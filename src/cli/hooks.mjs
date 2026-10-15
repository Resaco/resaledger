// The git hooks on the package side: rendering the hook scripts for .githooks/, and
// adding the guard's calls to a hook manager that a repository already uses.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const HOOK_NAMES = ['pre-commit', 'commit-msg', 'pre-push']

const TEMPLATES = new URL('../../templates/hooks/', import.meta.url)
const LEFTHOOK_FILES = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml']
const PRE_COMMIT_FILE = '.pre-commit-config.yaml'

/** The hook script for .githooks/<name>, calling the guard in the workspace folder dir. */
export function renderHook(name, dir) {
  if (!HOOK_NAMES.includes(name)) throw new Error(`unknown hook "${name}"; expected one of ${HOOK_NAMES.join(', ')}`)
  return readFileSync(new URL(name, TEMPLATES), 'utf8').replaceAll('{{dir}}', dir)
}

/** The arguments each hook passes on to the guard, in sh syntax. */
const HOOK_ARGUMENTS = { 'pre-commit': '', 'commit-msg': ' "$1"', 'pre-push': ' "$@"' }

/** The shell command that calls the guard for one hook. */
export function guardCall(name, dir) {
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
commit-msg:
  commands:
    resaledger:
      run: node "${dir}/scripts/records.mjs" commit-msg {1}
pre-push:
  commands:
    resaledger:
      run: node "${dir}/scripts/records.mjs" pre-push {1} {2}
      use_stdin: true

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

Then run "pre-commit install --hook-type pre-commit --hook-type commit-msg --hook-type pre-push".`
}

/**
 * Adds the guard's calls to the hook manager's configuration. husky and simple-git-hooks
 * are edited in place; lefthook and pre-commit use YAML, which is not safe to edit without a
 * parser, so they are left alone and the instructions hold the snippet to paste.
 * Returns { changed: [repository-relative files], instructions: string | null }.
 */
export function integrateHookManager(root, manager, dir) {
  if (manager === 'husky') return integrateHusky(root, dir)
  if (manager === 'simple-git-hooks') return integrateSimpleGitHooks(root, dir)
  if (manager === 'lefthook') return { changed: [], instructions: lefthookSnippet(dir) }
  if (manager === 'pre-commit') return { changed: [], instructions: preCommitSnippet(dir) }
  throw new Error(`unknown hook manager "${manager}"`)
}
