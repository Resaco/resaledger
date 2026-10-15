// Lanes (spec 6.1 and 6.4): the current branch, the local branches and the other worktrees
// of this repository, each with the task files it holds on disk, and the pushed branches not
// yet merged into the base, each with the task files that differ from the base's.
//
// A lane is { branch, path?, source, tasks, lastCommit? }. source is 'this' for the current
// worktree, 'worktree' for another local one and 'remote' for a remote-tracking branch.
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { stampPath, verifiedStamp } from './gates.mjs'
import { parseTask } from './tasks.mjs'
import { git, repositoryRoot } from './util.mjs'
import { fingerprint, treeReader } from './workspace.mjs'

const LANES_MARKDOWN = /\.(md|markdown)$/i
// The variables git sets for a hook that point at this worktree's repository and index.
const LANES_LOCATION_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY']

/** The current branch name, or null in a detached HEAD or outside a repository. */
export function currentLane() {
  try {
    return git('symbolic-ref', '--short', '-q', 'HEAD') || null
  } catch {
    return null
  }
}

/**
 * The local branches, as a Map from branch name to the last commit's { author, date }
 * (date in strict ISO 8601). A branch with no commit yet, such as main in a new repository,
 * is not in it.
 */
export function localBranches() {
  const branches = new Map()
  let output = ''
  try {
    output = git('for-each-ref', '--format=%(refname:short)%00%(authorname)%00%(authordate:iso-strict)', 'refs/heads/')
  } catch {
    return branches
  }
  for (const line of output.split('\n')) {
    if (line === '') continue
    const [branch, author, date] = line.split('\0')
    branches.set(branch, { author, date })
  }
  return branches
}

/** The parsed task files directly in <dir>/tasks of a reader. */
export function laneTasks(reader, dir) {
  const folder = `${dir}/tasks`
  return reader
    .list(folder)
    .filter((path) => LANES_MARKDOWN.test(path) && !path.slice(folder.length + 1).includes('/'))
    .map((path) => parseTask(path, reader.read(path) ?? ''))
}

/** A folder's real path for comparison, or null when it does not exist. */
function lanesRealPath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

/**
 * Runs read() without git's location variables, and restores them after. git sets
 * GIT_INDEX_FILE (and for some hooks GIT_DIR) for a hook; another worktree read with them
 * would list this worktree's index instead of that worktree's files.
 */
function lanesWithoutLocation(read) {
  const saved = new Map(LANES_LOCATION_VARIABLES.filter((name) => name in process.env).map((name) => [name, process.env[name]]))
  for (const name of saved.keys()) delete process.env[name]
  try {
    return read()
  } finally {
    for (const [name, value] of saved) process.env[name] = value
  }
}

/** The worktrees from `git worktree list --porcelain`, as [{ path, branch, bare, detached, prunable }]. */
function lanesWorktrees() {
  const worktrees = []
  let current = null
  for (const line of git('worktree', 'list', '--porcelain').split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null, bare: false, detached: false, prunable: false }
      worktrees.push(current)
    } else if (current === null) continue
    else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    else if (line === 'bare') current.bare = true
    else if (line === 'detached') current.detached = true
    else if (line.startsWith('prunable')) current.prunable = true
  }
  return worktrees
}

/**
 * The other worktrees of this repository as lanes: [{ branch, path, source: 'worktree', tasks,
 * lastCommit }]. Task files are read from each worktree's disk, so an uncommitted claim shows.
 * Bare and detached worktrees, the current one and worktrees whose folder is gone are skipped.
 * The lanes are sorted by branch name. Each worktree is read without git's location variables,
 * so this is safe inside a hook.
 * `branches` is localBranches(), passed in when the caller already has it.
 */
export function localLanes(config, branches = localBranches()) {
  const here = lanesRealPath(repositoryRoot())
  const lanes = []
  for (const worktree of lanesWorktrees()) {
    if (worktree.bare || worktree.detached || worktree.prunable || worktree.branch === null) continue
    if (!existsSync(worktree.path)) continue
    const real = lanesRealPath(worktree.path)
    if (real === null || real === here) continue
    let tasks = []
    try {
      tasks = lanesWithoutLocation(() => laneTasks(treeReader({ kind: 'worktree', root: worktree.path }), config.dir))
    } catch {
      // A worktree git cannot read is shown with no tasks rather than stopping work.
    }
    const lane = { branch: worktree.branch, path: worktree.path, source: 'worktree', tasks }
    if (branches.has(worktree.branch)) lane.lastCommit = branches.get(worktree.branch)
    lanes.push(lane)
  }
  return lanes.sort((a, b) => (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0))
}

const LANES_MAX_BUFFER = 1024 * 1024 * 1024

/** Runs git in a folder and returns stdout as a Buffer; throws with git's message when it fails. */
function lanesGit(root, args, input) {
  const result = spawnSync('git', args, { cwd: root, input, maxBuffer: LANES_MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString('utf8').trim()}`)
  return result.stdout
}

/** The remotes of a repository, by name. */
function lanesRemotes(root) {
  return lanesGit(root, ['remote']).toString('utf8').split('\n').filter((name) => name !== '')
}

/**
 * The remote that fetching and the base default to: the base branch's configured remote,
 * else origin, else the first remote; null when there is none.
 */
export function defaultRemote(root, base) {
  const remotes = lanesRemotes(root)
  if (remotes.length === 0) return null
  const configured = spawnSync('git', ['config', '--get', `branch.${base}.remote`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const named = configured.status === 0 ? configured.stdout.trim() : ''
  if (remotes.includes(named)) return named
  return remotes.includes('origin') ? 'origin' : remotes[0]
}

/**
 * Objects read in one `git cat-file --batch`, in the order asked: each is { oid, type, data }
 * with data a Buffer, or null when the object is missing.
 */
function lanesBatch(root, names) {
  if (names.length === 0) return []
  const output = lanesGit(root, ['cat-file', '--batch'], `${names.join('\n')}\n`)
  const objects = []
  let at = 0
  for (let index = 0; index < names.length; index += 1) {
    const end = output.indexOf(10, at)
    if (end === -1) break
    const header = output.toString('utf8', at, end).split(' ')
    at = end + 1
    if (header.length < 3) {
      objects.push(null) // missing or ambiguous
      continue
    }
    const size = Number(header[2])
    objects.push({ oid: header[0], type: header[1], data: output.subarray(at, at + size) })
    at += size + 1
  }
  return objects
}

/** The Markdown files of a raw tree object, as a Map from file name to blob id (hex). */
function lanesTreeFiles(data, hashBytes) {
  const files = new Map()
  let at = 0
  while (at < data.length) {
    const space = data.indexOf(32, at)
    const nul = data.indexOf(0, space)
    if (space === -1 || nul === -1) break
    const mode = data.toString('utf8', at, space)
    const name = data.toString('utf8', space + 1, nul)
    if (!mode.startsWith('40') && LANES_MARKDOWN.test(name)) files.set(name, data.toString('hex', nul + 1, nul + 1 + hashBytes))
    at = nul + 1 + hashBytes
  }
  return files
}

/**
 * The commits each head has that the base does not, as a Map from head to count, from one
 * `git rev-list --parents`: the fallback for git before 2.41, which has no ahead-behind atom.
 */
function lanesAheadCounts(root, baseRef, heads) {
  const counts = new Map()
  if (heads.length === 0) return counts
  const parents = new Map()
  const listed = lanesGit(root, ['rev-list', '--parents', '--stdin'], `${heads.join('\n')}\n^${baseRef}\n`)
  for (const line of listed.toString('utf8').split('\n')) {
    if (line === '') continue
    const [commit, ...rest] = line.split(' ')
    parents.set(commit, rest)
  }
  for (const head of heads) {
    // Every commit the walk lists is not in the base; a parent it does not list is.
    const seen = new Set()
    const stack = parents.has(head) ? [head] : []
    while (stack.length > 0) {
      const commit = stack.pop()
      if (seen.has(commit)) continue
      seen.add(commit)
      for (const parent of parents.get(commit)) if (parents.has(parent) && !seen.has(parent)) stack.push(parent)
    }
    counts.set(head, seen.size)
  }
  return counts
}

/** Whether a ref exists. */
function lanesRefExists(root, ref) {
  return spawnSync('git', ['rev-parse', '--verify', '-q', `${ref}^{commit}`], { cwd: root, stdio: 'ignore' }).status === 0
}

/**
 * The pushed lanes (spec 6.4): the remote-tracking branches, as last fetched, that are not
 * merged into the base, newest first. The base is the default remote's base branch when it
 * exists, else the local one. The symbolic HEAD and each remote's base branch are left out, and
 * a branch name on several remotes is one lane, the default remote's.
 *
 * Only the task files that differ from the base's are read: each branch's tasks folder in one
 * `git cat-file --batch`, the blob ids compared with the base's, and the differing blobs in a
 * second batch. A task identical to the base's is the base's own task, not that lane's claim.
 *
 * options is { root, config, local }: local is the set of branch names that are lanes on this
 * machine (this worktree and the other worktrees). A pushed branch with such a name is not a
 * remote lane; it is named in `pushed` instead.
 *
 * Returns { base, remote, lanes, baseTasks, pushed, live, branches }:
 * - base: the ref merged is measured against, such as 'origin/main', or null when none exists;
 * - lanes: [{ branch, source: 'remote', remote, ref, commit, tasks, lastCommit, ahead, verification }],
 *   ahead the commits ahead of the base (null without a base) and verification 'verified',
 *   'unverified', 'no-gates' or null (computed only for lanes that change a task);
 * - baseTasks: the base's parsed task files;
 * - pushed: the local lane names that have a remote-tracking branch;
 * - live: the branch names, local or remote, not merged into the base;
 * - branches: every branch name, local or remote, merged or not.
 */
export function remoteLanes(options) {
  const { root, config } = options
  const local = options.local ?? new Set()
  const remotes = lanesRemotes(root)
  const remote = defaultRemote(root, config.base)
  let base = null
  if (remote !== null && lanesRefExists(root, `refs/remotes/${remote}/${config.base}`)) base = `${remote}/${config.base}`
  else if (lanesRefExists(root, `refs/heads/${config.base}`)) base = config.base
  const baseRef = base === null ? null : base === config.base ? `refs/heads/${base}` : `refs/remotes/${base}`

  // Every branch, and which of them are not merged into the base.
  const format = '%(objectname)%00%(objecttype)%00%(refname)%00%(symref)%00%(authorname)%00%(authordate:iso-strict)'
  const listArgs = (extra) => ['for-each-ref', '--sort=-committerdate', `--format=${format}${extra}`, 'refs/heads/', 'refs/remotes/']
  let output
  let counted = false
  if (baseRef !== null) {
    try {
      output = lanesGit(root, listArgs(`%00%(ahead-behind:${baseRef})`))
      counted = true
    } catch {
      // git before 2.41 has no ahead-behind atom; lanesAheadCounts counts them below.
    }
  }
  if (!counted) output = lanesGit(root, listArgs(''))
  const unmerged = new Set(
    baseRef === null
      ? []
      : lanesGit(root, ['for-each-ref', `--no-merged=${baseRef}`, '--format=%(refname)', 'refs/heads/', 'refs/remotes/'])
          .toString('utf8')
          .split('\n')
          .filter((ref) => ref !== '')
  )
  const isLive = (ref) => baseRef === null || unmerged.has(ref)

  const branches = new Set()
  const live = new Set()
  const pushed = new Set()
  const byName = new Map()
  // Longest remote name first, so that a remote named a/b wins over a.
  const remotePrefixes = [...remotes].sort((a, b) => b.length - a.length).map((name) => [name, `refs/remotes/${name}/`])
  for (const line of output.toString('utf8').split('\n')) {
    if (line === '') continue
    const [commit, type, ref, symref, author, date, aheadBehind] = line.split('\0')
    if (type !== 'commit' || symref !== '') continue
    if (ref.startsWith('refs/heads/')) {
      const branch = ref.slice('refs/heads/'.length)
      branches.add(branch)
      if (isLive(ref)) live.add(branch)
      continue
    }
    const owner = remotePrefixes.find(([, prefix]) => ref.startsWith(prefix))
    if (!owner) continue
    const [remoteName, prefix] = owner
    const branch = ref.slice(prefix.length)
    branches.add(branch)
    if (local.has(branch)) {
      pushed.add(branch)
      continue
    }
    if (branch === config.base) continue
    if (!isLive(ref)) continue
    live.add(branch)
    const lane = { branch, source: 'remote', remote: remoteName, ref, commit, tasks: [], lastCommit: { author, date }, ahead: null, verification: null }
    if (counted) lane.ahead = Number(aheadBehind.split(' ')[0])
    const known = byName.get(branch)
    if (known === undefined || (remoteName === remote && known.remote !== remote)) byName.set(branch, lane)
  }
  const lanes = [...byName.values()]

  // The tasks folders of the base and every lane, in one batch.
  const folder = `${config.dir}/tasks`
  const commits = [...new Set(lanes.map((lane) => lane.commit))]
  const trees = lanesBatch(root, [...(baseRef === null ? [] : [`${baseRef}:${folder}`]), ...commits.map((commit) => `${commit}:${folder}`)])
  const filesOf = (object) => (object && object.type === 'tree' ? lanesTreeFiles(object.data, object.oid.length / 2) : new Map())
  const baseFiles = baseRef === null ? new Map() : filesOf(trees[0])
  const laneFiles = new Map(commits.map((commit, index) => [commit, filesOf(trees[index + (baseRef === null ? 0 : 1)])]))

  // The differing blobs and the base's, in a second batch.
  const wanted = new Set(baseFiles.values())
  const differing = new Map()
  for (const [commit, files] of laneFiles) {
    const changed = [...files].filter(([name, oid]) => baseFiles.get(name) !== oid)
    differing.set(commit, changed)
    for (const [, oid] of changed) wanted.add(oid)
  }
  const oids = [...wanted]
  const texts = new Map(lanesBatch(root, oids).map((object, index) => [oids[index], object ? object.data.toString('utf8') : '']))
  const parsed = (name, oid) => parseTask(`${folder}/${name}`, texts.get(oid) ?? '')
  const baseTasks = [...baseFiles].map(([name, oid]) => parsed(name, oid))
  for (const lane of lanes) lane.tasks = differing.get(lane.commit).map(([name, oid]) => parsed(name, oid))

  if (!counted && baseRef !== null) {
    const ahead = lanesAheadCounts(root, baseRef, commits)
    for (const lane of lanes) lane.ahead = ahead.get(lane.commit)
  }

  // Verification only for lanes that change a task: it costs a tree listing per head.
  const holding = lanes.filter((lane) => lane.tasks.length > 0)
  const gates = config.gates.commit.length + config.gates.verify.length
  if (gates === 0) for (const lane of holding) lane.verification = 'no-gates'
  else {
    const codes = new Map()
    for (const commit of new Set(holding.map((lane) => lane.commit))) codes.set(commit, fingerprint({ kind: 'commit', rev: commit, root }, config))
    const stampCommits = [...codes.keys()]
    const stamps = lanesBatch(root, stampCommits.map((commit) => `${commit}:${stampPath(config, codes.get(commit))}`))
    const verified = new Map(
      stampCommits.map((commit, index) => {
        const text = stamps[index] && stamps[index].type === 'blob' ? stamps[index].data.toString('utf8') : null
        return [commit, verifiedStamp({ read: () => text }, config, codes.get(commit)) !== null]
      })
    )
    for (const lane of holding) lane.verification = verified.get(lane.commit) ? 'verified' : 'unverified'
  }
  return { base, remote, lanes, baseTasks, pushed, live, branches }
}
