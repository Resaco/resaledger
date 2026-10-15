// The bundler: a small module set becomes one working file, and each broken
// convention stops the build with the file name and the rule.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { PACKAGE, run, temporary } from './helpers.mjs'

const BUNDLER = join(PACKAGE, 'scripts', 'bundle.mjs')
const { version } = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'))

const UTIL = `import { join } from 'node:path'

export function label(name) {
  return join('ledger', name)
}
`
const MAIN = `import { basename } from 'node:path'
import { label } from './util.mjs'

export function main(argv) {
  if (argv[0] === 'version') console.log(VERSION)
  else console.log(basename(label(argv[0])))
}

main(process.argv.slice(2))
`

/** Writes the modules into a fresh source folder and bundles them. */
function build(modules, ...options) {
  const folder = temporary('resaledger-bundle-test-')
  const src = join(folder, 'src')
  mkdirSync(src)
  for (const [name, text] of Object.entries(modules)) writeFileSync(join(src, name), text)
  const out = join(folder, 'dist', 'records.mjs')
  return { file: out, ...run(folder, process.execPath, [BUNDLER, '--src', src, '--out', out, ...options]) }
}

test('two modules become one file that runs version', () => {
  const built = build({ 'util.mjs': UTIL, 'main.mjs': MAIN })
  assert.equal(built.status, 0, built.out)
  const text = readFileSync(built.file, 'utf8')
  assert.equal(text.match(/^import .* from 'node:path'$/gm).length, 1, 'node: imports are merged')
  assert.match(text, /^import \{ basename, join \} from 'node:path'$/m)
  assert.ok(text.indexOf('// --- util.mjs ---') < text.indexOf('// --- main.mjs ---'), 'main.mjs comes last')
  assert.doesNotMatch(text, /^export /m)
  assert.doesNotMatch(text, /from '\.\/util\.mjs'/)
  const ran = run(PACKAGE, process.execPath, [built.file, 'version'])
  assert.equal(ran.status, 0, ran.out)
  assert.equal(ran.out.trim(), version)
  assert.equal(run(PACKAGE, process.execPath, [built.file, 'records.md']).out.trim(), 'records.md')
})

test('--check validates without writing the output', () => {
  const built = build({ 'util.mjs': UTIL, 'main.mjs': MAIN }, '--check')
  assert.equal(built.status, 0, built.out)
  assert.match(built.out, /check passed/)
  assert.equal(existsSync(built.file), false)
})

const BROKEN = [
  {
    rule: 'a duplicate top-level name',
    modules: { 'util.mjs': UTIL, 'other.mjs': 'export function label() {}\n', 'main.mjs': MAIN },
    message: /^bundle: util\.mjs: duplicate top-level name label; other\.mjs defines it too$/m
  },
  {
    rule: 'an aliased import',
    modules: { 'util.mjs': UTIL, 'main.mjs': MAIN.replace('{ label }', '{ label as name }') },
    message: /^bundle: main\.mjs: line 2: aliased imports are not allowed \(label as name\)$/m
  },
  {
    rule: 'a default export',
    modules: { 'util.mjs': 'export default function label() {}\n', 'main.mjs': MAIN },
    message: /^bundle: util\.mjs: line 1: export default is not allowed/m
  },
  {
    rule: 'an import cycle',
    modules: {
      'a.mjs': "import { b } from './b.mjs'\n\nexport function a() {\n  return b\n}\n",
      'b.mjs': "import { a } from './a.mjs'\n\nexport function b() {\n  return a\n}\n",
      'main.mjs': "import { a } from './a.mjs'\n\na()\n"
    },
    message: /^bundle: a\.mjs: import cycle: a\.mjs -> b\.mjs -> a\.mjs$/m
  },
  {
    rule: 'a default import',
    modules: { 'util.mjs': UTIL, 'main.mjs': MAIN.replace('{ label }', 'label') },
    message: /^bundle: main\.mjs: line 2: default imports are not allowed/m
  },
  {
    rule: 'a namespace import',
    modules: { 'util.mjs': UTIL, 'main.mjs': MAIN.replace('{ label }', '* as util') },
    message: /^bundle: main\.mjs: line 2: namespace imports are not allowed/m
  },
  {
    rule: 'an export list',
    modules: { 'util.mjs': `${UTIL}export { label as name }\n`, 'main.mjs': MAIN },
    message: /^bundle: util\.mjs: line 6: export lists and re-exports are not allowed/m
  },
  {
    rule: 'a declaration of VERSION',
    modules: { 'util.mjs': `${UTIL}export const VERSION = '0'\n`, 'main.mjs': MAIN },
    message: /^bundle: util\.mjs: line 6: VERSION is reserved/m
  },
  {
    rule: 'a name that the imported module does not export',
    modules: { 'util.mjs': UTIL.replace('export function', 'function'), 'main.mjs': MAIN },
    message: /^bundle: main\.mjs: line 2: util\.mjs does not export label$/m
  },
  {
    rule: 'a package import',
    modules: { 'util.mjs': UTIL.replace("'node:path'", "'path'"), 'main.mjs': MAIN },
    message: /^bundle: util\.mjs: line 1: only node: built-ins and sibling modules/m
  },
  {
    rule: 'a syntax error',
    modules: { 'util.mjs': `${UTIL}function (\n`, 'main.mjs': MAIN },
    message: /^bundle: node --check failed on the bundle/m
  }
]

for (const { rule, modules, message } of BROKEN) {
  test(`${rule} stops the build`, () => {
    const built = build(modules)
    assert.equal(built.status, 1, built.out)
    assert.match(built.out, message)
  })
}

test('the bundle embeds the released hashes, without its own guard, so a rebuild after a release is the same', () => {
  const folder = temporary('resaledger-bundle-released-')
  const without = join(folder, 'without.json')
  const withOwn = join(folder, 'with.json')
  writeFileSync(without, JSON.stringify({ guard: { '0.1.0': 'a'.repeat(64) }, 'agents-block': { '0.1.0': 'b'.repeat(64) } }))
  writeFileSync(withOwn, JSON.stringify({ guard: { '0.1.0': 'a'.repeat(64), [version]: 'c'.repeat(64) }, 'agents-block': { '0.1.0': 'b'.repeat(64) } }))
  const first = run(PACKAGE, process.execPath, [BUNDLER, '--out', join(folder, 'first.mjs'), '--released', without])
  const second = run(PACKAGE, process.execPath, [BUNDLER, '--out', join(folder, 'second.mjs'), '--released', withOwn])
  assert.equal(first.status, 0, first.out)
  assert.equal(second.status, 0, second.out)
  const text = readFileSync(join(folder, 'first.mjs'), 'utf8')
  assert.equal(text, readFileSync(join(folder, 'second.mjs'), 'utf8'))
  const released = JSON.parse(text.match(/^const RELEASED = (.*)$/m)[1])
  assert.deepEqual(released.guard, { '0.1.0': 'a'.repeat(64) })
  assert.equal(released['agents-block'], undefined, 'only the files CI judges are embedded')
  assert.match(released['hooks/pre-commit'][version], /^[0-9a-f]{64}$/)
})
