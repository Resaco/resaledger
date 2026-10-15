// The skill and the plugin marketplace. The skill follows the Agent Skills format: front
// matter with a name that matches its folder (at most 64 lowercase letters, digits and
// hyphens) and a description of at most 1,024 characters. The marketplace follows Claude Code's
// format, which Codex and the Copilot CLI also read: .claude-plugin/marketplace.json with a
// name, an owner and plugins, each plugin a folder with .claude-plugin/plugin.json.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { checkText } from '../scripts/hygiene.mjs'
import { PACKAGE } from './helpers.mjs'

const MARKETPLACE = '.claude-plugin/marketplace.json'
const SKILL = 'plugins/resaledger/skills/resaledger/SKILL.md'
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const { version } = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'))

/** A repository file's text. */
function read(path) {
  return readFileSync(join(PACKAGE, path), 'utf8')
}

/** The front matter of a SKILL.md as { fields, body }; fields null when there is none. */
export function frontMatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  if (!match) return { fields: null, body: text }
  const fields = {}
  for (const line of match[1].split('\n')) {
    const field = /^([a-z][a-z-]*):\s*(.*)$/.exec(line)
    assert.ok(field, `a front matter line of the form "key: value": ${line}`)
    fields[field[1]] = field[2].trim()
  }
  return { fields, body: match[2] }
}

/** The problems with a skill file at path, against the Agent Skills format. */
export function skillProblems(path, text) {
  const problems = []
  const { fields, body } = frontMatter(text)
  if (fields === null) return ['no front matter']
  const folder = basename(dirname(path))
  if (!fields.name) problems.push('no name')
  else {
    if (fields.name !== folder) problems.push(`name "${fields.name}" is not its folder "${folder}"`)
    if (fields.name.length > 64 || !NAME.test(fields.name)) problems.push('name is not 1 to 64 lowercase letters, digits and single hyphens')
  }
  if (!fields.description) problems.push('no description')
  else if (fields.description.length > 1024) problems.push(`description is ${fields.description.length} characters, over 1,024`)
  if (body.trim() === '') problems.push('no instructions')
  for (const hit of checkText(text)) problems.push(`hygiene: ${hit.rule}`)
  return problems
}

describe('the skill', () => {
  const text = read(SKILL)

  test('passes the format check', () => {
    assert.deepEqual(skillProblems(SKILL, text), [])
    assert.ok(text.split('\n').length <= 200, 'under about 200 lines')
  })

  test('the format check catches each problem', () => {
    const at = 'skills/shop/SKILL.md'
    assert.deepEqual(skillProblems(at, '# Shop\n'), ['no front matter'])
    assert.deepEqual(skillProblems(at, '---\nname: bakery\ndescription: Bake.\n---\nBake.\n'), ['name "bakery" is not its folder "shop"'])
    assert.deepEqual(skillProblems('skills/Shop/SKILL.md', '---\nname: Shop\ndescription: Bake.\n---\nBake.\n'), ['name is not 1 to 64 lowercase letters, digits and single hyphens'])
    assert.deepEqual(skillProblems(at, `---\nname: shop\ndescription: ${'x'.repeat(1025)}\n---\nBake.\n`), ['description is 1025 characters, over 1,024'])
    assert.deepEqual(skillProblems(at, '---\nname: shop\n---\nBake.\n'), ['no description'])
    const home = ['', 'Users', 'alice', 'shop'].join('/')
    assert.deepEqual(skillProblems(at, `---\nname: shop\ndescription: Bake.\n---\nRun it in ${home}.\n`), ['hygiene: home-path'])
  })

  test('covers the setup and the records it promises', () => {
    for (const phrase of ['npx resaledger init', '## Goal', 'gates', 'Evidence', 'Handoff', 'new decision', '.agents/skills/']) {
      assert.ok(text.includes(phrase.replace('## ', '')), phrase)
    }
  })
})

describe('the plugin marketplace', () => {
  const marketplace = JSON.parse(read(MARKETPLACE))

  test('has the documented required keys', () => {
    assert.match(marketplace.name, NAME)
    assert.equal(typeof marketplace.owner?.name, 'string')
    assert.ok(Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0)
    assert.equal(marketplace.metadata.version, version)
  })

  for (const plugin of marketplace.plugins ?? []) {
    test(`the plugin "${plugin.name}" exists where the marketplace says, with a manifest of the same name and version`, () => {
      assert.match(plugin.name, NAME)
      assert.equal(typeof plugin.description, 'string')
      assert.match(plugin.source, /^\.\/[^.]/, 'a relative source starts with ./ and stays inside the repository')
      const root = join(PACKAGE, plugin.source)
      assert.ok(statSync(root).isDirectory(), plugin.source)
      const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'))
      assert.equal(manifest.name, plugin.name)
      assert.equal(manifest.version, version)
      assert.equal(typeof manifest.description, 'string')
      // Skills are found in the plugin's skills/ folder, one folder per skill.
      assert.ok(existsSync(join(root, 'skills', plugin.name, 'SKILL.md')))
      assert.equal(join(plugin.source, 'skills', plugin.name, 'SKILL.md').split('\\').join('/'), SKILL)
    })
  }

  test('the JSON files are free of local paths and private addresses', () => {
    for (const path of [MARKETPLACE, 'plugins/resaledger/.claude-plugin/plugin.json']) assert.deepEqual(checkText(read(path)), [], path)
  })
})
