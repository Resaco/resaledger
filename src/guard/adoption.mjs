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

/** The full id of the newest commit reachable from `to` that added .resaledger.json, or null. */
export function adoptionCommit(root, to) {
  const { ok, out } = adoptionGit(root, ['log', '--diff-filter=A', '--format=%H', to, '--', CONFIG_FILE])
  return ok && out !== '' ? out.split('\n')[0] : null
}

/**
 * Where a range check that ends at `to` starts, given the start a caller chose (null for every
 * ancestor): that start, unless it is null or older than the commit that added .resaledger.json,
 * in which case that commit. A range from it checks only the commits made since adoption.
 */
export function adoptionStart(root, from, to) {
  const adopted = adoptionCommit(root, to)
  if (adopted === null) return from
  if (from === null || adoptionGit(root, ['merge-base', '--is-ancestor', from, adopted]).ok) return adopted
  return from
}
