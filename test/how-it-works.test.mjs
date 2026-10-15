// The How it works animation in docs/assets/how-it-works: each file is a small animated SVG that
// runs no script, loads nothing from outside itself and shows a still frame to readers who ask
// for less motion, so GitHub can show it inline in the README.
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { PACKAGE } from './helpers.mjs'

const FOLDER = join(PACKAGE, 'docs', 'assets', 'how-it-works')
const FILES = ['how-it-works-dark.svg', 'how-it-works-light.svg']
const LIMIT = 300 * 1024

test('each loop is a small, self-contained animated SVG with a still frame for reduced motion', () => {
  for (const name of FILES) {
    const path = join(FOLDER, name)
    const text = readFileSync(path, 'utf8')
    assert.ok(statSync(path).size < LIMIT, `${name} is ${statSync(path).size} bytes`)
    assert.match(text, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /, name)
    assert.match(text, /<\/svg>\n?$/, name)
    assert.match(text, /<title>[^<]+<\/title>/, `${name} has no title`)
    assert.doesNotMatch(text, /<script|\son[a-z]+=|javascript:/i, `${name} runs a script`)
    for (const [, url] of text.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
      assert.match(url, /^data:image\/png;base64,/, `${name} loads ${url.slice(0, 40)}`)
    }
    assert.doesNotMatch(text, /@import|url\((?!#)/, `${name} loads a stylesheet or a file`)
    assert.match(text, /@keyframes/, `${name} has no animation`)
    assert.match(text, /@media \(prefers-reduced-motion:reduce\)\{\*\{animation:none!important\}/, `${name} has no still frame`)
  }
})
