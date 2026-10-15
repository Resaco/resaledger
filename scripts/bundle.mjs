// Builds the guard: concatenates the modules in src/guard into one readable file,
// dist/records.mjs, that runs with no dependencies.
//
//   node scripts/bundle.mjs [--src <dir>] [--out <file>] [--released <file>] [--check]
//
// The modules follow a small convention so that plain concatenation is safe:
// - Internal imports are named only: import { a, b } from './x.mjs'. No aliases, no
//   namespace imports, no default imports, no side-effect imports.
// - node: imports are named only too. They are merged at the top of the bundle.
// - Exports are only export function, export async function, export const and
//   export class. No export default, no export lists, no re-exports.
// - Every top-level name is unique across the modules.
// - Top-level declarations start in column 0; everything nested is indented.
// - main.mjs comes last and may not be imported. An import cycle is an error.
// - VERSION is defined by the bundler from package.json; modules use it and never declare it.
// - RELEASED is defined by the bundler too: the hashes of the released guards, hooks and
//   workflows from templates/released.json (or --released), without this version's guard, which
//   cannot hold its own hash, and with this version's hooks and workflow. CI judges enforcement
//   changes by it.
//
// --check builds into a temporary folder, validates the result and writes nothing else.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions, contentHash, normalizeManaged } from '../src/guard/managed.mjs'

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RESERVED = ['VERSION', 'RELEASED']
// The managed files whose released hashes the guard needs to judge a change in CI.
const RELEASED_KEYS = /^(guard|hooks\/[\w-]+|workflow)$/
const NAME = /^[A-Za-z_$][\w$]*$/
const IMPORT = /^import\b([^'"]*?)\bfrom\s*(['"])([^'"]+)\2[ \t]*;?[ \t]*\r?\n?/gm
const EXPORT = /^export\s+(?:async\s+function\b|function\b|const\b|class\b)/

class BundleError extends Error {}

function reject(file, rule) {
  throw new BundleError(`${file}: ${rule}`)
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

function parseArgs(argv) {
  const options = {
    src: join(PACKAGE, 'src', 'guard'),
    out: join(PACKAGE, 'dist', 'records.mjs'),
    released: join(PACKAGE, 'templates', 'released.json'),
    check: false
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--check') options.check = true
    else if (arg === '--src' || arg === '--out' || arg === '--released') {
      if (!argv[i + 1]) throw new BundleError(`${arg} needs a value`)
      options[arg.slice(2)] = resolve(argv[i + 1])
      i += 1
    } else throw new BundleError(`unknown option ${arg}`)
  }
  if (!options.out.endsWith('.mjs')) throw new BundleError('--out must name a .mjs file')
  return options
}

/** The names a column-0 declaration line introduces: `const a`, `const { a, b: c }`, `function a`. */
function declaredNames(file, line, number) {
  const text = line.replace(/^export\s+/, '')
  const simple = text.match(/^(?:async\s+function\s*\*?|function\s*\*?|class)\s*([A-Za-z_$][\w$]*)/)
  if (simple) return [simple[1]]
  const binding = text.match(/^(?:const|let)\s+([A-Za-z_$][\w$]*)/)
  if (binding) return [binding[1]]
  const pattern = text.match(/^(?:const|let)\s*([{[])(.*?)([}\]])\s*=/)
  if (pattern) {
    return pattern[2]
      .split(',')
      .map((part) => part.replace(/^\s*\.\.\./, '').split(':').pop().split('=')[0].trim())
      .filter(Boolean)
  }
  if (/^(?:const|let)\b/.test(text)) reject(file, `line ${number}: a top-level destructuring must fit on one line`)
  if (/^var\b/.test(text)) reject(file, `line ${number}: var is not allowed; use const or let`)
  return []
}

/** One module: its imports, its top-level names, its exports and its body without imports or export keywords. */
function parseModule(path) {
  const file = basename(path)
  const source = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
  const internal = []
  const node = []
  const covered = new Set()

  for (const match of source.matchAll(IMPORT)) {
    const number = lineOf(source, match.index)
    covered.add(number)
    const clause = match[1].trim()
    const specifier = match[3]
    const where = `line ${number}`
    if (clause.startsWith('*')) reject(file, `${where}: namespace imports are not allowed; import names: import { a } from '${specifier}'`)
    if (!clause.startsWith('{') || !clause.endsWith('}'))
      reject(file, `${where}: default imports are not allowed; import names: import { a } from '${specifier}'`)
    const names = clause
      .slice(1, -1)
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
    for (const name of names) {
      if (/\sas\s/.test(name)) reject(file, `${where}: aliased imports are not allowed (${name.replace(/\s+/g, ' ')})`)
      if (!NAME.test(name)) reject(file, `${where}: cannot read the imported name "${name}"`)
    }
    if (specifier.startsWith('node:')) node.push({ specifier, names })
    else if (/^\.\/[\w.-]+\.mjs$/.test(specifier)) internal.push({ module: specifier.slice(2), names, line: number })
    else reject(file, `${where}: only node: built-ins and sibling modules (./name.mjs) can be imported, not "${specifier}"`)
  }

  const lines = source.split('\n')
  const declared = []
  const exported = []
  lines.forEach((line, index) => {
    const number = index + 1
    if (/^import\b(?![.(])/.test(line) && !covered.has(number))
      reject(file, `line ${number}: an import must be a named import with a from clause: import { a } from './x.mjs'`)
    if (/^export\b/.test(line)) {
      if (/^export\s+default\b/.test(line)) reject(file, `line ${number}: export default is not allowed; export a named function, const or class`)
      if (/^export\s*[{*]/.test(line)) reject(file, `line ${number}: export lists and re-exports are not allowed; put export before the declaration`)
      if (!EXPORT.test(line)) reject(file, `line ${number}: only export function, export async function, export const and export class are allowed`)
    }
    const names = declaredNames(file, line, number)
    for (const name of names) {
      if (RESERVED.includes(name)) reject(file, `line ${number}: ${name} is reserved; the bundler defines it`)
    }
    declared.push(...names.map((name) => ({ name, line: number })))
    if (/^export\b/.test(line)) exported.push(...names)
  })

  const body = source
    .replace(IMPORT, '')
    .replace(/^export\s+/gm, '')
    .replace(/^\n+/, '')
    .replace(/\n*$/, '\n')
  return { file, internal, node, declared, exported, body }
}

/** Dependency order, main.mjs last; dependencies before dependents, ties by name. */
function order(modules) {
  const byFile = new Map(modules.map((module) => [module.file, module]))
  for (const module of modules) {
    for (const { module: target, names, line } of module.internal) {
      if (target === module.file) reject(module.file, `line ${line}: a module cannot import itself`)
      if (target === 'main.mjs') reject(module.file, `line ${line}: main.mjs runs last and cannot be imported`)
      const imported = byFile.get(target)
      if (!imported) reject(module.file, `line ${line}: ./${target} does not exist`)
      for (const name of names) {
        if (!imported.exported.includes(name)) reject(module.file, `line ${line}: ${target} does not export ${name}`)
      }
    }
  }

  const sorted = []
  const state = new Map()
  const visit = (module, path) => {
    if (state.get(module.file) === 'done') return
    if (state.get(module.file) === 'visiting') {
      const cycle = [...path.slice(path.indexOf(module.file)), module.file].join(' -> ')
      reject(module.file, `import cycle: ${cycle}`)
    }
    state.set(module.file, 'visiting')
    const targets = [...new Set(module.internal.map(({ module: target }) => target))].sort()
    for (const target of targets) visit(byFile.get(target), [...path, module.file])
    state.set(module.file, 'done')
    sorted.push(module)
  }
  const files = [...byFile.keys()].sort()
  for (const file of files.filter((name) => name !== 'main.mjs')) visit(byFile.get(file), [])
  visit(byFile.get('main.mjs'), [])
  return sorted
}

function uniqueNames(modules) {
  const owners = new Map()
  const claim = (name, owner) => {
    const first = owners.get(name)
    if (first && first !== owner) reject(owner, `duplicate top-level name ${name}; ${first} defines it too`)
    owners.set(name, owner)
  }
  // A node: import becomes a top-level name of the bundle, shared by every module that imports it.
  const builtins = new Map()
  for (const module of modules) {
    for (const { specifier, names } of module.node) {
      for (const name of names) {
        const from = builtins.get(name)
        if (from && from.specifier !== specifier)
          reject(module.file, `duplicate top-level name ${name}; ${from.file} imports it from ${from.specifier}, this module from ${specifier}`)
        builtins.set(name, { specifier, file: module.file })
      }
    }
  }
  for (const [name, { specifier }] of builtins) claim(name, `the ${specifier} import`)
  for (const module of modules) {
    for (const { name, line } of module.declared) {
      const first = owners.get(name)
      if (first === module.file) reject(module.file, `line ${line}: duplicate top-level name ${name}`)
      claim(name, module.file)
    }
  }
}

/**
 * The table the guard embeds as RELEASED: { key: { version: hash } } for the guard, the hooks
 * and the workflow. This version's guard is left out, so a rebuild after release-hashes.mjs
 * records it gives the same bytes; this version's hooks and workflow are added from the templates.
 */
function embeddedReleased(file, version) {
  let table = {}
  if (existsSync(file)) {
    try {
      table = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      throw new BundleError(`${file} is not valid JSON (${error.message})`)
    }
  }
  const hooks = join(PACKAGE, 'templates', 'hooks')
  for (const name of readdirSync(hooks).sort()) {
    const key = `hooks/${name}`
    table[key] = { ...(table[key] ?? {}), [version]: contentHash(normalizeManaged(readFileSync(join(hooks, name), 'utf8'))) }
  }
  const workflow = join(PACKAGE, 'templates', 'workflow.yml')
  if (existsSync(workflow)) table.workflow = { ...(table.workflow ?? {}), [version]: contentHash(normalizeManaged(readFileSync(workflow, 'utf8'))) }
  const result = {}
  for (const key of Object.keys(table).sort()) {
    if (!RELEASED_KEYS.test(key)) continue
    const versions = Object.entries(table[key])
      .filter(([release]) => key !== 'guard' || release !== version)
      .sort(([a], [b]) => compareVersions(a, b))
    if (versions.length > 0) result[key] = Object.fromEntries(versions)
  }
  return result
}

function render(modules, version, released) {
  const merged = new Map()
  for (const module of modules) {
    for (const { specifier, names } of module.node) {
      const set = merged.get(specifier) ?? new Set()
      names.forEach((name) => set.add(name))
      merged.set(specifier, set)
    }
  }
  const imports = [...merged.keys()]
    .sort()
    .map((specifier) => `import { ${[...merged.get(specifier)].sort().join(', ')} } from '${specifier}'`)
  const header = [
    '#!/usr/bin/env node',
    `// ResaLedger ${version}`,
    '// The ResaLedger guard: one file with no dependencies, run by the git hooks, the agent',
    '// hooks and CI. Built from its source modules by scripts/bundle.mjs; do not edit it here.',
    ...imports,
    '',
    `const VERSION = '${version}'`,
    `const RELEASED = ${JSON.stringify(released)}`
  ]
  const sections = modules.map((module) => `// --- ${module.file} ---\n${module.body}`)
  return `${header.join('\n')}\n\n${sections.join('\n')}`
}

function validate(out) {
  const result = spawnSync(process.execPath, ['--check', out], { encoding: 'utf8' })
  if (result.status !== 0) throw new BundleError(`node --check failed on the bundle:\n${result.stderr.trim()}`)
}

function bundle(options) {
  if (!existsSync(options.src)) throw new BundleError(`${options.src} does not exist`)
  const files = readdirSync(options.src)
    .filter((name) => name.endsWith('.mjs'))
    .sort()
  if (!files.includes('main.mjs')) throw new BundleError('main.mjs: missing; the bundle needs an entry module')
  const modules = files.map((name) => parseModule(join(options.src, name)))
  const sorted = order(modules)
  uniqueNames(sorted)
  const { version } = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'))
  const output = render(sorted, version, embeddedReleased(options.released, version))

  if (options.check) {
    const folder = mkdtempSync(join(tmpdir(), 'resaledger-bundle-'))
    try {
      const out = join(folder, 'records.mjs')
      writeFileSync(out, output)
      validate(out)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
    return `bundle check passed: ${sorted.length} modules`
  }
  mkdirSync(dirname(options.out), { recursive: true })
  writeFileSync(options.out, output, { mode: 0o755 })
  validate(options.out)
  return `bundle written: ${sorted.length} modules`
}

try {
  console.log(bundle(parseArgs(process.argv.slice(2))))
} catch (error) {
  if (!(error instanceof BundleError)) throw error
  console.error(`bundle: ${error.message}`)
  process.exit(1)
}
