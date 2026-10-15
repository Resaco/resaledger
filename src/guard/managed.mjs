// The files ResaLedger manages, as hashes: the guard, the git hooks and the AGENTS.md block.
// `resaledger update` uses these to tell a released file from one changed by hand, and so does
// the CI check (spec 10) when it judges a change to the guard or a hook.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The parts of a semantic version: { core: [major, minor, patch], pre: [...] }. */
function managedVersionParts(version) {
  const plain = String(version).split('+')[0]
  const dash = plain.indexOf('-')
  const core = (dash === -1 ? plain : plain.slice(0, dash)).split('.').map((part) => Number(part) || 0)
  return { core, pre: dash === -1 ? [] : plain.slice(dash + 1).split('.') }
}

/** Compares two semantic versions: negative when a is older, 0 when equal, positive when newer. */
export function compareVersions(a, b) {
  const x = managedVersionParts(a)
  const y = managedVersionParts(b)
  for (let index = 0; index < 3; index++) {
    const diff = (x.core[index] ?? 0) - (y.core[index] ?? 0)
    if (diff !== 0) return diff
  }
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length
  for (let index = 0; index < Math.max(x.pre.length, y.pre.length); index++) {
    const p = x.pre[index]
    const q = y.pre[index]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const numeric = /^\d+$/.test(p) && /^\d+$/.test(q)
    if (numeric && Number(p) !== Number(q)) return Number(p) - Number(q)
    if (!numeric && p !== q) {
      if (/^\d+$/.test(p)) return -1
      if (/^\d+$/.test(q)) return 1
      return p < q ? -1 : 1
    }
  }
  return 0
}

/**
 * A managed file's text as it is hashed: LF line ends, no trailing whitespace, and, when dir
 * is given, the workspace folder put back as {{dir}}, so that one hash serves every dir.
 */
export function normalizeManaged(text, dir = null) {
  const plain = text.replace(/\r\n?/g, '\n').trimEnd()
  if (!dir) return plain
  const literal = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return plain.replace(new RegExp(`(?<![\\w./-])${literal}/`, 'g'), '{{dir}}/')
}

/** The SHA-256 of a normalized text, in hex. */
export function contentHash(text) {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * The released hashes this guard knows, { key: { version: hash } }: the table the bundler
 * embeds as RELEASED (earlier releases, and this version's hooks), plus this guard's own hash,
 * which it cannot embed in itself. Unbundled, the table is empty.
 */
export function releasedTable() {
  // RELEASED and VERSION exist only in the bundle, where scripts/bundle.mjs defines them.
  if (typeof RELEASED === 'undefined') return {}
  const table = Object.fromEntries(Object.entries(RELEASED).map(([key, versions]) => [key, { ...versions }]))
  try {
    const own = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    table.guard = { ...(table.guard ?? {}), [VERSION]: contentHash(normalizeManaged(own)) }
  } catch {
    // A guard that cannot read itself knows only the earlier releases.
  }
  return table
}
