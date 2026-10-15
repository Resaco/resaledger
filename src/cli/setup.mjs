// What `init` and `migrate` both do to a repository: find or build the guard, write the
// managed block into the root AGENTS.md, import AGENTS.md from an existing CLAUDE.md, pick
// the base branch, and turn the git hooks on.
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectHookManager } from './hooks.mjs'

export const PACKAGE_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
export const BUILT_GUARD = join(PACKAGE_ROOT, 'dist', 'records.mjs')
export const HOOKS_FOLDER = '.githooks'
export const GITATTRIBUTES_FILE = '.gitattributes'
// Git for Windows may check the hooks out with CRLF, and sh then fails on "\r".
export const HOOKS_EOL_RULE = `${HOOKS_FOLDER}/* text eol=lf`
// The branch the setup is committed on when the current branch is protected.
export const SETUP_BRANCH = 'resaledger-setup'

const AGENTS_BLOCK = new URL('../../templates/agents-block.md', import.meta.url)
export const MANAGED_START = '<!-- resaledger:start'
export const MANAGED_END = '<!-- resaledger:end -->'
const AGENTS_IMPORT = /^\s*@AGENTS\.md\s*$/

/** Builds the guard when dist/records.mjs is missing, as in a checkout of the source. False when the build fails. */
export function ensureGuard() {
  if (existsSync(BUILT_GUARD)) return true
  const built = spawnSync(process.execPath, [join(PACKAGE_ROOT, 'scripts', 'bundle.mjs')], { stdio: 'inherit' })
  return built.status === 0
}

/** The managed block for the root AGENTS.md, for the workspace folder dir, without a final newline. */
export function agentsBlock(dir) {
  return readFileSync(AGENTS_BLOCK, 'utf8').replaceAll('{{dir}}', dir).trimEnd()
}

/** The text without its managed block; everything else is kept as it is. */
export function removeManagedBlock(text) {
  const start = text.indexOf(MANAGED_START)
  if (start === -1) return text
  const end = text.indexOf(MANAGED_END, start)
  return `${text.slice(0, start)}${end === -1 ? '' : text.slice(end + MANAGED_END.length)}`
}

/**
 * The root AGENTS.md with the managed block: an existing block is replaced where it stands,
 * otherwise the block is appended after a blank line. Every other byte is kept.
 */
export function withAgentsBlock(text, block) {
  const start = text.indexOf(MANAGED_START)
  if (start !== -1) {
    const end = text.indexOf(MANAGED_END, start)
    const after = end === -1 ? '\n' : text.slice(end + MANAGED_END.length)
    return `${text.slice(0, start)}${block}${after}`
  }
  if (text === '') return `${block}\n`
  return `${text}${text.endsWith('\n') ? '' : '\n'}\n${block}\n`
}

/** The repository-relative path a file really is, following a link inside the repository; null outside it. */
export function realRelative(root, path) {
  const full = join(root, path)
  if (!existsSync(full)) return path
  if (!lstatSync(full).isSymbolicLink()) return path
  const real = realpathSync.native(full)
  const inside = relative(realpathSync.native(root), real)
  if (inside.startsWith('..') || resolve(inside) === inside) return null
  return inside.split(/[\\/]/).join('/')
}

/** True when the two repository-relative paths are the same file, through links or hard links. */
export function sameFile(root, a, b) {
  try {
    const one = statSync(join(root, a))
    const two = statSync(join(root, b))
    return one.ino === two.ino && one.dev === two.dev
  } catch {
    return false
  }
}

/**
 * The CLAUDE.md that should import AGENTS.md: null when there is none or when it is a link to
 * AGENTS.md (it reads the block already), { warning } when it is a link outside the repository
 * or to nothing, otherwise { path } with the repository-relative file to edit.
 */
export function claudeFile(root, agentsPath) {
  if (!lstatSync(join(root, 'CLAUDE.md'), { throwIfNoEntry: false })) return null
  if (sameFile(root, 'CLAUDE.md', 'AGENTS.md') || (agentsPath !== null && realRelative(root, 'CLAUDE.md') === agentsPath)) return null
  const path = realRelative(root, 'CLAUDE.md')
  if (path === null || !existsSync(join(root, path))) return { warning: 'CLAUDE.md is a link outside the repository or to nothing; add an "@AGENTS.md" line to the file it points to' }
  return { path }
}

/** True when one of the lines imports AGENTS.md. */
export function hasAgentsImport(lines) {
  return lines.some((line) => AGENTS_IMPORT.test(line))
}

function setupGit(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' })
}

/**
 * The base branch when it is not the default "main": a repository without main gets the
 * remote's default branch, or master. null when main exists or nothing better is known.
 */
export function detectBase(root) {
  const hasRef = (ref) => setupGit(root, ['rev-parse', '--verify', '-q', ref]).stdout.trim() !== ''
  if (hasRef('refs/heads/main') || hasRef('refs/remotes/origin/main')) return null
  const remoteHead = setupGit(root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']).stdout.trim().replace(/^origin\//, '')
  return remoteHead || (hasRef('refs/heads/master') || hasRef('refs/remotes/origin/master') ? 'master' : null)
}

/**
 * Turns the git hooks in .githooks/ on by setting core.hooksPath, unless a hook manager is in
 * use or core.hooksPath already names another folder; neither is ever overwritten.
 * Returns { state: 'activated' | 'active' | 'manager' | 'foreign', manager, hooksPath }.
 */
export function turnOnHooks(root) {
  const manager = detectHookManager(root)
  const hooksPath = setupGit(root, ['config', '--get', 'core.hooksPath']).stdout.trim()
  if (hooksPath !== '' && hooksPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') === HOOKS_FOLDER) return { state: 'active', manager, hooksPath }
  if (manager) return { state: 'manager', manager, hooksPath }
  if (hooksPath !== '') return { state: 'foreign', manager, hooksPath }
  setupGit(root, ['config', '--local', 'core.hooksPath', HOOKS_FOLDER])
  return { state: 'activated', manager, hooksPath: HOOKS_FOLDER }
}

/** The line that explains a hooks state that turnOnHooks did not change. */
export function hooksNote(result, dir) {
  const calls = `node ${dir}/scripts/records.mjs pre-commit, pre-merge-commit, commit-msg "$1", pre-push "$@"`
  if (result.state === 'activated') return `✔ git hooks turned on: core.hooksPath is ${HOOKS_FOLDER}`
  if (result.state === 'active') return `✔ git hooks are on: core.hooksPath is ${HOOKS_FOLDER}`
  if (result.state === 'manager') return `! ${result.manager} manages the git hooks here, so core.hooksPath was not changed; the guard runs from ${result.manager}'s hooks (${calls})`
  return `! core.hooksPath is "${result.hooksPath}", so the hooks in ${HOOKS_FOLDER}/ do not run; call the guard from your hooks instead (${calls})`
}

// Patterns whose eol=lf rule covers every hook, as an existing equivalent of HOOKS_EOL_RULE.
const HOOKS_EOL_PATTERNS = new Set(['*', `${HOOKS_FOLDER}/*`, `${HOOKS_FOLDER}/**`, `/${HOOKS_FOLDER}/*`, `/${HOOKS_FOLDER}/**`])

/** True when a .gitattributes text has a rule that checks every hook out with LF. */
export function hasHooksEolRule(text) {
  return text.split(/\r?\n/).some((line) => {
    const [pattern, ...attributes] = line.trim().split(/\s+/)
    return HOOKS_EOL_PATTERNS.has(pattern) && attributes.includes('eol=lf') && !attributes.includes('-text') && !attributes.includes('binary')
  })
}

/** The .gitattributes text (null when the file is missing) with HOOKS_EOL_RULE added, unless it has an equivalent; every other line is kept. */
export function withHooksEolRule(text) {
  if (text === null || text === '') return `${HOOKS_EOL_RULE}\n`
  if (hasHooksEolRule(text)) return text
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  return `${text}${text.endsWith('\n') ? '' : newline}${HOOKS_EOL_RULE}${newline}`
}

/** The current branch, or null when HEAD is detached. */
export function currentBranch(root) {
  const result = setupGit(root, ['symbolic-ref', '--short', '-q', 'HEAD'])
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null
}

/**
 * The next steps that commit the setup, each a line of text with its command. commit is the
 * commit command, config the planned configuration and what names the change, such as "the setup". On a protected branch the pre-commit
 * hook that was just installed refuses the commit, so the steps make a setup branch first,
 * then push it for a pull request, which is judged by its own rules (spec 10).
 */
export function setupCommitSteps(branch, config, commit, what = 'the setup') {
  if (branch === null || !config.protected.includes(branch)) return [`Commit ${what}:\n       ${commit}`]
  return [
    `"${branch}" is protected, so commit ${what} on a new branch:\n       git switch -c ${SETUP_BRANCH} && ${commit}`,
    `Push it and open a pull request into ${branch}; the first pull request that adds ResaLedger is judged by its own rules:\n       git push -u origin ${SETUP_BRANCH}`
  ]
}

/** The line that says a Git LFS hook at path is replaced, and that the guard runs Git LFS's pre-push (spec 9). */
export function gitLfsNote(path) {
  return `✔ ${path} was Git LFS's own hook; ResaLedger's pre-push replaces it, and the guard runs "git lfs pre-push" after its own checks wherever a tracked ${GITATTRIBUTES_FILE} names filter=lfs`
}
