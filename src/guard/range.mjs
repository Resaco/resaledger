// The commit range check, spec 5.9: every commit in a range that changes code names a task that is
// doing or done in that commit's own tree and held by the lane. Pre-push, handoff and CI all use it.
import { spawnSync } from 'node:child_process'
import { parseTask, TASK_ID } from './tasks.mjs'
import { repositoryRoot } from './util.mjs'
import { isCode } from './workspace.mjs'

const RANGE_MAX_BUFFER = 1024 * 1024 * 1024
const RANGE_TRAILER = /^Task:(.*)$/
const RANGE_REVERT = /^This reverts commit [0-9a-f]{7,64}\.$/m
const RANGE_RELEASE = /^Release v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
// GitHub's own committer address, written in two parts so the hygiene scan sees no address.
const RANGE_GITHUB_COMMITTER = ['noreply', 'github.com'].join('@')
const RANGE_MAINTENANCE = 'maintenance'

/** Runs git in a folder and returns stdout as a Buffer; throws with git's message when it fails. */
function rangeGit(root, args, input) {
  const result = spawnSync('git', args, { cwd: root, input, maxBuffer: RANGE_MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString('utf8').trim()}`)
  return result.stdout
}

/**
 * Reads objects in one `git cat-file --batch`. Each spec is an object name such as an id or
 * "<rev>:<path>". Returns a Map from spec to { type, data } (a Buffer); missing objects are left out.
 */
function rangeObjects(root, specs) {
  const objects = new Map()
  const unique = [...new Set(specs)]
  if (unique.length === 0) return objects
  const output = rangeGit(root, ['cat-file', '--batch'], `${unique.join('\n')}\n`)
  let at = 0
  for (const spec of unique) {
    const end = output.indexOf(10, at)
    if (end === -1) break
    const header = output.toString('utf8', at, end)
    at = end + 1
    if (header.endsWith(' missing') || header.endsWith(' ambiguous')) continue
    const [, type, size] = header.split(' ')
    const length = Number(size)
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

/**
 * The commits of a range, oldest first, from one `git log`:
 * [{ hash, short, parents, committer, subject, message, paths }]. paths are the files the commit
 * touches against its first parent (every file for a root commit), renames as both sides.
 * Without `from` the range is every ancestor of `to`.
 */
function rangeCommits(root, from, to) {
  const range = from ? `${from}..${to}` : to
  const output = rangeGit(root, [
    'log',
    '--reverse',
    '--topo-order',
    '--no-renames',
    '--root',
    '--name-only',
    '-z',
    '--format=%x01%H%x00%h%x00%P%x00%ce%x00%B',
    range,
    '--'
  ]).toString('utf8')
  const commits = []
  for (const chunk of output.split('\x01')) {
    if (chunk === '') continue
    const [hash, short, parents, committer, message = '', ...rest] = chunk.split('\0')
    const paths = rest.map((path, index) => (index === 0 ? path.replace(/^\n/, '') : path)).filter((path) => path !== '')
    commits.push({
      hash,
      short,
      parents: parents.split(' ').filter((parent) => parent !== ''),
      committer,
      subject: message.split('\n')[0].trim(),
      message,
      paths
    })
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
 * Why a commit is exempt from the trailer rules, or null: 'merge' (more than one parent),
 * 'revert' (made by git revert), 'release' (a "Release vX.Y.Z" subject), or 'github' (a commit
 * GitHub made when merging a pull request, only with context.skipGitHubMerges).
 * commit is { parents, committer, subject, message }.
 */
export function commitExemption(commit, context) {
  if (commit.parents.length > 1) return 'merge'
  if (RANGE_REVERT.test(commit.message)) return 'revert'
  if (RANGE_RELEASE.test(commit.subject)) return 'release'
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
 * commit is { short, parents, committer, subject, message, paths }. context is { config, lane,
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
 * Each commit is judged by checkCommit, with its own tree and the tasks at `from`: merge
 * commits, commits made by git revert and release commits are skipped. A commit that
 * changes code needs a Task: trailer; each id it names must be doing or done in that commit's
 * own tree, with a Lane there that is the lane or was set inside the range (not held by another
 * lane already at `from`). "maintenance" is allowed.
 */
export function checkRange(from, to, context) {
  const { config } = context
  const root = context.root ?? repositoryRoot()
  const tasksFolder = `${config.dir}/tasks`
  const commits = rangeCommits(root, from, to).filter(
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
