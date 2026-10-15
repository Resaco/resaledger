// Changes to enforcement (spec 10): what a pull request changes in the configuration, the guard,
// the git hooks and the workflow; which of those changes weaken the rules; and the decisions the
// pull request adds that let a weakening change through. The table of ids is in spec 10.
import { CONFIG_FILE, loadConfig } from './config.mjs'
import { compareVersions, contentHash, normalizeManaged, releasedTable } from './managed.mjs'
import { parseDecision } from './records.mjs'
import { treeReader } from './workspace.mjs'

const ENFORCEMENT_HOOKS = '.githooks/'
// The file whose line keeps the hooks LF on Windows (spec 13); a change to it is listed.
const ENFORCEMENT_ATTRIBUTES = '.gitattributes'
const ENFORCEMENT_EXECUTABLE = '100755'
export const ENFORCEMENT_WORKFLOW = '.github/workflows/resaledger.yml'
// The decision field that names the weakening changes a decision allows (spec 10).
const ENFORCEMENT_FIELD = 'Weakens'

/** One change: { id, kind: 'listed' | 'weakening', file, what }. */
function enforcementChange(id, weakening, what, file = CONFIG_FILE) {
  return { id, kind: weakening ? 'weakening' : 'listed', file, what }
}

/** A list of values for a message: "a", "b". */
function enforcementQuoted(values) {
  return values.map((value) => JSON.stringify(value)).join(', ')
}

/** A single value that changed, or nothing. */
function enforcementValue(id, before, after, weakening, what) {
  return before === after ? [] : [enforcementChange(id, weakening, what)]
}

/** A switch: turning it off weakens, turning it on tightens. */
function enforcementSwitch(id, before, after) {
  return enforcementValue(id, before, after, before && !after, `${id} turned ${after ? 'on' : 'off'}`)
}

/** A list where a removed item weakens and an added one tightens; a new order is listed. */
function enforcementList(id, before, after) {
  const removed = before.filter((item) => !after.includes(item))
  const added = after.filter((item) => !before.includes(item))
  if (removed.length === 0 && added.length === 0) {
    return before.join('\0') === after.join('\0') ? [] : [enforcementChange(id, false, `${id} reordered`)]
  }
  const parts = []
  if (removed.length > 0) parts.push(`removed ${enforcementQuoted(removed)}`)
  if (added.length > 0) parts.push(`added ${enforcementQuoted(added)}`)
  return [enforcementChange(id, removed.length > 0, `${id}: ${parts.join('; ')}`)]
}

/** The changes between two effective configurations, key by key (spec 5.2). */
function configChanges(before, after) {
  const pattern = (value) => (value === '' ? 'none' : JSON.stringify(value))
  const deny = (config) => config.agent.deny.map(({ pattern: rule }) => rule)
  const reasons = (config) => JSON.stringify(config.agent.deny.map(({ pattern: rule, reason }) => [rule, reason]))
  const changes = [
    ...enforcementValue('dir', before.dir, after.dir, true, `dir moved from "${before.dir}" to "${after.dir}"`),
    ...enforcementValue('preset', before.preset, after.preset, false, `preset changed from "${before.preset}" to "${after.preset}"`),
    ...enforcementValue('base', before.base, after.base, true, `base changed from "${before.base}" to "${after.base}"`),
    ...enforcementList('protected', before.protected, after.protected),
    ...enforcementSwitch('requirePushed', before.requirePushed, after.requirePushed),
    ...enforcementSwitch('claimPush', before.claimPush, after.claimPush),
    ...enforcementValue(
      'branchPattern',
      before.branchPattern,
      after.branchPattern,
      before.branchPattern !== '',
      `branchPattern changed from ${pattern(before.branchPattern)} to ${pattern(after.branchPattern)}`
    ),
    ...enforcementValue('branchPrefix', before.branchPrefix, after.branchPrefix, false, `branchPrefix changed from ${pattern(before.branchPrefix)} to ${pattern(after.branchPrefix)}`),
    ...enforcementValue('wip', before.wip, after.wip, after.wip > before.wip, `wip ${after.wip > before.wip ? 'raised' : 'lowered'} from ${before.wip} to ${after.wip}`),
    ...enforcementValue(
      'commitStyle',
      before.commitStyle,
      after.commitStyle,
      before.commitStyle === 'conventional',
      `commitStyle changed from "${before.commitStyle}" to "${after.commitStyle}"`
    ),
    ...enforcementValue(
      'aiAttribution',
      before.aiAttribution,
      after.aiAttribution,
      before.aiAttribution === 'forbid',
      `aiAttribution changed from "${before.aiAttribution}" to "${after.aiAttribution}"`
    ),
    ...enforcementList('codePaths', before.codePaths, after.codePaths),
    ...enforcementList('gates.commit', before.gates.commit, after.gates.commit),
    ...enforcementList('gates.verify', before.gates.verify, after.gates.verify),
    ...enforcementSwitch('ci.runGates', before.ci.runGates, after.ci.runGates),
    ...enforcementValue('phases', before.phases.join(', '), after.phases.join(', '), false, `phases changed from [${before.phases.join(', ')}] to [${after.phases.join(', ')}]`)
  ]
  const denyChanges = enforcementList('agent.deny', deny(before), deny(after))
  if (denyChanges.length === 0 && reasons(before) !== reasons(after)) denyChanges.push(enforcementChange('agent.deny', false, 'agent.deny: a reason changed'))
  return [...changes, ...denyChanges, ...unknownKeyChanges(before.unknown ?? {}, after.unknown ?? {})]
}

/**
 * Keys the guard that judges does not know, such as one a later release added: listed, never
 * judged, because their meaning is unknown here; a reviewer sees them.
 */
function unknownKeyChanges(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  return keys.flatMap((key) => {
    const was = JSON.stringify(before[key])
    const now = JSON.stringify(after[key])
    if (was === now) return []
    const what = was === undefined ? `${key}: added ${now}, a key this guard does not know` : now === undefined ? `${key}: removed, a key this guard does not know` : `${key}: changed from ${was} to ${now}, a key this guard does not know`
    return [enforcementChange(key, false, what)]
  })
}

/** The newest released version whose text of a managed file is this one, or null. */
function releasedVersionOf(text, key, dir, released) {
  if (text === null) return null
  const hash = contentHash(normalizeManaged(text, dir))
  const versions = Object.entries(released[key] ?? {})
    .filter(([, known]) => known === hash)
    .map(([version]) => version)
    .sort(compareVersions)
  return versions.at(-1) ?? null
}

/**
 * The change to one managed file: listed when the head's text is a released version of it
 * (key in the released table), else weakening. A removed file always weakens, and so does a
 * move back to an older release, which may bring back what a later one fixed.
 */
function managedChange(change, released) {
  const { id, key, path, before, after, dir } = change
  if (before === after) return []
  if (after === null) return [enforcementChange(id, true, `${path} removed`, path)]
  const version = releasedVersionOf(after, key, dir, released)
  const how = before === null ? 'added' : 'changed'
  if (version === null) return [enforcementChange(id, true, `${path} ${how}, and the new text is no released version of ResaLedger's`, path)]
  const previous = releasedVersionOf(before, key, dir, released)
  if (previous !== null && compareVersions(version, previous) < 0) {
    return [enforcementChange(id, true, `${path} moved back from ResaLedger ${previous} to ${version}, an older release`, path)]
  }
  return [enforcementChange(id, false, `${path} ${how}: ResaLedger ${version}, a released version`, path)]
}

/** The mode of a hook as words, for a message. */
function hookModeName(mode) {
  if (mode === ENFORCEMENT_EXECUTABLE) return 'executable'
  if (mode === '120000') return 'a symlink'
  return `not executable (mode ${mode})`
}

/**
 * The change to a hook's mode, folded into the change to its text: a hook that was executable
 * and is no longer (or became a symlink) does not run for anyone who clones, so it weakens.
 */
function hookModeChange(changes, id, path, before, after) {
  if (before === null || after === null || before === after) return changes
  const weakening = before === ENFORCEMENT_EXECUTABLE
  const what = `${path} is now ${hookModeName(after)}, was ${hookModeName(before)}`
  if (changes.length === 0) return [enforcementChange(id, weakening, what, path)]
  const [change] = changes
  return [{ ...change, kind: weakening || change.kind === 'weakening' ? 'weakening' : 'listed', what: `${change.what}; ${what}` }]
}

/** The change to .gitattributes, listed: it holds the line that keeps the hooks LF on Windows. */
function attributesChange(beforeReader, afterReader) {
  const before = beforeReader.read(ENFORCEMENT_ATTRIBUTES)
  const after = afterReader.read(ENFORCEMENT_ATTRIBUTES)
  if (before === after) return []
  const how = before === null ? 'added' : after === null ? 'removed' : 'changed'
  return [enforcementChange('gitattributes', false, `${ENFORCEMENT_ATTRIBUTES} ${how}`, ENFORCEMENT_ATTRIBUTES)]
}

/** The changes to the guard, the git hooks, the workflow and .gitattributes between two trees. */
function fileChanges(beforeReader, afterReader, beforeDir, afterDir, released) {
  const files = [
    {
      id: 'guard',
      key: 'guard',
      path: `${afterDir}/scripts/records.mjs`,
      before: beforeReader.read(`${beforeDir}/scripts/records.mjs`),
      after: afterReader.read(`${afterDir}/scripts/records.mjs`),
      dir: null
    }
  ]
  const hooks = [...new Set([...beforeReader.list(ENFORCEMENT_HOOKS), ...afterReader.list(ENFORCEMENT_HOOKS)])].sort()
  for (const path of hooks) {
    const name = path.slice(ENFORCEMENT_HOOKS.length)
    files.push({ id: `hooks/${name}`, key: `hooks/${name}`, path, before: beforeReader.read(path), after: afterReader.read(path), dir: afterDir, modes: [beforeReader.mode(path), afterReader.mode(path)] })
  }
  // The workflow reads the folder from the configuration, so its text holds no folder name.
  files.push({ id: 'workflow', key: 'workflow', path: ENFORCEMENT_WORKFLOW, before: beforeReader.read(ENFORCEMENT_WORKFLOW), after: afterReader.read(ENFORCEMENT_WORKFLOW), dir: null })
  const changes = files.flatMap((file) => (file.modes ? hookModeChange(managedChange(file, released), file.id, file.path, ...file.modes) : managedChange(file, released)))
  return [...changes, ...attributesChange(beforeReader, afterReader)]
}

/**
 * The decisions a pull request adds (in the head, not at the merge base), with the ids each
 * names on its "- Weakens:" line: [{ file, by, ids }]. Each tree is read in its own folder
 * (mergeBaseDir, dir), so a decision that moves along with the workspace is not added.
 */
function addedDecisions(mergeBaseReader, headReader, mergeBaseDir, dir) {
  // Directly in decisions/, as the records check reads them; a deeper file is no decision.
  const direct = (reader, root) => {
    const folder = `${root}/decisions`
    return reader.list(folder).filter((file) => /\.md$/i.test(file) && !file.slice(folder.length + 1).includes('/'))
  }
  // A decision the merge base has under any name, renamed or copied, is not added by this change.
  const text = (reader, file) => (reader.read(file) ?? '').replace(/\r\n?/g, '\n').trim()
  const known = new Set(direct(mergeBaseReader, mergeBaseDir).map((file) => text(mergeBaseReader, file)))
  const decisions = []
  for (const file of direct(headReader, dir)) {
    if (mergeBaseReader.read(file) !== null || known.has(text(headReader, file))) continue
    const decision = parseDecision(file, headReader.read(file) ?? '')
    const field = (name) => decision.fields.find((item) => item.name === name)
    const weakens = field(ENFORCEMENT_FIELD)
    if (!weakens) continue
    const ids = [weakens.value, ...weakens.items].join(' ').replace(/`/g, '').split(/[\s,]+/).filter((id) => id !== '')
    decisions.push({ file, by: field('Decided by')?.value || null, ids: new Set(ids) })
  }
  return decisions
}

/**
 * The enforcement check of a pull request: the changes from `from` (the merge base, or the base
 * when the merge base has no configuration) to the head, each weakening one matched with a
 * decision the pull request adds. `adds` is true when the base has no configuration: then there
 * is nothing to compare against. Returns { check, changes } with changes as
 * [{ id, kind, file, what, decidedBy: { file, by } | null }].
 */
export function enforcementCheck(root, { from, mergeBase, head, adds, released = releasedTable() }) {
  const check = { name: 'enforcement', ok: true, problems: [], counts: { changes: 0, weakening: 0 }, note: null }
  if (adds) return { check: { ...check, skipped: true, note: 'the base has no configuration, so there is nothing to compare against' }, changes: [] }

  const beforeReader = treeReader({ kind: 'commit', rev: from, root })
  const headReader = treeReader({ kind: 'commit', rev: head, root })
  const mergeBaseReader = mergeBase === from ? beforeReader : treeReader({ kind: 'commit', rev: mergeBase, root })
  const before = loadConfig(beforeReader).config
  const after = loadConfig(headReader)
  const found = []
  if (after.config) found.push(...configChanges(before, after.config))
  else if (headReader.read(CONFIG_FILE) === null) found.push(enforcementChange('config', true, `${CONFIG_FILE} removed`))
  else found.push(enforcementChange('config', true, `${CONFIG_FILE} is not a valid configuration in the head`))
  const dir = after.config?.dir ?? before.dir
  found.push(...fileChanges(beforeReader, headReader, before.dir, dir, released))

  const mergeBaseDir = (mergeBaseReader === beforeReader ? before : loadConfig(mergeBaseReader).config)?.dir ?? before.dir
  const decisions = addedDecisions(mergeBaseReader, headReader, mergeBaseDir, dir)
  const changes = found.map((change) => {
    const decision = change.kind === 'weakening' ? decisions.find(({ ids }) => ids.has(change.id)) : undefined
    return { ...change, decidedBy: decision ? { file: decision.file, by: decision.by } : null }
  })
  for (const change of changes) {
    if (change.kind !== 'weakening' || change.decidedBy) continue
    check.problems.push({
      id: change.id,
      file: change.file,
      line: 0,
      message: `${change.what}: this weakens enforcement, and no decision this pull request adds names it. Add one in ${dir}/decisions/ with the line "- Weakens: ${change.id}"`
    })
  }
  check.ok = check.problems.length === 0
  check.counts = { changes: changes.length, weakening: changes.filter(({ kind }) => kind === 'weakening').length }
  return { check, changes }
}
