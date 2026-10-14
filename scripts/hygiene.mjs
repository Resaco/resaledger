// Hygiene rules for a repository that will be public: no home-directory paths, no paths
// into an agent's private memory folders, no personal email addresses, and none of the
// words in the private deny-list (.git/info/hygiene-deny, never tracked).
// Shared by test/hygiene.test.mjs (tracked files) and scripts/scan-history.mjs (history).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

// Placeholder names that documentation may use in a home-directory path.
const PLACEHOLDERS = new Set(['you', 'user', 'username', 'me', 'example', 'runner', 'name'])

// A home folder, with either kind of slash: the Unix forms are case-sensitive, the Windows
// form is not. The lookbehind keeps URL paths such as https://site/home/page out.
const HOME = /(?<![\w.-])(?:[A-Za-z]:[\\/][Uu][Ss][Ee][Rr][Ss]|[\\/]Users|[\\/]home)[\\/]([A-Za-z0-9._-]+)/g

// The private memory structures of an agent's configuration folder.
const AGENT_MEMORY = /\.claude[\\/](?:clients|projects|memory)(?![\w-])/g

const EMAIL = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![\w-])/g
const EXAMPLE_DOMAINS = ['example.com', 'example.org', 'example.net']

function allowedEmail(domain) {
  const host = domain.toLowerCase()
  if (host === 'users.noreply.github.com') return true
  return EXAMPLE_DOMAINS.some((reserved) => host === reserved || host.endsWith(`.${reserved}`))
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Compiles deny-list entries into whole-word, case-insensitive patterns. */
export function denyPatterns(entries) {
  return entries.map((entry) => ({
    entry,
    pattern: new RegExp(`(?<![\\p{L}\\p{N}_])${escape(entry).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}_])`, 'giu')
  }))
}

/** Parses a deny-list: one entry per line, blank lines and # lines ignored. */
export function parseDenyList(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

/** Runs git without a shell; throws when it fails. */
export function git(root, args, env = process.env) {
  const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

/** The repository's deny-list entries, or [] when it has none. Works in worktrees too. */
export function readDenyList(root, env = process.env) {
  let path = git(root, ['rev-parse', '--git-path', 'info/hygiene-deny'], env).trim()
  if (!isAbsolute(path)) path = join(root, path)
  return existsSync(path) ? parseDenyList(readFileSync(path, 'utf8')) : []
}

/**
 * Checks one line of text against every rule. Returns [{ rule, match }].
 * `deny` is the result of denyPatterns().
 */
export function checkLine(line, deny = []) {
  const hits = []
  for (const found of line.matchAll(HOME)) {
    if (!PLACEHOLDERS.has(found[1].toLowerCase())) hits.push({ rule: 'home-path', match: found[0] })
  }
  for (const found of line.matchAll(AGENT_MEMORY)) hits.push({ rule: 'agent-memory', match: found[0] })
  for (const found of line.matchAll(EMAIL)) {
    if (!allowedEmail(found[1])) hits.push({ rule: 'email', match: found[0] })
  }
  for (const { entry, pattern } of deny) {
    if (line.match(pattern)) hits.push({ rule: 'deny-list', match: entry })
  }
  return hits
}

/** Checks a text, line by line. Returns [{ line, rule, match }] with 1-based line numbers. */
export function checkText(text, deny = []) {
  return text.split(/\r?\n/).flatMap((line, index) => checkLine(line, deny).map((hit) => ({ line: index + 1, ...hit })))
}

/** True when the first 8 KB hold a NUL byte. */
export function isBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0)
}

/**
 * Checks every text file that `git ls-files` lists in the repository at `root`.
 * Returns [{ file, line, rule, match }].
 */
export function scanTree(root, { env = process.env, deny = readDenyList(root, env) } = {}) {
  const patterns = denyPatterns(deny)
  const files = git(root, ['ls-files', '-z'], env).split('\0').filter(Boolean)
  const failures = []
  for (const file of files) {
    const path = join(root, file)
    if (!existsSync(path)) continue
    const buffer = readFileSync(path)
    if (isBinary(buffer)) continue
    // The path itself is public too.
    for (const hit of checkLine(file, patterns)) failures.push({ file, line: 0, ...hit })
    for (const hit of checkText(buffer.toString('utf8'), patterns)) failures.push({ file, ...hit })
  }
  return failures
}

/** One failure as "file:line: rule (match)". */
export function formatFailure({ file, line, rule, match }) {
  return `${file}:${line}: ${rule} (${match})`
}
