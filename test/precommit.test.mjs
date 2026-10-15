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

test('a clean git merge onto a protected branch is refused by pre-merge-commit', () => {
  const r = workspace({ config: { preset: 'team' } })
  const setup = r.git('rev-parse', 'HEAD').out.trim()
  r.git('checkout', '-q', '-b', 'lane')
  task(r, 'S1', 'Print the answer', { status: 'doing', lane: 'lane' })
  r.write('x.js', 'x\n')
  passed(r.commit('feat: x', 'Task: S1'))
  r.git('checkout', '-q', 'main')
  // A merge that commits by itself runs pre-merge-commit, never pre-commit.
  const noFf = r.git('merge', '-q', '--no-ff', '-m', 'Merge lane', 'lane')
  refused(noFf, /"main" is a protected branch, so nothing is committed on it, not even a merge.*A fast-forward merge makes no commit, so no commit hook sees it; pre-push refuses it/)
  assert.equal(r.git('rev-parse', 'HEAD').out.trim(), setup, 'no merge commit was made')
  r.git('merge', '--abort')
  // A true merge of diverged branches, with main moved on past the hooks.
  r.write('notes.md', 'Notes.\n')
  r.git('add', '-A')
  assert.equal(r.git('commit', '-q', '--no-verify', '-m', 'docs: notes').status, 0)
  const diverged = r.git('rev-parse', 'HEAD').out.trim()
  refused(r.git('merge', '-q', '-m', 'Merge lane', 'lane'), /"main" is a protected branch/)
  assert.equal(r.git('rev-parse', 'HEAD').out.trim(), diverged, 'no merge commit was made')
  r.git('merge', '--abort')
  // A merge stopped with --no-commit is committed through pre-commit.
  const merging = r.git('merge', '--no-ff', '--no-commit', 'lane')
  assert.equal(merging.status, 0, merging.out)
  refused(r.git('commit', '-q', '--no-edit'), /"main" is a protected branch/)
})

test('a clean merge onto a lane passes pre-merge-commit, and a bad merge is refused', () => {
  const r = workspace({ tasks: [['S1', 'Bake bread', { status: 'doing', lane: 'other' }]] })
  r.git('checkout', '-q', '-b', 'other')
  task(r, 'S1', 'Bake bread', { status: 'doing', lane: 'other', note: 'Rye.' })
  passed(r.commit('docs: S1 note'))
  r.git('checkout', '-q', 'main')
  r.git('checkout', '-q', '-b', 'mine')
  r.write('notes.md', 'Notes.\n')
  passed(r.commit('docs: notes'))
  // The merged lane's own change to its task passes.
  passed(r.git('merge', '-q', '--no-ff', '-m', 'Merge other', 'other'))
  assert.equal(r.git('rev-list', '--count', '--merges', 'HEAD').out.trim(), '1')
  // A merge that brings an invalid record is refused before git makes the commit.
  r.git('checkout', '-q', '-b', 'broken', 'main')
  r.write('ledger/tasks/S2.md', '# S2 Broken\n\n- Status: baking\n')
  r.git('add', '-A')
  assert.equal(r.git('commit', '-q', '--no-verify', '-m', 'docs: S2').status, 0)
  r.git('checkout', '-q', 'mine')
  const head = r.git('rev-parse', 'HEAD').out.trim()
  refused(r.git('merge', '-q', '--no-ff', '-m', 'Merge broken', 'broken'), /ledger\/tasks\/S2\.md:3: .*baking/)
  assert.equal(r.git('rev-parse', 'HEAD').out.trim(), head)
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

test('a README with setup markers is committed; only handoff asks for the text', () => {
  const r = repository()
  install(r)
  r.write('ledger/README.md', README.replace('Build a small web shop for local bakers.', 'TODO(resaledger): what is being built, for whom.'))
  r.git('config', 'core.hooksPath', '.githooks')
  passed(r.commit('chore: set up ResaLedger', 'Task: maintenance'))
})

test('the first commit in an empty repository passes', () => {
  const r = repository()
  install(r)
  task(r, 'S1', 'Bake bread', { status: 'doing', lane: 'someone' })
  r.git('config', 'core.hooksPath', '.githooks')
  passed(r.commit('chore: start', 'Task: maintenance'))
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
  const result = r.commit('feat: app', 'Task: maintenance')
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

test("a staged configuration does not lift the protection of its own commit; HEAD's rules judge it", () => {
  const r = workspace({ config: { preset: 'team' } })
  r.write('.resaledger.json', '{ "version": 2, "preset": "team", "protected": [], "gates": { "commit": [], "verify": [] } }\n')
  r.write('evil.js', 'evil\n')
  refused(r.commit('chore: loosen', 'Task: maintenance'), /"main" is a protected branch/)
  r.write('.resaledger.json', '{ "version": 2, "preset": "solo" }\n')
  refused(r.commit('chore: loosen', 'Task: maintenance'), /"main" is a protected branch/)
  // Once the looser rules are committed (here past the hooks), they judge the next commit.
  assert.equal(r.git('commit', '-q', '--no-verify', '-m', 'chore: loosen', '-m', 'Task: maintenance').status, 0)
  r.write('notes.md', 'Notes.\n')
  passed(r.commit('docs: notes'))
})

test("a staged branchPattern or base does not loosen HEAD's", () => {
  const r = workspace({ config: { branchPattern: '^(feat|fix)/' } })
  r.git('checkout', '-q', '-b', 'wip')
  r.write('.resaledger.json', '{ "version": 2 }\n')
  refused(r.commit('chore: drop the pattern', 'Task: maintenance'), /the branch name "wip" does not match branchPattern "\^\(feat\|fix\)\/"/)
  r.write('.resaledger.json', '{ "version": 2, "base": "wip", "branchPattern": "^(feat|fix)/" }\n')
  refused(r.commit('chore: move the base', 'Task: maintenance'), /the branch name "wip" does not match branchPattern/)
})

test("the commit gates are HEAD's: a staged configuration neither drops nor adds one", () => {
  const marker = join(temporary(), 'gate-ran')
  const gate = `node -e "require('fs').appendFileSync(process.argv[1], 'x')" "${marker.replace(/\\/g, '/')}"`
  const r = workspace({ config: { gates: { commit: ['node -e "process.exit(3)"'] } } })
  r.write('.resaledger.json', '{ "version": 2, "gates": { "commit": [] } }\n')
  r.write('src/app.js', 'console.log(1)\n')
  refused(r.commit('feat: app', 'Task: maintenance'), /the commit gate "node -e "process\.exit\(3\)"" failed/)
  r.write('.resaledger.json', `${JSON.stringify({ version: 2, gates: { commit: [gate] } })}\n`)
  refused(r.commit('feat: app', 'Task: maintenance'), /the commit gate "node -e "process\.exit\(3\)"" failed/)
  assert.equal(existsSync(marker), false, 'the staged gate did not run')
})

test('the index still names the workspace folder, and a commit without HEAD takes all its rules from the index', () => {
  const r = repository()
  install(r, { preset: 'team' })
  r.git('config', 'core.hooksPath', '.githooks')
  refused(r.commit('chore: start', 'Task: maintenance'), /"main" is a protected branch/)
  r.git('checkout', '-q', '-b', 'setup')
  passed(r.commit('chore: start', 'Task: maintenance'))
  // The staged configuration names another workspace folder; the records are checked there.
  r.write('.resaledger.json', '{ "version": 2, "preset": "team", "dir": "records" }\n')
  r.write('records/README.md', README)
  r.write('records/tasks/S1.md', '# S1 Broken\n\n- Status: baking\n')
  refused(r.commit('chore: move the workspace', 'Task: maintenance'), /records\/tasks\/S1\.md:3: .*baking/)
})

test("after merging another lane in, a task that lane holds is not deleted", () => {
  const r = workspace()
  r.git('checkout', '-q', '-b', 'lane-b')
  task(r, 'S9', 'Other work', { status: 'doing', lane: 'lane-b' })
  passed(r.commit('chore: claim S9'))
  r.git('checkout', '-q', 'main')
  r.git('checkout', '-q', '-b', 'lane-a')
  r.write('ledger/decisions/2026-10-15-a-choice.md', '# A choice\n\n- Date: 2026-10-15\n- Decided by: Alex\n\nBecause.\n')
  passed(r.commit('docs: decision'))
  passed(r.git('merge', '-q', '--no-ff', '-m', 'Merge lane-b', 'lane-b'))
  r.git('rm', '-q', 'ledger/tasks/S9.md')
  refused(r.commit('chore: drop S9'), /ledger\/tasks\/S9\.md: task S9 is deleted or its id renamed, but lane "lane-b" holds it \(Status: doing\)/)
  // The holding lane may still remove a task it created and never merged.
  r.git('reset', '-q', '--hard')
  r.git('checkout', '-q', 'lane-b')
  r.git('rm', '-q', 'ledger/tasks/S9.md')
  passed(r.commit('chore: drop S9'))
})

test('a pull that merges another lane\'s change to its task passes pre-merge-commit', () => {
  const r = workspace({ tasks: [['S1', 'Bake bread', { status: 'doing', lane: 'other' }]] })
  r.remote()
  assert.equal(r.push('main').status, 0)
  r.git('checkout', '-q', '-b', 'other')
  task(r, 'S1', 'Bake bread', { status: 'doing', lane: 'other', note: 'Rye.' })
  passed(r.commit('docs: S1 note'))
  assert.equal(r.push('other').status, 0)
  r.git('checkout', '-q', 'main')
  r.git('checkout', '-q', '-b', 'mine')
  r.write('notes.md', 'Notes.\n')
  passed(r.commit('docs: notes'))
  r.git('branch', '-q', '-D', 'other')
  passed(r.git('pull', '-q', '--no-rebase', '--no-edit', 'origin', 'other'))
  assert.equal(r.git('rev-list', '--count', '--merges', 'HEAD').out.trim(), '1')
})
