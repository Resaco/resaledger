// `resaledger update`: renews the files ResaLedger manages (spec section 15): the guard, the
// git hooks or the guard's calls in a hook manager, the managed block in the root AGENTS.md,
// and ResaLedger's entries in the hook configurations of the agents in use. A file is replaced only when its content is a released version of it, or this
// package's own; a file changed by hand is shown and kept unless --force is given. The
// README, the records, the configuration and the project's own text in AGENTS.md are never
// touched. planUpdate() only reads; applyUpdate() writes.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectAgents } from '../guard/agents.mjs'
import { CONFIG_FILE, parseConfig } from '../guard/config.mjs'
import { compareVersions, contentHash, normalizeManaged } from '../guard/managed.mjs'
import { callMarker, detectHookManager, guardCall, HOOK_NAMES, integrateHookManager, renderHook } from './hooks.mjs'
import { planAgentConfigs } from './init.mjs'
import { LEGACY_CONFIG_FILE } from './legacy.mjs'
import { lineDiff } from './migrate.mjs'
import { agentsBlock, BUILT_GUARD, GITATTRIBUTES_FILE, HOOKS_EOL_RULE, HOOKS_FOLDER, MANAGED_END, MANAGED_START, realRelative, withHooksEolRule } from './setup.mjs'

export const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
export const RELEASED_FILE = new URL('../../templates/released.json', import.meta.url)
export const UPDATE_COMMIT_MESSAGE = [`chore: update ResaLedger to ${PACKAGE_VERSION}`, 'Task: maintenance']

const TEMPLATES = new URL('../../templates/', import.meta.url)
const GUARD_VERSION_LINE = /^\/\/ ResaLedger (\S+)$/m
const LEFTHOOK_FILES = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml']

// Versions and hashes. compareVersions, normalizeManaged and contentHash live in the guard, which
// judges the same hashes in CI; they are exported here too for the package's own callers.

export { compareVersions, contentHash, normalizeManaged }

/** The version in a guard's second line ("// ResaLedger 1.0.0"), or null. */
export function guardVersion(text) {
  return text.split('\n', 3).join('\n').match(GUARD_VERSION_LINE)?.[1] ?? null
}

/**
 * The managed files of this package, keyed as in templates/released.json: { key: { text,
 * dirSensitive } }, with {{dir}} still in the templates. The guard is the built bundle.
 */
export function managedTemplates() {
  const templates = { guard: { text: readFileSync(BUILT_GUARD, 'utf8'), dirSensitive: false } }
  for (const name of HOOK_NAMES) templates[`hooks/${name}`] = { text: readFileSync(new URL(`hooks/${name}`, TEMPLATES), 'utf8'), dirSensitive: true }
  templates['agents-block'] = { text: readFileSync(new URL('agents-block.md', TEMPLATES), 'utf8'), dirSensitive: true }
  return templates
}

/**
 * This package's hash of each managed file. A dir-sensitive template must survive a round
 * trip through the default folder name, or its hash would match no installed copy.
 */
export function currentHashes() {
  const hashes = {}
  for (const [key, { text, dirSensitive }] of Object.entries(managedTemplates())) {
    const normal = normalizeManaged(text)
    if (dirSensitive && normalizeManaged(text.replaceAll('{{dir}}', 'ledger'), 'ledger') !== normal) {
      throw new Error(`templates/${key}: the text holds "ledger/" outside {{dir}}, so its installed copies cannot be recognised`)
    }
    hashes[key] = contentHash(normal)
  }
  return hashes
}

/** The table with one more version's hashes: { key: { version: hash } }, keys and versions sorted. */
export function withVersionHashes(table, version, hashes) {
  const result = {}
  for (const key of [...new Set([...Object.keys(table), ...Object.keys(hashes)])].sort()) {
    const versions = { ...(table[key] ?? {}) }
    if (hashes[key]) versions[version] = hashes[key]
    result[key] = Object.fromEntries(Object.entries(versions).sort(([a], [b]) => compareVersions(a, b)))
  }
  return result
}

/** The released versions' hashes from templates/released.json, with this package's own added. */
export function releasedHashes() {
  const table = existsSync(RELEASED_FILE) ? JSON.parse(readFileSync(RELEASED_FILE, 'utf8')) : {}
  return withVersionHashes(table, PACKAGE_VERSION, currentHashes())
}

/**
 * What an installed managed file is: 'unchanged' (this package's version), 'released' (an
 * older released version, in versions), 'newer' (a version newer than this package) or
 * 'edited' (none of them: changed by hand).
 */
export function judgeManaged(key, installed, wanted, dir, table) {
  const hash = contentHash(normalizeManaged(installed, dir))
  if (hash === contentHash(normalizeManaged(wanted, dir))) return { state: 'unchanged', versions: [PACKAGE_VERSION] }
  const versions = Object.entries(table[key] ?? {})
    .filter(([, known]) => known === hash)
    .map(([version]) => version)
  if (versions.some((version) => compareVersions(version, PACKAGE_VERSION) > 0)) return { state: 'newer', versions }
  return { state: versions.length > 0 ? 'released' : 'edited', versions }
}

/** The managed block in a text, markers included: { start, end, block }, { unterminated: true }, or null. */
export function findManagedBlock(text) {
  const start = text.indexOf(MANAGED_START)
  if (start === -1) return null
  const end = text.indexOf(MANAGED_END, start)
  if (end === -1) return { unterminated: true }
  return { start, end: end + MANAGED_END.length, block: text.slice(start, end + MANAGED_END.length) }
}

/** A lineDiff with only the changed lines and `context` unchanged lines around them; "  …" marks a gap. */
export function compactDiff(diff, context = 2) {
  const lines = diff.split('\n')
  const keep = lines.map(() => false)
  lines.forEach((line, index) => {
    if (line.startsWith('  ')) return
    for (let near = Math.max(0, index - context); near <= Math.min(lines.length - 1, index + context); near++) keep[near] = true
  })
  const out = []
  lines.forEach((line, index) => {
    if (keep[index]) out.push(line)
    else if (out.at(-1) !== '  …') out.push('  …')
  })
  return out.join('\n')
}

// The plan and its application.

function readOrNull(root, path) {
  try {
    return readFileSync(join(root, path), 'utf8')
  } catch {
    return null
  }
}

const NEWER = `run "npx resaledger@latest update" instead`

/**
 * Plans the update without writing anything. options is { force, released } (released
 * defaults to releasedHashes()). Returns { refusals, dir, manager, files, writes (path →
 * text), executable, integrate, instructions }. files holds { path, state, from?, note?,
 * diff? } with state 'replaced', 'restored', 'kept', 'manual' or 'unchanged'. Nothing may be
 * written when refusals is not empty.
 */
export function planUpdate(root, options = {}) {
  const force = options.force ?? false
  const plan = { refusals: [], dir: null, manager: null, files: [], writes: new Map(), executable: new Set(), integrate: false, instructions: null }
  const refuse = (message) => plan.refusals.push(message)

  // The configuration names the workspace folder; update never writes it.
  const configText = readOrNull(root, CONFIG_FILE)
  if (configText === null) {
    refuse(
      existsSync(join(root, LEGACY_CONFIG_FILE))
        ? `${LEGACY_CONFIG_FILE} exists: this is an agent-ledger 0.x workspace. Run "npx resaledger migrate" to convert it to ResaLedger 1.0`
        : `${CONFIG_FILE} is missing: ResaLedger is not set up in this repository. Run "npx resaledger init"`
    )
    return plan
  }
  const { config, problems } = parseConfig(configText)
  if (!config) {
    for (const problem of problems) refuse(`${CONFIG_FILE}: ${problem.message}`)
    return plan
  }
  const dir = config.dir
  plan.dir = dir
  if (!existsSync(BUILT_GUARD)) {
    refuse(`the built guard ${BUILT_GUARD} is missing; build it with "node scripts/bundle.mjs"`)
    return plan
  }
  const table = options.released ?? releasedHashes()

  /** One managed file that update owns as a whole, or its block (write builds the new file). */
  const judgeFile = (path, key, installed, wanted, judgedDir, write) => {
    if (installed === null) {
      plan.files.push({ path, state: 'restored' })
      plan.writes.set(path, write())
      return
    }
    const { state, versions } = judgeManaged(key, installed, wanted, judgedDir, table)
    if (state === 'newer') return refuse(`${path} is from ResaLedger ${versions.at(-1)}, newer than this package (${PACKAGE_VERSION}); ${NEWER}`)
    if (state === 'unchanged') return plan.files.push({ path, state })
    if (state === 'released') {
      plan.files.push({ path, state: 'replaced', from: versions.at(-1) })
      plan.writes.set(path, write())
      return
    }
    const diff = compactDiff(lineDiff(installed.replace(/\r\n?/g, '\n').trimEnd(), wanted.trimEnd()))
    if (force) {
      plan.files.push({ path, state: 'replaced', note: 'changed by hand, replaced with --force', diff })
      plan.writes.set(path, write())
    } else plan.files.push({ path, state: 'kept', note: 'changed by hand, so it is kept', diff })
  }

  // 1. The guard. A newer one is refused even when it was edited: its version line says so.
  const guardPath = `${dir}/scripts/records.mjs`
  const guard = readFileSync(BUILT_GUARD, 'utf8')
  const installedGuard = readOrNull(root, guardPath)
  const installedVersion = installedGuard === null ? null : guardVersion(installedGuard)
  if (installedVersion && compareVersions(installedVersion, PACKAGE_VERSION) > 0) {
    refuse(`${guardPath} is ResaLedger ${installedVersion}, newer than this package (${PACKAGE_VERSION}); ${NEWER}`)
    return plan
  }
  judgeFile(guardPath, 'guard', installedGuard, guard, null, () => guard)
  plan.executable.add(guardPath)

  // 2. The git hooks: .githooks/, or the guard's calls in a hook manager.
  plan.manager = detectHookManager(root)
  if (!plan.manager) {
    for (const name of HOOK_NAMES) {
      const path = `${HOOKS_FOLDER}/${name}`
      const wanted = renderHook(name, dir)
      judgeFile(path, `hooks/${name}`, readOrNull(root, path), wanted, dir, () => wanted)
      plan.executable.add(path)
    }
    // An install from before the rule existed gets it; an equivalent rule of the project's counts.
    const attributes = readOrNull(root, GITATTRIBUTES_FILE)
    const withRule = withHooksEolRule(attributes)
    if (withRule === attributes) plan.files.push({ path: GITATTRIBUTES_FILE, state: 'unchanged' })
    else {
      plan.files.push({ path: GITATTRIBUTES_FILE, state: attributes === null ? 'restored' : 'replaced', note: `the line "${HOOKS_EOL_RULE}" added` })
      plan.writes.set(GITATTRIBUTES_FILE, withRule)
    }
  } else if (plan.manager === 'husky') {
    for (const name of HOOK_NAMES) {
      const path = `.husky/${name}`
      const text = readOrNull(root, path) ?? ''
      const lines = text.split('\n')
      const at = lines.findIndex((line) => line.replace(/\r$/, '') === callMarker(name))
      const call = guardCall(name, dir)
      if (at === -1) {
        plan.files.push({ path, state: 'restored', note: "the guard's call" })
        plan.integrate = true
        continue
      }
      const current = (lines[at + 1] ?? '').replace(/\r$/, '')
      if (current === call) {
        plan.files.push({ path, state: 'unchanged' })
        continue
      }
      const diff = lineDiff(current, call)
      if (force) {
        const trailing = at + 1 === lines.length - 1 && lines[at + 1] === '' // the empty part after a final newline
        lines.splice(at + 1, at + 1 < lines.length && !trailing ? 1 : 0, call)
        plan.files.push({ path, state: 'replaced', note: "the guard's call, changed by hand, replaced with --force", diff })
        plan.writes.set(path, lines.join('\n'))
        plan.executable.add(path)
      } else plan.files.push({ path, state: 'kept', note: "the guard's call was changed by hand, so it is kept", diff })
    }
  } else if (plan.manager === 'simple-git-hooks') {
    let hooks = {}
    try {
      hooks = JSON.parse(readOrNull(root, 'package.json') ?? '{}')['simple-git-hooks'] ?? {}
    } catch {}
    const missing = HOOK_NAMES.filter((name) => !(typeof hooks[name] === 'string' && hooks[name].includes(`/scripts/records.mjs" ${name}`)))
    if (missing.length > 0) {
      plan.files.push({ path: 'package.json', state: 'restored', note: `the guard's ${missing.join(', ')} calls under "simple-git-hooks"` })
      plan.integrate = true
    } else plan.files.push({ path: 'package.json', state: 'unchanged', note: 'the guard\'s calls under "simple-git-hooks"' })
  } else {
    // lefthook and pre-commit use YAML, which update does not edit; it checks the calls are there.
    const files = plan.manager === 'lefthook' ? LEFTHOOK_FILES : ['.pre-commit-config.yaml']
    const path = files.find((file) => existsSync(join(root, file))) ?? files[0]
    const text = readOrNull(root, path) ?? ''
    const missing = HOOK_NAMES.filter((name) => !new RegExp(`records\\.mjs"?\\s+${name}\\b`).test(text))
    if (missing.length > 0) {
      plan.files.push({ path, state: 'manual', note: `the guard's ${missing.join(', ')} calls are missing; add them as shown below` })
      plan.instructions = integrateHookManager(root, plan.manager, dir).instructions
    } else plan.files.push({ path, state: 'unchanged', note: "the guard's calls" })
  }

  // 3. The managed block in the root AGENTS.md; the rest of the file is the project's.
  const agentsPath = realRelative(root, 'AGENTS.md')
  const block = agentsBlock(dir)
  if (agentsPath === null) {
    plan.files.push({ path: 'AGENTS.md', state: 'manual', note: 'a link outside the repository, so update does not write there; renew its managed block by hand' })
  } else {
    const text = readOrNull(root, agentsPath) ?? ''
    const found = findManagedBlock(text)
    const label = `${agentsPath} (managed block)`
    if (found?.unterminated) {
      plan.files.push({ path: label, state: 'kept', note: `the block has no "${MANAGED_END}" line, so update cannot tell it from your text; restore the line by hand` })
    } else if (found === null) {
      plan.files.push({ path: label, state: 'restored' })
      plan.writes.set(agentsPath, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${text === '' ? '' : '\n'}${block}\n`)
    } else {
      judgeFile(label, 'agents-block', found.block, block, dir, () => `${text.slice(0, found.start)}${block}${text.slice(found.end)}`)
      if (plan.writes.has(label)) {
        plan.writes.set(agentsPath, plan.writes.get(label))
        plan.writes.delete(label)
      }
    }
  }

  // 4. ResaLedger's entries in the agents' hook configurations; the other entries are the project's.
  const agentPlan = planAgentConfigs(root, detectAgents(root), dir, plan.writes)
  for (const file of agentPlan.files) {
    const state = file.created ? 'restored' : file.changed ? 'replaced' : 'unchanged'
    plan.files.push({ path: file.path, state, note: "ResaLedger's hook entries" })
  }
  for (const { path, reason, snippet } of agentPlan.manual) {
    plan.files.push({ path, state: 'manual', note: `${reason}, so its hook entries were not renewed; fix it and run update again, or add the entries below by hand` })
    plan.instructions = [plan.instructions, `Add these entries under "hooks" in ${path}:\n${snippet}`].filter(Boolean).join('\n\n')
  }
  for (const path of plan.executable) if (!plan.writes.has(path)) plan.executable.delete(path)
  return plan
}

/** Writes a plan that has no refusals, and adds missing calls to a hook manager. Returns the changed paths. */
export function applyUpdate(root, plan) {
  if (plan.refusals.length > 0) throw new Error('applyUpdate: the plan has refusals')
  for (const [path, text] of plan.writes) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
    if (plan.executable.has(path)) chmodSync(full, 0o755)
  }
  const changed = [...plan.writes.keys()]
  if (plan.integrate) changed.push(...integrateHookManager(root, plan.manager, plan.dir).changed)
  return [...new Set(changed)].sort()
}
