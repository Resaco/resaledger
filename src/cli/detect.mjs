// What `init` finds in the project (spec section 13): the gate candidates from its build files,
// the proof that each one passes, and the commit style. The build files are read as text and
// never run; only the candidate commands themselves run, once each, with a time limit.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GITHOOKS_CONVENTIONAL } from '../guard/githooks.mjs'

/** The package.json scripts that count as gates, by kind: fast checks commit, slow ones verify. "check" often runs the tests, as in a Makefile. */
export const GATE_SCRIPTS = Object.freeze({ commit: ['lint', 'typecheck', 'check-types', 'format:check'], verify: ['check', 'test', 'build'] })

/**
 * The package.json scripts that are listed for the project to add by hand and never run: a name
 * does not say whether a script ends or changes files (test:watch, lint:fix).
 */
export const LISTED_SCRIPTS = /^(?:test|lint):./

/** The Makefile targets that count as gates. "check" often runs the tests, so it is a verify gate. */
export const MAKE_TARGETS = Object.freeze({ commit: ['lint'], verify: ['check', 'test', 'build'] })

/** The time limit of one candidate run, in seconds, by kind. A commit gate slower than a minute does not belong in pre-commit. */
export const GATE_TIME_LIMITS = Object.freeze({ commit: 60, verify: 300 })

/** Variables that keep the package managers and toolchains off the network while a candidate runs. */
export const OFFLINE_ENV = Object.freeze({
  npm_config_offline: 'true',
  YARN_ENABLE_OFFLINE_MODE: '1',
  UV_OFFLINE: '1',
  PIP_NO_INDEX: '1',
  CARGO_NET_OFFLINE: 'true',
  GOPROXY: 'off',
  GOTOOLCHAIN: 'local',
  GIT_TERMINAL_PROMPT: '0'
})

/** The commitlint configuration files; a "commitlint" key in package.json counts too. */
const COMMITLINT_FILES = [
  '.commitlintrc',
  '.commitlintrc.json',
  '.commitlintrc.yaml',
  '.commitlintrc.yml',
  '.commitlintrc.js',
  '.commitlintrc.cjs',
  '.commitlintrc.mjs',
  '.commitlintrc.ts',
  '.commitlintrc.cts',
  'commitlint.config.js',
  'commitlint.config.cjs',
  'commitlint.config.mjs',
  'commitlint.config.ts',
  'commitlint.config.cts',
  'commitlint.config.mts'
]

const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm']
]
const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile']
const COMMIT_STYLE_SAMPLE = 50
const OUTPUT_KEPT = 4000
const REASON_LINES = 5

// Reading the project's files.

/** The text of a file under the root, or null. */
function readProjectFile(root, file) {
  try {
    return readFileSync(join(root, file), 'utf8')
  } catch {
    return null
  }
}

/** The parsed package.json, or null when it is missing or broken. */
function readPackageJson(root) {
  const text = readProjectFile(root, 'package.json')
  if (text === null) return null
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** The package manager the lockfile names: npm, pnpm, yarn or bun; npm when there is none. */
export function packageManager(root) {
  for (const [file, manager] of LOCKFILES) if (existsSync(join(root, file))) return manager
  return 'npm'
}

/** The command that runs one package.json script with a package manager. */
export function scriptCommand(manager, name) {
  return manager === 'npm' && name === 'test' ? 'npm test' : `${manager} run ${name}`
}

/** The names of a Makefile's explicit targets; recipe lines, variables and special targets are skipped. */
export function makeTargets(text) {
  const targets = new Set()
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('\t') || line.trimStart().startsWith('#')) continue
    const rule = line.match(/^([^\s:=#][^:=#]*?)\s*::?(?!=)/)
    if (!rule) continue
    for (const name of rule[1].split(/\s+/)) if (name && !name.startsWith('.') && !name.includes('%') && !name.includes('$')) targets.add(name)
  }
  return targets
}

/** The table names of a TOML text, [a.b] and [[a.b]] alike, with quotes and spaces removed. */
export function tomlTables(text) {
  const tables = new Set()
  for (const raw of text.split(/\r?\n/)) {
    const header = raw.trim().match(/^\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/)
    if (header) tables.add(header[1].replace(/["'\s]/g, ''))
  }
  return tables
}

/** The requirement names in a TOML text: quoted strings shaped like "name>=1.0", and keys of *dependencies tables. */
export function tomlRequirements(text) {
  const names = new Set()
  let dependencyTable = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const header = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?/)
    if (header) {
      dependencyTable = /dependencies$/.test(header[1].replace(/["'\s]/g, ''))
      continue
    }
    if (dependencyTable) {
      const key = line.match(/^["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*=/)
      if (key) names.add(key[1].toLowerCase())
    }
    for (const quoted of line.matchAll(/"([^"]*)"|'([^']*)'/g)) {
      const requirement = (quoted[1] ?? quoted[2]).match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~;@]|$)/)
      if (requirement) names.add(requirement[1].toLowerCase())
    }
  }
  return names
}

/** The Python tools a pyproject.toml uses: ruff, mypy and pytest, by their tool table or a requirement. */
export function pythonTools(text) {
  const tables = [...tomlTables(text)]
  const requirements = tomlRequirements(text)
  const uses = (tool) => requirements.has(tool) || tables.some((table) => table === `tool.${tool}` || table.startsWith(`tool.${tool}.`))
  return ['ruff', 'mypy', 'pytest'].filter(uses)
}

// The candidates.

/** One candidate: { command, kind: 'commit' | 'verify', source }. */
function candidate(command, kind, source) {
  return { command, kind, source }
}

/** The candidates from package.json scripts, run with the lockfile's package manager. */
function packageCandidates(root) {
  const scripts = readPackageJson(root)?.scripts
  if (scripts === null || typeof scripts !== 'object') return []
  const manager = packageManager(root)
  const found = []
  for (const kind of ['commit', 'verify']) {
    for (const name of GATE_SCRIPTS[kind]) {
      if (typeof scripts[name] === 'string' && scripts[name].trim() !== '') found.push(candidate(scriptCommand(manager, name), kind, 'package.json'))
    }
  }
  return found
}

/** The commands of the scripts named test:… or lint:…, with the lockfile's package manager, in the file's order. */
export function listedScripts(root) {
  const scripts = readPackageJson(root)?.scripts
  if (scripts === null || typeof scripts !== 'object') return []
  const manager = packageManager(root)
  return Object.entries(scripts)
    .filter(([name, text]) => LISTED_SCRIPTS.test(name) && typeof text === 'string' && text.trim() !== '')
    .map(([name]) => scriptCommand(manager, name))
}

/** Prints the listed scripts after the gates, as candidates to add by hand. */
function logListed(listed, log) {
  if (listed.length === 0) return
  log('Not run: these scripts may be checks, but a name does not say whether a script ends or changes files; add the ones that should be gates to "gates" in .resaledger.json by hand:')
  for (const command of listed) log(`  ${command}`)
}

/** The candidates from the Makefile's targets; a target that a package.json script of the same name covers is skipped. */
function makeCandidates(root) {
  const file = MAKEFILES.find((name) => existsSync(join(root, name)))
  if (!file) return []
  const targets = makeTargets(readProjectFile(root, file) ?? '')
  const scripts = readPackageJson(root)?.scripts ?? {}
  const found = []
  for (const kind of ['commit', 'verify']) {
    for (const name of MAKE_TARGETS[kind]) {
      if (targets.has(name) && typeof scripts[name] !== 'string') found.push(candidate(`make ${name}`, kind, file))
    }
  }
  return found
}

/** The candidates from pyproject.toml, under "uv run" when there is a uv.lock. */
function pythonCandidates(root) {
  const text = readProjectFile(root, 'pyproject.toml')
  if (text === null) return []
  const prefix = existsSync(join(root, 'uv.lock')) ? 'uv run ' : ''
  const commands = { ruff: ['ruff check', 'commit'], mypy: ['mypy .', 'commit'], pytest: ['pytest', 'verify'] }
  return pythonTools(text).map((tool) => candidate(`${prefix}${commands[tool][0]}`, commands[tool][1], 'pyproject.toml'))
}

/** The candidates for a Cargo.toml: fmt for commits, clippy and the tests for verify, since both compile. */
function cargoCandidates(root) {
  if (!existsSync(join(root, 'Cargo.toml'))) return []
  return [candidate('cargo fmt --check', 'commit', 'Cargo.toml'), candidate('cargo clippy -- -D warnings', 'verify', 'Cargo.toml'), candidate('cargo test', 'verify', 'Cargo.toml')]
}

/** The candidates for a go.mod: vet for commits, the tests for verify. */
function goCandidates(root) {
  if (!existsSync(join(root, 'go.mod'))) return []
  return [candidate('go vet ./...', 'commit', 'go.mod'), candidate('go test ./...', 'verify', 'go.mod')]
}

/** Every gate candidate the project's files name, in the order of the sources, each command once. */
export function gateCandidates(root) {
  const all = [...packageCandidates(root), ...makeCandidates(root), ...pythonCandidates(root), ...cargoCandidates(root), ...goCandidates(root)]
  const seen = new Set()
  return all.filter((item) => !seen.has(item.command) && seen.add(item.command))
}

// The proof.

/** Stops a candidate and everything it started: its process group, or its process tree on Windows. */
function stopCandidate(child) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else process.kill(-child.pid, 'SIGKILL')
  } catch {
    // It has already ended.
  }
}

/** The last lines of a command's output, for the reason a candidate failed. */
function lastLines(output) {
  const lines = output.replace(/\s+$/, '').split(/\r?\n/).filter((line) => line.trim() !== '')
  return lines.slice(-REASON_LINES)
}

/**
 * Runs one candidate once through the shell from the root, with no input and the offline
 * variables, and stops it at its time limit. Resolves to the candidate with { passed, seconds,
 * reason, output }: reason is null when it passed.
 */
export function proveCandidate(root, item, options = {}) {
  const limit = options.timeLimits?.[item.kind] ?? GATE_TIME_LIMITS[item.kind]
  const env = { ...(options.env ?? process.env), ...OFFLINE_ENV }
  const started = Date.now()
  return new Promise((resolve) => {
    let output = ''
    let timedOut = false
    let settled = false
    const child = spawn(item.command, { cwd: root, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true })
    const keep = (chunk) => {
      output = (output + chunk).slice(-OUTPUT_KEPT)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const interrupt = () => {
      stopCandidate(child)
      process.exit(130)
    }
    process.once('SIGINT', interrupt)
    const finish = (status, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      process.removeListener('SIGINT', interrupt)
      child.stdout.destroy()
      child.stderr.destroy()
      const seconds = Math.round((Date.now() - started) / 100) / 10
      let reason = null
      if (timedOut) reason = `stopped after ${limit} s, its time limit`
      else if (error) reason = `could not start: ${error.message}`
      else if (status !== 0) reason = `exited with ${status}`
      resolve({ ...item, passed: reason === null, seconds, reason, output })
    }
    let grace = null
    const timer = setTimeout(() => {
      timedOut = true
      stopCandidate(child)
      // A process that left the group may hold the output open; it is not waited for.
      grace = setTimeout(() => finish(null), 2000)
    }, limit * 1000)
    child.on('error', (error) => finish(null, error))
    child.on('close', (code, signal) => finish(code ?? signal))
  })
}

/**
 * Proves each candidate in turn and prints the progress with log. Returns { gates: { commit,
 * verify }, results }, gates holding only the commands that passed, in the candidates' order.
 */
export async function proveCandidates(root, candidates, options = {}) {
  const log = options.log ?? ((line) => console.log(line))
  const results = []
  for (const [index, item] of candidates.entries()) {
    const limit = options.timeLimits?.[item.kind] ?? GATE_TIME_LIMITS[item.kind]
    log(`  [${index + 1}/${candidates.length}] ${item.command} (${item.kind} gate, from ${item.source}, up to ${limit} s)…`)
    const result = await proveCandidate(root, item, options)
    if (result.passed) log(`  ✔ ${item.command} passed in ${result.seconds} s`)
    else {
      log(`  ✖ ${item.command} ${result.reason}, so it is not added`)
      for (const line of lastLines(result.output)) log(`      ${line}`)
    }
    results.push(result)
  }
  const gates = { commit: [], verify: [] }
  for (const result of results) if (result.passed) gates[result.kind].push(result.command)
  return { gates, results }
}

/**
 * Finds the gate candidates and proves them: { gates, results, listed }, with the progress printed
 * by log, then the scripts listed to add by hand (listed holds their commands).
 */
export async function detectGates(root, options = {}) {
  const log = options.log ?? ((line) => console.log(line))
  const candidates = gateCandidates(root)
  const listed = listedScripts(root)
  if (candidates.length === 0) {
    log('Gates: the project names no check that ResaLedger knows (package.json scripts, Makefile, pyproject.toml, Cargo.toml, go.mod).')
    logListed(listed, log)
    return { gates: { commit: [], verify: [] }, results: [], listed }
  }
  log(`Gates: trying ${candidates.length} check${candidates.length === 1 ? '' : 's'} once each, offline; only those that pass are kept.`)
  const proved = await proveCandidates(root, candidates, { ...options, log })
  logListed(listed, log)
  return { ...proved, listed }
}

// The commit style.

/** True when the project has a commitlint configuration. */
export function hasCommitlintConfig(root) {
  if (COMMITLINT_FILES.some((file) => existsSync(join(root, file)))) return true
  const manifest = readPackageJson(root)
  return manifest !== null && 'commitlint' in manifest
}

/** "conventional" when a commitlint configuration exists or most of the last 50 commits follow Conventional Commits, else "free". */
export function detectCommitStyle(root) {
  if (hasCommitlintConfig(root)) return 'conventional'
  const log = spawnSync('git', ['log', `-${COMMIT_STYLE_SAMPLE}`, '--no-merges', '--format=%s'], { cwd: root, encoding: 'utf8' })
  if (log.status !== 0) return 'free'
  const subjects = log.stdout.split('\n').filter(Boolean)
  const conventional = subjects.filter((subject) => GITHOOKS_CONVENTIONAL.test(subject)).length
  return conventional * 2 > subjects.length ? 'conventional' : 'free'
}
