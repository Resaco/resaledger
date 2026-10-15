// The configuration, .resaledger.json: read, validated and completed with its defaults.
// The table of keys is spec 5.2; the presets are spec 7.
import { likelyTypo } from './util.mjs'

export const CONFIG_FILE = '.resaledger.json'
export const CONFIG_VERSION = 2

const LEGACY_CONFIG_FILE = '.agent-ledger.json'

/** The defaults for every key that does not depend on the preset. */
export const DEFAULTS = Object.freeze({
  dir: 'ledger',
  preset: 'solo',
  base: 'main',
  branchPattern: '',
  branchPrefix: '',
  wip: 3,
  commitStyle: 'free',
  aiAttribution: 'allow',
  codePaths: Object.freeze([]),
  gates: Object.freeze({ commit: Object.freeze([]), verify: Object.freeze([]) }),
  ci: Object.freeze({ runGates: true }),
  phases: Object.freeze([]),
  agent: Object.freeze({ deny: Object.freeze([]) })
})

/** The keys each preset decides. `protected` is a function of the base branch. */
export const PRESETS = Object.freeze({
  solo: Object.freeze({ protected: () => [], requirePushed: false, claimPush: false }),
  team: Object.freeze({ protected: (base) => [base], requirePushed: true, claimPush: true })
})

const CONFIG_KEYS = [
  'version',
  'dir',
  'preset',
  'base',
  'protected',
  'requirePushed',
  'claimPush',
  'branchPattern',
  'branchPrefix',
  'wip',
  'commitStyle',
  'aiAttribution',
  'codePaths',
  'gates',
  'ci',
  'phases',
  'agent'
]
const CONFIG_SECTION_KEYS = { gates: ['commit', 'verify'], ci: ['runGates'], agent: ['deny'] }
const DENY_RULE_KEYS = ['pattern', 'reason']
const COMMIT_STYLES = ['free', 'conventional']
const AI_ATTRIBUTIONS = ['allow', 'forbid']
const PHASE_PREFIX = /^[A-Z]{1,4}$/

/** The 1-based line of a key path such as ['agent', 'deny', 1, 'pattern'] in the text, or 0. */
function configKeyLine(text, path) {
  let from = 0
  let found = -1
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index]
    if (typeof segment === 'number') {
      // An item in an array of objects: step past segment + 1 opening braces.
      if (index === path.length - 1) break
      for (let count = 0; count <= segment; count += 1) {
        const brace = text.indexOf('{', from)
        if (brace < 0) return found < 0 ? 0 : text.slice(0, found).split('\n').length
        from = brace + 1
      }
      continue
    }
    const literal = JSON.stringify(segment).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`${literal}\\s*:`, 'g')
    pattern.lastIndex = from
    const match = pattern.exec(text)
    if (!match) break
    found = match.index
    from = match.index + match[0].length
  }
  return found < 0 ? 0 : text.slice(0, found).split('\n').length
}

/** The line of a JSON syntax error, from the message's position or line, or 0. */
function jsonErrorLine(text, error) {
  const line = error.message.match(/line (\d+)/)
  if (line) return Number(line[1])
  const position = error.message.match(/position (\d+)/)
  if (position) return text.slice(0, Number(position[1])).split('\n').length
  return 0
}

// One folder name: letters, digits, '.', '_' and '-', not starting with '-'. The names are
// pasted into hook scripts, YAML snippets and commands, so nothing in them may need quoting.
const SAFE_SEGMENT = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/

/** True when value is a relative, '/'-separated folder path that is safe in a shell word, a YAML scalar and a path. */
export function isSafeFolderPath(value) {
  if (typeof value !== 'string' || value === '') return false
  return value.split('/').every((segment) => SAFE_SEGMENT.test(segment) && segment !== '.' && segment !== '..')
}

/** The rule isSafeFolderPath checks, in words, for messages. */
export const SAFE_FOLDER_RULE = "'/'-separated names of letters, digits, '.', '_' and '-', none of them empty, '.' or '..', and none starting with '-'"

function isJsonObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function configKeyName(path) {
  return path.map((segment, index) => (typeof segment === 'number' ? `[${segment}]` : index ? `.${segment}` : segment)).join('')
}

/**
 * Parses and validates the text of .resaledger.json. Returns { config, problems };
 * config is null when there is any problem, else every key is filled in.
 */
export function parseConfig(text) {
  const problems = []
  const report = (path, message) => problems.push({ file: CONFIG_FILE, line: path ? configKeyLine(text, path) : 0, message })

  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    problems.push({ file: CONFIG_FILE, line: jsonErrorLine(text, error), message: `not valid JSON (${error.message})` })
    return { config: null, problems }
  }
  if (!isJsonObject(raw)) {
    report(null, 'the configuration must be a JSON object, such as { "version": 2 }')
    return { config: null, problems }
  }

  const unknownKeys = (object, known, parent) => {
    for (const key of Object.keys(object)) {
      if (known.includes(key)) continue
      const path = [...parent, key]
      const guess = likelyTypo(key, known)
      const hint = guess ? `; did you mean "${configKeyName([...parent, guess])}"?` : `; known keys here: ${known.join(', ')}`
      report(path, `unknown key "${configKeyName(path)}"${hint}`)
    }
  }
  // An unknown version stops here: its other keys may mean something this guard does not know.
  if (!('version' in raw)) {
    report(null, `"version" is missing; this guard reads version ${CONFIG_VERSION}: add "version": ${CONFIG_VERSION}`)
    return { config: null, problems }
  }
  if (raw.version !== CONFIG_VERSION) {
    const fix =
      raw.version === 1
        ? 'version 1 is an agent-ledger 0.x configuration; run npx resaledger migrate'
        : 'run npx resaledger update to get a guard that reads it'
    report(['version'], `version ${JSON.stringify(raw.version)} is not supported; this guard reads version ${CONFIG_VERSION}: ${fix}`)
    return { config: null, problems }
  }

  unknownKeys(raw, CONFIG_KEYS, [])

  const string = (key, fallback, { nonEmpty = false } = {}) => {
    if (!(key in raw)) return fallback
    if (typeof raw[key] !== 'string' || (nonEmpty && raw[key] === '')) {
      report([key], `"${key}" must be ${nonEmpty ? 'a non-empty string' : 'a string'}, not ${JSON.stringify(raw[key])}`)
      return fallback
    }
    return raw[key]
  }
  const boolean = (object, key, fallback, path) => {
    if (!(key in object)) return fallback
    if (typeof object[key] !== 'boolean') {
      report(path, `"${configKeyName(path)}" must be true or false`)
      return fallback
    }
    return object[key]
  }
  const oneOf = (key, allowed, fallback) => {
    if (!(key in raw)) return fallback
    if (!allowed.includes(raw[key])) {
      report([key], `"${key}" must be one of ${allowed.map((value) => `"${value}"`).join(', ')}, not ${JSON.stringify(raw[key])}`)
      return fallback
    }
    return raw[key]
  }
  const strings = (object, key, path, check) => {
    if (!(key in object)) return []
    const value = object[key]
    if (!Array.isArray(value)) {
      report(path, `"${configKeyName(path)}" must be an array of strings, such as []`)
      return []
    }
    const result = []
    value.forEach((item, index) => {
      if (typeof item !== 'string' || item === '') {
        report(path, `"${configKeyName([...path, index])}" must be a non-empty string`)
        return
      }
      const checked = check ? check(item, [...path, index]) : item
      if (checked !== null) result.push(checked)
    })
    return result
  }
  const section = (key) => {
    if (!(key in raw)) return {}
    if (!isJsonObject(raw[key])) {
      report([key], `"${key}" must be an object, such as { ${CONFIG_SECTION_KEYS[key].map((name) => `"${name}": …`).join(', ')} }`)
      return {}
    }
    unknownKeys(raw[key], CONFIG_SECTION_KEYS[key], [key])
    return raw[key]
  }

  // dir
  let dir = DEFAULTS.dir
  if ('dir' in raw) {
    if (typeof raw.dir !== 'string') report(['dir'], `"dir" must be a string, such as "${DEFAULTS.dir}"`)
    else {
      if (!isSafeFolderPath(raw.dir))
        report(['dir'], `"dir" must be a relative folder inside the repository, such as "${DEFAULTS.dir}" or "docs/ledger", written as ${SAFE_FOLDER_RULE}; not ${JSON.stringify(raw.dir)}`)
      else dir = raw.dir
    }
  }

  const preset = oneOf('preset', Object.keys(PRESETS), DEFAULTS.preset)
  const base = string('base', DEFAULTS.base, { nonEmpty: true })
  const fromPreset = PRESETS[preset]

  const protectedBranches = 'protected' in raw ? strings(raw, 'protected', ['protected']) : fromPreset.protected(base)
  const requirePushed = boolean(raw, 'requirePushed', fromPreset.requirePushed, ['requirePushed'])
  const claimPush = boolean(raw, 'claimPush', fromPreset.claimPush, ['claimPush'])

  const branchPattern = string('branchPattern', DEFAULTS.branchPattern)
  let branchRegex = null
  if (branchPattern !== '') {
    try {
      branchRegex = new RegExp(branchPattern)
    } catch (error) {
      report(['branchPattern'], `"branchPattern" is not a valid regular expression (${error.message})`)
    }
  }
  const branchPrefix = string('branchPrefix', DEFAULTS.branchPrefix)

  let wip = DEFAULTS.wip
  if ('wip' in raw) {
    if (!Number.isInteger(raw.wip) || raw.wip < 1) report(['wip'], `"wip" must be a positive integer, such as ${DEFAULTS.wip}, not ${JSON.stringify(raw.wip)}`)
    else wip = raw.wip
  }

  const commitStyle = oneOf('commitStyle', COMMIT_STYLES, DEFAULTS.commitStyle)
  const aiAttribution = oneOf('aiAttribution', AI_ATTRIBUTIONS, DEFAULTS.aiAttribution)

  const codePaths = strings(raw, 'codePaths', ['codePaths'], (item, path) => {
    if (isSafeFolderPath(item)) return item
    report(path, `"${configKeyName(path)}" must be a relative folder inside the workspace, written as ${SAFE_FOLDER_RULE}; not ${JSON.stringify(item)}`)
    return null
  })

  const gatesSection = section('gates')
  const gates = { commit: strings(gatesSection, 'commit', ['gates', 'commit']), verify: strings(gatesSection, 'verify', ['gates', 'verify']) }

  const ciSection = section('ci')
  const ci = { runGates: boolean(ciSection, 'runGates', DEFAULTS.ci.runGates, ['ci', 'runGates']) }

  const phases = strings(raw, 'phases', ['phases'], (item, path) => {
    if (PHASE_PREFIX.test(item)) return item
    report(path, `"${configKeyName(path)}" must be an id prefix of one to four capital letters, such as "S", not ${JSON.stringify(item)}`)
    return null
  })

  const agentSection = section('agent')
  const deny = []
  if ('deny' in agentSection) {
    if (!Array.isArray(agentSection.deny)) report(['agent', 'deny'], '"agent.deny" must be an array of { "pattern": "…", "reason": "…" }')
    else {
      agentSection.deny.forEach((rule, index) => {
        const path = ['agent', 'deny', index]
        if (!isJsonObject(rule)) {
          report(['agent', 'deny'], `"${configKeyName(path)}" must be an object: { "pattern": "…", "reason": "…" }`)
          return
        }
        unknownKeys(rule, DENY_RULE_KEYS, path)
        if (typeof rule.pattern !== 'string' || rule.pattern === '') {
          report([...path, 'pattern'], `"${configKeyName(path)}.pattern" must be a non-empty string holding a regular expression`)
          return
        }
        if ('reason' in rule && typeof rule.reason !== 'string') {
          report([...path, 'reason'], `"${configKeyName(path)}.reason" must be a string`)
          return
        }
        try {
          deny.push({ pattern: rule.pattern, reason: rule.reason ?? '', regex: new RegExp(rule.pattern) })
        } catch (error) {
          report([...path, 'pattern'], `"${configKeyName(path)}.pattern" is not a valid regular expression (${error.message})`)
        }
      })
    }
  }

  if (problems.length > 0) {
    problems.sort((a, b) => a.line - b.line)
    return { config: null, problems }
  }
  const config = {
    version: CONFIG_VERSION,
    dir,
    preset,
    base,
    protected: protectedBranches,
    requirePushed,
    claimPush,
    branchPattern,
    branchRegex,
    branchPrefix,
    wip,
    commitStyle,
    aiAttribution,
    codePaths,
    gates,
    ci,
    phases,
    agent: { deny }
  }
  return { config, problems }
}

/**
 * Reads and parses the configuration. `read(path)` returns a file's text or null;
 * a reader object with a read method works too.
 */
export function loadConfig(read) {
  const readFile = typeof read === 'function' ? read : (path) => read.read(path)
  const text = readFile(CONFIG_FILE)
  if (text !== null && text !== undefined) return parseConfig(text)
  const legacy = readFile(LEGACY_CONFIG_FILE)
  const message =
    legacy !== null && legacy !== undefined
      ? `${CONFIG_FILE} is missing, and ${LEGACY_CONFIG_FILE} says this is an agent-ledger 0.x workspace; run npx resaledger migrate`
      : `${CONFIG_FILE} is missing; run npx resaledger init to set up ResaLedger`
  return { config: null, problems: [{ file: CONFIG_FILE, line: 0, message }] }
}

/** The effective configuration as JSON text, without the compiled regular expressions. */
export function effectiveConfigJson(config) {
  const { branchRegex, agent, ...rest } = config
  const plain = { ...rest, agent: { deny: agent.deny.map(({ pattern, reason }) => ({ pattern, reason })) } }
  return JSON.stringify(plain, null, 2)
}
