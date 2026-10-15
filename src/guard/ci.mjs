// The CI check (spec 10): the hooks' rules where nobody can skip them, judged by the rules of the
// branch a pull request merges into. ciResult returns the result as data, which the job summary
// and the pull request comment render; ciCommand prints it as plain text and sets the exit code.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { CONFIG_FILE, loadConfig } from './config.mjs'
import { enforcementCheck } from './enforcement.mjs'
import { runGates, stampPath, verifiedStamp } from './gates.mjs'
import { branchTaskFiles, idCollisions } from './ids.mjs'
import { ownershipProblems, taskRecordsById } from './ownership.mjs'
import { checkRange } from './range.mjs'
import { fail, repositoryRoot } from './util.mjs'
import { compareTaskIds } from './work.mjs'
import { checkWorkspace, fingerprint, loadWorkspace, treeReader } from './workspace.mjs'

const CI_ZERO = /^0+$/
const CI_PULL_REQUEST_EVENTS = ['pull_request', 'pull_request_target']
const CI_FETCH_HINT =
  'Fetch the full history: in GitHub Actions, give actions/checkout "fetch-depth: 0"; elsewhere, run "git fetch --unshallow" or fetch the missing commits'

/** A failure that stops the check before it can judge anything, such as a missing commit. */
class CiError extends Error {}

/** Runs git in a folder and returns its trimmed output; throws with git's message when it fails. */
function ciGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

/** The full id of a revision's commit, or null when the clone does not have it. */
function ciCommit(root, rev) {
  try {
    return ciGit(root, ['rev-parse', '--verify', '-q', `${rev}^{commit}`]) || null
  } catch {
    return null
  }
}

/** The first 7 characters of a commit id, for messages. */
function ciShort(commit) {
  return commit ? commit.slice(0, 7) : 'none'
}

/**
 * Resolves the revisions the check needs, or stops: a shallow clone or a missing commit cannot
 * be judged, because the merge base and the commit range would be wrong.
 */
function ciRequireHistory(root, revs) {
  let shallow = false
  try {
    shallow = ciGit(root, ['rev-parse', '--is-shallow-repository']) === 'true'
  } catch {
    throw new CiError('not inside a git repository')
  }
  const commits = revs.map((rev) => ({ rev, commit: ciCommit(root, rev) }))
  const missing = commits.filter(({ commit }) => commit === null).map(({ rev }) => rev)
  if (missing.length > 0) {
    throw new CiError(`${missing.length === 1 ? 'commit' : 'commits'} ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in this clone${shallow ? ', which is shallow' : ''}. ${CI_FETCH_HINT}`)
  }
  if (shallow) throw new CiError(`this clone is shallow, so the merge base and the commit range cannot be trusted. ${CI_FETCH_HINT}`)
  return commits.map(({ commit }) => commit)
}

/** The merge base of two commits, or a stop when they share no history. */
function ciMergeBase(root, a, b) {
  try {
    const base = ciGit(root, ['merge-base', a, b])
    if (base !== '') return base
  } catch {
    // Unrelated histories, reported below.
  }
  throw new CiError(`${ciShort(a)} and ${ciShort(b)} share no history, so there is no merge base to judge the change from. ${CI_FETCH_HINT}`)
}

/** Whether `ancestor` is an ancestor of `commit`. */
function ciIsAncestor(root, ancestor, commit) {
  return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, commit], { cwd: root, stdio: 'ignore' }).status === 0
}

/**
 * The rules: the configuration of `primary` (the base, or the commit before a push). When that
 * commit has no configuration, the change adds ResaLedger and is judged by the configuration of
 * `fallback`. Returns { config, from, commit, adds }; an invalid configuration stops the check.
 */
function ciRules(root, primary, fallback) {
  const candidates = [primary, fallback].filter((item) => item.commit !== null)
  for (const { commit, from } of candidates) {
    const reader = treeReader({ kind: 'commit', rev: commit, root })
    if (reader.read(CONFIG_FILE) === null) continue
    const { config, problems } = loadConfig(reader)
    if (!config) {
      const lines = problems.map(({ file, line, message }) => `  ${file}${line ? `:${line}` : ''}: ${message}`).join('\n')
      throw new CiError(`the configuration in ${ciShort(commit)} (the ${from}), which sets the rules, is invalid:\n${lines}`)
    }
    return { config, from, commit, adds: primary.commit !== null && from !== primary.from }
  }
  throw new CiError(`neither ${candidates.map(({ commit, from }) => `the ${from} ${ciShort(commit)}`).join(' nor ')} has ${CONFIG_FILE}, so there are no rules to check against`)
}

/** The records check of a commit: its own configuration must be valid, and every record. */
function ciRecordsCheck(root, commit, config) {
  const reader = treeReader({ kind: 'commit', rev: commit, root })
  const problems = []
  const own = loadConfig(reader)
  if (!own.config) problems.push(...own.problems)
  const workspace = loadWorkspace(reader, config)
  problems.push(...checkWorkspace(workspace, reader, config))
  return {
    name: 'records',
    ok: problems.length === 0,
    problems,
    counts: { tasks: workspace.tasks.length, decisions: workspace.decisions.length, logs: workspace.logs.length },
    note: null
  }
}

/** The commits check of a range, with checkRange; `from` null checks nothing (a new branch). */
function ciCommitsCheck(root, from, to, config, lane, skipGitHubMerges, note) {
  if (from === null) return { name: 'commits', ok: true, skipped: true, problems: [], counts: { commits: 0 }, note }
  const commits = Number(ciGit(root, ['rev-list', '--count', `${from}..${to}`]))
  const problems = checkRange(from, to, { config, lane, skipGitHubMerges, root })
  return { name: 'commits', ok: problems.length === 0, problems, counts: { commits }, note }
}

/** The text of a task's Evidence field, or null. */
function ciEvidence(task) {
  if (!task.evidence) return null
  const parts = [task.evidence.value, ...task.evidence.items].map((part) => (part ?? '').trim()).filter((part) => part !== '')
  return parts.length > 0 ? parts.join('; ') : null
}

/** The tasks whose status differs between two task Maps, in id order: { id, title, file, from, to, evidence }. */
function ciMovedTasks(before, after) {
  const moved = []
  for (const [id, { task }] of after) {
    const from = before.get(id)?.task.status ?? null
    if (from === task.status) continue
    moved.push({ id, title: task.title, file: task.file, from, to: task.status, evidence: ciEvidence(task) })
  }
  return moved.sort((a, b) => compareTaskIds(a.id, b.id))
}

/** The names of the remotes of a clone. */
function ciRemotes(root) {
  return ciGit(root, ['remote'])
    .split('\n')
    .filter((name) => name !== '')
}

/**
 * The ids check of a pull request: ids the head adds (not at the merge base) against the base's
 * tip and every other branch in the clone, except the pull request's own branch.
 */
function ciIdsCheck(root, config, context) {
  const { mergeBaseTasks, headTasks, baseTasks, base, head, lane, fork } = context
  const added = [...headTasks.values()].filter(({ task }) => !mergeBaseTasks.has(task.id)).map(({ task }) => ({ id: task.id, file: task.file }))
  const own = new Set()
  // A fork's branch name says nothing about the branches of this repository.
  if (!fork && lane) {
    own.add(`refs/heads/${lane}`)
    for (const remote of ciRemotes(root)) own.add(`refs/remotes/${remote}/${lane}`)
  }
  const others = [{ branch: config.base, files: new Map([...baseTasks.values()].map(({ task }) => [task.id, task.file])) }]
  let branches = 0
  if (added.length > 0) {
    const scanned = branchTaskFiles({ root, dir: config.dir, exclude: ({ ref, commit }) => commit === head || commit === base || own.has(ref) })
    branches = scanned.length
    others.push(...scanned)
  }
  const problems = idCollisions(added, others, config)
  return { name: 'ids', ok: problems.length === 0, problems, counts: { added: added.length, branches: branches + 1 }, note: null }
}

/**
 * The gates of a pull request. With ci.runGates, the base's commit gates and then its verify
 * gates run in the working tree, which the workflow checks out at the head. Without it, the
 * head must carry a stamp for its own code and these gates.
 */
function ciGatesCheck(root, config, head) {
  const guard = `node ${config.dir}/scripts/records.mjs`
  const commands = [...config.gates.commit, ...config.gates.verify]
  const result = { name: 'gates', ok: true, problems: [], counts: { gates: commands.length }, note: null }
  const gates = { mode: 'none', ranOn: null, passed: [], failure: null, stamp: null }
  if (commands.length === 0) return { check: { ...result, skipped: true, note: 'no gates are configured' }, gates }

  if (!config.ci.runGates) {
    const code = fingerprint({ kind: 'commit', rev: head, root }, config)
    const path = stampPath(config, code)
    const stamp = verifiedStamp(treeReader({ kind: 'commit', rev: head, root }), config, code)
    gates.mode = 'stamp'
    gates.ranOn = head
    gates.stamp = stamp === null ? null : path
    if (stamp === null) {
      result.ok = false
      result.problems.push({
        file: path,
        line: 0,
        message: `the head ${ciShort(head)} carries no stamp for its own code and these gates (ci.runGates is false, so CI checks the stamp instead of running the gates). Run "${guard} verify" on the head and commit the stamp`
      })
    }
    return { check: result, gates }
  }

  gates.mode = 'run'
  gates.ranOn = ciCommit(root, 'HEAD')
  if (gates.ranOn !== head) result.note = `the working tree is at ${ciShort(gates.ranOn)}, not at the head ${ciShort(head)}`
  const { passed, failure } = runGates(commands, { root })
  gates.passed = passed
  if (failure) {
    gates.failure = { command: failure.command, status: failure.status }
    result.ok = false
    result.problems.push({
      file: '',
      line: 0,
      message: `the gate "${failure.command}" failed with ${failure.status} on ${ciShort(gates.ranOn)}. Fix the code; a gate is never weakened to make it pass`
    })
  }
  return { check: result, gates }
}

/** The checks of a pull request, in order, and its result. */
function ciPullRequest(root, options) {
  const [base, head] = ciRequireHistory(root, [options.base, options.head])
  const mergeBase = ciMergeBase(root, base, head)
  const rules = ciRules(root, { commit: base, from: 'base' }, { commit: head, from: 'head' })
  const { config } = rules
  const { lane } = options
  const tasksAt = (commit) => taskRecordsById(treeReader({ kind: 'commit', rev: commit, root }), config.dir)
  const mergeBaseTasks = tasksAt(mergeBase)
  const headTasks = tasksAt(head)
  const baseTasks = base === mergeBase ? mergeBaseTasks : tasksAt(base)

  const checks = [ciRecordsCheck(root, head, config)]
  checks.push(ciCommitsCheck(root, mergeBase, head, config, lane, false, null))

  const ownership = ownershipProblems({
    before: mergeBaseTasks,
    after: headTasks,
    lane,
    config,
    holders: [baseTasks],
    accepted: [baseTasks],
    baseName: config.base
  })
  const changed = [...headTasks].filter(([id, { text }]) => mergeBaseTasks.get(id)?.text !== text).length
  checks.push({ name: 'ownership', ok: ownership.length === 0, problems: ownership, counts: { changed }, note: null })
  checks.push(ciIdsCheck(root, config, { mergeBaseTasks, headTasks, baseTasks, base, head, lane, fork: options.fork }))

  const moved = ciMovedTasks(mergeBaseTasks, headTasks)
  checks.push({ name: 'moved', ok: true, problems: [], counts: { moved: moved.length }, note: null })

  const { check, gates } = ciGatesCheck(root, config, head)
  checks.push(check)

  // The pull request's own changes start at the merge base; a merge base from before the base
  // added ResaLedger has no configuration, so the base stands in for it.
  const mergeBaseConfig = loadConfig(treeReader({ kind: 'commit', rev: mergeBase, root })).config
  const from = mergeBaseConfig ? mergeBase : base
  const enforcement = enforcementCheck(root, { from, mergeBase, head, adds: rules.adds })
  checks.push(enforcement.check)
  return { mergeBase, rules, checks, moved, gates, enforcement: enforcement.changes }
}

/** The checks of a push, in order, and its result. */
function ciPush(root, options) {
  const newBranch = options.before === null || CI_ZERO.test(options.before)
  const [after] = ciRequireHistory(root, [options.after])
  let before = null
  let from = null
  if (!newBranch) {
    before = ciRequireHistory(root, [options.before])[0]
    // A forced push: only the commits that are new since the common history are checked.
    from = ciIsAncestor(root, before, after) ? before : ciMergeBase(root, before, after)
  }
  const rules = ciRules(root, { commit: before, from: 'before' }, { commit: after, from: 'after' })
  const { config } = rules
  const checks = [ciRecordsCheck(root, after, config)]
  const note = newBranch ? 'a new branch: its commits are checked in their pull request' : null
  checks.push(ciCommitsCheck(root, from, after, config, null, true, note))
  const tasksAt = (commit) => taskRecordsById(treeReader({ kind: 'commit', rev: commit, root }), config.dir)
  const moved = from === null ? [] : ciMovedTasks(tasksAt(from), tasksAt(after))
  checks.push({ name: 'moved', ok: true, problems: [], counts: { moved: moved.length }, note: null })
  return { from, rules, checks, moved, gates: null, enforcement: null }
}

/**
 * The CI check as data. options is { event, source, base, head, lane, fork } for a pull request
 * or { event: 'push', source, before, after, ref } for a push, plus an optional root.
 *
 * Returns { event, source, base, head, lane, fork, ref, mergeBase, from, rules, checks, moved,
 * gates, enforcement, ok }:
 * - rules: { from: 'base' | 'head' | 'before' | 'after', commit, adds } (adds: the change adds
 *   ResaLedger and is judged by its own rules);
 * - checks: [{ name, ok, skipped?, problems, counts, note }] in the order they ran: records,
 *   commits, ownership, ids, moved, gates, enforcement for a pull request; records, commits,
 *   moved for a push;
 * - moved: [{ id, title, file, from, to, evidence }];
 * - gates: { mode: 'run' | 'stamp' | 'none', ranOn, passed: [{ command, seconds }], failure,
 *   stamp } for a pull request, null for a push;
 * - enforcement: for a pull request, the changes to enforcement from the merge base to the head,
 *   [{ id, kind: 'listed' | 'weakening', file, what, decidedBy: { file, by } | null }]; empty
 *   when nothing changed or when the change adds ResaLedger; null for a push.
 * Throws a CiError when the check cannot run, such as for a missing commit.
 */
export function ciResult(options) {
  let root = options.root
  if (!root) {
    try {
      root = repositoryRoot()
    } catch {
      throw new CiError('not inside a git repository')
    }
  }
  const pullRequest = options.event !== 'push'
  const outcome = pullRequest ? ciPullRequest(root, options) : ciPush(root, options)
  return {
    event: options.event,
    source: options.source ?? 'flags',
    base: pullRequest ? ciCommit(root, options.base) : null,
    head: pullRequest ? ciCommit(root, options.head) : ciCommit(root, options.after),
    lane: pullRequest ? options.lane : null,
    fork: pullRequest ? Boolean(options.fork) : false,
    ref: options.ref ?? null,
    before: pullRequest ? null : options.before,
    mergeBase: outcome.mergeBase ?? null,
    from: outcome.from ?? null,
    rules: { from: outcome.rules.from, commit: outcome.rules.commit, adds: outcome.rules.adds },
    checks: outcome.checks,
    moved: outcome.moved,
    gates: outcome.gates,
    enforcement: outcome.enforcement,
    ok: outcome.checks.every((check) => check.ok)
  }
}

/**
 * The options of ci from its arguments, or from the GitHub event when there are none.
 * --base and --head with --lane check a pull request from that lane; without --lane, they check
 * a push of the commits from --base to --head.
 */
export function ciOptions(args, env = process.env) {
  const flags = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!['--base', '--head', '--lane'].includes(arg)) throw new CiError(`unknown option "${arg}" for ci; use --base <rev> --head <rev> [--lane <branch>]`)
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new CiError(`${arg} needs a value`)
    flags[arg.slice(2)] = value
    index += 1
  }
  if (Object.keys(flags).length > 0) {
    if (!flags.base || !flags.head) throw new CiError('ci needs both --base <rev> and --head <rev>, and --lane <branch> for a pull request')
    if (flags.lane) return { event: 'pull_request', source: 'flags', base: flags.base, head: flags.head, lane: flags.lane, fork: false }
    return { event: 'push', source: 'flags', before: flags.base, after: flags.head, ref: null }
  }

  const name = env.GITHUB_EVENT_NAME
  const path = env.GITHUB_EVENT_PATH
  if (!name || !path) throw new CiError('no CI event found: run ci in GitHub Actions, or pass --base <rev> --head <rev> [--lane <branch>]')
  let payload
  try {
    payload = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new CiError(`cannot read the event file GITHUB_EVENT_PATH: ${error.message}`)
  }
  if (CI_PULL_REQUEST_EVENTS.includes(name)) {
    const pr = payload.pull_request
    if (!pr?.base?.sha || !pr?.head?.sha || !pr?.head?.ref) throw new CiError(`the ${name} event has no pull_request.base.sha, head.sha and head.ref`)
    const baseRepo = pr.base.repo?.full_name ?? null
    const headRepo = pr.head.repo?.full_name ?? null
    return { event: 'pull_request', source: 'github', base: pr.base.sha, head: pr.head.sha, lane: pr.head.ref, fork: headRepo === null || headRepo !== baseRepo }
  }
  if (name === 'push') {
    if (!payload.after) throw new CiError('the push event has no "after" commit')
    return { event: 'push', source: 'github', before: payload.before ?? null, after: payload.after, ref: payload.ref ?? null }
  }
  throw new CiError(`the ${name} event is not one ci checks; run it on pull_request and push, or pass --base <rev> --head <rev> [--lane <branch>]`)
}

/** The one-line summary of a check, after its ✔ or ✖. */
function ciCheckLine(check, result) {
  const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`
  const problems = check.problems.length > 0 ? `${plural(check.problems.length, 'problem')}; ` : ''
  const note = check.note ? ` (${check.note})` : ''
  const { counts } = check
  switch (check.name) {
    case 'records':
      return `records: ${problems}${plural(counts.tasks, 'task')}, ${plural(counts.decisions, 'decision')}, ${plural(counts.logs, 'log entry', 'log entries')}${note}`
    case 'commits':
      if (check.skipped) return `commits: not checked${note}`
      return `commits: ${problems}${plural(counts.commits, 'commit')} ${result.event === 'push' ? 'pushed' : 'from the merge base to the head'}${note}`
    case 'ownership':
      return `ownership: ${problems}${plural(counts.changed, 'task')} changed${note}`
    case 'ids':
      return `ids: ${problems}${plural(counts.added, 'new id')}, against ${plural(counts.branches, 'branch', 'branches')}${note}`
    case 'moved':
      return `tasks moved: ${counts.moved}`
    case 'enforcement': {
      if (check.skipped) return `enforcement: not compared (${check.note})`
      if (counts.changes === 0) return 'enforcement: unchanged'
      const undecided = check.problems.length > 0 ? `${plural(check.problems.length, 'weakening change')} no decision names; ` : ''
      return `enforcement: ${undecided}${plural(counts.changes, 'change')}, ${counts.weakening} weakening`
    }
    case 'gates': {
      if (check.skipped) return `gates: none${note}`
      const gates = result.gates
      if (gates.mode === 'stamp') return `gates: ${problems}${gates.stamp ? `the head carries its stamp ${gates.stamp}` : 'no stamp for the head'} (ci.runGates is false)`
      const timings = gates.passed.map(({ command, seconds }) => `${command} ✔ ${seconds} s`)
      if (gates.failure) timings.push(`${gates.failure.command} ✖`)
      return `gates on ${ciShort(gates.ranOn)}: ${timings.join(' · ')}${note}`
    }
    default:
      return `${check.name}: ${problems}`.replace(/; $/, '')
  }
}

/** The line of one change to enforcement: its id, what changed, and why it passes or fails. */
function ciChangeLine(change, check) {
  if (change.kind === 'listed') return `${change.id}: ${change.what}`
  if (change.decidedBy) return `${change.id}: ${change.what} · weakening, decided in ${change.decidedBy.file}${change.decidedBy.by ? ` by ${change.decidedBy.by}` : ''}`
  const problem = check.problems.find(({ id }) => id === change.id)
  return `✖ ${change.id}: ${problem ? problem.message : change.what}`
}

/** ci [--base <rev> --head <rev> [--lane <branch>]]: runs the CI check, prints it and exits 1 when a check fails. */
export function ciCommand(args) {
  let result
  try {
    result = ciResult(ciOptions(args))
  } catch (error) {
    if (error instanceof CiError) fail(error.message)
    throw error
  }
  const out = []
  if (result.event === 'push') {
    out.push(`ResaLedger ci: push${result.ref ? ` to ${result.ref}` : ''}, ${result.from ? `${ciShort(result.from)}..` : ''}${ciShort(result.head)}`)
  } else {
    out.push(
      `ResaLedger ci: pull request from "${result.lane}"${result.fork ? ' (a fork)' : ''}, head ${ciShort(result.head)}, base ${ciShort(result.base)}, merge base ${ciShort(result.mergeBase)}`
    )
  }
  if (result.rules.adds) out.push(`This change adds ResaLedger, so it is judged by its own rules, from the ${result.rules.from} ${ciShort(result.rules.commit)}.`)
  else out.push(`Rules from the ${result.rules.from} ${ciShort(result.rules.commit)}.`)
  for (const check of result.checks) {
    out.push(`${check.ok ? '✔' : '✖'} ${ciCheckLine(check, result)}`)
    if (check.name === 'enforcement') {
      for (const change of result.enforcement) out.push(`  ${ciChangeLine(change, check)}`)
      continue
    }
    for (const { file, line, message } of check.problems) out.push(`  ${file ? `${file}${line ? `:${line}` : ''}: ` : ''}${message}`)
    if (check.name === 'moved') {
      for (const task of result.moved) {
        out.push(`  ${task.id} ${task.title}: ${task.from ?? 'new'} → ${task.to ?? 'no status'}${task.evidence ? ` · Evidence: ${task.evidence}` : ''}`)
      }
    }
  }
  console.log(out.join('\n'))
  if (!result.ok) process.exit(1)
}
