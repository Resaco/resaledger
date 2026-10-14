// The test helpers themselves: a repository, a commit, a worktree and a round trip
// through a bare remote.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { repository } from './helpers.mjs'

test('the helpers build a repository, a worktree and a remote that work together', () => {
  const r = repository()
  r.write('notes.md', '# Notes\n')
  const first = r.commit('chore: start the notes')
  assert.equal(first.status, 0, first.out)
  assert.equal(r.git('log', '--format=%an <%ae>', '-1').out.trim(), 'Test <test@example.com>')

  r.remote()
  const pushed = r.push('main')
  assert.equal(pushed.status, 0, pushed.out)

  const lane = r.worktree('lane', 'feature/lane')
  assert.equal(lane.git('branch', '--show-current').out.trim(), 'feature/lane')
  lane.append('notes.md', 'From the lane.\n')
  const second = lane.commit('docs: add a line from the lane')
  assert.equal(second.status, 0, second.out)
  const pushedLane = lane.push('feature/lane')
  assert.equal(pushedLane.status, 0, pushedLane.out)

  const fetched = r.fetch()
  assert.equal(fetched.status, 0, fetched.out)
  assert.equal(r.git('show', 'origin/feature/lane:notes.md').out, '# Notes\nFrom the lane.\n')
  assert.equal(r.read('notes.md'), '# Notes\n')
})
