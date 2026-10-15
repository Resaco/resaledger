// The files ResaLedger manages, as hashes: the guard, the git hooks, the workflow and the AGENTS.md block.
// `resaledger update` uses these to tell a released file from one changed by hand, and so does
// the CI check (spec 10) when it judges a change to the guard or a hook.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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

/** Two released tables merged: { key: { version: hash } }, the second one's hashes added to the first's. */
export function mergeReleased(first, second) {
  const table = Object.fromEntries(Object.entries(first).map(([key, versions]) => [key, { ...versions }]))
  for (const [key, versions] of Object.entries(second)) table[key] = { ...(table[key] ?? {}), ...versions }
  return table
}

/** The text of a file in a folder, or null. */
function managedRead(folder, ...parts) {
  try {
    return readFileSync(join(folder, ...parts), 'utf8')
  } catch {
    return null
  }
}

/**
 * The released hashes of an unpacked resaledger package (ci --release): { version, table }. The
 * table holds the package's guard, hooks and workflow under its own version, and the earlier
 * releases its templates/released.json records. Throws with the reason when the folder is not
 * such a package.
 */
export function packageReleased(folder) {
  let manifest = null
  try {
    manifest = JSON.parse(managedRead(folder, 'package.json') ?? 'null')
  } catch {
    // Reported below.
  }
  if (manifest?.name !== 'resaledger' || typeof manifest.version !== 'string') throw new Error(`${folder} is not a resaledger package: its package.json does not name resaledger and a version`)
  const guard = managedRead(folder, 'dist', 'records.mjs')
  if (guard === null) throw new Error(`${folder} is not a built resaledger package: dist/records.mjs is missing`)
  const { version } = manifest
  let recorded = {}
  try {
    recorded = JSON.parse(managedRead(folder, 'templates', 'released.json') ?? '{}')
  } catch {
    // A package without a readable table still names its own files.
  }
  const own = { guard: { [version]: contentHash(normalizeManaged(guard)) } }
  const hooks = join(folder, 'templates', 'hooks')
  for (const name of existsSync(hooks) ? readdirSync(hooks).sort() : []) {
    const text = managedRead(hooks, name)
    if (text !== null) own[`hooks/${name}`] = { [version]: contentHash(normalizeManaged(text)) }
  }
  const workflow = managedRead(folder, 'templates', 'workflow.yml')
  if (workflow !== null) own.workflow = { [version]: contentHash(normalizeManaged(workflow)) }
  const earlier = Object.fromEntries(
    Object.entries(recorded ?? {})
      .filter(([key, versions]) => /^(guard|hooks\/[\w-]+|workflow)$/.test(key) && versions && typeof versions === 'object')
      .map(([key, versions]) => [key, Object.fromEntries(Object.entries(versions).filter(([, hash]) => typeof hash === 'string'))])
  )
  return { version, table: mergeReleased(earlier, own) }
}
