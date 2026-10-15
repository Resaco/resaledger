// claim: taking a task, in real repositories with the bundled guard and its hooks. Other lanes
// are real worktrees, and other people are clones of a bare remote.
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

/** A task file; a plan section unless plan is false. */
function taskFile(id, title, fields = {}) {
  const { status = 'todo', lane, plan = true } = fields
  const lines = [`# ${id} ${title}`, '', `- Status: ${status}`]
  if (lane) lines.push(`- Lane: ${lane}`)
  if (status === 'done') lines.push('- Evidence: `npm test`: 3 of 3')
  if (status === 'dropped') lines.push('- Reason: not needed')
  if (plan) lines.push('', '## Plan', '', 'Do the thing and test it.')
  return `${lines.join('\n')}\n`
}

/** A repository with the hooks on, the bundled guard, a configuration, a README and tasks, committed. */
function workspace({ config = {}, tasks = [] } = {}) {
  const r = repository()
  for (const name of HOOK_NAMES) {
    r.write(`.githooks/${name}`, renderHook(name, 'ledger'))
    chmodSync(join(r.root, '.githooks', name), 0o755)
  }
  r.write('ledger/scripts/records.mjs', readFileSync(GUARD, 'utf8'))
  r.write('.resaledger.json', `${JSON.stringify({ version: 2, ...config }, null, 2)}\n`)
  r.write('ledger/README.md', README)
  for (const [id, title, fields] of tasks) r.write(`ledger/tasks/${id}.md`, taskFile(id, title, fields))
  const committed = r.commit('chore: start')
  if (committed.status !== 0) throw new Error(`commit failed: ${committed.out}`)
  r.git('config', 'core.hooksPath', '.githooks')
  return r
}

const claim = (r, ...args) => r.node('ledger/scripts/records.mjs', 'claim', ...args)
const git = (r, ...args) => {
  const result = r.git(...args)
  assert.equal(result.status, 0, result.out)
  return result.out.trim()
}

/** A workspace with a bare remote and main pushed. */
function pushedWorkspace(options) {
  const r = workspace(options)
  r.remote()
  // Pushing main directly is the setup, made with the hooks off: main may be protected.
  git(r, 'config', '--unset', 'core.hooksPath')
  git(r, 'push', '-q', '-u', 'origin', 'main')
  git(r, 'config', 'core.hooksPath', '.githooks')
  return r
}

/** A clone of r's remote, with the hooks on and the same helpers as r. */
function cloneOf(r, name) {
  const path = join(r.base, name)
  const cloned = run(r.base, 'git', ['clone', '-q', join(r.base, 'remote.git'), path])
  assert.equal(cloned.status, 0, cloned.out)
  const c = { ...r, root: path }
  c.git = (...args) => run(path, 'git', args)
  c.node = (...args) => run(path, process.execPath, args)
  c.read = (file) => readFileSync(join(path, file), 'utf8')
  git(c, 'config', 'core.hooksPath', '.githooks')
  return c
}

test('solo: claims in place, keeping every other byte, and says the claim is local until pushed', () => {
  const original = [
    '# S1 Bake the bread',
    '',
    '- Status: todo',
    '- Depends on: —',
    '- Owner note: keep this',
    '- Issue: #12',
    '',
    '## Plan',
    '',
    'Knead,  rise and bake.   ',
    '',
    '## Notes',
    '',
    'Trailing text.'
  ].join('\r\n')
  const r = workspace({ tasks: [['S2', 'Other']] })
  r.write('ledger/tasks/S1-bake.md', original)
  r.commit('docs: add S1')

  const result = claim(r, 'S1')
  assert.equal(result.status, 0, result.out)
  assert.equal(
    result.out,
    `✔ S1 claimed in lane main
The claim is visible to the local worktrees now, and to others once the branch is pushed.
Next: node ledger/scripts/records.mjs task S1 for the plan, then start work; run node ledger/scripts/records.mjs handoff before you stop.
`
  )
  assert.equal(r.read('ledger/tasks/S1-bake.md'), original.replace('- Status: todo', '- Status: doing\r\n- Lane: main'))
  // Not committed: the claim is in the working tree only.
  assert.equal(git(r, 'status', '--porcelain'), 'M ledger/tasks/S1-bake.md')

  const again = claim(r, 'S1')
  assert.equal(again.status, 0, again.out)
  assert.match(again.out, /^✔ S1 is already claimed in lane main; nothing changed\n/)
})

test('an existing Lane line is replaced, and a missing one goes after Status and its nested lines', () => {
  const r = workspace()
  r.write('ledger/tasks/S1.md', '# S1 One\n\n- Status: blocked\n- Lane: old\n- Waiting for: S2\n\n## Plan\n\nGo.\n')
  r.write('ledger/tasks/S2.md', '# S2 Two\n\n- Waiting for: someone\n- Status: todo\n  - a note\n\n## Plan\n\nGo.\n')
  r.commit('docs: tasks')
  assert.equal(claim(r, 'S2').status, 0)
  assert.equal(r.read('ledger/tasks/S2.md'), '# S2 Two\n\n- Waiting for: someone\n- Status: doing\n  - a note\n- Lane: main\n\n## Plan\n\nGo.\n')
  // S1 is held by lane old (blocked with a Lane).
  const refused = claim(r, 'S1')
  assert.equal(refused.status, 1)
  assert.match(refused.out, /lane "old", in this worktree/)
  // The branch old does not exist, so the takeover names the commit the claim was seen at.
  const head = git(r, 'rev-parse', '--short', 'HEAD')
  const taken = claim(r, 'S1', '--take')
  assert.equal(taken.status, 0, taken.out)
  assert.equal(r.read('ledger/tasks/S1.md'), `# S1 One\n\n- Status: doing\n- Lane: main\n- Taken over from: old at ${head}\n- Waiting for: S2\n\n## Plan\n\nGo.\n`)
})

test('refuses a bad id, an unknown id, a done task, a dropped task and a detached HEAD', () => {
  const r = workspace({ tasks: [['S1', 'One'], ['S2', 'Two', { status: 'done' }], ['S3', 'Three', { status: 'dropped' }]] })
  const cases = [
    [['s1'], /"s1" is not a task id/],
    [[], /claim needs a task id/],
    [['S9'], /there is no task S9 in ledger\/tasks/],
    [['S2'], /S2 is done, so there is nothing to claim/],
    [['S3'], /S3 is dropped, so there is nothing to claim/],
    [['S1', '--bogus'], /unknown option "--bogus"/],
    [['S1', '--branch'], /--branch needs a value/]
  ]
  for (const [args, pattern] of cases) {
    const result = claim(r, ...args)
    assert.equal(result.status, 1, args.join(' '))
    assert.match(result.out, pattern)
  }
  git(r, 'checkout', '-q', '--detach')
  const detached = claim(r, 'S1')
  assert.equal(detached.status, 1)
  assert.match(detached.out, /HEAD is detached, and a detached HEAD is not a lane/)
  assert.equal(git(r, 'status', '--porcelain'), '')
  // With --branch, a detached HEAD gets a lane.
  const branched = claim(r, 'S1', '--branch', 's1-lane')
  assert.equal(branched.status, 0, branched.out)
  assert.equal(git(r, 'branch', '--show-current'), 's1-lane')
})

test('refuses a task with no plan, or a plan that is a proposal, and changes nothing', () => {
  const r = workspace({ tasks: [['S1', 'One', { plan: false }]] })
  r.write('ledger/plan/S-shop.md', '# Shop\n\nStatus: proposal\n\n## S2 Two\n\nBuild it.\n')
  r.write('ledger/tasks/S2.md', '# S2 Two\n\n- Status: todo\n- Plan: [S-shop.md](../plan/S-shop.md#s2-two)\n')
  r.commit('docs: plan')
  const none = claim(r, 'S1')
  assert.equal(none.status, 1)
  assert.match(none.out, /✖ S1 cannot be claimed yet: it has no plan\. Nothing was changed\./)
  assert.match(none.out, /a doing task needs a plan/)
  assert.match(none.out, /Write the plan, then run "node ledger\/scripts\/records\.mjs claim S1" again\./)
  const proposal = claim(r, 'S2')
  assert.equal(proposal.status, 1)
  assert.match(proposal.out, /is a proposal/)
  assert.equal(git(r, 'status', '--porcelain'), '')

  r.write('ledger/plan/S-shop.md', '# Shop\n\nStatus: approved\n\n## S2 Two\n\nBuild it.\n')
  const approved = claim(r, 'S2')
  assert.equal(approved.status, 0, approved.out)
})

test('refuses past the WIP limit of the lane', () => {
  const r = workspace({ config: { wip: 2 }, tasks: [['S1', 'One', { status: 'doing', lane: 'main' }], ['S2', 'Two', { status: 'doing', lane: 'main' }], ['S3', 'Three'], ['S4', 'Four', { status: 'doing', lane: 'elsewhere' }]] })
  const result = claim(r, 'S3')
  assert.equal(result.status, 1)
  assert.match(result.out, /the lane main already has 2 tasks doing \(S1, S2\), and the limit is 2\. Finish one/)
  assert.equal(git(r, 'status', '--porcelain'), '')
})

test('a double claim between two worktrees is refused; --take records the takeover, and pre-commit accepts it', () => {
  const r = workspace({ tasks: [['S1', 'One'], ['S2', 'Two']] })
  const a = r.worktree('a')
  // Lane a claims S1, not yet committed: the claim shows from disk.
  assert.equal(claim(a, 'S1').status, 0)
  const refused = claim(r, 'S1')
  assert.equal(refused.status, 1)
  assert.match(refused.out, /✖ S1 is held by another lane:\n {2}lane "a", in the worktree at .+\n {2}If that lane has stopped, take the task over with "node ledger\/scripts\/records\.mjs claim S1 --take"/)
  assert.equal(git(r, 'status', '--porcelain'), '')

  // Lane a commits its claim. A new branch b from a takes the task over.
  assert.equal(a.commit('chore: claim S1', 'Task: S1').status, 0)
  const short = git(a, 'rev-parse', '--short', 'HEAD')
  const b = a.worktree('b')
  git(b, 'reset', '-q', '--hard', 'a')
  assert.equal(claim(b, 'S1').status, 1)
  const taken = claim(b, 'S1', '--take')
  assert.equal(taken.status, 0, taken.out)
  assert.match(taken.out, new RegExp(`^✔ S1 claimed in lane b, taken over from a at ${short}\\n`))
  assert.match(b.read('ledger/tasks/S1.md'), new RegExp(`- Status: doing\\n- Lane: b\\n- Taken over from: a at ${short}\\n`))
  const committed = b.commit('chore: take over S1', 'Task: S1')
  assert.equal(committed.status, 0, committed.out)

  // Without the takeover line, pre-commit refuses the same change.
  git(b, 'reset', '-q', '--hard', 'a')
  b.write('ledger/tasks/S1.md', b.read('ledger/tasks/S1.md').replace('- Lane: a', '- Lane: b'))
  const plain = b.commit('chore: take S1', 'Task: S1')
  assert.equal(plain.status, 1)
  assert.match(plain.out, /task S1 is held by lane "a"/)
})

test('team: two clones through the bare remote; the first claim makes a lane branch and pushes it, the second clone fetches and is refused', () => {
  const r = pushedWorkspace({ config: { preset: 'team', branchPrefix: 'feat/' }, tasks: [['S1', 'Bake the bread'], ['S2', 'Two']] })
  const c = cloneOf(r, 'clone')

  const first = claim(c, 'S1')
  assert.equal(first.status, 0, first.out)
  assert.match(first.out, /^✔ S1 claimed on the new branch feat\/s1-bake-the-bread from main, committed and pushed to origin\/feat\/s1-bake-the-bread\n/)
  assert.doesNotMatch(first.out, /visible to the local worktrees/)
  assert.equal(git(c, 'branch', '--show-current'), 'feat/s1-bake-the-bread')
  assert.equal(git(c, 'log', '-1', '--format=%B'), 'chore: claim S1\n\nTask: S1')
  assert.equal(git(c, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/feat/s1-bake-the-bread')
  assert.equal(git(c, 'status', '--porcelain'), '')

  // r has not fetched: claim fetches first, sees the pushed claim and refuses.
  const second = claim(r, 'S1')
  assert.equal(second.status, 1)
  assert.match(second.out, /lane "feat\/s1-bake-the-bread", in the pushed branch origin\/feat\/s1-bake-the-bread/)
  assert.equal(git(r, 'branch', '--show-current'), 'main')
  assert.equal(git(r, 'status', '--porcelain'), '')

  // --take on a protected base makes a new lane that records the takeover, and pushes it.
  const short = git(r, 'rev-parse', '--short', 'origin/feat/s1-bake-the-bread')
  const taken = claim(r, 'S1', '--take', '--branch', 'feat/s1-again')
  assert.equal(taken.status, 0, taken.out)
  assert.match(taken.out, new RegExp(`taken over from feat/s1-bake-the-bread at ${short}, committed and pushed`))
})

test('team: a fetch failure is a warning, and the claim goes on as last fetched', () => {
  const r = pushedWorkspace({ config: { preset: 'team', claimPush: false }, tasks: [['S1', 'One']] })
  git(r, 'remote', 'set-url', 'origin', join(r.base, 'gone.git'))
  const result = claim(r, 'S1')
  assert.equal(result.status, 0, result.out)
  assert.match(result.out, /^! could not fetch from origin: .+; checking the branches as last fetched$/m)
  assert.match(result.out, /✔ S1 claimed on the new branch s1-one from main\n/)
  assert.match(result.out, /The claim is visible to the local worktrees now, and to others once the branch is pushed\./)
  assert.equal(git(r, 'branch', '--show-current'), 's1-one')
})

test('--worktree creates the lane in a new worktree, in the solo preset too', () => {
  const r = workspace({ tasks: [['S1', 'One'], ['S2', 'Two']] })
  const path = join(r.base, 'wt')
  const result = claim(r, 'S1', '--worktree', path)
  assert.equal(result.status, 0, result.out)
  assert.match(result.out, new RegExp(`^✔ S1 claimed on the new branch s1-one in the worktree ${path.replace(/[\\.]/g, '\\$&')}\\n`))
  assert.match(result.out, /Next: cd .+wt, then node ledger\/scripts\/records\.mjs task S1/)
  assert.match(readFileSync(join(path, 'ledger/tasks/S1.md'), 'utf8'), /- Status: doing\n- Lane: s1-one\n/)
  assert.equal(run(path, 'git', ['branch', '--show-current']).out.trim(), 's1-one')
  assert.equal(git(r, 'status', '--porcelain'), '')
  assert.equal(git(r, 'branch', '--show-current'), 'main')

  // This worktree now sees S1 held by s1-one.
  assert.match(claim(r, 'S1').out, /lane "s1-one", in the worktree at /)
  // A task file changed since the last commit is not in the new worktree.
  r.append('ledger/tasks/S2.md', '\nMore.\n')
  const dirty = claim(r, 'S2', '--worktree', join(r.base, 'wt2'))
  assert.equal(dirty.status, 1)
  assert.match(dirty.out, /has changes that are not committed/)
  assert.equal(existsSync(join(r.base, 'wt2')), false)
  // An existing folder or branch is refused.
  assert.match(claim(r, 'S2', '--worktree', path).out, /already exists; give --worktree a new folder/)
  assert.match(claim(r, 'S2', '--branch', 's1-one').out, /the branch "s1-one" already exists/)
})

test('--push commits the claim on its own through the hooks and pushes the branch', () => {
  const r = pushedWorkspace({ config: { commitStyle: 'conventional' }, tasks: [['S1', 'One'], ['S2', 'Two']] })
  git(r, 'checkout', '-q', '-b', 'lane-x')
  r.write('src/app.js', 'staged but not part of the claim\n')
  git(r, 'add', 'src/app.js')
  const result = claim(r, 'S1', '--push')
  assert.equal(result.status, 0, result.out)
  assert.match(result.out, /^✔ S1 claimed in lane lane-x, committed and pushed to origin\/lane-x\n/)
  assert.equal(git(r, 'show', '--name-only', '--format=%s', 'HEAD'), 'chore: claim S1\n\nledger/tasks/S1.md')
  assert.equal(git(r, 'status', '--porcelain'), 'A  src/app.js')
  assert.equal(git(r, 'rev-parse', 'origin/lane-x'), git(r, 'rev-parse', 'HEAD'))
})

test('--push: a claim commit the hooks refuse is reported, and --push without a remote is refused', () => {
  const r = pushedWorkspace({ config: { branchPattern: '^lane/' }, tasks: [['S1', 'One']] })
  git(r, 'checkout', '-q', '-b', 'not-a-lane')
  const result = claim(r, 'S1', '--push')
  assert.equal(result.status, 1)
  assert.match(result.out, /✖ the claim commit was refused, so S1 is claimed in ledger\/tasks\/S1\.md but not committed:/)
  assert.match(result.out, /does not match branchPattern/)

  const solo = workspace({ tasks: [['S1', 'One']] })
  const lonely = claim(solo, 'S1', '--push')
  assert.equal(lonely.status, 1)
  assert.match(lonely.out, /--push needs a remote/)
  assert.equal(git(solo, 'status', '--porcelain'), '')
})

test('help lists claim', () => {
  const r = workspace()
  assert.match(r.node('ledger/scripts/records.mjs', 'help').out, /\n {2}claim <id> \[--take\] \[--branch <name>\] \[--worktree <path>\] \[--push\]\n/)
})
