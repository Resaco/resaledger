// `resaledger init`: sets ResaLedger up in a repository (spec section 13). planInit() only
// reads: it checks every refusal and builds every file in memory. applyInit() writes the plan,
// adds the guard's calls to a hook manager and turns the git hooks on.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { CONFIG_FILE, CONFIG_VERSION, DEFAULTS, parseConfig } from '../guard/config.mjs'
import { SETUP_MARKER } from '../guard/records.mjs'
import { detectHookManager, HOOK_NAMES, integrateHookManager, renderHook } from './hooks.mjs'
import { LEGACY_CONFIG_FILE } from './legacy.mjs'
import { agentsBlock, BUILT_GUARD, claudeFile, detectBase, hasAgentsImport, HOOKS_FOLDER, realRelative, turnOnHooks, withAgentsBlock } from './setup.mjs'

const README_TEMPLATE = new URL('../../templates/readme.md', import.meta.url)
export const GOAL_MARKER = `${SETUP_MARKER}: what is being built, for whom, and what counts as finished, in one or two sentences.`
export const INIT_COMMIT_MESSAGE = ['chore: set up ResaLedger', 'Task: maintenance']

// The options, the answers and the project name.

/** Parses init's arguments: { flags: { team, dir, yes }, error }. error is null or a message. */
export function parseInitArgs(args) {
  const flags = { team: false, dir: null, yes: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--team') flags.team = true
    else if (arg === '--yes' || arg === '-y') flags.yes = true
    else if (arg === '--dir' || arg.startsWith('--dir=')) {
      const value = arg === '--dir' ? args[++index] : arg.slice('--dir='.length)
      if (value === undefined || value === '' || value.startsWith('--')) return { flags, error: '--dir needs a folder name, such as --dir records' }
      flags.dir = value
    } else return { flags, error: `unknown option "${arg}" for init; use --team, --dir <name> or --yes` }
  }
  return { flags, error: null }
}

/** The preset an answer to "solo or team?" names: an empty answer is solo; null when it names neither. */
export function presetFromAnswer(text) {
  const answer = text.trim().toLowerCase()
  if (answer === '' || answer === 's' || answer === 'solo') return 'solo'
  if (answer === 't' || answer === 'team') return 'team'
  return null
}

/** One line of text with its whitespace collapsed. */
function oneLine(text) {
  return String(text).replace(/\s+/g, ' ').trim()
}

/**
 * The options for planInit from the flags and the answers to the questions, if any were asked:
 * answers is { preset, goal }, each the text typed. --team wins over an answer; an empty or
 * missing goal leaves the marker.
 */
export function initOptions(flags, answers = {}) {
  const preset = flags.team ? 'team' : (presetFromAnswer(answers.preset ?? '') ?? 'solo')
  return { preset, dir: flags.dir ?? DEFAULTS.dir, goal: oneLine(answers.goal ?? '') }
}

/** The value of `name` in a TOML table such as [project], read line by line; null when absent. */
export function tomlTableName(text, table) {
  let inside = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      const header = line.match(/^\[\s*([A-Za-z0-9_.-]+)\s*\]\s*(?:#.*)?$/)
      inside = header !== null && header[1] === table
      continue
    }
    if (!inside) continue
    const value = line.match(/^name\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/)
    if (value) return value[1] !== undefined ? value[1].replace(/\\(["\\])/g, '$1') : value[2]
  }
  return null
}

/** The last part of go.mod's module path, without a major version suffix such as /v2; null when absent. */
export function goModuleName(text) {
  const module = text.match(/^\s*module\s+("?)([^\s"]+)\1\s*(?:\/\/.*)?$/m)
  if (!module) return null
  const parts = module[2].split('/').filter(Boolean)
  let last = parts.pop() ?? null
  if (last && /^v\d+$/.test(last) && parts.length > 0) last = parts.pop()
  return last
}

function readText(root, file) {
  try {
    return readFileSync(join(root, file), 'utf8')
  } catch {
    return null
  }
}

/**
 * The project's name, from the first of package.json, pyproject.toml, Cargo.toml and go.mod
 * that names it, or else the folder's name. The files are parsed as text, never run.
 */
export function projectName(root) {
  const readers = [
    ['package.json', (text) => {
      try {
        const name = JSON.parse(text)?.name
        return typeof name === 'string' ? name : null
      } catch {
        return null
      }
    }],
    ['pyproject.toml', (text) => tomlTableName(text, 'project')],
    ['Cargo.toml', (text) => tomlTableName(text, 'package')],
    ['go.mod', goModuleName]
  ]
  for (const [file, read] of readers) {
    const text = readText(root, file)
    const name = text === null ? null : read(text)
    if (name && oneLine(name)) return oneLine(name)
  }
  return basename(root)
}

/** The workspace README from the template, with the goal sentence or the goal's marker. */
export function renderReadme(name, goal) {
  const values = { name, goal: goal || GOAL_MARKER }
  return readFileSync(README_TEMPLATE, 'utf8').replace(/\{\{(name|goal)\}\}/g, (_, key) => values[key])
}

// The plan and its application.

function initGit(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' })
}

/** The files among paths with uncommitted changes, untracked files included, as git status shows them. */
function dirtyFiles(root, paths) {
  if (paths.length === 0) return []
  const status = initGit(root, ['status', '--porcelain', '--untracked-files=all', '--', ...paths])
  if (status.status !== 0) return [`(git status failed: ${status.stderr.trim()})`]
  return status.stdout.split('\n').filter(Boolean).map((line) => line.slice(3))
}

/**
 * Plans the setup without writing anything. options is { preset, dir, goal, guardPath }.
 * Returns { refusals, writes (path → text), executable, created, changed, managerFiles,
 * manager, instructions, warnings, dir, preset, goalMarker }. Nothing may be written when
 * refusals is not empty.
 */
export function planInit(root, options = {}) {
  const plan = {
    refusals: [],
    writes: new Map(),
    executable: new Set(),
    created: [],
    changed: [],
    managerFiles: [],
    manager: null,
    instructions: null,
    warnings: [],
    dir: null,
    preset: options.preset ?? 'solo',
    goalMarker: !options.goal
  }
  const refuse = (message) => plan.refusals.push(message)

  // 1. What stops it.
  if (existsSync(join(root, CONFIG_FILE))) {
    refuse(`${CONFIG_FILE} exists: this repository is already set up with ResaLedger. "npx resaledger update" renews the guard`)
    return plan
  }
  if (existsSync(join(root, LEGACY_CONFIG_FILE))) {
    refuse(`${LEGACY_CONFIG_FILE} exists: this is an agent-ledger 0.x workspace. Run "npx resaledger migrate" to convert it to ResaLedger 1.0`)
    return plan
  }
  // --dir follows the configuration's own rule for "dir".
  const named = parseConfig(JSON.stringify({ version: CONFIG_VERSION, dir: options.dir ?? DEFAULTS.dir }))
  if (!named.config) {
    for (const problem of named.problems) refuse(`--dir: ${problem.message}`)
    return plan
  }
  const dir = named.config.dir
  plan.dir = dir
  if (lstatSync(join(root, dir), { throwIfNoEntry: false })) {
    refuse(`${dir}/ exists, and ResaLedger did not create it; choose another workspace folder with --dir <name>`)
  }
  const guardPath = options.guardPath ?? BUILT_GUARD
  if (!existsSync(guardPath)) refuse(`the built guard ${guardPath} is missing; build it with "node scripts/bundle.mjs"`)
  const agentsPath = realRelative(root, 'AGENTS.md')
  if (agentsPath === null) refuse('AGENTS.md is a link to a file outside the repository; init does not write there')

  // 2. The git hooks: a hook manager's files, or .githooks/.
  const touched = [] // existing files init changes, for the uncommitted-changes check
  plan.manager = detectHookManager(root)
  if (plan.manager === 'husky') plan.managerFiles = HOOK_NAMES.map((name) => `.husky/${name}`)
  else if (plan.manager === 'simple-git-hooks') plan.managerFiles = ['package.json']
  else if (plan.manager) plan.instructions = integrateHookManager(root, plan.manager, dir).instructions // lefthook and pre-commit: a snippet, no writes
  else {
    for (const name of HOOK_NAMES) {
      const path = `${HOOKS_FOLDER}/${name}`
      const text = renderHook(name, dir)
      const current = readText(root, path)
      if (current !== null && current.replace(/\r\n?/g, '\n') !== text) {
        refuse(`${path} exists and is not ResaLedger's hook, so init would replace it; move its commands into a hook manager or elsewhere first`)
      }
      plan.writes.set(path, text)
      plan.executable.add(path)
    }
  }
  touched.push(...plan.managerFiles)

  // 3. The workspace and the configuration.
  const config = { version: CONFIG_VERSION, preset: plan.preset }
  if (dir !== DEFAULTS.dir) config.dir = dir
  const base = detectBase(root)
  if (base) config.base = base
  config.gates = { commit: [], verify: [] }
  const configText = `${JSON.stringify(config, null, 2)}\n`
  const parsed = parseConfig(configText)
  if (!parsed.config) for (const problem of parsed.problems) refuse(`the planned ${CONFIG_FILE} is invalid, which is a bug in resaledger: ${problem.message}`)
  plan.writes.set(CONFIG_FILE, configText)
  plan.writes.set(`${dir}/README.md`, renderReadme(projectName(root), options.goal ?? ''))
  if (existsSync(guardPath)) {
    plan.writes.set(`${dir}/scripts/records.mjs`, readFileSync(guardPath, 'utf8'))
    plan.executable.add(`${dir}/scripts/records.mjs`)
  }

  // 4. The root AGENTS.md and CLAUDE.md.
  if (agentsPath !== null) {
    const current = readText(root, agentsPath)
    plan.writes.set(agentsPath, withAgentsBlock(current ?? '', agentsBlock(dir)))
  }
  const claude = claudeFile(root, agentsPath)
  if (claude?.warning) plan.warnings.push(claude.warning)
  else if (claude) {
    const text = readFileSync(join(root, claude.path), 'utf8')
    if (!hasAgentsImport(text.split(/\r?\n/))) plan.writes.set(claude.path, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${text === '' ? '' : '\n'}@AGENTS.md\n`)
  }

  // 5. Uncommitted changes in a file init changes.
  for (const path of plan.writes.keys()) if (existsSync(join(root, path))) touched.push(path)
  const dirty = dirtyFiles(root, [...new Set(touched)])
  if (dirty.length > 0) refuse(`these files have uncommitted changes, and init would change them: ${dirty.join(', ')}. Commit or stash them first`)

  // 6. What changes.
  for (const [path, text] of plan.writes) {
    const current = readText(root, path)
    if (current === null) plan.created.push(path)
    else if (current !== text) plan.changed.push(path)
    else plan.writes.delete(path)
  }
  for (const path of plan.executable) if (!plan.writes.has(path)) plan.executable.delete(path)
  plan.created.sort()
  plan.changed.sort()
  return plan
}

/**
 * Writes a plan that has no refusals, adds the guard's calls to a hook manager and turns the
 * hooks on. Returns { created, changed, hooks, instructions }, hooks as turnOnHooks returns it.
 */
export function applyInit(root, plan) {
  if (plan.refusals.length > 0) throw new Error('applyInit: the plan has refusals')
  for (const [path, text] of plan.writes) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
    if (plan.executable.has(path)) chmodSync(full, 0o755)
  }
  const created = [...plan.created]
  const changed = [...plan.changed]
  let instructions = plan.instructions
  if (plan.manager === 'husky' || plan.manager === 'simple-git-hooks') {
    const before = new Set(plan.managerFiles.filter((path) => existsSync(join(root, path))))
    const result = integrateHookManager(root, plan.manager, plan.dir)
    for (const path of result.changed) (before.has(path) ? changed : created).push(path)
    instructions = result.instructions
  }
  return { created: created.sort(), changed: [...new Set(changed)].sort(), hooks: turnOnHooks(root), instructions }
}

/** A path as one sh word. */
function shellWord(path) {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`
}

/** The command that commits exactly the files init wrote. */
export function commitCommand(files) {
  const [header, trailer] = INIT_COMMIT_MESSAGE
  return `git add ${files.map(shellWord).join(' ')} && git commit -m "${header}" -m "${trailer}"`
}
