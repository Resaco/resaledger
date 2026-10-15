// docs/format.md, the format reference: its examples are checked by the guard's own parsers.
//
// The convention: a fenced block whose info string is "<language> <kind> [<path>]" is an
// example. Record kinds carry the repository path of the file they show:
//   markdown task|decision|log|plan|readme <path>   a record; all of them form one workspace
//   text evidence <path>                            a file the evidence links to
//   json stamp <path>                               a stamp for the first config example
//   json config                                     a complete .resaledger.json
//   json effective                                  what `records.mjs config` prints for { "version": 2 }
//   text commit                                     a commit message that changes code
//   text code                                       lines of "yes|no <path>", with "codePaths": ["fixtures"]
// Blocks with any other info string are illustrations and are not checked.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULTS, PRESETS, effectiveConfigJson, parseConfig } from '../src/guard/config.mjs'
import { verifiedStamp } from '../src/guard/gates.mjs'
import { GITHOOKS_CONVENTIONAL } from '../src/guard/githooks.mjs'
import { headings, relativeLinks, resolveLinkPath } from '../src/guard/markdown.mjs'
import { checkCommit } from '../src/guard/range.mjs'
import { checkWorkspace, isCode, loadWorkspace } from '../src/guard/workspace.mjs'
import { PACKAGE } from './helpers.mjs'

const DOC = 'docs/format.md'
const TEXT = readFileSync(join(PACKAGE, DOC), 'utf8')
const RECORD_FOLDERS = { task: 'tasks', decision: 'decisions', log: 'log', plan: 'plan', readme: '', evidence: 'evidence', stamp: 'verified' }
const KINDS = new Set([...Object.keys(RECORD_FOLDERS), 'config', 'effective', 'commit', 'code'])

/** The example blocks of the document: [{ kind, path, text, line }]. */
function examples(text) {
  const blocks = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const open = lines[index].match(/^(`{3,})(\S+)[ \t]+(\S+)(?:[ \t]+(\S+))?[ \t]*$/)
    if (!open || !KINDS.has(open[3])) continue
    let end = index + 1
    while (end < lines.length && lines[end] !== open[1]) end += 1
    assert.ok(end < lines.length, `the example on line ${index + 1} is not closed`)
    blocks.push({ kind: open[3], path: open[4] ?? null, text: `${lines.slice(index + 1, end).join('\n')}\n`, line: index + 1 })
    index = end
  }
  return blocks
}

const BLOCKS = examples(TEXT)
const of = (kind) => BLOCKS.filter((block) => block.kind === kind)
const DEFAULT_CONFIG = parseConfig('{ "version": 2 }').config

/** A reader over the example files, with the methods treeReader gives. */
function exampleReader(files) {
  const paths = [...files.keys()].sort()
  return {
    list: (prefix = '') => paths.filter((path) => prefix === '' || path.startsWith(`${prefix}/`)),
    read: (path) => files.get(path) ?? null,
    exists: (path) => files.has(path) || paths.some((file) => file.startsWith(`${path}/`))
  }
}

/** The example workspace: every record, evidence and stamp block, by path. */
function exampleFiles() {
  const files = new Map()
  for (const block of BLOCKS) {
    if (!(block.kind in RECORD_FOLDERS)) continue
    assert.ok(block.path, `the ${block.kind} example on line ${block.line} names no path`)
    assert.ok(!files.has(block.path), `two examples are ${block.path}`)
    files.set(block.path, block.text)
  }
  return files
}

test('the document has an example of every kind', () => {
  for (const kind of KINDS) assert.ok(of(kind).length > 0, `no ${kind} example`)
})

test('every record example sits in its folder and the workspace they form has no problem', () => {
  const files = exampleFiles()
  for (const block of BLOCKS) {
    if (!(block.kind in RECORD_FOLDERS)) continue
    const folder = RECORD_FOLDERS[block.kind]
    const expected = folder === '' ? `${DEFAULT_CONFIG.dir}/README.md` : `${DEFAULT_CONFIG.dir}/${folder}/`
    assert.ok(folder === '' ? block.path === expected : block.path.startsWith(expected), `the ${block.kind} example on line ${block.line} is not in ${expected}`)
  }
  const reader = exampleReader(files)
  const workspace = loadWorkspace(reader, DEFAULT_CONFIG)
  assert.equal(workspace.tasks.length, of('task').length)
  assert.equal(workspace.decisions.length, of('decision').length)
  assert.equal(workspace.logs.length, of('log').length)
  assert.equal(workspace.plans.size, of('plan').length)
  assert.ok(workspace.readme)
  assert.deepEqual(checkWorkspace(workspace, reader, DEFAULT_CONFIG), [])
})

test('every configuration example is valid, and the stamp example passes for the first one', () => {
  for (const block of of('config')) assert.deepEqual(parseConfig(block.text).problems, [], `config on line ${block.line}`)
  const config = parseConfig(of('config')[0].text).config
  for (const block of of('stamp')) {
    const stamp = JSON.parse(block.text)
    assert.ok(verifiedStamp(exampleReader(exampleFiles()), config, stamp.fingerprint), `stamp on line ${block.line}`)
    assert.equal(block.text, `${JSON.stringify(stamp, null, 2)}\n`, 'a stamp is written with two-space indentation')
  }
})

test('the effective configuration is what records.mjs config prints for { "version": 2 }', () => {
  for (const block of of('effective')) assert.equal(block.text, `${effectiveConfigJson(DEFAULT_CONFIG)}\n`)
})

test('every commit example passes the commit rules against the example tasks', () => {
  const workspace = loadWorkspace(exampleReader(exampleFiles()), DEFAULT_CONFIG)
  for (const block of of('commit')) {
    const message = block.text.trimEnd()
    const subject = message.split('\n')[0]
    assert.match(subject, GITHOOKS_CONVENTIONAL, `commit on line ${block.line}`)
    const commit = { short: 'example', parents: [], committer: '', subject, message, paths: ['src/server/storage.js'], exemption: null }
    const problems = checkCommit(commit, {
      config: DEFAULT_CONFIG,
      lane: null,
      skipGitHubMerges: false,
      task: (id) => workspace.tasks.find((task) => task.id === id) ?? null,
      startLane: () => null
    })
    assert.deepEqual(problems, [], `commit on line ${block.line}`)
  }
})

test('the code examples say what isCode says', () => {
  const config = parseConfig('{ "version": 2, "codePaths": ["fixtures"] }').config
  for (const block of of('code')) {
    for (const line of block.text.trim().split('\n')) {
      const [answer, path] = line.trim().split(/\s+/)
      assert.ok(answer === 'yes' || answer === 'no', `"${line}" on line ${block.line}`)
      assert.equal(isCode(path, config), answer === 'yes', path)
    }
  }
})

test('every relative link and every anchor in the document resolves', () => {
  const anchors = new Set(headings(TEXT).map((heading) => heading.anchor))
  for (const [, anchor] of TEXT.matchAll(/\]\(#([^)\s]+)\)/g)) assert.ok(anchors.has(anchor), `#${anchor}`)
  for (const link of relativeLinks(TEXT)) {
    const path = resolveLinkPath(DOC, link.path)
    assert.ok(path !== null && existsSync(join(PACKAGE, path)), `line ${link.line}: ${link.target}`)
    if (link.anchor && path.endsWith('.md')) {
      const target = headings(readFileSync(join(PACKAGE, path), 'utf8')).map((heading) => heading.anchor)
      assert.ok(target.includes(link.anchor.toLowerCase()), `line ${link.line}: ${link.target}`)
    }
  }
})

test('every configuration key is documented', () => {
  const keys = ['version', ...Object.keys(PRESETS.solo)]
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) keys.push(...Object.keys(value).map((name) => `${key}.${name}`))
    else keys.push(key)
  }
  for (const key of keys) assert.ok(TEXT.includes(`| \`${key}\``), `the key ${key} has no row in the configuration table`)
})
