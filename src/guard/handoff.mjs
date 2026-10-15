// The end-of-session check (spec 8): the records are valid, the hooks are active, the tree is
// clean, the gates passed on this code, every task in progress has a current handoff note, the
// unpushed commits are recorded and, in the team preset, the lane is pushed.
import { spawnSync } from 'node:child_process'
import { loadConfig } from './config.mjs'
import { stampPath, verifiedStamp } from './gates.mjs'
import { hooksActive } from './githooks.mjs'
import { currentLane } from './lanes.mjs'
import { checkRange, taskTrailers } from './range.mjs'
import { fail, repositoryRoot } from './util.mjs'
import { checkWorkspace, fingerprint, loadWorkspace, treeReader } from './workspace.mjs'

const HANDOFF_SHOWN_PATHS = 5
const HANDOFF_NAMING_COMMITS = 200
const HANDOFF_FALLBACK_COMMITS = 50
const HANDOFF_MAX_BUFFER = 256 * 1024 * 1024

/** Runs git in a folder: { ok, out } with stdout untrimmed, never throws on git's own failure. */
function handoffGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: HANDOFF_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  return { ok: result.status === 0, out: result.stdout }
}

/** The full id of a revision, or null when it does not resolve to a commit. */
function handoffCommit(root, rev) {
  const { ok, out } = handoffGit(root, ['rev-parse', '--verify', '-q', `${rev}^{commit}`])
  return ok ? out.trim() : null
}

/** The paths of `git status --porcelain`, renames as their new path. */
function handoffDirtyPaths(root) {
  const { ok, out } = handoffGit(root, ['status', '--porcelain=v1', '-z'])
  if (!ok) throw new Error('git status failed')
  const records = out.split('\0')
  const paths = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.length < 4) continue
    paths.push(record.slice(3))
    // A rename or copy is followed by its original path, which is the same change.
    if (record[0] === 'R' || record[0] === 'C') index += 1
  }
  return paths
}

/** Whether a section body holds content: a line that is neither blank nor a heading. */
function handoffHasContent(body) {
  return body.split('\n').some((line) => line.trim() !== '' && !/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line))
}

/**
 * Where this lane's own commits start, as a full commit id, or null for every commit:
 * the upstream when the branch has one; otherwise the fork point from the base branch when
 * this is not the base and the base exists locally; otherwise null. `kind` names the choice.
 */
function handoffLaneStart(root, config, lane) {
  if (lane !== null) {
    const upstream = handoffCommit(root, '@{upstream}')
    if (upstream !== null) return { kind: 'upstream', from: upstream }
  }
  if (lane !== config.base && handoffCommit(root, `refs/heads/${config.base}`) !== null) {
    const { ok, out } = handoffGit(root, ['merge-base', `refs/heads/${config.base}`, 'HEAD'])
    if (ok && out.trim() !== '') return { kind: 'base', from: out.trim() }
  }
  return { kind: 'none', from: null }
}

/**
 * The range of unpushed commits that handoff checks: from the upstream; else from the base
 * branch; else since the newest commit that added a stamp; else the last 50 commits.
 * `from` null means every ancestor of HEAD. The stamp for the code at HEAD, which this session
 * may just have committed, does not count: the range starts at the stamp before it.
 */
function handoffUnpushedRange(root, config, lane, currentStamp) {
  const start = handoffLaneStart(root, config, lane)
  if (start.kind !== 'none') return start
  const pathspec = [`${config.dir}/verified/`]
  if (currentStamp !== null) pathspec.push(`:(exclude)${currentStamp}`)
  const stamped = handoffGit(root, ['log', '-1', '--diff-filter=A', '--format=%H', 'HEAD', '--', ...pathspec])
  if (stamped.ok && stamped.out.trim() !== '') return { kind: 'stamp', from: stamped.out.trim() }
  return { kind: 'recent', from: handoffCommit(root, `HEAD~${HANDOFF_FALLBACK_COMMITS}`) }
}

/** The commits of a log range, newest first, as [{ hash, short, ids }] with the ids of their Task: trailers. */
function handoffNamingCommits(root, rangeArgs) {
  const { ok, out } = handoffGit(root, ['log', '--format=%x01%H%x00%h%x00%B', ...rangeArgs, '--'])
  if (!ok) return []
  return out
    .split('\x01')
    .filter((chunk) => chunk !== '')
    .map((chunk) => {
      const [hash, short, message = ''] = chunk.split('\0')
      return { hash, short, ids: taskTrailers(message).ids }
    })
}

/** Problems with the handoff notes of the doing tasks this lane holds. */
function handoffNoteProblems(root, config, lane, tasks, dirty) {
  const held = tasks.filter((task) => task.status === 'doing' && task.lane === lane && task.id)
  if (held.length === 0) return []
  const problems = []
  const start = handoffLaneStart(root, config, lane)
  // The commits on this lane since the base, or the last 200 when where the lane starts is unclear.
  const rangeArgs = start.kind === 'base' ? [`${start.from}..HEAD`] : ['-n', String(HANDOFF_NAMING_COMMITS), 'HEAD']
  const commits = handoffNamingCommits(root, rangeArgs)
  const dirtyFiles = new Set(dirty)
  for (const task of held) {
    const section = task.sections.handoff
    if (section === null || !handoffHasContent(section.body)) {
      problems.push({
        file: task.file,
        line: section ? section.line : task.titleLine,
        message: `${task.id} is in progress in this lane without a handoff note: write the exact next step in its ## Handoff`
      })
      continue
    }
    const naming = commits.find((commit) => commit.ids.includes(task.id))
    if (!naming || dirtyFiles.has(task.file)) continue
    const changed = handoffGit(root, ['log', '-1', '--format=%H', 'HEAD', '--', task.file])
    const fileCommit = changed.ok ? changed.out.trim() : ''
    const current = fileCommit !== '' && handoffGit(root, ['merge-base', '--is-ancestor', naming.hash, fileCommit]).ok
    if (!current) {
      problems.push({
        file: task.file,
        line: section.line,
        message: `${task.id}'s handoff is older than your last commit on it (${naming.short}): rewrite it`
      })
    }
  }
  return problems
}

/** Problems with pushing the lane: no upstream, or commits the upstream does not have. */
function handoffPushProblems(root, lane) {
  if (handoffCommit(root, '@{upstream}') === null) {
    return [{ file: '', line: 0, message: `the lane "${lane}" is not pushed: run git push -u origin HEAD` }]
  }
  const { ok, out } = handoffGit(root, ['rev-list', '--count', '@{upstream}..HEAD'])
  const ahead = ok ? Number(out.trim()) : 0
  if (ahead === 0) return []
  return [{ file: '', line: 0, message: `the lane "${lane}" has ${ahead} unpushed commit${ahead === 1 ? '' : 's'}: run git push` }]
}

/**
 * Every reason the session cannot end yet, as problems { file, line, message }, in the order
 * spec 8 lists them. context is { root, config, lane }, with lane the current branch, or null
 * in a detached HEAD, which skips the checks that need a lane.
 */
export function handoffProblems(context) {
  const { config } = context
  const root = context.root ?? repositoryRoot()
  const lane = context.lane ?? null
  const problems = []

  const reader = treeReader({ kind: 'worktree', root })
  const workspace = loadWorkspace(reader, config)
  problems.push(...checkWorkspace(workspace, reader, config))

  if (!hooksActive()) problems.push({ file: '', line: 0, message: 'the git hooks are not active in this clone: run work or hooks --activate' })

  const dirty = handoffDirtyPaths(root)
  if (dirty.length > 0) {
    const shown = dirty.slice(0, HANDOFF_SHOWN_PATHS).join(', ')
    const more = dirty.length > HANDOFF_SHOWN_PATHS ? ` and ${dirty.length - HANDOFF_SHOWN_PATHS} more` : ''
    problems.push({
      file: '',
      line: 0,
      message: `the tree has ${dirty.length} uncommitted path${dirty.length === 1 ? '' : 's'} (${shown}${more}): commit them or remove them; uncommitted work is not a handoff`
    })
  }

  if (handoffCommit(root, 'HEAD') === null) {
    problems.push({ file: '', line: 0, message: 'there is no commit yet: commit your work first' })
    return problems
  }

  let currentStamp = null
  if (config.gates.verify.length > 0) {
    const code = fingerprint({ kind: 'commit', rev: 'HEAD', root }, config)
    currentStamp = stampPath(config, code)
    if (verifiedStamp(reader, config, code) === null) {
      problems.push({
        file: currentStamp,
        line: 0,
        message: 'the gates have not passed on the code at HEAD: run verify and commit the stamp with your records'
      })
    }
  }

  if (lane !== null) problems.push(...handoffNoteProblems(root, config, lane, workspace.tasks, dirty))

  const range = handoffUnpushedRange(root, config, lane, currentStamp)
  problems.push(...checkRange(range.from, 'HEAD', { config, lane, skipGitHubMerges: false, root }))

  if (config.requirePushed && lane !== null) problems.push(...handoffPushProblems(root, lane))
  return problems
}

/** handoff: the end-of-session check. Prints one line when the session may end; otherwise each problem, and exits 1. */
export function handoffCommand(args = []) {
  for (const arg of args) fail(`unknown option "${arg}" for handoff; it takes no options`)
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }
  const { config, problems: configProblems } = loadConfig(treeReader({ kind: 'worktree', root }))
  if (!config) {
    console.error('✖ Not ready to hand off')
    for (const { file, line, message } of configProblems) console.error(`  ${file}${line ? `:${line}` : ''}: ${message}`)
    process.exit(1)
  }
  const lane = currentLane()
  let problems
  try {
    problems = handoffProblems({ root, config, lane })
  } catch (error) {
    fail(error.message)
  }
  if (problems.length > 0) {
    console.error('✖ Not ready to hand off')
    for (const { file, line, message } of problems) console.error(`  ${file ? `${file}${line ? `:${line}` : ''}: ` : ''}${message}`)
    process.exit(1)
  }
  const parts = ['records valid']
  parts.push(config.gates.verify.length > 0 ? 'the gates passed on this code' : 'no verify gates to pass')
  if (lane === null) parts.push('detached HEAD, so no lane checks')
  else {
    parts.push('every task in progress has a current handoff note')
    if (config.requirePushed) parts.push('the lane is pushed')
  }
  console.log(`✔ handed off: ${parts.join(', ')}`)
}
