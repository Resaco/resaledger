// The open-source files of this repository (D3): each one exists and is reached from the
// README, its links resolve, the YAML files have the structure GitHub expects, the release
// workflow publishes only from a tag with read-only rights, and the places that wait for the
// owner's input are listed.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { describe, test } from 'node:test'
import { PACKAGE } from './helpers.mjs'

const read = (path) => readFileSync(join(PACKAGE, path), 'utf8')

// The README links these directly.
const LINKED = ['CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', 'CHANGELOG.md', 'docs/releasing.md']
// These are reached through the files above.
const REACHED = [
  '.github/ISSUE_TEMPLATE/bug-report.yml',
  '.github/ISSUE_TEMPLATE/feature-request.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/pull_request_template.md',
  '.github/workflows/release.yml'
]
const ISSUE_FORMS = ['.github/ISSUE_TEMPLATE/bug-report.yml', '.github/ISSUE_TEMPLATE/feature-request.yml']
const YAML_FILES = [...ISSUE_FORMS, '.github/ISSUE_TEMPLATE/config.yml', '.github/workflows/release.yml']

/** The relative link targets of a Markdown file, without anchors, as repository paths. */
function localLinks(path) {
  const targets = []
  for (const [, target] of read(path).matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue
    const file = target.split('#')[0]
    targets.push(normalize(join(dirname(path), file)).split('\\').join('/').replace(/\/$/, ''))
  }
  return targets
}

/** Every file reached from README.md through relative links, at most `depth` links away. */
function reachable(depth) {
  const seen = new Set(['README.md'])
  let frontier = ['README.md']
  for (let step = 0; step < depth; step += 1) {
    const next = []
    for (const path of frontier) {
      if (!path.endsWith('.md') || !existsSync(join(PACKAGE, path))) continue
      for (const target of localLinks(path)) {
        if (!seen.has(target)) {
          seen.add(target)
          next.push(target)
        }
      }
    }
    frontier = next
  }
  return seen
}

describe('the repository files', () => {
  test('every file exists', () => {
    for (const path of [...LINKED, ...REACHED, 'ledger/evidence/d3/good-first-issues.md']) assert.ok(existsSync(join(PACKAGE, path)), `${path} is missing`)
  })

  test('the README links each document, and the release notes', () => {
    const links = localLinks('README.md')
    for (const path of LINKED) assert.ok(links.includes(path), `README.md does not link ${path}`)
    assert.match(read('README.md'), /\[release notes\]\(https:\/\/github\.com\/Resaco\/resaledger\/releases\)/)
  })

  test('the templates and the release workflow are reached from the README', () => {
    const reached = reachable(2)
    for (const path of REACHED) assert.ok(reached.has(path), `${path} is not reached from README.md`)
  })

  test('every relative link in these files resolves', () => {
    for (const path of [...LINKED, '.github/pull_request_template.md', 'ledger/evidence/d3/good-first-issues.md']) {
      for (const target of localLinks(path)) assert.ok(existsSync(join(PACKAGE, target)), `${path} links ${target}, which is missing`)
    }
  })

  test('the changelog keeps an Unreleased section, and the package publishes it', () => {
    assert.match(read('CHANGELOG.md'), /^## \[Unreleased\]$/m)
    assert.ok(JSON.parse(read('package.json')).files.includes('CHANGELOG.md'))
  })

  test('the code of conduct adopts the Contributor Covenant 2.1 by reference', () => {
    const text = read('CODE_OF_CONDUCT.md')
    assert.match(text, /https:\/\/www\.contributor-covenant\.org\/version\/2\/1\/code_of_conduct\//)
    assert.match(text, /^## Scope$/m)
  })

  test('the security policy asks for private reports and names the trust model', () => {
    const text = read('SECURITY.md')
    assert.match(text, /private vulnerability reporting/)
    assert.match(text, /latest 1\.x/)
    assert.ok(localLinks('SECURITY.md').includes('ledger/plan/spec.md'))
  })

  test('the pull request template ends with a Task: line', () => {
    assert.match(read('.github/pull_request_template.md'), /\nTask: *\n?$/)
  })
})

// A small reader for the subset of YAML these files use: block mappings, block sequences of
// mappings or scalars, flow sequences of scalars, literal block scalars and plain or quoted
// scalars. Enough to check their structure without a YAML dependency.

function indentOf(line) {
  return line.length - line.trimStart().length
}

function yamlScalar(text) {
  const value = text.trim()
  if (value === '') return null
  if (/^\[.*\]$/.test(value)) {
    const inner = value.slice(1, -1).trim()
    return inner === '' ? [] : inner.split(',').map(yamlScalar)
  }
  if (/^'.*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'")
  if (/^".*"$/.test(value)) return JSON.parse(value)
  if (/^-?\d+$/.test(value)) return Number(value)
  if (value === 'true' || value === 'false') return value === 'true'
  return value
}

/** Parses the block at lines[index] with `indent` spaces; returns [value, next index]. */
function yamlBlock(lines, index, indent) {
  if (lines[index].trimStart().startsWith('- ')) {
    const list = []
    while (index < lines.length && indentOf(lines[index]) === indent && lines[index].trimStart().startsWith('- ')) {
      const rest = lines[index].trimStart().slice(2)
      if (!/^[\w.-]+:(\s|$)/.test(rest)) {
        list.push(yamlScalar(rest))
        index += 1
        continue
      }
      // "- key: value" opens a mapping whose keys sit two spaces further in.
      const inner = `${' '.repeat(indent + 2)}${rest}`
      const [item, next] = yamlBlock([...lines.slice(0, index), inner, ...lines.slice(index + 1)], index, indent + 2)
      list.push(item)
      index = next
    }
    return [list, index]
  }
  const map = {}
  while (index < lines.length && indentOf(lines[index]) === indent) {
    const match = lines[index].trim().match(/^([\w.-]+):(?:\s+(.*))?$/)
    if (!match) throw new Error(`cannot read line ${index + 1}: ${lines[index]}`)
    const [, key, rest = ''] = match
    index += 1
    if (rest === '|') {
      const body = []
      const inner = index < lines.length ? indentOf(lines[index]) : indent + 2
      while (index < lines.length && (lines[index].trim() === '' || indentOf(lines[index]) >= inner)) {
        body.push(lines[index].slice(inner))
        index += 1
      }
      while (body.length > 0 && body.at(-1).trim() === '') body.pop()
      map[key] = `${body.join('\n')}\n`
    } else if (rest !== '') map[key] = yamlScalar(rest)
    else if (index < lines.length && indentOf(lines[index]) > indent) [map[key], index] = yamlBlock(lines, index, indentOf(lines[index]))
    else if (index < lines.length && indentOf(lines[index]) === indent && lines[index].trimStart().startsWith('- '))
      [map[key], index] = yamlBlock(lines, index, indent)
    else map[key] = null
  }
  return [map, index]
}

/** Parses a file; comments and empty lines outside literal blocks are dropped. */
function parseYaml(text) {
  const lines = []
  let scalar = null
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (scalar !== null && (line.trim() === '' || indentOf(line) > scalar)) {
      lines.push(line)
      continue
    }
    scalar = null
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (/:\s+\|$/.test(line)) scalar = indentOf(line)
    lines.push(line)
  }
  while (lines.length > 0 && lines.at(-1).trim() === '') lines.pop()
  return yamlBlock(lines, 0, 0)[0]
}

describe('the YAML files', () => {
  test('the issue forms have a name, a description and a body GitHub accepts', () => {
    const types = new Set(['markdown', 'input', 'textarea', 'dropdown', 'checkboxes'])
    for (const path of ISSUE_FORMS) {
      const form = parseYaml(read(path))
      assert.equal(typeof form.name, 'string', path)
      assert.equal(typeof form.description, 'string', path)
      assert.ok(Array.isArray(form.labels), `${path}: labels`)
      assert.ok(Array.isArray(form.body) && form.body.length > 1, `${path}: body`)
      const ids = new Set()
      for (const item of form.body) {
        assert.ok(types.has(item.type), `${path}: type ${item.type}`)
        if (item.type === 'markdown') {
          assert.equal(typeof item.attributes.value, 'string', path)
          continue
        }
        assert.match(item.id, /^[\w-]+$/, path)
        assert.ok(!ids.has(item.id), `${path}: id ${item.id} twice`)
        ids.add(item.id)
        assert.equal(typeof item.attributes.label, 'string', `${path}: ${item.id}`)
        if (item.type === 'dropdown') {
          assert.ok(item.attributes.options.length > 1, `${path}: ${item.id}`)
          // An unquoted No or Yes would be read as a boolean.
          for (const option of item.attributes.options) assert.equal(typeof option, 'string', `${path}: ${item.id}`)
        }
      }
    }
  })

  test('the issue chooser turns off blank issues and sends security reports to private reporting', () => {
    const config = parseYaml(read('.github/ISSUE_TEMPLATE/config.yml'))
    assert.equal(config.blank_issues_enabled, false)
    const urls = config.contact_links.map((link) => link.url)
    assert.ok(urls.includes('https://github.com/Resaco/resaledger/security/advisories/new'))
    assert.ok(config.contact_links.some((link) => /SECURITY\.md/.test(link.about) || /SECURITY\.md$/.test(link.url)))
    for (const link of config.contact_links) for (const key of ['name', 'url', 'about']) assert.equal(typeof link[key], 'string')
  })

  test('Ruby\'s YAML parser reads the same structures, when ruby exists', (t) => {
    const probe = spawnSync('ruby', ['--version'], { encoding: 'utf8' })
    if (probe.error) return t.skip('ruby is not installed')
    for (const path of YAML_FILES) {
      const text = read(path)
      const ruby = spawnSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.safe_load(STDIN.read))'], { input: text, encoding: 'utf8' })
      assert.equal(ruby.status, 0, `${path}: ${ruby.stderr}`)
      const parsed = JSON.parse(ruby.stdout)
      // YAML 1.1 reads the key "on" as true.
      if ('true' in parsed) {
        parsed.on = parsed.true
        delete parsed.true
      }
      assert.deepEqual(parsed, JSON.parse(JSON.stringify(parseYaml(text))), path)
    }
  })
})

describe('the release workflow', () => {
  const text = read('.github/workflows/release.yml')
  const workflow = parseYaml(text)
  const job = workflow.jobs.publish
  const runs = job.steps.filter((step) => typeof step.run === 'string').map((step) => step.run)
  const position = (pattern) => runs.findIndex((run) => pattern.test(run))

  test('runs only on a pushed v* tag, never on pull_request_target', () => {
    assert.deepEqual(workflow.on, { push: { tags: ['v*'] } })
    assert.doesNotMatch(text, /pull_request_target/)
  })

  test('may only read the repository and request an OIDC token', () => {
    assert.deepEqual(workflow.permissions, { contents: 'read', 'id-token': 'write' })
    assert.equal(job.permissions, undefined)
  })

  test('uses the same action versions as the test workflow', () => {
    const uses = job.steps.filter((step) => step.uses).map((step) => step.uses)
    assert.deepEqual(uses, ['actions/checkout@v5', 'actions/setup-node@v5'])
    const checkout = job.steps.find((step) => step.uses === 'actions/checkout@v5')
    assert.equal(checkout.with['persist-credentials'], false)
  })

  test('tests, builds and checks the release hashes before it publishes with provenance', () => {
    const publish = position(/npm publish --provenance/)
    assert.ok(publish >= 0, 'no npm publish --provenance')
    for (const pattern of [/package\.json/, /^npm test$/m, /^node scripts\/bundle\.mjs$/m, /^node scripts\/release-hashes\.mjs --check$/m]) {
      const index = position(pattern)
      assert.ok(index >= 0 && index < publish, `${pattern} must run before the publish`)
    }
    assert.match(read('scripts/release-hashes.mjs'), /--check/)
  })

  test('passes values from the event to its scripts only through the environment', () => {
    for (const run of runs) assert.doesNotMatch(run, /\$\{\{/)
  })
})

// Places where the owner still has to fill something in, written as an HTML comment that
// starts with "owner:". Built from fragments so that this file does not list itself.
const MARKER = new RegExp(['<', '!-- owner: ([^>]*?) --', '>'].join(''), 'g')

test('the owner markers are listed, and none is left open', (t) => {
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: PACKAGE, encoding: 'utf8' })
  assert.equal(listed.status, 0, listed.stderr)
  const markers = []
  for (const path of listed.stdout.split('\0').filter(Boolean)) {
    if (!existsSync(join(PACKAGE, path)) || /\.(png|jpe?g|gif|webp|ico|woff2?)$/i.test(path)) continue
    const lines = readFileSync(join(PACKAGE, path), 'utf8').split('\n')
    lines.forEach((line, index) => {
      for (const [, what] of line.matchAll(MARKER)) markers.push(`${relative(PACKAGE, join(PACKAGE, path)).split('\\').join('/')}:${index + 1}: ${what}`)
    })
  }
  for (const marker of markers) t.diagnostic(`open for the owner: ${marker}`)
  // A release candidate leaves nothing open for the owner.
  assert.deepEqual(markers, [])
})
