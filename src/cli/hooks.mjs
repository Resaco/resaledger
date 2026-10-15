// The git hooks on the package side: rendering the hook scripts for .githooks/, and
// adding the guard's calls to a hook manager that a repository already uses.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSafeFolderPath, SAFE_FOLDER_RULE } from '../guard/config.mjs'
import { GIT_HOOKS } from '../guard/githooks.mjs'

// pre-merge-commit runs pre-commit's checks for a merge that commits by itself, which runs no pre-commit.
export const HOOK_NAMES = GIT_HOOKS

const TEMPLATES = new URL('../../templates/hooks/', import.meta.url)
const LEFTHOOK_FILES = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml']
const PRE_COMMIT_FILE = '.pre-commit-config.yaml'

/** Throws unless dir is a folder path that is safe to paste into a shell script or YAML. */
function assertSafeDir(dir) {
  if (!isSafeFolderPath(dir)) throw new Error(`the workspace folder ${JSON.stringify(dir)} is not ${SAFE_FOLDER_RULE}`)
}

/** The hook script for .githooks/<name>, calling the guard in the workspace folder dir. */
export function renderHook(name, dir) {
  if (!HOOK_NAMES.includes(name)) throw new Error(`unknown hook "${name}"; expected one of ${HOOK_NAMES.join(', ')}`)
  // The configuration refuses an unsafe dir already; the template quotes it as well.
  assertSafeDir(dir)
  return readFileSync(new URL(name, TEMPLATES), 'utf8').replaceAll('{{dir}}', dir)
}

// The hooks `git lfs install` writes, and the command that writes them again over others.
export const GIT_LFS_HOOKS = ['pre-push', 'post-checkout', 'post-commit', 'post-merge']
export const GIT_LFS_RESTORE = 'git lfs update --force'
// Git LFS's check that git-lfs is installed: printf in 3.x, echo in older releases, any message.
const QUOTED = '"(?:[^"\\\\]|\\\\.)*"'
const GIT_LFS_CHECK = new RegExp(`^command -v git-lfs >/dev/null 2>&1 ?\\|\\| ?\\{ ?(?:printf >&2 ?${QUOTED} ?|echo >&2 ?)${QUOTED} ?; ?exit 2 ?; ?\\}$`)

/**
 * True when text is the hook Git LFS writes as .githooks/<name>: #!/bin/sh, the check that
 * git-lfs is installed and `git lfs <name> "$@"`, and nothing else. Whitespace does not count.
 */
export function isGitLfsHook(name, text) {
  if (!GIT_LFS_HOOKS.includes(name)) return false
  const lines = text.split(/\r?\n|\r/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean)
  return lines.length === 3 && lines[0] === '#!/bin/sh' && GIT_LFS_CHECK.test(lines[1]) && lines[2] === `git lfs ${name} "$@"`
}

// A command line that runs Git LFS's pre-push, outside a comment.
const RUNS_GIT_LFS_PRE_PUSH = /^(?!\s*#).*\bgit(?: |-)lfs pre-push\b/m

/**
 * The file and place in it where the hook manager's pre-push already runs `git lfs pre-push`,
 * or null. That command reads all of git's input before the guard's call, which then checks
 * nothing. Only husky and simple-git-hooks are read; lefthook's and pre-commit's YAML is not.
 */
export function managerGitLfsPrePush(root, manager) {
  if (manager === 'husky') {
    const path = join(root, '.husky', 'pre-push')
    const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
    return RUNS_GIT_LFS_PRE_PUSH.test(text) ? '.husky/pre-push' : null
  }
  if (manager === 'simple-git-hooks') {
    const command = readJson(join(root, 'package.json'))?.['simple-git-hooks']?.['pre-push']
    return typeof command === 'string' && RUNS_GIT_LFS_PRE_PUSH.test(command) ? 'package.json: "simple-git-hooks" pre-push' : null
  }
  return null
}

const GIT_LFS_SNIPPET_NOTE = 'If your pre-push already runs "git lfs pre-push", remove it: it would read git\'s input before the guard, and the guard runs Git LFS\'s pre-push itself.'

/** The arguments each hook passes on to the guard, in sh syntax. */
const HOOK_ARGUMENTS = { 'pre-commit': '', 'pre-merge-commit': '', 'commit-msg': ' "$1"', 'pre-push': ' "$@"' }

/** The shell command that calls the guard for one hook. */
export function guardCall(name, dir) {
  assertSafeDir(dir)
  return `node "${dir}/scripts/records.mjs" ${name}${HOOK_ARGUMENTS[name]}`
}

/** The comment line that marks the guard's call in a hook manager's file. */
export function callMarker(name) {
  return `# resaledger: ${name} call, managed by ResaLedger; do not edit`
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** The hook manager the repository at root uses, or null. The first match wins. */
export function detectHookManager(root) {
  const manifest = readJson(join(root, 'package.json'))
  const prepare = manifest?.scripts?.prepare
  if (existsSync(join(root, '.husky')) || (typeof prepare === 'string' && /\bhusky\b/.test(prepare))) return 'husky'
  if (LEFTHOOK_FILES.some((file) => existsSync(join(root, file)))) return 'lefthook'
  if (existsSync(join(root, PRE_COMMIT_FILE))) return 'pre-commit'
  if (manifest && typeof manifest === 'object' && 'simple-git-hooks' in manifest) return 'simple-git-hooks'
  return null
}

/** Appends the guard's call to .husky/<hook> for each hook, unless its marker is there already. */
function integrateHusky(root, dir) {
  const changed = []
  mkdirSync(join(root, '.husky'), { recursive: true })
  for (const name of HOOK_NAMES) {
    const file = `.husky/${name}`
    const path = join(root, file)
    const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (text.split(/\r?\n/).includes(callMarker(name))) continue
    const separator = text === '' || text.endsWith('\n') ? '' : '\n'
    writeFileSync(path, `${text}${separator}${callMarker(name)}\n${guardCall(name, dir)}\n`, { mode: 0o755 })
    changed.push(file)
  }
  return { changed, instructions: null }
}

/** Adds the guard's call to each hook under "simple-git-hooks" in package.json, keeping the rest. */
function integrateSimpleGitHooks(root, dir) {
  const path = join(root, 'package.json')
  const text = readFileSync(path, 'utf8')
  const manifest = JSON.parse(text)
  const hooks = manifest['simple-git-hooks'] && typeof manifest['simple-git-hooks'] === 'object' ? manifest['simple-git-hooks'] : {}
  let modified = false
  for (const name of HOOK_NAMES) {
    const call = guardCall(name, dir)
    const current = typeof hooks[name] === 'string' ? hooks[name].trim() : ''
    if (current.includes(`/scripts/records.mjs" ${name}`)) continue
    hooks[name] = current === '' ? call : `${current} && ${call}`
    modified = true
  }
  if (!modified) return { changed: [], instructions: null }
  manifest['simple-git-hooks'] = hooks
  const indent = text.match(/^[ \t]+(?=")/m)?.[0] ?? '  '
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  writeFileSync(path, `${JSON.stringify(manifest, null, indent).replace(/\n/g, newline)}${newline}`)
  return { changed: ['package.json'], instructions: 'Run "npx simple-git-hooks" to install the updated hooks.' }
}

function lefthookSnippet(dir) {
  return `Add the guard's calls to your lefthook configuration, merging them into any hooks it already has:

pre-commit:
  commands:
    resaledger:
      run: node "${dir}/scripts/records.mjs" pre-commit
pre-merge-commit:
  commands:
    resaledger:
      run: node "${dir}/scripts/records.mjs" pre-merge-commit
commit-msg:
  commands:
    resaledger:
      run: node "${dir}/scripts/records.mjs" commit-msg {1}
pre-push:
  commands:
    resaledger:
      run: node "${dir}/scripts/records.mjs" pre-push {1} {2}
      use_stdin: true

${GIT_LFS_SNIPPET_NOTE}

Then run "npx lefthook install".`
}

function preCommitSnippet(dir) {
  return `Add the guard's calls to ${PRE_COMMIT_FILE}, under "repos":

  - repo: local
    hooks:
      - id: resaledger-pre-commit
        name: ResaLedger pre-commit
        entry: node "${dir}/scripts/records.mjs" pre-commit
        language: system
        pass_filenames: false
        always_run: true
        stages: [pre-commit]
      - id: resaledger-pre-merge-commit
        name: ResaLedger pre-merge-commit
        entry: node "${dir}/scripts/records.mjs" pre-merge-commit
        language: system
        pass_filenames: false
        always_run: true
        stages: [pre-merge-commit]
      - id: resaledger-commit-msg
        name: ResaLedger commit-msg
        entry: node "${dir}/scripts/records.mjs" commit-msg
        language: system
        always_run: true
        stages: [commit-msg]
      - id: resaledger-pre-push
        name: ResaLedger pre-push
        entry: node "${dir}/scripts/records.mjs" pre-push
        language: system
        pass_filenames: false
        always_run: true
        stages: [pre-push]

${GIT_LFS_SNIPPET_NOTE}

Then run "pre-commit install --hook-type pre-commit --hook-type pre-merge-commit --hook-type commit-msg --hook-type pre-push".`
}

/**
 * Adds the guard's calls to the hook manager's configuration. husky and simple-git-hooks
 * are edited in place; lefthook and pre-commit use YAML, which is not safe to edit without a
 * parser, so they are left alone and the instructions hold the snippet to paste.
 * Returns { changed: [repository-relative files], instructions: string | null }.
 */
export function integrateHookManager(root, manager, dir) {
  assertSafeDir(dir)
  if (manager === 'husky') return integrateHusky(root, dir)
  if (manager === 'simple-git-hooks') return integrateSimpleGitHooks(root, dir)
  if (manager === 'lefthook') return { changed: [], instructions: lefthookSnippet(dir) }
  if (manager === 'pre-commit') return { changed: [], instructions: preCommitSnippet(dir) }
  throw new Error(`unknown hook manager "${manager}"`)
}
