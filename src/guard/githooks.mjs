// The git hooks on the guard side: what each hook checks, whether the hooks are active
// in this clone, and turning them on.
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { git, repositoryRoot } from './util.mjs'

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

/** The pre-commit hook. A placeholder until H1: branch rules, the records in the index, ownership, gates. */
export function preCommit() {}

/** The commit-msg hook, given the message file. A placeholder until H2: header, attribution, trailers. */
export function commitMsg(file) {}

/** The pre-push hook, given git's lines on stdin. A placeholder until H2: protected branches, the pushed range. */
export function prePush(input) {}
