// Lanes (spec 6.1 and 6.4): the current branch, the local branches and the other worktrees
// of this repository, each with the task files it holds on disk.
//
// A lane is { branch, path?, source, tasks, lastCommit? }. source is 'this' for the current
// worktree and 'worktree' for another local one; W2 adds 'remote' lanes in the same shape.
import { existsSync, realpathSync } from 'node:fs'
import { parseTask } from './tasks.mjs'
import { git, repositoryRoot } from './util.mjs'
import { treeReader } from './workspace.mjs'

const LANES_MARKDOWN = /\.(md|markdown)$/i

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
    return realpathSync(path)
  } catch {
    return null
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
 * The lanes are sorted by branch name.
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
      tasks = laneTasks(treeReader({ kind: 'worktree', root: worktree.path }), config.dir)
    } catch {
      // A worktree git cannot read is shown with no tasks rather than stopping work.
    }
    const lane = { branch: worktree.branch, path: worktree.path, source: 'worktree', tasks }
    if (branches.has(worktree.branch)) lane.lastCommit = branches.get(worktree.branch)
    lanes.push(lane)
  }
  return lanes.sort((a, b) => (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0))
}
