// The package itself: its manifest, its license and the shape of the built guard.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ENV, PACKAGE, repository, run, temporary } from './helpers.mjs'

const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'))

test('package.json has no dependencies and the published name, bin and engines', () => {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
    assert.equal(manifest[field], undefined, `${field} must not exist`)
  assert.equal(manifest.name, 'resaledger')
  assert.equal(manifest.type, 'module')
  assert.deepEqual(manifest.bin, { resaledger: 'bin/resaledger.mjs' })
  assert.deepEqual(manifest.engines, { node: '>=20' })
  assert.equal(manifest.license, 'MIT')
})

test('LICENSE holds the copyright line', () => {
  assert.match(readFileSync(join(PACKAGE, 'LICENSE'), 'utf8'), /^Copyright \(c\) 2026 Resaco Oy$/m)
})

test('the built guard starts with the shebang and the version, and prints the version', () => {
  const out = join(temporary(), 'records.mjs')
  const built = run(PACKAGE, process.execPath, [join(PACKAGE, 'scripts', 'bundle.mjs'), '--out', out])
  assert.equal(built.status, 0, built.out)
  const [first, second] = readFileSync(out, 'utf8').split('\n')
  assert.equal(first, '#!/usr/bin/env node')
  assert.equal(second, `// ResaLedger ${manifest.version}`)
  const ran = run(PACKAGE, process.execPath, [out, 'version'])
  assert.equal(ran.status, 0, ran.out)
  assert.equal(ran.out.trim(), manifest.version)
})

test('the package command prints the version', () => {
  const ran = run(PACKAGE, process.execPath, [join(PACKAGE, 'bin', 'resaledger.mjs'), '--version'])
  assert.equal(ran.status, 0, ran.out)
  assert.equal(ran.out.trim(), manifest.version)
})

/**
 * Runs npm in the package. Through npm's own script when the tests run under npm, which sets
 * npm_execpath; otherwise as a command, through a shell on Windows, where Node refuses to start
 * npm.cmd without one.
 */
/** Runs npm in the package, or in cwd: { status, stdout, out }, out holding stderr too. */
function npm(args, cwd = PACKAGE, env = ENV) {
  const [command, list, shell] = process.env.npm_execpath
    ? [process.execPath, [process.env.npm_execpath, ...args], false]
    : process.platform === 'win32'
      ? ['npm', args, true]
      : ['npm', args, false]
  const result = spawnSync(command, list, { cwd, env, encoding: 'utf8', shell })
  if (result.error) throw result.error
  return { status: result.status, stdout: result.stdout, out: `${result.stdout}${result.stderr}` }
}

/** Every file under a path in the package, as POSIX paths relative to the package. */
function filesUnder(path) {
  const full = join(PACKAGE, path)
  if (!existsSync(full)) return []
  if (!statSync(full).isDirectory()) return [path]
  return readdirSync(full).filter((name) => name !== '.DS_Store').flatMap((name) => filesUnder(`${path}/${name}`))
}

test('npm pack publishes exactly the files in "files", the built guard, package.json and README.md', () => {
  // --ignore-scripts: prepack would rebuild dist/records.mjs while other test files read it.
  // scripts/test.mjs has built it already.
  const packed = npm(['pack', '--dry-run', '--json', '--ignore-scripts'])
  assert.equal(packed.status, 0, packed.out)
  // Only stdout: npm may warn on stderr, as it does about an auth token in a release job.
  const listed = JSON.parse(packed.stdout.slice(packed.stdout.indexOf('[')))[0].files.map((file) => file.path).sort()
  const intended = [...new Set([...manifest.files.flatMap(filesUnder), 'dist/records.mjs', 'package.json', 'README.md'])].sort()
  assert.deepEqual(listed, intended)
  assert.ok(listed.includes('dist/records.mjs'))
  assert.ok(listed.includes('templates/released.json'))
  for (const path of listed) assert.doesNotMatch(path, /^(?:test|ledger|docs|scripts)\//, `${path} must not be published`)
})

test('npx in a repository whose package.json npm cannot resolve: refused with EOVERRIDE, and run with a neutral --prefix', () => {
  // Offline, with the packed package and a fresh cache: the project's own dependency is a local
  // folder, and its override conflicts with it, so npm refuses the project's tree.
  const folder = temporary()
  const packed = npm(['pack', '--json', '--ignore-scripts', '--pack-destination', folder])
  assert.equal(packed.status, 0, packed.out)
  const tarball = join(folder, JSON.parse(packed.stdout.slice(packed.stdout.indexOf('[')))[0].filename)
  const env = { ...ENV, npm_config_cache: join(folder, 'cache'), npm_config_offline: 'true', npm_config_yes: 'true', npm_config_update_notifier: 'false' }
  const r = repository()
  r.write('deps/local/package.json', '{ "name": "local", "version": "1.0.0" }\n')
  r.write('package.json', `${JSON.stringify({ name: '@scope/web', version: '1.0.0', dependencies: { local: 'file:./deps/local' }, overrides: { local: '2.0.0' } })}\n`)
  assert.equal(r.commit('initial').status, 0)

  const plain = npm(['exec', `--package=${tarball}`, '--', 'resaledger', '--version'], r.root, env)
  assert.notEqual(plain.status, 0)
  assert.match(plain.out, /EOVERRIDE/)

  // An empty folder as the prefix: npm reads no project, and the command still runs in the current folder.
  const neutral = join(folder, 'neutral')
  mkdirSync(neutral)
  const sub = join(r.root, 'src')
  mkdirSync(sub)
  writeFileSync(join(sub, 'app.js'), '')
  const init = npm(['exec', '--prefix', neutral, `--package=${tarball}`, '--', 'resaledger', 'init', '--yes', '--no-gates'], sub, env)
  assert.equal(init.status, 0, init.out)
  assert.ok(existsSync(join(r.root, 'ledger', 'scripts', 'records.mjs')), init.out)
  assert.equal(r.read('ledger/README.md').split('\n')[0], '# web')
  assert.deepEqual(readdirSync(neutral), [])
})
