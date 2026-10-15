// The commit range check, spec 5.9: every commit in a range that changes code names a task that is
// doing or done in that commit's own tree and held by the lane. Pre-push, handoff and CI all use it.
//
// Commits are never parsed out of formatted output, which a message could forge: the list comes
// from git rev-list, each commit from git cat-file --batch (length-prefixed), and its paths from
// git diff-tree --raw -z, keyed by hash. Anything that does not parse is an error, never a pass.
import { spawnSync } from 'node:child_process'
import { parseTask, TASK_ID } from './tasks.mjs'
import { repositoryRoot } from './util.mjs'
import { isCode } from './workspace.mjs'

const RANGE_MAX_BUFFER = 1024 * 1024 * 1024
const RANGE_TRAILER = /^Task:(.*)$/
const RANGE_REVERT = /^This reverts commit ([0-9a-f]{7,64})\.$/gm
const RANGE_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const RANGE_COMMITTER = /^committer .*<([^<>]*)> -?\d+ [+-]\d{4}$/
// GitHub's own committer address, written in two parts so the hygiene scan sees no address.
const RANGE_GITHUB_COMMITTER = ['noreply', 'github.com'].join('@')
const RANGE_MAINTENANCE = 'maintenance'
const RANGE_SHOWN_PATHS = 3
// Options that make a diff the same whatever the user's diff configuration is.
const RANGE_DIFF = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--src-prefix=a/', '--dst-prefix=b/']

/** Runs git in a folder: { status, stdout } with stdout a Buffer; throws only when git cannot start. */
function rangeRun(root, args, input) {
  const result = spawnSync('git', args, { cwd: root, input, maxBuffer: RANGE_MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  return { status: result.status, stdout: result.stdout, stderr: result.stderr.toString('utf8').trim() }
}

/** Runs git in a folder and returns stdout as a Buffer; throws with git's message when it fails. */
function rangeGit(root, args, input) {
  const result = rangeRun(root, args, input)
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`)
  return result.stdout
}

/** The error for a commit that cannot be read: the check refuses rather than passes. */
function rangeUnreadable(what) {
  return new Error(`cannot read ${what} from git, so the commits are not checked`)
}

/**
 * Reads objects in one `git cat-file --batch`. Each spec is an object name such as an id or
 * "<rev>:<path>". Returns a Map from spec to { type, data } (a Buffer); missing objects are left out.
 */
export function rangeObjects(root, specs) {
  const objects = new Map()
  const unique = [...new Set(specs)]
  if (unique.length === 0) return objects
  const output = rangeGit(root, ['cat-file', '--batch'], `${unique.join('\n')}\n`)
  let at = 0
  for (const spec of unique) {
    const end = output.indexOf(10, at)
    if (end === -1) throw rangeUnreadable(`the object ${spec}`)
    const header = output.toString('utf8', at, end)
    at = end + 1
    if (header.endsWith(' missing') || header.endsWith(' ambiguous')) continue
    const [, type, size] = header.split(' ')
    const length = Number(size)
    if (!Number.isSafeInteger(length) || at + length >= output.length || output[at + length] !== 10) throw rangeUnreadable(`the object ${spec}`)
    objects.set(spec, { type, data: output.subarray(at, at + length) })
    at += length + 1
  }
  return objects
}

/** The blob entries of a raw tree object, as a Map from name to object id (hex). */
function rangeTreeEntries(data, hashBytes) {
  const entries = new Map()
  let at = 0
  while (at < data.length) {
    const space = data.indexOf(32, at)
    const nul = data.indexOf(0, space)
    if (space === -1 || nul === -1) break
    const mode = data.toString('utf8', at, space)
    const name = data.toString('utf8', space + 1, nul)
    const oid = data.toString('hex', nul + 1, nul + 1 + hashBytes)
    at = nul + 1 + hashBytes
    if (!mode.startsWith('40')) entries.set(name, oid)
  }
  return entries
}

/** A raw commit object, parsed and validated: { parents, committer, subject, message }. */
function rangeParseCommit(hash, data) {
  const split = data.indexOf('\n\n')
  if (split === -1) throw rangeUnreadable(`the commit ${hash}`)
  const lines = data.toString('utf8', 0, split).split('\n')
  if (!/^tree [0-9a-f]+$/.test(lines[0])) throw rangeUnreadable(`the commit ${hash}`)
  const parents = []
  let committer = null
  for (const line of lines.slice(1)) {
    if (line.startsWith('parent ')) {
      const parent = line.slice('parent '.length)
      if (!RANGE_HASH.test(parent)) throw rangeUnreadable(`the commit ${hash}`)
      parents.push(parent)
    } else if (line.startsWith('committer ')) {
      const match = RANGE_COMMITTER.exec(line)
      if (!match || committer !== null) throw rangeUnreadable(`the commit ${hash}`)
      committer = match[1]
    }
  }
  if (committer === null) throw rangeUnreadable(`the commit ${hash}`)
  const message = data.toString('utf8', split + 2)
  return { parents, committer, subject: message.split('\n')[0].trim(), message }
}

/**
 * The commits `git rev-list <args>` lists, in its order, each read with `git cat-file --batch`:
 * [{ hash, short, parents, committer, subject, message }]. short is read from git when asked
 * for. Throws when git fails or any commit does not parse.
 */
export function readCommits(root, revListArgs) {
  const hashes = rangeGit(root, ['rev-list', ...revListArgs, '--'])
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '')
  if (hashes.length === 0) return []
  if (!hashes.every((hash) => RANGE_HASH.test(hash))) throw rangeUnreadable('the list of commits')
  const output = rangeGit(root, ['cat-file', '--batch'], `${hashes.join('\n')}\n`)
  const commits = []
  let at = 0
  for (const hash of hashes) {
    const end = output.indexOf(10, at)
    const header = end === -1 ? '' : output.toString('utf8', at, end)
    const [oid, type, size] = header.split(' ')
    const length = Number(size)
    at = end + 1
    if (oid !== hash || type !== 'commit' || !/^\d+$/.test(size ?? '') || at + length >= output.length || output[at + length] !== 10) {
      throw rangeUnreadable(`the commit ${hash}`)
    }
    const commit = rangeParseCommit(hash, output.subarray(at, at + length))
    at += length + 1
    let short = null
    commits.push({
      hash,
      get short() {
        if (short === null) short = rangeGit(root, ['rev-parse', '--short', hash]).toString('utf8').trim()
        return short
      },
      ...commit
    })
  }
  if (at !== output.length) throw rangeUnreadable('the list of commits')
  return commits
}

/**
 * The paths each commit touches against its parent (every file for a root commit), deletions
 * included, from one `git diff-tree --stdin --raw -z`: a Map from hash to paths. Merges are not
 * given here; see mergeOwnPaths.
 */
function rangePaths(root, hashes) {
  const paths = new Map()
  if (hashes.length === 0) return paths
  const tokens = rangeGit(root, ['diff-tree', '--stdin', '-r', '--root', '--no-renames', '--raw', '-z', '--always'], `${hashes.join('\n')}\n`)
    .toString('utf8')
    .split('\0')
  if (tokens.pop() !== '') throw rangeUnreadable('the paths of the commits')
  let current = null
  let next = 0
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.startsWith(':')) {
      // A raw entry is always followed by exactly one path, as renames are off.
      const path = tokens[index + 1]
      if (current === null || path === undefined || path === '') throw rangeUnreadable('the paths of the commits')
      current.push(path)
      index += 1
    } else {
      if (token !== hashes[next]) throw rangeUnreadable('the paths of the commits')
      current = []
      paths.set(token, current)
      next += 1
    }
  }
  if (next !== hashes.length) throw rangeUnreadable('the paths of the commits')
  return paths
}

/** The paths one commit touches against its first parent, or every file for a root commit. */
export function commitPaths(root, hash) {
  return rangePaths(root, [hash]).get(hash)
}

/** The full id of a revision's commit, or null when it does not resolve. */
function rangeResolve(root, rev) {
  const { status, stdout } = rangeRun(root, ['rev-parse', '--verify', '-q', `${rev}^{commit}`])
  const hash = stdout.toString('utf8').trim()
  return status === 0 && RANGE_HASH.test(hash) ? hash : null
}

/** The id of the empty tree in this repository's hash. */
function rangeEmptyTree(root) {
  return rangeGit(root, ['hash-object', '-t', 'tree', '--stdin'], '').toString('utf8').trim()
}

/** The paths that differ between two tree-ish revisions; `to` null is the index (GIT_INDEX_FILE). */
function rangeChanged(root, from, to) {
  const args =
    to === null
      ? ['diff-index', '--cached', '-r', '--no-renames', '--name-only', '-z', from, '--']
      : ['diff-tree', '-r', '--no-renames', '--name-only', '-z', from, to, '--']
  return rangeGit(root, args)
    .toString('utf8')
    .split('\0')
    .filter((path) => path !== '')
}

/** The merge bases of two commits, or the empty tree when their histories are unrelated. */
function rangeMergeBases(root, a, b) {
  const { status, stdout, stderr } = rangeRun(root, ['merge-base', '--all', a, b])
  if (status !== 0 && status !== 1) throw new Error(`git merge-base failed: ${stderr}`)
  const bases = stdout
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '')
  if (!bases.every((base) => RANGE_HASH.test(base))) throw rangeUnreadable(`the merge base of ${a} and ${b}`)
  return bases.length > 0 ? bases : [rangeEmptyTree(root)]
}

/**
 * The code paths a merge changes of its own, spec 5.9: for each parent, the code paths in
 * diff(parent, merge) that no other parent's side changed, a side being diff(merge base, that
 * parent). A clean merge, or one that only resolves conflicts, has none; any other code path
 * (an "evil merge") makes it a code commit that needs its own Task: line. merge is a commit,
 * or null for the index while a merge is being concluded.
 */
export function mergeOwnPaths(root, config, parents, merge) {
  const own = new Set()
  for (const [index, parent] of parents.entries()) {
    const sides = new Set()
    for (const [other, otherParent] of parents.entries()) {
      if (other === index) continue
      for (const base of rangeMergeBases(root, parent, otherParent)) {
        for (const path of rangeChanged(root, base, otherParent)) sides.add(path)
      }
    }
    for (const path of rangeChanged(root, parent, merge)) {
      if (isCode(path, config) && !sides.has(path)) own.add(path)
    }
  }
  return [...own].sort()
}

/** The patch id of a diff, or '' for an empty one. --verbatim keeps whitespace; older git falls back to --stable. */
function rangePatchId(root, diff) {
  if (diff.length === 0) return ''
  let result = rangeRun(root, ['patch-id', '--verbatim'], diff)
  if (result.status !== 0) result = rangeRun(root, ['patch-id', '--stable'], diff)
  if (result.status !== 0) throw new Error(`git patch-id failed: ${result.stderr}`)
  return result.stdout.toString('utf8').split(' ')[0].trim()
}

/** The diff from one revision to another; `to` null is the index. */
function rangeDiff(root, from, to) {
  return rangeGit(root, ['diff', ...RANGE_DIFF, ...(to === null ? ['--cached', from] : [from, to]), '--'])
}

/**
 * Whether a commit is a real revert, spec 5.9: its message names, in git revert's "This reverts
 * commit <hash>." line, a commit that resolves to an ancestor of `parent`, and its own change
 * (from `parent` to `commit`, or to the index when commit is null) has the patch id of that
 * commit's change inverted. The message alone exempts nothing.
 */
export function isRevert(root, message, parent, commit) {
  if (parent === null) return false
  for (const [, named] of String(message).matchAll(RANGE_REVERT)) {
    const reverted = rangeResolve(root, named)
    if (reverted === null) continue
    if (rangeRun(root, ['merge-base', '--is-ancestor', reverted, parent]).status !== 0) continue
    const before = rangeResolve(root, `${reverted}^`) ?? rangeEmptyTree(root)
    const own = rangePatchId(root, rangeDiff(root, parent, commit))
    if (own !== '' && own === rangePatchId(root, rangeDiff(root, reverted, before))) return true
  }
  return false
}

/**
 * The commits of a range, oldest first: [{ hash, short, parents, committer, subject, message,
 * paths, exemption }]. paths are the files a commit touches against its parent (every file for a
 * root commit); for a merge, only the code paths it changes of its own (mergeOwnPaths).
 * exemption is 'merge' for a merge with none, 'revert' for a real revert (isRevert), or null.
 * Without `from` the range is every ancestor of `to`.
 */
function rangeCommits(root, config, from, to) {
  const commits = readCommits(root, ['--reverse', '--topo-order', from ? `${from}..${to}` : to])
  const paths = rangePaths(
    root,
    commits.filter((commit) => commit.parents.length < 2).map((commit) => commit.hash)
  )
  for (const commit of commits) {
    commit.exemption = null
    if (commit.parents.length > 1) {
      commit.paths = mergeOwnPaths(root, config, commit.parents, commit.hash)
      if (commit.paths.length === 0) commit.exemption = 'merge'
      continue
    }
    commit.paths = paths.get(commit.hash)
    if (commit.paths.some((path) => isCode(path, config)) && isRevert(root, commit.message, commit.parents[0] ?? null, commit.hash)) {
      commit.exemption = 'revert'
    }
  }
  return commits
}

/**
 * The task trailers of a commit message: { ids, maintenance }. Every body line of the form
 * "Task: <value>" counts; the value is a comma-separated list, and "maintenance" (lowercase)
 * sets maintenance instead of naming an id. The subject line never counts.
 */
export function taskTrailers(message) {
  const ids = []
  let maintenance = false
  const lines = String(message).replace(/\r\n?/g, '\n').split('\n').slice(1)
  for (const line of lines) {
    const match = RANGE_TRAILER.exec(line.trimEnd())
    if (!match) continue
    for (const part of match[1].split(',')) {
      const value = part.trim()
      if (value === '') continue
      if (value === RANGE_MAINTENANCE) maintenance = true
      else if (!ids.includes(value)) ids.push(value)
    }
  }
  return { ids, maintenance }
}

/**
 * Why a commit is exempt from the trailer rules, or null: commit.exemption, which the caller
 * found in git ('merge' for a merge that changes no code of its own, 'revert' for a real
 * revert), or 'github' (a commit GitHub made when merging a pull request, only with
 * context.skipGitHubMerges). The message alone never exempts a commit, and a release commit
 * that changes code needs a Task: line like any other.
 * commit is { committer, exemption }.
 */
export function commitExemption(commit, context) {
  if (commit.exemption) return commit.exemption
  if (context.skipGitHubMerges && commit.committer.toLowerCase() === RANGE_GITHUB_COMMITTER) return 'github'
  return null
}

/** The task file for an id among a tasks folder's entries: <id>.md or <id>-<slug>.md. */
export function taskFileFor(names, id) {
  for (const name of names) {
    if (name === `${id}.md` || (name.startsWith(`${id}-`) && name.endsWith('.md'))) return name
  }
  return null
}

/**
 * The trailer problems of one commit, spec 5.9, as { file: commit.short, line: 0, message }.
 * checkRange calls it for each commit of a range, and commit-msg for the commit being made.
 *
 * commit is { short, parents, committer, subject, message, paths, exemption }: for a merge,
 * paths are the code paths it changes of its own (mergeOwnPaths). context is { config, lane,
 * skipGitHubMerges, task, startLane }: task(id) is the parsed task in the commit's own tree,
 * or null when it has no file there; startLane(id) is the task's Lane where the range starts
 * (null when the task is not there, has no Lane, or there is no start). A task whose Lane is
 * not the lane is accepted when that Lane was set after the start. lane null skips the lane rule.
 */
export function checkCommit(commit, context) {
  const { config } = context
  const lane = context.lane ?? null
  const tasksFolder = `${config.dir}/tasks`
  if (commitExemption(commit, context) !== null) return []
  if (!commit.paths.some((path) => isCode(path, config))) return []
  const problems = []
  const problem = (message) => problems.push({ file: commit.short, line: 0, message: `"${commit.subject}" ${message}` })
  const { ids, maintenance } = taskTrailers(commit.message)
  if (ids.length === 0 && !maintenance && commit.parents.length > 1) {
    const shown = commit.paths.filter((path) => isCode(path, config))
    const more = shown.length > RANGE_SHOWN_PATHS ? ` and ${shown.length - RANGE_SHOWN_PATHS} more` : ''
    problem(
      `is a merge that changes code neither side changed (${shown.slice(0, RANGE_SHOWN_PATHS).join(', ')}${more}), but names no task. Add a trailer line "Task: <id>" to the message body for the task that change belongs to, or make the change in its own commit`
    )
    return problems
  }
  if (ids.length === 0 && !maintenance) {
    problem(
      'changes code but names no task. Add a trailer line "Task: <id>" to the message body for the task it belongs to, or "Task: maintenance" for a change with no behaviour change'
    )
    return problems
  }
  const valid = []
  for (const id of ids) {
    if (TASK_ID.test(id)) valid.push(id)
    else
      problem(
        `has "${id}" in its Task: trailer, which is not a task id. Write ids such as S4 or S4.1, separated by commas, or "maintenance" in lowercase`
      )
  }

  const laneChecks = []
  for (const id of valid) {
    const task = context.task(id)
    if (task === null) {
      problem(`names task ${id}, which has no file in ${tasksFolder}/ in that commit. Add the task file, or name the task the change belongs to`)
      continue
    }
    if (task.status !== 'doing' && task.status !== 'done') {
      problem(
        `names task ${id}, which is ${task.status ?? 'without a status'} in that commit. A commit can only name a task that is doing or done in its own tree: claim the task first, or name the task the change belongs to`
      )
      continue
    }
    if (lane !== null && task.lane !== lane) laneChecks.push({ id, task })
  }

  // The lane rule only refuses naming a task that another lane held before the start: a Lane
  // equal to this lane, or set after the start (by a claim, also in a records-only commit, or
  // under a branch name that was later renamed), is accepted. Taking a held task without
  // claim --take is caught by the ownership check in pre-commit and CI (H1 and C1), not here.
  for (const { id, task } of laneChecks) {
    if (task.lane === null) {
      problem(`names task ${id}, which has no Lane in that commit. Claim the task for "${lane}" first`)
      continue
    }
    if (context.startLane(id) !== task.lane) continue
    problem(
      `names task ${id}, which is held by lane "${task.lane}" before this range, not by "${lane}". Name a task this lane holds, or take it over with claim --take`
    )
  }
  return problems
}

/**
 * Checks every commit in from..to, oldest first, and returns problems as
 * { file: <short hash>, line: 0, message }. Without `from`, every ancestor of `to` is checked.
 *
 * context is { config, lane, skipGitHubMerges, root }: the effective configuration; the lane
 * (branch) that must hold each named task, or null to skip that rule; whether commits that
 * GitHub made when merging a pull request are skipped (the CI push check); and the repository,
 * by default the one of the current folder.
 *
 * Each commit is judged by checkCommit, with its own tree and the tasks at `from`: a merge
 * that changes no code of its own and a real revert are skipped (rangeCommits). A commit that
 * changes code needs a Task: trailer; each id it names must be doing or done in that commit's
 * own tree, with a Lane there that is the lane or was set inside the range (not held by another
 * lane already at `from`). "maintenance" is allowed.
 */
export function checkRange(from, to, context) {
  const { config } = context
  const root = context.root ?? repositoryRoot()
  const tasksFolder = `${config.dir}/tasks`
  const commits = rangeCommits(root, config, from, to).filter(
    (commit) => commitExemption(commit, context) === null && commit.paths.some((path) => isCode(path, config))
  )
  if (commits.length === 0) return []
  const hashBytes = commits[0].hash.length / 2

  // One batch for the tasks folder of every commit that names a task id, one for the task files they name.
  const naming = commits.filter((commit) => taskTrailers(commit.message).ids.some((id) => TASK_ID.test(id)))
  const trees = rangeObjects(
    root,
    naming.map((commit) => `${commit.hash}:${tasksFolder}`)
  )
  const entriesOf = new Map()
  const wanted = []
  for (const commit of naming) {
    const tree = trees.get(`${commit.hash}:${tasksFolder}`)
    const entries = tree && tree.type === 'tree' ? rangeTreeEntries(tree.data, hashBytes) : new Map()
    entriesOf.set(commit.hash, entries)
    for (const id of taskTrailers(commit.message).ids) {
      const name = TASK_ID.test(id) ? taskFileFor(entries.keys(), id) : null
      if (name !== null) wanted.push(entries.get(name))
    }
  }
  const blobs = rangeObjects(root, wanted)
  const parsed = new Map()
  const taskIn = (entries, id) => {
    const name = taskFileFor(entries.keys(), id)
    if (name === null) return null
    const oid = entries.get(name)
    const key = `${oid} ${name}`
    if (!parsed.has(key)) parsed.set(key, parseTask(`${tasksFolder}/${name}`, blobs.get(oid)?.data.toString('utf8') ?? ''))
    return parsed.get(key)
  }

  // The Lanes at `from`, read only when the lane rule needs one.
  let startEntries = null
  const lanesAtStart = new Map() // id → its Lane at `from`, or null when the task is not there or has none
  const startLane = (id) => {
    if (!from) return null
    if (lanesAtStart.has(id)) return lanesAtStart.get(id)
    if (startEntries === null) {
      const startTree = rangeObjects(root, [`${from}:${tasksFolder}`]).get(`${from}:${tasksFolder}`)
      startEntries = startTree && startTree.type === 'tree' ? rangeTreeEntries(startTree.data, hashBytes) : new Map()
    }
    const name = taskFileFor(startEntries.keys(), id)
    const blob = name === null ? undefined : rangeObjects(root, [startEntries.get(name)]).get(startEntries.get(name))
    const lane = blob ? parseTask(`${tasksFolder}/${name}`, blob.data.toString('utf8')).lane : null
    lanesAtStart.set(id, lane)
    return lane
  }

  return commits.flatMap((commit) =>
    checkCommit(commit, {
      ...context,
      config,
      task: (id) => taskIn(entriesOf.get(commit.hash) ?? new Map(), id),
      startLane
    })
  )
}
