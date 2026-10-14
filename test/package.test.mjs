// The package itself: its manifest, its license and the shape of the built guard.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { PACKAGE, run, temporary } from './helpers.mjs'

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
