// pre-commit: real repositories with the bundled guard and the rendered hooks, committed
// through git, so that the staged content, partial commits and merges are git's own.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { HOOK_NAMES, renderHook } from '../src/cli/hooks.mjs'
import { PACKAGE, repository, run, temporary } from './helpers.mjs'

const GUARD = join(temporary(), 'records.mjs')
const built = run(PACKAGE, process.execPath, [join(PACKAGE, 'scripts', 'bundle.mjs'), '--out', GUARD])
if (built.status !== 0) throw new Error(`bundle failed: ${built.out}`)

const README = `# Bakery shop

## Goal

Build a small web shop for local bakers.

## Environments

Local only.

## Manual checks

None.
`

const REFUSED = /✖ This commit is refused/

/** A task file, valid for its status. */
function taskFile(id, title, fields = {}) {
  const { status = 'todo', lane, depends, takenOver, note } = fields
  const lines = [`# ${id} ${title}`, '', `- Status: ${status}`]
  if (lane) lines.push(`- Lane: ${lane}`)
  if (depends) lines.push(`- Depends on: ${depends}`)
  if (takenOver) lines.push(`- Taken over from: ${takenOver}`)
  if (status === 'done') lines.push('- Evidence: `npm test`: 3 of 3')
  if (status === 'dropped') lines.push('- Reason: not needed')
  if (status === 'blocked') lines.push('- Waiting for: owner')
  if (status === 'doing') lines.push('', '## Plan', '', 'Do the thing and test it.')
  if (note) lines.push('', '## Notes', '', note)
  return `${lines.join('\n')}\n`
}

/** Writes the hooks, the bundled guard, a configuration and a README into a repository. */
function install(r, config = {}) {
  for (const name of HOOK_NAMES) {
    r.write(`.githooks/${name}`, renderHook(name, 'ledger'))
    chmodSync(join(r.root, '.githooks', name), 0o755)
  }
  r.write('ledger/scripts/records.mjs', readFileSync(GUARD, 'utf8'))
  r.write('.resaledger.json', `${JSON.stringify({ version: 2, ...config }, null, 2)}\n`)
  r.write('ledger/README.md', README)
}

/** A repository with tasks committed on main with the hooks off, then the hooks turned on. */
function workspace({ config = {}, tasks = [] } = {}) {
  const r = repository()
  install(r, config)
  for (const [id, title, fields] of tasks) r.write(`ledger/tasks/${id}.md`, taskFile(id, title, fields))
  const committed = r.commit('chore: start')
  if (committed.status !== 0) throw new Error(`commit failed: ${committed.out}`)
  r.git('config', 'core.hooksPath', '.githooks')
  return r
}

function task(r, id, title, fields) {
  r.write(`ledger/tasks/${id}.md`, taskFile(id, title, fields))
}

function refused(result, pattern) {
  assert.notEqual(result.status, 0, result.out)
  assert.match(result.out, REFUSED)
  assert.match(result.out, pattern)
}

function passed(result) {
  assert.equal(result.status, 0, result.out)
  assert.doesNotMatch(result.out, /✖/)
}

test('an invalid configuration in the index is refused', () => {
  const r = workspace()
  r.write('.resaledger.json', '{ "version": 3 }\n')
  refused(r.commit('chore: config'), /\.resaledger\.json:\d+: version 3 is not supported/)
})

test('a commit on a protected branch is refused', () => {
  const r = workspace({ config: { preset: 'team' } })
  r.write('notes.md', 'Notes.\n')
  refused(r.commit('docs: notes'), /"main" is a protected branch.*claim <id>.*pull request/)
})

test('a merge commit on a protected branch is refused', () => {
  const r = workspace({ config: { preset: 'team' } })
  r.git('checkout', '-q', '-b', 'lane')
  r.write('notes.md', 'Notes.\n')
  passed(r.commit('docs: notes'))
  r.git('checkout', '-q', 'main')
  const merging = r.git('merge', '--no-ff', '--no-commit', 'lane')
  assert.equal(merging.status, 0, merging.out)
  refused(r.git('commit', '-q', '--no-edit'), /"main" is a protected branch/)
})

test('a branch name that fails branchPattern is refused; the base branch passes', () => {
  const r = workspace({ config: { branchPattern: '^(feat|fix)/' } })
  r.write('notes.md', 'Notes.\n')
  passed(r.commit('docs: notes on main'))
  r.git('checkout', '-q', '-b', 'wip')
  r.write('notes.md', 'More notes.\n')
  refused(r.commit('docs: notes'), /the branch name "wip" does not match branchPattern "\^\(feat\|fix\)\/"/)
  r.git('checkout', '-q', '-b', 'feat/notes')
  passed(r.commit('docs: notes'))
})

test('an invalid record is refused', () => {
  const r = workspace()
  r.write('ledger/tasks/S1.md', '# S1 Bake bread\n\n- Status: baking\n')
  refused(r.commit('docs: S1'), /ledger\/tasks\/S1\.md:3: .*baking/)
})

test('a partial commit that leaves the index invalid is refused, though the working tree is valid', () => {
  const r = workspace({ tasks: [['S1', 'Bake bread']] })
  // S2 is staged in the main index, so only git's temporary index for the partial commit
  // (GIT_INDEX_FILE) lacks it: committing S1 alone names a task the commit does not have.
  task(r, 'S1', 'Bake bread', { depends: 'S2' })
  task(r, 'S2', 'Buy flour')
  r.git('add', 'ledger/tasks/S2.md')
  passed(r.node('ledger/scripts/records.mjs', 'check'))
  passed(r.node('ledger/scripts/records.mjs', 'check', '--index'))
  refused(r.git('commit', '-q', '-m', 'docs: S1', '--', 'ledger/tasks/S1.md'), /ledger\/tasks\/S1\.md:\d+: .*S2/)
})

test('a partial commit that is valid passes, though the working tree is not', () => {
  const r = workspace({ tasks: [['S1', 'Bake bread']] })
  task(r, 'S1', 'Bake bread', { note: 'Use rye.' })
  r.write('ledger/tasks/S2.md', '# S2 Broken\n\n- Status: baking\n')
  r.git('add', 'ledger/tasks/S2.md')
  assert.notEqual(r.node('ledger/scripts/records.mjs', 'check').status, 0)
  passed(r.git('commit', '-q', '-m', 'docs: S1', '--', 'ledger/tasks/S1.md'))
  // The partial commit was judged without the invalid S2 staged in the main index; a full commit is not.
  refused(r.git('commit', '-q', '-m', 'docs: S2'), /ledger\/tasks\/S2\.md/)
})

test('deleting a task that exists on the base is refused, on a lane and on the base', () => {
  const r = workspace({ tasks: [['S1', 'Bake bread'], ['S2', 'Buy flour']] })
  r.git('checkout', '-q', '-b', 'lane')
  r.git('rm', '-q', 'ledger/tasks/S1.md')
  refused(r.commit('docs: drop S1'), /ledger\/tasks\/S1\.md: task S1 is deleted .*exists on main.*Status: dropped.*Reason/)
  // Renaming the id is a deletion of the old one.
  r.git('reset', '-q', '--hard')
  r.write('ledger/tasks/S3.md', taskFile('S3', 'Bake bread'))
  r.git('rm', '-q', 'ledger/tasks/S1.md')
  refused(r.commit('docs: renumber S1'), /task S1 is deleted/)
  r.git('reset', '-q', '--hard')
  r.git('checkout', '-q', 'main')
  r.git('rm', '-q', 'ledger/tasks/S2.md')
  refused(r.commit('docs: drop S2'), /task S2 is deleted/)
})

test('a task created on this branch may be renamed and deleted', () => {
  const r = workspace({ tasks: [['S1', 'Bake bread']] })
  r.git('checkout', '-q', '-b', 'lane')
  task(r, 'S5', 'Sell cakes')
  passed(r.commit('docs: add S5'))
  // Another lane took S5 first, so this one renames it before merging.
  r.git('rm', '-q', 'ledger/tasks/S5.md')
  task(r, 'S6', 'Sell cakes')
  passed(r.commit('docs: S5 is S6'))
  r.git('rm', '-q', 'ledger/tasks/S6.md')
  passed(r.commit('docs: remove S6'))
})

test("editing another lane's task is refused, and a doing or blocked task counts", () => {
  const r = workspace({
    tasks: [
      ['S1', 'Bake bread', { status: 'doing', lane: 'other' }],
      ['S2', 'Buy flour', { status: 'blocked', lane: 'other' }]
    ]
  })
  r.git('checkout', '-q', '-b', 'mine')
  task(r, 'S1', 'Bake bread', { status: 'doing', lane: 'other', note: 'An edit.' })
  refused(r.commit('docs: S1'), /ledger\/tasks\/S1\.md: task S1 is held by lane "other" \(Status: doing\).*claim S1 --take/)
  r.git('reset', '-q', '--hard')
  task(r, 'S2', 'Buy flour', { status: 'doing', lane: 'mine' })
  refused(r.commit('docs: claim S2'), /task S2 is held by lane "other" \(Status: blocked\)/)
})

test('the holding lane edits its own task, and a takeover with Taken over from passes', () => {
  const r = workspace({ tasks: [['S1', 'Bake bread', { status: 'doing', lane: 'other' }]] })
  r.git('checkout', '-q', '-b', 'other')
  task(r, 'S1', 'Bake bread', { status: 'doing', lane: 'other', note: 'Rye.' })
  passed(r.commit('docs: S1 note'))
  r.git('checkout', '-q', '-b', 'mine')
  // A takeover that does not name the old lane is not one.
  task(r, 'S1', 'Bake bread', { status: 'doing', lane: 'mine', takenOver: 'someone at abc1234' })
  refused(r.commit('chore: take S1'), /held by lane "other"/)
  task(r, 'S1', 'Bake bread', { status: 'doing', lane: 'mine', takenOver: 'other at abc1234' })
  passed(r.commit('chore: take S1'))
})

test('claiming an unheld task and editing a done or dropped task pass', () => {
  const r = workspace({
    tasks: [
      ['S1', 'Bake bread'],
      ['S2', 'Buy flour', { status: 'done', lane: 'other' }],
      ['S3', 'Sell cakes', { status: 'dropped' }],
      ['S4', 'Open a shop', { status: 'blocked' }]
    ]
  })
  r.git('checkout', '-q', '-b', 'mine')
  task(r, 'S1', 'Bake bread', { status: 'doing', lane: 'mine' })
  passed(r.commit('chore: claim S1'))
  task(r, 'S2', 'Buy flour', { status: 'done', lane: 'other', note: 'Fixed a link.' })
  task(r, 'S3', 'Sell cakes', { status: 'dropped', note: 'Maybe later.' })
  task(r, 'S4', 'Open a shop', { status: 'blocked', note: 'Waiting for the lease.' })
  passed(r.commit('docs: notes'))
})

test('during a merge, a task staged as the merged lane left it passes', () => {
  const r = workspace({ tasks: [['S1', 'Bake bread', { status: 'doing', lane: 'lane' }]] })
  r.git('checkout', '-q', '-b', 'lane')
  task(r, 'S1', 'Bake bread', { status: 'done', lane: 'lane' })
  passed(r.commit('docs: S1 done'))
  r.git('checkout', '-q', 'main')
  r.write('notes.md', 'Notes.\n')
  passed(r.commit('docs: notes'))
  assert.equal(r.git('merge', '--no-ff', '--no-commit', 'lane').status, 0)
  passed(r.git('commit', '-q', '--no-edit'))
})

test('the first commit in an empty repository passes', () => {
  const r = repository()
  install(r)
  task(r, 'S1', 'Bake bread', { status: 'doing', lane: 'someone' })
  r.git('config', 'core.hooksPath', '.githooks')
  passed(r.commit('chore: start'))
  assert.equal(r.git('rev-list', '--count', 'HEAD').out.trim(), '1')
})

test('a detached HEAD passes without the ownership check', () => {
  const r = workspace({ tasks: [['S1', 'Bake bread', { status: 'doing', lane: 'other' }], ['S2', 'Buy flour']] })
  r.git('checkout', '-q', '--detach')
  task(r, 'S1', 'Bake bread', { status: 'doing', lane: 'other', note: 'An edit.' })
  r.git('rm', '-q', 'ledger/tasks/S2.md')
  passed(r.commit('docs: S1'))
})

test('the commit gates run only when code is staged', () => {
  const marker = join(temporary(), 'gate-ran')
  const gate = `node -e "require('fs').appendFileSync(process.argv[1], 'x')" "${marker.replace(/\\/g, '/')}"`
  const r = workspace({ config: { gates: { commit: [gate] } } })
  task(r, 'S1', 'Bake bread')
  r.write('notes.md', 'Notes.\n')
  passed(r.commit('docs: S1'))
  assert.equal(existsSync(marker), false)
  r.write('src/app.js', 'console.log(1)\n')
  const result = r.commit('feat: app')
  passed(result)
  assert.equal(readFileSync(marker, 'utf8'), 'x')
  assert.match(result.out, /✔ node -e .* \([\d.]+ s\)/)
})

test('a failing commit gate refuses the commit', () => {
  const r = workspace({ config: { gates: { commit: ['node -e "process.exit(3)"'] } } })
  r.write('src/app.js', 'console.log(1)\n')
  const result = r.commit('feat: app')
  refused(result, /the commit gate "node -e "process\.exit\(3\)"" failed/)
  assert.match(result.out, /exited with 3/)
  assert.equal(r.git('rev-list', '--count', 'HEAD').out.trim(), '1')
})
