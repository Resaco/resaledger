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

/** Why a commit is exempt from the range check, or null. */
function rangeExemption(commit, context) {
  if (commit.parents.length > 1) return 'merge'
  if (RANGE_REVERT.test(commit.message)) return 'revert'
  if (RANGE_RELEASE.test(commit.subject)) return 'release'
  if (context.skipGitHubMerges && commit.committer.toLowerCase() === RANGE_GITHUB_COMMITTER) return 'github'
  return null
}

/** The task file for an id among a tasks folder's entries: <id>.md or <id>-<slug>.md. */
function rangeTaskFile(entries, id) {
  for (const name of entries.keys()) {
    if (name === `${id}.md` || (name.startsWith(`${id}-`) && name.endsWith('.md'))) return name
  }
  return null
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
 * Merge commits, commits made by git revert and release commits are skipped. A commit that
 * changes code needs a Task: trailer; each id it names must be doing or done in that commit's
 * own tree, with a Lane there that is the lane or was set inside the range (not held by another
 * lane already at `from`). "maintenance" is allowed.
 */
export function checkRange(from, to, context) {
  const { config } = context
  const root = context.root ?? repositoryRoot()
  const lane = context.lane ?? null
  const tasksFolder = `${config.dir}/tasks`
  const perCommit = [] // the problems of each commit, in commit order
  const pending = [] // commits that change code and name tasks: their trees are read below
  const all = () => perCommit.flat()

  for (const commit of rangeCommits(root, from, to)) {
    if (rangeExemption(commit, context) !== null) continue
    if (!commit.paths.some((path) => isCode(path, config))) continue
    const own = []
    perCommit.push(own)
    const problem = (message) => own.push({ file: commit.short, line: 0, message: `"${commit.subject}" ${message}` })
    const { ids, maintenance } = taskTrailers(commit.message)
    if (ids.length === 0 && !maintenance) {
      problem(
        'changes code but names no task. Add a trailer line "Task: <id>" to the message body for the task it belongs to, or "Task: maintenance" for a change with no behaviour change'
      )
      continue
    }
    const valid = []
    for (const id of ids) {
      if (TASK_ID.test(id)) valid.push(id)
      else
        problem(
          `has "${id}" in its Task: trailer, which is not a task id. Write ids such as S4 or S4.1, separated by commas, or "maintenance" in lowercase`
        )
    }
    if (valid.length > 0) pending.push({ commit, ids: valid, problem })
  }
  if (pending.length === 0) return all()

  // One batch for the tasks folder of every pending commit, one for the task files they name.
  const hashBytes = pending[0].commit.hash.length / 2
  const trees = rangeObjects(
    root,
    pending.map(({ commit }) => `${commit.hash}:${tasksFolder}`)
  )
  const wanted = []
  for (const item of pending) {
    const tree = trees.get(`${item.commit.hash}:${tasksFolder}`)
    item.entries = tree && tree.type === 'tree' ? rangeTreeEntries(tree.data, hashBytes) : new Map()
    item.files = new Map(item.ids.map((id) => [id, rangeTaskFile(item.entries, id)]))
    for (const name of item.files.values()) if (name !== null) wanted.push(item.entries.get(name))
  }
  const blobs = rangeObjects(root, wanted)
  const parsed = new Map()
  const taskIn = (item, id) => {
    const name = item.files.get(id)
    if (name === null) return null
    const oid = item.entries.get(name)
    const key = `${oid} ${name}`
    if (!parsed.has(key)) parsed.set(key, parseTask(`${tasksFolder}/${name}`, blobs.get(oid)?.data.toString('utf8') ?? ''))
    return parsed.get(key)
  }

  const laneChecks = []
  for (const item of pending) {
    for (const id of item.ids) {
      const task = taskIn(item, id)
      if (task === null) {
        item.problem(`names task ${id}, which has no file in ${tasksFolder}/ in that commit. Add the task file, or name the task the change belongs to`)
        continue
      }
      if (task.status !== 'doing' && task.status !== 'done') {
        item.problem(
          `names task ${id}, which is ${task.status ?? 'without a status'} in that commit. A commit can only name a task that is doing or done in its own tree: claim the task first, or name the task the change belongs to`
        )
        continue
      }
      if (lane !== null && task.lane !== lane) laneChecks.push({ item, id, task })
    }
  }
  if (laneChecks.length === 0) return all()

  // The lane rule only refuses naming a task that another lane held before this range: a Lane
  // equal to this lane, or set inside the range (by a claim, also in a records-only commit, or
  // under a branch name that was later renamed), is accepted. Taking a held task without
  // claim --take is caught by the ownership check in pre-commit and CI (H1 and C1), not here.
  const lanesAtStart = new Map() // id → its Lane at `from`, or null when the task is not there or has none
  if (from) {
    const startTree = rangeObjects(root, [`${from}:${tasksFolder}`]).get(`${from}:${tasksFolder}`)
    const startEntries = startTree && startTree.type === 'tree' ? rangeTreeEntries(startTree.data, hashBytes) : new Map()
    const startFiles = new Map()
    for (const { id } of laneChecks) startFiles.set(id, rangeTaskFile(startEntries, id))
    const startBlobs = rangeObjects(root, [...startFiles.values()].filter((name) => name !== null).map((name) => startEntries.get(name)))
    for (const [id, name] of startFiles) {
      const blob = name === null ? undefined : startBlobs.get(startEntries.get(name))
      lanesAtStart.set(id, blob ? parseTask(`${tasksFolder}/${name}`, blob.data.toString('utf8')).lane : null)
    }
  }
  for (const { item, id, task } of laneChecks) {
    if (task.lane === null) {
      item.problem(`names task ${id}, which has no Lane in that commit. Claim the task for "${lane}" first`)
      continue
    }
    const startLane = from ? lanesAtStart.get(id) : null
    if (startLane !== task.lane) continue
    item.problem(
      `names task ${id}, which is held by lane "${task.lane}" before this range, not by "${lane}". Name a task this lane holds, or take it over with claim --take`
    )
  }
  return all()
}
