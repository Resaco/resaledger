// Task ids across branches (spec 6.7): which ids every branch in the clone has, read in one
// batch, and the ids a change adds that another branch already has as a different task.
import { spawnSync } from 'node:child_process'

const IDS_MAX_BUFFER = 1024 * 1024 * 1024
// A task file's name carries its id; the records check holds the heading to it.
const IDS_FILE_NAME = /^([A-Z]{1,4}\d+(?:\.\d+)*)(?:-[^/]+)?\.md$/

/** Runs git in a folder and returns stdout as a Buffer; throws with git's message when it fails. */
function idsGit(root, args, input) {
  const result = spawnSync('git', args, { cwd: root, input, maxBuffer: IDS_MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString('utf8').trim()}`)
  return result.stdout
}

/** The file names in a raw tree object (blobs only). */
function idsTreeNames(data, hashBytes) {
  const names = []
  let at = 0
  while (at < data.length) {
    const space = data.indexOf(32, at)
    const nul = data.indexOf(0, space)
    if (space === -1 || nul === -1) break
    const mode = data.toString('utf8', at, space)
    if (!mode.startsWith('40')) names.push(data.toString('utf8', space + 1, nul))
    at = nul + 1 + hashBytes
  }
  return names
}

/**
 * The task files of every branch in the clone, local (refs/heads) and remote-tracking
 * (refs/remotes), from one `git for-each-ref` and one `git cat-file --batch`, without reading
 * any task file: the id comes from the file name. Symbolic refs such as origin/HEAD are skipped.
 *
 * options is { root, dir, exclude }: the repository, the workspace folder, and an optional
 * exclude({ ref, branch, commit }) that leaves a branch out.
 *
 * Returns [{ ref, branch, commit, files }], where branch is the short name (origin/S4-x) and
 * files is a Map from id to the task file's repository path. A branch without a tasks folder
 * has an empty Map.
 */
export function branchTaskFiles(options) {
  const { root, dir } = options
  const exclude = options.exclude ?? (() => false)
  const branches = []
  const output = idsGit(root, ['for-each-ref', '--format=%(objectname)%00%(objecttype)%00%(refname)%00%(refname:short)%00%(symref)', 'refs/heads/', 'refs/remotes/'])
  for (const line of output.toString('utf8').split('\n')) {
    if (line === '') continue
    const [commit, type, ref, branch, symref] = line.split('\0')
    if (type !== 'commit' || symref !== '') continue
    const entry = { ref, branch, commit, files: new Map() }
    if (!exclude(entry)) branches.push(entry)
  }
  if (branches.length === 0) return branches

  const folder = `${dir}/tasks`
  const commits = [...new Set(branches.map((entry) => entry.commit))]
  const batch = idsGit(root, ['cat-file', '--batch'], `${commits.map((commit) => `${commit}:${folder}`).join('\n')}\n`)
  const hashBytes = commits[0].length / 2
  const filesOf = new Map()
  let at = 0
  for (const commit of commits) {
    const end = batch.indexOf(10, at)
    if (end === -1) break
    const header = batch.toString('utf8', at, end).split(' ')
    at = end + 1
    if (header.length < 3) continue // missing or ambiguous: no tasks folder
    const size = Number(header[2])
    const files = new Map()
    if (header[1] === 'tree') {
      for (const name of idsTreeNames(batch.subarray(at, at + size), hashBytes)) {
        const named = name.match(IDS_FILE_NAME)
        if (named && !files.has(named[1])) files.set(named[1], `${folder}/${name}`)
      }
    }
    filesOf.set(commit, files)
    at += size + 1
  }
  for (const entry of branches) entry.files = filesOf.get(entry.commit) ?? new Map()
  return branches
}

/**
 * The id collisions of a change (spec 6.7): each id the change adds that another branch has in
 * a different file. The same path is the same task, which the ownership rules cover.
 *
 * added is [{ id, file }], the tasks the change adds (not in its "before" tree). others is
 * [{ branch, files, worktree? }], files a Map from id to path; worktree marks a branch read from
 * another worktree's disk. Returns problems on the added file, one per id and other file.
 */
export function idCollisions(added, others, config) {
  const guard = `node ${config.dir}/scripts/records.mjs`
  const problems = []
  const seen = new Set()
  for (const { id, file } of added) {
    for (const other of others) {
      const theirs = other.files.get(id)
      if (theirs === undefined || theirs === file) continue
      const key = `${id}\0${other.branch}\0${theirs}`
      if (seen.has(key)) continue
      seen.add(key)
      const where = other.worktree ? `the worktree of branch "${other.branch}"` : `branch "${other.branch}"`
      problems.push({
        file,
        line: 0,
        message: `task ${id} is new here, but ${where} already has ${id} in ${theirs}. Rename this task's file and id to a free one; "${guard} new" takes the next free number`
      })
    }
  }
  return problems
}
