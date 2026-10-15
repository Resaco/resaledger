// Lanes read from inside a git hook: git sets GIT_INDEX_FILE (and for some hooks GIT_DIR), and
// localLanes must still read each other worktree's own files, not this worktree's index.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { ENV, PACKAGE, repository } from './helpers.mjs'

const LANES = pathToFileURL(join(PACKAGE, 'src', 'guard', 'lanes.mjs')).href

/** The other worktrees' lanes as [branch, ids], from a node process in root with extra variables. */
function lanesFrom(root, extra = {}) {
  const script = `import { localLanes } from ${JSON.stringify(LANES)}
const lanes = localLanes({ dir: 'ledger' })
process.stdout.write(JSON.stringify(lanes.map((lane) => [lane.branch, lane.tasks.map((task) => task.id)])))
`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env: { ...ENV, ...extra }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('localLanes reads another worktree\'s own tasks with git\'s hook variables set', () => {
  const r = repository()
  r.write('ledger/tasks/S9.md', '# S9 Nine\n\n- Status: todo\n')
  assert.equal(r.commit('chore: start').status, 0)
  const other = r.worktree('other')
  other.write('ledger/tasks/S1.md', '# S1 One\n\n- Status: doing\n- Lane: other\n')
  other.git('add', '-A')

  assert.deepEqual(lanesFrom(r.root), [['other', ['S1', 'S9']]])
  for (const index of ['.git/index', join(r.root, '.git', 'index')]) {
    assert.deepEqual(lanesFrom(r.root, { GIT_INDEX_FILE: index }), [['other', ['S1', 'S9']]], index)
  }
  assert.deepEqual(lanesFrom(r.root, { GIT_DIR: '.git', GIT_INDEX_FILE: '.git/index' }), [['other', ['S1', 'S9']]])
})
