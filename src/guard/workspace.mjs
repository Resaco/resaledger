// The workspace as a whole: files read from the working tree, the index or a commit; every
// record loaded and checked; what counts as code (spec 5.10) and the code fingerprint (spec 5.7).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_FILE, loadConfig, unknownKeyNotices } from './config.mjs'
import { parseDecision, parseLogEntry, parseReadme, planStatus, validateDecision, validateLogEntry, validatePlanStatus, validateReadme } from './records.mjs'
import { parseTask, validateTask, validateTaskSet } from './tasks.mjs'
import { fail, recordCounts, repositoryRoot } from './util.mjs'

const WORKSPACE_IMAGE = /\.(avif|gif|jpe?g|png|svg|webp)$/i
const WORKSPACE_MARKDOWN = /\.(md|markdown)$/i
// Files code reads or runs: inside the workspace they count as code, not as records (spec 5.10).
const WORKSPACE_CODE = /\.(js|mjs|cjs|ts|tsx|jsx|json|ya?ml|sh|py|rb|go|rs|toml)$/i
const WORKSPACE_STAMP = /^verified\/[0-9a-f]{16}\.json$/
const WORKSPACE_RECORD_FOLDERS = ['tasks/', 'decisions/', 'log/', 'plan/']
const WORKSPACE_HOOKS = '.githooks/'
const WORKSPACE_MAX_BUFFER = 1024 * 1024 * 1024

/** Runs git in a folder and returns stdout as a Buffer; throws with git's message when it fails. */
function workspaceGit(root, args, input) {
  const result = spawnSync('git', args, { cwd: root, input, maxBuffer: WORKSPACE_MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString('utf8').trim()}`)
  return result.stdout
}

/** The NUL-separated records of git output, without the empty one at the end. */
function workspaceRecords(buffer) {
  return buffer.toString('utf8').split('\0').filter((record) => record !== '')
}

/**
 * The tracked entries of the index or a commit, as [{ mode, oid, path }] sorted by path.
 * The index comes from `git ls-files -s`, a commit from `git ls-tree -r`.
 */
function workspaceEntries(root, source) {
  const entries = []
  if (source.kind === 'index') {
    for (const record of workspaceRecords(workspaceGit(root, ['ls-files', '-s', '-z']))) {
      const tab = record.indexOf('\t')
      const [mode, oid] = record.slice(0, tab).split(' ')
      entries.push({ mode, oid, path: record.slice(tab + 1) })
    }
  } else if (source.kind === 'commit') {
    if (typeof source.rev !== 'string' || source.rev === '') throw new Error('a commit source needs a rev, such as HEAD')
    for (const record of workspaceRecords(workspaceGit(root, ['ls-tree', '-r', '-z', `${source.rev}^{tree}`, '--']))) {
      const tab = record.indexOf('\t')
      const [mode, , oid] = record.slice(0, tab).split(' ')
      entries.push({ mode, oid, path: record.slice(tab + 1) })
    }
  } else {
    throw new Error(`unknown source kind ${JSON.stringify(source.kind)}; use index or commit`)
  }
  return entries
}

/** Reads blobs in one `git cat-file --batch`, as a Map from object id to text. */
function workspaceBlobs(root, oids) {
  const texts = new Map()
  if (oids.length === 0) return texts
  const output = workspaceGit(root, ['cat-file', '--batch'], `${oids.join('\n')}\n`)
  let at = 0
  while (at < output.length) {
    const end = output.indexOf(10, at)
    if (end === -1) break
    const header = output.toString('utf8', at, end).split(' ')
    at = end + 1
    if (header[1] === 'missing' || header.length < 3) continue
    const size = Number(header[2])
    texts.set(header[0], output.toString('utf8', at, at + size))
    at += size + 1
  }
  return texts
}

/** A path in the form the reader keys on: POSIX, with no leading ./ and no trailing slash. */
function workspaceKey(path) {
  return String(path).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '')
}

/**
 * Reads files from one source, with repository-relative POSIX paths:
 * { kind: 'worktree' } (the files on disk that git tracks or would add), { kind: 'index' }
 * (the staged content) or { kind: 'commit', rev }. An optional `root` names the repository;
 * by default it is the repository of the current folder.
 *
 * Returns { list(prefix), read(path), exists(path), mode(path) }. list(prefix) gives the sorted
 * file paths in a folder, at any depth ('' for all). read gives a file's text, or null when it is
 * missing. exists is true for a file and for a folder that holds at least one file. mode gives
 * git's mode of a file in the index or a commit, such as '100755', or null (always in the
 * working tree).
 */
export function treeReader(source) {
  const root = source.root ?? repositoryRoot()
  let files = null // Map of path → object id (null in the working tree)
  const modes = new Map() // path → git's mode, in the index or a commit
  let folders = null
  const texts = new Map()

  const listing = () => {
    if (files !== null) return files
    files = new Map()
    if (source.kind === 'worktree') {
      const deleted = new Set(workspaceRecords(workspaceGit(root, ['ls-files', '-z', '--deleted'])))
      for (const path of workspaceRecords(workspaceGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']))) {
        if (!deleted.has(path)) files.set(path, null)
      }
    } else {
      // In a merge conflict the index holds several stages of a path; the first one stands for it.
      for (const entry of workspaceEntries(root, source)) {
        if (files.has(entry.path)) continue
        files.set(entry.path, entry.oid)
        modes.set(entry.path, entry.mode)
      }
    }
    files = new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    folders = new Set([''])
    for (const path of files.keys()) {
      for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) folders.add(path.slice(0, slash))
    }
    return files
  }

  const fetchBlobs = (wanted) => {
    // One batch for the file asked for and, the first time, every Markdown file: the records.
    const paths = texts.size === 0 ? [...files.keys()].filter((path) => WORKSPACE_MARKDOWN.test(path) || path === wanted) : [wanted]
    const pending = paths.filter((path) => !texts.has(path))
    const blobs = workspaceBlobs(root, [...new Set(pending.map((path) => files.get(path)))])
    for (const path of pending) texts.set(path, blobs.get(files.get(path)) ?? null)
  }

  return {
    list(prefix = '') {
      const folder = workspaceKey(prefix)
      const start = folder === '' ? '' : `${folder}/`
      return [...listing().keys()].filter((path) => path.startsWith(start))
    },
    read(path) {
      const key = workspaceKey(path)
      if (!listing().has(key)) return null
      if (texts.has(key)) return texts.get(key)
      if (source.kind === 'worktree') {
        let text = null
        try {
          text = readFileSync(join(root, key), 'utf8')
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) throw error
        }
        texts.set(key, text)
        return text
      }
      fetchBlobs(key)
      return texts.get(key)
    },
    exists(path) {
      const key = workspaceKey(path)
      return listing().has(key) || folders.has(key)
    },
    mode(path) {
      const key = workspaceKey(path)
      listing()
      return modes.get(key) ?? null
    }
  }
}

/** The paths of the Markdown files directly in a folder. */
function workspaceMarkdownIn(reader, folder) {
  return reader.list(folder).filter((path) => WORKSPACE_MARKDOWN.test(path) && !path.slice(folder.length + 1).includes('/'))
}

/**
 * Loads every record of the workspace from a reader:
 * { dir, tasks, decisions, logs, plans, readme, problems }. plans is a Map from each plan
 * file's path to its status line or null; problems are the parse problems of every record.
 */
export function loadWorkspace(reader, config) {
  const { dir } = config
  const problems = []
  const parsed = (folder, parse) =>
    workspaceMarkdownIn(reader, `${dir}/${folder}`).map((path) => {
      const record = parse(path, reader.read(path) ?? '')
      problems.push(...record.problems)
      return record
    })
  const tasks = parsed('tasks', parseTask)
  const decisions = parsed('decisions', parseDecision)
  const logs = parsed('log', parseLogEntry)
  // A record in a subfolder is never read, so it would be lost without a word.
  for (const folder of ['tasks', 'decisions', 'log']) {
    const root = `${dir}/${folder}/`
    for (const path of reader.list(`${dir}/${folder}`)) {
      if (!WORKSPACE_MARKDOWN.test(path) || !path.slice(root.length).includes('/')) continue
      problems.push({ file: path, line: 0, message: `a record belongs directly in ${root}, where it is read; move it to ${root}${path.slice(path.lastIndexOf('/') + 1)}` })
    }
  }
  const plans = new Map()
  for (const path of reader.list(`${dir}/plan`)) {
    if (WORKSPACE_MARKDOWN.test(path)) plans.set(path, planStatus(reader.read(path) ?? ''))
  }
  const readmeText = reader.read(`${dir}/README.md`)
  const readme = readmeText === null ? null : parseReadme(`${dir}/README.md`, readmeText)
  return { dir, tasks, decisions, logs, plans, readme, problems }
}

/** Sorts problems by file, then by line, keeping the order of equal ones. */
function workspaceSortProblems(problems) {
  return problems.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
}

/**
 * Every problem in a loaded workspace: its parse problems and every validation problem,
 * sorted by file and line. The reader answers which linked files exist in the same source.
 */
export function checkWorkspace(workspace, reader, config) {
  const planStatuses = new Map(workspace.plans)
  const context = {
    exists: (path) => reader.exists(path),
    read: (path) => reader.read(path),
    planStatus: (path) => {
      // A plan outside plan/ is read when a task links to it.
      if (!planStatuses.has(path)) {
        const text = WORKSPACE_MARKDOWN.test(path) ? reader.read(path) : null
        planStatuses.set(path, text === null ? null : planStatus(text))
      }
      return planStatuses.get(path)
    },
    taskIds: new Set(workspace.tasks.map((task) => task.id).filter((id) => id)),
    config
  }
  const problems = [...workspace.problems]
  for (const task of workspace.tasks) problems.push(...validateTask(task, context))
  problems.push(...validateTaskSet(workspace.tasks, context))
  for (const decision of workspace.decisions) problems.push(...validateDecision(decision, context))
  for (const entry of workspace.logs) problems.push(...validateLogEntry(entry, context))
  for (const [path, status] of workspace.plans) problems.push(...validatePlanStatus(path, status))
  if (workspace.readme === null) {
    problems.push({
      file: `${workspace.dir}/README.md`,
      line: 0,
      message: 'the workspace README is missing. Add it with "## Goal", "## Environments" and "## Manual checks" sections'
    })
  } else problems.push(...validateReadme(workspace.readme))
  return workspaceSortProblems(problems)
}

/**
 * Whether a repository-relative path is code (spec 5.10): every file outside the workspace that
 * is not Markdown, plus, inside the workspace, scripts/, the codePaths except images there, and
 * every file with a code extension (such as .js, .json or .sh) other than a stamp in verified/
 * or a file under tasks/, decisions/, log/ or plan/. Also the git hooks and the configuration.
 * Records and documentation are not code.
 */
export function isCode(path, config) {
  const key = workspaceKey(path)
  const workspace = `${config.dir}/`
  if (key === CONFIG_FILE || key.startsWith(WORKSPACE_HOOKS)) return true
  if (key.startsWith(workspace)) {
    const inside = key.slice(workspace.length)
    if (inside.startsWith('scripts/')) return true
    if (config.codePaths.some((codePath) => inside.startsWith(`${codePath}/`))) return !WORKSPACE_IMAGE.test(key)
    if (WORKSPACE_STAMP.test(inside) || WORKSPACE_RECORD_FOLDERS.some((folder) => inside.startsWith(folder))) return false
    return WORKSPACE_CODE.test(key)
  }
  return !WORKSPACE_MARKDOWN.test(key)
}

/**
 * The code fingerprint of the index ({ kind: 'index' }) or a commit ({ kind: 'commit', rev }):
 * a SHA-1 hex digest over the sorted "<mode> <oid> <path>" lines of its code files. Only
 * git's object ids enter it, so line endings in the working tree do not change it.
 */
export function fingerprint(source, config) {
  const root = source.root ?? repositoryRoot()
  const lines = workspaceEntries(root, source)
    .filter((entry) => isCode(entry.path, config))
    .map((entry) => `${entry.mode} ${entry.oid} ${entry.path}`)
    .sort()
  return createHash('sha1').update(lines.map((line) => `${line}\n`).join('')).digest('hex')
}

/** The current branch of a repository, or null in a detached HEAD. */
function workspaceCurrentBranch(root) {
  const result = spawnSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return result.status === 0 && result.stdout.trim() !== '' ? result.stdout.trim() : null
}

/**
 * check [--index | --rev <rev>] [--range <from>..<to>]: validates every record and exits 1 when
 * there is a problem. With --range it then checks that every commit in the range is recorded
 * (spec 5.9), with the current branch as the lane, or no lane in a detached HEAD. The caller
 * passes the range check in, as checkRange from range.mjs, which itself imports this module.
 */
export function checkCommand(args, rangeCheck = null) {
  let source = { kind: 'worktree' }
  let range = null
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--index') source = { kind: 'index' }
    else if (arg === '--rev') {
      if (!args[index + 1]) fail('--rev needs a revision, such as --rev HEAD')
      source = { kind: 'commit', rev: args[index + 1] }
      index += 1
    } else if (arg === '--range') {
      const value = args[index + 1] ?? ''
      const at = value.indexOf('..')
      if (at <= 0 || value.includes('...')) fail('--range needs two revisions, such as --range origin/main..HEAD')
      range = { from: value.slice(0, at), to: value.slice(at + 2) || 'HEAD' }
      index += 1
    } else fail(`unknown option "${arg}" for check; use --index, --rev <rev> or --range <from>..<to>`)
  }
  if (range !== null && typeof rangeCheck !== 'function') fail('--range is not available in this build')
  let root
  let reader
  try {
    root = repositoryRoot()
    reader = treeReader({ ...source, root })
  } catch {
    fail('not inside a git repository')
  }
  let problems
  let workspace
  let config = null
  try {
    // The configuration comes from the same source as the records, so an old commit is checked by its own rules.
    const loaded = loadConfig(reader)
    problems = loaded.problems
    config = loaded.config
    if (config) {
      workspace = loadWorkspace(reader, config)
      problems = checkWorkspace(workspace, reader, config)
    }
  } catch (error) {
    fail(error.message)
  }
  if (problems.length > 0) {
    for (const { file, line, message } of problems) console.error(`✖ ${file}${line ? `:${line}` : ''}: ${message}`)
    process.exit(1)
  }
  console.log(`✔ records valid: ${recordCounts(workspace.tasks.length, workspace.decisions.length, workspace.logs.length)}`)
  for (const { file, message } of unknownKeyNotices(config)) console.log(`! ${file}: ${message}`)
  if (range === null) return
  const lane = workspaceCurrentBranch(root)
  let rangeProblems
  try {
    rangeProblems = rangeCheck(range.from, range.to, { config, lane, skipGitHubMerges: false, root })
  } catch (error) {
    fail(error.message)
  }
  if (rangeProblems.length > 0) {
    for (const { file, message } of rangeProblems) console.error(`✖ ${file}: ${message}`)
    process.exit(1)
  }
  console.log(`✔ commits recorded: ${range.from}..${range.to}${lane === null ? ' (detached HEAD: no lane rule)' : ` (lane ${lane})`}`)
}
