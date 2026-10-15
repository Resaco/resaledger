// The brand files in docs/assets/brand: each SVG holds only the drawing, each file is described
// in the folder's README, and the covers and small marks are the sizes the README promises.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { PACKAGE } from './helpers.mjs'

const BRAND = join(PACKAGE, 'docs', 'assets', 'brand')
const ELEMENTS = new Set(['svg', 'g', 'path'])
const ATTRIBUTES = new Set(['xmlns', 'viewBox', 'width', 'height', 'fill', 'fill-rule', 'd'])

/** The width and height of a PNG, from its IHDR chunk. */
function pngSize(file) {
  const data = readFileSync(file)
  assert.equal(data.toString('latin1', 12, 16), 'IHDR', `${file} is not a PNG`)
  return [data.readUInt32BE(16), data.readUInt32BE(20)]
}

test('every SVG holds only paths: no text, fonts, scripts, metadata, ids or layer names', () => {
  const files = readdirSync(BRAND).filter((name) => name.endsWith('.svg'))
  assert.ok(files.length >= 6, files.join(', '))
  for (const name of files) {
    const text = readFileSync(join(BRAND, name), 'utf8')
    for (const [, element] of text.matchAll(/<([A-Za-z][\w:-]*)/g)) assert.ok(ELEMENTS.has(element), `${name}: <${element}>`)
    for (const [, attribute] of text.matchAll(/\s([\w:-]+)="/g)) assert.ok(ATTRIBUTES.has(attribute), `${name}: ${attribute}=`)
    assert.doesNotMatch(text, /<!--|<!\[CDATA\[|<\?/, `${name}: a comment, CDATA or processing instruction`)
  }
})

test('the README describes every file, and every file it names exists', () => {
  const readme = readFileSync(join(BRAND, 'README.md'), 'utf8')
  const files = readdirSync(BRAND).filter((name) => name !== 'README.md')
  for (const name of files) assert.ok(readme.includes(`\`${name}\``), `${name} is not described in the README`)
  for (const [, name] of readme.matchAll(/`([\w-]+\.(?:svg|png))`/g)) assert.ok(files.includes(name), `the README names ${name}, which is missing`)
})

test('the covers are 1280×640 and each small mark is its own size', () => {
  for (const name of ['cover-dark.png', 'cover-light.png']) assert.deepEqual(pngSize(join(BRAND, name)), [1280, 640], name)
  for (const size of [16, 32, 64]) {
    for (const name of [`mark-${size}.png`, `mark-${size}-on-dark.png`]) assert.deepEqual(pngSize(join(BRAND, name)), [size, size], name)
  }
})
