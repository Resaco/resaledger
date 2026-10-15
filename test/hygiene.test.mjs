// The hygiene rules of rule 1 in ledger/AGENTS.md: this repository's tracked files must be
// clean, and the scanners must catch each kind of violation. Planted strings are built from
// fragments at runtime, so this file passes its own scan.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkText, denyPatterns, formatFailure, scanTree } from '../scripts/hygiene.mjs'
import { formatHit, scanHistory } from '../scripts/scan-history.mjs'
import { ENV, PACKAGE, repository } from './helpers.mjs'

const AT = '@'
const SLASH = '/'
const HOME = ['', 'Users', 'jdoe'].join(SLASH)
const AGENT = ['.claude', 'memory'].join(SLASH)
const PRIVATE = ['zorb', 'ulon'].join('')

test('the tracked files of this repository are clean', () => {
  const failures = scanTree(PACKAGE, { env: ENV })
  assert.deepEqual(failures.map(formatFailure), [])
})

test('home-directory paths are caught with either slash, placeholders are not', () => {
  const rules = (text) => checkText(text).map((hit) => hit.rule)
  assert.deepEqual(rules(`cd ${HOME}/code`), ['home-path'])
  assert.deepEqual(rules(['', 'home', 'jdoe'].join(SLASH)), ['home-path'])
  assert.deepEqual(rules(['C:', 'Users', 'jdoe'].join('\\')), ['home-path'])
  assert.deepEqual(rules(['C:', 'Users', 'jdoe'].join(SLASH)), ['home-path'])
  assert.deepEqual(rules(['', 'Users', 'jdoe'].join('\\')), ['home-path'])
  for (const name of ['you', 'user', 'username', 'me', 'example', 'runner', 'name']) {
    assert.deepEqual(rules(['', 'Users', name, 'x'].join(SLASH)), [], name)
    assert.deepEqual(rules(['', 'home', name].join(SLASH)), [], name)
  }
  assert.deepEqual(rules(`https://example.com${SLASH}home${SLASH}page`), [])
})

test('private agent memory paths are caught, documented settings paths are not', () => {
  const rules = (text) => checkText(text).map((hit) => hit.rule)
  for (const part of ['clients', 'projects', 'memory']) {
    assert.deepEqual(rules(`~/${['.claude', part, 'x'].join(SLASH)}`), ['agent-memory'], part)
  }
  assert.deepEqual(rules(['.claude', 'settings.json'].join(SLASH)), [])
  assert.deepEqual(rules(`~/${['.claude', 'skills'].join(SLASH)}`), [])
})

test('email addresses are caught unless no-reply or reserved examples', () => {
  const rules = (text) => checkText(text).map((hit) => hit.rule)
  assert.deepEqual(rules(`mail jane${AT}corp.fi`), ['email'])
  assert.deepEqual(rules(`1+bot${AT}users.noreply.github.com`), [])
  for (const domain of ['example.com', 'example.org', 'example.net', 'mail.example.com']) {
    assert.deepEqual(rules(`a${AT}${domain}`), [], domain)
  }
  assert.deepEqual(rules(`react${AT}18.3.1 and actions/checkout${AT}v4`), [])
})

test('a string escape ends an address: an import after \\n is not one, an address after it is', () => {
  const rules = (text) => checkText(text).map((hit) => hit.rule)
  assert.deepEqual(rules(`'Use the test command.\\n\\n${AT}AGENTS.md\\n'`), [])
  assert.deepEqual(rules(`'Contact:\\njane${AT}corp.fi'`), ['email'])
  assert.deepEqual(rules(`'\\tjane${AT}corp.fi'`), ['email'])
})

test('deny-list entries match whole words, case-insensitively, spaces included', () => {
  const rules = (text, entries) => checkText(text, denyPatterns(entries)).map((hit) => hit.rule)
  assert.deepEqual(rules(`a ${PRIVATE.toUpperCase()} b`, [PRIVATE]), ['deny-list'])
  assert.deepEqual(rules(`a ${PRIVATE}s b`, [PRIVATE]), [])
  assert.deepEqual(rules(`a_${PRIVATE} b`, [PRIVATE]), [])
  assert.deepEqual(rules(`(${PRIVATE}).`, [PRIVATE]), ['deny-list'])
  assert.deepEqual(rules('Big  Corp', ['big corp']), ['deny-list'])
  assert.deepEqual(rules('Big Corporation', ['big corp']), [])
  assert.deepEqual(rules('a+b', ['a+b']), ['deny-list'])
})

function plantedRepository() {
  const r = repository()
  r.write('README.md', '# Clean\n\nNothing private here.\n')
  return r
}

function denyList(r, text) {
  writeFileSync(join(r.root, '.git', 'info', 'hygiene-deny'), text)
}

test('a clean tree passes', () => {
  const r = plantedRepository()
  denyList(r, `# private words\n${PRIVATE}\n`)
  r.commit('docs: readme')
  assert.deepEqual(scanTree(r.root, { env: ENV }), [])
})

test('a planted home path is caught with its file, line and rule', () => {
  const r = plantedRepository()
  r.write('docs/setup.md', `Intro\n\nRun it from ${HOME}/project.\n`)
  r.git('add', '-A')
  assert.deepEqual(scanTree(r.root, { env: ENV }).map(formatFailure), [`docs/setup.md:3: home-path (${HOME})`])
})

test('a planted agent memory path is caught', () => {
  const r = plantedRepository()
  r.write('notes.txt', `see ~/${AGENT}/active.md\n`)
  r.git('add', '-A')
  assert.deepEqual(scanTree(r.root, { env: ENV }).map(formatFailure), [`notes.txt:1: agent-memory (${AGENT})`])
})

test('a planted email address is caught', () => {
  const r = plantedRepository()
  const address = `jane${AT}corp.fi`
  r.write('src/a.js', `// contact\n// ${address}\n`)
  r.git('add', '-A')
  assert.deepEqual(scanTree(r.root, { env: ENV }).map(formatFailure), [`src/a.js:2: email (${address})`])
})

test('a planted private word is caught when the deny-list exists, and only then', () => {
  const r = plantedRepository()
  r.write('a.md', `Built for ${PRIVATE[0].toUpperCase()}${PRIVATE.slice(1)} Ltd.\n`)
  r.write('b.md', `Built for ${PRIVATE}ian code.\n`)
  r.write('c.md', 'Made by Big\n  Corp.\n')
  r.git('add', '-A')
  assert.deepEqual(scanTree(r.root, { env: ENV }), [])
  denyList(r, `# comment line\n\n${PRIVATE}\nbig corp\n`)
  assert.deepEqual(scanTree(r.root, { env: ENV }).map(formatFailure), [`a.md:1: deny-list (${PRIVATE})`])
  r.write('c.md', 'Made by Big Corp.\n')
  assert.deepEqual(scanTree(r.root, { env: ENV }).map(formatFailure), [`a.md:1: deny-list (${PRIVATE})`, 'c.md:1: deny-list (big corp)'])
})

test('binary and untracked files are skipped', () => {
  const r = plantedRepository()
  writeFileSync(join(r.root, 'image.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(HOME)]))
  r.git('add', '-A')
  r.write('untracked.md', `${HOME}\n`)
  assert.deepEqual(scanTree(r.root, { env: ENV }), [])
})

test('the history scan finds a planted word in an old message and in old content', () => {
  const r = plantedRepository()
  denyList(r, `${PRIVATE}\n`)
  r.commit('docs: readme')
  r.git('commit', '-q', '--allow-empty', '-m', `chore: work for ${PRIVATE}`)
  r.write('notes.md', `first\nwritten for ${PRIVATE}\n`)
  r.commit('docs: notes')
  r.write('notes.md', 'first\n')
  r.commit('docs: tidy notes')
  r.commit('docs: later')
  assert.deepEqual(scanTree(r.root, { env: ENV }), [])

  const hits = scanHistory(r.root, { env: ENV })
  const commits = r.git('log', '--format=%H %s').out.trim().split('\n').map((line) => line.split(' '))
  const hash = (subject) => commits.find(([, ...words]) => words.join(' ') === subject)[0]
  assert.deepEqual(
    hits.map(formatHit).sort(),
    [
      `${hash(`chore: work for ${PRIVATE}`).slice(0, 12)} message:1: deny-list (${PRIVATE})`,
      `${hash('docs: notes').slice(0, 12)} notes.md:2: deny-list (${PRIVATE})`
    ].sort()
  )

  const cli = r.node(join(PACKAGE, 'scripts', 'scan-history.mjs'), r.root)
  assert.equal(cli.status, 1, cli.out)
  assert.match(cli.out, /2 hit\(s\)/)
})

test('the history scan checks author and committer, and exits 0 when clean', () => {
  const r = plantedRepository()
  r.commit('docs: readme')
  const clean = r.node(join(PACKAGE, 'scripts', 'scan-history.mjs'), r.root)
  assert.equal(clean.status, 0, clean.out)
  assert.match(clean.out, /clean/)

  r.write('more.md', 'more\n')
  r.git('add', '-A')
  const address = `jane${AT}corp.fi`
  const committed = spawnSync('git', ['commit', '-q', '-m', 'docs: more', '--author', `Jane <${address}>`], {
    cwd: r.root,
    env: { ...ENV, GIT_COMMITTER_EMAIL: address },
    encoding: 'utf8'
  })
  assert.equal(committed.status, 0, committed.stderr)
  const where = scanHistory(r.root, { env: ENV }).map((hit) => `${hit.where} ${hit.rule}`)
  assert.deepEqual(where.sort(), ['author email', 'committer email'])
  assert.equal(r.node(join(PACKAGE, 'scripts', 'scan-history.mjs'), r.root).status, 1)
})
