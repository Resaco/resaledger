// Where ResaLedger starts in a repository's history: the commit that added .resaledger.json.
// Commits older than it were made before the project adopted ResaLedger, so no range check
// judges them. Handoff and pre-push share this start.
import { spawnSync } from 'node:child_process'
import { CONFIG_FILE } from './config.mjs'

const ADOPTION_MAX_BUFFER = 256 * 1024 * 1024

/** Runs git in a folder: { ok, out } with stdout trimmed, never throws on git's own failure. */
function adoptionGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: ADOPTION_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  return { ok: result.status === 0, out: result.stdout.trim() }
}

/**
 * The full id of the oldest commit that added .resaledger.json among `range` (git log
 * arguments, such as [to] or [`${from}..${to}`]), or null. The oldest, so that a later commit
 * that deletes the file and adds it again cannot move the start past itself.
 */
function adoptionOldest(root, range) {
  const { ok, out } = adoptionGit(root, ['log', '--reverse', '--diff-filter=A', '--format=%H', ...range, '--', CONFIG_FILE])
  return ok && out !== '' ? out.split('\n')[0] : null
}

/** The full id of the oldest commit reachable from `to` that added .resaledger.json, or null. */
export function adoptionCommit(root, to) {
  return adoptionOldest(root, [to])
}

/**
 * Where a range check that ends at `to` starts, given the start a caller chose (null for every
 * ancestor). A start whose tree has .resaledger.json is kept: the project had adopted
 * ResaLedger there, so every later commit is judged. Otherwise the start moves to the oldest
 * commit after it that added the file, and the range checks only the commits made since.
 */
export function adoptionStart(root, from, to) {
  if (from !== null && adoptionGit(root, ['cat-file', '-e', `${from}:${CONFIG_FILE}`]).ok) return from
  return adoptionOldest(root, from === null ? [to] : [`${from}..${to}`]) ?? from
}
