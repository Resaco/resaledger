// handoff: the end-of-session check, in real repositories with the bundled guard and its
// hooks installed. Each failure has its own test with its exact output; commits the hooks
// would refuse are made with the hooks off or with --no-verify where that is the point.
import assert from 'node:assert/strict'
import { chmodSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { HOOK_NAMES, renderHook } from '../src/cli/hooks.mjs'
import { PACKAGE, repository, run, temporary } from './helpers.mjs'

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

const GATES = { commit: [], verify: ['node --version'] }
const PASSED = '✔ handed off: records valid, the gates passed on this code, every task in progress has a current handoff note\n'

/** A doing task held by a lane, with a plan and, unless null, a handoff note. */
function doingTask(id, lane, handoff = 'Started. Next: the list view.') {
  const lines = [`# ${id} Store the orders`, '', '- Status: doing', `- Lane: ${lane}`, '', '## Plan', '', 'Store orders and test it.']
  if (handoff !== null) lines.push('', '## Handoff', '', handoff)
  return `${lines.join('\n')}\n`
}

/**
 * A repository on main with the hooks, the bundled guard, a configuration, a README and the
 * given files, committed with the hooks off; then the hooks are turned on.
 */
function workspace({ config = { gates: GATES }, readme = README, files = {} } = {}) {
  const r = repository()
  for (const name of HOOK_NAMES) {
    r.write(`.githooks/${name}`, renderHook(name, 'ledger'))
    chmodSync(join(r.root, '.githooks', name), 0o755)
  }
  r.write('ledger/scripts/records.mjs', readFileSync(GUARD, 'utf8'))
  r.write('.resaledger.json', `${JSON.stringify({ version: 2, ...config }, null, 2)}\n`)
  r.write('ledger/README.md', readme)
  for (const [path, text] of Object.entries(files)) r.write(path, text)
  committed(r.commit('chore: start', 'Task: maintenance'))
  committed(r.git('config', 'core.hooksPath', '.githooks'))
  return r
}

function committed(result) {
  assert.equal(result.status, 0, result.out)
  return result
}

/** Writes files and commits them through the hooks. */
function commit(r, files, ...messages) {
  for (const [path, text] of Object.entries(files)) r.write(path, text)
  return committed(r.commit(...messages))
}

/** Runs verify and commits the stamp it wrote, as a records-only commit. */
function verifyAndCommit(r) {
  committed(r.node('ledger/scripts/records.mjs', 'verify'))
  committed(r.commit('chore: record the stamp'))
}

function handoff(r, ...args) {
  return r.node('ledger/scripts/records.mjs', 'handoff', ...args)
}

function short(r, rev = 'HEAD') {
  return r.git('log', '-1', '--format=%h', rev).out.trim()
}

/** Asserts a failed handoff with exactly these problem lines. */
function refused(r, ...lines) {
  const result = handoff(r)
  assert.equal(result.out, `✖ Not ready to hand off\n${lines.map((line) => `  ${line}\n`).join('')}`)
  assert.equal(result.status, 1)
}

/** A solo session on main: S1 held by main, the code and the task file committed together, verified. */
function verifiedSession() {
  const r = workspace({ files: { 'ledger/tasks/S1.md': doingTask('S1', 'main') } })
  commit(r, { 'src/orders.js': 'export const orders = []\n', 'ledger/tasks/S1.md': doingTask('S1', 'main', 'Orders are stored. Next: the list view.') }, 'feat: store orders', 'Task: S1')
  verifyAndCommit(r)
  return r
}

test('a session that commits the code and the task file together, then the stamp, passes', () => {
  const r = verifiedSession()
  const result = handoff(r)
  assert.equal(result.out, PASSED)
  assert.equal(result.status, 0)
})

test('without verify gates no stamp is needed', () => {
  const r = workspace({ config: {}, files: { 'ledger/tasks/S1.md': doingTask('S1', 'main') } })
  commit(r, { 'src/orders.js': 'export const orders = []\n', 'ledger/tasks/S1.md': doingTask('S1', 'main', 'Stored. Next: views.') }, 'feat: store orders', 'Task: S1')
  const result = handoff(r)
  assert.equal(result.out, '✔ handed off: records valid, no verify gates to pass, every task in progress has a current handoff note\n')
  assert.equal(result.status, 0)
})

test('in a detached HEAD the lane checks are skipped', () => {
  // S1 is held by main without a handoff note, which only the lane checks would report.
  const r = workspace({ config: {}, files: { 'ledger/tasks/S1.md': doingTask('S1', 'main', null) } })
  assert.equal(handoff(r).status, 1)
  committed(r.git('checkout', '-q', '--detach'))
  const result = handoff(r)
  assert.equal(result.out, '✔ handed off: records valid, no verify gates to pass, detached HEAD, so no lane checks\n')
  assert.equal(result.status, 0)
})

test('handoff takes no options', () => {
  const r = workspace()
  const result = handoff(r, '--force')
  assert.equal(result.out, 'resaledger: unknown option "--force" for handoff; it takes no options\n')
  assert.equal(result.status, 1)
})

test('an invalid record fails, with the same message as check', () => {
  const r = verifiedSession()
  committed(r.git('config', '--unset', 'core.hooksPath'))
  commit(r, { 'ledger/tasks/S2.md': '# S2 Bake bread\n\n- Status: wip\n' }, 'docs: add S2')
  committed(r.git('config', 'core.hooksPath', '.githooks'))
  const check = r.node('ledger/scripts/records.mjs', 'check')
  assert.equal(check.status, 1)
  const lines = check.out.trim().split('\n').map((line) => line.replace(/^✖ /, ''))
  assert.ok(lines.length > 0 && lines.every((line) => line.startsWith('ledger/tasks/S2.md:')), check.out)
  refused(r, ...lines)
})

test('a setup marker left in the README fails', () => {
  const r = workspace({ config: {}, readme: README.replace('Local only.', 'TODO(resaledger): list the environments') })
  refused(r, "ledger/README.md:9: a TODO(resaledger) marker is left; write the project's own text here and remove the marker")
})

test('inactive hooks fail', () => {
  const r = verifiedSession()
  committed(r.git('config', '--unset', 'core.hooksPath'))
  refused(r, 'the git hooks are not active in this clone: run work or hooks --activate')
})

test('a dirty tree fails, naming the count and the first five paths', () => {
  const r = verifiedSession()
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) r.write(`${name}.txt`, 'x\n')
  refused(r, 'the tree has 6 uncommitted paths (a.txt, b.txt, c.txt, d.txt, e.txt and 1 more): commit them or remove them; uncommitted work is not a handoff')
})

test('code that was never verified fails', () => {
  const r = workspace({ files: { 'ledger/tasks/S1.md': doingTask('S1', 'main') } })
  commit(r, { 'src/orders.js': 'export const orders = []\n', 'ledger/tasks/S1.md': doingTask('S1', 'main', 'Stored. Next: views.') }, 'feat: store orders', 'Task: S1')
  const stamp = r.node('ledger/scripts/records.mjs', 'verify').out.match(/wrote (\S+?\.json)/)[1]
  r.git('clean', '-fdq')
  refused(r, `${stamp}: the gates have not passed on the code at HEAD: run verify and commit the stamp with your records`)
})

test('a stamp for older code fails', () => {
  const r = verifiedSession()
  commit(r, { 'src/orders.js': 'export const orders = [1]\n', 'ledger/tasks/S1.md': doingTask('S1', 'main', 'Seeded. Next: views.') }, 'feat: seed orders', 'Task: S1')
  const stamp = r.node('ledger/scripts/records.mjs', 'verify').out.match(/wrote (\S+?\.json)/)[1]
  committed(r.git('checkout', '-q', '--', '.'))
  r.git('clean', '-fdq')
  refused(r, `${stamp}: the gates have not passed on the code at HEAD: run verify and commit the stamp with your records`)
})

test('a doing task without a handoff note fails', () => {
  const r = workspace({ config: {}, files: { 'ledger/tasks/S1.md': doingTask('S1', 'main', null) } })
  refused(r, 'ledger/tasks/S1.md:1: S1 is in progress in this lane without a handoff note: write the exact next step in its ## Handoff')
})

test('an empty handoff section fails like a missing one', () => {
  const r = workspace({ config: {}, files: { 'ledger/tasks/S1.md': doingTask('S1', 'main', '### Later') } })
  refused(r, 'ledger/tasks/S1.md:10: S1 is in progress in this lane without a handoff note: write the exact next step in its ## Handoff')
})

test('a handoff older than the last commit naming the task fails', () => {
  const r = verifiedSession()
  commit(r, { 'src/orders.js': 'export const orders = [1]\n' }, 'feat: seed orders', 'Task: S1')
  verifyAndCommit(r)
  refused(r, `ledger/tasks/S1.md:10: S1's handoff is older than your last commit on it (${short(r, 'HEAD~1')}): rewrite it`)
  // Rewriting the note in its own commit after the code commit makes it current.
  commit(r, { 'ledger/tasks/S1.md': doingTask('S1', 'main', 'Seeded. Next: views.') }, 'docs: hand off S1')
  assert.equal(handoff(r).out, PASSED)
})

test('a byte 0x01 in a message neither hides the commit that names the task nor an unrecorded one', () => {
  const r = verifiedSession()
  r.write('src/orders.js', 'export const orders = [1]\n')
  committed(r.git('add', '-A'))
  r.write('.git/HANDOFF_MSG', 'feat: seed orders\n\n\x01\nTask: S1\n')
  committed(r.git('commit', '-q', '--cleanup=verbatim', '-F', '.git/HANDOFF_MSG'))
  verifyAndCommit(r)
  refused(r, `ledger/tasks/S1.md:10: S1's handoff is older than your last commit on it (${short(r, 'HEAD~1')}): rewrite it`)
  commit(r, { 'ledger/tasks/S1.md': doingTask('S1', 'main', 'Seeded. Next: views.') }, 'docs: hand off S1')
  r.write('src/orders.js', 'export const orders = [2]\n')
  committed(r.git('add', '-A'))
  r.write('.git/HANDOFF_MSG', 'feat: hide me\n\n\x01')
  committed(r.git('commit', '-q', '--no-verify', '--cleanup=verbatim', '-F', '.git/HANDOFF_MSG'))
  verifyAndCommit(r)
  refused(
    r,
    `${short(r, 'HEAD~1')}: "feat: hide me" changes code but names no task. Add a trailer line "Task: <id>" to the message body for the task it belongs to, or "Task: maintenance" for a change with no behaviour change`
  )
})

test('a commit made with --no-verify that names no task fails', () => {
  const r = verifiedSession()
  r.write('src/orders.js', 'export const orders = [2]\n')
  committed(r.git('add', '-A'))
  committed(r.git('commit', '-q', '--no-verify', '-m', 'feat: sneak a change in'))
  verifyAndCommit(r)
  refused(
    r,
    `${short(r, 'HEAD~1')}: "feat: sneak a change in" changes code but names no task. Add a trailer line "Task: <id>" to the message body for the task it belongs to, or "Task: maintenance" for a change with no behaviour change`
  )
})

/** A team repository with S1 claimed on lane s1, and a bare origin with main pushed. */
function teamLane() {
  const r = workspace({ config: { preset: 'team' }, files: { 'ledger/tasks/S1.md': '# S1 Store the orders\n\n- Status: todo\n' } })
  // main is protected, so the remote fetches it rather than being pushed to.
  const remote = r.remote()
  committed(run(remote, 'git', ['fetch', '-q', r.root, 'main:main']))
  committed(r.fetch())
  committed(r.git('checkout', '-q', '-b', 's1'))
  commit(r, { 'ledger/tasks/S1.md': doingTask('S1', 's1') }, 'chore: claim S1', 'Task: S1')
  commit(r, { 'src/orders.js': 'export const orders = []\n', 'ledger/tasks/S1.md': doingTask('S1', 's1', 'Stored. Next: views.') }, 'feat: store orders', 'Task: S1')
  return r
}

test('team: a lane with no upstream fails', () => {
  const r = teamLane()
  refused(r, 'the lane "s1" is not pushed: run git push -u origin HEAD')
})

test('team: a lane with unpushed commits fails, and passes once pushed', () => {
  const r = teamLane()
  committed(r.push('-u', 'HEAD'))
  commit(r, { 'src/orders.js': 'export const orders = [1]\n', 'ledger/tasks/S1.md': doingTask('S1', 's1', 'Seeded. Next: views.') }, 'feat: seed orders', 'Task: S1')
  refused(r, 'the lane "s1" has 1 unpushed commit: run git push')
  committed(r.push())
  assert.equal(handoff(r).out, '✔ handed off: records valid, no verify gates to pass, every task in progress has a current handoff note, the lane is pushed\n')
})

test('team: an unrecorded commit on a lane with no upstream is found from the base branch', () => {
  const r = teamLane()
  r.write('src/orders.js', 'export const orders = [3]\n')
  committed(r.git('add', '-A'))
  committed(r.git('commit', '-q', '--no-verify', '-m', 'feat: untracked change'))
  refused(
    r,
    `${short(r)}: "feat: untracked change" changes code but names no task. Add a trailer line "Task: <id>" to the message body for the task it belongs to, or "Task: maintenance" for a change with no behaviour change`,
    'the lane "s1" is not pushed: run git push -u origin HEAD'
  )
})

test('help lists handoff', () => {
  const r = workspace()
  assert.match(r.node('ledger/scripts/records.mjs', 'help').out, /\n {2}handoff {3}the end-of-session check/)
})

test('a records-only commit that names the task does not make its handoff stale', () => {
  const r = verifiedSession()
  commit(r, { 'ledger/log/2026-10-15-orders.md': '# 2026-10-15 · Orders\n\nStored the orders.\n' }, 'docs: log the orders work', 'Task: S1')
  const result = handoff(r)
  assert.equal(result.out, PASSED)
  assert.equal(result.status, 0)
})
