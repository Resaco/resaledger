#!/usr/bin/env node
// ResaLedger 1.0.0-rc.3
// The ResaLedger guard: one file with no dependencies, run by the git hooks, the agent
// hooks and CI. Built from its source modules by scripts/bundle.mjs; do not edit it here.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { isatty } from 'node:tty'
import { fileURLToPath } from 'node:url'

const VERSION = '1.0.0-rc.3'
const RELEASED = {"guard":{"1.0.0-rc.1":"5865d816045d07943149d2672863d8692583792e291834b0a22817811b3ffa15","1.0.0-rc.2":"0ba567d54ac828281b33cdf78774b9cda38119aed73fb2c0e10e146201f6b170"},"hooks/commit-msg":{"1.0.0-rc.1":"aed52395adb1fd45357244e5d78ddc3c60b0e5fc558678b1f7464f42b740f667","1.0.0-rc.2":"aed52395adb1fd45357244e5d78ddc3c60b0e5fc558678b1f7464f42b740f667","1.0.0-rc.3":"aed52395adb1fd45357244e5d78ddc3c60b0e5fc558678b1f7464f42b740f667"},"hooks/pre-commit":{"1.0.0-rc.1":"26abf45bfc0570188dc7cd368e4a40269835b79bfcf72efb30d839017a5322e8","1.0.0-rc.2":"26abf45bfc0570188dc7cd368e4a40269835b79bfcf72efb30d839017a5322e8","1.0.0-rc.3":"26abf45bfc0570188dc7cd368e4a40269835b79bfcf72efb30d839017a5322e8"},"hooks/pre-merge-commit":{"1.0.0-rc.1":"f62d8a0d3dfd87e4816e311a095b8f93e9329955adf668077a0cc10ace224b7f","1.0.0-rc.2":"f62d8a0d3dfd87e4816e311a095b8f93e9329955adf668077a0cc10ace224b7f","1.0.0-rc.3":"f62d8a0d3dfd87e4816e311a095b8f93e9329955adf668077a0cc10ace224b7f"},"hooks/pre-push":{"1.0.0-rc.1":"68ac4461397ecad35218104129f87f02fce5964cbcc71f346dcac424282f553a","1.0.0-rc.2":"68ac4461397ecad35218104129f87f02fce5964cbcc71f346dcac424282f553a","1.0.0-rc.3":"68ac4461397ecad35218104129f87f02fce5964cbcc71f346dcac424282f553a"},"workflow":{"1.0.0-rc.1":"ef7bdb309f6d0137ad2602be587d06ec2013be44664e6ccd99f2ef3da426e68f","1.0.0-rc.2":"ef7bdb309f6d0137ad2602be587d06ec2013be44664e6ccd99f2ef3da426e68f","1.0.0-rc.3":"ef7bdb309f6d0137ad2602be587d06ec2013be44664e6ccd99f2ef3da426e68f"}}

// --- util.mjs ---
// Small helpers that every part of the guard uses.

/** Runs git and returns its trimmed output; throws when git fails. */
function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** A count and its noun: "1 task", "2 tasks"; many is the plural when it is not word + "s". */
function plural(count, word, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`
}

/** The records counted, as "1 task, 2 decisions, 0 log entries". */
function recordCounts(tasks, decisions, logs) {
  return `${plural(tasks, 'task')}, ${plural(decisions, 'decision')}, ${plural(logs, 'log entry', 'log entries')}`
}

/** Prints the message to stderr and stops with exit code 1. */
function fail(message) {
  console.error(`resaledger: ${message}`)
  process.exit(1)
}

/** The top level of the repository the current folder is in, as a POSIX path. */
function repositoryRoot() {
  return git('rev-parse', '--show-toplevel').replace(/\\/g, '/')
}

/**
 * The edit distance between two strings: insertions, deletions, substitutions and swaps of
 * two neighbouring letters, each counting one (the optimal string alignment distance).
 */
function editDistance(a, b) {
  const rows = [Array.from({ length: b.length + 1 }, (_, index) => index)]
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(rows[i - 1][j] + 1, current[j - 1] + 1, rows[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) current[j] = Math.min(current[j], rows[i - 2][j - 2] + 1)
    }
    rows.push(current)
  }
  return rows[a.length][b.length]
}

/** How far a name may be from a known one and still be its typo: 2 for six letters or more, else 1 (spec 5.2, 5.3). */
function typoLimit(known) {
  return known.length >= 6 ? 2 : 1
}

/** The known name closest to name within its typo limit, ignoring case, or null. Ties go to the first. */
function likelyTypo(name, known) {
  let best = null
  let bestDistance = Infinity
  for (const candidate of known) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase())
    if (distance <= typoLimit(candidate) && distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

// --- config.mjs ---
// The configuration, .resaledger.json: read, validated and completed with its defaults.
// The table of keys is spec 5.2; the presets are spec 7.

const CONFIG_FILE = '.resaledger.json'
const CONFIG_VERSION = 2

const LEGACY_CONFIG_FILE = '.agent-ledger.json'

/** The defaults for every key that does not depend on the preset. */
const DEFAULTS = Object.freeze({
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
  agent: Object.freeze({ deny: Object.freeze([]), pushNeedsHandoff: false })
})

/** The keys each preset decides. `protected` is a function of the base branch. */
const PRESETS = Object.freeze({
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
const CONFIG_SECTION_KEYS = { gates: ['commit', 'verify'], ci: ['runGates'], agent: ['deny', 'pushNeedsHandoff'] }
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
function isSafeFolderPath(value) {
  if (typeof value !== 'string' || value === '') return false
  return value.split('/').every((segment) => SAFE_SEGMENT.test(segment) && segment !== '.' && segment !== '..')
}

/** The rule isSafeFolderPath checks, in words, for messages. */
const SAFE_FOLDER_RULE = "'/'-separated names of letters, digits, '.', '_' and '-', none of them empty, '.' or '..', and none starting with '-'"

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
function parseConfig(text) {
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

  // A key this guard does not know is kept, because a later 1.x release may have added it
  // (spec 15); one close to a known key is a typo (util's likelyTypo), which would silently drop a rule.
  const unknown = {}
  const unknownKeys = (object, known, parent) => {
    for (const key of Object.keys(object)) {
      if (known.includes(key)) continue
      const path = [...parent, key]
      const guess = likelyTypo(key, known)
      if (guess) report(path, `unknown key "${configKeyName(path)}"; did you mean "${configKeyName([...parent, guess])}"?`)
      else unknown[configKeyName(path)] = object[key]
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

  const pushNeedsHandoff = boolean(agentSection, 'pushNeedsHandoff', DEFAULTS.agent.pushNeedsHandoff, ['agent', 'pushNeedsHandoff'])

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
    agent: { deny, pushNeedsHandoff },
    unknown
  }
  return { config, problems }
}

/** The notices for the keys a configuration keeps without knowing them, as { file, line, message }. */
function unknownKeyNotices(config) {
  return Object.keys(config.unknown ?? {}).map((key) => ({
    file: CONFIG_FILE,
    line: 0,
    message: `"${key}" is not a key this guard knows; it is kept, since a newer ResaLedger may use it. Run npx resaledger update if the project uses a newer version`
  }))
}

/**
 * Reads and parses the configuration. `read(path)` returns a file's text or null;
 * a reader object with a read method works too.
 */
function loadConfig(read) {
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
function effectiveConfigJson(config) {
  const { branchRegex, agent, unknown, ...rest } = config
  const plain = { ...rest, agent: { deny: agent.deny.map(({ pattern, reason }) => ({ pattern, reason })), pushNeedsHandoff: agent.pushNeedsHandoff } }
  return JSON.stringify(plain, null, 2)
}

// --- adoption.mjs ---
// Where ResaLedger starts in a repository's history: the commit that added .resaledger.json.
// Commits older than it were made before the project adopted ResaLedger, so no range check
// judges them. Handoff and pre-push share this start.

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
function adoptionCommit(root, to) {
  return adoptionOldest(root, [to])
}

/**
 * Where a range check that ends at `to` starts, given the start a caller chose (null for every
 * ancestor). A start whose tree has .resaledger.json is kept: the project had adopted
 * ResaLedger there, so every later commit is judged. Otherwise the start moves to the oldest
 * commit after it that added the file, and the range checks only the commits made since.
 */
function adoptionStart(root, from, to) {
  if (from !== null && adoptionGit(root, ['cat-file', '-e', `${from}:${CONFIG_FILE}`]).ok) return from
  return adoptionOldest(root, from === null ? [to] : [`${from}..${to}`]) ?? from
}

// --- markdown.mjs ---
// Markdown primitives that every record parser uses: lines, headings and their anchors,
// sections, relative links and bullet fields. Pure functions over text; no file access.

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/
const LINK_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const INLINE_LINK =
  /!?\[((?:[^[\]\\]|\\.|\[[^\]]*\])*)\]\(\s*(<[^<>\n]*>|[^\s()<>]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/g
const FIELD = /^- ([\p{L} ]*\p{L}):(?:[ \t]+(.*))?$/u
const NESTED_ITEM = /^(?:\t| {2,})[ \t]*- (.*)$/
const EMPTY_VALUES = new Set(['', '—', '–', '-'])

/** The lines of a text, with CRLF and lone CR treated as LF; a trailing newline adds no line. */
function splitLines(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** For each line, whether it belongs to a fenced code block (the fence lines included). */
function fencedLines(lines) {
  const fenced = []
  let open = null
  for (const line of lines) {
    if (open) {
      fenced.push(true)
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
      if (close && close[1][0] === open[0] && close[1].length >= open.length) open = null
      continue
    }
    const fence = line.match(FENCE_OPEN)
    // A backtick fence's info string may not contain a backtick.
    if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      open = fence[1]
      fenced.push(true)
    } else fenced.push(false)
  }
  return fenced
}

/** The anchor GitHub makes from a heading's text, before duplicates are numbered. */
function headingSlug(text) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc}\- ]/gu, '')
    .replaceAll(' ', '-')
}

/** ATX headings outside fenced code, as { level, text, anchor, line } with 1-based lines. */
function headings(text) {
  const lines = splitLines(text)
  const fenced = fencedLines(lines)
  const taken = new Map()
  const found = []
  lines.forEach((line, index) => {
    if (fenced[index]) return
    const match = line.match(ATX_HEADING)
    if (!match) return
    const title = (match[2] ?? '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim()
    const base = headingSlug(title)
    // Numbered like github-slugger: a number already taken moves on to the next one.
    let anchor = base
    while (taken.has(anchor)) {
      const next = taken.get(base) + 1
      taken.set(base, next)
      anchor = `${base}-${next}`
    }
    taken.set(anchor, 0)
    found.push({ level: match[1].length, text: title, anchor, line: index + 1 })
  })
  return found
}

/** The section an anchor names: its heading, the lines up to the next heading of the same or a higher level, and the heading's line. */
function findSection(text, anchor) {
  const wanted = anchor.replace(/^#/, '').toLowerCase()
  const all = headings(text)
  const position = all.findIndex((heading) => heading.anchor.toLowerCase() === wanted)
  if (position === -1) return null
  const heading = all[position]
  const next = all.slice(position + 1).find((other) => other.level <= heading.level)
  const lines = splitLines(text)
  return { heading, lines: lines.slice(heading.line, next ? next.line - 1 : lines.length), line: heading.line }
}

/** A line with its inline code spans blanked out, so that links inside them are not seen. */
function withoutCodeSpans(line) {
  let result = ''
  let rest = line
  for (;;) {
    const open = rest.match(/`+/)
    if (!open) return result + rest
    const after = rest.slice(open.index + open[0].length)
    const close = after.match(new RegExp(`(?<!\`)${open[0]}(?!\`)`))
    if (!close) return result + rest
    const end = open.index + open[0].length + close.index + open[0].length
    result += rest.slice(0, open.index) + ' '.repeat(end - open.index)
    rest = rest.slice(end)
  }
}

function decodePercent(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Inline links and images that point into the repository, as { target, path, anchor, line }. */
function relativeLinks(text) {
  const lines = splitLines(text)
  const fenced = fencedLines(lines)
  const links = []
  lines.forEach((line, index) => {
    if (fenced[index]) return
    for (const match of withoutCodeSpans(line).matchAll(INLINE_LINK)) {
      const raw = match[2]
      const target = raw.startsWith('<') ? raw.slice(1, -1) : raw
      if (!target || target.startsWith('#') || target.startsWith('//') || LINK_SCHEME.test(target)) continue
      const hash = target.indexOf('#')
      const path = hash === -1 ? target : target.slice(0, hash)
      const anchor = hash === -1 ? '' : target.slice(hash + 1)
      links.push({ target, path: decodePercent(path), anchor: decodePercent(anchor), line: index + 1 })
    }
  })
  return links
}

/** The repository-relative path a link in fromFile points to, or null when it climbs out of the repository. */
function resolveLinkPath(fromFile, path) {
  const joined = path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(fromFile), path)
  const resolved = posix.normalize(joined || '.').replace(/(.)\/+$/, '$1')
  if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) return null
  return resolved
}

/**
 * A bullet list of `- Name: value` fields starting at lines[start], after any blank lines.
 * Nested `  - item` lines go to the field's items; other indented lines continue the last
 * item, or the value. Returns { fields, end } with end the index of the first line after the list.
 */
function parseFields(lines, start) {
  const fields = []
  let index = start
  while (index < lines.length && lines[index].trim() === '') index += 1
  if (index >= lines.length || !FIELD.test(lines[index])) return { fields, end: start }
  for (; index < lines.length; index += 1) {
    const line = lines[index]
    const field = line.match(FIELD)
    if (field) {
      fields.push({ name: field[1].trim(), value: (field[2] ?? '').trim(), items: [], line: index + 1 })
      continue
    }
    const current = fields[fields.length - 1]
    const item = line.match(NESTED_ITEM)
    if (item) {
      current.items.push(item[1].trim())
      continue
    }
    if (/^[ \t]+\S/.test(line)) {
      const more = line.trim()
      if (current.items.length > 0) {
        const last = current.items.length - 1
        current.items[last] = current.items[last] ? `${current.items[last]} ${more}` : more
      } else current.value = current.value ? `${current.value} ${more}` : more
      continue
    }
    break
  }
  return { fields, end: index }
}

/** The "- Name: value" lines from line index start on, outside code blocks, as { name, line }. */
function fieldLinesAfter(lines, start) {
  const fenced = fencedLines(lines)
  const found = []
  for (let index = start; index < lines.length; index += 1) {
    const field = fenced[index] ? null : lines[index].match(FIELD)
    if (field) found.push({ name: field[1].trim(), line: index + 1 })
  }
  return found
}

/** Whether a field value means "empty": nothing, or a dash. */
function isEmptyValue(value) {
  return EMPTY_VALUES.has(value.trim())
}

// --- records.mjs ---
// Decisions, log entries, plan status lines and the workspace README: parsers over text and
// validators over parsed records. No file access; a validator returns problems.

const SETUP_MARKER = 'TODO(resaledger)'

const RECORD_DATE = /^\d{4}-\d{2}-\d{2}$/
const DATED_FILE = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/
const LOG_HEADING = /^(\d{4}-\d{2}-\d{2}) · (\S.*)$/
const PLAN_STATUS_LINE = /^Status:(.*)$/
const PLAN_STATUSES = ['proposal', 'approved', 'in progress', 'implemented']
const README_SECTIONS = ['Goal', 'Environments', 'Manual checks']
const DECISION_FIELDS = ['Date', 'Decided by', 'Status', 'Weakens']
const LOG_FIELDS = ['Lane', 'Tasks']

/** Whether a YYYY-MM-DD string names a day that exists in the calendar. */
function isCalendarDate(value) {
  if (!RECORD_DATE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/**
 * The first H1 of a text and the bullet fields straight after it, with a problem for each
 * repeated field; later holds the "- Name: value" lines below the list's end.
 */
function titleAndFields(file, text) {
  const lines = splitLines(text)
  const title = headings(text).find((heading) => heading.level === 1)
  const problems = []
  if (!title) return { title: null, titleLine: 0, fields: [], later: [], problems }
  const { fields, end } = parseFields(lines, title.line)
  const seen = new Set()
  for (const field of fields) {
    const key = field.name.toLowerCase()
    if (seen.has(key)) {
      problems.push({ file, line: field.line, message: `the field "${field.name}" appears twice; keep one "- ${field.name}: …" line` })
    }
    seen.add(key)
  }
  return { title: title.text, titleLine: title.line, fields, later: fieldLinesAfter(lines, end), problems }
}

/** A problem for each known field below the field list that the list lacks: it is read as text, not as a field. */
function lateFieldProblems(record, known) {
  const listed = new Set(record.fields.map((field) => field.name))
  return record.later
    .filter((field) => known.includes(field.name) && !listed.has(field.name))
    .map((field) => ({
      file: record.file,
      line: field.line,
      message: `"- ${field.name}:" is below the field list, so it is read as text, not as a field; move it up into the list after the heading, with no blank line before it`
    }))
}

/** The first field with exactly this name, or undefined. */
function recordField(record, name) {
  return record.fields.find((field) => field.name === name)
}

/** A problem for each field whose name is a near miss of a known one, such as "Decided By" or "Dat". */
function recordFieldNameProblems(record, known) {
  const problems = []
  for (const field of record.fields) {
    if (known.includes(field.name)) continue
    const suggestion = likelyTypo(field.name, known)
    if (suggestion)
      problems.push({ file: record.file, line: field.line, message: `the field "${field.name}" is not known; write it as "${suggestion}"` })
  }
  return problems
}

/** Problems with a dated file name: <folder>/<date>-<slug>.md, whose date equals the record's. */
function datedFileProblems(file, folder, date, example) {
  const parent = posix.basename(posix.dirname(file))
  const match = posix.basename(file).match(DATED_FILE)
  if (parent !== folder || !match || !isCalendarDate(match[1])) {
    return [{ file, line: 0, message: `the file name should be ${folder}/<YYYY-MM-DD>-<slug>.md, for example ${folder}/${example}` }]
  }
  if (date && isCalendarDate(date) && match[1] !== date) {
    return [{ file, line: 0, message: `the file name's date ${match[1]} differs from the record's date ${date}; rename the file to ${folder}/${date}-${match[2]}.md or correct the date` }]
  }
  return []
}

// Decisions (spec 5.4).

/** A decision file as { file, title, titleLine, fields, problems }. */
function parseDecision(path, text) {
  return { file: path, ...titleAndFields(path, text) }
}

/** Problems with a decision: its heading, Date, Decided by, Status and file name. context.exists(path) checks links. */
function validateDecision(decision, context) {
  const { file } = decision
  const problems = []
  const at = decision.titleLine || 1
  if (!decision.title) {
    problems.push({ file, line: 1, message: 'a decision starts with a heading that says what was decided: "# <decision>"' })
  }

  const date = recordField(decision, 'Date')
  const dateValue = date && !isEmptyValue(date.value) ? date.value : null
  if (!dateValue) {
    problems.push({ file, line: date ? date.line : at, message: 'a decision needs a date: add "- Date: YYYY-MM-DD" after the heading' })
  } else if (!RECORD_DATE.test(dateValue)) {
    problems.push({ file, line: date.line, message: `the date "${dateValue}" is not in the form YYYY-MM-DD; write it as "- Date: 2026-10-14"` })
  } else if (!isCalendarDate(dateValue)) {
    problems.push({ file, line: date.line, message: `the date ${dateValue} does not exist in the calendar; write the real day the decision was made` })
  }

  const decidedBy = recordField(decision, 'Decided by')
  if (!decidedBy || isEmptyValue(decidedBy.value)) {
    problems.push({ file, line: decidedBy ? decidedBy.line : at, message: 'a decision needs the person who decided: write "- Decided by: <name>"' })
  }

  const status = recordField(decision, 'Status')
  if (status && !isEmptyValue(status.value) && status.value !== 'accepted') {
    const superseded = status.value.match(/^superseded by\s+(.+)$/)
    const link = superseded ? relativeLinks(superseded[1])[0] : undefined
    if (!link) {
      problems.push({ file, line: status.line, message: `the status "${status.value}" is not "accepted" or "superseded by <link>"; write "- Status: accepted" or "- Status: superseded by [the newer decision](<date>-<slug>.md)"` })
    } else {
      const target = resolveLinkPath(file, link.path)
      if (target === null || !context.exists(target)) {
        problems.push({ file, line: status.line, message: `the superseding decision "${link.path}" does not exist; link to the decision file that replaces this one` })
      }
    }
  }

  problems.push(...recordFieldNameProblems(decision, DECISION_FIELDS))
  problems.push(...lateFieldProblems(decision, DECISION_FIELDS))
  problems.push(...datedFileProblems(file, 'decisions', dateValue, '2026-10-14-bullet-fields.md'))
  return problems
}

// Log entries (spec 5.5).

/** A log entry as { file, title, date, titleLine, fields, problems }; date and title come from "# <date> · <title>". */
function parseLogEntry(path, text) {
  const parsed = titleAndFields(path, text)
  const match = parsed.title ? parsed.title.match(LOG_HEADING) : null
  return {
    file: path,
    title: match ? match[2].trim() : parsed.title,
    date: match ? match[1] : null,
    heading: parsed.title,
    titleLine: parsed.titleLine,
    fields: parsed.fields,
    problems: parsed.problems
  }
}

/** Problems with a log entry: its heading, file name and Tasks. context.taskIds is the Set of known task ids. */
function validateLogEntry(entry, context) {
  const { file } = entry
  const problems = []
  if (!entry.heading) {
    problems.push({ file, line: 1, message: 'a log entry starts with a heading: "# YYYY-MM-DD · <title>"' })
  } else if (!entry.date) {
    problems.push({ file, line: entry.titleLine, message: `the heading "${entry.heading}" is not "<YYYY-MM-DD> · <title>"; write it as "# 2026-10-14 · ${entry.heading}"` })
  } else if (!isCalendarDate(entry.date)) {
    problems.push({ file, line: entry.titleLine, message: `the date ${entry.date} does not exist in the calendar; write the real day of the entry` })
  }

  problems.push(...recordFieldNameProblems(entry, LOG_FIELDS))

  const tasks = recordField(entry, 'Tasks')
  if (tasks) {
    const known = context.taskIds ?? new Set()
    const ids = [tasks.value, ...tasks.items]
      .flatMap((value) => value.split(','))
      .map((id) => id.trim())
      .filter((id) => !isEmptyValue(id))
    for (const id of ids) {
      if (!known.has(id)) {
        problems.push({ file, line: tasks.line, message: `the task ${id} does not exist; list ids of existing tasks, comma-separated, or remove it` })
      }
    }
  }

  problems.push(...datedFileProblems(file, 'log', entry.date, '2026-10-14-storage-routes.md'))
  return problems
}

// Plans (spec 5.6).

/** The status line before a plan's first ## heading, as { value, date, by, line }, or null. date and by are null when left out. */
function planStatus(text) {
  const lines = splitLines(text)
  const firstSection = headings(text).find((heading) => heading.level === 2)
  const end = firstSection ? firstSection.line - 1 : lines.length
  for (let index = 0; index < end; index += 1) {
    const match = lines[index].match(PLAN_STATUS_LINE)
    if (!match) continue
    const [value, date, ...by] = match[1].split('·').map((part) => part.trim())
    return { value, date: date || null, by: by.join(' · ') || null, line: index + 1 }
  }
  return null
}

/** A problem when a plan's status is not exactly proposal, approved, in progress or implemented. */
function validatePlanStatus(path, status) {
  if (!status || PLAN_STATUSES.includes(status.value)) return []
  return [{
    file: path,
    line: status.line,
    message: `the plan status "${status.value}" is not one of ${PLAN_STATUSES.join(', ')}; write for example "Status: approved · 2026-10-14 · <who decided>"`
  }]
}

// The workspace README (spec 5.8).

/** The README as { file, sections, markers }: sections maps each ## heading's text to { line, body }; markers are the lines with SETUP_MARKER. */
function parseReadme(path, text) {
  const lines = splitLines(text)
  const all = headings(text)
  const sections = new Map()
  all.forEach((heading, position) => {
    if (heading.level !== 2 || sections.has(heading.text)) return
    const next = all.slice(position + 1).find((other) => other.level <= 2)
    const body = lines.slice(heading.line, next ? next.line - 1 : lines.length).join('\n').trim()
    sections.set(heading.text, { line: heading.line, body })
  })
  const markers = []
  lines.forEach((line, index) => {
    if (line.includes(SETUP_MARKER)) markers.push(index + 1)
  })
  return { file: path, sections, markers }
}

/**
 * Problems with the shape of the README: a missing required section or an empty one. Setup
 * markers are not among them, so the files `init` writes can be committed at once; whether the
 * README is written is a question for the end of a session (readmeMarkerProblems).
 */
function validateReadme(readme) {
  const { file } = readme
  const problems = []
  const names = [...readme.sections.keys()].map((name) => name.trim().toLowerCase())
  for (const required of README_SECTIONS) {
    if (!names.includes(required.toLowerCase())) {
      problems.push({ file, line: 0, message: `the README has no "## ${required}" section; add it with the project's own text` })
    }
  }
  for (const [name, section] of readme.sections) {
    if (section.body === '') {
      problems.push({ file, line: section.line, message: `the section "## ${name}" is empty; write the project's own text under it` })
    }
  }
  return problems
}

/** A problem for every setup marker left in the README. handoff asks for none; check and the hooks do not. */
function readmeMarkerProblems(readme) {
  return readme.markers.map((line) => ({
    file: readme.file,
    line,
    message: `a ${SETUP_MARKER} marker is left; write the project's own text here and remove the marker`
  }))
}

// --- tasks.mjs ---
// Task files, spec 5.3: parsed from text and validated against a context, with no file access.
// One file at a time checks the shape; the set checks unique ids, dependencies and WIP per lane.

const TASK_ID = /^[A-Z]{1,4}\d+(\.\d+)*$/
const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done', 'dropped']

/** The field names spec 5.3 defines, spelled as they are written. */
const TASK_FIELDS = ['Status', 'Lane', 'Depends on', 'Plan', 'Evidence', 'Waiting for', 'Reason', 'Issue', 'Taken over from']

// A stamp's path: <dir>/verified/<16 hex digits>.json (spec 5.7).
const TASK_STAMP_PATH = /(^|\/)verified\/[0-9a-f]{16}\.json$/
const TASK_SECTIONS = { plan: 'Plan', handoff: 'Handoff', notes: 'Notes' }
const TASK_TITLE_MAX = 100
const TASK_HANDOFF_MAX = 1500
const TASK_SLUG_MAX = 40
// Latin letters that NFKD does not split into a base letter and a mark.
const TASK_SLUG_LETTERS = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ł: 'l', þ: 'th', Æ: 'AE', Œ: 'OE', Ø: 'O', Đ: 'D', Ł: 'L', Þ: 'TH' }
const TASK_FILE_NAME = /^([A-Z]{1,4}\d+(?:\.\d+)*)(?:-[^/]+)?\.md$/
const TASK_ID_HINT = 'one to four capital letters, a number and optional .number parts, such as S4, S4.1 or API12'

/** A field's text: its value, or its nested items joined, or null when both are empty. */
function taskFieldText(field) {
  if (!field) return null
  if (!isEmptyValue(field.value)) return field.value
  const items = field.items.filter((item) => !isEmptyValue(item))
  return items.length > 0 ? items.join('; ') : null
}

/** A level-2 section's line and body: the lines up to the next heading of level 1 or 2. */
function taskSection(lines, all, name) {
  const position = all.findIndex((heading) => heading.level === 2 && heading.text === name)
  if (position === -1) return null
  const heading = all[position]
  const next = all.slice(position + 1).find((other) => other.level <= 2)
  return { line: heading.line, body: lines.slice(heading.line, next ? next.line - 1 : lines.length).join('\n') }
}

/** Whether section lines hold content: a line that is neither blank nor a heading. */
function taskHasContent(lines) {
  return lines.some((line) => line.trim() !== '' && !/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line))
}

/** Parses a task file. Problems are only what made parsing impossible; validateTask checks the rest. */
function parseTask(path, text) {
  const lines = splitLines(text)
  const all = headings(text)
  const task = {
    file: path,
    id: null,
    title: null,
    titleLine: 0,
    fields: [],
    status: null,
    lane: null,
    dependsOn: [],
    plan: null,
    evidence: null,
    waitingFor: null,
    reason: null,
    issue: null,
    takenOverFrom: null,
    sections: { plan: null, handoff: null, notes: null },
    unknownFields: [],
    links: relativeLinks(text),
    problems: []
  }
  for (const [key, name] of Object.entries(TASK_SECTIONS)) task.sections[key] = taskSection(lines, all, name)

  const heading = all.find((candidate) => candidate.level === 1)
  if (!heading) {
    task.problems.push({
      file: path,
      line: lines.length > 0 ? 1 : 0,
      message: 'the task has no heading. Start the file with "# <id> <title>", such as "# S4 Store projects and documents"'
    })
    return task
  }
  const [id, ...rest] = heading.text.split(/[ \t]+/)
  task.id = id || null
  task.title = rest.join(' ').trim()
  task.titleLine = heading.line

  const { fields } = parseFields(lines, heading.line)
  task.fields = fields
  if (fields.length === 0) {
    task.problems.push({
      file: path,
      line: heading.line,
      message: 'the task has no field list after its heading. Put the fields straight after the heading, starting with "- Status: todo"'
    })
    return task
  }

  const first = new Map()
  for (const field of fields) {
    if (!TASK_FIELDS.includes(field.name)) task.unknownFields.push({ name: field.name, line: field.line })
    else if (!first.has(field.name)) first.set(field.name, field)
  }
  task.status = taskFieldText(first.get('Status'))
  task.lane = taskFieldText(first.get('Lane'))
  task.waitingFor = taskFieldText(first.get('Waiting for'))
  task.reason = taskFieldText(first.get('Reason'))
  task.issue = taskFieldText(first.get('Issue'))
  task.takenOverFrom = taskFieldText(first.get('Taken over from'))
  const plan = first.get('Plan')
  task.plan = plan && !isEmptyValue(plan.value) ? plan.value : null
  const evidence = first.get('Evidence')
  if (evidence) task.evidence = { value: evidence.value, items: evidence.items, line: evidence.line }
  const depends = first.get('Depends on')
  if (depends) {
    task.dependsOn = [depends.value, ...depends.items]
      .flatMap((part) => part.split(','))
      .map((part) => part.trim())
      .filter((part) => !isEmptyValue(part))
  }
  return task
}

/** Whether evidence text has a command in backticks, a Markdown link or a web URL. */
function taskEvidenceIsConcrete(text) {
  return /`[^`\n]*\S[^`\n]*`/.test(text) || /\[[^\]]*\]\([^)\s]+[^)]*\)/.test(text) || /\bhttps?:\/\/\S+/.test(text)
}

/** The first field of a name, or undefined. */
function taskField(task, name) {
  return task.fields.find((field) => field.name === name)
}

/**
 * Checks one parsed task. The context is { exists, read, planStatus, taskIds, config }.
 * A task whose parse problems are not empty is not checked further: report task.problems instead.
 */
function validateTask(task, context) {
  if (task.problems.length > 0) return []
  const problems = []
  const report = (line, message) => problems.push({ file: task.file, line, message })
  const { dir } = context.config
  const headingLine = task.titleLine

  // Heading.
  const idValid = TASK_ID.test(task.id)
  if (!idValid) report(headingLine, `"${task.id}" is not a task id. Write the heading as "# <id> <title>", where the id is ${TASK_ID_HINT}`)
  if (task.title === '') report(headingLine, `the heading has no title. Write "# ${idValid ? task.id : 'S4'} <title>", such as "# ${idValid ? task.id : 'S4'} Store projects and documents"`)
  else if ([...task.title].length > TASK_TITLE_MAX)
    report(headingLine, `the title has ${[...task.title].length} characters. Shorten it to at most ${TASK_TITLE_MAX} and put the detail in a ## Plan or ## Notes section`)

  // File name.
  const folder = `${dir}/tasks/`
  const name = task.file.startsWith(folder) ? task.file.slice(folder.length) : null
  const named = name === null ? null : name.match(TASK_FILE_NAME)
  const suggestion = idValid ? taskFileName(dir, task.id, task.title) : `${folder}<id>-<slug>.md`
  if (name === null || name.includes('/')) report(0, `a task file belongs directly in ${folder}. Move it to ${suggestion}`)
  else if (!named) report(0, `the file name is not "<id>-<slug>.md" or "<id>.md". Rename it to ${suggestion}`)
  else if (idValid && named[1] !== task.id)
    report(headingLine, `the file name says ${named[1]} but the heading says ${task.id}. Rename the file to ${suggestion}, or write "# ${named[1]} ${task.title}"`)

  // Fields: duplicates and likely typos.
  const seen = new Map()
  for (const field of task.fields) {
    if (TASK_FIELDS.includes(field.name)) {
      if (seen.has(field.name)) report(field.line, `"${field.name}" appears twice (first on line ${seen.get(field.name)}). Keep one "- ${field.name}:" line`)
      else seen.set(field.name, field.line)
    }
  }
  for (const unknown of task.unknownFields) {
    const known = likelyTypo(unknown.name, TASK_FIELDS)
    if (known) report(unknown.line, `"${unknown.name}" looks like a typo. Write "- ${known}:"`)
  }

  // Status and the fields it requires.
  const status = taskField(task, 'Status')
  const statusLine = status ? status.line : headingLine
  if (!status || task.status === null) {
    report(statusLine, `the task has no status. Write "- Status: todo", or one of ${TASK_STATUSES.join(', ')}`)
  } else if (!TASK_STATUSES.includes(task.status)) {
    report(statusLine, `"${task.status}" is not a status. Write one of ${TASK_STATUSES.join(', ')}`)
  } else if (task.status === 'doing' && task.lane === null) {
    report(statusLine, 'a doing task needs a lane. Add "- Lane: <branch>" with the branch that holds the task')
  } else if (task.status === 'blocked' && task.waitingFor === null) {
    report(statusLine, 'a blocked task needs "- Waiting for: <who or what>", such as owner, a person, a task id or an outside party')
  } else if (task.status === 'dropped' && task.reason === null) {
    report(statusLine, 'a dropped task needs "- Reason: <why>", such as "split into S7.1–S7.5", "superseded by S9" or "not needed"')
  }

  // Evidence.
  const evidenceText = task.evidence ? [task.evidence.value, ...task.evidence.items].filter((part) => !isEmptyValue(part)).join('\n') : ''
  if (task.status === 'done' && evidenceText === '') {
    if (task.evidence) {
      const placeholder = task.evidence.value.trim()
      const how = placeholder === '' ? 'write after "- Evidence:"' : `replace "${placeholder}" after "- Evidence:" with`
      report(task.evidence.line, `a done task needs evidence: ${how} a command in backticks, a link or a URL, such as "\`npm test\`: 14 of 14"`)
    }
    else report(statusLine, 'a done task needs evidence. Add "- Evidence:" with a command in backticks, a link or a URL, such as "`npm test`: 14 of 14"')
  } else if (evidenceText !== '' && !taskEvidenceIsConcrete(evidenceText)) {
    report(task.evidence.line, 'evidence needs a command in backticks, a link or a URL, not only words. Write, for example, "`npm test`: 14 of 14" or a link to a file under evidence/')
  }

  // Plan.
  const planField = taskField(task, 'Plan')
  const planLine = planField ? planField.line : statusLine
  let planContent = false
  let planNote = ''
  if (task.plan !== null) {
    const link = relativeLinks(task.plan)[0]
    const path = link ? resolveLinkPath(task.file, link.path) : null
    if (!link) {
      report(planLine, `Plan must be a Markdown link to a plan section, such as "[S-server.md](../plan/S-server.md#s4-store-projects)", not "${task.plan}"`)
    } else if (path !== null && link.path !== '' && context.exists(path)) {
      // A missing file is reported with the other links below.
      const text = context.read(path)
      if (text !== null && text !== undefined) {
        if (link.anchor) {
          const section = findSection(text, link.anchor)
          if (!section) {
            const anchors = headings(text).map((heading) => `#${heading.anchor}`)
            const hint = anchors.length > 0 ? ` Link to one of its sections, such as ${anchors.slice(0, 3).join(', ')}` : ' Add the section to the plan, or link to the file without an anchor'
            report(planLine, `Plan links to #${link.anchor}, which is not a section in ${path}.${hint}`)
          } else {
            planContent = taskHasContent(section.lines)
            if (!planContent) planNote = ` The linked section #${link.anchor} in ${path} has only its heading.`
          }
        } else {
          planContent = taskHasContent(splitLines(text))
          if (!planContent) planNote = ` The linked plan ${path} is empty.`
        }
      }
      const planStatus = context.planStatus(path)
      if (task.status === 'doing' && String(planStatus?.value ?? '').toLowerCase() === 'proposal') {
        report(planLine, `the plan ${path} is a proposal, and a task cannot be doing until its plan is approved. Approve the plan first (its status line says "Status: approved"), or set this task back to todo`)
      }
    }
  }
  if (task.status === 'doing') {
    const own = task.sections.plan
    const ownContent = own !== null && taskHasContent(own.body.split('\n'))
    if (!planContent && !ownContent) {
      report(
        own && task.plan === null ? own.line : planLine,
        `a doing task needs a plan.${planNote} Link "- Plan:" to a plan section with content, or write the goal and acceptance checks in a "## Plan" section`
      )
    }
  }

  // Handoff length; whether a doing task has one is a session check, not a shape check.
  if (task.sections.handoff) {
    const length = [...task.sections.handoff.body.trim()].length
    if (length > TASK_HANDOFF_MAX)
      report(task.sections.handoff.line, `the handoff has ${length} characters. Shorten it to at most ${TASK_HANDOFF_MAX}: the state now, with the story moved to ## Notes or a log entry`)
  }

  // Every relative link resolves.
  for (const link of task.links) {
    if (link.path === '') continue
    const path = resolveLinkPath(task.file, link.path)
    if (path === null) report(link.line, `the link ${link.target} points outside the repository. Link to a file inside it`)
    else if (TASK_STAMP_PATH.test(path))
      report(link.line, `the link ${link.target} points to a stamp, which the next verify replaces, so the link would break. Name the stamp in backticks instead: \`${path.slice(path.lastIndexOf('/') + 1)}\``)
    else if (!context.exists(path)) report(link.line, `the link ${link.target} points to ${path}, which does not exist. Fix the path or add the file`)
    else if (link.anchor && path.endsWith('.md') && !(planField && link.line === planField.line)) {
      // The Plan link's anchor is checked above, with a hint; every other anchor here.
      const target = context.read(path)
      const wanted = link.anchor.toLowerCase()
      if (target !== null && !headings(target).some((heading) => heading.anchor === wanted))
        report(link.line, `the link ${link.target} points to #${link.anchor}, which is not a heading in ${path}. Fix the anchor or link to the file without it`)
    }
  }
  return problems
}

/** Checks a set of tasks together: unique ids, dependencies that exist and WIP per lane. */
function validateTaskSet(tasks, context) {
  const problems = []
  const byId = new Map()
  for (const task of tasks) {
    if (!task.id) continue
    if (!byId.has(task.id)) byId.set(task.id, [])
    byId.get(task.id).push(task)
  }
  for (const [id, same] of byId) {
    if (same.length < 2) continue
    for (const task of same) {
      const others = same.filter((other) => other !== task).map((other) => other.file)
      problems.push({ file: task.file, line: task.titleLine, message: `the id ${id} is also used by ${others.join(', ')}. Ids are unique: give one of them a new id` })
    }
  }

  for (const task of tasks) {
    const missing = task.dependsOn.filter((id) => !byId.has(id))
    if (missing.length === 0) continue
    const field = taskField(task, 'Depends on')
    for (const id of missing)
      problems.push({ file: task.file, line: field ? field.line : task.titleLine, message: `"Depends on" names ${id}, which is not a task. Write the id of an existing task, or remove it` })
  }

  const byLane = new Map()
  for (const task of tasks) {
    if (task.status !== 'doing' || task.lane === null) continue
    if (!byLane.has(task.lane)) byLane.set(task.lane, [])
    byLane.get(task.lane).push(task)
  }
  const limit = context.config.wip
  for (const [lane, doing] of byLane) {
    if (doing.length <= limit) continue
    const sorted = [...doing].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    const first = sorted[0]
    const status = taskField(first, 'Status')
    problems.push({
      file: first.file,
      line: status ? status.line : first.titleLine,
      message: `the lane ${lane} has ${doing.length} tasks doing (${sorted.map((task) => task.id).join(', ')}), more than the limit of ${limit}. Finish one or set it back to todo or blocked`
    })
  }
  return problems
}

/** A file-name slug: lowercase ASCII words joined by hyphens, at most 40 characters, or ''. */
function slugify(title) {
  const slug = title
    .replace(/[ßæœøđłþÆŒØĐŁÞ]/g, (letter) => TASK_SLUG_LETTERS[letter])
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length <= TASK_SLUG_MAX) return slug
  let cut = slug.slice(0, TASK_SLUG_MAX)
  if (slug[TASK_SLUG_MAX] !== '-') {
    const hyphen = cut.lastIndexOf('-')
    if (hyphen > 0) cut = cut.slice(0, hyphen)
  }
  return cut.replace(/-+$/, '')
}

// The device names Windows reserves, in any case and with any extension: no file can have them.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * The path of a new task file: <dir>/tasks/<id>-<slug>.md, or <dir>/tasks/<id>.md with no slug.
 * A name Windows reserves before its first dot, such as COM1.md, gets "-task" after the id.
 */
function taskFileName(dir, id, title) {
  const slug = slugify(title ?? '')
  let name = `${id}${slug ? `-${slug}` : ''}`
  if (WINDOWS_RESERVED.test(name.split('.')[0])) name = `${id}-task${slug ? `-${slug}` : ''}`
  return `${dir}/tasks/${name}.md`
}

// --- workspace.mjs ---
// The workspace as a whole: files read from the working tree, the index or a commit; every
// record loaded and checked; what counts as code (spec 5.10) and the code fingerprint (spec 5.7).

const WORKSPACE_IMAGE = /\.(avif|gif|jpe?g|png|svg|webp)$/i
const WORKSPACE_MARKDOWN = /\.(md|markdown)$/i
// Files code reads or runs: inside the workspace they count as code, not as records (spec 5.10).
const WORKSPACE_CODE = /\.(js|mjs|cjs|ts|tsx|jsx|json|ya?ml|sh|py|rb|go|rs|toml)$/i
const WORKSPACE_STAMP = /^verified\/[0-9a-f]{16}\.json$/
const WORKSPACE_RECORD_FOLDERS = ['tasks/', 'decisions/', 'log/', 'plan/']
const WORKSPACE_HOOKS = '.githooks/'
const WORKSPACE_MAX_BUFFER = 1024 * 1024 * 1024

/** Runs git in a folder and returns stdout as a Buffer; throws with git's message when it fails. */
function workspaceGit(root, args, input) {
  const result = spawnSync('git', args, { cwd: root, input, maxBuffer: WORKSPACE_MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString('utf8').trim()}`)
  return result.stdout
}

/** The NUL-separated records of git output, without the empty one at the end. */
function workspaceRecords(buffer) {
  return buffer.toString('utf8').split('\0').filter((record) => record !== '')
}

/**
 * The tracked entries of the index or a commit, as [{ mode, oid, path }] sorted by path.
 * The index comes from `git ls-files -s`, a commit from `git ls-tree -r`.
 */
function workspaceEntries(root, source) {
  const entries = []
  if (source.kind === 'index') {
    for (const record of workspaceRecords(workspaceGit(root, ['ls-files', '-s', '-z']))) {
      const tab = record.indexOf('\t')
      const [mode, oid] = record.slice(0, tab).split(' ')
      entries.push({ mode, oid, path: record.slice(tab + 1) })
    }
  } else if (source.kind === 'commit') {
    if (typeof source.rev !== 'string' || source.rev === '') throw new Error('a commit source needs a rev, such as HEAD')
    for (const record of workspaceRecords(workspaceGit(root, ['ls-tree', '-r', '-z', `${source.rev}^{tree}`, '--']))) {
      const tab = record.indexOf('\t')
      const [mode, , oid] = record.slice(0, tab).split(' ')
      entries.push({ mode, oid, path: record.slice(tab + 1) })
    }
  } else {
    throw new Error(`unknown source kind ${JSON.stringify(source.kind)}; use index or commit`)
  }
  return entries
}

/** Reads blobs in one `git cat-file --batch`, as a Map from object id to text. */
function workspaceBlobs(root, oids) {
  const texts = new Map()
  if (oids.length === 0) return texts
  const output = workspaceGit(root, ['cat-file', '--batch'], `${oids.join('\n')}\n`)
  let at = 0
  while (at < output.length) {
    const end = output.indexOf(10, at)
    if (end === -1) break
    const header = output.toString('utf8', at, end).split(' ')
    at = end + 1
    if (header[1] === 'missing' || header.length < 3) continue
    const size = Number(header[2])
    texts.set(header[0], output.toString('utf8', at, at + size))
    at += size + 1
  }
  return texts
}

/** A path in the form the reader keys on: POSIX, with no leading ./ and no trailing slash. */
function workspaceKey(path) {
  return String(path).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '')
}

/**
 * Reads files from one source, with repository-relative POSIX paths:
 * { kind: 'worktree' } (the files on disk that git tracks or would add), { kind: 'index' }
 * (the staged content) or { kind: 'commit', rev }. An optional `root` names the repository;
 * by default it is the repository of the current folder.
 *
 * Returns { list(prefix), read(path), exists(path), mode(path) }. list(prefix) gives the sorted
 * file paths in a folder, at any depth ('' for all). read gives a file's text, or null when it is
 * missing. exists is true for a file and for a folder that holds at least one file. mode gives
 * git's mode of a file in the index or a commit, such as '100755', or null (always in the
 * working tree).
 */
function treeReader(source) {
  const root = source.root ?? repositoryRoot()
  let files = null // Map of path → object id (null in the working tree)
  const modes = new Map() // path → git's mode, in the index or a commit
  let folders = null
  const texts = new Map()

  const listing = () => {
    if (files !== null) return files
    files = new Map()
    if (source.kind === 'worktree') {
      const deleted = new Set(workspaceRecords(workspaceGit(root, ['ls-files', '-z', '--deleted'])))
      for (const path of workspaceRecords(workspaceGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']))) {
        if (!deleted.has(path)) files.set(path, null)
      }
    } else {
      // In a merge conflict the index holds several stages of a path; the first one stands for it.
      for (const entry of workspaceEntries(root, source)) {
        if (files.has(entry.path)) continue
        files.set(entry.path, entry.oid)
        modes.set(entry.path, entry.mode)
      }
    }
    files = new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    folders = new Set([''])
    for (const path of files.keys()) {
      for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) folders.add(path.slice(0, slash))
    }
    return files
  }

  const fetchBlobs = (wanted) => {
    // One batch for the file asked for and, the first time, every Markdown file: the records.
    const paths = texts.size === 0 ? [...files.keys()].filter((path) => WORKSPACE_MARKDOWN.test(path) || path === wanted) : [wanted]
    const pending = paths.filter((path) => !texts.has(path))
    const blobs = workspaceBlobs(root, [...new Set(pending.map((path) => files.get(path)))])
    for (const path of pending) texts.set(path, blobs.get(files.get(path)) ?? null)
  }

  return {
    list(prefix = '') {
      const folder = workspaceKey(prefix)
      const start = folder === '' ? '' : `${folder}/`
      return [...listing().keys()].filter((path) => path.startsWith(start))
    },
    read(path) {
      const key = workspaceKey(path)
      if (!listing().has(key)) return null
      if (texts.has(key)) return texts.get(key)
      if (source.kind === 'worktree') {
        let text = null
        try {
          text = readFileSync(join(root, key), 'utf8')
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) throw error
        }
        texts.set(key, text)
        return text
      }
      fetchBlobs(key)
      return texts.get(key)
    },
    exists(path) {
      const key = workspaceKey(path)
      return listing().has(key) || folders.has(key)
    },
    mode(path) {
      const key = workspaceKey(path)
      listing()
      return modes.get(key) ?? null
    }
  }
}

/** The paths of the Markdown files directly in a folder. */
function workspaceMarkdownIn(reader, folder) {
  return reader.list(folder).filter((path) => WORKSPACE_MARKDOWN.test(path) && !path.slice(folder.length + 1).includes('/'))
}

/**
 * Loads every record of the workspace from a reader:
 * { dir, tasks, decisions, logs, plans, readme, problems }. plans is a Map from each plan
 * file's path to its status line or null; problems are the parse problems of every record.
 */
function loadWorkspace(reader, config) {
  const { dir } = config
  const problems = []
  const parsed = (folder, parse) =>
    workspaceMarkdownIn(reader, `${dir}/${folder}`).map((path) => {
      const record = parse(path, reader.read(path) ?? '')
      problems.push(...record.problems)
      return record
    })
  const tasks = parsed('tasks', parseTask)
  const decisions = parsed('decisions', parseDecision)
  const logs = parsed('log', parseLogEntry)
  // A record in a subfolder is never read, so it would be lost without a word.
  for (const folder of ['tasks', 'decisions', 'log']) {
    const root = `${dir}/${folder}/`
    for (const path of reader.list(`${dir}/${folder}`)) {
      if (!WORKSPACE_MARKDOWN.test(path) || !path.slice(root.length).includes('/')) continue
      problems.push({ file: path, line: 0, message: `a record belongs directly in ${root}, where it is read; move it to ${root}${path.slice(path.lastIndexOf('/') + 1)}` })
    }
  }
  const plans = new Map()
  for (const path of reader.list(`${dir}/plan`)) {
    if (WORKSPACE_MARKDOWN.test(path)) plans.set(path, planStatus(reader.read(path) ?? ''))
  }
  const readmeText = reader.read(`${dir}/README.md`)
  const readme = readmeText === null ? null : parseReadme(`${dir}/README.md`, readmeText)
  return { dir, tasks, decisions, logs, plans, readme, problems }
}

/** Sorts problems by file, then by line, keeping the order of equal ones. */
function workspaceSortProblems(problems) {
  return problems.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
}

/**
 * Every problem in a loaded workspace: its parse problems and every validation problem,
 * sorted by file and line. The reader answers which linked files exist in the same source.
 */
function checkWorkspace(workspace, reader, config) {
  const planStatuses = new Map(workspace.plans)
  const context = {
    exists: (path) => reader.exists(path),
    read: (path) => reader.read(path),
    planStatus: (path) => {
      // A plan outside plan/ is read when a task links to it.
      if (!planStatuses.has(path)) {
        const text = WORKSPACE_MARKDOWN.test(path) ? reader.read(path) : null
        planStatuses.set(path, text === null ? null : planStatus(text))
      }
      return planStatuses.get(path)
    },
    taskIds: new Set(workspace.tasks.map((task) => task.id).filter((id) => id)),
    config
  }
  const problems = [...workspace.problems]
  for (const task of workspace.tasks) problems.push(...validateTask(task, context))
  problems.push(...validateTaskSet(workspace.tasks, context))
  for (const decision of workspace.decisions) problems.push(...validateDecision(decision, context))
  for (const entry of workspace.logs) problems.push(...validateLogEntry(entry, context))
  for (const [path, status] of workspace.plans) problems.push(...validatePlanStatus(path, status))
  if (workspace.readme === null) {
    problems.push({
      file: `${workspace.dir}/README.md`,
      line: 0,
      message: 'the workspace README is missing. Add it with "## Goal", "## Environments" and "## Manual checks" sections'
    })
  } else problems.push(...validateReadme(workspace.readme))
  return workspaceSortProblems(problems)
}

/**
 * Whether a repository-relative path is code (spec 5.10): every file outside the workspace that
 * is not Markdown, plus, inside the workspace, scripts/, the codePaths except images there, and
 * every file with a code extension (such as .js, .json or .sh) other than a stamp in verified/
 * or a file under tasks/, decisions/, log/ or plan/. Also the git hooks and the configuration.
 * Records and documentation are not code.
 */
function isCode(path, config) {
  const key = workspaceKey(path)
  const workspace = `${config.dir}/`
  if (key === CONFIG_FILE || key.startsWith(WORKSPACE_HOOKS)) return true
  if (key.startsWith(workspace)) {
    const inside = key.slice(workspace.length)
    if (inside.startsWith('scripts/')) return true
    if (config.codePaths.some((codePath) => inside.startsWith(`${codePath}/`))) return !WORKSPACE_IMAGE.test(key)
    if (WORKSPACE_STAMP.test(inside) || WORKSPACE_RECORD_FOLDERS.some((folder) => inside.startsWith(folder))) return false
    return WORKSPACE_CODE.test(key)
  }
  return !WORKSPACE_MARKDOWN.test(key)
}

/**
 * The code fingerprint of the index ({ kind: 'index' }) or a commit ({ kind: 'commit', rev }):
 * a SHA-1 hex digest over the sorted "<mode> <oid> <path>" lines of its code files. Only
 * git's object ids enter it, so line endings in the working tree do not change it.
 */
function fingerprint(source, config) {
  const root = source.root ?? repositoryRoot()
  const lines = workspaceEntries(root, source)
    .filter((entry) => isCode(entry.path, config))
    .map((entry) => `${entry.mode} ${entry.oid} ${entry.path}`)
    .sort()
  return createHash('sha1').update(lines.map((line) => `${line}\n`).join('')).digest('hex')
}

/** The current branch of a repository, or null in a detached HEAD. */
function workspaceCurrentBranch(root) {
  const result = spawnSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return result.status === 0 && result.stdout.trim() !== '' ? result.stdout.trim() : null
}

/**
 * check [--index | --rev <rev>] [--range <from>..<to>]: validates every record and exits 1 when
 * there is a problem. With --range it then checks that every commit in the range is recorded
 * (spec 5.9), with the current branch as the lane, or no lane in a detached HEAD. The caller
 * passes the range check in, as checkRange from range.mjs, which itself imports this module.
 */
function checkCommand(args, rangeCheck = null) {
  let source = { kind: 'worktree' }
  let range = null
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--index') source = { kind: 'index' }
    else if (arg === '--rev') {
      if (!args[index + 1]) fail('--rev needs a revision, such as --rev HEAD')
      source = { kind: 'commit', rev: args[index + 1] }
      index += 1
    } else if (arg === '--range') {
      const value = args[index + 1] ?? ''
      const at = value.indexOf('..')
      if (at <= 0 || value.includes('...')) fail('--range needs two revisions, such as --range origin/main..HEAD')
      range = { from: value.slice(0, at), to: value.slice(at + 2) || 'HEAD' }
      index += 1
    } else fail(`unknown option "${arg}" for check; use --index, --rev <rev> or --range <from>..<to>`)
  }
  if (range !== null && typeof rangeCheck !== 'function') fail('--range is not available in this build')
  let root
  let reader
  try {
    root = repositoryRoot()
    reader = treeReader({ ...source, root })
  } catch {
    fail('not inside a git repository')
  }
  let problems
  let workspace
  let config = null
  try {
    // The configuration comes from the same source as the records, so an old commit is checked by its own rules.
    const loaded = loadConfig(reader)
    problems = loaded.problems
    config = loaded.config
    if (config) {
      workspace = loadWorkspace(reader, config)
      problems = checkWorkspace(workspace, reader, config)
    }
  } catch (error) {
    fail(error.message)
  }
  if (problems.length > 0) {
    for (const { file, line, message } of problems) console.error(`✖ ${file}${line ? `:${line}` : ''}: ${message}`)
    process.exit(1)
  }
  console.log(`✔ records valid: ${recordCounts(workspace.tasks.length, workspace.decisions.length, workspace.logs.length)}`)
  for (const { file, message } of unknownKeyNotices(config)) console.log(`! ${file}: ${message}`)
  if (range === null) return
  const lane = workspaceCurrentBranch(root)
  let rangeProblems
  try {
    rangeProblems = rangeCheck(range.from, range.to, { config, lane, skipGitHubMerges: false, root })
  } catch (error) {
    fail(error.message)
  }
  if (rangeProblems.length > 0) {
    for (const { file, message } of rangeProblems) console.error(`✖ ${file}: ${message}`)
    process.exit(1)
  }
  console.log(`✔ commits recorded: ${range.from}..${range.to}${lane === null ? ' (detached HEAD: no lane rule)' : ` (lane ${lane})`}`)
}

// --- gates.mjs ---
// The quality gates and their stamps (spec 5.7): running the gate commands, and the
// content-addressed record that they passed on exactly the committed code.

const GATES_OUTPUT_LINES = 80
const GATES_STAMP_VERSION = 1
const GATES_SHOWN_PATHS = 5
const GATES_STAMP_NAME = /^[0-9a-f]{16}\.json$/

/**
 * Runs each command through the shell (sh, or cmd.exe on Windows) from the repository root,
 * in order, and stops at the first failure. A pass prints one line; a failure prints the last
 * 80 lines of the command's combined output. options.env, when given, is the commands'
 * whole environment. Never exits: returns
 * { passed: [{ command, seconds }], failure: { command, status, output } | null }.
 */
function runGates(commands, options = {}) {
  const root = options.root ?? repositoryRoot()
  const passed = []
  for (const command of commands) {
    const started = Date.now()
    // stdout and stderr share one file, so the output keeps the order the command wrote it in.
    const folder = mkdtempSync(join(tmpdir(), 'resaledger-gate-'))
    const file = join(folder, 'output')
    let result
    let output
    try {
      const descriptor = openSync(file, 'w')
      try {
        result = spawnSync(command, { cwd: root, env: options.env ?? process.env, shell: true, stdio: ['ignore', descriptor, descriptor], windowsHide: true })
      } finally {
        closeSync(descriptor)
      }
      output = readFileSync(file, 'utf8')
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
    const seconds = Math.round((Date.now() - started) / 100) / 10
    if (result.error || result.status !== 0) {
      if (result.error) output += `${output === '' || output.endsWith('\n') ? '' : '\n'}${result.error.message}\n`
      const status = result.status ?? result.signal ?? 1
      const lines = output.replace(/\s+$/, '').split(/\r?\n/)
      if (lines.length > GATES_OUTPUT_LINES) console.error(`… ${lines.length - GATES_OUTPUT_LINES} lines above`)
      if (output.trim() !== '') console.error(lines.slice(-GATES_OUTPUT_LINES).join('\n'))
      console.error(`✖ ${command} exited with ${status}`)
      return { passed, failure: { command, status, output } }
    }
    console.log(`✔ ${command} (${seconds} s)`)
    passed.push({ command, seconds })
  }
  return { passed, failure: null }
}

/** The repository-relative path of the stamp for a fingerprint: <dir>/verified/<first 16 hex>.json. */
function stampPath(config, fingerprint) {
  return `${config.dir}/verified/${fingerprint.slice(0, 16)}.json`
}

/** The gates of a stamp: a SHA-256 hex digest of the fingerprint and the gate commands, one per line. */
function gatesDigest(fingerprint, gates) {
  return createHash('sha256').update([fingerprint, ...gates].join('\n')).digest('hex')
}

/**
 * The exact text of a stamp: no time, durations or names, so equal code gives equal bytes.
 * Its content must depend on the fingerprint almost everywhere. Otherwise git's rename detection
 * pairs a stamp that a branch deletes with the one it adds, and two branches that both prune the
 * same stamp conflict (rename/rename) when they merge.
 */
function gatesStampText(fingerprint, gates) {
  return `${JSON.stringify({ version: GATES_STAMP_VERSION, fingerprint, gates: gatesDigest(fingerprint, gates) }, null, 2)}\n`
}

/**
 * The parsed stamp for a fingerprint in the reader's source, or null when the file is missing,
 * is not valid JSON, names another full fingerprint or was written for other gates than the
 * configured ones. A stamp is a claim, not a proof (spec 12).
 */
function verifiedStamp(reader, config, fingerprint) {
  const text = reader.read(stampPath(config, fingerprint))
  if (text === null || text === undefined) return null
  let stamp
  try {
    stamp = JSON.parse(text)
  } catch {
    return null
  }
  if (stamp === null || typeof stamp !== 'object' || stamp.fingerprint !== fingerprint) return null
  if (stamp.gates !== gatesDigest(fingerprint, gatesConfigured(config))) return null
  return stamp
}

/** Every configured gate: the commit gates, then the verify gates. */
function gatesConfigured(config) {
  return [...config.gates.commit, ...config.gates.verify]
}

/** The configuration from the working tree of the repository, or a refusal. */
function gatesLoadConfig(root) {
  const { config, problems } = loadConfig(treeReader({ kind: 'worktree', root }))
  if (!config) {
    for (const { file, line, message } of problems) console.error(`✖ ${file}${line ? `:${line}` : ''}: ${message}`)
    process.exit(1)
  }
  return config
}

/** The code paths with staged, unstaged or untracked changes, in git's order. */
function gatesUncommittedCode(root, config) {
  // Not util's git(): its trim would cut the leading space of the first status code.
  const result = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) fail(`git status failed: ${result.stderr.trim()}`)
  const records = result.stdout.split('\0')
  const paths = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.length < 4) continue
    const state = record.slice(0, 2)
    paths.push(record.slice(3))
    // A rename or copy in the index is followed by its original path, which changed too.
    if (state[0] === 'R' || state[0] === 'C') {
      index += 1
      if (records[index]) paths.push(records[index])
    }
  }
  return [...new Set(paths)].filter((path) => isCode(path, config))
}

/**
 * The tracked code paths whose working-tree changes git hides: marked skip-worktree (tag S in
 * `git ls-files -v`) or assume-unchanged (a lowercase tag). git status shows no change for them,
 * so the gates could run on code that differs from the commit the stamp names.
 */
function gatesHiddenCode(root, config) {
  const result = spawnSync('git', ['ls-files', '-v', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) fail(`git ls-files failed: ${result.stderr.trim()}`)
  const paths = []
  for (const record of result.stdout.split('\0')) {
    if (record.length < 3) continue
    const tag = record[0]
    if ((tag === 'S' || (tag >= 'a' && tag <= 'z')) && isCode(record.slice(2), config)) paths.push(record.slice(2))
  }
  return [...new Set(paths)]
}

/** The first five paths, and how many more there are. */
function gatesShown(paths) {
  const shown = paths.slice(0, GATES_SHOWN_PATHS).join(', ')
  return paths.length > GATES_SHOWN_PATHS ? `${shown} and ${paths.length - GATES_SHOWN_PATHS} more` : shown
}

/**
 * verify [--force]: runs the commit gates, then the verify gates, on the committed code and
 * writes the stamp for its fingerprint, deleting every other stamp. When the stamp already
 * exists with the same gates, runs nothing; --force runs the gates anyway.
 */
function verifyCommand(args = []) {
  let force = false
  for (const arg of args) {
    if (arg === '--force') force = true
    else fail(`unknown option "${arg}" for verify; use --force`)
  }
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }
  const config = gatesLoadConfig(root)
  const gates = gatesConfigured(config)
  if (gates.length === 0) {
    console.log('No gates are configured in .resaledger.json, so there is nothing to verify.')
    return
  }

  const uncommitted = gatesUncommittedCode(root, config)
  if (uncommitted.length > 0) {
    fail(`uncommitted code: ${gatesShown(uncommitted)}. Commit it first: the gates run on the committed code, and the stamp names it`)
  }
  const hidden = gatesHiddenCode(root, config)
  if (hidden.length > 0) {
    fail(
      `git hides working-tree changes to code: ${gatesShown(hidden)} ${hidden.length === 1 ? 'is' : 'are'} marked skip-worktree or assume-unchanged, so the gates could run on code the stamp does not name. Undo it with "git update-index --no-skip-worktree --no-assume-unchanged <path>" (or "git sparse-checkout disable" in a sparse checkout), commit any change it reveals, and run verify again`
    )
  }

  let code
  try {
    code = fingerprint({ kind: 'commit', rev: 'HEAD', root }, config)
  } catch {
    fail('there is no commit to verify yet; commit the code first')
  }
  const path = stampPath(config, code)
  const existing = verifiedStamp(treeReader({ kind: 'worktree', root }), config, code)
  if (existing !== null && !force) {
    console.log(`✔ this code is already verified: ${path}. Run "verify --force" to run the gates again.`)
    return
  }

  const { passed, failure } = runGates(gates, { root })
  if (failure) {
    console.error(`✖ a gate failed, so no stamp was written. Fix the code; a gate is never weakened to make it pass`)
    process.exit(1)
  }

  const folder = join(root, config.dir, 'verified')
  mkdirSync(folder, { recursive: true })
  const name = path.slice(path.lastIndexOf('/') + 1)
  writeFileSync(join(folder, name), gatesStampText(code, gates))
  // Only regular files named like a stamp are stamps; anything else in verified/ is left alone.
  const pruned = readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && GATES_STAMP_NAME.test(entry.name) && entry.name !== name)
    .map((entry) => entry.name)
  for (const entry of pruned) {
    try {
      unlinkSync(join(folder, entry))
    } catch (error) {
      fail(`wrote ${path}, but could not remove the old stamp ${config.dir}/verified/${entry} (${error.code ?? error.message}). Delete it yourself, then commit the stamps with the records`)
    }
  }
  const removed = pruned.length > 0 ? `, removed ${plural(pruned.length, 'old stamp')}` : ''
  console.log(`✔ ${passed.length === 1 ? 'the gate' : `all ${passed.length} gates`} passed: wrote ${path}${removed}. Commit it with the records.`)
}

/** gates: lists the commit gates and the verify gates. */
function gatesCommand() {
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }
  const config = gatesLoadConfig(root)
  const print = (title, commands) => {
    console.log(title)
    if (commands.length === 0) console.log('  none')
    for (const command of commands) console.log(`  ${command}`)
  }
  print('Commit gates (pre-commit runs them on every commit that changes code):', config.gates.commit)
  print('Verify gates ("verify" runs them after the commit gates):', config.gates.verify)
}

// --- ids.mjs ---
// Task ids across branches (spec 6.7): which ids every branch in the clone has, read in one
// batch, and the ids a change adds that another branch already has as a different task.

const IDS_MAX_BUFFER = 1024 * 1024 * 1024
// A task file's name carries its id; the records check holds the heading to it.
const IDS_FILE_NAME = /^([A-Z]{1,4}\d+(?:\.\d+)*)(?:-[^/]+)?\.md$/

/** Runs git in a folder and returns stdout as a Buffer; throws with git's message when it fails. */
function idsGit(root, args, input) {
  const result = spawnSync('git', args, { cwd: root, input, maxBuffer: IDS_MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString('utf8').trim()}`)
  return result.stdout
}

/** The file names in a raw tree object (blobs only). */
function idsTreeNames(data, hashBytes) {
  const names = []
  let at = 0
  while (at < data.length) {
    const space = data.indexOf(32, at)
    const nul = data.indexOf(0, space)
    if (space === -1 || nul === -1) break
    const mode = data.toString('utf8', at, space)
    if (!mode.startsWith('40')) names.push(data.toString('utf8', space + 1, nul))
    at = nul + 1 + hashBytes
  }
  return names
}

/**
 * The file names directly in one folder on every branch in the clone, local (refs/heads) and
 * remote-tracking (refs/remotes), from one `git for-each-ref` and one `git cat-file --batch`.
 * Symbolic refs such as origin/HEAD are skipped.
 *
 * options is { root, folder, exclude }: the repository, the repository-relative folder, and an
 * optional exclude({ ref, branch, commit }) that leaves a branch out.
 *
 * Returns [{ ref, branch, commit, names }], where branch is the short name (origin/S4-x) and
 * names are the files' names (blobs only, no subfolders). A branch without the folder has none.
 */
function branchFolderNames(options) {
  const { root, folder } = options
  const exclude = options.exclude ?? (() => false)
  const branches = []
  const output = idsGit(root, ['for-each-ref', '--format=%(objectname)%00%(objecttype)%00%(refname)%00%(refname:short)%00%(symref)', 'refs/heads/', 'refs/remotes/'])
  for (const line of output.toString('utf8').split('\n')) {
    if (line === '') continue
    const [commit, type, ref, branch, symref] = line.split('\0')
    if (type !== 'commit' || symref !== '') continue
    const entry = { ref, branch, commit, names: [] }
    if (!exclude(entry)) branches.push(entry)
  }
  if (branches.length === 0) return branches

  const commits = [...new Set(branches.map((entry) => entry.commit))]
  const batch = idsGit(root, ['cat-file', '--batch'], `${commits.map((commit) => `${commit}:${folder}`).join('\n')}\n`)
  const hashBytes = commits[0].length / 2
  const namesOf = new Map()
  let at = 0
  for (const commit of commits) {
    const end = batch.indexOf(10, at)
    if (end === -1) break
    const header = batch.toString('utf8', at, end).split(' ')
    at = end + 1
    if (header.length < 3) continue // missing or ambiguous: no such folder
    const size = Number(header[2])
    namesOf.set(commit, header[1] === 'tree' ? idsTreeNames(batch.subarray(at, at + size), hashBytes) : [])
    at += size + 1
  }
  for (const entry of branches) entry.names = namesOf.get(entry.commit) ?? []
  return branches
}

/**
 * The task files of every branch in the clone, local and remote-tracking, read as
 * branchFolderNames reads them, without reading any task file: the id comes from the file name.
 *
 * options is { root, dir, exclude }: the repository, the workspace folder, and an optional
 * exclude({ ref, branch, commit }) that leaves a branch out.
 *
 * Returns [{ ref, branch, commit, files }], where files is a Map from id to the task file's
 * repository path. A branch without a tasks folder has an empty Map.
 */
function branchTaskFiles(options) {
  const folder = `${options.dir}/tasks`
  return branchFolderNames({ root: options.root, folder, exclude: options.exclude }).map(({ ref, branch, commit, names }) => {
    const files = new Map()
    for (const name of names) {
      const named = name.match(IDS_FILE_NAME)
      if (named && !files.has(named[1])) files.set(named[1], `${folder}/${name}`)
    }
    return { ref, branch, commit, files }
  })
}

/**
 * The id collisions of a change (spec 6.7): each id the change adds that another branch has in
 * a different file. The same path is the same task, which the ownership rules cover.
 *
 * added is [{ id, file }], the tasks the change adds (not in its "before" tree). others is
 * [{ branch, files, worktree? }], files a Map from id to path; worktree marks a branch read from
 * another worktree's disk. Returns problems on the added file, one per id and other file.
 */
function idCollisions(added, others, config) {
  const guard = `node ${config.dir}/scripts/records.mjs`
  const problems = []
  const seen = new Set()
  for (const { id, file } of added) {
    for (const other of others) {
      const theirs = other.files.get(id)
      if (theirs === undefined || theirs === file) continue
      const key = `${id}\0${other.branch}\0${theirs}`
      if (seen.has(key)) continue
      seen.add(key)
      const where = other.worktree ? `the worktree of branch "${other.branch}"` : `branch "${other.branch}"`
      problems.push({
        file,
        line: 0,
        message: `task ${id} is new here, but ${where} already has ${id} in ${theirs}. Rename this task's file and id to a free one; "${guard} new" takes the next free number`
      })
    }
  }
  return problems
}

// --- lanes.mjs ---
// Lanes (spec 6.1 and 6.4): the current branch, the local branches and the other worktrees
// of this repository, each with the task files it holds on disk, and the pushed branches not
// yet merged into the base, each with the task files that differ from the base's.
//
// A lane is { branch, path?, source, tasks, lastCommit? }. source is 'this' for the current
// worktree, 'worktree' for another local one and 'remote' for a remote-tracking branch.

const LANES_MARKDOWN = /\.(md|markdown)$/i

/** The current branch name, or null in a detached HEAD or outside a repository. */
function currentLane() {
  try {
    return git('symbolic-ref', '--short', '-q', 'HEAD') || null
  } catch {
    return null
  }
}

/**
 * The local branches, as a Map from branch name to the last commit's { author, date }
 * (date in strict ISO 8601). A branch with no commit yet, such as main in a new repository,
 * is not in it.
 */
function localBranches() {
  const branches = new Map()
  let output = ''
  try {
    output = git('for-each-ref', '--format=%(refname:short)%00%(authorname)%00%(authordate:iso-strict)', 'refs/heads/')
  } catch {
    return branches
  }
  for (const line of output.split('\n')) {
    if (line === '') continue
    const [branch, author, date] = line.split('\0')
    branches.set(branch, { author, date })
  }
  return branches
}

/** The parsed task files directly in <dir>/tasks of a reader. */
function laneTasks(reader, dir) {
  const folder = `${dir}/tasks`
  return reader
    .list(folder)
    .filter((path) => LANES_MARKDOWN.test(path) && !path.slice(folder.length + 1).includes('/'))
    .map((path) => parseTask(path, reader.read(path) ?? ''))
}

/** A folder's real path for comparison, or null when it does not exist. */
function lanesRealPath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

/**
 * A reader of the task files in a worktree's <dir>/tasks folder, straight from disk: no git
 * call, so it is fast, and git's hook variables (GIT_INDEX_FILE, GIT_DIR) cannot point it at
 * this worktree's index. Only the files directly in that folder are listed.
 */
function lanesTasksReader(root, dir) {
  const folder = `${dir}/tasks`
  return {
    list() {
      try {
        return readdirSync(join(root, folder), { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => `${folder}/${entry.name}`)
          .sort()
      } catch {
        return []
      }
    },
    read(path) {
      try {
        return readFileSync(join(root, path), 'utf8')
      } catch {
        return null
      }
    }
  }
}

/** The worktrees from `git worktree list --porcelain`, as [{ path, branch, bare, detached, prunable }]. */
function lanesWorktrees() {
  const worktrees = []
  let current = null
  for (const line of git('worktree', 'list', '--porcelain').split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null, bare: false, detached: false, prunable: false }
      worktrees.push(current)
    } else if (current === null) continue
    else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    else if (line === 'bare') current.bare = true
    else if (line === 'detached') current.detached = true
    else if (line.startsWith('prunable')) current.prunable = true
  }
  return worktrees
}

/**
 * The other worktrees of this repository as lanes: [{ branch, path, source: 'worktree', tasks,
 * lastCommit }]. Task files are read from each worktree's disk, so an uncommitted claim shows.
 * Only each worktree's <dir>/tasks folder is read, from disk, so this is fast and safe inside a
 * hook. Bare and detached worktrees, the current one and worktrees whose folder is gone are
 * skipped. The lanes are sorted by branch name.
 * `branches` is localBranches(), passed in when the caller already has it.
 */
function localLanes(config, branches = localBranches()) {
  const here = lanesRealPath(repositoryRoot())
  const lanes = []
  for (const worktree of lanesWorktrees()) {
    if (worktree.bare || worktree.detached || worktree.prunable || worktree.branch === null) continue
    if (!existsSync(worktree.path)) continue
    const real = lanesRealPath(worktree.path)
    if (real === null || real === here) continue
    const tasks = laneTasks(lanesTasksReader(worktree.path, config.dir), config.dir)
    const lane = { branch: worktree.branch, path: worktree.path, source: 'worktree', tasks }
    if (branches.has(worktree.branch)) lane.lastCommit = branches.get(worktree.branch)
    lanes.push(lane)
  }
  return lanes.sort((a, b) => (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0))
}

const LANES_MAX_BUFFER = 1024 * 1024 * 1024

/** Runs git in a folder and returns stdout as a Buffer; throws with git's message when it fails. */
function lanesGit(root, args, input) {
  const result = spawnSync('git', args, { cwd: root, input, maxBuffer: LANES_MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString('utf8').trim()}`)
  return result.stdout
}

/** The remotes of a repository, by name. */
function lanesRemotes(root) {
  return lanesGit(root, ['remote']).toString('utf8').split('\n').filter((name) => name !== '')
}

/**
 * The remote that fetching and the base default to: the base branch's configured remote,
 * else origin, else the first remote; null when there is none.
 */
function defaultRemote(root, base) {
  const remotes = lanesRemotes(root)
  if (remotes.length === 0) return null
  const configured = spawnSync('git', ['config', '--get', `branch.${base}.remote`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const named = configured.status === 0 ? configured.stdout.trim() : ''
  if (remotes.includes(named)) return named
  return remotes.includes('origin') ? 'origin' : remotes[0]
}

/**
 * Objects read in one `git cat-file --batch`, in the order asked: each is { oid, type, data }
 * with data a Buffer, or null when the object is missing.
 */
function lanesBatch(root, names) {
  if (names.length === 0) return []
  const output = lanesGit(root, ['cat-file', '--batch'], `${names.join('\n')}\n`)
  const objects = []
  let at = 0
  for (let index = 0; index < names.length; index += 1) {
    const end = output.indexOf(10, at)
    if (end === -1) break
    const header = output.toString('utf8', at, end).split(' ')
    at = end + 1
    if (header.length < 3) {
      objects.push(null) // missing or ambiguous
      continue
    }
    const size = Number(header[2])
    objects.push({ oid: header[0], type: header[1], data: output.subarray(at, at + size) })
    at += size + 1
  }
  return objects
}

/** The Markdown files of a raw tree object, as a Map from file name to blob id (hex). */
function lanesTreeFiles(data, hashBytes) {
  const files = new Map()
  let at = 0
  while (at < data.length) {
    const space = data.indexOf(32, at)
    const nul = data.indexOf(0, space)
    if (space === -1 || nul === -1) break
    const mode = data.toString('utf8', at, space)
    const name = data.toString('utf8', space + 1, nul)
    if (!mode.startsWith('40') && LANES_MARKDOWN.test(name)) files.set(name, data.toString('hex', nul + 1, nul + 1 + hashBytes))
    at = nul + 1 + hashBytes
  }
  return files
}

/**
 * The commits each head has that the base does not, as a Map from head to count, from one
 * `git rev-list --parents`: the fallback for git before 2.41, which has no ahead-behind atom.
 */
function lanesAheadCounts(root, baseRef, heads) {
  const counts = new Map()
  if (heads.length === 0) return counts
  const parents = new Map()
  const listed = lanesGit(root, ['rev-list', '--parents', '--stdin'], `${heads.join('\n')}\n^${baseRef}\n`)
  for (const line of listed.toString('utf8').split('\n')) {
    if (line === '') continue
    const [commit, ...rest] = line.split(' ')
    parents.set(commit, rest)
  }
  for (const head of heads) {
    // Every commit the walk lists is not in the base; a parent it does not list is.
    const seen = new Set()
    const stack = parents.has(head) ? [head] : []
    while (stack.length > 0) {
      const commit = stack.pop()
      if (seen.has(commit)) continue
      seen.add(commit)
      for (const parent of parents.get(commit)) if (parents.has(parent) && !seen.has(parent)) stack.push(parent)
    }
    counts.set(head, seen.size)
  }
  return counts
}

/** Whether a ref exists. */
function lanesRefExists(root, ref) {
  return spawnSync('git', ['rev-parse', '--verify', '-q', `${ref}^{commit}`], { cwd: root, stdio: 'ignore' }).status === 0
}

/**
 * The pushed lanes (spec 6.4): the remote-tracking branches, as last fetched, that are not
 * merged into the base, newest first. The base is the default remote's base branch when it
 * exists, else the local one. The symbolic HEAD and each remote's base branch are left out, and
 * a branch name on several remotes is one lane, the default remote's.
 *
 * Only the task files that differ from the base's are read: each branch's tasks folder in one
 * `git cat-file --batch`, the blob ids compared with the base's, and the differing blobs in a
 * second batch. A task identical to the base's is the base's own task, not that lane's claim.
 *
 * options is { root, config, local }: local is the set of branch names that are lanes on this
 * machine (this worktree and the other worktrees). A pushed branch with such a name is not a
 * remote lane; it is named in `pushed` instead.
 *
 * Returns { base, remote, lanes, baseTasks, pushed, live, branches }:
 * - base: the ref merged is measured against, such as 'origin/main', or null when none exists;
 * - lanes: [{ branch, source: 'remote', remote, ref, commit, tasks, lastCommit, ahead, verification }],
 *   ahead the commits ahead of the base (null without a base) and verification 'verified',
 *   'unverified', 'no-gates' or null (computed only for lanes that change a task);
 * - baseTasks: the base's parsed task files;
 * - pushed: the local lane names that have a remote-tracking branch;
 * - live: the branch names, local or remote, not merged into the base;
 * - branches: every branch name, local or remote, merged or not.
 */
function remoteLanes(options) {
  const { root, config } = options
  const local = options.local ?? new Set()
  const remotes = lanesRemotes(root)
  const remote = defaultRemote(root, config.base)
  let base = null
  if (remote !== null && lanesRefExists(root, `refs/remotes/${remote}/${config.base}`)) base = `${remote}/${config.base}`
  else if (lanesRefExists(root, `refs/heads/${config.base}`)) base = config.base
  const baseRef = base === null ? null : base === config.base ? `refs/heads/${base}` : `refs/remotes/${base}`

  // Every branch, and which of them are not merged into the base.
  const format = '%(objectname)%00%(objecttype)%00%(refname)%00%(symref)%00%(authorname)%00%(authordate:iso-strict)'
  const listArgs = (extra) => ['for-each-ref', '--sort=-committerdate', `--format=${format}${extra}`, 'refs/heads/', 'refs/remotes/']
  let output
  let counted = false
  if (baseRef !== null) {
    try {
      output = lanesGit(root, listArgs(`%00%(ahead-behind:${baseRef})`))
      counted = true
    } catch {
      // git before 2.41 has no ahead-behind atom; lanesAheadCounts counts them below.
    }
  }
  if (!counted) output = lanesGit(root, listArgs(''))
  const unmerged = new Set(
    baseRef === null
      ? []
      : lanesGit(root, ['for-each-ref', `--no-merged=${baseRef}`, '--format=%(refname)', 'refs/heads/', 'refs/remotes/'])
          .toString('utf8')
          .split('\n')
          .filter((ref) => ref !== '')
  )
  const isLive = (ref) => baseRef === null || unmerged.has(ref)

  const branches = new Set()
  const live = new Set()
  const pushed = new Set()
  const byName = new Map()
  // Longest remote name first, so that a remote named a/b wins over a.
  const remotePrefixes = [...remotes].sort((a, b) => b.length - a.length).map((name) => [name, `refs/remotes/${name}/`])
  for (const line of output.toString('utf8').split('\n')) {
    if (line === '') continue
    const [commit, type, ref, symref, author, date, aheadBehind] = line.split('\0')
    if (type !== 'commit' || symref !== '') continue
    if (ref.startsWith('refs/heads/')) {
      const branch = ref.slice('refs/heads/'.length)
      branches.add(branch)
      if (isLive(ref)) live.add(branch)
      continue
    }
    const owner = remotePrefixes.find(([, prefix]) => ref.startsWith(prefix))
    if (!owner) continue
    const [remoteName, prefix] = owner
    const branch = ref.slice(prefix.length)
    branches.add(branch)
    if (local.has(branch)) {
      pushed.add(branch)
      continue
    }
    if (branch === config.base) continue
    if (!isLive(ref)) continue
    live.add(branch)
    const lane = { branch, source: 'remote', remote: remoteName, ref, commit, tasks: [], lastCommit: { author, date }, ahead: null, verification: null }
    if (counted) lane.ahead = Number(aheadBehind.split(' ')[0])
    const known = byName.get(branch)
    if (known === undefined || (remoteName === remote && known.remote !== remote)) byName.set(branch, lane)
  }
  const lanes = [...byName.values()]

  // The tasks folders of the base and every lane, in one batch.
  const folder = `${config.dir}/tasks`
  const commits = [...new Set(lanes.map((lane) => lane.commit))]
  const trees = lanesBatch(root, [...(baseRef === null ? [] : [`${baseRef}:${folder}`]), ...commits.map((commit) => `${commit}:${folder}`)])
  const filesOf = (object) => (object && object.type === 'tree' ? lanesTreeFiles(object.data, object.oid.length / 2) : new Map())
  const baseFiles = baseRef === null ? new Map() : filesOf(trees[0])
  const laneFiles = new Map(commits.map((commit, index) => [commit, filesOf(trees[index + (baseRef === null ? 0 : 1)])]))

  // The differing blobs and the base's, in a second batch.
  const wanted = new Set(baseFiles.values())
  const differing = new Map()
  for (const [commit, files] of laneFiles) {
    const changed = [...files].filter(([name, oid]) => baseFiles.get(name) !== oid)
    differing.set(commit, changed)
    for (const [, oid] of changed) wanted.add(oid)
  }
  const oids = [...wanted]
  const texts = new Map(lanesBatch(root, oids).map((object, index) => [oids[index], object ? object.data.toString('utf8') : '']))
  const parsed = (name, oid) => parseTask(`${folder}/${name}`, texts.get(oid) ?? '')
  const baseTasks = [...baseFiles].map(([name, oid]) => parsed(name, oid))
  for (const lane of lanes) lane.tasks = differing.get(lane.commit).map(([name, oid]) => parsed(name, oid))

  if (!counted && baseRef !== null) {
    const ahead = lanesAheadCounts(root, baseRef, commits)
    for (const lane of lanes) lane.ahead = ahead.get(lane.commit)
  }

  // Verification only for lanes that change a task: it costs a tree listing per head.
  const holding = lanes.filter((lane) => lane.tasks.length > 0)
  const gates = config.gates.commit.length + config.gates.verify.length
  if (gates === 0) for (const lane of holding) lane.verification = 'no-gates'
  else {
    const codes = new Map()
    for (const commit of new Set(holding.map((lane) => lane.commit))) codes.set(commit, fingerprint({ kind: 'commit', rev: commit, root }, config))
    const stampCommits = [...codes.keys()]
    const stamps = lanesBatch(root, stampCommits.map((commit) => `${commit}:${stampPath(config, codes.get(commit))}`))
    const verified = new Map(
      stampCommits.map((commit, index) => {
        const text = stamps[index] && stamps[index].type === 'blob' ? stamps[index].data.toString('utf8') : null
        return [commit, verifiedStamp({ read: () => text }, config, codes.get(commit)) !== null]
      })
    )
    for (const lane of holding) lane.verification = verified.get(lane.commit) ? 'verified' : 'unverified'
  }
  return { base, remote, lanes, baseTasks, pushed, live, branches }
}

// --- ownership.mjs ---
// Task ownership (spec 6.2): one lane changes a held task, and tasks are never deleted.
// pre-commit compares HEAD with the index; ci compares the merge base with the head and the
// base branch's tip. Both pass the task maps in, so the rules are the same for every source.

/** The tasks of a reader by id, each as { task, text }; the first file wins for a duplicate id. */
function taskRecordsById(reader, dir) {
  const byId = new Map()
  for (const task of laneTasks(reader, dir)) {
    if (task.id && !byId.has(task.id)) byId.set(task.id, { task, text: reader.read(task.file) })
  }
  return byId
}

/** The lane that holds a task: its Lane while doing, or blocked with a Lane; otherwise null. */
function ownershipHolder(task) {
  if (task.status === 'doing' || task.status === 'blocked') return task.lane
  return null
}

/** Whether a task is a takeover by a lane: doing, that Lane, and Taken over from naming the holder. */
function ownershipIsTakeover(task, lane, holder) {
  if (task.status !== 'doing' || task.lane !== lane || !task.takenOverFrom) return false
  return task.takenOverFrom.split(/[\s,;`]+/).includes(holder)
}

/**
 * The ownership problems of a change from `before` to `after`, two Maps from taskRecordsById.
 *
 * context:
 * - before, after: the tasks the change starts from and ends with.
 * - lane: the branch that makes the change.
 * - config: the effective configuration.
 * - kept: the ids that must not disappear (they exist on the base branch), or null for every
 *   id in `before`.
 * - holders: more task Maps whose holders count, besides `before`, such as the base's tip.
 * - accepted: task Maps whose exact text for a task is not this lane's change, such as the
 *   commit being merged, or the base's tip.
 * - baseName: how messages name the base branch.
 *
 * A task that `after` changes (or adds) and another lane holds in `before` or in a `holders`
 * Map is a problem, unless `after` records a takeover from that lane. A task that `after` no
 * longer has (deleted, or its id renamed) is a problem when it is in `kept`, or when another
 * lane holds it in `before`, as after merging that lane in, whatever `kept` says.
 */
function ownershipProblems(context) {
  const { before, after, lane, config } = context
  const kept = context.kept ?? new Set(before.keys())
  const holders = context.holders ?? []
  const accepted = context.accepted ?? []
  const baseName = context.baseName ?? config.base
  const guard = `node ${config.dir}/scripts/records.mjs`
  const problems = []

  for (const [id, { task }] of before) {
    if (after.has(id)) continue
    const holder = ownershipHolder(task)
    if (kept.has(id)) {
      problems.push({
        file: task.file,
        line: 0,
        message: `task ${id} is deleted or its id renamed, but it exists on ${baseName}. Tasks are never deleted: keep the file and set "Status: dropped" with a "Reason"`
      })
    } else if (holder && holder !== lane) {
      problems.push({
        file: task.file,
        line: 0,
        message: `task ${id} is deleted or its id renamed, but lane "${holder}" holds it (Status: ${task.status}), so only that lane changes it`
      })
    }
  }

  for (const [id, { task, text }] of after) {
    if (before.get(id)?.text === text) continue
    if (accepted.some((tasks) => tasks.get(id)?.text === text)) continue
    const reported = new Set()
    for (const source of [before, ...holders]) {
      const held = source.get(id)?.task
      if (!held) continue
      const holder = ownershipHolder(held)
      if (!holder || holder === lane || reported.has(holder)) continue
      if (ownershipIsTakeover(task, lane, holder)) continue
      reported.add(holder)
      problems.push({
        file: task.file,
        line: 0,
        message: `task ${id} is held by lane "${holder}" (Status: ${held.status}), so only that lane changes it. To take it over, run "${guard} claim ${id} --take"`
      })
    }
  }
  return problems
}

/**
 * The tasks of `after` that name another lane and change here: a Lane other than `lane`, and
 * text that is neither in `before` nor in any `accepted` Map. A branch carries such a task only
 * as a copy of the lane it names, as when it is stacked on that lane. Returns [{ id, task, text,
 * holder }], holder being the Lane the task names.
 */
function foreignLaneTasks(context) {
  const { before, after, lane } = context
  const accepted = context.accepted ?? []
  const foreign = []
  for (const [id, { task, text }] of after) {
    if (!task.lane || task.lane === lane) continue
    if (before.get(id)?.text === text) continue
    if (accepted.some((tasks) => tasks.get(id)?.text === text)) continue
    foreign.push({ id, task, text, holder: task.lane })
  }
  return foreign
}

/**
 * The problems of the tasks from foreignLaneTasks against the copies on their lanes' branches.
 * copies is a Map from id to { branch, task, text } (task and text null when that branch has no
 * such file); an id is missing when the lane has no branch to read.
 *
 * A copy equal to the lane's is fine. Otherwise it is a problem when this copy holds the task,
 * or the lane's copy does: only that lane changes a task it holds (spec 6.2), and a branch that
 * claims a task names its own lane. A done, dropped or todo task the lane no longer holds can be
 * edited by anyone.
 */
function laneCopyProblems(tasks, copies, config) {
  const guard = `node ${config.dir}/scripts/records.mjs`
  const problems = []
  for (const { id, task, text, holder } of tasks) {
    const copy = copies.get(id)
    if (copy?.text === text) continue
    const held = ownershipHolder(task) !== null
    const copyHeld = copy?.task ? ownershipHolder(copy.task) !== null : false
    if (!held && !copyHeld) continue
    const where = copy ? `branch "${copy.branch}"` : `lane "${holder}", whose branch is not in this clone`
    problems.push({
      file: task.file,
      line: 0,
      message: `task ${id} is held by lane "${holder}", and this branch's copy differs from that of ${where}. Only that lane changes it: rebase on "${holder}" for its latest copy, or claim the task for this lane with "${guard} claim ${id}" (with --take while "${holder}" holds it)`
    })
  }
  return problems
}

/** The tasks of a Map from taskRecordsById that a lane holds: [{ id, task }]. */
function heldTasks(tasks, lane) {
  return [...tasks].filter(([, { task }]) => ownershipHolder(task) === lane).map(([id, { task }]) => ({ id, task }))
}

/**
 * The double claims of a lane (spec 6.3): a task the lane holds that another open branch holds
 * under a different lane, unless this lane records a takeover from that lane. held is from
 * heldTasks; copies is [{ id, branch, task }], the copies of those tasks on the other branches.
 * One problem per task and other lane, naming the first branch.
 */
function doubleClaimProblems(held, copies, lane, config) {
  const guard = `node ${config.dir}/scripts/records.mjs`
  const ours = new Map(held.map(({ id, task }) => [id, task]))
  const problems = []
  const seen = new Set()
  for (const { id, branch, task: copy } of copies) {
    const task = ours.get(id)
    const holder = ownershipHolder(copy)
    if (!task || !holder || holder === lane || ownershipIsTakeover(task, lane, holder)) continue
    if (seen.has(`${id}\0${holder}`)) continue
    seen.add(`${id}\0${holder}`)
    problems.push({
      file: task.file,
      line: 0,
      message: `task ${id} is claimed twice: this lane "${lane}" holds it, and branch "${branch}" holds it as lane "${holder}". One lane gives it up, or this one takes it over with "${guard} claim ${id} --take"`
    })
  }
  return problems
}

// --- range.mjs ---
// The commit range check, spec 5.9: every commit in a range that changes code names a task that is
// doing or done in that commit's own tree and held by the lane. Pre-push, handoff and CI all use it.
//
// Commits are never parsed out of formatted output, which a message could forge: the list comes
// from git rev-list, each commit from git cat-file --batch (length-prefixed), and its paths from
// git diff-tree --raw -z, keyed by hash. Anything that does not parse is an error, never a pass.

const RANGE_MAX_BUFFER = 1024 * 1024 * 1024
const RANGE_TRAILER = /^Task:(.*)$/
const RANGE_REVERT = /^This reverts commit ([0-9a-f]{7,64})\.$/gm
const RANGE_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const RANGE_COMMITTER = /^committer .*<([^<>]*)> -?\d+ [+-]\d{4}$/
// GitHub's own committer address, written in two parts so the hygiene scan sees no address.
const RANGE_GITHUB_COMMITTER = ['noreply', 'github.com'].join('@')
// The subject GitHub gives a squash merge: the pull request's title, then " (#<number>)".
const RANGE_GITHUB_SQUASH = /\(#\d+\)$/
const RANGE_MAINTENANCE = 'maintenance'
const RANGE_SHOWN_PATHS = 3
// Options that make a diff the same whatever the user's diff configuration is.
const RANGE_DIFF = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--src-prefix=a/', '--dst-prefix=b/']

/** Runs git in a folder: { status, stdout } with stdout a Buffer; throws only when git cannot start. */
function rangeRun(root, args, input) {
  const result = spawnSync('git', args, { cwd: root, input, maxBuffer: RANGE_MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  return { status: result.status, stdout: result.stdout, stderr: result.stderr.toString('utf8').trim() }
}

/** Runs git in a folder and returns stdout as a Buffer; throws with git's message when it fails. */
function rangeGit(root, args, input) {
  const result = rangeRun(root, args, input)
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`)
  return result.stdout
}

/** The error for a commit that cannot be read: the check refuses rather than passes. */
function rangeUnreadable(what) {
  return new Error(`cannot read ${what} from git, so the commits are not checked`)
}

/**
 * Reads objects in one `git cat-file --batch`. Each spec is an object name such as an id or
 * "<rev>:<path>". Returns a Map from spec to { type, data } (a Buffer); missing objects are left out.
 */
function rangeObjects(root, specs) {
  const objects = new Map()
  const unique = [...new Set(specs)]
  if (unique.length === 0) return objects
  const output = rangeGit(root, ['cat-file', '--batch'], `${unique.join('\n')}\n`)
  let at = 0
  for (const spec of unique) {
    const end = output.indexOf(10, at)
    if (end === -1) throw rangeUnreadable(`the object ${spec}`)
    const header = output.toString('utf8', at, end)
    at = end + 1
    if (header.endsWith(' missing') || header.endsWith(' ambiguous')) continue
    const [, type, size] = header.split(' ')
    const length = Number(size)
    if (!Number.isSafeInteger(length) || at + length >= output.length || output[at + length] !== 10) throw rangeUnreadable(`the object ${spec}`)
    objects.set(spec, { type, data: output.subarray(at, at + length) })
    at += length + 1
  }
  return objects
}

/** The blob entries of a raw tree object, as a Map from name to object id (hex). */
function rangeTreeEntries(data, hashBytes) {
  const entries = new Map()
  let at = 0
  while (at < data.length) {
    const space = data.indexOf(32, at)
    const nul = data.indexOf(0, space)
    if (space === -1 || nul === -1) break
    const mode = data.toString('utf8', at, space)
    const name = data.toString('utf8', space + 1, nul)
    const oid = data.toString('hex', nul + 1, nul + 1 + hashBytes)
    at = nul + 1 + hashBytes
    if (!mode.startsWith('40')) entries.set(name, oid)
  }
  return entries
}

/** A raw commit object, parsed and validated: { parents, committer, subject, message }. */
function rangeParseCommit(hash, data) {
  const split = data.indexOf('\n\n')
  if (split === -1) throw rangeUnreadable(`the commit ${hash}`)
  const lines = data.toString('utf8', 0, split).split('\n')
  if (!/^tree [0-9a-f]+$/.test(lines[0])) throw rangeUnreadable(`the commit ${hash}`)
  const parents = []
  let committer = null
  for (const line of lines.slice(1)) {
    if (line.startsWith('parent ')) {
      const parent = line.slice('parent '.length)
      if (!RANGE_HASH.test(parent)) throw rangeUnreadable(`the commit ${hash}`)
      parents.push(parent)
    } else if (line.startsWith('committer ')) {
      const match = RANGE_COMMITTER.exec(line)
      if (!match || committer !== null) throw rangeUnreadable(`the commit ${hash}`)
      committer = match[1]
    }
  }
  if (committer === null) throw rangeUnreadable(`the commit ${hash}`)
  const message = data.toString('utf8', split + 2)
  return { parents, committer, subject: message.split('\n')[0].trim(), message }
}

/**
 * The commits `git rev-list <args>` lists, in its order, each read with `git cat-file --batch`:
 * [{ hash, short, parents, committer, subject, message }]. short is read from git when asked
 * for. Throws when git fails or any commit does not parse.
 */
function readCommits(root, revListArgs) {
  const hashes = rangeGit(root, ['rev-list', ...revListArgs, '--'])
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '')
  if (hashes.length === 0) return []
  if (!hashes.every((hash) => RANGE_HASH.test(hash))) throw rangeUnreadable('the list of commits')
  const output = rangeGit(root, ['cat-file', '--batch'], `${hashes.join('\n')}\n`)
  const commits = []
  let at = 0
  for (const hash of hashes) {
    const end = output.indexOf(10, at)
    const header = end === -1 ? '' : output.toString('utf8', at, end)
    const [oid, type, size] = header.split(' ')
    const length = Number(size)
    at = end + 1
    if (oid !== hash || type !== 'commit' || !/^\d+$/.test(size ?? '') || at + length >= output.length || output[at + length] !== 10) {
      throw rangeUnreadable(`the commit ${hash}`)
    }
    const commit = rangeParseCommit(hash, output.subarray(at, at + length))
    at += length + 1
    let short = null
    commits.push({
      hash,
      get short() {
        if (short === null) short = rangeGit(root, ['rev-parse', '--short', hash]).toString('utf8').trim()
        return short
      },
      ...commit
    })
  }
  if (at !== output.length) throw rangeUnreadable('the list of commits')
  return commits
}

/**
 * The paths each commit touches against its parent (every file for a root commit), deletions
 * included, from one `git diff-tree --stdin --raw -z`: a Map from hash to paths. Merges are not
 * given here; see mergeOwnPaths.
 */
function rangePaths(root, hashes) {
  const paths = new Map()
  if (hashes.length === 0) return paths
  const tokens = rangeGit(root, ['diff-tree', '--stdin', '-r', '--root', '--no-renames', '--raw', '-z', '--always'], `${hashes.join('\n')}\n`)
    .toString('utf8')
    .split('\0')
  if (tokens.pop() !== '') throw rangeUnreadable('the paths of the commits')
  let current = null
  let next = 0
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.startsWith(':')) {
      // A raw entry is always followed by exactly one path, as renames are off.
      const path = tokens[index + 1]
      if (current === null || path === undefined || path === '') throw rangeUnreadable('the paths of the commits')
      current.push(path)
      index += 1
    } else {
      if (token !== hashes[next]) throw rangeUnreadable('the paths of the commits')
      current = []
      paths.set(token, current)
      next += 1
    }
  }
  if (next !== hashes.length) throw rangeUnreadable('the paths of the commits')
  return paths
}

/** The paths one commit touches against its first parent, or every file for a root commit. */
function commitPaths(root, hash) {
  return rangePaths(root, [hash]).get(hash)
}

/** The full id of a revision's commit, or null when it does not resolve. */
function rangeResolve(root, rev) {
  const { status, stdout } = rangeRun(root, ['rev-parse', '--verify', '-q', `${rev}^{commit}`])
  const hash = stdout.toString('utf8').trim()
  return status === 0 && RANGE_HASH.test(hash) ? hash : null
}

/** The id of the empty tree in this repository's hash. */
function rangeEmptyTree(root) {
  return rangeGit(root, ['hash-object', '-t', 'tree', '--stdin'], '').toString('utf8').trim()
}

/** The paths that differ between two tree-ish revisions; `to` null is the index (GIT_INDEX_FILE). */
function rangeChanged(root, from, to) {
  const args =
    to === null
      ? ['diff-index', '--cached', '-r', '--no-renames', '--name-only', '-z', from, '--']
      : ['diff-tree', '-r', '--no-renames', '--name-only', '-z', from, to, '--']
  return rangeGit(root, args)
    .toString('utf8')
    .split('\0')
    .filter((path) => path !== '')
}

/** The merge bases of two commits, or the empty tree when their histories are unrelated. */
function rangeMergeBases(root, a, b) {
  const { status, stdout, stderr } = rangeRun(root, ['merge-base', '--all', a, b])
  if (status !== 0 && status !== 1) throw new Error(`git merge-base failed: ${stderr}`)
  const bases = stdout
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '')
  if (!bases.every((base) => RANGE_HASH.test(base))) throw rangeUnreadable(`the merge base of ${a} and ${b}`)
  return bases.length > 0 ? bases : [rangeEmptyTree(root)]
}

/**
 * The code paths a merge changes of its own, spec 5.9: for each parent, the code paths in
 * diff(parent, merge) that no other parent's side changed, a side being diff(merge base, that
 * parent). A clean merge, or one that only resolves conflicts, has none; any other code path
 * (an "evil merge") makes it a code commit that needs its own Task: line. merge is a commit,
 * or null for the index while a merge is being concluded.
 */
function mergeOwnPaths(root, config, parents, merge) {
  const own = new Set()
  for (const [index, parent] of parents.entries()) {
    const sides = new Set()
    for (const [other, otherParent] of parents.entries()) {
      if (other === index) continue
      for (const base of rangeMergeBases(root, parent, otherParent)) {
        for (const path of rangeChanged(root, base, otherParent)) sides.add(path)
      }
    }
    for (const path of rangeChanged(root, parent, merge)) {
      if (isCode(path, config) && !sides.has(path)) own.add(path)
    }
  }
  return [...own].sort()
}

/** The patch id of a diff, or '' for an empty one. --verbatim keeps whitespace; older git falls back to --stable. */
function rangePatchId(root, diff) {
  if (diff.length === 0) return ''
  let result = rangeRun(root, ['patch-id', '--verbatim'], diff)
  if (result.status !== 0) result = rangeRun(root, ['patch-id', '--stable'], diff)
  if (result.status !== 0) throw new Error(`git patch-id failed: ${result.stderr}`)
  return result.stdout.toString('utf8').split(' ')[0].trim()
}

/** The diff from one revision to another; `to` null is the index. */
function rangeDiff(root, from, to) {
  return rangeGit(root, ['diff', ...RANGE_DIFF, ...(to === null ? ['--cached', from] : [from, to]), '--'])
}

/**
 * Whether a commit is a real revert, spec 5.9: its message names, in git revert's "This reverts
 * commit <hash>." line, a commit that resolves to an ancestor of `parent`, and its own change
 * (from `parent` to `commit`, or to the index when commit is null) has the patch id of that
 * commit's change inverted. The message alone exempts nothing.
 */
function isRevert(root, message, parent, commit) {
  if (parent === null) return false
  for (const [, named] of String(message).matchAll(RANGE_REVERT)) {
    const reverted = rangeResolve(root, named)
    if (reverted === null) continue
    if (rangeRun(root, ['merge-base', '--is-ancestor', reverted, parent]).status !== 0) continue
    const before = rangeResolve(root, `${reverted}^`) ?? rangeEmptyTree(root)
    const own = rangePatchId(root, rangeDiff(root, parent, commit))
    if (own !== '' && own === rangePatchId(root, rangeDiff(root, reverted, before))) return true
  }
  return false
}

/**
 * The branch of each lane in the clone, from one `git for-each-ref`: a Map from lane to
 * { ref, branch, commit, commits }. ref, branch and commit are those of a remote-tracking branch
 * (refs/remotes/<remote>/<lane>, the first by name) or else the local one (refs/heads/<lane>);
 * commits are the tips of all of them. A lane with neither is left out. No fetch.
 */
function laneBranches(root, lanes) {
  const branches = new Map()
  const wanted = new Set(lanes)
  if (wanted.size === 0) return branches
  // A * in a for-each-ref pattern matches one path segment: one remote name.
  const patterns = [...wanted].flatMap((lane) => [`refs/remotes/*/${lane}`, `refs/heads/${lane}`])
  const found = new Map()
  const output = rangeGit(root, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(refname:short)', ...patterns]).toString('utf8')
  for (const line of output.split('\n')) {
    const [ref, commit, type, branch] = line.split('\0')
    if (type !== 'commit') continue
    const remote = ref.startsWith('refs/remotes/')
    const lane = remote ? ref.slice('refs/remotes/'.length).replace(/^[^/]+\//, '') : ref.slice('refs/heads/'.length)
    if (!wanted.has(lane)) continue
    if (!found.has(lane)) found.set(lane, [])
    found.get(lane).push({ ref, branch, commit, remote })
  }
  for (const [lane, refs] of found) {
    const first = refs.find(({ remote }) => remote) ?? refs[0]
    branches.set(lane, { ref: first.ref, branch: first.branch, commit: first.commit, commits: [...new Set(refs.map(({ commit }) => commit))] })
  }
  return branches
}

/**
 * The commits on each lane's branches that are not ancestors of `from` (every one without it),
 * from one `git rev-list --parents` for all lanes: a Map from lane to a Set of commit ids.
 * branches is a Map from laneBranches.
 */
function rangeLaneReach(root, from, branches) {
  const reach = new Map()
  const tips = [...new Set([...branches.values()].flatMap(({ commits }) => commits))]
  if (tips.length === 0) return reach
  const parents = new Map()
  const output = rangeGit(root, ['rev-list', '--parents', ...tips, ...(from ? [`^${from}`] : []), '--']).toString('utf8')
  for (const line of output.split('\n')) {
    if (line === '') continue
    const [hash, ...ids] = line.split(' ')
    if (!RANGE_HASH.test(hash)) throw rangeUnreadable('the commits of the lane branches')
    parents.set(hash, ids)
  }
  for (const [lane, { commits }] of branches) {
    const seen = new Set()
    const stack = commits.filter((commit) => parents.has(commit))
    while (stack.length > 0) {
      const commit = stack.pop()
      if (seen.has(commit)) continue
      seen.add(commit)
      for (const parent of parents.get(commit)) if (parents.has(parent) && !seen.has(parent)) stack.push(parent)
    }
    reach.set(lane, seen)
  }
  return reach
}

/**
 * The commits of a range, oldest first: [{ hash, short, parents, committer, subject, message,
 * paths, exemption }]. paths are the files a commit touches against its parent (every file for a
 * root commit); for a merge, only the code paths it changes of its own (mergeOwnPaths).
 * exemption is 'merge' for a merge with none, 'revert' for a real revert (isRevert), or null.
 * Without `from` the range is every ancestor of `to`.
 */
function rangeCommits(root, config, from, to) {
  const commits = readCommits(root, ['--reverse', '--topo-order', from ? `${from}..${to}` : to])
  const paths = rangePaths(
    root,
    commits.filter((commit) => commit.parents.length < 2).map((commit) => commit.hash)
  )
  for (const commit of commits) {
    commit.exemption = null
    if (commit.parents.length > 1) {
      commit.paths = mergeOwnPaths(root, config, commit.parents, commit.hash)
      if (commit.paths.length === 0) commit.exemption = 'merge'
      continue
    }
    commit.paths = paths.get(commit.hash)
    if (commit.paths.some((path) => isCode(path, config)) && isRevert(root, commit.message, commit.parents[0] ?? null, commit.hash)) {
      commit.exemption = 'revert'
    }
  }
  return commits
}

/**
 * The task trailers of a commit message: { ids, maintenance }. Every body line of the form
 * "Task: <value>" counts; the value is a comma-separated list, and "maintenance" (lowercase)
 * sets maintenance instead of naming an id. The subject line never counts.
 */
function taskTrailers(message) {
  const ids = []
  let maintenance = false
  const lines = String(message).replace(/\r\n?/g, '\n').split('\n').slice(1)
  for (const line of lines) {
    const match = RANGE_TRAILER.exec(line.trimEnd())
    if (!match) continue
    for (const part of match[1].split(',')) {
      const value = part.trim()
      if (value === '') continue
      if (value === RANGE_MAINTENANCE) maintenance = true
      else if (!ids.includes(value)) ids.push(value)
    }
  }
  return { ids, maintenance }
}

/**
 * Why a commit is exempt from the trailer rules, or null: commit.exemption, which the caller
 * found in git ('merge' for a merge that changes no code of its own, 'revert' for a real
 * revert), or 'github' (a commit GitHub made when merging a pull request, only with
 * context.skipGitHubMerges): GitHub's committer address on a merge commit or on a commit whose
 * subject has GitHub's squash form, "Title (#12)". The address is not verified, so it buys no
 * more than that. The message alone never exempts a commit, and a release commit that changes
 * code needs a Task: line like any other.
 * commit is { parents, committer, subject, exemption }.
 */
function commitExemption(commit, context) {
  if (commit.exemption) return commit.exemption
  if (context.skipGitHubMerges && isGitHubMerge(commit)) return 'github'
  return null
}

/** True for a merge or squash commit with GitHub's committer address. */
function isGitHubMerge({ parents, committer, subject }) {
  if (committer.toLowerCase() !== RANGE_GITHUB_COMMITTER) return false
  return parents.length > 1 || RANGE_GITHUB_SQUASH.test(subject ?? '')
}

/** The task file for an id among a tasks folder's entries: <id>.md or <id>-<slug>.md. */
function taskFileFor(names, id) {
  for (const name of names) {
    if (name === `${id}.md` || (name.startsWith(`${id}-`) && name.endsWith('.md'))) return name
  }
  return null
}

/**
 * The trailer problems of one commit, spec 5.9, as { file: commit.short, line: 0, message }.
 * checkRange calls it for each commit of a range, and commit-msg for the commit being made.
 *
 * commit is { short, parents, committer, subject, message, paths, exemption }: for a merge,
 * paths are the code paths it changes of its own (mergeOwnPaths). context is { config, lane,
 * skipGitHubMerges, task, startLane, onLane }: task(id) is the parsed task in the commit's own
 * tree, or null when it has no file there; startLane(id) is the task's Lane where the range
 * starts (null when the task is not there, has no Lane, or there is no start); the optional
 * onLane(lane) is { branch, reachable } for a lane with a branch in the clone, reachable telling
 * whether this commit is on it, and null otherwise. lane null skips the lane rule.
 *
 * A task whose Lane is another lane's is accepted when the commit is on that lane's branch (as
 * after merging the lane); when that lane has no branch in the clone, when its Lane was set
 * after the start.
 */
function checkCommit(commit, context) {
  const { config } = context
  const lane = context.lane ?? null
  const tasksFolder = `${config.dir}/tasks`
  if (commitExemption(commit, context) !== null) return []
  if (!commit.paths.some((path) => isCode(path, config))) return []
  const problems = []
  const problem = (message) => problems.push({ file: commit.short, line: 0, message: `"${commit.subject}" ${message}` })
  const { ids, maintenance } = taskTrailers(commit.message)
  if (ids.length === 0 && !maintenance && commit.parents.length > 1) {
    const shown = commit.paths.filter((path) => isCode(path, config))
    const more = shown.length > RANGE_SHOWN_PATHS ? ` and ${shown.length - RANGE_SHOWN_PATHS} more` : ''
    problem(
      `is a merge that changes code neither side changed (${shown.slice(0, RANGE_SHOWN_PATHS).join(', ')}${more}), but names no task. Add a trailer line "Task: <id>" to the message body for the task that change belongs to, or make the change in its own commit`
    )
    return problems
  }
  if (ids.length === 0 && !maintenance) {
    problem(
      'changes code but names no task. Add a trailer line "Task: <id>" to the message body for the task it belongs to, or "Task: maintenance" for a change with no behaviour change'
    )
    return problems
  }
  const valid = []
  for (const id of ids) {
    if (TASK_ID.test(id)) valid.push(id)
    else
      problem(
        `has "${id}" in its Task: trailer, which is not a task id. Write ids such as S4 or S4.1, separated by commas, or "maintenance" in lowercase`
      )
  }

  const laneChecks = []
  for (const id of valid) {
    const task = context.task(id)
    if (task === null) {
      problem(`names task ${id}, which has no file in ${tasksFolder}/ in that commit. Add the task file, or name the task the change belongs to`)
      continue
    }
    if (task.status !== 'doing' && task.status !== 'done') {
      problem(
        `names task ${id}, which is ${task.status ?? 'without a status'} in that commit. A commit can only name a task that is doing or done in its own tree: claim the task first, or name the task the change belongs to`
      )
      continue
    }
    if (lane !== null && task.lane !== lane) laneChecks.push({ id, task })
  }

  // Another lane's task is accepted on that lane's own commits, which a merge or a stacked
  // branch brings in, and refused on any other commit, also one a side branch launders in.
  // Without the lane's branch, the rule only refuses naming a task another lane held before the
  // start: a Lane set after the start (by a claim, also in a records-only commit, or under a
  // branch name that was later renamed, or by a lane merged and deleted since) is accepted. Taking a held task without
  // claim --take is caught by the ownership check in pre-commit and CI (H1 and C1), not here.
  for (const { id, task } of laneChecks) {
    if (task.lane === null) {
      problem(`names task ${id}, which has no Lane in that commit. Claim the task for "${lane}" first`)
      continue
    }
    const holder = context.onLane?.(task.lane) ?? null
    if (holder?.reachable) continue
    if (holder !== null) {
      problem(
        `names task ${id}, whose Lane is "${task.lane}", but the commit is not on that lane's branch "${holder.branch}". Name a task this lane holds, or take it over with claim --take`
      )
      continue
    }
    if (context.startLane(id) !== task.lane) continue
    problem(
      `names task ${id}, which is held by lane "${task.lane}" before this range, not by "${lane}". Name a task this lane holds, or take it over with claim --take`
    )
  }
  return problems
}

/**
 * The lane branches of the other lanes a range's commits name, as onLane(hash, lane) for
 * checkCommit: { branch, reachable } or null. naming is the commits that name a task id, and
 * taskOf(commit, id) the parsed task in a commit's tree. Reads git only when a commit names a
 * task whose Lane is not `lane`.
 */
function rangeOnLane(root, from, lane, naming, taskOf) {
  const holders = new Set()
  if (lane !== null) {
    for (const commit of naming) {
      for (const id of taskTrailers(commit.message).ids) {
        const task = TASK_ID.test(id) ? taskOf(commit, id) : null
        if (task?.lane && task.lane !== lane) holders.add(task.lane)
      }
    }
  }
  if (holders.size === 0) return () => null
  const branches = laneBranches(root, [...holders])
  const reach = rangeLaneReach(root, from, branches)
  return (hash, holder) => {
    const branch = branches.get(holder)
    return branch ? { branch: branch.branch, reachable: reach.get(holder).has(hash) } : null
  }
}

/**
 * Checks every commit in from..to, oldest first, and returns problems as
 * { file: <short hash>, line: 0, message }. Without `from`, every ancestor of `to` is checked.
 *
 * context is { config, lane, skipGitHubMerges, root, exempt }: the effective configuration; the
 * lane (branch) that must hold each named task, or null to skip that rule; whether commits that
 * GitHub made when merging a pull request are skipped (the CI push check); the repository, by
 * default the one of the current folder; and an optional Map that counts the code commits
 * exempted, by reason ('merge', 'revert' or 'github').
 *
 * Each commit is judged by checkCommit, with its own tree and the tasks at `from`: a merge
 * that changes no code of its own and a real revert are skipped (rangeCommits). A commit that
 * changes code needs a Task: trailer; each id it names must be doing or done in that commit's
 * own tree, with a Lane there that is the lane, or another lane's when the commit is on that
 * lane's branch (or, when it has none in the clone, set inside the range). "maintenance" is
 * allowed. Only a range that names another lane's task reads the lane branches: one
 * `git for-each-ref` and one `git rev-list` (laneBranches, rangeLaneReach).
 */
function checkRange(from, to, context) {
  const { config } = context
  const root = context.root ?? repositoryRoot()
  const tasksFolder = `${config.dir}/tasks`
  const commits = rangeCommits(root, config, from, to).filter((commit) => {
    if (!commit.paths.some((path) => isCode(path, config))) return false
    const reason = commitExemption(commit, context)
    if (reason !== null && context.exempt) context.exempt.set(reason, (context.exempt.get(reason) ?? 0) + 1)
    return reason === null
  })
  if (commits.length === 0) return []
  const hashBytes = commits[0].hash.length / 2

  // One batch for the tasks folder of every commit that names a task id, one for the task files they name.
  const naming = commits.filter((commit) => taskTrailers(commit.message).ids.some((id) => TASK_ID.test(id)))
  const trees = rangeObjects(
    root,
    naming.map((commit) => `${commit.hash}:${tasksFolder}`)
  )
  const entriesOf = new Map()
  const wanted = []
  for (const commit of naming) {
    const tree = trees.get(`${commit.hash}:${tasksFolder}`)
    const entries = tree && tree.type === 'tree' ? rangeTreeEntries(tree.data, hashBytes) : new Map()
    entriesOf.set(commit.hash, entries)
    for (const id of taskTrailers(commit.message).ids) {
      const name = TASK_ID.test(id) ? taskFileFor(entries.keys(), id) : null
      if (name !== null) wanted.push(entries.get(name))
    }
  }
  const blobs = rangeObjects(root, wanted)
  const parsed = new Map()
  const taskIn = (entries, id) => {
    const name = taskFileFor(entries.keys(), id)
    if (name === null) return null
    const oid = entries.get(name)
    const key = `${oid} ${name}`
    if (!parsed.has(key)) parsed.set(key, parseTask(`${tasksFolder}/${name}`, blobs.get(oid)?.data.toString('utf8') ?? ''))
    return parsed.get(key)
  }

  // The Lanes at `from`, read only when the lane rule needs one.
  let startEntries = null
  const lanesAtStart = new Map() // id → its Lane at `from`, or null when the task is not there or has none
  const startLane = (id) => {
    if (!from) return null
    if (lanesAtStart.has(id)) return lanesAtStart.get(id)
    if (startEntries === null) {
      const startTree = rangeObjects(root, [`${from}:${tasksFolder}`]).get(`${from}:${tasksFolder}`)
      startEntries = startTree && startTree.type === 'tree' ? rangeTreeEntries(startTree.data, hashBytes) : new Map()
    }
    const name = taskFileFor(startEntries.keys(), id)
    const blob = name === null ? undefined : rangeObjects(root, [startEntries.get(name)]).get(startEntries.get(name))
    const lane = blob ? parseTask(`${tasksFolder}/${name}`, blob.data.toString('utf8')).lane : null
    lanesAtStart.set(id, lane)
    return lane
  }

  const onLane = rangeOnLane(root, from, context.lane ?? null, naming, (commit, id) => taskIn(entriesOf.get(commit.hash), id))
  return commits.flatMap((commit) =>
    checkCommit(commit, {
      ...context,
      config,
      task: (id) => taskIn(entriesOf.get(commit.hash) ?? new Map(), id),
      startLane,
      onLane: (holder) => onLane(commit.hash, holder)
    })
  )
}

// --- githooks.mjs ---
// The git hooks on the guard side: what each hook checks, whether the hooks are active
// in this clone, and turning them on.

const HOOKS_PATH = '.githooks'

// The git hooks that call the guard. git runs pre-merge-commit, not pre-commit, for a merge
// that commits by itself; a fast-forward makes no commit, so only pre-push sees it.
const GIT_HOOKS = Object.freeze(['pre-commit', 'pre-merge-commit', 'commit-msg', 'pre-push'])

// The YAML files of the hook managers whose installed hooks do not name the guard themselves.
const MANAGER_FILES = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml', '.pre-commit-config.yaml']

/** The text of a file, or '' when it cannot be read. */
function readHookFile(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** The value of core.hooksPath, or '' when it is unset. */
function configuredHooksPath(root) {
  try {
    return git('-C', root, 'config', '--get', 'core.hooksPath')
  } catch {
    return ''
  }
}

/** True when the path names the .githooks folder at the repository root. */
function isOwnHooksPath(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') === HOOKS_PATH
}

/** Whether git runs the guard's call for one hook from the hooks folder. */
function githooksHookActive(root, folder, name) {
  const hook = readHookFile(join(folder, name))
  if (hook === '') return false
  if (hook.split(/\r?\n/).includes(`# resaledger: ${name} hook, managed by ResaLedger; do not edit`)) return true
  const calls = new RegExp(`scripts/records\\.mjs"?\\s+${name}(?![\\w-])`)
  if (calls.test(hook)) return true
  // husky runs .husky/<hook> from its own scripts in .husky/_.
  if (folder.replace(/\\/g, '/').replace(/\/+$/, '').endsWith('.husky/_') && calls.test(readHookFile(join(folder, '..', name)))) return true
  return MANAGER_FILES.some((file) => calls.test(readHookFile(join(root, file))))
}

/**
 * True when git runs each of the guard's hooks (GIT_HOOKS) in this clone: for each, the
 * effective hooks folder (core.hooksPath or the git folder's hooks, per worktree) holds the
 * ResaLedger hook, or a hook manager's hook is installed and its configuration calls the guard.
 * A clone set up before pre-merge-commit was shipped is not active until it is updated.
 */
function hooksActive(root = repositoryRoot()) {
  let folder = git('-C', root, 'rev-parse', '--git-path', 'hooks')
  if (!isAbsolute(folder)) folder = join(root, folder)
  return GIT_HOOKS.every((name) => githooksHookActive(root, folder, name))
}

/**
 * Points core.hooksPath at .githooks when it is unset. Returns 'activated' when it set it,
 * 'active' when it already pointed there, and { foreign: value } without changing anything
 * when it holds another value, such as a hook manager's folder.
 */
function activateHooks() {
  const root = repositoryRoot()
  const current = configuredHooksPath(root)
  if (current === '') {
    git('-C', root, 'config', '--local', 'core.hooksPath', HOOKS_PATH)
    return 'activated'
  }
  if (isOwnHooksPath(current)) return 'active'
  return { foreign: current }
}

/** Prints the refusal of a commit with one line per problem, and exits 1. */
function githooksRefuse(problems) {
  console.error('✖ This commit is refused')
  for (const { file, line, message } of problems) console.error(`  ${file ? `${file}${line ? `:${line}` : ''}: ` : ''}${message}`)
  process.exit(1)
}

/** The full object id of a revision's commit, or null when it does not resolve. */
function githooksCommit(rev) {
  try {
    return git('rev-parse', '--verify', '-q', `${rev}^{commit}`) || null
  } catch {
    return null
  }
}

/** The problems with the branch: a protected branch, or a name that fails branchPattern. */
function githooksBranchProblems(branch, config) {
  if (branch === null) return []
  const guard = `node ${config.dir}/scripts/records.mjs`
  if (config.protected.includes(branch)) {
    return [
      {
        file: '',
        line: 0,
        message: `"${branch}" is a protected branch, so nothing is committed on it, not even a merge. Work in a lane branch, for example with "${guard} claim <id>", which creates one, and open a pull request. A fast-forward merge makes no commit, so no commit hook sees it; pre-push refuses it`
      }
    ]
  }
  if (config.branchRegex && branch !== config.base && !config.branchRegex.test(branch)) {
    return [
      {
        file: '',
        line: 0,
        message: `the branch name "${branch}" does not match branchPattern ${JSON.stringify(config.branchPattern)} in .resaledger.json. Rename it with "git branch -m <name>"`
      }
    ]
  }
  return []
}

/**
 * The ownership problems of the staged tasks (spec 6.2), compared by id with HEAD: a task that
 * exists on the base branch was deleted or had its id renamed, or a task another lane holds, in
 * HEAD or in `holders` (the other local worktrees), was changed without a takeover. During a
 * merge, a task staged exactly as a merged commit has it is that lane's own change and passes.
 */
function githooksOwnershipProblems(root, branch, config, head, headTasks, stagedTasks, mergeHeads, holders) {
  let kept = new Set(headTasks.keys())
  const deleted = [...headTasks.keys()].some((id) => !stagedTasks.has(id))
  const base = deleted && branch !== config.base ? githooksCommit(config.base) : null
  if (base !== null) {
    let mergeBase = head
    try {
      mergeBase = git('merge-base', head, base) || head
    } catch {
      // Unrelated histories: HEAD stands for the base.
    }
    if (mergeBase !== head) kept = new Set(taskRecordsById(treeReader({ kind: 'commit', rev: mergeBase, root }), config.dir).keys())
  }
  const accepted = mergeHeads.map((rev) => taskRecordsById(treeReader({ kind: 'commit', rev, root }), config.dir))
  return ownershipProblems({ before: headTasks, after: stagedTasks, lane: branch, config, kept, holders, accepted })
}

/**
 * The tasks each other local worktree holds, as one Map by id per worktree: its tasks on disk
 * whose Lane is its own branch, so that a claim it has not committed yet counts (spec 6.2).
 */
function githooksWorktreeHolders(lanes) {
  return lanes.map((lane) => new Map(lane.tasks.filter((task) => task.id && task.lane === lane.branch).map((task) => [task.id, { task }])))
}

/** Whether the staged tasks change or add a task compared with HEAD. */
function githooksTasksChanged(headTasks, stagedTasks) {
  return [...stagedTasks].some(([id, { text }]) => headTasks.get(id)?.text !== text)
}

/**
 * The commits a merge brings in. When `git commit` concludes a merge, MERGE_HEAD names them.
 * git runs pre-merge-commit before it writes MERGE_HEAD, so there they are the commits that
 * GIT_REFLOG_ACTION names ("merge <commit>…", as git merge sets it), and for FETCH_HEAD, as
 * git pull merges, the fetched commits marked for merging. Empty for an ordinary commit, and
 * when the merged commits cannot be found, so that no task change is taken as theirs.
 */
function githooksMergeHeads(root, hook) {
  const commits = new Set()
  if (hook !== 'pre-merge-commit') {
    for (const line of readHookFile(githooksGitPath(root, 'MERGE_HEAD')).split(/\r?\n/)) {
      const commit = line.trim() === '' ? null : githooksCommit(line.trim())
      if (commit !== null) commits.add(commit)
    }
    return [...commits]
  }
  const [action = '', ...names] = (process.env.GIT_REFLOG_ACTION ?? '').trim().split(/\s+/)
  if (action !== 'merge' && action !== 'pull') return []
  if (action === 'pull' || names.includes('FETCH_HEAD')) {
    for (const line of readHookFile(githooksGitPath(root, 'FETCH_HEAD')).split(/\r?\n/)) {
      const [oid, mark] = line.split('\t')
      const commit = mark === '' && oid ? githooksCommit(oid) : null
      if (commit !== null) commits.add(commit)
    }
  }
  for (const name of names) {
    const commit = name === 'FETCH_HEAD' || name.startsWith('-') ? null : githooksCommit(name)
    if (commit !== null) commits.add(commit)
  }
  return [...commits]
}

/** The absolute path of a file in the git folder, such as MERGE_HEAD, for this worktree. */
function githooksGitPath(root, name) {
  const path = git('-C', root, 'rev-parse', '--git-path', name)
  return isAbsolute(path) ? path : join(root, path)
}

/**
 * The id problems of the staged tasks (spec 6.7 and 9): an id that this commit adds and that a
 * locally visible branch has in another file. The other branches are the local branches and the
 * remote-tracking branches, except this lane's own, and the other worktrees as they are on disk.
 */
function githooksIdProblems(root, branch, config, headTasks, stagedTasks, lanes) {
  const added = [...stagedTasks.values()].filter(({ task }) => !headTasks.has(task.id)).map(({ task }) => ({ id: task.id, file: task.file }))
  if (added.length === 0) return []
  let own = new Set()
  if (branch !== null) {
    const remotes = git('-C', root, 'remote').split('\n').filter((name) => name !== '')
    own = new Set([`refs/heads/${branch}`, ...remotes.map((remote) => `refs/remotes/${remote}/${branch}`)])
  }
  const others = branchTaskFiles({ root, dir: config.dir, exclude: (ref) => own.has(ref.ref) })
  for (const lane of lanes()) {
    others.push({ branch: lane.branch, worktree: true, files: new Map(lane.tasks.filter((task) => task.id).map((task) => [task.id, task.file])) })
  }
  return idCollisions(added, others, config)
}

/** The staged paths, compared with HEAD (or with nothing before the first commit), deletions included. */
function githooksStagedPaths() {
  return git('diff', '--cached', '--name-only', '--no-renames', '-z')
    .split('\0')
    .filter((path) => path !== '')
}

/**
 * The configuration committed in a commit: { config, problems } as loadConfig gives it, or
 * null when the commit is null or has no .resaledger.json.
 */
function githooksCommittedConfig(root, rev) {
  if (rev === null) return null
  const reader = treeReader({ kind: 'commit', rev, root })
  return reader.exists(CONFIG_FILE) ? loadConfig(reader) : null
}

/**
 * The configuration a change is judged by: its own (for dir, the records and the rest), with
 * the rules taken from a committed configuration it cannot change (spec 12): the base, the
 * protected branches, branchPattern and the gates. Without rules, its own hold.
 */
function githooksWithRules(config, rules) {
  if (!rules) return config
  const { base, branchPattern, branchRegex, gates } = rules
  return { ...config, base, protected: rules.protected, branchPattern, branchRegex, gates }
}

/**
 * The pre-commit hook, and pre-merge-commit, which git runs instead for a merge that commits
 * by itself. Judged on the staged content (the index git names in GIT_INDEX_FILE, which is a
 * temporary one for `git commit -- <paths>`): the configuration, the branch rules, the records,
 * task ownership against HEAD and the other local worktrees' claims on disk, new ids against
 * the other local branches and worktrees, and the commit gates when code is staged. The rules
 * (githooksWithRules) are HEAD's committed ones, so staging a looser configuration does not
 * loosen the commit that adds it; the index's hold only before the first commit, or when HEAD
 * has no valid configuration yet.
 * hook is the hook git runs, which tells where the merged commits of a merge are found.
 * A refusal prints every problem and exits 1; a pass prints only the gate lines.
 */
function preCommit(hook = 'pre-commit') {
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }
  const reader = treeReader({ kind: 'index', root })
  const { config: staged, problems: configProblems } = loadConfig(reader)
  if (!staged) githooksRefuse(configProblems)
  const head = githooksCommit('HEAD')
  const config = githooksWithRules(staged, githooksCommittedConfig(root, head)?.config)

  const branch = currentLane()
  const problems = githooksBranchProblems(branch, config)
  problems.push(...checkWorkspace(loadWorkspace(reader, staged), reader, staged))
  const headTasks = head === null ? new Map() : taskRecordsById(treeReader({ kind: 'commit', rev: head, root }), config.dir)
  const stagedTasks = taskRecordsById(reader, config.dir)
  // The other worktrees are read once, and only when a task changes: most commits change none.
  let others = null
  const lanes = () => (others ??= localLanes(config, new Map()))
  if (branch !== null && head !== null) {
    const holders = githooksTasksChanged(headTasks, stagedTasks) ? githooksWorktreeHolders(lanes()) : []
    problems.push(...githooksOwnershipProblems(root, branch, config, head, headTasks, stagedTasks, githooksMergeHeads(root, hook), holders))
  }
  problems.push(...githooksIdProblems(root, branch, config, headTasks, stagedTasks, lanes))
  if (problems.length > 0) githooksRefuse(problems)

  if (config.gates.commit.length === 0 || !githooksStagedPaths().some((path) => isCode(path, config))) return
  const { failure } = runGates(config.gates.commit, { root })
  if (failure) {
    githooksRefuse([{ file: '', line: 0, message: `the commit gate "${failure.command}" failed. Fix the code; a gate is never weakened to make it pass` }])
  }
}

/**
 * What aiAttribution "forbid" refuses in a trailer. names are models, assistants and vendors,
 * matched as whole words in any case. qualified are names that are also people's first names,
 * so they match only in the forms listed (<version> is a version number, <digit> one digit).
 * domains are the vendors' e-mail domains. A GitHub bot address ("<login>[bot]" at GitHub's
 * users.noreply host) is refused when its login contains any of the names.
 */
const AI_ATTRIBUTION = Object.freeze({
  names: Object.freeze([
    'Anthropic',
    'OpenAI',
    'ChatGPT',
    'GPT',
    'Codex',
    'Copilot',
    'Gemini',
    'Cursor',
    'Grok',
    'xAI',
    'Moonshot',
    'Mistral',
    'Aider',
    'Windsurf',
    'Codeium',
    'DeepSeek',
    'Qwen',
    'Amazon Q'
  ]),
  qualified: Object.freeze([
    Object.freeze({
      name: 'Claude',
      forms: Object.freeze(['Claude Code', 'Claude Opus', 'Claude Sonnet', 'Claude Haiku', 'Claude Fable', 'Claude Instant', 'Claude <version>'])
    }),
    Object.freeze({ name: 'Devin', forms: Object.freeze(['Devin AI', 'devin-ai']) }),
    Object.freeze({ name: 'Jules', forms: Object.freeze(['google-labs-jules', 'Jules[bot]']) }),
    Object.freeze({ name: 'Kimi', forms: Object.freeze(['Kimi K<digit>', 'Kimi Code', 'Kimi AI']) })
  ]),
  domains: Object.freeze([
    'anthropic.com',
    'openai.com',
    'cursor.com',
    'cursor.sh',
    'x.ai',
    'moonshot.ai',
    'moonshot.cn',
    'mistral.ai',
    'cognition.ai',
    'aider.chat',
    'codeium.com',
    'windsurf.com',
    'deepseek.com'
  ])
})

const GITHOOKS_ESCAPE = /[.*+?^${}()|[\]\\]/g
// A name as a word: no letter or digit before it, no letter after it (so "GPT-4o" matches, "cursory" does not).
const GITHOOKS_AI_NAME = new RegExp(
  `(?<![A-Za-z0-9])(?:${AI_ATTRIBUTION.names.map((name) => name.replace(GITHOOKS_ESCAPE, '\\$&').replace(/ /g, '[\\s-]+')).join('|')})(?![A-Za-z])`,
  'i'
)
// The qualified forms of AI_ATTRIBUTION, one pattern for each name, in the same order.
const GITHOOKS_AI_QUALIFIED = [
  /(?<![A-Za-z0-9])claude(?:[\s-]+(?:code|opus|sonnet|haiku|fable|instant)(?![A-Za-z])|[\s-]*v?\d)/i,
  /(?<![A-Za-z0-9])devin[\s-]ai(?![A-Za-z])/i,
  /(?<![A-Za-z0-9])(?:google-labs-jules|jules\[bot\])/i,
  /(?<![A-Za-z0-9])kimi[\s-]*(?:k\d|code(?![A-Za-z])|ai(?![A-Za-z]))/i
]
const GITHOOKS_AI_DOMAIN = new RegExp(
  `@(?:[A-Za-z0-9-]+\\.)*(?:${AI_ATTRIBUTION.domains.map((domain) => domain.replace(GITHOOKS_ESCAPE, '\\$&')).join('|')})(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`,
  'i'
)
// A GitHub bot address: the login (after an optional "<id>+") ends in [bot].
const GITHOOKS_GITHUB_BOT = /(?:\d+\+)?([A-Za-z0-9-]+)\[bot\]@users\.noreply\.github\.com/gi
const GITHOOKS_AI_LOGIN_NAMES = [...AI_ATTRIBUTION.names, ...AI_ATTRIBUTION.qualified.map(({ name }) => name)].map((name) =>
  name.toLowerCase().replace(/ /g, '')
)

/** Whether a trailer line names an AI model, assistant or vendor, as AI_ATTRIBUTION lists them. */
function githooksNamesAi(line) {
  if (GITHOOKS_AI_NAME.test(line) || GITHOOKS_AI_DOMAIN.test(line)) return true
  if (GITHOOKS_AI_QUALIFIED.some((pattern) => pattern.test(line))) return true
  for (const [, login] of line.matchAll(GITHOOKS_GITHUB_BOT)) {
    const plain = login.toLowerCase()
    if (GITHOOKS_AI_LOGIN_NAMES.some((name) => plain.includes(name))) return true
  }
  return false
}

// A trailer whose key ends in -by or -with: Co-authored-by, Signed-off-by, Assisted-by, Generated-with.
const GITHOOKS_ATTRIBUTION_TRAILER = /^[A-Za-z0-9][A-Za-z0-9-]*-(?:by|with)[ \t]*:/i
// type(scope)!: description, after any of git's fixup!, squash! and amend! prefixes.
const GITHOOKS_CONVENTIONAL = /^(?:(?:fixup|squash|amend)! )*[a-z]+(?:\([^()\s][^()]*\))?!?: \S/
const GITHOOKS_ZERO_OID = /^0+$/

/** The comment prefix of commit messages: core.commentString or core.commentChar, '#' by default and for "auto". */
function githooksCommentPrefix() {
  for (const key of ['core.commentString', 'core.commentChar']) {
    let value = ''
    try {
      value = git('config', '--get', key)
    } catch {
      // Unset.
    }
    if (value !== '' && value !== 'auto') return value
  }
  return '#'
}

/**
 * The message as git stores it with the default cleanup: comment lines and everything from
 * the scissors line of `git commit -v` down are dropped, trailing spaces trimmed, runs of
 * blank lines collapsed, and blank lines at the start and the end removed.
 */
function githooksCleanMessage(text, comment) {
  const scissors = `${comment} ------------------------ >8 ------------------------`
  const kept = []
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    if (line === scissors) break
    if (line.startsWith(comment)) continue
    kept.push(line.trimEnd())
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '')
}

/** The attribution trailers of a message that name a model, an assistant or its vendor, as problems. */
function githooksAttributionProblems(message) {
  const problems = []
  for (const line of message.split('\n').slice(1)) {
    if (!GITHOOKS_ATTRIBUTION_TRAILER.test(line)) continue
    if (!githooksNamesAi(line)) continue
    problems.push({
      file: '',
      line: 0,
      message: `the trailer "${line.trim()}" names an AI model, assistant or vendor, and aiAttribution is "forbid" in .resaledger.json. Remove the trailer`
    })
  }
  return problems
}

/** The task with an id in the tasks folder of a reader, parsed, or null when it has no file there. */
function githooksTaskIn(reader, dir, id) {
  const folder = `${dir}/tasks/`
  const names = reader
    .list(`${dir}/tasks`)
    .map((path) => path.slice(folder.length))
    .filter((name) => !name.includes('/'))
  const name = taskFileFor(names, id)
  return name === null ? null : parseTask(`${folder}${name}`, reader.read(`${folder}${name}`) ?? '')
}

/**
 * The commits a merge being concluded brings in, from MERGE_HEAD (one per line), or [] when none
 * is. Unlike githooksMergeHeads, a MERGE_HEAD that cannot be read stops commit-msg.
 */
function githooksConcludedMergeHeads(root) {
  let text
  try {
    const path = git('rev-parse', '--git-path', 'MERGE_HEAD')
    text = readFileSync(isAbsolute(path) ? path : join(root, path), 'utf8')
  } catch {
    return []
  }
  const heads = text.split('\n').filter((line) => line.trim() !== '')
  const resolved = heads.map((line) => githooksCommit(line.trim()))
  if (resolved.includes(null)) fail('cannot read MERGE_HEAD, so this merge is not checked')
  return resolved
}

/**
 * What commit-msg judges, spec 5.9: { parents, paths, exemption }. While a merge is concluded,
 * paths are the code paths the merge changes of its own, and none exempts it. Otherwise paths
 * are the staged ones against HEAD; when nothing is staged and HEAD is not a merge (as in
 * `commit --amend` with only a new message), HEAD's own paths against its parent are judged too,
 * so dropping the trailer from a code commit is refused. A real revert is exempt.
 */
function githooksJudged(root, config, head, message) {
  const mergeHeads = head === null ? [] : githooksConcludedMergeHeads(root)
  if (mergeHeads.length > 0) {
    const parents = [head, ...mergeHeads]
    const paths = mergeOwnPaths(root, config, parents, null)
    return { parents, paths, exemption: paths.length === 0 ? 'merge' : null }
  }
  let paths = githooksStagedPaths()
  let parent = head
  let target = null
  if (head !== null && paths.length === 0) {
    const [current] = readCommits(root, ['--no-walk', head])
    if (current === undefined || current.hash !== head) fail('cannot read HEAD, so this commit is not checked')
    if (current.parents.length < 2) {
      paths = commitPaths(root, head)
      parent = current.parents[0] ?? null
      target = head
    }
  }
  const revert = paths.some((path) => isCode(path, config)) && isRevert(root, message, parent, target)
  return { parents: [], paths, exemption: revert ? 'revert' : null }
}

/**
 * The commit-msg hook, given the message file. The message is cleaned as git will store it,
 * then judged: attribution trailers when aiAttribution is "forbid" (on every commit), the
 * Conventional Commits header when commitStyle is "conventional" (not on a merge or a real
 * revert), and the task trailers against the staged tree (the index in GIT_INDEX_FILE), with
 * the rules checkRange applies to one commit and HEAD as the start (see githooksJudged).
 */
function commitMsg(file) {
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    fail(`cannot read the commit message file ${file}: ${error.message}`)
  }
  const message = githooksCleanMessage(text, githooksCommentPrefix())
  const reader = treeReader({ kind: 'index', root })
  const { config, problems: configProblems } = loadConfig(reader)
  if (!config) githooksRefuse(configProblems)

  const head = githooksCommit('HEAD')
  let judged
  try {
    judged = githooksJudged(root, config, head, message)
  } catch (error) {
    fail(`${error.message}; the commit is refused`)
  }
  const subject = message.split('\n')[0]
  const commit = { short: '', committer: '', subject, message, ...judged }
  const problems = config.aiAttribution === 'forbid' ? githooksAttributionProblems(message) : []
  if (commit.parents.length < 2 && commitExemption(commit, { skipGitHubMerges: false }) === null && config.commitStyle === 'conventional' && !GITHOOKS_CONVENTIONAL.test(subject)) {
    problems.unshift({
      file: '',
      line: 0,
      message: `the header "${subject}" does not follow Conventional Commits, and commitStyle is "conventional" in .resaledger.json. Write "type(scope): description", for example "feat(server): store documents"`
    })
  }
  const headReader = head === null ? null : treeReader({ kind: 'commit', rev: head, root })
  problems.push(
    ...checkCommit(commit, {
      config,
      lane: currentLane(),
      skipGitHubMerges: false,
      task: (id) => githooksTaskIn(reader, config.dir, id),
      startLane: (id) => (headReader === null ? null : (githooksTaskIn(headReader, config.dir, id)?.lane ?? null))
    })
  )
  if (problems.length > 0) githooksRefuse(problems)
}

/** The merge base of two revisions, or null when they have none. */
function githooksMergeBase(a, b) {
  try {
    return git('merge-base', a, b) || null
  } catch {
    return null
  }
}

/**
 * The lines of a push as [localRef, localOid, remoteRef, remoteOid]: git's stdin, or, when it
 * is empty, the variables the pre-commit framework sets instead of passing stdin on.
 */
function githooksPushLines(input, env) {
  const lines = String(input)
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 4)
  if (lines.length > 0 || !env.PRE_COMMIT_REMOTE_BRANCH) return lines
  const localRef = env.PRE_COMMIT_LOCAL_BRANCH || 'HEAD'
  const localOid = githooksCommit(env.PRE_COMMIT_TO_REF || localRef)
  if (localOid === null) return []
  const remoteOid = (env.PRE_COMMIT_FROM_REF && githooksCommit(env.PRE_COMMIT_FROM_REF)) || '0'.repeat(localOid.length)
  return [[localRef, localOid, env.PRE_COMMIT_REMOTE_BRANCH, remoteOid]]
}

/**
 * Where the commits a push adds start: the remote commit when git has it; otherwise the merge
 * base with the remote's base branch; otherwise, for a branch other than the base, the merge
 * base with the local base branch. null means every ancestor; prePush moves any start older
 * than the commit that added .resaledger.json up to that commit (adoptionStart), as handoff does.
 */
function githooksPushStart(localOid, remoteOid, remote, branch, config) {
  if (!GITHOOKS_ZERO_OID.test(remoteOid) && githooksCommit(remoteOid) !== null) return remoteOid
  const remoteBase = remote ? githooksCommit(`refs/remotes/${remote}/${config.base}`) : null
  if (remoteBase !== null) {
    const start = githooksMergeBase(localOid, remoteBase)
    if (start !== null) return start
  }
  if (branch !== config.base) {
    const localBase = githooksCommit(`refs/heads/${config.base}`)
    const start = localBase === null ? null : githooksMergeBase(localOid, localBase)
    if (start !== null) return start
  }
  return null
}

/**
 * The pre-push hook, given git's lines on stdin and its arguments (the remote's name and URL).
 * For each pushed branch: no push to a protected branch and no deletion of one, and the
 * commits the push adds pass checkRange with the local branch as the lane. Tags are skipped.
 * The rules (githooksWithRules) come from the remote's base branch as last fetched, else from
 * local HEAD, so a pushed commit cannot loosen them. The rest of the configuration is the
 * pushed commit's own; a pushed commit without one is judged by the rules' configuration.
 */
function prePush(input, args = []) {
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }
  const remote = args[0] || process.env.PRE_COMMIT_REMOTE_NAME || ''
  const local = githooksCommittedConfig(root, githooksCommit('HEAD'))?.config ?? null
  const tracked = remote ? githooksCommit(`refs/remotes/${remote}/${local?.base ?? DEFAULTS.base}`) : null
  const rules = githooksCommittedConfig(root, tracked)?.config ?? local
  const problems = []
  const lines = githooksPushLines(input, process.env)
  for (const [localRef, localOid, remoteRef, remoteOid] of lines) {
    if (!remoteRef.startsWith('refs/heads/')) continue
    const branch = remoteRef.slice('refs/heads/'.length)
    const refuse = (message) => problems.push(`${branch}: ${message}`)
    const deletion = GITHOOKS_ZERO_OID.test(localOid)
    if (!deletion && githooksCommit(localOid) === null) continue
    const own = deletion ? null : githooksCommittedConfig(root, localOid)
    if (own && !own.config) {
      for (const { file, line, message } of own.problems) refuse(`${file}${line ? `:${line}` : ''}: ${message}`)
      continue
    }
    if (!own && !rules) {
      if (!deletion) refuse(`the pushed commit has no ${CONFIG_FILE}, and neither has HEAD, so there are no rules to judge it by. Commit the configuration first`)
      continue
    }
    const config = githooksWithRules(own?.config ?? rules, rules)
    if (config.protected.includes(branch)) {
      refuse(
        deletion
          ? `"${branch}" is a protected branch, so it is not deleted`
          : `"${branch}" is a protected branch, so nothing is pushed to it directly, not even a fast-forward merge, which no commit hook sees. Push a lane branch and open a pull request`
      )
      continue
    }
    if (deletion) continue
    const lane = localRef.startsWith('refs/heads/') ? localRef.slice('refs/heads/'.length) : branch
    const from = adoptionStart(root, githooksPushStart(localOid, remoteOid, remote, branch, config), localOid)
    for (const { file, line, message } of checkRange(from, localOid, { config, lane, skipGitHubMerges: false, root })) {
      refuse(`${file}${line ? `:${line}` : ''}: ${message}`)
    }
  }
  if (problems.length === 0 && lines.length > 0 && githooksUsesLfs(root, lines)) {
    githooksLfsPrePush(root, input, lines, [remote, args[1] || process.env.PRE_COMMIT_REMOTE_URL || ''])
  }
  if (problems.length === 0) return
  console.error('✖ This push is refused')
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

// filter=lfs outside a comment; git grep gets -G so that grep.patternType cannot change it.
const GITHOOKS_LFS_RULE = '^[^#]*filter=lfs'

/**
 * Whether Git LFS is in use for this push: filter=lfs outside a comment in the repository's
 * own attributes (info/attributes and the file core.attributesFile names, or git's default
 * global attributes file when it is unset), or in a
 * .gitattributes file, at the root or in a folder, of the index or of the tree of a pushed
 * commit, since a branch can bring Git LFS before the checkout has it. Two small file reads,
 * one git grep over the index and one per distinct pushed object id.
 */
function githooksUsesLfs(root, lines) {
  const rule = new RegExp(GITHOOKS_LFS_RULE)
  const names = (file) => {
    let text = ''
    try {
      text = readFileSync(isAbsolute(file) ? file : join(root, file), 'utf8')
    } catch {}
    return text.split(/\r?\n/).some((line) => rule.test(line))
  }
  const info = spawnSync('git', ['rev-parse', '--git-path', 'info/attributes'], { cwd: root, encoding: 'utf8', windowsHide: true })
  if (info.status === 0 && names(info.stdout.trim())) return true
  const named = spawnSync('git', ['config', '--get', 'core.attributesFile'], { cwd: root, encoding: 'utf8', windowsHide: true })
  // Unset, git reads its default: $XDG_CONFIG_HOME/git/attributes, else ~/.config/git/attributes.
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const file = named.status === 0 ? named.stdout.trim().replace(/^~(?=$|[/\\])/, () => homedir()) : join(xdg, 'git', 'attributes')
  if (file && names(file)) return true
  const grep = (...where) =>
    spawnSync('git', ['grep', '-q', '-G', '-e', GITHOOKS_LFS_RULE, ...where, '--', ':(glob)**/.gitattributes'], { cwd: root, stdio: 'ignore', windowsHide: true }).status === 0
  if (grep('--cached')) return true
  const pushed = new Set(lines.map((line) => line[1]).filter((oid) => !GITHOOKS_ZERO_OID.test(oid)))
  for (const oid of pushed) if (grep(oid)) return true
  return false
}

/**
 * Runs Git LFS's pre-push, as the hook Git LFS would have written does, with the same
 * arguments and refs, and exits with its code; its output reaches the user unchanged. Without
 * git-lfs the push is refused with Git LFS's advice, adapted: this hook is ResaLedger's.
 */
function githooksLfsPrePush(root, input, lines, args) {
  const version = spawnSync('git', ['lfs', 'version'], { cwd: root, stdio: 'ignore', windowsHide: true })
  if (version.error || version.status !== 0) {
    console.error('✖ This push is refused')
    console.error(
      "  this push uses Git LFS (filter=lfs in a .gitattributes file or in git's attributes), but git-lfs was not found on your PATH, so the push would send LFS pointers without their objects. Install Git LFS and push again: ResaLedger's pre-push hook runs \"git lfs pre-push\" itself. If the repository no longer uses Git LFS, remove filter=lfs from its .gitattributes files and git's attributes"
    )
    process.exit(1)
  }
  const refs = String(input).trim() ? String(input) : lines.map((line) => `${line.join(' ')}\n`).join('')
  const result = spawnSync('git', ['lfs', 'pre-push', ...args], { cwd: root, input: refs, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true })
  if (result.error) fail(`git lfs pre-push could not run: ${result.error.message}`)
  process.exit(result.status ?? 1)
}

// --- handoff.mjs ---
// The end-of-session check (spec 8): the records are valid, the README is written, the hooks are
// active, the tree is clean, the gates passed on this code, every task in progress has a current
// handoff note, the unpushed commits are recorded and, in the team preset, the lane is pushed.

const HANDOFF_SHOWN_PATHS = 5
const HANDOFF_NAMING_COMMITS = 200
const HANDOFF_FALLBACK_COMMITS = 50
const HANDOFF_MAX_BUFFER = 256 * 1024 * 1024

/** Runs git in a folder: { ok, out } with stdout untrimmed, never throws on git's own failure. */
function handoffGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: HANDOFF_MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  return { ok: result.status === 0, out: result.stdout }
}

/** The full id of a revision, or null when it does not resolve to a commit. */
function handoffCommit(root, rev) {
  const { ok, out } = handoffGit(root, ['rev-parse', '--verify', '-q', `${rev}^{commit}`])
  return ok ? out.trim() : null
}

/** The paths of `git status --porcelain`, renames as their new path. */
function handoffDirtyPaths(root) {
  const { ok, out } = handoffGit(root, ['status', '--porcelain=v1', '-z'])
  if (!ok) throw new Error('git status failed')
  const records = out.split('\0')
  const paths = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.length < 4) continue
    paths.push(record.slice(3))
    // A rename or copy is followed by its original path, which is the same change.
    if (record[0] === 'R' || record[0] === 'C') index += 1
  }
  return paths
}

/** Whether a section body holds content: a line that is neither blank nor a heading. */
function handoffHasContent(body) {
  return body.split('\n').some((line) => line.trim() !== '' && !/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line))
}

/**
 * Where this lane's own commits start, as a full commit id, or null for every commit:
 * the upstream when the branch has one; otherwise the fork point from the base branch when
 * this is not the base and the base exists locally; otherwise null. `kind` names the choice.
 */
function handoffLaneStart(root, config, lane) {
  if (lane !== null) {
    const upstream = handoffCommit(root, '@{upstream}')
    if (upstream !== null) return { kind: 'upstream', from: upstream }
  }
  if (lane !== config.base && handoffCommit(root, `refs/heads/${config.base}`) !== null) {
    const { ok, out } = handoffGit(root, ['merge-base', `refs/heads/${config.base}`, 'HEAD'])
    if (ok && out.trim() !== '') return { kind: 'base', from: out.trim() }
  }
  return { kind: 'none', from: null }
}

/**
 * The range of unpushed commits that handoff checks: from the upstream; else from the base
 * branch; else since the newest commit that added a stamp; else since the commit that added
 * .resaledger.json; else the last 50 commits. No range reaches past the commit that added
 * .resaledger.json, so the commits a project made before it adopted ResaLedger are never
 * judged. `from` null means every ancestor of HEAD. The stamp for the code at HEAD, which
 * this session may just have committed, does not count: the range starts at the stamp before it.
 */
function handoffUnpushedRange(root, config, lane, currentStamp) {
  const chosen = handoffChosenStart(root, config, lane, currentStamp)
  const from = adoptionStart(root, chosen.from, 'HEAD')
  return from === chosen.from ? chosen : { kind: 'adoption', from }
}

/** The start of the unpushed range before adoption bounds it: { kind, from }. */
function handoffChosenStart(root, config, lane, currentStamp) {
  const start = handoffLaneStart(root, config, lane)
  if (start.kind !== 'none') return start
  const pathspec = [`${config.dir}/verified/`]
  if (currentStamp !== null) pathspec.push(`:(exclude)${currentStamp}`)
  const stamped = handoffGit(root, ['log', '-1', '--diff-filter=A', '--format=%H', 'HEAD', '--', ...pathspec])
  if (stamped.ok && stamped.out.trim() !== '') return { kind: 'stamp', from: stamped.out.trim() }
  const adopted = adoptionCommit(root, 'HEAD')
  if (adopted !== null) return { kind: 'adoption', from: adopted }
  return { kind: 'recent', from: handoffCommit(root, `HEAD~${HANDOFF_FALLBACK_COMMITS}`) }
}

/**
 * The commits of a rev-list range, newest first, as [{ hash, short, ids }] with the ids of their
 * Task: trailers. Read with readCommits, never from formatted output; throws when a commit
 * cannot be read, so handoff refuses rather than passes.
 */
function handoffNamingCommits(root, rangeArgs) {
  // Object.assign keeps short as the lazy getter readCommits gives it.
  return readCommits(root, rangeArgs).map((commit) => Object.assign(commit, { ids: taskTrailers(commit.message).ids }))
}

/**
 * Whether a commit changes code. A records-only commit that names a task, such as a claim or a
 * stamp, does not make its handoff stale: the note follows the work, not the bookkeeping.
 */
function handoffChangesCode(root, config, hash) {
  const { ok, out } = handoffGit(root, ['diff-tree', '--no-commit-id', '--root', '-r', '--name-only', '-z', hash])
  return ok && out.split('\0').some((path) => path !== '' && isCode(path, config))
}

/** Problems with the handoff notes of the doing tasks this lane holds. */
function handoffNoteProblems(root, config, lane, tasks, dirty) {
  const held = tasks.filter((task) => task.status === 'doing' && task.lane === lane && task.id)
  if (held.length === 0) return []
  const problems = []
  const start = handoffLaneStart(root, config, lane)
  // The commits on this lane since the base, or the last 200 when where the lane starts is unclear.
  const rangeArgs = start.kind === 'base' ? [`${start.from}..HEAD`] : ['-n', String(HANDOFF_NAMING_COMMITS), 'HEAD']
  const commits = handoffNamingCommits(root, rangeArgs)
  const dirtyFiles = new Set(dirty)
  for (const task of held) {
    const section = task.sections.handoff
    if (section === null || !handoffHasContent(section.body)) {
      problems.push({
        file: task.file,
        line: section ? section.line : task.titleLine,
        message: `${task.id} is in progress in this lane without a handoff note: write the exact next step in its ## Handoff`
      })
      continue
    }
    const naming = commits.find((commit) => commit.ids.includes(task.id) && handoffChangesCode(root, config, commit.hash))
    if (!naming || dirtyFiles.has(task.file)) continue
    const changed = handoffGit(root, ['log', '-1', '--format=%H', 'HEAD', '--', task.file])
    const fileCommit = changed.ok ? changed.out.trim() : ''
    const current = fileCommit !== '' && handoffGit(root, ['merge-base', '--is-ancestor', naming.hash, fileCommit]).ok
    if (!current) {
      problems.push({
        file: task.file,
        line: section.line,
        message: `${task.id}'s handoff is older than your last commit on it (${naming.short}): rewrite it`
      })
    }
  }
  return problems
}

/** Problems with pushing the lane: no upstream, or commits the upstream does not have. */
function handoffPushProblems(root, lane) {
  if (handoffCommit(root, '@{upstream}') === null) {
    return [{ file: '', line: 0, message: `the lane "${lane}" is not pushed: run git push -u origin HEAD` }]
  }
  const { ok, out } = handoffGit(root, ['rev-list', '--count', '@{upstream}..HEAD'])
  const ahead = ok ? Number(out.trim()) : 0
  if (ahead === 0) return []
  return [{ file: '', line: 0, message: `the lane "${lane}" has ${ahead} unpushed commit${ahead === 1 ? '' : 's'}: run git push` }]
}

/**
 * Every reason the session cannot end yet, as problems { file, line, message }, in the order
 * spec 8 lists them. context is { root, config, lane }, with lane the current branch, or null
 * in a detached HEAD, which skips the checks that need a lane.
 */
function handoffProblems(context) {
  const { config } = context
  const root = context.root ?? repositoryRoot()
  const lane = context.lane ?? null
  const problems = []

  const reader = treeReader({ kind: 'worktree', root })
  const workspace = loadWorkspace(reader, config)
  problems.push(...checkWorkspace(workspace, reader, config))
  if (workspace.readme !== null) problems.push(...readmeMarkerProblems(workspace.readme))

  if (!hooksActive(root)) problems.push({ file: '', line: 0, message: 'the git hooks are not active in this clone: run work or hooks --activate' })

  const dirty = handoffDirtyPaths(root)
  if (dirty.length > 0) {
    const shown = dirty.slice(0, HANDOFF_SHOWN_PATHS).join(', ')
    const more = dirty.length > HANDOFF_SHOWN_PATHS ? ` and ${dirty.length - HANDOFF_SHOWN_PATHS} more` : ''
    problems.push({
      file: '',
      line: 0,
      message: `the tree has ${dirty.length} uncommitted path${dirty.length === 1 ? '' : 's'} (${shown}${more}): commit them or remove them; uncommitted work is not a handoff`
    })
  }

  if (handoffCommit(root, 'HEAD') === null) {
    problems.push({ file: '', line: 0, message: 'there is no commit yet: commit your work first' })
    return problems
  }

  let currentStamp = null
  if (config.gates.verify.length > 0) {
    const code = fingerprint({ kind: 'commit', rev: 'HEAD', root }, config)
    currentStamp = stampPath(config, code)
    if (verifiedStamp(reader, config, code) === null) {
      problems.push({
        file: currentStamp,
        line: 0,
        message: 'the gates have not passed on the code at HEAD: run verify and commit the stamp with your records'
      })
    }
  }

  if (lane !== null) problems.push(...handoffNoteProblems(root, config, lane, workspace.tasks, dirty))

  const range = handoffUnpushedRange(root, config, lane, currentStamp)
  problems.push(...checkRange(range.from, 'HEAD', { config, lane, skipGitHubMerges: false, root }))

  if (config.requirePushed && lane !== null) problems.push(...handoffPushProblems(root, lane))
  return problems
}

/** handoff's message when it fails: a headline and one line per problem. */
function handoffReport(problems) {
  const lines = problems.map(({ file, line, message }) => `  ${file ? `${file}${line ? `:${line}` : ''}: ` : ''}${message}`)
  return ['✖ Not ready to hand off', ...lines].join('\n')
}

/** handoff: the end-of-session check. Prints one line when the session may end; otherwise each problem, and exits 1. */
function handoffCommand(args = []) {
  for (const arg of args) fail(`unknown option "${arg}" for handoff; it takes no options`)
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }
  const { config, problems: configProblems } = loadConfig(treeReader({ kind: 'worktree', root }))
  if (!config) {
    console.error(handoffReport(configProblems))
    process.exit(1)
  }
  const lane = currentLane()
  let problems
  try {
    problems = handoffProblems({ root, config, lane })
  } catch (error) {
    fail(error.message)
  }
  if (problems.length > 0) {
    console.error(handoffReport(problems))
    process.exit(1)
  }
  const parts = ['records valid']
  parts.push(config.gates.verify.length > 0 ? 'the gates passed on this code' : 'no verify gates to pass')
  if (lane === null) parts.push('detached HEAD, so no lane checks')
  else {
    parts.push('every task in progress has a current handoff note')
    if (config.requirePushed) parts.push('the lane is pushed')
  }
  console.log(`✔ handed off: ${parts.join(', ')}`)
}

// --- agents.mjs ---
// Agent hooks (spec 11): one entry point, hook <agent> <event>, for the agents that have hooks,
// and the configurations that call it. Each agent has an input adapter that turns its JSON into
// an action; the rules are shared. The contract every adapter keeps:
// - a refusal is exit code 2 with the reason on stderr;
// - input the adapter does not recognise is allowed, never blocked: git hooks and CI still hold;
// - the guard finds the repository root itself, from the input's cwd or the current folder;
// - it stays fast: git is asked only what the action needs.
//
// The shell parser reads commands well enough that text inside quotes is never taken for an
// option, a command or a redirection. What it does not parse, and therefore does not see:
// - a `cd` only moves the folder for the commands after it in the same script, subshells too;
// - aliases, functions, `source`d scripts, scripts run from files, and variables: a word with
//   an unexpanded $VAR or a glob is never a path the guard checks;
// - `case` patterns, whose ")" ends a command early (the commands still parse, a bit split);
// - `find -exec`, `git` aliases and `env -S`;
// - file edits through tools other than redirections, tee and sed -i (cp, mv, perl -i …).

const AGENT_NAMES = Object.freeze(['claude', 'codex', 'cursor', 'gemini', 'copilot'])
const AGENT_EVENTS = Object.freeze(['session-start', 'pre-tool', 'stop'])

// How long a session's state is kept under .git, in days.
const AGENTS_SESSION_DAYS = 14
const AGENTS_REMINDER_PROBLEMS = 5
const AGENTS_WORK_TIMEOUT = 15 * 1000

// The input adapters. tool(input) turns a tool call into an action, or null when the tool is
// none of the guard's business or its input is not recognised:
//   { kind: 'shell', command }   a shell command, as text
//   { kind: 'edit', paths }      file edits, paths absolute or relative to the session's folder
// session(input), when an adapter has one, returns { id, cwd }; the default reads session_id
// and cwd, which Claude Code and Codex both send with every event.

function agentsIsObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The paths an apply_patch envelope adds, updates, deletes or moves to. */
function patchPaths(patch) {
  const paths = []
  for (const line of String(patch).split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/)
    if (match) paths.push(match[1].trim())
  }
  return paths
}

/** A command given as an argument list: the script of "bash -lc <script>", or the words quoted. */
function agentsArgvCommand(argv) {
  if (!argv.every((word) => typeof word === 'string') || argv.length === 0) return null
  if (argv.length === 3 && /(?:^|\/)(?:ba|z|da|k)?sh$/.test(argv[0]) && /^-\w*c$/.test(argv[1])) return argv[2]
  return argv.map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)).join(' ')
}

/** A tool's arguments as an object: the object itself, or a JSON text of one; null otherwise. */
function agentsToolArgs(args) {
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return null
    }
  }
  return agentsIsObject(args) ? args : null
}

/** The first of the named fields of args that holds a non-empty string, or null. */
function agentsStringField(args, names) {
  const name = names.find((key) => typeof args[key] === 'string' && args[key] !== '')
  return name === undefined ? null : args[name]
}

const AGENTS_PATH_FIELDS = ['file_path', 'path', 'target_file', 'filePath']

/**
 * Claude Code's tool input, which the Copilot CLI also sends when it runs the hooks of
 * .claude/settings.json: tool_name and tool_input, with Claude's tool names.
 */
function agentsClaudeTool(input) {
  const args = input.tool_input
  if (!agentsIsObject(args)) return null
  if (input.tool_name === 'Bash') return typeof args.command === 'string' ? { kind: 'shell', command: args.command } : null
  if (['Edit', 'Write', 'MultiEdit'].includes(input.tool_name)) return typeof args.file_path === 'string' ? { kind: 'edit', paths: [args.file_path] } : null
  if (input.tool_name === 'NotebookEdit') return typeof args.notebook_path === 'string' ? { kind: 'edit', paths: [args.notebook_path] } : null
  return null
}

// Each adapter may also have:
//   session(input)       { id, cwd } from the agent's own field names;
//   startOutput(text)    what session start prints, for an agent whose stdout must be JSON;
//   deny(message)        the agent's JSON for a refused tool, printed besides exit code 2;
//   remind(message)      the agent's JSON for the end-of-turn reminder, when exit code 2 is
//                        not how that agent's end-of-turn hook continues the agent;
//   turnsOnHooks(input)  true for a call that turns on the git hooks when it is the session's first.
const AGENT_ADAPTERS = {
  claude: { tool: agentsClaudeTool },
  codex: {
    tool(input) {
      const args = input.tool_input
      if (!agentsIsObject(args)) return null
      const command = Array.isArray(args.command) ? agentsArgvCommand(args.command) : args.command
      if (typeof command !== 'string') return null
      if (input.tool_name === 'apply_patch') return { kind: 'edit', paths: patchPaths(command) }
      if (['Bash', 'shell', 'local_shell', 'exec_command'].includes(input.tool_name)) return { kind: 'shell', command }
      return null
    }
  },
  cursor: {
    // Every Cursor hook sends conversation_id; sessionStart also sends session_id.
    session: (input) => ({
      id: input.conversation_id ?? input.session_id,
      cwd: typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : undefined
    }),
    tool(input) {
      // beforeShellExecution sends the command and its folder at the top level.
      if (typeof input.command === 'string' && input.tool_name === undefined) return { kind: 'shell', command: input.command }
      const args = agentsToolArgs(input.tool_input)
      if (args === null || typeof input.tool_name !== 'string') return null
      if (/^(?:shell|terminal|run_terminal_cmd|run_terminal_command)$/i.test(input.tool_name)) {
        return typeof args.command === 'string' ? { kind: 'shell', command: args.command, cwd: agentsStringField(args, ['cwd', 'working_directory']) } : null
      }
      if (/^(?:write|edit|strreplace|str_replace|multiedit|search_replace|edit_file|delete|delete_file)$/i.test(input.tool_name)) {
        const path = agentsStringField(args, AGENTS_PATH_FIELDS)
        return path === null ? null : { kind: 'edit', paths: [path] }
      }
      return null
    },
    turnsOnHooks: (input) => typeof input.command === 'string' && input.tool_name === undefined,
    startOutput: (text) => JSON.stringify({ additional_context: text }),
    deny: (message) => ({ permission: 'deny', user_message: message, agent_message: message }),
    remind: (message) => ({ followup_message: message })
  },
  gemini: {
    tool(input) {
      const args = agentsToolArgs(input.tool_input)
      if (args === null) return null
      if (input.tool_name === 'run_shell_command') {
        return typeof args.command === 'string' ? { kind: 'shell', command: args.command, cwd: agentsStringField(args, ['dir_path', 'directory']) } : null
      }
      if (['write_file', 'replace'].includes(input.tool_name)) {
        const path = agentsStringField(args, AGENTS_PATH_FIELDS)
        return path === null ? null : { kind: 'edit', paths: [path] }
      }
      return null
    },
    startOutput: (text) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }),
    deny: (message) => ({ decision: 'deny', reason: message })
  },
  copilot: {
    session: (input) => ({ id: input.sessionId ?? input.session_id, cwd: input.cwd }),
    tool(input) {
      // Claude Code's shape, which Copilot sends to hooks under Claude's event names.
      if (input.tool_name !== undefined) return agentsClaudeTool(input)
      if (typeof input.toolName !== 'string') return null
      const name = input.toolName.toLowerCase()
      if (name === 'apply_patch') {
        const patch = typeof input.toolArgs === 'string' && input.toolArgs.includes('*** Begin Patch') ? input.toolArgs : agentsStringField(agentsToolArgs(input.toolArgs) ?? {}, ['input', 'patch'])
        return patch === null ? null : { kind: 'edit', paths: patchPaths(patch) }
      }
      const args = agentsToolArgs(input.toolArgs)
      if (args === null) return null
      if (name === 'bash' || name === 'shell') return typeof args.command === 'string' ? { kind: 'shell', command: args.command } : null
      if (['edit', 'create', 'write', 'str_replace', 'str_replace_editor'].includes(name)) {
        const path = agentsStringField(args, AGENTS_PATH_FIELDS)
        return path === null ? null : { kind: 'edit', paths: [path] }
      }
      return null
    },
    startOutput: (text) => JSON.stringify({ additionalContext: text }),
    deny: (message) => ({ permissionDecision: 'deny', permissionDecisionReason: message }),
    remind: (message) => ({ decision: 'block', reason: message })
  }
}

// The shell parser.

/** The index of the ")" that closes a "(" just before start, skipping quotes; text.length when none. */
function agentsClosingParen(text, start) {
  let depth = 1
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (char === '\\') index++
    else if (char === "'") {
      const end = text.indexOf("'", index + 1)
      index = end === -1 ? text.length : end
    } else if (char === '"') {
      index++
      while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1
    } else if (char === '(') depth++
    else if (char === ')' && --depth === 0) return index
  }
  return text.length
}

/**
 * The expansion that starts at text[index] ("$" or a backtick): { end, script, literal }.
 * script is the text of a command substitution, to be parsed too; literal is true for a lone "$".
 */
function agentsExpansion(text, index) {
  if (text[index] === '`') {
    let end = index + 1
    while (end < text.length && text[end] !== '`') end += text[end] === '\\' ? 2 : 1
    return { end: Math.min(end + 1, text.length), script: text.slice(index + 1, end) }
  }
  const next = text[index + 1]
  if (next === '(') {
    const close = agentsClosingParen(text, index + 2)
    if (text[index + 2] === '(') return { end: close + 1 } // arithmetic
    return { end: close + 1, script: text.slice(index + 2, close) }
  }
  if (next === '{') {
    const close = text.indexOf('}', index + 2)
    return { end: close === -1 ? text.length : close + 1 }
  }
  const name = text.slice(index + 1).match(/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/)
  if (name) return { end: index + 1 + name[0].length }
  return { end: index + 1, literal: true }
}

const AGENTS_REDIRECT = /^(?:<<<|<<-|<<|<>|<&|>>|>&|>\||<|>)/
const AGENTS_KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'esac', 'time'])

/**
 * Splits a script into simple commands without running anything. Each command is { words,
 * redirects, heredocs, nested, separator } with words { value, quoted, dynamic }, redirects
 * { op, target }, the bodies of its here-documents, and the scripts of the command and process
 * substitutions in its words, which run before it.
 */
function agentsTokenize(text) {
  const commands = []
  const pending = [] // here-documents whose bodies start after the next newline
  let command = { words: [], redirects: [], heredocs: [], nested: [], separator: '' }
  let word = null
  let redirect = null
  const startWord = () => {
    if (word === null) word = { value: '', quoted: false, dynamic: false }
    return word
  }
  const endWord = () => {
    if (word === null) return
    if (redirect) command.redirects.push({ op: redirect, target: word })
    else command.words.push(word)
    word = null
    redirect = null
  }
  const endCommand = (separator) => {
    endWord()
    redirect = null
    if (command.words.length > 0 || command.redirects.length > 0) {
      command.separator = separator
      commands.push(command)
    }
    command = { words: [], redirects: [], heredocs: [], nested: [], separator: '' }
  }
  const expand = (index) => {
    const expansion = agentsExpansion(text, index)
    if (expansion.script !== undefined) command.nested.push(expansion.script)
    const current = startWord()
    current.value += text.slice(index, expansion.end)
    if (!expansion.literal) current.dynamic = true
    return expansion.end
  }

  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === ' ' || char === '\t' || char === '\r') {
      endWord()
      index++
    } else if (char === '\n') {
      endCommand(';')
      index++
      while (pending.length > 0) {
        const doc = pending.shift()
        const body = []
        while (index < text.length) {
          let end = text.indexOf('\n', index)
          if (end === -1) end = text.length
          const line = text.slice(index, end).replace(/\r$/, '')
          index = end + 1
          if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delimiter) break
          body.push(line)
        }
        doc.command.heredocs.push(body.join('\n'))
      }
    } else if (char === '#' && word === null) {
      const end = text.indexOf('\n', index)
      index = end === -1 ? text.length : end
    } else if (char === '\\') {
      if (text[index + 1] !== '\n') startWord().value += text[index + 1] ?? ''
      index += 2
    } else if (char === "'") {
      const end = text.indexOf("'", index + 1)
      const stop = end === -1 ? text.length : end
      const current = startWord()
      current.value += text.slice(index + 1, stop)
      current.quoted = true
      index = stop + 1
    } else if (char === '$' && text[index + 1] === "'") {
      // ANSI-C quoting: a literal string with backslash escapes.
      let end = index + 2
      while (end < text.length && text[end] !== "'") end += text[end] === '\\' ? 2 : 1
      const current = startWord()
      current.value += text.slice(index + 2, end).replace(/\\(.)/g, '$1')
      current.quoted = true
      index = end + 1
    } else if (char === '"') {
      const current = startWord()
      current.quoted = true
      index++
      while (index < text.length && text[index] !== '"') {
        const inner = text[index]
        if (inner === '\\' && index + 1 < text.length && '$`"\\\n'.includes(text[index + 1])) {
          if (text[index + 1] !== '\n') current.value += text[index + 1]
          index += 2
        } else if (inner === '$' || inner === '`') index = expand(index)
        else {
          current.value += inner
          index++
        }
      }
      index++
    } else if (char === '$' || char === '`') {
      index = expand(index)
    } else if ((char === '<' || char === '>') && text[index + 1] === '(') {
      const close = agentsClosingParen(text, index + 2)
      command.nested.push(text.slice(index + 2, close))
      const current = startWord()
      current.value += text.slice(index, close + 1)
      current.dynamic = true
      index = close + 1
    } else if (char === '&' && text[index + 1] === '>') {
      endWord()
      const op = text[index + 2] === '>' ? '&>>' : '&>'
      redirect = op
      index += op.length
    } else if (char === '<' || char === '>') {
      // A number written right before the operator is the file descriptor, not a word.
      if (word !== null && !word.quoted && !word.dynamic && /^\d+$/.test(word.value)) word = null
      else endWord()
      const op = text.slice(index).match(AGENTS_REDIRECT)[0]
      index += op.length
      if (op === '<<' || op === '<<-') {
        while (text[index] === ' ' || text[index] === '\t') index++
        let delimiter = ''
        while (index < text.length && !/[\s;&|()<>]/.test(text[index])) {
          if (text[index] !== '"' && text[index] !== "'" && text[index] !== '\\') delimiter += text[index]
          index++
        }
        pending.push({ delimiter, strip: op === '<<-', command })
      } else redirect = op
    } else if ('|&;()'.includes(char)) {
      let op = char
      if ((char === '&' || char === '|' || char === ';') && text[index + 1] === char) op = char + char
      else if (char === '|' && text[index + 1] === '&') op = '|&'
      endCommand(op)
      index += op.length
    } else {
      startWord().value += char
      if ('*?['.includes(char) && !word.quoted) word.dynamic = true
      index++
    }
  }
  endCommand('')
  return commands
}

const AGENTS_WRAPPERS = {
  command: { args: [] },
  builtin: { args: [] },
  exec: { args: ['-a'] },
  nohup: { args: [] },
  time: { args: [] },
  nice: { args: ['-n'] },
  sudo: { args: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'] },
  doas: { args: ['-u', '-C'] },
  env: { args: ['-u', '-C', '--unset', '--chdir'], assignments: true },
  xargs: { args: ['-I', '-L', '-n', '-P', '-d', '-E', '-s', '-a'] },
  timeout: { args: ['-s', '-k', '--signal', '--kill-after'], positional: 1 },
  stdbuf: { args: ['-i', '-o', '-e'] }
}
const AGENTS_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/

/** The base name of a command word: "/usr/bin/git" → "git". */
function agentsProgram(word) {
  return word.replace(/^.*\//, '')
}

/**
 * A parsed command without what only wraps the real one: keywords such as "if" and "!",
 * variable assignments, and wrappers such as env, sudo or xargs. Returns
 * { args (strings), words, assignments (strings), redirects, heredocs }.
 */
function agentsSimpleCommand(command) {
  let words = command.words
  const assignments = []
  let changed = true
  while (changed && words.length > 0) {
    changed = false
    while (words.length > 0 && !words[0].quoted && AGENTS_KEYWORDS.has(words[0].value)) {
      words = words.slice(1)
      changed = true
    }
    while (words.length > 0 && AGENTS_ASSIGNMENT.test(words[0].value)) {
      assignments.push(words[0].value)
      words = words.slice(1)
      changed = true
    }
    const wrapper = words.length > 0 ? AGENTS_WRAPPERS[agentsProgram(words[0].value)] : undefined
    if (wrapper) {
      let index = 1
      let positional = wrapper.positional ?? 0
      while (index < words.length) {
        const value = words[index].value
        if (value === '--') {
          index++
          break
        }
        if (wrapper.args.includes(value)) index += 2
        else if (value.startsWith('-') && value.length > 1) index++
        else if (wrapper.assignments && AGENTS_ASSIGNMENT.test(value)) {
          assignments.push(value)
          index++
        } else if (positional > 0) {
          positional--
          index++
        } else break
      }
      words = words.slice(index)
      changed = true
    }
  }
  return { args: words.map((item) => item.value), words, assignments, redirects: command.redirects, heredocs: command.heredocs }
}

/** The script a shell runs with -c ("bash -lc 'git push'"), or null. */
function agentsShellScript(args) {
  if (!/^(?:ba|z|da|k|fi)?sh$/.test(agentsProgram(args[0] ?? ''))) return null
  let script = false
  for (let index = 1; index < args.length; index++) {
    const value = args[index]
    if (value === '-o' || value === '+o' || value === '-O' || value === '+O') index++
    else if (/^[-+][A-Za-z]+$/.test(value)) {
      if (value.startsWith('-') && value.includes('c')) script = true
    } else if (value === '--') continue
    else return script ? value : null
  }
  return null
}

/**
 * The simple commands of a shell script, in the order they run as far as the text shows,
 * including those inside command substitutions, "bash -c" scripts and eval. Each is
 * { args, words, assignments, redirects, heredocs, separator, depth }; depth 0 is the
 * script's own level.
 */
function shellCommands(text, depth = 0) {
  if (depth > 5) return []
  const result = []
  for (const command of agentsTokenize(String(text))) {
    for (const script of command.nested) result.push(...shellCommands(script, depth + 1))
    const simple = { ...agentsSimpleCommand(command), separator: command.separator, depth }
    result.push(simple)
    const script = agentsShellScript(simple.args)
    if (script !== null) result.push(...shellCommands(script, depth + 1))
    if (simple.args[0] === 'eval') result.push(...shellCommands(simple.args.slice(1).join(' '), depth + 1))
  }
  return result
}

/** A command as text for agent.deny: its words, with any word that holds whitespace shown as "…". */
function agentsRenderCommand(command) {
  const words = [...command.assignments, ...command.args].map((value) => (/\s/.test(value) ? '"…"' : value))
  return words.join(' ')
}

// The rules.

const AGENTS_NO_VERIFY = /^--no-veri(?:fy?)?$/
const AGENTS_HOOKS_PATH = /^core\.hookspath$/i

// Options of git subcommands that take the next word as their value, so it is never read as an option.
const AGENTS_GIT_VALUE_OPTIONS = {
  commit: ['-m', '-F', '-c', '-C', '-t', '--message', '--file', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--author', '--date', '--template', '--cleanup', '--trailer', '--pathspec-from-file'],
  push: ['-o', '--push-option', '--repo', '--receive-pack', '--exec'],
  merge: ['-m', '-F', '-s', '-X', '--message', '--file', '--strategy', '--strategy-option', '--into-name'],
  rebase: ['-s', '-X', '-x', '--onto', '--strategy', '--strategy-option', '--exec'],
  checkout: ['-b', '-B', '--orphan', '--conflict', '--pathspec-from-file'],
  switch: ['-c', '-C', '--create', '--force-create', '--orphan', '--conflict'],
  restore: ['-s', '--source', '--conflict', '--pathspec-from-file'],
  reset: ['--pathspec-from-file'],
  clean: ['-e', '--exclude'],
  default: ['-m', '-F', '--message', '--file']
}
const AGENTS_COMMIT_SHORT_VALUES = 'mFcCt'
const AGENTS_COMMIT_SHORT_ATTACHED = 'Su'

/** Splits a git subcommand's arguments into { options, positionals }, skipping option values. */
function agentsGitArguments(sub, args) {
  const takesValue = AGENTS_GIT_VALUE_OPTIONS[sub] ?? AGENTS_GIT_VALUE_OPTIONS.default
  const options = []
  const positionals = []
  for (let index = 0; index < args.length; index++) {
    const value = args[index]
    if (value === '--') {
      positionals.push(...args.slice(index + 1).map((path) => ({ value: path, afterDashes: true })))
      break
    }
    if (value.startsWith('-') && value !== '-') {
      options.push(value)
      if (takesValue.includes(value)) index++
      else if (sub === 'commit' && /^-[A-Za-z]{2,}$/.test(value)) {
        // A cluster such as -am: a letter that takes a value ends it, and the value may follow.
        const letters = value.slice(1)
        const at = [...letters].findIndex((letter) => AGENTS_COMMIT_SHORT_VALUES.includes(letter) || AGENTS_COMMIT_SHORT_ATTACHED.includes(letter))
        if (at === letters.length - 1 && AGENTS_COMMIT_SHORT_VALUES.includes(letters[at])) index++
      }
    } else positionals.push({ value, afterDashes: false })
  }
  return { options, positionals }
}

/** True when a commit's options say --no-verify: the long option or -n, alone or in a cluster. */
function agentsCommitSkipsHooks(options) {
  for (const option of options) {
    if (AGENTS_NO_VERIFY.test(option) || option === '-n') return true
    if (/^-[A-Za-z]{2,}$/.test(option)) {
      for (const letter of option.slice(1)) {
        if (letter === 'n') return true
        if (AGENTS_COMMIT_SHORT_VALUES.includes(letter) || AGENTS_COMMIT_SHORT_ATTACHED.includes(letter)) break
      }
    }
  }
  return false
}

/** The branch a push destination names, or null for a tag or another kind of ref. */
function agentsPushBranch(destination, current) {
  if (destination === 'HEAD' || destination === '@') return current
  if (destination.startsWith('refs/heads/')) return destination.slice('refs/heads/'.length)
  if (destination.startsWith('refs/')) return null
  return destination
}

/**
 * A git command line read up to its subcommand: { folder, settings, sub, rest }. folder is
 * where it runs after any -C, settings the -c and --config-env values, rest the words after sub.
 */
function agentsGitInvocation(args, cwd) {
  let index = 1
  let folder = cwd
  const settings = []
  while (index < args.length) {
    const value = args[index]
    if (value === '-C') {
      folder = resolve(folder, agentsExpandHome(args[index + 1] ?? '.'))
      index += 2
    } else if (value === '-c' || value === '--config-env') {
      settings.push(args[index + 1] ?? '')
      index += 2
    } else if (value.startsWith('-c') && value.length > 2) {
      settings.push(value.slice(2))
      index++
    } else if (value.startsWith('--config-env=')) {
      settings.push(value.slice('--config-env='.length))
      index++
    } else if (['--git-dir', '--work-tree', '--namespace', '--super-prefix', '--attr-source'].includes(value)) index += 2
    else if (value.startsWith('-')) index++
    else break
  }
  return { folder, settings, sub: args[index], rest: args.slice(index + 1) }
}

/** True when a short-option word (such as -fd, not --force) holds the letter. */
function agentsShortHas(option, letter) {
  return /^-[A-Za-z]+$/.test(option) && option.slice(1).includes(letter)
}

/** True when a local branch of that name exists, seen from folder. */
function agentsLocalBranch(folder, name) {
  return agentsGit(folder, ['rev-parse', '--verify', '-q', `refs/heads/${name}`]) !== null
}

/**
 * What a git command throws away, as words for the refusal, or null when it keeps the work:
 * reset --hard, clean -f, checkout of paths or forced, restore of the worktree, switch -f.
 */
function agentsDiscards(sub, options, positionals, folder) {
  const has = (...names) => options.some((option) => names.includes(option))
  if (sub === 'reset') return has('--hard') ? 'throws away uncommitted changes' : null
  if (sub === 'clean') {
    const force = options.some((option) => option === '--force' || agentsShortHas(option, 'f'))
    const dryRun = options.some((option) => option === '--dry-run' || agentsShortHas(option, 'n'))
    return force && !dryRun ? 'deletes untracked files' : null
  }
  if (sub === 'switch') return options.some((option) => ['--force', '--discard-changes'].includes(option) || agentsShortHas(option, 'f')) ? 'throws away uncommitted changes' : null
  if (sub === 'restore') {
    const worktree = options.some((option) => option === '--worktree' || agentsShortHas(option, 'W'))
    const staged = options.some((option) => option === '--staged' || agentsShortHas(option, 'S'))
    return worktree || !staged ? 'throws away uncommitted changes to files' : null
  }
  if (sub === 'checkout') {
    if (options.some((option) => option === '--force' || agentsShortHas(option, 'f'))) return 'throws away uncommitted changes'
    if (agentsCheckoutPaths(options, positionals, folder)) return 'throws away uncommitted changes to files'
  }
  return null
}

/**
 * True when a checkout restores paths rather than switching branches: paths after "--", a ".",
 * a tree-ish and paths, or one word that names an existing path and no local branch.
 */
function agentsCheckoutPaths(options, positionals, folder) {
  if (options.some((option) => ['-b', '-B', '--orphan', '-p', '--patch'].includes(option))) return positionals.some((item) => item.afterDashes)
  if (positionals.some((item) => item.afterDashes || item.value === '.' || item.value === './')) return true
  if (positionals.length > 1) return true
  const [only] = positionals
  return only !== undefined && only.value !== '-' && existsSync(resolve(folder, only.value)) && !agentsLocalBranch(folder, only.value)
}

/**
 * The branch a checkout or switch moves its worktree to: a name, null for a detached HEAD, or
 * undefined when it does not move it or the guard cannot tell.
 */
function agentsSwitchTarget(sub, rest, options, positionals, folder) {
  const created = rest.findIndex((word) => (sub === 'switch' ? ['-c', '-C', '--create', '--force-create', '--orphan'] : ['-b', '-B', '--orphan']).includes(word))
  if (created !== -1) return rest[created + 1]
  if (options.includes('--detach') || (sub === 'switch' && options.includes('-d'))) return null
  if (sub === 'checkout' && agentsCheckoutPaths(options, positionals, folder)) return undefined
  const target = positionals[0]?.value
  if (target === undefined || target === '-' || target.startsWith('@{')) return undefined
  if (agentsLocalBranch(folder, target)) return target
  // A commit checks out a detached HEAD; any other name makes a branch from a remote one.
  if (sub === 'checkout' && agentsGit(folder, ['rev-parse', '--verify', '-q', `${target}^{commit}`]) !== null) return null
  return target
}

/** The refusal for a git command, or null. context holds the configuration and the folder it runs in. */
function agentsGitRefusal(args, context, cwd) {
  const { folder, settings, sub, rest } = agentsGitInvocation(args, cwd)
  if (settings.some((setting) => AGENTS_HOOKS_PATH.test(setting.split('=')[0]))) {
    return 'this git command changes core.hooksPath for its run, which turns the git hooks off. The hooks stay on; fix what they report instead'
  }
  if (sub === undefined) return null
  const { options, positionals } = agentsGitArguments(sub, rest)

  if (options.some((option) => AGENTS_NO_VERIFY.test(option)) || (sub === 'commit' && agentsCommitSkipsHooks(options))) {
    return `"git ${sub}" with --no-verify skips the git hooks. Never bypass them: fix what the hook reports, or tell the user what blocks you`
  }

  const discards = agentsDiscards(sub, options, positionals, folder)
  if (discards) {
    const worktree = agentsWorktreeOf(context, folder)
    const branch = worktree ? agentsBranchOf(context, worktree) : null
    if (branch && context.config.protected.includes(branch)) {
      return `"git ${sub}" here ${discards} in the checkout of the protected branch "${branch}". Run it only in your own lane's worktree, on your lane's branch`
    }
    if (worktree && worktree.top !== agentsOwnTop(context)) {
      return `"git ${sub}" here ${discards} in another worktree (${worktree.top}${branch ? `, branch "${branch}"` : ''}), not this session's own. Leave other lanes' work to their owners; run it only in your own worktree`
    }
  }

  if (sub === 'config') {
    const words = positionals.map((item) => item.value)
    const key = words.findIndex((word) => AGENTS_HOOKS_PATH.test(word))
    if (key === -1) return null
    const reading = options.some((option) => /^--(?:get|get-all|get-regexp|get-urlmatch|list)$|^-l$/.test(option)) || ['get', 'list'].includes(words[0])
    const writing = options.some((option) => /^--(?:unset|unset-all|replace-all|add|remove-section|rename-section)$/.test(option)) || ['set', 'unset'].includes(words[0])
    if (!writing && (reading || key === words.length - 1)) return null
    return 'changing core.hooksPath turns the ResaLedger git hooks off. They stay on; fix what they report instead'
  }

  if (sub === 'commit') {
    const branch = agentsBranchAt(context, folder)
    if (branch && context.config.protected.includes(branch)) {
      return `"${branch}" is a protected branch, so nothing is committed on it. Work in a lane branch: "${context.guard} claim <id>" creates one`
    }
    return null
  }

  if (sub === 'push') {
    const force = options.some((option) => option === '-f' || option === '--mirror' || (option.startsWith('--force') && !option.startsWith('--force-if-includes')) || /^-[A-Za-z]*f[A-Za-z]*$/.test(option) && !option.startsWith('--'))
    const refspecs = positionals.slice(1).map((item) => item.value)
    if (force || refspecs.some((refspec) => refspec.startsWith('+'))) {
      return 'a forced push rewrites history that others may have. Push normally; if the push is rejected, fetch, merge or rebase your own unpushed commits, and push again'
    }
    const protectedRefusal = agentsProtectedPushRefusal(options, refspecs, context, folder)
    if (protectedRefusal) return protectedRefusal
    if (context.config.agent.pushNeedsHandoff) {
      // A dry run pushes nothing.
      if (options.some((option) => option === '--dry-run' || agentsShortHas(option, 'n'))) return null
      if (context.changedBy) {
        return `"git push" follows "git ${context.changedBy}" in the same command, and agent.pushNeedsHandoff judges a push before the command runs, so it cannot see what "git ${context.changedBy}" changes. Run "git push" as a command of its own, after the rest has run`
      }
      return agentsPushHandoffRefusal(context, folder)
    }
  }
  return null
}

// The git commands that change the commits, the index or the checkout, for a push after them.
const AGENTS_CHANGING = ['add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'commit', 'merge', 'mv', 'pull', 'rebase', 'reset', 'restore', 'revert', 'rm', 'stash', 'switch']

/** Notes the last git command so far in a command line that changes the commits, the index or the checkout. */
function agentsTrackChange(args, context, cwd) {
  const { sub, rest } = agentsGitInvocation(args, cwd)
  if (!AGENTS_CHANGING.includes(sub)) return
  if (sub === 'stash' && ['list', 'show'].includes(rest[0])) return
  context.changedBy = sub
}

/** The refusal for a push that would reach a protected branch, or null. */
function agentsProtectedPushRefusal(options, refspecs, context, folder) {
  const protectedBranches = context.config.protected
  if (protectedBranches.length === 0) return null
  if (options.includes('--all') || options.includes('--branches')) {
    return `"git push --all" pushes every branch, including the protected ${protectedBranches.map((branch) => `"${branch}"`).join(', ')}. Push your lane branch by name`
  }
  const current = agentsBranchAt(context, folder)
  const deleting = options.includes('-d') || options.includes('--delete')
  const targets = []
  if (refspecs.length === 0) {
    if (current) targets.push(current)
  }
  for (const refspec of refspecs) {
    const colon = refspec.indexOf(':')
    const destination = colon === -1 ? refspec : refspec.slice(colon + 1) || refspec.slice(0, colon)
    if (destination.includes('*')) {
      targets.push(...protectedBranches)
      continue
    }
    const branch = agentsPushBranch(destination, current)
    if (branch) targets.push(branch)
  }
  const hit = targets.find((branch) => protectedBranches.includes(branch))
  if (hit) {
    return `"${hit}" is a protected branch, so nothing is ${deleting ? 'deleted from' : 'pushed to'} it. Push your lane branch and open a pull request`
  }
  return null
}

/**
 * With agent.pushNeedsHandoff (spec 11): the refusal for a push while handoff fails in the
 * worktree the push runs in, or null. The check that the lane is pushed is left out, since the
 * push does that; like handoff, it runs no gates. A folder outside this repository is not judged.
 */
function agentsPushHandoffRefusal(context, folder) {
  const worktree = agentsWorktreeOf(context, folder)
  if (!worktree) return null
  const root = worktree.top
  const { config, problems: configProblems } =
    root === agentsRealPath(context.root) && context.loadedConfig ? { config: context.loadedConfig, problems: [] } : loadConfig(agentsCommittedFile(root))
  if (!config && agentsCommittedFile(root)(CONFIG_FILE) === null && worktree.branch) {
    return `the lane "${worktree.branch}" has no ${CONFIG_FILE} at its last commit: the lane branched before ResaLedger was set up. Merge the base branch into it, which brings the configuration, and push again`
  }
  const problems = config ? handoffProblems({ root, config: { ...config, requirePushed: false }, lane: worktree.branch }) : configProblems
  if (problems.length === 0) return null
  return `agent.pushNeedsHandoff is on, so an agent pushes only work that is handed over, and "${context.guard} handoff" does not pass here:
${handoffReport(problems)}
Fix these, run handoff, and push again`
}

/** The paths a command writes that the guard can see: redirections, tee and sed -i. */
function agentsWrittenPaths(command) {
  const paths = []
  for (const { op, target } of command.redirects) {
    if (!['>', '>>', '>|', '&>', '&>>', '<>', '>&'].includes(op)) continue
    if (op === '>&' && /^(?:\d+|-)$/.test(target.value)) continue
    if (!target.dynamic) paths.push(target.value)
  }
  const program = agentsProgram(command.args[0] ?? '')
  const words = command.words.slice(1)
  if (program === 'tee') {
    let dashes = false
    for (const word of words) {
      if (!dashes && word.value === '--') dashes = true
      else if (dashes || !word.value.startsWith('-')) {
        if (!word.dynamic) paths.push(word.value)
      }
    }
  }
  if (program === 'sed') {
    let inPlace = false
    let script = false
    const files = []
    for (let index = 0; index < words.length; index++) {
      const { value, dynamic } = words[index]
      if (value === '-e' || value === '-f' || value === '--expression' || value === '--file') {
        script = true
        index++
      } else if (value.startsWith('--expression=') || value.startsWith('--file=')) script = true
      else if (value === '--in-place' || value.startsWith('--in-place=')) inPlace = true
      else if (/^-[A-Za-z]/.test(value)) {
        for (let at = 1; at < value.length; at++) {
          const letter = value[at]
          if (letter === 'i') {
            inPlace = true
            // BSD sed takes the backup suffix as the next word: sed -i '' 's/a/b/' file.
            if (at === value.length - 1 && words[index + 1]?.value === '') index++
            break
          }
          if (letter === 'e' || letter === 'f') {
            script = true
            if (at === value.length - 1) index++
            break
          }
        }
      } else if (!script) script = true
      else if (!dynamic) files.push(value)
    }
    if (inPlace) paths.push(...files)
  }
  if (program === 'apply_patch') for (const body of command.heredocs) paths.push(...patchPaths(body))
  return paths
}

/** A path with a leading ~ expanded. */
function agentsExpandHome(path) {
  return path === '~' || path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path
}

/** A path with its existing part resolved through links, so it compares with git's paths. */
function agentsRealPath(path) {
  let existing = path
  const rest = []
  while (!existsSync(existing)) {
    const parent = resolve(existing, '..')
    if (parent === existing) return path
    rest.unshift(existing.slice(parent.length).replace(/^[\\/]/, ''))
    existing = parent
  }
  try {
    return resolve(realpathSync.native(existing), ...rest)
  } catch {
    return path
  }
}

function agentsGit(folder, args) {
  const result = spawnSync('git', ['-C', folder, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  return result.status === 0 ? result.stdout.replace(/\r?\n$/, '') : null
}

/**
 * The worktree a folder is in, as { top, branch }, or null when it is outside this repository
 * (another repository counts as outside). Cached per folder.
 */
function agentsWorktreeOf(context, folder) {
  if (context.worktrees.has(folder)) return context.worktrees.get(folder)
  let found = null
  let existing = folder
  while (!existsSync(existing) && resolve(existing, '..') !== existing) existing = resolve(existing, '..')
  try {
    if (!statSync(existing).isDirectory()) existing = resolve(existing, '..')
  } catch {}
  const out = agentsGit(existing, ['rev-parse', '--show-toplevel', '--git-common-dir'])
  if (out !== null) {
    const [top, common] = out.split('\n')
    if (agentsRealPath(resolve(existing, common)) === context.commonDir) {
      const branch = agentsGit(top, ['symbolic-ref', '--short', '-q', 'HEAD']) || null
      found = { top: agentsRealPath(top), branch }
    }
  }
  context.worktrees.set(folder, found)
  return found
}

/** A worktree's branch, after any checkout or switch the script ran in it before this command. */
function agentsBranchOf(context, worktree) {
  return context.switched.has(worktree.top) ? context.switched.get(worktree.top) : worktree.branch
}

function agentsBranchAt(context, folder) {
  const worktree = agentsWorktreeOf(context, folder)
  return worktree ? agentsBranchOf(context, worktree) : null
}

/**
 * The top of the session's own worktree: where its start was recorded, so that a session whose
 * folder moved since is still judged by where it started; else the worktree of its folder.
 */
function agentsOwnTop(context) {
  if (context.ownTop !== undefined) return context.ownTop
  let top = null
  const file = agentsSessionFile(context, 'start')
  try {
    const recorded = JSON.parse(readFileSync(file, 'utf8')).top
    if (typeof recorded === 'string') top = recorded
  } catch {}
  context.ownTop = top ?? agentsWorktreeOf(context, context.cwd)?.top ?? null
  return context.ownTop
}

/** Notes the branch a checkout or switch leaves its worktree on, for the commands after it. */
function agentsTrackSwitch(args, context, cwd) {
  const { folder, sub, rest } = agentsGitInvocation(args, cwd)
  if (sub !== 'checkout' && sub !== 'switch') return
  const worktree = agentsWorktreeOf(context, folder)
  if (!worktree) return
  const { options, positionals } = agentsGitArguments(sub, rest)
  const target = agentsSwitchTarget(sub, rest, options, positionals, folder)
  if (target !== undefined) context.switched.set(worktree.top, target)
}

/** The refusal for file edits at the given absolute paths, or null. */
function agentsEditRefusal(paths, context) {
  for (const path of paths) {
    if (path.startsWith('/dev/')) continue
    const real = agentsRealPath(path)
    const worktree = agentsWorktreeOf(context, resolve(real, '..'))
    const branch = worktree ? agentsBranchOf(context, worktree) : null
    if (!branch || !context.config.protected.includes(branch)) continue
    const inside = relative(worktree.top, real).replace(/\\/g, '/')
    if (inside === '' || inside.startsWith('../') || inside === '..' || inside === '.git' || inside.startsWith('.git/')) continue
    const ignored = spawnSync('git', ['-C', worktree.top, 'check-ignore', '-q', '--', inside], { stdio: 'ignore' })
    if (ignored.status === 0) continue
    return `"${branch}" is a protected branch, so files are not edited on it (${inside}). Work in a lane branch: "${context.guard} claim <id>" creates one, or "git switch -c <branch>"`
  }
  return null
}

/** The refusal for a shell command run in folder (default the session's), or null. */
function agentsShellRefusal(text, context, folder = context.cwd) {
  const commands = shellCommands(text)
  let cwd = folder
  // An edit is judged by the branch at its point in the script; its refusal comes after agent.deny's.
  let editRefusal = null
  for (const command of commands) {
    const program = agentsProgram(command.args[0] ?? '')
    for (const assignment of command.assignments) {
      if (/^GIT_CONFIG_(?:PARAMETERS|KEY_\d+|COUNT)=/.test(assignment) && /hookspath/i.test(assignment)) {
        return 'this command changes core.hooksPath through the environment, which turns the git hooks off. The hooks stay on; fix what they report instead'
      }
    }
    if (program === 'export' && command.args.some((word) => /^GIT_CONFIG_/.test(word) && /hookspath/i.test(word))) {
      return 'this command changes core.hooksPath through the environment, which turns the git hooks off. The hooks stay on; fix what they report instead'
    }
    if (program === 'git') {
      const reason = agentsGitRefusal(command.args, context, cwd)
      if (reason) return reason
    }
    editRefusal ??= agentsEditRefusal(agentsWrittenPaths(command).map((path) => resolve(cwd, agentsExpandHome(path))), context)
    if (program === 'git') {
      agentsTrackSwitch(command.args, context, cwd)
      agentsTrackChange(command.args, context, cwd)
    }
    if (program === 'cd' && command.depth === 0 && command.words[1] && !command.words[1].dynamic) cwd = resolve(cwd, agentsExpandHome(command.args[1]))
  }
  if (context.config.agent.deny.length > 0) {
    const top = commands.filter((command) => command.depth === 0)
    const texts = [top.map((command) => `${agentsRenderCommand(command)}${command.separator && command.separator !== ';' ? ` ${command.separator}` : command.separator}`).join(' ').trim(), ...commands.map(agentsRenderCommand)]
    for (const rule of context.config.agent.deny) {
      const regex = rule.regex ?? new RegExp(rule.pattern)
      if (texts.some((candidate) => regex.test(candidate))) {
        return `this command matches the project's agent.deny rule "${rule.pattern}"${rule.reason ? `: ${rule.reason}` : ''}`
      }
    }
  }
  return editRefusal
}

// Session state, under the common git folder: one file per session id.

function agentsSessionFile(context, suffix) {
  return context.stateDir ? resolve(context.stateDir, `${context.sessionKey}.${suffix}`) : null
}

/** What the session can have changed: HEAD, the status and the diff against HEAD. */
function agentsSnapshot(root) {
  const head = agentsGit(root, ['rev-parse', '-q', '--verify', 'HEAD']) ?? ''
  const status = agentsGit(root, ['status', '--porcelain']) ?? ''
  const diff = spawnSync('git', ['-C', root, 'diff', 'HEAD', '--no-ext-diff', '--binary'], { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  const hash = createHash('sha256').update(status).update('\0').update(diff.stdout ?? Buffer.alloc(0)).digest('hex')
  return { head, state: hash }
}

/**
 * Records where the session started, unless it is recorded already. The record is written to a
 * temporary file and then linked into place, so a concurrent reader sees either no record or a
 * whole one, and a record once in place is never replaced: concurrent calls never reset it.
 */
function agentsRecordStart(context) {
  const file = agentsSessionFile(context, 'start')
  if (!file || existsSync(file)) return
  const temporary = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(context.stateDir, { recursive: true })
    writeFileSync(temporary, `${JSON.stringify({ ...agentsSnapshot(context.root), top: agentsRealPath(context.root) })}\n`)
    try {
      linkSync(temporary, file)
    } catch (error) {
      // A file system without hard links: a rename is atomic too, but replaces, so only when still absent.
      if (error.code !== 'EEXIST' && !existsSync(file)) renameSync(temporary, file)
    }
  } catch {
  } finally {
    try {
      unlinkSync(temporary)
    } catch {}
  }
}

/** Removes the state of other sessions older than AGENTS_SESSION_DAYS; the current one's stays. */
function agentsPruneSessions(context) {
  if (!context.stateDir || !existsSync(context.stateDir)) return
  const limit = Date.now() - AGENTS_SESSION_DAYS * 24 * 60 * 60 * 1000
  for (const name of readdirSync(context.stateDir)) {
    if (name.startsWith(`${context.sessionKey}.`)) continue
    const path = resolve(context.stateDir, name)
    try {
      if (statSync(path).mtimeMs < limit) unlinkSync(path)
    } catch {}
  }
}

/** Prints the refusal and stops with exit code 2; json, when given, is the agent's own form of it on stdout. */
function agentsRefuse(message, json = null) {
  if (json) process.stdout.write(`${JSON.stringify(json)}\n`)
  console.error(`✖ ResaLedger: ${message}`)
  process.exit(2)
}

function agentsSessionStart(context) {
  agentsRecordStart(context)
  agentsPruneSessions(context)
  // work turns the git hooks on, and its output becomes the agent's context.
  const result = spawnSync(process.execPath, [process.argv[1], 'work'], { cwd: context.root, encoding: 'utf8', timeout: AGENTS_WORK_TIMEOUT })
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const { startOutput } = context.adapter
  if (startOutput) process.stdout.write(`${startOutput(text)}\n`)
  else if (text) process.stdout.write(text)
}

function agentsStop(context) {
  const startFile = agentsSessionFile(context, 'start')
  if (!startFile) return
  let start
  try {
    start = JSON.parse(readFileSync(startFile, 'utf8'))
  } catch {
    // No record of the start: the session's changes are unknown, so it starts now. Records are
    // whole or absent, and agentsRecordStart never replaces one, so this cannot reset a start.
    agentsRecordStart(context)
    return
  }
  const remindedFile = agentsSessionFile(context, 'reminded')
  if (existsSync(remindedFile)) return
  const now = agentsSnapshot(context.root)
  if (now.head === start.head && now.state === start.state) return
  let problems
  try {
    problems = context.config ? handoffProblems({ root: context.root, config: context.config, lane: currentLane() }) : context.configProblems
  } catch {
    return
  }
  if (problems.length === 0) return
  // Created exclusively: when two configurations call this for one session, one of them reminds.
  try {
    writeFileSync(remindedFile, `${new Date().toISOString()}\n`, { flag: 'wx' })
  } catch {
    return
  }
  const shown = problems.slice(0, AGENTS_REMINDER_PROBLEMS).map(({ file, line, message }) => `  - ${file ? `${file}${line ? `:${line}` : ''}: ` : ''}${message}`)
  if (problems.length > AGENTS_REMINDER_PROBLEMS) shown.push(`  - and ${problems.length - AGENTS_REMINDER_PROBLEMS} more`)
  const message = `this session changed the repository, and "${context.guard} handoff" does not pass yet:
${shown.join('\n')}
Finish the work and run handoff, or tell the user exactly what is left. (This reminder comes once per session.)`
  const { remind } = context.adapter
  if (!remind) return agentsRefuse(message)
  // This agent continues on its own JSON with exit code 0; the message on stderr is for its log.
  process.stdout.write(`${JSON.stringify(remind(`ResaLedger: ${message}`))}\n`)
  console.error(`✖ ResaLedger: ${message}`)
}

/**
 * A reader of the files committed at HEAD in a worktree: the rules come from there, so an agent
 * cannot lift one by editing the configuration without committing it.
 */
function agentsCommittedFile(root) {
  return (path) => agentsGit(root, ['show', `HEAD:${path}`])
}

/** The repository, its configuration and the session, for one hook call; null outside a repository. */
function agentsContext(session, adapter) {
  const cwd = typeof session.cwd === 'string' && session.cwd !== '' && existsSync(session.cwd) ? resolve(session.cwd) : process.cwd()
  const out = agentsGit(cwd, ['rev-parse', '--show-toplevel', '--git-common-dir'])
  if (out === null) return null
  const [top, common] = out.split('\n')
  const root = resolve(top)
  process.chdir(root)
  const loaded = loadConfig(agentsCommittedFile(root))
  const config = loaded.config
  const effective = config ?? { dir: DEFAULTS.dir, protected: [], agent: { deny: [], pushNeedsHandoff: false } }
  const key = typeof session.id === 'string' ? session.id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) : ''
  return {
    root,
    cwd,
    config: effective,
    loadedConfig: config,
    configProblems: loaded.problems,
    guard: `node ${effective.dir}/scripts/records.mjs`,
    commonDir: agentsRealPath(resolve(cwd, common)),
    // In the common git folder, shared by every worktree: a session that moves to another
    // worktree keeps its start, and so the worktree it started in.
    stateDir: key && !key.startsWith('.') ? resolve(cwd, common, 'resaledger', 'sessions') : null,
    sessionKey: key,
    adapter,
    worktrees: new Map(),
    switched: new Map(),
    // The last git command so far in this command line that changes the commits, the index or the checkout.
    changedBy: null
  }
}

/**
 * hook <agent> <event>: reads the agent's JSON (text) and applies the rules. Exits 2 with the
 * reason on stderr to refuse; returns, so exiting 0, to allow. Input it does not recognise,
 * an unknown agent or event, and a folder outside a repository are allowed.
 */
function hookCommand(agent, event, text = '') {
  const adapter = Object.hasOwn(AGENT_ADAPTERS, agent ?? '') ? AGENT_ADAPTERS[agent] : null
  if (!adapter || !AGENT_EVENTS.includes(event)) {
    console.error(`resaledger: hook: unknown agent or event "${agent ?? ''} ${event ?? ''}"; use hook <${AGENT_NAMES.join('|')}> <${AGENT_EVENTS.join('|')}>. Allowed.`)
    return
  }
  let input
  try {
    input = JSON.parse(text)
  } catch {
    return
  }
  if (!agentsIsObject(input)) return
  let refusal = null
  try {
    const session = adapter.session ? adapter.session(input) : { id: input.session_id, cwd: input.cwd }
    const context = agentsContext(session, adapter)
    if (context === null) return
    if (event === 'session-start') return agentsSessionStart(context)
    if (event === 'stop') {
      context.config = context.loadedConfig
      return agentsStop(context)
    }
    // Cursor's cloud agents run no sessionStart hook, so their first shell call turns the git hooks on.
    if (adapter.turnsOnHooks?.(input) && !existsSync(agentsSessionFile(context, 'start') ?? '')) activateHooks()
    agentsRecordStart(context)
    const action = adapter.tool(input)
    if (action === null) return
    if (action.kind === 'shell') refusal = agentsShellRefusal(action.command, context, action.cwd ? resolve(context.cwd, agentsExpandHome(action.cwd)) : context.cwd)
    else if (action.kind === 'edit') refusal = agentsEditRefusal(action.paths.map((path) => resolve(context.cwd, agentsExpandHome(path))), context)
  } catch {
    return
  }
  if (refusal) agentsRefuse(refusal, adapter.deny ? adapter.deny(`ResaLedger: ${refusal}`) : null)
}

// The configurations that call the hook. The command lines never change between versions,
// because Codex asks the user to trust a hook again when its command changes. Claude Code,
// Codex and Gemini CLI group handlers under a matcher; Cursor and Copilot list the handlers
// themselves (flat) and take a "version" next to "hooks".

const AGENTS_TIMEOUTS = { 'session-start': 30, 'pre-tool': 20, stop: 60 }

const AGENT_CONFIGS = {
  claude: {
    file: '.claude/settings.json',
    handler: (dir, event) => ({ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/${dir}/scripts/records.mjs" hook claude ${event}`, timeout: AGENTS_TIMEOUTS[event] }),
    events: [
      { name: 'SessionStart', event: 'session-start' },
      { name: 'PreToolUse', event: 'pre-tool', matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit' },
      { name: 'Stop', event: 'stop' }
    ]
  },
  codex: {
    file: '.codex/hooks.json',
    // Codex runs hooks in the session's folder, so the command finds the repository's top first.
    handler: (dir, event) => ({ type: 'command', command: `node "$(git rev-parse --show-toplevel)/${dir}/scripts/records.mjs" hook codex ${event}`, timeout: AGENTS_TIMEOUTS[event] }),
    events: [
      { name: 'SessionStart', event: 'session-start' },
      { name: 'PreToolUse', event: 'pre-tool', matcher: 'Bash|apply_patch' },
      { name: 'Stop', event: 'stop' }
    ]
  },
  cursor: {
    file: '.cursor/hooks.json',
    flat: true,
    version: 1,
    // Cursor runs project hooks from the project's root. A hook that crashes or times out lets
    // the tool run unless failClosed is set; loop_limit 1 lets the reminder continue the agent once.
    handler: (dir, event) => ({ command: `node ${dir}/scripts/records.mjs hook cursor ${event}` }),
    events: [
      { name: 'sessionStart', event: 'session-start' },
      { name: 'beforeShellExecution', event: 'pre-tool', extra: { failClosed: true } },
      { name: 'preToolUse', event: 'pre-tool', extra: { failClosed: true } },
      { name: 'stop', event: 'stop', extra: { loop_limit: 1 } }
    ]
  },
  gemini: {
    file: '.gemini/settings.json',
    // Gemini CLI's timeouts are in milliseconds.
    handler: (dir, event) => ({ name: `resaledger-${event}`, type: 'command', command: `node "$GEMINI_PROJECT_DIR/${dir}/scripts/records.mjs" hook gemini ${event}`, timeout: AGENTS_TIMEOUTS[event] * 1000 }),
    events: [
      { name: 'SessionStart', event: 'session-start' },
      { name: 'BeforeTool', event: 'pre-tool', matcher: 'run_shell_command|write_file|replace' },
      { name: 'AfterAgent', event: 'stop' }
    ]
  },
  copilot: {
    file: '.github/hooks/resaledger.json',
    flat: true,
    version: 1,
    // The cloud agent runs only "bash"; the CLI may run hooks in a subfolder.
    handler: (dir, event) => ({ type: 'command', bash: `node "$(git rev-parse --show-toplevel)/${dir}/scripts/records.mjs" hook copilot ${event}`, timeoutSec: AGENTS_TIMEOUTS[event] }),
    events: [
      { name: 'sessionStart', event: 'session-start' },
      { name: 'preToolUse', event: 'pre-tool' },
      { name: 'agentStop', event: 'stop' }
    ]
  }
}

/** The configuration file an agent's hooks live in, relative to the repository root. */
function agentConfigFile(agent) {
  return AGENT_CONFIGS[agent].file
}

/** True when a hook command is ResaLedger's: it runs records.mjs hook, in 1.0's form or 0.3's. */
function isLedgerHookCommand(command) {
  return typeof command === 'string' && /scripts\/records\.mjs\\?"?\s+hook\b/.test(command)
}

/** True when a handler, grouped or flat, runs ResaLedger's hook command. */
function agentsOwnHandler(handler) {
  return agentsIsObject(handler) && (isLedgerHookCommand(handler.command) || isLedgerHookCommand(handler.bash))
}

/** ResaLedger's entries for an agent: { EventName: matcher group }, or { EventName: handler } for a flat one. */
function agentHookEntries(agent, dir) {
  const { handler, events, flat } = AGENT_CONFIGS[agent]
  const entries = {}
  for (const { name, event, matcher, extra } of events) {
    entries[name] = flat ? { ...handler(dir, event), ...extra } : { ...(matcher ? { matcher } : {}), hooks: [handler(dir, event)] }
  }
  return entries
}

// Gemini CLI reads GEMINI.md unless context.fileName names other files, so the list keeps
// GEMINI.md and adds AGENTS.md.
const GEMINI_CONTEXT_FILES = ['AGENTS.md', 'GEMINI.md']

/** The JSON to add by hand, for a file the merge cannot read. */
function agentConfigSnippet(agent, dir) {
  const { version } = AGENT_CONFIGS[agent]
  const entries = agentHookEntries(agent, dir)
  const context = agent === 'gemini' ? { context: { fileName: GEMINI_CONTEXT_FILES } } : {}
  return JSON.stringify({ ...(version ? { version } : {}), ...context, hooks: Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, [entry]])) }, null, 2)
}

/**
 * Makes Gemini CLI's context.fileName include AGENTS.md, keeping the other keys and the file
 * names already listed. Changes settings in place; returns an error text, or null.
 */
function geminiWithAgentsFile(settings) {
  if ('context' in settings && !agentsIsObject(settings.context)) return 'has a "context" value that is not an object'
  const context = settings.context ?? {}
  const names = context.fileName
  if (names === undefined) context.fileName = [...GEMINI_CONTEXT_FILES]
  else if (typeof names === 'string') context.fileName = names === 'AGENTS.md' ? names : [names, 'AGENTS.md']
  else if (Array.isArray(names) && names.every((name) => typeof name === 'string')) {
    if (!names.includes('AGENTS.md')) names.push('AGENTS.md')
  } else return 'has a "context.fileName" value that is neither a file name nor a list of them'
  settings.context = context
  return null
}

/** An entry under an event without ResaLedger's handlers: { own, rest }, rest null when nothing is left. */
function agentsWithoutOwn(entry, flat) {
  if (flat) return agentsOwnHandler(entry) ? { own: true, rest: null } : { own: false, rest: entry }
  const handlers = agentsIsObject(entry) && Array.isArray(entry.hooks) ? entry.hooks : []
  const others = handlers.filter((handler) => !agentsOwnHandler(handler))
  if (others.length === handlers.length) return { own: false, rest: entry }
  return { own: true, rest: others.length > 0 ? { ...entry, hooks: others } : null }
}

/**
 * Merges ResaLedger's entries into an agent's configuration text (null when the file is
 * missing). Only handlers whose command is ResaLedger's are added, replaced or removed;
 * everything else keeps its meaning and its order. Gemini CLI's context.fileName also gets
 * AGENTS.md. Returns { text, changed } or { error }.
 */
function mergeAgentConfig(agent, text, dir) {
  const { flat, version } = AGENT_CONFIGS[agent]
  let settings = {}
  if (text !== null && text !== undefined && text.trim() !== '') {
    try {
      settings = JSON.parse(text)
    } catch (error) {
      return { error: `is not valid JSON (${error.message})` }
    }
  }
  if (!agentsIsObject(settings)) return { error: 'is not a JSON object' }
  const before = JSON.stringify(settings, null, 2)
  if ('hooks' in settings && !agentsIsObject(settings.hooks)) return { error: 'has a "hooks" value that is not an object' }
  if (agent === 'gemini') {
    const problem = geminiWithAgentsFile(settings)
    if (problem) return { error: problem }
  }
  const hooks = settings.hooks ?? {}
  const entries = agentHookEntries(agent, dir)
  for (const name of Object.keys(entries)) {
    if (name in hooks && !Array.isArray(hooks[name])) return { error: `has a "hooks.${name}" value that is not an array` }
  }
  const positions = {}
  for (const name of Object.keys(hooks)) {
    if (!Array.isArray(hooks[name])) continue
    const kept = []
    let removed = false
    for (const entry of hooks[name]) {
      const { own, rest } = agentsWithoutOwn(entry, flat)
      if (!own) {
        kept.push(entry)
        continue
      }
      removed = true
      positions[name] ??= kept.length
      if (rest !== null) kept.push(rest)
    }
    if (removed && kept.length === 0 && !(name in entries)) delete hooks[name]
    else hooks[name] = kept
  }
  for (const [name, entry] of Object.entries(entries)) {
    const list = hooks[name] ?? []
    list.splice(positions[name] ?? list.length, 0, entry)
    hooks[name] = list
  }
  // A new file starts with the format's version; an existing one keeps its own.
  if (version && !('version' in settings)) settings = { version, ...settings }
  settings.hooks = hooks
  const after = JSON.stringify(settings, null, 2)
  return { text: `${after}\n`, changed: after !== before || text === null || text === undefined }
}

/** True when an agent's configuration file holds ResaLedger's hook command, even as invalid JSON. */
function agentConfigured(root, agent) {
  try {
    return isLedgerHookCommand(readFileSync(resolve(root, agentConfigFile(agent)), 'utf8'))
  } catch {
    return false
  }
}

/** The agents in use in a repository: their folder or instruction file exists. */
function detectAgents(root) {
  const found = []
  if (existsSync(resolve(root, '.claude')) || existsSync(resolve(root, 'CLAUDE.md'))) found.push('claude')
  if (existsSync(resolve(root, '.codex'))) found.push('codex')
  if (existsSync(resolve(root, '.cursor')) || existsSync(resolve(root, '.cursorrules'))) found.push('cursor')
  if (existsSync(resolve(root, '.gemini')) || existsSync(resolve(root, 'GEMINI.md'))) found.push('gemini')
  const copilot = ['.github/copilot-instructions.md', '.github/instructions', '.github/copilot', '.github/hooks']
  if (copilot.some((path) => existsSync(resolve(root, path)))) found.push('copilot')
  return found
}

// --- work.mjs ---
// work (spec 6.4 and 8): the state on one screen, for this lane and the other local
// worktrees, and with --all the pushed branches not merged into the base. It is the first
// context of every session, so it says what this lane holds, what waits, what is ready and
// what to type next. It fetches only with --fetch.

const WORK_READY_MAX = 5
const WORK_HANDOFF_LINES = 3
const WORK_PROBLEMS_MAX = 5
const WORK_SETTLED = ['done', 'dropped']
const WORK_FETCH_TIMEOUT = 60 * 1000

/** The parts of a task id: its letters and its numbers, as { prefix, numbers }. */
function workIdParts(id) {
  const match = /^([A-Z]+)(\d+(?:\.\d+)*)$/.exec(id ?? '')
  if (!match) return { prefix: id ?? '', numbers: [] }
  return { prefix: match[1], numbers: match[2].split('.').map(Number) }
}

/** Natural id order: by prefix, then number by number, so S2 < S10 and S4 < S4.1 < S5. */
function compareTaskIds(a, b) {
  const left = workIdParts(a)
  const right = workIdParts(b)
  if (left.prefix !== right.prefix) return left.prefix < right.prefix ? -1 : 1
  for (let index = 0; index < Math.min(left.numbers.length, right.numbers.length); index += 1) {
    if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] - right.numbers[index]
  }
  return left.numbers.length - right.numbers.length
}

/** Ids ordered by the phases setting first (prefixes it does not name go last), then naturally. */
function workPhaseOrder(phases) {
  const rank = (id) => {
    const position = phases.indexOf(workIdParts(id).prefix)
    return position === -1 ? phases.length : position
  }
  return (a, b) => rank(a) - rank(b) || compareTaskIds(a, b)
}

/** The first sentence of the README's Goal section, or null. */
function workGoal(readme) {
  if (!readme) return null
  const name = [...readme.sections.keys()].find((heading) => heading.trim().toLowerCase() === 'goal')
  if (name === undefined) return null
  const paragraph = readme.sections.get(name).body.split(/\n[ \t]*\n/)[0].replace(/\s+/g, ' ').trim()
  if (paragraph === '') return null
  const sentence = /^.*?[.!?](?=\s|$)/.exec(paragraph)
  return sentence ? sentence[0] : paragraph
}

/** The first lines of a task's Handoff that hold text. */
function workHandoff(task) {
  const body = task.sections.handoff?.body ?? ''
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, WORK_HANDOFF_LINES)
}

/** The ids a lane holds: tasks doing, or blocked with a Lane, whose Lane is that lane's branch. */
function workHeldBy(lane) {
  return lane.tasks
    .filter((task) => task.id && (task.status === 'doing' || (task.status === 'blocked' && task.lane !== null)) && task.lane === lane.branch)
    .map((task) => task.id)
    .sort(compareTaskIds)
}

/** The lane named first in a "Taken over from" value, such as "s4-old at 1a2b3c4". */
function workTakenFrom(task) {
  return task.takenOverFrom ? task.takenOverFrom.split(/\s+/)[0] : null
}

/** Ids that are doing in more than one lane, as [{ id, lanes }], across every visible tree. */
function workDoubleClaims(lanes) {
  const claims = new Map() // id → Map of lane → the tasks that name it
  for (const lane of lanes) {
    for (const task of lane.tasks) {
      if (!task.id || task.status !== 'doing' || task.lane === null) continue
      if (!claims.has(task.id)) claims.set(task.id, new Map())
      const byLane = claims.get(task.id)
      if (!byLane.has(task.lane)) byLane.set(task.lane, [])
      byLane.get(task.lane).push(task)
    }
  }
  const doubles = []
  for (const [id, byLane] of claims) {
    // A lane that took the task over with claim --take replaces the lane it names.
    const replaced = new Set([...byLane.values()].flat().map(workTakenFrom).filter(Boolean))
    const holders = [...byLane.keys()].filter((lane) => !replaced.has(lane))
    if (holders.length > 1) doubles.push({ id, lanes: holders.sort() })
  }
  return doubles.sort((a, b) => compareTaskIds(a.id, b.id))
}

/**
 * Doing tasks whose Lane is not a known lane. Without --all, known is this lane, the worktrees'
 * and the local branches. With --all, known is this lane, the worktrees' and the branches not
 * merged into the base, and each claim says why it is stale: its branch is 'merged' or 'gone'.
 */
function workStaleClaims(taskLists, known, merged = null) {
  const stale = []
  const seen = new Set()
  for (const tasks of taskLists) {
    for (const task of tasks) {
      if (!task.id || task.status !== 'doing' || task.lane === null || known.has(task.lane)) continue
      const key = `${task.id}\0${task.lane}`
      if (seen.has(key)) continue
      seen.add(key)
      const claim = { id: task.id, lane: task.lane, file: task.file }
      if (merged !== null) claim.reason = merged.has(task.lane) ? 'merged' : 'gone'
      stale.push(claim)
    }
  }
  return stale.sort((a, b) => compareTaskIds(a.id, b.id))
}

/** Done or dropped out of all tasks, per id prefix, ordered by phases and then by prefix. */
function workProgress(tasks, phases) {
  const byPrefix = new Map()
  for (const task of tasks) {
    if (!task.id) continue
    const { prefix } = workIdParts(task.id)
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, { prefix, done: 0, total: 0 })
    const entry = byPrefix.get(prefix)
    entry.total += 1
    if (WORK_SETTLED.includes(task.status)) entry.done += 1
  }
  const order = workPhaseOrder(phases)
  return [...byPrefix.values()].sort((a, b) => order(`${a.prefix}0`, `${b.prefix}0`))
}

/** A task as the sections show it. */
function workSummary(task) {
  return { id: task.id, title: task.title ?? '', file: task.file }
}

/**
 * Whether the gates passed on the code at HEAD: 'verified' when a stamp for it is in the
 * working tree, 'unverified' when not, 'no-gates' or 'no-commits' when there is nothing to check.
 */
function workVerification(config, reader, root) {
  const gates = config.gates.commit.length + config.gates.verify.length
  if (gates === 0) return { state: 'no-gates', gates }
  let code
  try {
    code = fingerprint({ kind: 'commit', rev: 'HEAD', root }, config)
  } catch {
    return { state: 'no-commits', gates }
  }
  return { state: verifiedStamp(reader, config, code) ? 'verified' : 'unverified', gates }
}

/** Computes everything work shows, as one plain object (the --json output). */
function workState(options) {
  const { config, workspace, problems, lane, hooks, others, branches, root, verification } = options
  const remote = options.remote ?? null // remoteLanes() with --all
  const tasks = workspace.tasks.filter((task) => task.id)
  const thisLane = { branch: lane, path: root, source: 'this', tasks: workspace.tasks }
  if (lane !== null && branches.has(lane)) thisLane.lastCommit = branches.get(lane)
  const localLaneList = [thisLane, ...others]
  if (remote !== null) for (const each of localLaneList) each.pushed = remote.pushed.has(each.branch)
  const lanes = remote === null ? localLaneList : [...localLaneList, ...remote.lanes]

  const inProgress = lane === null ? [] : tasks.filter((task) => task.status === 'doing' && task.lane === lane)
  const blocked = tasks.filter((task) => task.status === 'blocked')
  const forOwner = (task) => /^owner\b/i.test(task.waitingFor ?? '')

  // A task is held when any visible tree has it doing, or blocked with a lane.
  const held = new Set()
  for (const each of lanes) {
    for (const task of each.tasks) {
      if (task.id && (task.status === 'doing' || (task.status === 'blocked' && task.lane !== null))) held.add(task.id)
    }
  }
  const statuses = new Map(tasks.map((task) => [task.id, task.status]))
  const order = workPhaseOrder(config.phases)
  const ready = tasks
    .filter((task) => task.status === 'todo' && !held.has(task.id))
    .filter((task) => task.dependsOn.every((id) => WORK_SETTLED.includes(statuses.get(id))))
    .sort((a, b) => order(a.id, b.id))
    .slice(0, WORK_READY_MAX)

  const known = new Set([...(remote === null ? branches.keys() : remote.live), ...others.map((other) => other.branch)])
  if (lane !== null) known.add(lane)
  const merged = remote === null ? null : new Set([...branches.keys(), ...remote.branches].filter((name) => !known.has(name)))
  const progress = workProgress(tasks, config.phases)
  const byInProgress = [...inProgress].sort((a, b) => compareTaskIds(a.id, b.id))
  const focus = byInProgress[0]?.id ?? ready[0]?.id ?? '<id>'
  const guard = `node ${config.dir}/scripts/records.mjs`

  const state = {
    lane,
    preset: config.preset,
    hooks,
    goal: workGoal(workspace.readme),
    inProgress: byInProgress.map((task) => ({ ...workSummary(task), handoff: workHandoff(task) })),
    waitingForOwner: blocked.filter(forOwner).sort((a, b) => compareTaskIds(a.id, b.id)).map((task) => ({ ...workSummary(task), waitingFor: task.waitingFor })),
    blocked: blocked.filter((task) => !forOwner(task)).sort((a, b) => compareTaskIds(a.id, b.id)).map((task) => ({ ...workSummary(task), waitingFor: task.waitingFor })),
    ready: ready.map(workSummary),
    lanes: lanes.map((each) => {
      const shown = { branch: each.branch, path: each.path, source: each.source, holds: each.branch === null ? [] : workHeldBy(each) }
      if (each.lastCommit) shown.lastCommit = each.lastCommit
      if (each.pushed !== undefined) shown.pushed = each.pushed
      if (each.source === 'remote') {
        Object.assign(shown, { pushed: true, remote: each.remote, ref: each.ref, commit: each.commit, ahead: each.ahead, verification: each.verification })
      }
      return shown
    }),
    progress: {
      done: progress.reduce((sum, entry) => sum + entry.done, 0),
      total: progress.reduce((sum, entry) => sum + entry.total, 0),
      byPrefix: progress
    },
    verification,
    warnings: {
      doubleClaims: workDoubleClaims(lanes),
      staleClaims: workStaleClaims([...lanes.map((each) => each.tasks), remote?.baseTasks ?? []], known, merged),
      problems
    },
    next: [`${guard} task ${focus}`, `${guard} handoff`]
  }
  if (remote !== null) {
    state.base = remote.base
    state.fetch = options.fetched ?? null
  }
  return state
}

/** The state as text, one section after another; empty sections are left out. */
function workText(state) {
  const out = []
  const section = (heading, lines) => {
    if (lines.length === 0) return
    out.push('', heading, ...lines)
  }
  const line = (task, extra) => `  ${task.id}  ${task.title}${extra ? ` — ${extra}` : ''}`

  const verified = { verified: ' · verified', unverified: ' · not verified', 'no-commits': '', 'no-gates': '' }[state.verification.state]
  out.push(`ResaLedger · lane ${state.lane ?? '(detached HEAD)'} · ${state.preset} · hooks ${state.hooks.active ? 'on' : 'off'}${verified}`)
  if (state.goal) out.push(`Goal: ${state.goal}`)

  const progressLines = state.inProgress.flatMap((task) => [line(task), ...task.handoff.map((text) => `      ${text}`)])
  section('In progress in this lane', progressLines.length > 0 ? progressLines : ['  none'])
  section('Waiting for the owner', state.waitingForOwner.map((task) => line(task, task.waitingFor)))
  section('Blocked', state.blocked.map((task) => line(task, `waiting for ${task.waitingFor}`)))
  section('Ready next', state.ready.map((task) => line(task)))
  const holds = (lane) => (lane.holds.length > 0 ? lane.holds.join(', ') : 'holds nothing')
  section(
    'Other lanes',
    state.lanes.filter((lane) => lane.source === 'worktree').map((lane) => `  ${lane.branch}: ${holds(lane)}${lane.pushed ? ' · pushed' : ''}`)
  )
  if ('base' in state) {
    const verified = { verified: ' · verified', unverified: ' · not verified' }
    const remoteLines = state.lanes
      .filter((lane) => lane.source === 'remote')
      .map((lane) => {
        const ahead = lane.ahead === null ? '' : ` · ${lane.ahead} ahead`
        const last = lane.lastCommit ? ` · ${lane.lastCommit.author} ${lane.lastCommit.date.slice(0, 10)}` : ''
        return `  ${lane.remote}/${lane.branch}: ${holds(lane)}${ahead}${last}${verified[lane.verification] ?? ''}`
      })
    section(state.base === null ? 'Pushed lanes' : `Pushed lanes not merged into ${state.base}`, remoteLines.length > 0 ? remoteLines : ['  none'])
  }
  if (state.progress.total > 0) {
    const parts = state.progress.byPrefix.map((entry) => `${entry.prefix} ${entry.done}/${entry.total}`)
    section('Progress', [`  ${state.progress.done} of ${state.progress.total} done or dropped${parts.length > 1 ? ` · ${parts.join(' · ')}` : ''}`])
  }

  const warnings = [
    ...state.warnings.doubleClaims.map((claim) => `  ${claim.id} is doing in ${claim.lanes.length} lanes: ${claim.lanes.join(', ')}. One of them sets it back or takes it over with claim --take`),
    ...state.warnings.staleClaims.map((claim) => {
      const why = claim.reason === 'merged' ? `is merged into ${state.base}` : claim.reason === 'gone' ? 'is gone' : 'is no branch here'
      return `  ${claim.id} is held by ${claim.lane}, which ${why}: a stale claim. Take it over with claim ${claim.id} --take`
    }),
    ...state.warnings.problems.slice(0, WORK_PROBLEMS_MAX).map(({ file, line: at, message }) => `  ${file}${at ? `:${at}` : ''}: ${message}`)
  ]
  const more = state.warnings.problems.length - WORK_PROBLEMS_MAX
  if (more > 0) warnings.push(`  and ${more} more record problem${more === 1 ? '' : 's'}; run check for the list`)
  section('Warnings', warnings)

  if (state.verification.state === 'unverified')
    out.push('', `The gates have not passed on the code at HEAD: run ${state.next[1].replace(/handoff$/, 'verify')} once your code is committed.`)
  out.push('', `Next: ${state.next[0]} for the plan, then ${state.next[1]} before you stop.`)
  return `${out.join('\n')}\n`
}

/**
 * git fetch --prune from the default remote, as { remote, ok, message }: message is git's first
 * line of error when the fetch fails, or why there is nothing to fetch from.
 */
function workFetch(root, base) {
  const remote = defaultRemote(root, base)
  if (remote === null) return { remote: null, ok: false, message: 'there is no remote' }
  const result = spawnSync('git', ['fetch', '--prune', '--quiet', remote], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: WORK_FETCH_TIMEOUT
  })
  if (result.status === 0) return { remote, ok: true, message: null }
  const reason = result.error ? result.error.message : (result.stderr ?? '').split('\n').map((text) => text.replace(/^fatal:\s*/, '').trim()).find((text) => text !== '')
  return { remote, ok: false, message: reason ?? `git fetch exited with ${result.status}` }
}

/**
 * work [--all] [--fetch] [--json]: turns on the git hooks, then prints the state of this lane
 * and the local worktrees; --all adds the pushed branches not merged into the base, and
 * --fetch (which implies --all) fetches them first.
 */
function workCommand(args) {
  let json = false
  let all = false
  let fetch = false
  for (const arg of args) {
    if (arg === '--json') json = true
    else if (arg === '--all') all = true
    else if (arg === '--fetch') {
      all = true
      fetch = true
    } else fail(`unknown option "${arg}" for work; use --all, --fetch or --json`)
  }
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }

  const notes = []
  const hooks = { active: false, activated: false, foreign: null }
  try {
    const result = activateHooks()
    if (result === 'activated') {
      hooks.activated = true
      notes.push('✔ git hooks turned on: core.hooksPath is .githooks')
    } else if (result !== 'active') {
      hooks.foreign = result.foreign
      notes.push(`✖ core.hooksPath is "${result.foreign}", not .githooks: call the guard from those hooks, or run "hooks --activate" for the details`)
    }
    hooks.active = hooksActive()
  } catch (error) {
    notes.push(`✖ could not turn on the git hooks: ${error.message}`)
  }

  const reader = treeReader({ kind: 'worktree', root })
  const loaded = loadConfig(reader)
  if (!loaded.config) {
    for (const { file, line, message } of loaded.problems) console.error(`✖ ${file}${line ? `:${line}` : ''}: ${message}`)
    process.exit(1)
  }
  const { config } = loaded
  let fetched = null
  if (fetch) {
    fetched = workFetch(root, config.base)
    if (!fetched.ok) notes.push(`✖ could not fetch${fetched.remote ? ` from ${fetched.remote}` : ''}: ${fetched.message}; showing the branches as last fetched`)
  }
  const workspace = loadWorkspace(reader, config)
  const problems = checkWorkspace(workspace, reader, config)
  const branches = localBranches()
  const verification = workVerification(config, reader, root)
  const lane = currentLane()
  const others = localLanes(config, branches)
  const remote = all ? remoteLanes({ root, config, local: new Set([lane, ...others.map((other) => other.branch)].filter((name) => name !== null)) }) : null
  const state = workState({ config, workspace, problems, lane, hooks, others, branches, root, verification, remote, fetched })

  if (json) {
    // The fetch note goes to stderr, so that stdout stays one JSON object.
    if (fetched !== null && !fetched.ok) console.error(notes[notes.length - 1])
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
    return
  }
  for (const note of notes) console.log(note)
  process.stdout.write(workText(state))
}

// --- changes.mjs ---
// changes (spec 8): the tasks that became done since a tag, with their evidence, grouped as
// Keep a Changelog does, as a draft for the changelog and the release notes. It only reads git
// and never writes a file.

const CHANGES_TYPE = /^([A-Za-z]+)(?:\([^()]*\))?!?: \S/
const CHANGES_FILE_ID = /^([A-Z]{1,4}\d+(?:\.\d+)*)(?:-[^/]+)?\.md$/
const CHANGES_LINK = /\]\((<[^>]*>|[^)\s]+)\)/g
const CHANGES_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const CHANGES_HASH_LINE = /^@([0-9a-f]{40}|[0-9a-f]{64})$/
// Keep a Changelog order; Deprecated, Removed and Security have no Conventional Commit type.
const CHANGES_GROUPS = ['Added', 'Changed', 'Fixed']

/** Runs git in the repository: { status, stdout } with stdout as trimmed text. */
function changesGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  return { status: result.status, stdout: (result.stdout ?? '').trim() }
}

/** The options: { since, json }; anything else is a refusal. */
function changesOptions(args) {
  const options = { since: null, json: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') options.json = true
    else if (arg === '--since') {
      if (!args[index + 1]) fail('--since needs a tag, branch or commit, such as --since v1.0.0')
      options.since = args[index + 1]
      index += 1
    } else fail(`unknown option "${arg}" for changes; use changes [--since <ref>] [--json]`)
  }
  return options
}

/** The start of the range: { ref, commit }, from --since or the newest tag; both null with no tag. */
function changesStart(root, since) {
  if (since !== null) {
    const resolved = since.startsWith('-') ? { status: 1 } : changesGit(root, ['rev-parse', '--verify', '--quiet', `${since}^{commit}`])
    if (resolved.status !== 0) fail(`"${since}" is not a tag, branch or commit in this repository; give one that exists, such as a tag from "git tag"`)
    return { ref: since, commit: resolved.stdout }
  }
  const tag = changesGit(root, ['describe', '--tags', '--abbrev=0', 'HEAD'])
  if (tag.status !== 0) return { ref: null, commit: null }
  return { ref: tag.stdout, commit: changesGit(root, ['rev-parse', '--verify', '--quiet', `${tag.stdout}^{commit}`]).stdout }
}

/** The tasks in a commit, as a Map from id to the parsed task. */
function changesTasks(root, rev, dir) {
  const reader = treeReader({ kind: 'commit', rev, root })
  const tasks = new Map()
  for (const path of reader.list(`${dir}/tasks`)) {
    if (!path.endsWith('.md')) continue
    const task = parseTask(path, reader.read(path) ?? '')
    if (task.id && !tasks.has(task.id)) tasks.set(task.id, task)
  }
  return tasks
}

/**
 * The ids among candidates (done at both ends) whose task file was not done in some commit of
 * the range: reopened and finished again. One git log lists the commits that touch the task
 * files, and one batch reads only the files of the candidates.
 */
function changesReopened(root, dir, from, candidates) {
  if (candidates.size === 0) return new Set()
  const log = changesGit(root, ['-c', 'core.quotePath=false', 'log', '--format=@%H', '--name-only', `${from}..HEAD`, '--', `${dir}/tasks/`])
  if (log.status !== 0) fail('cannot read the history of the task files from git')
  const specs = []
  let hash = null
  for (const line of log.stdout.split('\n')) {
    const commit = CHANGES_HASH_LINE.exec(line)
    if (commit) hash = commit[1]
    else if (hash && line.startsWith(`${dir}/tasks/`)) {
      const id = CHANGES_FILE_ID.exec(line.slice(dir.length + 7))?.[1]
      if (candidates.has(id)) specs.push(`${hash}:${line}`)
    }
  }
  const reopened = new Set()
  for (const [spec, object] of rangeObjects(root, specs)) {
    const path = spec.slice(spec.indexOf(':') + 1)
    const task = parseTask(path, object.data.toString('utf8'))
    if (candidates.has(task.id) && task.status !== 'done') reopened.add(task.id)
  }
  return reopened
}

/**
 * The Conventional Commit types of the commits in the range that name each task, as a Map from
 * id to types (null for a free-form subject). The commit claim makes is left out: it says
 * nothing about the change.
 */
function changesTypes(commits, ids) {
  const types = new Map([...ids].map((id) => [id, []]))
  for (const commit of commits) {
    const type = CHANGES_TYPE.exec(commit.subject)?.[1].toLowerCase() ?? null
    for (const id of taskTrailers(commit.message).ids) {
      if (!types.has(id) || commit.subject === `chore: claim ${id}`) continue
      types.get(id).push(type)
    }
  }
  return types
}

/** The group of a task from its commit types: Added for any feat, Fixed when all are fix, else Changed. */
function changesGroup(types) {
  if (types.includes('feat')) return 'Added'
  if (types.length > 0 && types.every((type) => type === 'fix')) return 'Fixed'
  return 'Changed'
}

/** A task's evidence as one line, its relative links rewritten from the task file to the repository root. */
function changesEvidence(task) {
  if (!task.evidence) return ''
  const parts = [task.evidence.value, ...task.evidence.items].map((part) => part.trim()).filter((part) => part !== '')
  return parts.join('; ').replace(CHANGES_LINK, (whole, raw) => {
    const target = raw.startsWith('<') ? raw.slice(1, -1) : raw
    if (target === '' || target.startsWith('#') || target.startsWith('//') || CHANGES_SCHEME.test(target)) return whole
    const hash = target.indexOf('#')
    const path = resolveLinkPath(task.file, hash === -1 ? target : target.slice(0, hash))
    if (path === null) return whole
    const rewritten = `${path}${hash === -1 ? '' : target.slice(hash)}`
    return raw.startsWith('<') ? `](<${rewritten}>)` : `](${rewritten})`
  })
}

/** The draft as data: { since, from, to, grouped, tasks: [{ id, title, file, group, evidence }], dropped }. */
function changesData(root, since) {
  const head = changesGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  if (head.status !== 0) fail('this repository has no commits yet')
  const loaded = loadConfig(treeReader({ kind: 'commit', rev: head.stdout, root }))
  if (!loaded.config) fail(loaded.problems.map((problem) => problem.message).join('; '))
  const { dir } = loaded.config
  const start = changesStart(root, since)

  const now = changesTasks(root, head.stdout, dir)
  const before = start.commit ? changesTasks(root, start.commit, dir) : new Map()
  const doneBefore = new Set([...now.keys()].filter((id) => now.get(id).status === 'done' && before.get(id)?.status === 'done'))
  const reopened = start.commit ? changesReopened(root, dir, start.commit, doneBefore) : new Set()
  const finished = [...now.values()].filter((task) => task.status === 'done' && (!doneBefore.has(task.id) || reopened.has(task.id)))
  const dropped = [...now.values()].filter((task) => task.status === 'dropped' && before.get(task.id)?.status !== 'dropped')

  const commits = readCommits(root, start.commit ? [`${start.commit}..${head.stdout}`] : [head.stdout])
  const types = changesTypes(commits, finished.map((task) => task.id))
  const grouped = [...types.values()].some((list) => list.some((type) => type !== null))
  const tasks = finished
    .sort((a, b) => compareTaskIds(a.id, b.id))
    .map((task) => ({ id: task.id, title: task.title, file: task.file, group: grouped ? changesGroup(types.get(task.id)) : null, evidence: changesEvidence(task) }))
  return { since: start.ref, from: start.commit, to: head.stdout, grouped, tasks, dropped: dropped.map((task) => task.id).sort(compareTaskIds) }
}

/** One Markdown list line: the id and title, then the evidence. */
function changesLine(task) {
  return `- ${task.id} ${task.title}${task.evidence ? ` — ${task.evidence}` : ''}`
}

/** The draft as Markdown, ready to paste into a CHANGELOG. */
function changesMarkdown(data) {
  const lines = [data.since ? `## Changes since ${data.since}` : '## Changes since the first commit', '']
  if (!data.since) lines.push('No tag is reachable from HEAD, so this covers the whole history.', '')
  if (data.tasks.length === 0) lines.push(`No task became done since ${data.since ?? 'the first commit'}.`, '')
  else if (!data.grouped) lines.push(...data.tasks.map(changesLine), '')
  else {
    for (const group of CHANGES_GROUPS) {
      const members = data.tasks.filter((task) => task.group === group)
      if (members.length > 0) lines.push(`### ${group}`, '', ...members.map(changesLine), '')
    }
  }
  if (data.dropped.length > 0) lines.push(`Not listed: ${data.dropped.join(', ')}, dropped in this range.`, '')
  return `${lines.join('\n').trimEnd()}\n`
}

/** changes [--since <ref>] [--json]: prints the draft; read-only. */
function changesCommand(args) {
  const options = changesOptions(args)
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }
  const data = changesData(root, options.since)
  if (options.json) console.log(JSON.stringify(data, null, 2))
  else process.stdout.write(changesMarkdown(data))
}

// --- managed.mjs ---
// The files ResaLedger manages, as hashes: the guard, the git hooks, the workflow and the AGENTS.md block.
// `resaledger update` uses these to tell a released file from one changed by hand, and so does
// the CI check (spec 10) when it judges a change to the guard or a hook.

/** The parts of a semantic version: { core: [major, minor, patch], pre: [...] }. */
function managedVersionParts(version) {
  const plain = String(version).split('+')[0]
  const dash = plain.indexOf('-')
  const core = (dash === -1 ? plain : plain.slice(0, dash)).split('.').map((part) => Number(part) || 0)
  return { core, pre: dash === -1 ? [] : plain.slice(dash + 1).split('.') }
}

/** Compares two semantic versions: negative when a is older, 0 when equal, positive when newer. */
function compareVersions(a, b) {
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
function normalizeManaged(text, dir = null) {
  const plain = text.replace(/\r\n?/g, '\n').trimEnd()
  if (!dir) return plain
  const literal = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return plain.replace(new RegExp(`(?<![\\w./-])${literal}/`, 'g'), '{{dir}}/')
}

/** The SHA-256 of a normalized text, in hex. */
function contentHash(text) {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * The released hashes this guard knows, { key: { version: hash } }: the table the bundler
 * embeds as RELEASED (earlier releases, and this version's hooks), plus this guard's own hash,
 * which it cannot embed in itself. Unbundled, the table is empty.
 */
function releasedTable() {
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
function mergeReleased(first, second) {
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
function packageReleased(folder) {
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

// --- enforcement.mjs ---
// Changes to enforcement (spec 10): what a pull request changes in the configuration, the guard,
// the git hooks and the workflow; which of those changes weaken the rules; and the decisions the
// pull request adds that let a weakening change through. The table of ids is in spec 10.

const ENFORCEMENT_HOOKS = '.githooks/'
// The file whose line keeps the hooks LF on Windows (spec 13); a change to it is listed.
const ENFORCEMENT_ATTRIBUTES = '.gitattributes'
const ENFORCEMENT_EXECUTABLE = '100755'
const ENFORCEMENT_WORKFLOW = '.github/workflows/resaledger.yml'
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
  const pushChanges = enforcementSwitch('agent.pushNeedsHandoff', before.agent.pushNeedsHandoff, after.agent.pushNeedsHandoff)
  return [...changes, ...denyChanges, ...pushChanges, ...unknownKeyChanges(before.unknown ?? {}, after.unknown ?? {})]
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
function enforcementCheck(root, { from, mergeBase, head, adds, released = releasedTable() }) {
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

// --- report.mjs ---
// The output of the CI check (spec 10): plain text for the log, Markdown for the job summary and
// the pull request comment, and the comment itself, posted once and then updated in place.

// The hidden first line of ResaLedger's pull request comment, which finds it again on later runs.
const CI_COMMENT_MARKER = '<!-- resaledger:ci -->'
const CI_COMMENT_PAGES = 10
const CI_COMMENT_TIMEOUT = 10000

/** The first 7 characters of a commit id, for messages. */
function ciShort(commit) {
  return commit ? commit.slice(0, 7) : 'none'
}

/** The one-line summary of a check, after its ✔ or ✖. */
function ciCheckLine(check, result) {
  const problems = check.problems.length > 0 ? `${plural(check.problems.length, 'problem')}; ` : ''
  const note = check.note ? ` (${check.note})` : ''
  const { counts } = check
  switch (check.name) {
    case 'records':
      return `records: ${problems}${recordCounts(counts.tasks, counts.decisions, counts.logs)}${note}`
    case 'commits':
      if (check.skipped) return `commits: not checked${note}`
      return `commits: ${problems}${plural(counts.commits, 'commit')} ${result.event === 'push' ? 'pushed' : 'from the merge base to the head'}${ciGitHubExempt(counts)}${note}`
    case 'ownership':
      return `ownership: ${problems}${plural(counts.changed, 'task')} changed${note}`
    case 'ids':
      return `ids: ${problems}${plural(counts.added, 'new id')}, against ${plural(counts.branches, 'branch', 'branches')}${note}`
    case 'moved':
      return `tasks moved: ${counts.moved}`
    case 'enforcement': {
      if (check.skipped) return `enforcement: not compared (${check.note})`
      if (counts.changes === 0) return 'enforcement: unchanged'
      const undecided = check.problems.length > 0 ? `${plural(check.problems.length, 'weakening change')} no decision names; ` : ''
      return `enforcement: ${undecided}${plural(counts.changes, 'change')}, ${counts.weakening} weakening`
    }
    case 'gates': {
      if (check.skipped) return `gates: none${note}`
      const gates = result.gates
      if (gates.mode === 'stamp') return `gates: ${problems}${gates.stamp ? `the head carries its stamp ${gates.stamp}` : 'no stamp for the head'} (ci.runGates is false)`
      const timings = gates.passed.map(({ command, seconds }) => `${command} ✔ ${seconds} s`)
      if (gates.failure) timings.push(`${gates.failure.command} ✖`)
      return `gates on ${ciShort(gates.ranOn)}: ${timings.length > 0 ? timings.join(' · ') : 'not run'}${note}`
    }
    default:
      return `${check.name}: ${problems}`.replace(/; $/, '')
  }
}

/** How many code commits passed as GitHub's merge or squash commits, trusted by their committer. */
function ciGitHubExempt(counts) {
  return counts.github > 0 ? `, ${counts.github} exempt as GitHub's merge or squash ${counts.github === 1 ? 'commit' : 'commits'} by the committer address` : ''
}

/** A change's text led by its id, which a configuration change's text already starts with. */
function ciChangeText(change, text) {
  return text.startsWith(`${change.id} `) || text.startsWith(`${change.id}:`) ? text : `${change.id}: ${text}`
}

/** The line of one change to enforcement: its id, what changed, and why it passes or fails. */
function ciChangeLine(change, check) {
  if (change.kind === 'listed') return ciChangeText(change, change.what)
  if (change.decidedBy) return `${ciChangeText(change, change.what)} · weakening, decided in ${change.decidedBy.file}${change.decidedBy.by ? ` by ${change.decidedBy.by}` : ''}`
  const problem = check.problems.find(({ id }) => id === change.id)
  return `✖ ${ciChangeText(change, problem ? problem.message : change.what)}`
}

/** A problem as one line: "file:line: message". */
function ciProblemLine({ file, line, message }) {
  return `${file ? `${file}${line ? `:${line}` : ''}: ` : ''}${message}`
}

// The commit the rules came from, by rules.from: a pull request's base or head, a push's commits.
const CI_RULES_SOURCES = { base: 'base', head: 'head', before: 'commit before the push', after: 'last pushed commit' }

/** Where the rules came from, as a sentence. */
function ciRulesLine(result) {
  const { rules, release } = result
  const source = `the ${CI_RULES_SOURCES[rules.from] ?? rules.from} ${ciShort(rules.commit)}`
  const from = rules.adds ? `This change adds ResaLedger, so it is judged by its own rules, from ${source}.` : `Rules from ${source}.`
  return release ? `${from} ResaLedger ${release.version} counts as released (--release).` : from
}

/** The status change of a moved task: "doing → done", or "new, todo" for a new task. */
function ciMove(task) {
  return task.from === null ? `new, ${task.to ?? 'no status'}` : `${task.from} → ${task.to ?? 'no status'}`
}

/** The CI result as plain text, for the log. */
function ciText(result) {
  const out = []
  if (result.event === 'push') {
    out.push(`ResaLedger ci: push${result.ref ? ` to ${result.ref}` : ''}, ${result.from ? `${ciShort(result.from)}..` : ''}${ciShort(result.head)}`)
  } else {
    out.push(
      `ResaLedger ci: pull request from "${result.lane}"${result.fork ? ' (a fork)' : ''}, head ${ciShort(result.head)}, base ${ciShort(result.base)}, merge base ${ciShort(result.mergeBase)}`
    )
  }
  if (result.skipped) {
    out.push(`Not checked: ${result.skipped}.`)
    return out.join('\n')
  }
  out.push(ciRulesLine(result))
  for (const check of result.checks) {
    out.push(`${check.ok ? '✔' : '✖'} ${ciCheckLine(check, result)}`)
    if (check.name === 'enforcement') {
      for (const change of result.enforcement) out.push(`  ${ciChangeLine(change, check)}`)
      continue
    }
    for (const problem of check.problems) out.push(`  ${ciProblemLine(problem)}`)
    if (check.name === 'moved') {
      for (const task of result.moved) out.push(`  ${task.id} ${task.title}: ${ciMove(task)}${task.evidence ? ` · Evidence: ${task.evidence}` : ''}`)
    }
  }
  return out.join('\n')
}

/**
 * Text from the records, made safe for Markdown: one line that renders as written. Code spans
 * stay as they are, since nothing renders inside them; elsewhere `<` becomes `&lt;` (no HTML or
 * hidden comments) and the punctuation of links, images and emphasis is escaped. A backtick run
 * with no closing run of the same length is escaped too, as CommonMark reads it literally.
 */
function ciMarkdownText(text) {
  const plain = String(text).replace(/\s+/g, ' ').trim()
  let out = ''
  let at = 0
  while (at < plain.length) {
    const tick = plain.indexOf('`', at)
    if (tick === -1) return out + ciMarkdownEscape(plain.slice(at))
    out += ciMarkdownEscape(plain.slice(at, tick))
    const run = /^`+/.exec(plain.slice(tick))[0]
    const close = ciClosingRun(plain, tick + run.length, run.length)
    if (close === -1) {
      out += ciMarkdownEscape(run)
      at = tick + run.length
      continue
    }
    out += plain.slice(tick, close + run.length)
    at = close + run.length
  }
  return out
}

/** Where the next run of exactly `length` backticks starts, from `from`, or -1. */
function ciClosingRun(text, from, length) {
  const runs = /`+/g
  runs.lastIndex = from
  for (let match = runs.exec(text); match !== null; match = runs.exec(text)) {
    if (match[0].length === length) return match.index
  }
  return -1
}

/**
 * Plain text outside code spans, escaped: backslashes, Markdown's inline punctuation and `<`.
 * Mentions (@name), issue references (#12, owner/repo#12, GH-12) get a word joiner (U+2060)
 * after the @, the # or GH: it is invisible, but GitHub then neither notifies anyone nor leaves
 * a reference in another issue. A backslash or an HTML entity would not stop either. A # inside
 * a URL and a GH- inside a path or slug are no references and stay as written.
 */
function ciMarkdownEscape(text) {
  return text
    .replace(/[\\`*_[\]~]/g, '\\$&')
    .replace(/</g, '&lt;')
    .replace(/(^|[^\w])@(?=\w)/g, '$1@\u2060')
    // A joiner after a URL's # would end GitHub's autolink there.
    .replace(/\S+/g, (token) => (token.includes('://') ? token : token.replace(/#(?=\d)/g, '#\u2060')))
    // GH-12 in capitals, not inside a path or a slug such as tasks/gh-2-fix.md or fix-GH-4.
    .replace(/(^|[^\w/.\\-])GH(?=-\d)/g, '$1GH\u2060')
}

/** A command as a Markdown code span, on one line. */
function ciMarkdownCode(text) {
  const plain = String(text).replace(/\s+/g, ' ').trim()
  return plain.includes('`') ? `\`\` ${plain} \`\`` : `\`${plain}\``
}

/** The title of the Markdown output: what was checked, and the verdict. */
function ciMarkdownTitle(result) {
  const what = result.event === 'push' ? `push${result.ref ? ` to ${result.ref.replace(/^refs\/heads\//, '')}` : ''}` : 'this pull request'
  const failed = result.checks.filter((check) => !check.ok).length
  const verdict = result.skipped ? 'not checked' : failed === 0 ? '✔ passed' : `✖ ${plural(failed, 'check')} failed`
  return `### ResaLedger · ${ciMarkdownText(what)} · ${verdict}`
}

/** The commits line: how many were checked and whether they pass. */
function ciCommitsSummary(result) {
  const check = result.checks.find(({ name }) => name === 'commits')
  if (!check) return null
  if (check.skipped) return `**Commits:** not checked${check.note ? ` (${ciMarkdownText(check.note)})` : ''}`
  const verdict = check.ok ? 'all pass' : plural(check.problems.length, 'problem')
  return `**Commits:** ${check.counts.commits} checked, ${verdict}${ciGitHubExempt(check.counts)}`
}

/** The gates line: each command with its time, where it ran, and where the rules came from. */
function ciGatesSummary(result) {
  const { gates } = result
  if (!gates) return null
  const from = `(rules from the ${result.rules.from} \`${ciShort(result.rules.commit)}\`)`
  if (gates.mode === 'none') return `**Gates:** none configured ${from}`
  if (gates.mode === 'stamp') return `**Gates:** ${gates.stamp ? `the head carries its stamp ${ciMarkdownCode(gates.stamp)}` : '✖ no stamp for the head'}, as ci.runGates is false ${from}`
  const timings = gates.passed.map(({ command, seconds }) => `${ciMarkdownCode(command)} ✔ ${seconds} s`)
  if (gates.failure) timings.push(`${ciMarkdownCode(gates.failure.command)} ✖ (exit ${gates.failure.status})`)
  return `**Gates** on \`${ciShort(gates.ranOn)}\`: ${timings.length > 0 ? timings.join(' · ') : 'not run'} ${from}`
}

/** The enforcement lines: "unchanged", or each change with its id. */
function ciEnforcementSummary(result) {
  if (result.enforcement === null) return []
  const check = result.checks.find(({ name }) => name === 'enforcement')
  if (check?.skipped) return [`**Enforcement:** not compared (${ciMarkdownText(check.note)})`]
  if (result.enforcement.length === 0) return ['**Enforcement:** unchanged']
  return ['**Enforcement:**', ...result.enforcement.map((change) => `- ${ciMarkdownText(ciChangeLine(change, check))}`)]
}

/**
 * The CI result as Markdown, for the job summary and the pull request comment: the tasks the
 * change moves with their evidence, the commits, the gates with their times and where the
 * rules came from, the changes to enforcement, then the problems and every check.
 */
function ciMarkdown(result) {
  const lines = [ciMarkdownTitle(result), '']
  if (result.skipped) return [...lines, `Not checked: ${ciMarkdownText(result.skipped)}.`, ''].join('\n')
  if (result.moved.length === 0) lines.push('No task changes its status.')
  for (const task of result.moved) {
    lines.push(`- **${ciMarkdownText(task.id)}** ${ciMarkdownText(task.title)} · ${ciMove(task)}`)
    if (task.evidence) lines.push(`  Evidence: ${ciMarkdownText(task.evidence)}`)
  }
  lines.push('')
  for (const line of [ciCommitsSummary(result), ciGatesSummary(result)]) if (line) lines.push(line, '')
  const enforcement = ciEnforcementSummary(result)
  if (enforcement.length > 0) lines.push(...enforcement, '')
  if (result.rules.adds || result.release) lines.push(ciMarkdownText(ciRulesLine(result)), '')

  const failed = result.checks.filter((check) => !check.ok && check.name !== 'enforcement')
  if (failed.length > 0) {
    lines.push('**Problems:**')
    for (const check of failed) {
      lines.push(`- ✖ ${ciMarkdownText(ciCheckLine(check, result))}`)
      for (const problem of check.problems) lines.push(`  - ${ciMarkdownText(ciProblemLine(problem))}`)
    }
    lines.push('')
  }
  lines.push('<details><summary>Every check</summary>', '')
  for (const check of result.checks) lines.push(`- ${check.ok ? '✔' : '✖'} ${ciMarkdownText(ciCheckLine(check, result))}`)
  lines.push('', '</details>', '')
  return lines.join('\n')
}

/** The Markdown of a check that could not run, such as in a shallow clone. */
function ciErrorMarkdown(message) {
  return ['### ResaLedger · ✖ the check could not run', '', ciMarkdownText(message), ''].join('\n')
}

/** Appends Markdown to the job summary when GITHUB_STEP_SUMMARY names a file; a failure prints one warning. */
function writeSummary(env, markdown) {
  const file = env.GITHUB_STEP_SUMMARY
  if (!file) return false
  try {
    appendFileSync(file, `${markdown}\n`)
    return true
  } catch (error) {
    console.error(`warning: ResaLedger could not write the job summary: ${error.message}`)
    return false
  }
}

/** One request to the GitHub REST API; throws with the method, the path and the status when it fails. */
async function ciRequest(url, method, token, body) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'resaledger',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(CI_COMMENT_TIMEOUT)
  })
  if (!response.ok) throw new Error(`${method} ${new URL(url).pathname} answered ${response.status}`)
  return response.status === 204 ? null : response.json()
}

/**
 * Posts ResaLedger's comment on a pull request, or updates it in place: lists the comments,
 * finds the one that starts with the marker, and PATCHes it, else POSTs a new one. Returns
 * 'created' or 'updated'; throws when the API fails.
 */
async function postComment({ api, repository, number, token, markdown }) {
  const root = `${api.replace(/\/+$/, '')}/repos/${repository}`
  const body = `${CI_COMMENT_MARKER}\n${markdown}`
  let existing = null
  for (let page = 1; page <= CI_COMMENT_PAGES && existing === null; page++) {
    const comments = await ciRequest(`${root}/issues/${number}/comments?per_page=100&page=${page}`, 'GET', token)
    if (!Array.isArray(comments)) throw new Error('the list of comments is not a list')
    existing = comments.find((comment) => typeof comment.body === 'string' && comment.body.startsWith(CI_COMMENT_MARKER)) ?? null
    if (comments.length < 100) break
  }
  if (existing) {
    await ciRequest(`${root}/issues/comments/${existing.id}`, 'PATCH', token, { body })
    return 'updated'
  }
  await ciRequest(`${root}/issues/${number}/comments`, 'POST', token, { body })
  return 'created'
}

/**
 * The comment of a CI run: on a pull request from this repository's event, with a token, posts
 * or updates it. Never throws: a failure prints one warning line, and the check is unchanged.
 */
async function ciComment(env, options, markdown) {
  if (options.event !== 'pull_request' || options.source !== 'github' || !options.number) return null
  if (options.fork) {
    console.log('No pull request comment: the pull request comes from a fork, whose token cannot write.')
    return null
  }
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) return null
  try {
    const api = env.GITHUB_API_URL || 'https://api.github.com'
    const done = await postComment({ api, repository: env.GITHUB_REPOSITORY, number: options.number, token: env.GITHUB_TOKEN, markdown })
    console.log(`Pull request comment ${done}.`)
    return done
  } catch (error) {
    console.error(`warning: ResaLedger could not comment on the pull request: ${error.message}`)
    return null
  }
}

// --- ci.mjs ---
// The CI check (spec 10): the hooks' rules where nobody can skip them, judged by the rules of the
// branch a pull request merges into. ciResult returns the result as data; ciCommand prints it,
// writes the job summary, comments on the pull request (report.mjs) and sets the exit code.

const CI_ZERO = /^0+$/
// The variables that give access to the repository or to GitHub's runner services. The gates run
// the pull request's code, so they never see them (spec 12).
const CI_GATES_HIDDEN = /^(GITHUB_TOKEN|ACTIONS_.*)$/i
const CI_FETCH_HINT =
  'Fetch the full history: in GitHub Actions, give actions/checkout "fetch-depth: 0"; elsewhere, run "git fetch --unshallow" or fetch the missing commits'

/** A failure that stops the check before it can judge anything, such as a missing commit. */
class CiError extends Error {}

/** Runs git in a folder and returns its trimmed output; throws with git's message when it fails. */
function ciGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

/** The full id of a revision's commit, or null when the clone does not have it. */
function ciCommit(root, rev) {
  try {
    return ciGit(root, ['rev-parse', '--verify', '-q', `${rev}^{commit}`]) || null
  } catch {
    return null
  }
}

/**
 * Resolves the revisions the check needs, or stops: a shallow clone or a missing commit cannot
 * be judged, because the merge base and the commit range would be wrong.
 */
function ciRequireHistory(root, revs) {
  let shallow = false
  try {
    shallow = ciGit(root, ['rev-parse', '--is-shallow-repository']) === 'true'
  } catch {
    throw new CiError('not inside a git repository')
  }
  const commits = revs.map((rev) => ({ rev, commit: ciCommit(root, rev) }))
  const missing = commits.filter(({ commit }) => commit === null).map(({ rev }) => rev)
  if (missing.length > 0) {
    throw new CiError(`${missing.length === 1 ? 'commit' : 'commits'} ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in this clone${shallow ? ', which is shallow' : ''}. ${CI_FETCH_HINT}`)
  }
  if (shallow) throw new CiError(`this clone is shallow, so the merge base and the commit range cannot be trusted. ${CI_FETCH_HINT}`)
  return commits.map(({ commit }) => commit)
}

/** The merge base of two commits, or a stop when they share no history. */
function ciMergeBase(root, a, b) {
  try {
    const base = ciGit(root, ['merge-base', a, b])
    if (base !== '') return base
  } catch {
    // Unrelated histories, reported below.
  }
  throw new CiError(`${ciShort(a)} and ${ciShort(b)} share no history, so there is no merge base to judge the change from. ${CI_FETCH_HINT}`)
}

/** Whether `ancestor` is an ancestor of `commit`. */
function ciIsAncestor(root, ancestor, commit) {
  return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, commit], { cwd: root, stdio: 'ignore' }).status === 0
}

/**
 * The rules: the configuration of `primary` (the base, or the commit before a push). When that
 * commit has no configuration, the change adds ResaLedger and is judged by the configuration of
 * `fallback`. Returns { config, from, commit, adds }; an invalid configuration stops the check.
 */
function ciRules(root, primary, fallback) {
  const candidates = [primary, fallback].filter((item) => item.commit !== null)
  for (const { commit, from } of candidates) {
    const reader = treeReader({ kind: 'commit', rev: commit, root })
    if (reader.read(CONFIG_FILE) === null) continue
    const { config, problems } = loadConfig(reader)
    if (!config) {
      const lines = problems.map(({ file, line, message }) => `  ${file}${line ? `:${line}` : ''}: ${message}`).join('\n')
      throw new CiError(`the configuration in ${ciShort(commit)} (the ${from}), which sets the rules, is invalid:\n${lines}`)
    }
    return { config, from, commit, adds: primary.commit !== null && from !== primary.from }
  }
  throw new CiError(`neither ${candidates.map(({ commit, from }) => `the ${from} ${ciShort(commit)}`).join(' nor ')} has ${CONFIG_FILE}, so there are no rules to check against`)
}

/**
 * The rules with the workspace folder of a commit's own valid configuration, so that each tree's
 * records are read where that tree keeps them: a pull request may move `dir` (spec 10). Every
 * other rule stays the base's.
 */
function ciTreeConfig(root, commit, config) {
  const own = loadConfig(treeReader({ kind: 'commit', rev: commit, root })).config
  return own && own.dir !== config.dir ? { ...config, dir: own.dir } : config
}

/** The records check of a commit: its own configuration must be valid, and every record. */
function ciRecordsCheck(root, commit, config) {
  const reader = treeReader({ kind: 'commit', rev: commit, root })
  const problems = []
  const own = loadConfig(reader)
  if (!own.config) problems.push(...own.problems)
  const workspace = loadWorkspace(reader, config)
  problems.push(...checkWorkspace(workspace, reader, config))
  return {
    name: 'records',
    ok: problems.length === 0,
    problems,
    counts: { tasks: workspace.tasks.length, decisions: workspace.decisions.length, logs: workspace.logs.length },
    note: null
  }
}

/**
 * The commits check of a range, with checkRange; `from` null checks nothing (a new branch). A
 * start older than the commit that added .resaledger.json moves up to it, as in handoff and
 * pre-push, so commits made before the project adopted ResaLedger are not judged.
 */
function ciCommitsCheck(root, from, to, config, lane, skipGitHubMerges, note) {
  if (from === null) return { name: 'commits', ok: true, skipped: true, problems: [], counts: { commits: 0 }, note }
  const start = adoptionStart(root, from, to)
  const commits = Number(ciGit(root, ['rev-list', '--count', `${start}..${to}`]))
  const exempt = new Map()
  const problems = checkRange(start, to, { config, lane, skipGitHubMerges, root, exempt })
  // Trusted by the committer address alone, so the output says how many (spec 10).
  return { name: 'commits', ok: problems.length === 0, problems, counts: { commits, github: exempt.get('github') ?? 0 }, note }
}

/**
 * The decisions and log entries the merge base has (in its folder `beforeDir`) and the head lacks
 * (in `afterDir`), as problems: they are only ever added (spec 6.2), and a renamed one would also
 * pass for a new decision.
 */
function ciRemovedRecords(root, mergeBase, head, beforeDir, afterDir) {
  const before = treeReader({ kind: 'commit', rev: mergeBase, root })
  const after = treeReader({ kind: 'commit', rev: head, root })
  const problems = []
  for (const [folder, kind] of [['decisions', 'decision'], ['log', 'log entry']]) {
    const prefix = `${beforeDir}/${folder}/`
    for (const file of before.list(`${beforeDir}/${folder}`)) {
      const name = file.slice(prefix.length)
      if (!/\.md$/i.test(file) || name.includes('/') || after.exists(`${afterDir}/${folder}/${name}`)) continue
      problems.push({ file, line: 0, message: `this ${kind} is deleted or renamed, but the merge base has it. Decisions and log entries are only added: restore it${kind === 'decision' ? ', and supersede it with a new decision' : ''}` })
    }
  }
  return problems
}

/** The text of a task's Evidence field, or null; "—", as new writes it, is empty. */
function ciEvidence(task) {
  if (!task.evidence) return null
  const parts = [task.evidence.value, ...task.evidence.items].map((part) => (part ?? '').trim()).filter((part) => !isEmptyValue(part))
  return parts.length > 0 ? parts.join('; ') : null
}

/** The tasks whose status differs between two task Maps, in id order: { id, title, file, from, to, evidence }. */
function ciMovedTasks(before, after) {
  const moved = []
  for (const [id, { task }] of after) {
    const from = before.get(id)?.task.status ?? null
    if (from === task.status) continue
    moved.push({ id, title: task.title, file: task.file, from, to: task.status, evidence: ciEvidence(task) })
  }
  return moved.sort((a, b) => compareTaskIds(a.id, b.id))
}

/** The names of the remotes of a clone. */
function ciRemotes(root) {
  return ciGit(root, ['remote'])
    .split('\n')
    .filter((name) => name !== '')
}

/**
 * The copies of tasks on the branches of the lanes they name (spec 6.2), read in one
 * `git cat-file --batch`. tasks is [{ id, task, holder }] from foreignLaneTasks. Returns a Map
 * from id to { branch, task, text }, task and text null when that branch has no such file; an
 * id whose lane has no branch in the clone is left out. No fetch: the workflow fetches every branch.
 */
function ciLaneCopies(root, tasks) {
  const copies = new Map()
  if (tasks.length === 0) return copies
  const branches = laneBranches(root, [...new Set(tasks.map(({ holder }) => holder))])
  const wanted = tasks.filter(({ holder }) => branches.has(holder)).map(({ id, task, holder }) => ({ id, branch: branches.get(holder), spec: `${branches.get(holder).commit}:${task.file}` }))
  const objects = rangeObjects(root, wanted.map(({ spec }) => spec))
  for (const { id, branch, spec } of wanted) {
    const object = objects.get(spec)
    const text = object?.type === 'blob' ? object.data.toString('utf8') : null
    const file = spec.slice(spec.indexOf(':') + 1)
    copies.set(id, { branch: branch.branch, task: text === null ? null : parseTask(file, text), text })
  }
  return copies
}

/** The refs of a pull request's own branch in the clone; none for a fork, whose branch name says nothing about this repository's. */
function ciOwnRefs(root, lane, fork) {
  const own = new Set()
  if (fork || !lane) return own
  own.add(`refs/heads/${lane}`)
  for (const remote of ciRemotes(root)) own.add(`refs/remotes/${remote}/${lane}`)
  return own
}

/**
 * The copies of the tasks a pull request holds on the other open branches of the clone (those
 * not merged into the base), from one `git for-each-ref --no-merged` and one
 * `git cat-file --batch`: [{ id, branch, task }]. held is from heldTasks; the pull request's
 * own branch, the head and the base are left out. No fetch: the workflow fetches every branch.
 */
function ciOpenCopies(root, held, context) {
  const { base, head, own } = context
  if (held.length === 0) return []
  const output = ciGit(root, ['for-each-ref', `--no-merged=${base}`, '--format=%(objectname)%00%(objecttype)%00%(refname)%00%(refname:short)%00%(symref)', 'refs/heads/', 'refs/remotes/'])
  const wanted = []
  for (const line of output.split('\n')) {
    const [commit, type, ref, branch, symref] = line.split('\0')
    if (type !== 'commit' || symref !== '' || own.has(ref) || commit === head || commit === base) continue
    for (const { id, task } of held) wanted.push({ id, branch, file: task.file, spec: `${commit}:${task.file}` })
  }
  const objects = rangeObjects(root, wanted.map(({ spec }) => spec))
  return wanted.flatMap(({ id, branch, file, spec }) => {
    const object = objects.get(spec)
    return object?.type === 'blob' ? [{ id, branch, task: parseTask(file, object.data.toString('utf8')) }] : []
  })
}

/**
 * The ids check of a pull request: ids the head adds (not at the merge base) against the base's
 * tip and every other branch in the clone, except the pull request's own branch (own, from ciOwnRefs).
 */
function ciIdsCheck(root, config, context) {
  const { mergeBaseTasks, headTasks, baseTasks, base, head, own } = context
  const added = [...headTasks.values()].filter(({ task }) => !mergeBaseTasks.has(task.id)).map(({ task }) => ({ id: task.id, file: task.file }))
  const others = [{ branch: config.base, files: new Map([...baseTasks.values()].map(({ task }) => [task.id, task.file])) }]
  let branches = 0
  if (added.length > 0) {
    const scanned = branchTaskFiles({ root, dir: config.dir, exclude: ({ ref, commit }) => commit === head || commit === base || own.has(ref) })
    branches = scanned.length
    others.push(...scanned)
  }
  const problems = idCollisions(added, others, config)
  return { name: 'ids', ok: problems.length === 0, problems, counts: { added: added.length, branches: branches + 1 }, note: null }
}

/** The environment of the gates: this process's, without the token and GitHub's runner credentials. */
function ciGatesEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CI_GATES_HIDDEN.test(name)))
}

/**
 * The gates of a pull request. With ci.runGates, the base's commit gates and then its verify
 * gates run in the working tree, which the workflow checks out at the head. Without it, the
 * head must carry a stamp for its own code and these gates. A working tree that is not at the
 * head fails the check without running them, since they would judge other code.
 */
function ciGatesCheck(root, config, head) {
  const guard = `node ${config.dir}/scripts/records.mjs`
  const commands = [...config.gates.commit, ...config.gates.verify]
  const result = { name: 'gates', ok: true, problems: [], counts: { gates: commands.length }, note: null }
  const gates = { mode: 'none', ranOn: null, passed: [], failure: null, stamp: null }
  if (commands.length === 0) return { check: { ...result, skipped: true, note: 'no gates are configured' }, gates }

  if (!config.ci.runGates) {
    const code = fingerprint({ kind: 'commit', rev: head, root }, config)
    const path = stampPath(config, code)
    const stamp = verifiedStamp(treeReader({ kind: 'commit', rev: head, root }), config, code)
    gates.mode = 'stamp'
    gates.ranOn = head
    gates.stamp = stamp === null ? null : path
    if (stamp === null) {
      result.ok = false
      result.problems.push({
        file: path,
        line: 0,
        message: `the head ${ciShort(head)} carries no stamp for its own code and these gates (ci.runGates is false, so CI checks the stamp instead of running the gates). Run "${guard} verify" on the head and commit the stamp`
      })
    }
    return { check: result, gates }
  }

  gates.mode = 'run'
  gates.ranOn = ciCommit(root, 'HEAD')
  if (gates.ranOn !== head) {
    result.note = `the working tree is at ${ciShort(gates.ranOn)}, not at the head ${ciShort(head)}`
    result.ok = false
    result.problems.push({ file: '', line: 0, message: `the gates did not run: ${result.note}, so they would judge other code. Check out the head before running ci` })
    return { check: result, gates }
  }
  const { passed, failure } = runGates(commands, { root, env: ciGatesEnv(process.env) })
  gates.passed = passed
  if (failure) {
    gates.failure = { command: failure.command, status: failure.status }
    result.ok = false
    result.problems.push({
      file: '',
      line: 0,
      message: `the gate "${failure.command}" failed with ${failure.status} on ${ciShort(gates.ranOn)}. Fix the code; a gate is never weakened to make it pass`
    })
  }
  return { check: result, gates }
}

/** The checks of a pull request, in order, and its result. */
function ciPullRequest(root, options) {
  const [base, head] = ciRequireHistory(root, [options.base, options.head])
  const mergeBase = ciMergeBase(root, base, head)
  const rules = ciRules(root, { commit: base, from: 'base' }, { commit: head, from: 'head' })
  const { config } = rules
  const { lane } = options
  // Each tree is read with its own folder, and tasks are compared by id, so a move of dir is judged.
  const configAt = (commit) => ciTreeConfig(root, commit, config)
  const tasksAt = (commit) => taskRecordsById(treeReader({ kind: 'commit', rev: commit, root }), configAt(commit).dir)
  const mergeBaseTasks = tasksAt(mergeBase)
  const headTasks = tasksAt(head)
  const baseTasks = base === mergeBase ? mergeBaseTasks : tasksAt(base)

  const checks = [ciRecordsCheck(root, head, configAt(head))]
  checks.push(ciCommitsCheck(root, mergeBase, head, config, lane, false, null))

  const ownership = ownershipProblems({
    before: mergeBaseTasks,
    after: headTasks,
    lane,
    config,
    holders: [baseTasks],
    accepted: [baseTasks],
    baseName: config.base
  })
  // A task that names another lane and changes here must be that lane's copy (a stacked branch).
  const reported = new Set(ownership.map(({ file }) => file))
  const foreign = foreignLaneTasks({ before: mergeBaseTasks, after: headTasks, lane, accepted: [baseTasks] }).filter(({ task }) => !reported.has(task.file))
  ownership.push(...laneCopyProblems(foreign, ciLaneCopies(root, foreign), config))
  // A task this lane holds that another open branch holds under another lane: a double claim.
  const own = ciOwnRefs(root, lane, options.fork)
  const held = lane ? heldTasks(headTasks, lane) : []
  ownership.push(...doubleClaimProblems(held, ciOpenCopies(root, held, { base, head, own }), lane, config))
  ownership.push(...ciRemovedRecords(root, mergeBase, head, configAt(mergeBase).dir, configAt(head).dir))
  const changed = [...headTasks].filter(([id, { text }]) => mergeBaseTasks.get(id)?.text !== text).length
  checks.push({ name: 'ownership', ok: ownership.length === 0, problems: ownership, counts: { changed }, note: null })
  checks.push(ciIdsCheck(root, config, { mergeBaseTasks, headTasks, baseTasks, base, head, own }))

  const moved = ciMovedTasks(mergeBaseTasks, headTasks)
  checks.push({ name: 'moved', ok: true, problems: [], counts: { moved: moved.length }, note: null })

  const { check, gates } = ciGatesCheck(root, configAt(head), head)
  checks.push(check)

  // The pull request's own changes start at the merge base; a merge base from before the base
  // added ResaLedger has no configuration, so the base stands in for it.
  const mergeBaseConfig = loadConfig(treeReader({ kind: 'commit', rev: mergeBase, root })).config
  const from = mergeBaseConfig ? mergeBase : base
  const enforcement = enforcementCheck(root, { from, mergeBase, head, adds: rules.adds, released: options.released ?? releasedTable() })
  checks.push(enforcement.check)
  return { mergeBase, rules, checks, moved, gates, enforcement: enforcement.changes }
}

/**
 * Why a push is not checked, or null. With --only-base-pushes, as the workflow runs it, only a
 * push to the base branch or a protected branch is checked; a lane's commits are checked in
 * its pull request.
 */
function ciSkippedPush(options, config) {
  if (!options.onlyBasePushes || !options.ref) return null
  const branches = [config.base, ...config.protected]
  const branch = options.ref.replace(/^refs\/heads\//, '')
  if (options.ref.startsWith('refs/heads/') && branches.includes(branch)) return null
  return `a push to ${options.ref}, which is not the base branch or a protected branch (--only-base-pushes); its commits are checked in their pull request`
}

/** The checks of a push, in order, and its result. */
function ciPush(root, options) {
  const newBranch = options.before === null || CI_ZERO.test(options.before)
  const [after] = ciRequireHistory(root, [options.after])
  let before = null
  let from = null
  if (!newBranch) {
    before = ciRequireHistory(root, [options.before])[0]
    // A forced push: only the commits that are new since the common history are checked.
    from = ciIsAncestor(root, before, after) ? before : ciMergeBase(root, before, after)
  }
  const rules = ciRules(root, { commit: before, from: 'before' }, { commit: after, from: 'after' })
  const { config } = rules
  const skipped = ciSkippedPush(options, config)
  if (skipped) return { from: null, rules, checks: [], moved: [], gates: null, enforcement: null, skipped }
  const checks = [ciRecordsCheck(root, after, ciTreeConfig(root, after, config))]
  const note = newBranch ? 'a new branch: its commits are checked in their pull request' : null
  checks.push(ciCommitsCheck(root, from, after, config, null, true, note))
  const tasksAt = (commit) => taskRecordsById(treeReader({ kind: 'commit', rev: commit, root }), ciTreeConfig(root, commit, config).dir)
  const moved = from === null ? [] : ciMovedTasks(tasksAt(from), tasksAt(after))
  checks.push({ name: 'moved', ok: true, problems: [], counts: { moved: moved.length }, note: null })
  return { from, rules, checks, moved, gates: null, enforcement: null }
}

/**
 * The released table of ci --release: this guard's own table with the unpacked package's added,
 * so that an update of the guard to that release passes without a decision. { version, table }.
 */
function ciRelease(folder) {
  try {
    const { version, table } = packageReleased(folder)
    return { version, table: mergeReleased(releasedTable(), table) }
  } catch (error) {
    throw new CiError(`--release: ${error.message}`)
  }
}

/**
 * The CI check as data. options is { event, source, base, head, lane, fork, number } for a pull
 * request or { event: 'push', source, before, after, ref } for a push, plus an optional root,
 * release (an unpacked package's folder) and onlyBasePushes.
 *
 * Returns { event, source, base, head, lane, fork, ref, mergeBase, from, rules, checks, moved,
 * gates, enforcement, release, skipped, ok }:
 * - rules: { from: 'base' | 'head' | 'before' | 'after', commit, adds } (adds: the change adds
 *   ResaLedger and is judged by its own rules);
 * - checks: [{ name, ok, skipped?, problems, counts, note }] in the order they ran: records,
 *   commits, ownership, ids, moved, gates, enforcement for a pull request; records, commits,
 *   moved for a push;
 * - moved: [{ id, title, file, from, to, evidence }];
 * - gates: { mode: 'run' | 'stamp' | 'none', ranOn, passed: [{ command, seconds }], failure,
 *   stamp } for a pull request, null for a push;
 * - enforcement: for a pull request, the changes to enforcement from the merge base to the head,
 *   [{ id, kind: 'listed' | 'weakening', file, what, decidedBy: { file, by } | null }]; empty
 *   when nothing changed or when the change adds ResaLedger; null for a push;
 * - release: { version, folder } when options.release names an unpacked package, else null;
 * - skipped: why a push is not checked (options.onlyBasePushes), else null; then checks is empty.
 * Throws a CiError when the check cannot run, such as for a missing commit.
 */
function ciResult(options) {
  let root = options.root
  if (!root) {
    try {
      root = repositoryRoot()
    } catch {
      throw new CiError('not inside a git repository')
    }
  }
  const pullRequest = options.event !== 'push'
  const release = options.release ? ciRelease(options.release) : null
  const outcome = pullRequest ? ciPullRequest(root, { ...options, released: release?.table }) : ciPush(root, options)
  return {
    event: options.event,
    source: options.source ?? 'flags',
    base: pullRequest ? ciCommit(root, options.base) : null,
    head: pullRequest ? ciCommit(root, options.head) : ciCommit(root, options.after),
    lane: pullRequest ? options.lane : null,
    fork: pullRequest ? Boolean(options.fork) : false,
    ref: options.ref ?? null,
    before: pullRequest ? null : options.before,
    mergeBase: outcome.mergeBase ?? null,
    from: outcome.from ?? null,
    rules: { from: outcome.rules.from, commit: outcome.rules.commit, adds: outcome.rules.adds },
    checks: outcome.checks,
    moved: outcome.moved,
    gates: outcome.gates,
    enforcement: outcome.enforcement,
    release: release ? { version: release.version, folder: options.release } : null,
    skipped: outcome.skipped ?? null,
    ok: outcome.checks.every((check) => check.ok)
  }
}

const CI_USAGE = 'use --base <rev> --head <rev> [--lane <branch>], --release <folder> and --only-base-pushes'

/** The flags of ci: { base, head, lane, release, onlyBasePushes }; throws on an unknown one. */
function ciFlags(args) {
  const flags = { onlyBasePushes: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--only-base-pushes') {
      flags.onlyBasePushes = true
      continue
    }
    if (!['--base', '--head', '--lane', '--release'].includes(arg)) throw new CiError(`unknown option "${arg}" for ci; ${CI_USAGE}`)
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new CiError(`${arg} needs a value`)
    flags[arg.slice(2)] = value
    index += 1
  }
  return flags
}

/**
 * The options of ci from its arguments, or from the GitHub event when --base and --head are not
 * given. --base and --head with --lane check a pull request from that lane; without --lane, they
 * check a push of the commits from --base to --head. --release and --only-base-pushes apply to both.
 */
function ciOptions(args, env = process.env) {
  const { base, head, lane, release = null, onlyBasePushes } = ciFlags(args)
  const extra = { release, onlyBasePushes }
  if (base || head || lane) {
    if (!base || !head) throw new CiError('ci needs both --base <rev> and --head <rev>, and --lane <branch> for a pull request')
    if (lane) return { event: 'pull_request', source: 'flags', base, head, lane, fork: false, number: null, ...extra }
    return { event: 'push', source: 'flags', before: base, after: head, ref: null, ...extra }
  }

  const name = env.GITHUB_EVENT_NAME
  const path = env.GITHUB_EVENT_PATH
  if (!name || !path) throw new CiError('no CI event found: run ci in GitHub Actions, or pass --base <rev> --head <rev> [--lane <branch>]')
  let payload
  try {
    payload = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new CiError(`cannot read the event file GITHUB_EVENT_PATH: ${error.message}`)
  }
  if (name === 'pull_request_target') {
    throw new CiError(
      'the pull_request_target event runs with a write token and the repository\'s secrets, which the gates would expose to the pull request\'s code, so ci refuses it. Run ci on pull_request (ResaLedger spec, section 10: CI)'
    )
  }
  if (name === 'pull_request') {
    const pr = payload.pull_request
    if (!pr?.base?.sha || !pr?.head?.sha || !pr?.head?.ref) throw new CiError(`the ${name} event has no pull_request.base.sha, head.sha and head.ref`)
    const baseRepo = pr.base.repo?.full_name ?? null
    const headRepo = pr.head.repo?.full_name ?? null
    const number = Number.isInteger(pr.number) ? pr.number : null
    return { event: 'pull_request', source: 'github', base: pr.base.sha, head: pr.head.sha, lane: pr.head.ref, fork: headRepo === null || headRepo !== baseRepo, number, ...extra }
  }
  if (name === 'push') {
    if (!payload.after) throw new CiError('the push event has no "after" commit')
    return { event: 'push', source: 'github', before: payload.before ?? null, after: payload.after, ref: payload.ref ?? null, ...extra }
  }
  throw new CiError(`the ${name} event is not one ci checks; run it on pull_request and push, or pass --base <rev> --head <rev> [--lane <branch>]`)
}

/**
 * ci [--base <rev> --head <rev> [--lane <branch>]] [--release <folder>] [--only-base-pushes]:
 * runs the CI check and prints it; writes the job summary when GITHUB_STEP_SUMMARY is set, also
 * when the check fails or cannot run; comments on the pull request when it can; exits 1 when a
 * check fails.
 */
async function ciCommand(args, env = process.env) {
  let options
  let result
  try {
    options = ciOptions(args, env)
    result = ciResult(options)
  } catch (error) {
    // Any error, such as a commit the range reader refuses, is a check that could not run: it
    // gets the summary and exit 1, never a stack trace.
    writeSummary(env, ciErrorMarkdown(error.message))
    fail(error.message)
  }
  console.log(ciText(result))
  const markdown = ciMarkdown(result)
  writeSummary(env, markdown)
  await ciComment(env, options, markdown)
  if (!result.ok) process.exit(1)
}

// --- claim.mjs ---
// claim (spec 6.3 and 6.5): take a task safely. It refuses a task that another visible lane
// holds (this worktree, the other local worktrees and the pushed branches as last fetched; the
// team preset fetches first) unless --take records the takeover. On a protected base, or with
// --branch or --worktree, it creates the lane first. It sets Status and Lane, keeping the rest of
// the file byte for byte, after checking the WIP limit and the plan. With claimPush or --push it
// commits the claim on its own, through the hooks, and pushes the branch.

const CLAIM_FETCH_TIMEOUT = 60 * 1000
const CLAIM_LINE_BREAK = /(\r\n|\r|\n)/

/** Prints a refusal and stops with exit code 1. */
function claimRefuse(message, details = []) {
  console.error(`✖ ${message}`)
  for (const detail of details) console.error(`  ${detail}`)
  process.exit(1)
}

/** Runs git in a folder: { status, stdout, stderr }, with stdout trimmed. */
function claimGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() }
}

/** git's first meaningful line of output, without its "fatal:" or "error:" prefix. */
function claimGitReason(result) {
  const lines = `${result.stderr}\n${result.stdout}`.split('\n').map((line) => line.replace(/^(?:fatal|error):\s*/, '').trim())
  return lines.find((line) => line !== '') ?? `git exited with ${result.status}`
}

/** The arguments of claim, as { id, take, branch, worktree, push }. */
function claimParseArgs(args) {
  const options = { id: null, take: false, branch: null, worktree: null, push: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--take') options.take = true
    else if (arg === '--push') options.push = true
    else if (arg === '--branch' || arg === '--worktree') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--') || value === '')
        claimRefuse(`${arg} needs a value, such as ${arg === '--branch' ? '--branch s4-store-documents' : '--worktree ../s4'}`)
      options[arg.slice(2)] = value
      index += 1
    } else if (arg.startsWith('--')) claimRefuse(`unknown option "${arg}" for claim; use --take, --branch <name>, --worktree <path> or --push`)
    else if (options.id === null) options.id = arg
    else claimRefuse(`claim takes one task id, not "${options.id}" and "${arg}"`)
  }
  if (options.id === null) claimRefuse('claim needs a task id, as in claim S4')
  if (!TASK_ID.test(options.id)) claimRefuse(`"${options.id}" is not a task id: write one to four capital letters and a number, such as S4 or S4.1`)
  return options
}

/**
 * git fetch --prune from the default remote, as { remote, ok, message }: message is git's first
 * line of error when the fetch fails, or why there is nothing to fetch from.
 */
function claimFetch(root, base) {
  const remote = defaultRemote(root, base)
  if (remote === null) return { remote: null, ok: false, message: 'there is no remote' }
  const result = spawnSync('git', ['fetch', '--prune', '--quiet', remote], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: CLAIM_FETCH_TIMEOUT
  })
  if (result.status === 0) return { remote, ok: true, message: null }
  const reason = result.error ? result.error.message : (result.stderr ?? '').split('\n').map((text) => text.replace(/^fatal:\s*/, '').trim()).find((text) => text !== '')
  return { remote, ok: false, message: reason ?? `git fetch exited with ${result.status}` }
}

/** The lane that holds a task: its Lane while doing, or blocked with a Lane; otherwise null. */
function claimHolder(task) {
  if (task.status === 'doing' || task.status === 'blocked') return task.lane
  return null
}

/**
 * The lanes other than `lane` (null for none) that hold the task anywhere visible, as [{ lane, where, commit }],
 * the first sighting of each lane. A lane that some visible copy says was taken over from (with
 * claim --take) no longer holds the task. sources is [{ where, tasks, commit }].
 */
function claimOtherHolders(id, lane, sources) {
  const copies = sources.flatMap((source) => source.tasks.filter((task) => task.id === id).map((task) => ({ task, source })))
  const replaced = new Set(copies.flatMap(({ task }) => (task.takenOverFrom ? task.takenOverFrom.split(/[\s,;`]+/) : [])))
  const holders = new Map()
  for (const { task, source } of copies) {
    const holder = claimHolder(task)
    if (!holder || holder === lane || replaced.has(holder) || holders.has(holder)) continue
    holders.set(holder, { lane: holder, where: source.where, commit: source.commit ?? null })
  }
  return [...holders.values()]
}

/** The short id of a holder's newest commit: its local branch, else where the claim was seen. */
function claimHolderCommit(root, holder) {
  for (const rev of [`refs/heads/${holder.lane}`, holder.commit]) {
    if (!rev) continue
    const result = claimGit(root, ['rev-parse', '--verify', '-q', '--short', `${rev}^{commit}`])
    if (result.status === 0 && result.stdout !== '') return result.stdout
  }
  return null
}

/**
 * The text with a field set: the field's line replaced when it exists, else a new line after
 * the block of the field `after` (or of the last field). Every other byte is kept, line breaks
 * included.
 */
function claimSetField(text, name, value, after) {
  const task = parseTask('task.md', text)
  const parts = text.split(CLAIM_LINE_BREAK)
  const line = `- ${name}: ${value}`
  const existing = task.fields.find((field) => field.name === name)
  if (existing) {
    parts[(existing.line - 1) * 2] = line
    return parts.join('')
  }
  const anchor = task.fields.findIndex((field) => field.name === after)
  const at = anchor === -1 ? task.fields.length - 1 : anchor
  let end // the 1-based last line of the anchor field's block
  if (at + 1 < task.fields.length) end = task.fields[at + 1].line - 1
  else {
    end = task.fields[at].line
    while (parts[end * 2] !== undefined && /^[ \t]+\S/.test(parts[end * 2])) end += 1
  }
  const separator = parts[(end - 1) * 2 + 1]
  if (separator === undefined) parts.push(text.includes('\r\n') ? '\r\n' : '\n', line)
  else parts.splice(end * 2, 0, line, separator)
  return parts.join('')
}

/** The task file's text claimed for a lane: Status doing, Lane, and Taken over from with --take. */
function claimText(text, lane, takenOver) {
  let claimed = claimSetField(text, 'Status', 'doing', null)
  claimed = claimSetField(claimed, 'Lane', lane, 'Status')
  if (takenOver) claimed = claimSetField(claimed, 'Taken over from', takenOver, 'Lane')
  return claimed
}

/** Commits the claimed task file on its own, through the hooks; refuses with git's output when that fails. */
function claimCommit(cwd, file, id) {
  const added = claimGit(cwd, ['add', '--', file])
  if (added.status !== 0) claimRefuse(`could not stage ${file}: ${claimGitReason(added)}`)
  const result = spawnSync('git', ['commit', '-q', '-m', `chore: claim ${id}`, '-m', `Task: ${id}`, '--', file], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.split('\n').filter((line) => line.trim() !== '')
    claimRefuse(`the claim commit was refused, so ${id} is claimed in ${file} but not committed:`, output)
  }
}

/**
 * claim <id> [--take] [--branch <name>] [--worktree <path>] [--push]: takes a task for a lane.
 * Prints one line saying what happened, then the next step.
 */
function claimCommand(args) {
  const options = claimParseArgs(args)
  const { id } = options
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }
  const reader = treeReader({ kind: 'worktree', root })
  const loaded = loadConfig(reader)
  if (!loaded.config) {
    for (const { file, line, message } of loaded.problems) console.error(`✖ ${file}${line ? `:${line}` : ''}: ${message}`)
    process.exit(1)
  }
  const { config } = loaded
  const guard = `node ${config.dir}/scripts/records.mjs`
  const here = currentLane()

  // Where the claim goes: in place, on a new branch here, or on a new branch in a new worktree.
  const protectedBase = here !== null && config.protected.includes(here)
  const mode = options.worktree !== null ? 'worktree' : options.branch !== null || protectedBase ? 'branch' : 'here'
  if (mode === 'here' && here === null)
    claimRefuse(`HEAD is detached, and a detached HEAD is not a lane. Switch to a branch first, or create one with "${guard} claim ${id} --branch <name>"`)

  const tasks = laneTasks(reader, config.dir)
  const task = tasks.find((each) => each.id === id)
  if (!task) claimRefuse(`there is no task ${id} in ${config.dir}/tasks; run "${guard} work" to see the tasks, or "${guard} new" to create one`)
  if (task.problems.length > 0) claimRefuse(`${task.file} cannot be read as a task:`, task.problems.map((problem) => problem.message))
  if (task.status === 'done' || task.status === 'dropped')
    claimRefuse(`${id} is ${task.status}, so there is nothing to claim. For more work on it, add a task with ${guard} new --under ${id} "<title>"`)

  // A new lane is named <branchPrefix><id>-<slug>, with the id in lowercase as branch names usually are.
  const slug = slugify(task.title ?? '')
  const lane = mode === 'here' ? here : (options.branch ?? `${config.branchPrefix}${id.toLowerCase()}${slug ? `-${slug}` : ''}`)
  if (mode !== 'here') {
    if (claimGit(root, ['check-ref-format', '--branch', lane]).status !== 0) claimRefuse(`"${lane}" is not a valid branch name; give another with --branch <name>`)
    if (claimGit(root, ['rev-parse', '--verify', '-q', `refs/heads/${lane}`]).status === 0)
      claimRefuse(`the branch "${lane}" already exists. Switch to it with "git switch ${lane}" and claim there, or name a new branch with --branch <name>`)
    if (config.branchRegex && lane !== config.base && !config.branchRegex.test(lane))
      claimRefuse(`the branch name "${lane}" does not match branchPattern ${JSON.stringify(config.branchPattern)} in .resaledger.json; name one that does with --branch <name>`)
  }
  let worktreePath = null
  if (mode === 'worktree') {
    worktreePath = resolve(options.worktree)
    if (existsSync(worktreePath)) claimRefuse(`${options.worktree} already exists; give --worktree a new folder`)
    const committed = treeReader({ kind: 'commit', rev: 'HEAD', root }).read(task.file)
    if (committed !== reader.read(task.file))
      claimRefuse(`${task.file} has changes that are not committed, and the new worktree starts from the last commit. Commit the task file first, then claim it`)
  }

  const remote = defaultRemote(root, config.base)
  const push = options.push || config.claimPush
  if (options.push && remote === null) claimRefuse('--push needs a remote to push to, and this repository has none. Add one with "git remote add origin <url>", or claim without --push')

  // Who else holds the task: the team preset fetches first, and goes on as last fetched when that fails.
  const notes = []
  if (config.preset === 'team') {
    const fetched = claimFetch(root, config.base)
    if (!fetched.ok) notes.push(`could not fetch${fetched.remote ? ` from ${fetched.remote}` : ''}: ${fetched.message}; checking the branches as last fetched`)
  }
  const head = claimGit(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])
  const others = localLanes(config)
  const sources = [{ where: 'this worktree', tasks, commit: head.status === 0 ? head.stdout : null }]
  for (const other of others) sources.push({ where: `the worktree at ${other.path}`, tasks: other.tasks, commit: null })
  try {
    const local = new Set([here, ...others.map((other) => other.branch)].filter((name) => name !== null))
    const pushed = remoteLanes({ root, config, local })
    for (const each of pushed.lanes) sources.push({ where: `the pushed branch ${each.remote}/${each.branch}`, tasks: each.tasks, commit: each.commit })
    if (pushed.base !== null) sources.push({ where: pushed.base, tasks: pushed.baseTasks, commit: null })
  } catch (error) {
    notes.push(`could not read the pushed branches: ${error.message}`)
  }
  for (const note of notes) console.error(`! ${note}`)

  // A new branch holds nothing yet: a lane of the same name elsewhere is another lane.
  const holders = claimOtherHolders(id, mode === 'here' ? lane : null, sources)
  if (holders.length > 0 && !options.take) {
    claimRefuse(
      `${id} is held by ${holders.length === 1 ? 'another lane' : `${holders.length} other lanes`}:`,
      [
        ...holders.map((holder) => `lane "${holder.lane}", in ${holder.where}`),
        `If that lane has stopped, take the task over with "${guard} claim ${id} --take"; it records where the task came from.`
      ]
    )
  }
  if (mode === 'here' && holders.length === 0 && task.status === 'doing' && task.lane === lane) {
    console.log(`✔ ${id} is already claimed in lane ${lane}; nothing changed`)
    console.log(`Next: ${guard} task ${id} for the plan, then work; run ${guard} handoff before you stop.`)
    return
  }
  const takenOver = holders.map((holder) => {
    const commit = claimHolderCommit(root, holder)
    return commit ? `${holder.lane} at ${commit}` : holder.lane
  })

  // The claim, checked before anything changes: the WIP limit, then the plan and the file's shape.
  const doing = tasks.filter((each) => each.id !== id && each.status === 'doing' && each.lane === lane).map((each) => each.id)
  if (doing.length + 1 > config.wip)
    claimRefuse(
      `the lane ${lane} already has ${doing.length} task${doing.length === 1 ? '' : 's'} doing (${doing.join(', ')}), and the limit is ${config.wip}. Finish one, or set it back to todo or blocked, then claim ${id}`
    )
  const text = reader.read(task.file) ?? ''
  const claimed = claimText(text, lane, takenOver.length > 0 ? takenOver.join(', ') : null)
  const context = {
    exists: (path) => reader.exists(path),
    read: (path) => reader.read(path),
    planStatus: (path) => {
      const plan = reader.read(path)
      return plan === null ? null : planStatus(plan)
    },
    taskIds: new Set(tasks.map((each) => each.id).filter(Boolean)),
    config
  }
  const problems = validateTask(parseTask(task.file, claimed), context)
  if (problems.length > 0) {
    const planMissing = problems.some((problem) => /needs a plan|is a proposal|^Plan /.test(problem.message))
    claimRefuse(
      `${id} cannot be claimed yet${planMissing ? ': it has no plan' : ''}. Nothing was changed.`,
      [
        ...problems.map((problem) => `${problem.file}${problem.line ? `:${problem.line}` : ''}: ${problem.message}`),
        planMissing ? `Write the plan, then run "${guard} claim ${id}" again.` : `Fix the task file, then run "${guard} claim ${id}" again.`
      ]
    )
  }

  // The lane, then the claim. A new lane's name must be free on the remote too.
  if (mode !== 'here' && remote !== null && claimGit(root, ['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${lane}`]).status === 0)
    claimRefuse(`a branch named "${lane}" is already pushed to ${remote}. Name a new branch with --branch <name>`)
  let target = root
  if (mode === 'branch') {
    const created = claimGit(root, ['checkout', '-q', '-b', lane])
    if (created.status !== 0) claimRefuse(`could not create the branch ${lane}: ${claimGitReason(created)}`)
  } else if (mode === 'worktree') {
    const created = claimGit(root, ['worktree', 'add', '-q', '-b', lane, worktreePath])
    if (created.status !== 0) claimRefuse(`could not create the worktree ${options.worktree}: ${claimGitReason(created)}`)
    target = worktreePath
  }
  writeFileSync(join(target, task.file), claimed)

  let pushedTo = null
  let unpushed = null
  if (push) {
    claimCommit(target, task.file, id)
    if (remote === null) unpushed = 'there is no remote, so the claim commit is not pushed. Add a remote and push the branch'
    else {
      const result = spawnSync('git', ['push', '-q', '-u', remote, lane], { cwd: target, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] })
      if (result.error) throw result.error
      if (result.status !== 0)
        claimRefuse(`${id} is claimed and committed, but the push failed: ${claimGitReason({ status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' })}`, [
          `Push it with "git push -u ${remote} ${lane}" so that others see the claim.`
        ])
      pushedTo = remote
    }
  }

  const how = []
  if (mode === 'branch') how.push(`on the new branch ${lane}${here === null ? '' : ` from ${here}`}`)
  else if (mode === 'worktree') how.push(`on the new branch ${lane} in the worktree ${options.worktree}`)
  else how.push(`in lane ${lane}`)
  if (takenOver.length > 0) how.push(`taken over from ${takenOver.join(', ')}`)
  if (pushedTo !== null) how.push(`committed and pushed to ${pushedTo}/${lane}`)
  else if (push) how.push('committed')
  console.log(`✔ ${id} claimed ${how.join(', ')}`)
  if (unpushed !== null) console.log(`! ${unpushed}`)
  else if (!push) console.log(`The claim is visible to the local worktrees now${remote === null ? '' : ', and to others once the branch is pushed'}.`)
  const cd = mode === 'worktree' ? `cd ${options.worktree}, then ` : ''
  console.log(`Next: ${cd}${guard} task ${id} for the plan, then start work; run ${guard} handoff before you stop.`)
}

// --- create.mjs ---
// task and new (spec 6.7 and 8): read one task with its plan section, and create task,
// decision and log files with safe ids and names. A new id takes the next number after the
// highest visible in this worktree, the other local worktrees and every fetched branch, so
// that concurrent lanes do not pick the same one. Nothing is ever overwritten.

const CREATE_PREFIX = /^[A-Z]{1,4}$/
const CREATE_FILE_ID = /^([A-Z]{1,4}\d+(?:\.\d+)*)(?:-[^/]+)?\.md$/
const CREATE_TITLE_MAX = 100
const CREATE_PLACEHOLDER = '—'

/** The numbers of an id with a given prefix, or null when the id has another prefix. */
function createIdNumbers(id, prefix) {
  const match = /^([A-Z]+)(\d+(?:\.\d+)*)$/.exec(id ?? '')
  if (!match || match[1] !== prefix) return null
  return match[2].split('.').map(Number)
}

/** The next top-level id for a prefix: one more than the highest number among the known ids (a gap is not reused). */
function nextTaskId(prefix, known) {
  let highest = 0
  for (const id of known) {
    const numbers = createIdNumbers(id, prefix)
    if (numbers && numbers[0] > highest) highest = numbers[0]
  }
  return `${prefix}${highest + 1}`
}

/** The next child id of a parent: S4 gives S4.1, then S4.2; S4.1 gives S4.1.1. */
function nextChildId(parent, known) {
  let highest = 0
  for (const id of known) {
    if (!id || !id.startsWith(`${parent}.`)) continue
    const rest = id.slice(parent.length + 1)
    if (/^\d+$/.test(rest) && Number(rest) > highest) highest = Number(rest)
  }
  return `${parent}.${highest + 1}`
}

/** The repository root and the effective configuration, or a refusal. */
function createSetup() {
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }
  const reader = treeReader({ kind: 'worktree', root })
  const loaded = loadConfig(reader)
  if (!loaded.config) {
    for (const { file, line, message } of loaded.problems) console.error(`✖ ${file}${line ? `:${line}` : ''}: ${message}`)
    process.exit(1)
  }
  return { root, reader, config: loaded.config }
}

/** Prints a refusal and stops with exit code 1. */
function createRefuse(message) {
  console.error(`✖ ${message}`)
  process.exit(1)
}

/** The ids in a folder on disk, from the file names. */
function createIdsOnDisk(folder) {
  let names = []
  try {
    names = readdirSync(folder)
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
  }
  return names.map((name) => name.match(CREATE_FILE_ID)?.[1]).filter(Boolean)
}

/** Every task id visible from here: this worktree, the other local worktrees and every local and remote-tracking branch. */
function createKnownIds(root, config) {
  const known = new Set(createIdsOnDisk(join(root, config.dir, 'tasks')))
  for (const lane of localLanes(config)) {
    for (const task of lane.tasks) {
      if (task.id) known.add(task.id)
      const named = task.file.slice(task.file.lastIndexOf('/') + 1).match(CREATE_FILE_ID)
      if (named) known.add(named[1])
    }
  }
  for (const branch of branchTaskFiles({ root, dir: config.dir })) for (const id of branch.files.keys()) known.add(id)
  return known
}

/** Writes a new file and refuses when it exists; nothing is ever overwritten. */
function createWrite(root, path, text) {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  try {
    writeFileSync(full, text, { flag: 'wx' })
  } catch (error) {
    if (error.code === 'EEXIST') createRefuse(`${path} already exists; nothing was overwritten`)
    throw error
  }
}

/** One line typed on a terminal, or null when stdin is not a terminal or cannot be read. */
function createPrompt(question) {
  if (!process.stdin.isTTY) return null
  process.stderr.write(question)
  const buffer = Buffer.alloc(1)
  const bytes = []
  try {
    for (;;) {
      const read = readSync(0, buffer, 0, 1, null)
      if (read === 0 || buffer[0] === 10) break
      bytes.push(buffer[0])
    }
  } catch {
    return null
  }
  return Buffer.from(bytes).toString('utf8').replace(/\r$/, '')
}

/** An issue's title from the GitHub CLI, or null when gh is missing or fails. */
function createIssueTitle(root, issue) {
  const result = spawnSync('gh', ['issue', 'view', issue, '--json', 'title'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error || result.status !== 0) return null
  try {
    const title = JSON.parse(result.stdout).title
    return typeof title === 'string' ? title : null
  } catch {
    return null
  }
}

/** A title on one line, with runs of white space collapsed. */
function createCleanTitle(title) {
  return (title ?? '').replace(/\s+/g, ' ').trim()
}

/** Today's date in local time, as YYYY-MM-DD. */
function createToday() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** The names in a folder on disk, or none. */
function createNamesOnDisk(folder) {
  try {
    return readdirSync(folder)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []
    throw error
  }
}

/**
 * A dated file name that no visible tree has: <folder>/<date>-<slug>.md, or with -2, -3, …
 * when this worktree, another local worktree or any branch already has the name.
 */
function createDatedPath(root, config, folder, title, fallback) {
  const path = `${config.dir}/${folder}`
  const taken = new Set(createNamesOnDisk(join(root, path)))
  for (const lane of localLanes(config)) for (const name of createNamesOnDisk(join(lane.path, path))) taken.add(name)
  for (const branch of branchFolderNames({ root, folder: path })) for (const name of branch.names) taken.add(name)
  const base = `${createToday()}-${slugify(title) || fallback}`
  let name = `${base}.md`
  for (let number = 2; taken.has(name); number += 1) name = `${base}-${number}.md`
  return `${path}/${name}`
}

/** The person who decides: git's user.name, then the author name git would use, or null. */
function createAuthorName() {
  try {
    const name = git('config', 'user.name')
    if (name) return name
  } catch {
    // Not set.
  }
  return process.env.GIT_AUTHOR_NAME?.trim() || null
}

/** new decision "<title>" and new log "<title>". */
function createRecord(kind, title) {
  const { root, reader, config } = createSetup()
  const guard = `node ${config.dir}/scripts/records.mjs`
  if (kind === 'decision') {
    const path = createDatedPath(root, config, 'decisions', title, 'decision')
    const author = createAuthorName()
    // The file ends on the field list, so that a field appended at once, such as Weakens, joins it.
    createWrite(root, path, `# ${title}\n\n- Date: ${createToday()}\n- Decided by: ${author ?? CREATE_PLACEHOLDER}\n- Status: accepted\n`)
    console.log(`✔ created ${path}`)
    const missing = author ? '' : ' Fill in "Decided by" too: git has no user.name here.'
    console.log(`Next: add any more fields, such as "- Weakens: <id>", straight below the list, then a blank line and what was decided and why.${missing} Then run ${guard} check.`)
    return
  }
  const path = createDatedPath(root, config, 'log', title, 'entry')
  const lane = currentLane()
  const held = lane === null ? [] : laneTasks(reader, config.dir).filter((task) => task.id && task.status === 'doing' && task.lane === lane).map((task) => task.id)
  createWrite(root, path, `# ${createToday()} · ${title}\n\n- Lane: ${lane ?? CREATE_PLACEHOLDER}\n- Tasks: ${held.length > 0 ? held.join(', ') : CREATE_PLACEHOLDER}\n\n`)
  console.log(`✔ created ${path}`)
  console.log(`Next: write below the fields what was tried, what failed and what was learned. Then run ${guard} check.`)
}

/** The arguments of new, as { kind, prefix, title, under, issue }. */
function createParseArgs(args) {
  const positionals = []
  let under = null
  let issue = null
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--under' || arg === '--issue') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) createRefuse(`${arg} needs a value, such as ${arg === '--under' ? '--under S4' : '--issue 123'}`)
      if (arg === '--under') under = value
      else issue = value
      index += 1
    } else if (arg.startsWith('--')) createRefuse(`unknown option "${arg}" for new; use --under <id> or --issue <n>`)
    else positionals.push(arg)
  }
  if (positionals[0] === 'decision' || positionals[0] === 'log') {
    const kind = positionals[0]
    if (under !== null || issue !== null) createRefuse(`--under and --issue are for tasks, not for new ${kind}`)
    if (positionals.length > 2) createRefuse(`new ${kind} takes one title: put it in quotes, as in new ${kind} "<title>"`)
    return { kind, prefix: null, title: positionals[1] ?? '', under, issue }
  }
  if (positionals.length > 2) createRefuse('new takes a prefix and one title: put the title in quotes, as in new S "Store the orders"')
  let prefix = null
  let title = null
  if (positionals.length === 2) [prefix, title] = positionals
  else if (positionals.length === 1 && issue !== null && CREATE_PREFIX.test(positionals[0])) prefix = positionals[0]
  else title = positionals[0] ?? null
  if (prefix !== null && !CREATE_PREFIX.test(prefix)) createRefuse(`"${prefix}" is not a prefix: write one to four capital letters, such as S or API`)
  if (issue !== null) {
    if (!/^#?\d+$/.test(issue)) createRefuse(`"${issue}" is not an issue number: write --issue 123`)
    issue = issue.replace(/^#/, '')
  }
  if (under !== null) {
    if (!TASK_ID.test(under)) createRefuse(`"${under}" is not a task id: --under takes the id of an existing task, such as S4`)
    if (prefix !== null) createRefuse('--under takes the prefix from its parent: leave out the prefix')
  }
  return { kind: 'task', prefix, title, under, issue }
}

/**
 * new [<prefix>] "<title>" [--under <id>] [--issue <n>], new decision "<title>" and new log "<title>".
 * Creates the file, prints its path and the next step.
 */
function newCommand(args) {
  const options = createParseArgs(args)
  if (options.kind !== 'task') {
    const title = createCleanTitle(options.title)
    if (title === '') createRefuse(`the title is empty: write new ${options.kind} "<title>"`)
    createRecord(options.kind, title)
    return
  }

  const { root, config } = createSetup()
  const guard = `node ${config.dir}/scripts/records.mjs`
  let title = createCleanTitle(options.title)
  if (title === '' && options.title === null && options.issue !== null) {
    title = createCleanTitle(createIssueTitle(root, options.issue) ?? createPrompt(`Title for the task from issue #${options.issue}: `))
    if (title === '') createRefuse(`could not read the title of issue #${options.issue} with gh: give it yourself, as in new --issue ${options.issue} "<title>"`)
  }
  if (title === '') createRefuse('the title is empty: write new [<prefix>] "<title>", such as new S "Store the orders"')
  if ([...title].length > CREATE_TITLE_MAX) createRefuse(`the title has ${[...title].length} characters; shorten it to at most ${CREATE_TITLE_MAX} and put the detail in the task's ## Plan`)

  const known = createKnownIds(root, config)
  let id
  if (options.under !== null) {
    if (!createIdsOnDisk(join(root, config.dir, 'tasks')).includes(options.under))
      createRefuse(`there is no task ${options.under} in ${config.dir}/tasks: --under takes the id of a task in this worktree`)
    id = nextChildId(options.under, known)
  } else id = nextTaskId(options.prefix ?? 'T', known)

  const path = taskFileName(config.dir, id, title)
  // Evidence is written empty, so that finishing the task shows where its evidence goes.
  const fields = ['- Status: todo', `- Evidence: ${CREATE_PLACEHOLDER}`]
  if (options.issue !== null) fields.push(`- Issue: #${options.issue}`)
  createWrite(root, path, `# ${id} ${title}\n\n${fields.join('\n')}\n`)
  console.log(`✔ created ${path}`)
  console.log(`Next: write its goal and checks under "## Plan", or link "- Plan:" to a plan section; then ${guard} claim ${id}`)
}

/** task <id>: prints the task file, then the plan section its Plan link points to. */
function taskCommand(id) {
  if (!id) createRefuse('task needs an id, as in task S4')
  if (!TASK_ID.test(id)) createRefuse(`"${id}" is not a task id: write one to four capital letters and a number, such as S4 or S4.1`)
  const { reader, config } = createSetup()
  const task = laneTasks(reader, config.dir).find((each) => each.id === id)
  if (!task) createRefuse(`there is no task ${id} in ${config.dir}/tasks; run work to see the tasks, or new to create one`)

  const text = reader.read(task.file) ?? ''
  process.stdout.write(`${task.file}\n\n${text.endsWith('\n') ? text : `${text}\n`}`)
  if (task.plan === null) return

  const link = relativeLinks(task.plan)[0]
  if (!link || link.path === '') createRefuse(`the Plan field is not a link to a plan section: "${task.plan}". Write "- Plan: [<file>](../plan/<file>.md#<section>)"`)
  const path = resolveLinkPath(task.file, link.path)
  const planText = path === null ? null : reader.read(path)
  if (planText === null) createRefuse(`the Plan link ${link.target} points to ${path ?? 'outside the repository'}, which does not exist. Fix the link in ${task.file}`)
  let shown = planText
  if (link.anchor) {
    const section = findSection(planText, link.anchor)
    if (!section) createRefuse(`the Plan link points to #${link.anchor}, which is not a section in ${path}. Fix the anchor in ${task.file}`)
    const heading = planText.split(/\r?\n/)[section.line - 1]
    shown = [heading, ...section.lines].join('\n').replace(/\s+$/, '')
  }
  process.stdout.write(`\n${path}${link.anchor ? `#${link.anchor}` : ''}\n\n${shown.replace(/\s+$/, '')}\n`)
}

// --- main.mjs ---
// The command line of the guard. This module runs last in the bundle.
// VERSION is defined by scripts/bundle.mjs from package.json.

const HELP = `ResaLedger ${VERSION}

Usage: node ledger/scripts/records.mjs <command>

Commands:
  work [--all] [--fetch] [--json]
            the state: this lane, the other local worktrees, what is ready
            (also: status); turns on the git hooks; --all adds the pushed
            branches not merged into the base, --fetch fetches them first
  task <id> one task file, then the plan section its Plan link points to
  new [<prefix>] "<title>" [--under <id>] [--issue <n>]
            a todo task with the next free id (prefix T by default):
            higher than any in this worktree, the other worktrees and
            the fetched branches; --under S4 makes the next child, S4.1;
            --issue records the issue and, with no title, asks gh for it
  new decision "<title>"
            a decision file with today's date
  new log "<title>"
            a log entry with today's date and this lane
  claim <id> [--take] [--branch <name>] [--worktree <path>] [--push]
            take a task: refuses one another lane holds (here, in another
            worktree or on a pushed branch; team fetches first), sets
            Status: doing and Lane, and checks the WIP limit and the plan;
            --take takes it over and records where from; on a protected
            base, or with --branch, it creates the lane branch first;
            --worktree creates it in a new worktree; with claimPush or
            --push it commits the claim alone and pushes the branch
  changes [--since <ref>] [--json]
            the tasks that became done since a tag (the newest by default),
            with their evidence, grouped as Added, Changed and Fixed from
            the Conventional Commits that name them: a changelog draft in
            Markdown; read-only
  check     validate the records in the working tree
            (--index: the staged files; --rev <rev>: a commit;
            --range <from>..<to>: also that every commit names its task)
  ci [--base <rev> --head <rev> [--lane <branch>]] [--release <folder>]
     [--only-base-pushes]
            the CI check of a pull request or a push, read from the GitHub
            event; with --lane, a pull request from that lane, and without
            it, a push of the commits from --base to --head. It writes the
            job summary and comments on the pull request when it can.
            --release counts an unpacked resaledger package as released;
            --only-base-pushes checks only pushes to the base or a
            protected branch
  config    print the effective configuration
  gates     list the commit gates and the verify gates
  handoff   the end-of-session check: records, hooks, a clean tree, the
            stamp, current handoff notes and recorded, pushed commits
  hooks [--activate]
            say whether the git hooks are active; --activate turns them on
  verify [--force]
            run the gates on the committed code and write its stamp
            (--force: run them even when the stamp exists)
  hook <agent> <event>
            called by an agent's own hooks with its JSON on stdin; agent is
            claude, codex, cursor, gemini or copilot, event is session-start,
            pre-tool or stop. It refuses --no-verify, changes to
            core.hooksPath, forced pushes, pushes and edits on a protected
            branch, commands that throw work away (reset --hard, clean -f,
            checkout of paths, restore, switch -f) in a protected branch's
            checkout or another worktree, and agent.deny commands
            (exit code 2, the reason on stderr), and reminds once per
            session when handoff fails after the session changed the
            repository
  version   print the version
  help      print this help
`

/** A reader for files in the working tree at the repository root: text, or null when missing. */
function workingTreeReader(root) {
  return (path) => {
    try {
      return readFileSync(join(root, path), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
      throw error
    }
  }
}

/** Prints each problem as a refusal line on stderr. */
function printProblems(problems) {
  for (const { file, line, message } of problems) console.error(`✖ ${file}${line ? `:${line}` : ''}: ${message}`)
}

function configCommand() {
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }
  const { config, problems } = loadConfig(workingTreeReader(root))
  if (problems.length > 0) {
    printProblems(problems)
    process.exit(1)
  }
  console.log(effectiveConfigJson(config))
}

/**
 * All of stdin as text, up to its end; '' for a terminal. The caller (an agent, or git for
 * pre-push) may write after this process starts, and a pipe can be non-blocking, so a read
 * that finds nothing yet (EAGAIN) waits and tries again instead of taking the input as empty.
 * That wait ends after STDIN_WAIT_MS with what was read; a blocking pipe that never closes is
 * left to the caller's own hook timeout, as any read would be. process.stdin is never touched:
 * opening it makes the pipe non-blocking.
 */
const STDIN_WAIT_MS = 10 * 1000
function readStdin() {
  if (isatty(0)) return ''
  const chunks = []
  const buffer = Buffer.alloc(64 * 1024)
  const pause = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + STDIN_WAIT_MS
  for (;;) {
    let count
    try {
      count = readSync(0, buffer, 0, buffer.length, null)
    } catch (error) {
      if (error.code === 'EAGAIN' && Date.now() < deadline) {
        Atomics.wait(pause, 0, 0, 5)
        continue
      }
      if (['EAGAIN', 'EOF', 'EBADF'].includes(error.code)) break
      throw error
    }
    if (count === 0) break
    chunks.push(Buffer.from(buffer.subarray(0, count)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function hooksCommand(args) {
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }
  const dir = loadConfig(workingTreeReader(root)).config?.dir ?? DEFAULTS.dir
  const guard = `node ${dir}/scripts/records.mjs`
  const activate = args.includes('--activate')
  if (activate) {
    const result = activateHooks()
    if (result === 'activated') console.log('✔ git hooks turned on: core.hooksPath is .githooks')
    else if (result === 'active') console.log('✔ core.hooksPath is already .githooks')
    else {
      console.error(`✖ core.hooksPath is already "${result.foreign}", so ResaLedger changed nothing.
  Call the guard from those hooks instead:
    ${guard} pre-commit            (pre-commit)
    ${guard} pre-merge-commit      (pre-merge-commit)
    ${guard} commit-msg "$1"       (commit-msg)
    ${guard} pre-push "$@"         (pre-push, with its stdin)`)
      process.exit(1)
    }
  }
  if (hooksActive()) console.log('✔ the git hooks are active in this clone')
  else if (activate) fail('a hook in .githooks/ is missing or is not the ResaLedger hook; run "npx resaledger update" to restore it')
  else {
    console.error(`✖ the git hooks are not active in this clone; run "${guard} hooks --activate"`)
    process.exit(1)
  }
}

function main(argv) {
  const [command = 'help'] = argv
  if (command === 'version' || command === '--version') console.log(VERSION)
  else if (command === 'help' || command === '--help') process.stdout.write(HELP)
  else if (command === 'work' || command === 'status') workCommand(argv.slice(1))
  else if (command === 'task') taskCommand(argv[1])
  else if (command === 'new') newCommand(argv.slice(1))
  else if (command === 'claim') claimCommand(argv.slice(1))
  else if (command === 'changes') changesCommand(argv.slice(1))
  else if (command === 'ci') ciCommand(argv.slice(1))
  else if (command === 'check') checkCommand(argv.slice(1), checkRange)
  else if (command === 'config') configCommand()
  else if (command === 'gates') gatesCommand()
  else if (command === 'verify') verifyCommand(argv.slice(1))
  else if (command === 'handoff') handoffCommand(argv.slice(1))
  else if (command === 'hooks') hooksCommand(argv.slice(1))
  else if (command === 'pre-commit' || command === 'pre-merge-commit') preCommit(command)
  else if (command === 'commit-msg') {
    if (!argv[1]) fail('commit-msg needs the message file, as git passes it: commit-msg <file>')
    commitMsg(argv[1])
  } else if (command === 'pre-push') prePush(readStdin(), argv.slice(1))
  else if (command === 'hook') hookCommand(argv[1], argv[2], readStdin())
  else fail(`unknown command "${command}"; run "help" for the list`)
}

main(process.argv.slice(2))
