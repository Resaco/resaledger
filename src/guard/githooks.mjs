// The git hooks on the guard side: what each hook checks, whether the hooks are active
// in this clone, and turning them on.
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { loadConfig } from './config.mjs'
import { runGates } from './gates.mjs'
import { currentLane, laneTasks } from './lanes.mjs'
import { fail, git, repositoryRoot } from './util.mjs'
import { checkWorkspace, isCode, loadWorkspace, treeReader } from './workspace.mjs'

export const HOOKS_PATH = '.githooks'

// The YAML files of the hook managers whose installed hooks do not name the guard themselves.
const MANAGER_FILES = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml', '.pre-commit-config.yaml']

/** The text of a file, or '' when it cannot be read. */
function readHookFile(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** The value of core.hooksPath, or '' when it is unset. */
function configuredHooksPath(root) {
  try {
    return git('-C', root, 'config', '--get', 'core.hooksPath')
  } catch {
    return ''
  }
}

/** True when the path names the .githooks folder at the repository root. */
function isOwnHooksPath(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') === HOOKS_PATH
}

/**
 * True when git runs the guard's commit-msg check in this clone: the effective hooks folder
 * (core.hooksPath or the git folder's hooks, per worktree) holds the ResaLedger commit-msg
 * hook, or a hook manager's commit-msg hook is installed and its configuration calls the guard.
 */
export function hooksActive() {
  const root = repositoryRoot()
  let folder = git('-C', root, 'rev-parse', '--git-path', 'hooks')
  if (!isAbsolute(folder)) folder = join(root, folder)
  const hook = readHookFile(join(folder, 'commit-msg'))
  if (hook === '') return false
  if (hook.split(/\r?\n/).includes('# resaledger: commit-msg hook, managed by ResaLedger; do not edit')) return true
  const calls = /scripts\/records\.mjs"?\s+commit-msg\b/
  if (calls.test(hook)) return true
  // husky runs .husky/<hook> from its own scripts in .husky/_.
  if (folder.replace(/\\/g, '/').replace(/\/+$/, '').endsWith('.husky/_') && calls.test(readHookFile(join(folder, '..', 'commit-msg'))))
    return true
  return MANAGER_FILES.some((file) => calls.test(readHookFile(join(root, file))))
}

/**
 * Points core.hooksPath at .githooks when it is unset. Returns 'activated' when it set it,
 * 'active' when it already pointed there, and { foreign: value } without changing anything
 * when it holds another value, such as a hook manager's folder.
 */
export function activateHooks() {
  const root = repositoryRoot()
  const current = configuredHooksPath(root)
  if (current === '') {
    git('-C', root, 'config', '--local', 'core.hooksPath', HOOKS_PATH)
    return 'activated'
  }
  if (isOwnHooksPath(current)) return 'active'
  return { foreign: current }
}

/** Prints the refusal of a commit with one line per problem, and exits 1. */
function githooksRefuse(problems) {
  console.error('✖ This commit is refused')
  for (const { file, line, message } of problems) console.error(`  ${file ? `${file}${line ? `:${line}` : ''}: ` : ''}${message}`)
  process.exit(1)
}

/** The full object id of a revision's commit, or null when it does not resolve. */
function githooksCommit(rev) {
  try {
    return git('rev-parse', '--verify', '-q', `${rev}^{commit}`) || null
  } catch {
    return null
  }
}

/** The problems with the branch: a protected branch, or a name that fails branchPattern. */
function githooksBranchProblems(branch, config) {
  if (branch === null) return []
  const guard = `node ${config.dir}/scripts/records.mjs`
  if (config.protected.includes(branch)) {
    return [
      {
        file: '',
        line: 0,
        message: `"${branch}" is a protected branch, so nothing is committed on it, not even a merge. Work in a lane branch, for example with "${guard} claim <id>", which creates one, and open a pull request`
      }
    ]
  }
  if (config.branchRegex && branch !== config.base && !config.branchRegex.test(branch)) {
    return [
      {
        file: '',
        line: 0,
        message: `the branch name "${branch}" does not match branchPattern ${JSON.stringify(config.branchPattern)} in .resaledger.json. Rename it with "git branch -m <name>"`
      }
    ]
  }
  return []
}

/** The tasks of a reader by id, each with its file and text; the first file wins for a duplicate id. */
function githooksTasksById(reader, dir) {
  const byId = new Map()
  for (const task of laneTasks(reader, dir)) {
    if (task.id && !byId.has(task.id)) byId.set(task.id, { task, text: reader.read(task.file) })
  }
  return byId
}

/** The lane that holds a task: its Lane while doing, or blocked with a Lane; otherwise null. */
function githooksHolder(task) {
  if (task.status === 'doing' || task.status === 'blocked') return task.lane
  return null
}

/** Whether the staged task is a takeover by this branch: doing, this Lane, and Taken over from naming the holder. */
function githooksIsTakeover(staged, branch, holder) {
  if (staged.status !== 'doing' || staged.lane !== branch || !staged.takenOverFrom) return false
  return staged.takenOverFrom.split(/[\s,;`]+/).includes(holder)
}

/**
 * The ownership problems of the staged tasks (spec 6.2), compared by id with HEAD: a task that
 * exists on the base branch was deleted or had its id renamed, or a task another lane holds was
 * changed without a takeover. During a merge, a task staged exactly as the merged commit has it
 * is that lane's own change and passes.
 */
function githooksOwnershipProblems(root, branch, config, indexReader, head) {
  const problems = []
  const guard = `node ${config.dir}/scripts/records.mjs`
  const headTasks = githooksTasksById(treeReader({ kind: 'commit', rev: head, root }), config.dir)
  const stagedTasks = githooksTasksById(indexReader, config.dir)

  const deleted = [...headTasks.keys()].filter((id) => !stagedTasks.has(id))
  if (deleted.length > 0) {
    let baseIds = new Set(headTasks.keys())
    const base = branch === config.base ? null : githooksCommit(config.base)
    if (base !== null) {
      let mergeBase = head
      try {
        mergeBase = git('merge-base', head, base) || head
      } catch {
        // Unrelated histories: HEAD stands for the base.
      }
      if (mergeBase !== head) baseIds = new Set(githooksTasksById(treeReader({ kind: 'commit', rev: mergeBase, root }), config.dir).keys())
    }
    for (const id of deleted) {
      if (!baseIds.has(id)) continue
      problems.push({
        file: headTasks.get(id).task.file,
        line: 0,
        message: `task ${id} is deleted or its id renamed, but it exists on ${config.base}. Tasks are never deleted: keep the file and set "Status: dropped" with a "Reason"`
      })
    }
  }

  const mergeHead = githooksCommit('MERGE_HEAD')
  const merged = mergeHead === null ? null : githooksTasksById(treeReader({ kind: 'commit', rev: mergeHead, root }), config.dir)
  for (const [id, { task: before, text: beforeText }] of headTasks) {
    const after = stagedTasks.get(id)
    if (!after || after.text === beforeText) continue
    const holder = githooksHolder(before)
    if (!holder || holder === branch) continue
    if (githooksIsTakeover(after.task, branch, holder)) continue
    if (merged?.get(id)?.text === after.text) continue
    problems.push({
      file: after.task.file,
      line: 0,
      message: `task ${id} is held by lane "${holder}" (Status: ${before.status}), so only that lane changes it. To take it over, run "${guard} claim ${id} --take"`
    })
  }
  return problems
}

/** The staged paths, compared with HEAD (or with nothing before the first commit), deletions included. */
function githooksStagedPaths() {
  return git('diff', '--cached', '--name-only', '--no-renames', '-z')
    .split('\0')
    .filter((path) => path !== '')
}

/**
 * The pre-commit hook, judged on the staged content (the index git names in GIT_INDEX_FILE,
 * which is a temporary one for `git commit -- <paths>`): the configuration, the branch rules,
 * the records, task ownership against HEAD, and the commit gates when code is staged.
 * A refusal prints every problem and exits 1; a pass prints only the gate lines.
 */
export function preCommit() {
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }
  const reader = treeReader({ kind: 'index', root })
  const { config, problems: configProblems } = loadConfig(reader)
  if (!config) githooksRefuse(configProblems)

  const branch = currentLane()
  const problems = githooksBranchProblems(branch, config)
  problems.push(...checkWorkspace(loadWorkspace(reader, config), reader, config))
  const head = githooksCommit('HEAD')
  if (branch !== null && head !== null) problems.push(...githooksOwnershipProblems(root, branch, config, reader, head))
  if (problems.length > 0) githooksRefuse(problems)

  if (config.gates.commit.length === 0 || !githooksStagedPaths().some((path) => isCode(path, config))) return
  const { failure } = runGates(config.gates.commit, { root })
  if (failure) {
    githooksRefuse([{ file: '', line: 0, message: `the commit gate "${failure.command}" failed. Fix the code; a gate is never weakened to make it pass` }])
  }
}

/** The commit-msg hook, given the message file. A placeholder until H2: header, attribution, trailers. */
export function commitMsg(file) {}

/** The pre-push hook, given git's lines on stdin. A placeholder until H2: protected branches, the pushed range. */
export function prePush(input) {}
