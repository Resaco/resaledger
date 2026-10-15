// The shared start of a range check: never before the commit that added .resaledger.json.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adoptionCommit, adoptionStart } from '../src/guard/adoption.mjs'
import { repository } from './helpers.mjs'

/** Three commits before adoption, the adoption commit, then two more; returns the ids, oldest first. */
function history() {
  const r = repository()
  const ids = []
  const step = (path, text) => {
    r.write(path, text)
    assert.equal(r.commit(`change ${path}`).status, 0)
    ids.push(r.git('rev-parse', 'HEAD').out.trim())
  }
  for (let index = 1; index <= 3; index += 1) step('app.js', `${index}\n`)
  step('.resaledger.json', '{ "version": 2 }\n')
  step('app.js', '4\n')
  step('app.js', '5\n')
  return { r, ids }
}

test('adoptionCommit is the commit that added .resaledger.json, or null before it', () => {
  const { r, ids } = history()
  assert.equal(adoptionCommit(r.root, 'HEAD'), ids[3])
  assert.equal(adoptionCommit(r.root, ids[2]), null)
})

test('adoptionStart moves a start that is null or older than adoption to the adoption commit', () => {
  const { r, ids } = history()
  assert.equal(adoptionStart(r.root, null, 'HEAD'), ids[3])
  assert.equal(adoptionStart(r.root, ids[0], 'HEAD'), ids[3])
  assert.equal(adoptionStart(r.root, ids[3], 'HEAD'), ids[3])
  assert.equal(adoptionStart(r.root, ids[4], 'HEAD'), ids[4])
  // Before adoption there is nothing to bound.
  assert.equal(adoptionStart(r.root, null, ids[2]), null)
  assert.equal(adoptionStart(r.root, ids[0], ids[2]), ids[0])
})

test('a later commit that deletes the configuration and adds it again moves no start', () => {
  const { r, ids } = history()
  const step = (message) => {
    assert.equal(r.commit(message).status, 0)
    return r.git('rev-parse', 'HEAD').out.trim()
  }
  r.git('rm', '-q', '.resaledger.json')
  step('chore: drop the configuration')
  r.write('app.js', 'sneak\n')
  step('feat: sneak')
  r.write('.resaledger.json', '{ "version": 2 }\n')
  const readded = step('chore: add it back')
  // A start that has the configuration stays where it is, so the sneak is in the range.
  assert.equal(adoptionStart(r.root, ids[5], 'HEAD'), ids[5])
  // From before adoption, or with no start, the range begins at the first adoption.
  assert.equal(adoptionStart(r.root, ids[0], 'HEAD'), ids[3])
  assert.equal(adoptionStart(r.root, null, 'HEAD'), ids[3])
  assert.equal(adoptionCommit(r.root, 'HEAD'), ids[3])
  assert.notEqual(adoptionCommit(r.root, 'HEAD'), readded)
})
