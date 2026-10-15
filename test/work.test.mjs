// work: the state on one screen, in real repositories with the bundled guard and its hooks
// installed, so that turning the hooks on is real. Lanes are real worktrees.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { HOOK_NAMES, renderHook } from '../src/cli/hooks.mjs'
import { compareTaskIds } from '../src/guard/work.mjs'
import { BUDGET, ENV, PACKAGE, repository, run, temporary } from './helpers.mjs'

const GUARD = join(temporary(), 'records.mjs')
const built = run(PACKAGE, process.execPath, [join(PACKAGE, 'scripts', 'bundle.mjs'), '--out', GUARD])
if (built.status !== 0) throw new Error(`bundle failed: ${built.out}`)

const README = `# Bakery shop

## Goal

Build a small web shop for local bakers. It is finished when a customer can order bread.

## Environments

Local only.

## Manual checks

None.
`

/** A task file: its heading, fields and sections, valid for its status. */
function taskFile(id, title, fields = {}) {
  const { status = 'todo', lane, depends, waiting, handoff } = fields
  const lines = [`# ${id} ${title}`, '', `- Status: ${status}`]
  if (lane) lines.push(`- Lane: ${lane}`)
  if (depends) lines.push(`- Depends on: ${depends}`)
  if (waiting) lines.push(`- Waiting for: ${waiting}`)
  if (status === 'done') lines.push('- Evidence: `npm test`: 3 of 3')
  if (status === 'dropped') lines.push('- Reason: not needed')
  if (status === 'doing') lines.push('', '## Plan', '', 'Do the thing and test it.')
  if (handoff) lines.push('', '## Handoff', '', handoff)
  return `${lines.join('\n')}\n`
}

/** A repository with the hooks and the bundled guard, a configuration, a README and tasks, committed with the hooks off. */
function workspace({ config = {}, readme = README, tasks = [] } = {}) {
  const r = repository()
  for (const name of HOOK_NAMES) {
    r.write(`.githooks/${name}`, renderHook(name, 'ledger'))
    chmodSync(join(r.root, '.githooks', name), 0o755)
  }
  r.write('ledger/scripts/records.mjs', readFileSync(GUARD, 'utf8'))
  r.write('.resaledger.json', `${JSON.stringify({ version: 2, ...config }, null, 2)}\n`)
  if (readme !== null) r.write('ledger/README.md', readme)
  for (const [id, title, fields] of tasks) r.write(`ledger/tasks/${id}.md`, taskFile(id, title, fields))
  const committed = r.commit('chore: start')
  if (committed.status !== 0) throw new Error(`commit failed: ${committed.out}`)
  return r
}

function work(r, ...args) {
  return r.node('ledger/scripts/records.mjs', 'work', ...args)
}

function workJson(r, ...args) {
  const result = work(r, '--json', ...args)
  assert.equal(result.status, 0, result.out)
  return JSON.parse(result.out)
}

test('ids sort naturally: by prefix, then number by number', () => {
  const ids = ['S10', 'S4.1', 'A2', 'S2', 'S4', 'S5', 'S4.10', 'S4.2', 'A10']
  assert.deepEqual([...ids].sort(compareTaskIds), ['A2', 'A10', 'S2', 'S4', 'S4.1', 'S4.2', 'S4.10', 'S5', 'S10'])
})

test('an empty workspace shows the goal, no work in progress and the next commands', () => {
  const r = workspace()
  const result = work(r)
  assert.equal(result.status, 0, result.out)
  assert.equal(
    result.out,
    `✔ git hooks turned on: core.hooksPath is .githooks
ResaLedger · lane main · solo · hooks on
Goal: Build a small web shop for local bakers.

In progress in this lane
  none

Next: node ledger/scripts/records.mjs task <id> for the plan, then node ledger/scripts/records.mjs handoff before you stop.
`
  )
  // The second run finds the hooks on and says nothing about them.
  assert.ok(work(r).out.startsWith('ResaLedger · lane main · solo · hooks on\n'))
})

test('a solo repository: in progress with the handoff, waiting, blocked, ready next and progress', () => {
  const r = workspace({
    tasks: [
      ['S1', 'Set up the project', { status: 'done' }],
      ['S2', 'Try a framework', { status: 'dropped' }],
      ['S3', 'Store the orders', { status: 'doing', lane: 'main', handoff: 'Routes are done.\n\nNext: the list view.\nThe tree is clean.\nOpen question: paging.' }],
      ['S4', 'Choose the payment provider', { status: 'blocked', waiting: 'Owner: pick one of the two offers' }],
      ['S5', 'Send receipts', { status: 'blocked', waiting: 'S3' }],
      ['S6', 'Show the bread list', { depends: 'S1, S2' }],
      ['S7', 'Order history', { depends: 'S3' }],
      ['S8', 'Opening hours page']
    ]
  })
  work(r)
  const result = work(r)
  assert.equal(result.status, 0, result.out)
  assert.equal(
    result.out,
    `ResaLedger · lane main · solo · hooks on
Goal: Build a small web shop for local bakers.

In progress in this lane
  S3  Store the orders
      Routes are done.
      Next: the list view.
      The tree is clean.

Waiting for the owner
  S4  Choose the payment provider — Owner: pick one of the two offers

Blocked
  S5  Send receipts — waiting for S3

Ready next
  S6  Show the bread list
  S8  Opening hours page

Progress
  2 of 8 done or dropped

Next: node ledger/scripts/records.mjs task S3 for the plan, then node ledger/scripts/records.mjs handoff before you stop.
`
  )
})

test('ready next is ordered by id naturally, or by phases first, and shows at most five', () => {
  const tasks = ['S10', 'S2', 'S4.1', 'S4', 'S5', 'A1'].map((id) => [id, `Task ${id}`])
  const plain = workJson(workspace({ tasks }))
  assert.deepEqual(plain.ready.map((task) => task.id), ['A1', 'S2', 'S4', 'S4.1', 'S5'])
  const phased = workJson(workspace({ tasks, config: { phases: ['S', 'A'] } }))
  assert.deepEqual(phased.ready.map((task) => task.id), ['S2', 'S4', 'S4.1', 'S5', 'S10'])
  assert.deepEqual(
    phased.progress.byPrefix.map((entry) => entry.prefix),
    ['S', 'A']
  )
})

test('three worktrees see each other\'s claims, an uncommitted one too, and ready next leaves them out', () => {
  const r = workspace({ tasks: [['S1', 'One'], ['S2', 'Two'], ['S3', 'Three'], ['S4', 'Four']] })
  const a = r.worktree('a')
  a.write('ledger/tasks/S1.md', taskFile('S1', 'One', { status: 'doing', lane: 'a', handoff: 'Started.' }))
  assert.equal(a.commit('chore: claim S1').status, 0)
  const b = r.worktree('b')
  b.write('ledger/tasks/S2.md', taskFile('S2', 'Two', { status: 'doing', lane: 'b' }))
  const c = r.worktree('c')

  const fromMain = work(r)
  assert.equal(fromMain.status, 0, fromMain.out)
  assert.match(fromMain.out, /\nOther lanes\n {2}a: S1\n {2}b: S2\n {2}c: holds nothing\n/)
  assert.match(fromMain.out, /\nReady next\n {2}S3 {2}Three\n {2}S4 {2}Four\n/)
  assert.doesNotMatch(fromMain.out, /Warnings/)

  const fromC = workJson(c)
  assert.equal(fromC.lane, 'c')
  assert.deepEqual(
    fromC.lanes.map((lane) => [lane.branch, lane.source, lane.holds]),
    [['c', 'this', []], ['a', 'worktree', ['S1']], ['b', 'worktree', ['S2']], ['main', 'worktree', []]]
  )
  assert.deepEqual(fromC.ready.map((task) => task.id), ['S3', 'S4'])
  assert.equal(fromC.lanes[1].lastCommit.author, 'Test')

  const fromA = work(a)
  assert.match(fromA.out, /^ResaLedger · lane a · solo · hooks on\n/)
  assert.match(fromA.out, /\nIn progress in this lane\n {2}S1 {2}One\n {6}Started\.\n/)
  assert.match(fromA.out, /\nOther lanes\n {2}b: S2\n {2}c: holds nothing\n {2}main: holds nothing\n/)
})

test('a task doing in two worktrees is a double claim', () => {
  const r = workspace({ tasks: [['S1', 'One'], ['S2', 'Two']] })
  for (const name of ['a', 'b']) r.worktree(name).write('ledger/tasks/S1.md', taskFile('S1', 'One', { status: 'doing', lane: name }))
  const result = work(r)
  assert.match(result.out, /\nWarnings\n {2}S1 is doing in 2 lanes: a, b\./)
  const state = workJson(r)
  assert.deepEqual(state.warnings.doubleClaims, [{ id: 'S1', lanes: ['a', 'b'] }])
  assert.deepEqual(state.ready.map((task) => task.id), ['S2'])
})

test('a task held by a branch that is gone is a stale claim', () => {
  const r = workspace({ tasks: [['S1', 'One', { status: 'doing', lane: 's1-old-branch' }], ['S2', 'Two']] })
  const result = work(r)
  assert.match(result.out, /\nWarnings\n {2}S1 is held by s1-old-branch, which is no branch here: a stale claim\. Take it over with claim S1 --take\n/)
  assert.match(result.out, /\nIn progress in this lane\n {2}none\n/)
  const state = workJson(r)
  assert.deepEqual(state.warnings.staleClaims, [{ id: 'S1', lane: 's1-old-branch', file: 'ledger/tasks/S1.md' }])
  assert.deepEqual(state.ready.map((task) => task.id), ['S2'])

  // A local branch that exists is not stale, even without a worktree.
  r.git('branch', 's1-old-branch')
  assert.deepEqual(workJson(r).warnings.staleClaims, [])
})

test('record problems are warnings: five shown, and a count of the rest', () => {
  const tasks = Array.from({ length: 7 }, (_, index) => [`S${index + 1}`, `Task ${index + 1}`, { depends: 'X99' }])
  const result = work(workspace({ tasks }))
  assert.equal(result.status, 0, result.out)
  const warnings = result.out.split('\nWarnings\n')[1].split('\n\n')[0].split('\n')
  assert.equal(warnings.length, 6)
  assert.match(warnings[0], /^ {2}ledger\/tasks\/S1\.md:\d+: "Depends on" names X99/)
  assert.equal(warnings[5], '  and 2 more record problems; run check for the list')
})

test('--json prints one object with every section and nothing else', () => {
  const r = workspace({
    tasks: [
      ['S1', 'One', { status: 'doing', lane: 'main', handoff: 'Halfway.' }],
      ['S2', 'Two', { status: 'blocked', waiting: 'owner' }],
      ['S3', 'Three']
    ]
  })
  const result = work(r, '--json')
  assert.equal(result.status, 0, result.out)
  const state = JSON.parse(result.out)
  assert.deepEqual(Object.keys(state), ['lane', 'preset', 'hooks', 'goal', 'inProgress', 'waitingForOwner', 'blocked', 'ready', 'lanes', 'progress', 'verification', 'warnings', 'next'])
  assert.equal(state.lane, 'main')
  assert.equal(state.preset, 'solo')
  assert.deepEqual(state.hooks, { active: true, activated: true, foreign: null })
  assert.equal(state.goal, 'Build a small web shop for local bakers.')
  assert.deepEqual(state.inProgress, [{ id: 'S1', title: 'One', file: 'ledger/tasks/S1.md', handoff: ['Halfway.'] }])
  assert.deepEqual(state.waitingForOwner, [{ id: 'S2', title: 'Two', file: 'ledger/tasks/S2.md', waitingFor: 'owner' }])
  assert.deepEqual(state.blocked, [])
  assert.deepEqual(state.ready, [{ id: 'S3', title: 'Three', file: 'ledger/tasks/S3.md' }])
  assert.equal(state.lanes.length, 1)
  assert.deepEqual(state.lanes[0].holds, ['S1'])
  assert.equal(state.lanes[0].source, 'this')
  assert.deepEqual(Object.keys(state.lanes[0].lastCommit), ['author', 'date'])
  assert.deepEqual(state.progress, { done: 0, total: 3, byPrefix: [{ prefix: 'S', done: 0, total: 3 }] })
  assert.deepEqual(state.warnings, { doubleClaims: [], staleClaims: [], problems: [] })
  assert.deepEqual(state.next, ['node ledger/scripts/records.mjs task S1', 'node ledger/scripts/records.mjs handoff'])
  assert.equal(work(r, '--verbose').status, 1)
})

test('the hooks are off in a fresh clone and on after work', () => {
  const r = workspace()
  const clone = join(r.base, 'clone')
  assert.equal(run(r.base, 'git', ['clone', '-q', r.root, clone]).status, 0)
  const guard = (...args) => run(clone, process.execPath, ['ledger/scripts/records.mjs', ...args])
  assert.equal(guard('hooks').status, 1)
  const result = guard('work')
  assert.equal(result.status, 0, result.out)
  assert.match(result.out, /^✔ git hooks turned on: core\.hooksPath is \.githooks\nResaLedger · lane main · solo · hooks on\n/)
  assert.equal(guard('hooks').status, 0)
  assert.equal(run(clone, 'git', ['config', 'core.hooksPath']).out.trim(), '.githooks')
})

test('a foreign core.hooksPath is left alone, with one warning line', () => {
  const r = workspace()
  r.git('config', 'core.hooksPath', '.husky')
  const result = work(r)
  assert.equal(result.status, 0, result.out)
  const lines = result.out.split('\n')
  assert.match(lines[0], /^✖ core\.hooksPath is "\.husky", not \.githooks/)
  assert.equal(lines[1], 'ResaLedger · lane main · solo · hooks off')
  assert.equal(r.git('config', 'core.hooksPath').out.trim(), '.husky')
})

test('the status alias and the team preset', () => {
  const r = workspace({ config: { preset: 'team' } })
  const result = r.node('ledger/scripts/records.mjs', 'status')
  assert.equal(result.status, 0, result.out)
  assert.match(result.out, /ResaLedger · lane main · team · hooks on\n/)
})

test('work finishes within the budget on 300 tasks', (t) => {
  const statuses = ['todo', 'todo', 'done', 'dropped', 'blocked', 'doing']
  const tasks = Array.from({ length: 300 }, (_, index) => {
    const status = statuses[index % statuses.length]
    const id = `${['S', 'C', 'W'][index % 3]}${index + 1}`
    const fields = { status, depends: index > 10 && status === 'todo' ? `S${(index % 9) * 3 + 1}` : undefined }
    if (status === 'blocked') fields.waiting = index % 2 ? 'owner' : 'a supplier'
    if (status === 'doing') {
      fields.lane = 'main'
      fields.handoff = 'Halfway there.\nNext: the tests.'
    }
    return [id, `Task number ${index + 1}`, fields]
  })
  const r = workspace({ tasks })
  work(r)
  const started = process.hrtime.bigint()
  const result = work(r)
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6
  assert.equal(result.status, 0, result.out)
  assert.match(result.out, /300 done or dropped|of 300 done or dropped/)
  t.diagnostic(`work on 300 tasks: ${elapsed.toFixed(0)} ms, including node start-up`)
  assert.ok(elapsed < 3000 * BUDGET, `work took ${elapsed} ms`)
})

test('the header says whether the gates passed on the code at HEAD', () => {
  const r = workspace({ config: { gates: { verify: ['node -e "process.exit(0)"'] } } })
  const before = work(r)
  assert.equal(before.status, 0, before.out)
  assert.match(before.out, /· hooks on · not verified\n/)
  assert.match(before.out, /The gates have not passed on the code at HEAD: run node ledger\/scripts\/records\.mjs verify/)
  assert.equal(workJson(r).verification.state, 'unverified')

  const verified = r.node('ledger/scripts/records.mjs', 'verify')
  assert.equal(verified.status, 0, verified.out)
  const after = work(r)
  assert.match(after.out, /· hooks on · verified\n/)
  assert.doesNotMatch(after.out, /have not passed/)
  assert.deepEqual(workJson(r).verification, { state: 'verified', gates: 1 })
})

test('with no gates the header says nothing about verification', () => {
  const r = workspace()
  assert.deepEqual(workJson(r).verification, { state: 'no-gates', gates: 0 })
})

// work --all: the pushed lanes. A second clone of the bare remote does the other lanes' work,
// with no hooks, and pushes it; the repository under test sees it after a fetch.

/** A clone of r's remote next to r, with git and file helpers. */
function cloneOf(r, name = 'clone') {
  const root = join(r.base, name)
  const cloned = run(r.base, 'git', ['clone', '-q', join(r.base, 'remote.git'), root])
  if (cloned.status !== 0) throw new Error(`git clone failed: ${cloned.out}`)
  const c = {
    root,
    git: (...args) => {
      const result = run(root, 'git', args)
      if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.out}`)
      return result.out
    },
    write: (path, text) => writeFileSync(join(root, path), text),
    /** A branch from main with these task files, committed (at a date, when given) and pushed. */
    lane: (branch, files, date) => {
      c.git('checkout', '-q', '-b', branch, 'main')
      for (const [id, title, fields] of files) c.write(`ledger/tasks/${id}.md`, taskFile(id, title, fields))
      c.git('add', '-A')
      const dates = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}
      const message = `chore: claim ${files.map(([id]) => id).join(', ')}`
      const committed = spawnSync('git', ['commit', '-q', '--allow-empty', '-m', message], { cwd: root, env: { ...ENV, ...dates }, encoding: 'utf8' })
      if (committed.status !== 0) throw new Error(`git commit failed: ${committed.stdout}${committed.stderr}`)
      c.git('push', '-q', '-u', 'origin', branch)
      c.git('checkout', '-q', 'main')
    }
  }
  return c
}

/** A workspace with a bare remote, its main pushed, and a clone of that remote. */
function pushedWorkspace(options) {
  const r = workspace(options)
  r.remote()
  assert.equal(r.push('-u', 'main').status, 0)
  return { r, c: cloneOf(r) }
}

test('work --all shows pushed lanes newest first, with what each holds, and warns of a task held by two', () => {
  const { r, c } = pushedWorkspace({ tasks: [['S1', 'One'], ['S2', 'Two'], ['S3', 'Three']] })
  c.lane('a', [['S1', 'One', { status: 'doing', lane: 'a' }]], '2030-01-01T10:00:00Z')
  c.lane('b', [['S1', 'One', { status: 'doing', lane: 'b' }], ['S2', 'Two', { status: 'doing', lane: 'b' }]], '2030-01-02T10:00:00Z')
  c.lane('quiet', [], '2030-01-03T10:00:00Z')
  assert.equal(r.fetch().status, 0)

  const plain = workJson(r)
  assert.deepEqual(plain.lanes.map((lane) => lane.source), ['this'])
  assert.equal('base' in plain, false)

  const state = workJson(r, '--all')
  assert.equal(state.base, 'origin/main')
  assert.equal(state.fetch, null)
  const remote = state.lanes.filter((lane) => lane.source === 'remote')
  assert.deepEqual(
    remote.map((lane) => [lane.branch, lane.holds, lane.ahead, lane.verification]),
    [
      ['quiet', [], 1, null],
      ['b', ['S1', 'S2'], 1, 'no-gates'],
      ['a', ['S1'], 1, 'no-gates']
    ]
  )
  assert.deepEqual(Object.keys(remote[0]), ['branch', 'source', 'holds', 'lastCommit', 'pushed', 'remote', 'ref', 'commit', 'ahead', 'verification'])
  assert.equal(remote[0].ref, 'refs/remotes/origin/quiet')
  assert.equal(remote[0].lastCommit.author, 'Test')
  assert.equal(state.lanes[0].pushed, true)
  assert.deepEqual(state.warnings.doubleClaims, [{ id: 'S1', lanes: ['a', 'b'] }])
  assert.deepEqual(state.warnings.staleClaims, [])
  assert.deepEqual(state.ready.map((task) => task.id), ['S3'])

  const text = work(r, '--all')
  assert.equal(text.status, 0, text.out)
  assert.match(
    text.out,
    /\nPushed lanes not merged into origin\/main\n {2}origin\/quiet: holds nothing · 1 ahead · Test 2030-01-03\n {2}origin\/b: S1, S2 · 1 ahead · Test 2030-01-02\n {2}origin\/a: S1 · 1 ahead · Test 2030-01-01\n/
  )
  assert.match(text.out, /\nWarnings\n {2}S1 is doing in 2 lanes: a, b\./)
  assert.doesNotMatch(work(r).out, /Pushed lanes/)
})

test('work --all: a task that is the base\'s own is no lane\'s claim, and a merged lane is not shown', () => {
  const { r, c } = pushedWorkspace({ tasks: [['S1', 'One', { status: 'doing', lane: 'main' }], ['S2', 'Two']] })
  // The lane changes another file only: S1 on it is the base's own task.
  c.git('checkout', '-q', '-b', 'docs')
  c.write('notes.md', 'Notes.\n')
  c.git('add', '-A')
  c.git('commit', '-q', '-m', 'docs: notes')
  c.git('push', '-q', 'origin', 'docs')
  c.git('checkout', '-q', 'main')
  c.lane('done-lane', [['S2', 'Two', { status: 'done' }]])
  c.git('merge', '-q', '--ff-only', 'done-lane')
  c.git('push', '-q', 'origin', 'main')
  assert.equal(r.fetch().status, 0)

  const state = workJson(r, '--all')
  assert.deepEqual(
    state.lanes.map((lane) => [lane.branch, lane.source, lane.holds]),
    [['main', 'this', ['S1']], ['docs', 'remote', []]]
  )
  assert.deepEqual(state.warnings.doubleClaims, [])
  assert.deepEqual(state.warnings.staleClaims, [])
})

test('work --all: a claim left by a merged branch, and by a deleted one, is a stale claim; --fetch prunes', () => {
  const { r, c } = pushedWorkspace({ tasks: [['S1', 'One'], ['S2', 'Two'], ['S3', 'Three']] })
  c.lane('m', [['S1', 'One', { status: 'doing', lane: 'm' }]])
  c.git('merge', '-q', '--no-ff', '-m', 'Merge m', 'm')
  c.lane('g', [['S2', 'Two', { status: 'doing', lane: 'g' }]])
  c.git('merge', '-q', '--no-ff', '-m', 'Merge g', 'g')
  c.git('push', '-q', 'origin', 'main')
  assert.equal(r.fetch().status, 0)
  c.git('push', '-q', 'origin', '--delete', 'g')

  // As last fetched, g still exists, merged.
  const before = workJson(r, '--all')
  assert.deepEqual(before.lanes.map((lane) => lane.branch), ['main'])
  assert.deepEqual(
    before.warnings.staleClaims.map((claim) => [claim.id, claim.lane, claim.reason]),
    [['S1', 'm', 'merged'], ['S2', 'g', 'merged']]
  )

  const fetched = work(r, '--fetch')
  assert.equal(fetched.status, 0, fetched.out)
  assert.doesNotMatch(fetched.out, /could not fetch/)
  assert.match(fetched.out, /\nPushed lanes not merged into origin\/main\n {2}none\n/)
  assert.match(fetched.out, /\n {2}S1 is held by m, which is merged into origin\/main: a stale claim\. Take it over with claim S1 --take\n/)
  assert.match(fetched.out, /\n {2}S2 is held by g, which is gone: a stale claim\. Take it over with claim S2 --take\n/)
  const after = workJson(r, '--all')
  assert.deepEqual(after.fetch, null)
  assert.deepEqual(
    after.warnings.staleClaims.map((claim) => [claim.id, claim.reason]),
    [['S1', 'merged'], ['S2', 'gone']]
  )
  // The plain work does not read the base: this lane is behind it and sees no claim.
  assert.deepEqual(workJson(r).warnings.staleClaims, [])
})

test('work --fetch against an unreachable remote says so in one line and continues offline', () => {
  const { r, c } = pushedWorkspace({ tasks: [['S1', 'One']] })
  c.lane('a', [['S1', 'One', { status: 'doing', lane: 'a' }]])
  assert.equal(r.fetch().status, 0)
  r.git('remote', 'set-url', 'origin', join(r.base, 'gone.git'))

  const result = work(r, '--fetch')
  assert.equal(result.status, 0, result.out)
  const failures = result.out.split('\n').filter((line) => line.startsWith('✖'))
  assert.equal(failures.length, 1)
  assert.match(failures[0], /^✖ could not fetch from origin: .+; showing the branches as last fetched$/)
  assert.match(result.out, /\n {2}origin\/a: S1 · 1 ahead/)

  const json = r.node('ledger/scripts/records.mjs', 'work', '--fetch', '--json')
  assert.equal(json.status, 0, json.out)
  // run() joins stdout and stderr: the object, then the note on stderr.
  assert.match(json.out, /\n✖ could not fetch from origin: /)
  const state = JSON.parse(json.out.slice(0, json.out.lastIndexOf('}') + 1))
  assert.equal(state.fetch.ok, false)
  assert.equal(state.fetch.remote, 'origin')
  assert.deepEqual(state.lanes.map((lane) => lane.branch), ['main', 'a'])
})

test('work --all: a lane that is a local worktree and pushed shows once, as the local lane', () => {
  const r = workspace({ tasks: [['S1', 'One'], ['S2', 'Two']] })
  r.remote()
  assert.equal(r.push('-u', 'main').status, 0)
  const w = r.worktree('w')
  w.write('ledger/tasks/S1.md', taskFile('S1', 'One', { status: 'doing', lane: 'w' }))
  assert.equal(w.commit('chore: claim S1').status, 0)
  assert.equal(w.push('-u', 'w').status, 0)
  // Uncommitted on disk: the local lane reads it, the pushed branch does not have it.
  w.write('ledger/tasks/S2.md', taskFile('S2', 'Two', { status: 'doing', lane: 'w' }))

  const state = workJson(r, '--all')
  assert.deepEqual(
    state.lanes.map((lane) => [lane.branch, lane.source, lane.holds, lane.pushed]),
    [['main', 'this', [], true], ['w', 'worktree', ['S1', 'S2'], true]]
  )
  assert.match(work(r, '--all').out, /\nOther lanes\n {2}w: S1, S2 · pushed\n/)
  assert.doesNotMatch(work(r).out, /pushed/)
})

test('work --all: whether a pushed lane\'s head is verified', () => {
  const { r, c } = pushedWorkspace({ config: { gates: { verify: ['node -e "process.exit(0)"'] } }, tasks: [['S1', 'One'], ['S2', 'Two']] })
  c.lane('v', [['S1', 'One', { status: 'doing', lane: 'v' }]])
  c.git('checkout', '-q', 'v')
  const verified = run(c.root, process.execPath, ['ledger/scripts/records.mjs', 'verify'])
  assert.equal(verified.status, 0, verified.out)
  c.git('add', '-A')
  c.git('commit', '-q', '-m', 'chore: stamp')
  c.git('push', '-q', 'origin', 'v')
  c.git('checkout', '-q', 'main')
  c.lane('u', [['S2', 'Two', { status: 'doing', lane: 'u' }]])
  assert.equal(r.fetch().status, 0)

  const remote = workJson(r, '--all').lanes.filter((lane) => lane.source === 'remote')
  assert.deepEqual(
    remote.map((lane) => [lane.branch, lane.ahead, lane.verification]).sort(),
    [['u', 1, 'unverified'], ['v', 2, 'verified']]
  )
  assert.match(work(r, '--all').out, /\n {2}origin\/v: S1 · 2 ahead · Test [\d-]+ · verified\n/)
})

test('work --all finishes within the budget on 500 pushed branches', (t) => {
  const { r, c } = pushedWorkspace({ tasks: Array.from({ length: 50 }, (_, index) => [`S${index + 1}`, `Task ${index + 1}`]) })
  // Five lane heads, each changing a task, and 500 remote-tracking refs over them.
  const heads = []
  for (let index = 0; index < 5; index += 1) {
    c.lane(`head-${index}`, [[`S${index + 1}`, `Task ${index + 1}`, { status: 'doing', lane: `lane-${index}` }]])
    heads.push(c.git('rev-parse', `head-${index}`).trim())
  }
  assert.equal(r.fetch().status, 0)
  const updates = Array.from({ length: 500 }, (_, index) => `create refs/remotes/origin/lane-${index} ${heads[index % heads.length]}\n`).join('')
  const created = r.run('git', ['update-ref', '--stdin'], updates)
  assert.equal(created.status, 0, created.out)
  work(r, '--all')

  const started = process.hrtime.bigint()
  const result = work(r, '--all', '--json')
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6
  assert.equal(result.status, 0, result.out)
  const state = JSON.parse(result.out)
  assert.equal(state.lanes.filter((lane) => lane.source === 'remote').length, 505)
  assert.deepEqual(state.lanes.find((lane) => lane.branch === 'lane-3').holds, ['S4'])
  const plainStarted = process.hrtime.bigint()
  assert.equal(work(r, '--json').status, 0)
  const plain = Number(process.hrtime.bigint() - plainStarted) / 1e6
  t.diagnostic(`work --all on 500 branches: ${elapsed.toFixed(0)} ms, including node start-up; plain work: ${plain.toFixed(0)} ms`)
  assert.ok(elapsed < 2000 * BUDGET, `work --all took ${elapsed} ms`)
})
