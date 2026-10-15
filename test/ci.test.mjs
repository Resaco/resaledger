// ci: real repositories and simulated GitHub event files, run through the bundled guard.
// One event per rule, a pull request from a fork, pushes after a squash merge and after a merge
// commit, the first pull request that adds ResaLedger, rules from the base, the stamp mode,
// a shallow clone and the --base/--head/--lane flags.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { ENV, PACKAGE, repository, run, temporary } from './helpers.mjs'

const GUARD = join(temporary(), 'records.mjs')
const built = run(PACKAGE, process.execPath, [join(PACKAGE, 'scripts', 'bundle.mjs'), '--out', GUARD])
if (built.status !== 0) throw new Error(`bundle failed: ${built.out}`)

// GitHub's committer address, in two parts for the hygiene scan.
const GITHUB = ['noreply', 'github.com'].join('@')
const ZERO = '0'.repeat(40)

const README = `# Bakery shop

## Goal

Build a small web shop for local bakers.

## Environments

Local only.

## Manual checks

None.
`

/** A task file, valid for its status unless evidence is false. */
function taskFile(id, title, fields = {}) {
  const { status = 'todo', lane, takenOver, note, evidence = true } = fields
  const lines = [`# ${id} ${title}`, '', `- Status: ${status}`]
  if (lane) lines.push(`- Lane: ${lane}`)
  if (takenOver) lines.push(`- Taken over from: ${takenOver}`)
  if (status === 'done' && evidence) lines.push('- Evidence: `npm test`: 3 of 3')
  if (status === 'blocked') lines.push('- Waiting for: owner')
  if (status === 'doing') lines.push('', '## Plan', '', 'Do the thing and test it.')
  if (note) lines.push('', '## Notes', '', note)
  return `${lines.join('\n')}\n`
}

/** Writes files and commits them; fails the test when git does. Returns the new HEAD. */
function commit(r, files, ...messages) {
  for (const [path, text] of Object.entries(files)) r.write(path, text)
  const committed = r.commit(...messages)
  assert.equal(committed.status, 0, committed.out)
  return rev(r)
}

function rev(r, name = 'HEAD') {
  return r.git('rev-parse', name).out.trim()
}

/** A repository whose first commit on main sets up ResaLedger with the given tasks. No hooks run. */
function setup({ config = {}, tasks = [] } = {}) {
  const r = repository()
  const files = {
    '.resaledger.json': `${JSON.stringify({ version: 2, ...config }, null, 2)}\n`,
    'ledger/README.md': README
  }
  for (const [id, title, fields] of tasks) files[`ledger/tasks/${id}.md`] = taskFile(id, title, fields)
  commit(r, files, 'chore: set up', 'Task: maintenance')
  return r
}

function task(id, title, fields) {
  return { [`ledger/tasks/${id}.md`]: taskFile(id, title, fields) }
}

/** Runs the bundled ci in a repository with a simulated GitHub event. */
function ci(r, name, payload, args = []) {
  const file = join(temporary('resaledger-event-'), 'event.json')
  writeFileSync(file, JSON.stringify(payload))
  const result = spawnSync(process.execPath, [GUARD, 'ci', ...args], {
    cwd: r.root,
    env: { ...ENV, GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: file },
    encoding: 'utf8'
  })
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

/** A pull_request event from a branch into main, at their current commits. */
function pullRequest(r, branch, { base = 'main', fork = false, ref = branch } = {}) {
  return {
    pull_request: {
      base: { sha: rev(r, base), ref: base, repo: { full_name: 'team/shop' } },
      head: { sha: rev(r, branch), ref, repo: { full_name: fork ? 'someone/shop' : 'team/shop' } }
    }
  }
}

function passed(result) {
  assert.equal(result.status, 0, result.out)
  assert.doesNotMatch(result.out, /✖/)
}

function failed(result, pattern) {
  assert.equal(result.status, 1, result.out)
  assert.match(result.out, pattern)
}

/** A lane that claims S1, commits code for it and finishes it. */
function finishedLane(r, lane = 'lane-a') {
  r.git('checkout', '-q', '-b', lane)
  commit(r, task('S1', 'Bake bread', { status: 'doing', lane }), 'chore: claim S1', 'Task: S1')
  commit(r, { 'src/bread.js': 'export const bread = 1\n' }, 'feat: bake bread', 'Task: S1')
  commit(r, task('S1', 'Bake bread', { status: 'done', lane }), 'docs: finish S1')
}

describe('ci on a pull request', () => {
  test('a recorded pull request passes and lists every check and the tasks it moves', () => {
    const r = setup({ tasks: [['S1', 'Bake bread'], ['S2', 'Buy flour']] })
    finishedLane(r)
    const result = ci(r, 'pull_request', pullRequest(r, 'lane-a'))
    passed(result)
    assert.match(result.out, /pull request from "lane-a"/)
    assert.match(result.out, /Rules from the base [0-9a-f]{7}\./)
    assert.match(result.out, /✔ records: 2 tasks/)
    assert.match(result.out, /✔ commits: 3 commits from the merge base to the head/)
    assert.match(result.out, /✔ ownership: 1 task changed/)
    assert.match(result.out, /✔ ids: 0 new ids/)
    assert.match(result.out, /✔ tasks moved: 1\n {2}S1 Bake bread: todo → done · Evidence: `npm test`: 3 of 3/)
    assert.match(result.out, /✔ gates: none \(no gates are configured\)/)
    assert.match(result.out, /✔ enforcement: unchanged\n/)
    // The order of the checks is fixed.
    const order = [...result.out.matchAll(/^[✔✖] (\w+)/gm)].map((match) => match[1])
    assert.deepEqual(order, ['records', 'commits', 'ownership', 'ids', 'tasks', 'gates', 'enforcement'])
  })

  test('invalid records in the head fail', () => {
    const r = setup()
    r.git('checkout', '-q', '-b', 'lane-a')
    commit(r, { 'ledger/tasks/S1.md': '# S1 Bake bread\n\n- Status: baking\n' }, 'docs: S1')
    failed(ci(r, 'pull_request', pullRequest(r, 'lane-a')), /✖ records: \d+ problems?.*\n(?: {2}.*\n)* {2}ledger\/tasks\/S1\.md:3: .*baking/)
  })

  test('a task that becomes done without evidence fails the records check', () => {
    const r = setup({ tasks: [['S1', 'Bake bread', { status: 'doing', lane: 'lane-a' }]] })
    r.git('checkout', '-q', '-b', 'lane-a')
    commit(r, task('S1', 'Bake bread', { status: 'done', lane: 'lane-a', evidence: false }), 'docs: finish S1')
    failed(ci(r, 'pull_request', pullRequest(r, 'lane-a')), /✖ records: .*\n {2}ledger\/tasks\/S1\.md.*Evidence/)
  })

  test('a code commit that names no task fails the commits check, each commit against its own tree', () => {
    const r = setup({ tasks: [['S1', 'Bake bread']] })
    r.git('checkout', '-q', '-b', 'lane-a')
    commit(r, { 'src/a.js': '1\n' }, 'feat: a')
    commit(r, task('S1', 'Bake bread', { status: 'doing', lane: 'lane-a' }), 'chore: claim S1')
    commit(r, { 'src/b.js': '1\n' }, 'feat: b', 'Task: S1')
    const result = ci(r, 'pull_request', pullRequest(r, 'lane-a'))
    failed(result, /✖ commits: 1 problem; 3 commits/)
    assert.match(result.out, /"feat: a" changes code but names no task/)
  })

  test('the lane rule uses the head branch: a commit naming a task another lane held fails', () => {
    const r = setup({ tasks: [['S1', 'Bake bread', { status: 'doing', lane: 'other' }]] })
    r.git('checkout', '-q', '-b', 'lane-a')
    commit(r, { 'src/a.js': '1\n' }, 'feat: a', 'Task: S1')
    failed(ci(r, 'pull_request', pullRequest(r, 'lane-a')), /names task S1, which is held by lane "other" before this range, not by "lane-a"/)
  })

  test("changing another lane's task fails unless the head records a takeover", () => {
    const r = setup({ tasks: [['S1', 'Bake bread', { status: 'doing', lane: 'other' }]] })
    r.git('checkout', '-q', '-b', 'lane-a')
    commit(r, task('S1', 'Bake bread', { status: 'doing', lane: 'other', note: 'An edit.' }), 'docs: S1 note')
    failed(ci(r, 'pull_request', pullRequest(r, 'lane-a')), /✖ ownership: 1 problem.*\n {2}ledger\/tasks\/S1\.md: task S1 is held by lane "other" \(Status: doing\).*claim S1 --take/)
    commit(r, task('S1', 'Bake bread', { status: 'doing', lane: 'lane-a', takenOver: 'other at abc1234' }), 'chore: take S1', 'Task: S1')
    passed(ci(r, 'pull_request', pullRequest(r, 'lane-a')))
  })

  test('a task claimed on the base after the merge base is held there: claiming it again fails', () => {
    const r = setup({ tasks: [['S1', 'Bake bread']] })
    r.git('checkout', '-q', '-b', 'lane-a')
    commit(r, task('S1', 'Bake bread', { status: 'doing', lane: 'lane-a' }), 'chore: claim S1', 'Task: S1')
    r.git('checkout', '-q', 'main')
    commit(r, task('S1', 'Bake bread', { status: 'doing', lane: 'lane-b' }), 'chore: claim S1', 'Task: S1')
    failed(ci(r, 'pull_request', pullRequest(r, 'lane-a')), /task S1 is held by lane "lane-b"/)
  })

  test('a lane that merged the base in passes with the base version of a held task', () => {
    const r = setup({ tasks: [['S1', 'Bake bread'], ['S2', 'Buy flour']] })
    r.git('checkout', '-q', '-b', 'lane-a')
    commit(r, task('S1', 'Bake bread', { status: 'doing', lane: 'lane-a' }), 'chore: claim S1', 'Task: S1')
    r.git('checkout', '-q', 'main')
    commit(r, { 'notes.md': 'Notes.\n' }, 'docs: notes')
    r.git('checkout', '-q', '-b', 'lane-b', 'main~1')
    commit(r, task('S2', 'Buy flour', { status: 'doing', lane: 'lane-b' }), 'chore: claim S2', 'Task: S2')
    r.git('checkout', '-q', 'main')
    assert.equal(r.git('merge', '-q', '--no-ff', '-m', 'Merge lane-b', 'lane-b').status, 0)
    r.git('checkout', '-q', 'lane-a')
    assert.equal(r.git('merge', '-q', '--no-ff', '-m', 'Merge main', 'main').status, 0)
    passed(ci(r, 'pull_request', pullRequest(r, 'lane-a')))
  })

  test('deleting a task that exists at the merge base fails; renaming its id is a deletion', () => {
    const r = setup({ tasks: [['S1', 'Bake bread'], ['S2', 'Buy flour']] })
    r.git('checkout', '-q', '-b', 'lane-a')
    r.git('rm', '-q', 'ledger/tasks/S1.md')
    commit(r, task('S3', 'Bake bread'), 'docs: renumber S1')
    failed(ci(r, 'pull_request', pullRequest(r, 'lane-a')), /ledger\/tasks\/S1\.md: task S1 is deleted or its id renamed, but it exists on main/)
  })

  test('a new id that the base or another branch has in another file fails; the same file does not', () => {
    const r = setup({ tasks: [['S1', 'Bake bread']] })
    r.git('checkout', '-q', '-b', 'lane-b')
    commit(r, { 'ledger/tasks/S5-sell-cakes.md': taskFile('S5', 'Sell cakes') }, 'docs: add S5')
    r.git('checkout', '-q', 'main')
    commit(r, { 'ledger/tasks/S6-open-a-shop.md': taskFile('S6', 'Open a shop') }, 'docs: add S6')
    r.git('checkout', '-q', '-b', 'lane-a', 'main~1')
    commit(r, { 'ledger/tasks/S5-pay-rent.md': taskFile('S5', 'Pay rent'), 'ledger/tasks/S6-hire.md': taskFile('S6', 'Hire') }, 'docs: add S5 and S6')
    const result = ci(r, 'pull_request', pullRequest(r, 'lane-a'))
    failed(result, /✖ ids: 2 problems; 2 new ids, against 2 branches/)
    assert.match(result.out, /ledger\/tasks\/S5-pay-rent\.md: task S5 is new here, but branch "lane-b" already has S5 in ledger\/tasks\/S5-sell-cakes\.md\. Rename this task's file and id.*new" takes the next free number/)
    assert.match(result.out, /ledger\/tasks\/S6-hire\.md: task S6 is new here, but branch "main" already has S6 in ledger\/tasks\/S6-open-a-shop\.md/)

    // The same path is the same task, and a pull request's own branch never collides with itself.
    r.git('checkout', '-q', '-b', 'lane-c', 'main')
    r.git('branch', '-q', '-D', 'lane-a')
    r.git('checkout', '-q', 'lane-b', '--', 'ledger/tasks/S5-sell-cakes.md')
    commit(r, {}, 'docs: S5 too')
    passed(ci(r, 'pull_request', pullRequest(r, 'lane-c')))
  })

  test('a remote-tracking branch counts, except the pull request branch itself', () => {
    const r = setup({ tasks: [['S1', 'Bake bread']] })
    r.remote()
    r.push('main')
    r.git('checkout', '-q', '-b', 'lane-b')
    commit(r, { 'ledger/tasks/S5-sell-cakes.md': taskFile('S5', 'Sell cakes') }, 'docs: add S5')
    r.push('lane-b')
    r.git('checkout', '-q', 'main')
    r.git('branch', '-q', '-D', 'lane-b')
    r.git('checkout', '-q', '-b', 'lane-a')
    commit(r, { 'ledger/tasks/S5-pay-rent.md': taskFile('S5', 'Pay rent') }, 'docs: add S5')
    r.push('lane-a')
    const result = ci(r, 'pull_request', pullRequest(r, 'lane-a'))
    failed(result, /branch "origin\/lane-b" already has S5/)
    // origin/lane-a is the pull request's own branch, even after a later rename of its task.
    r.git('rm', '-q', 'ledger/tasks/S5-pay-rent.md')
    commit(r, { 'ledger/tasks/S7-pay-rent.md': taskFile('S7', 'Pay rent') }, 'docs: S5 is S7')
    passed(ci(r, 'pull_request', pullRequest(r, 'lane-a')))
  })

  test('the gates run with the base commands, and a head that removes a gate is still judged by it', () => {
    const r = setup({ config: { gates: { commit: ['node -e "process.exit(0)"'], verify: ['node -e "process.exit(Number(require(\'fs\').existsSync(\'broken\')))"'] } } })
    r.git('checkout', '-q', '-b', 'lane-a')
    commit(r, task('S1', 'Bake bread', { status: 'doing', lane: 'lane-a' }), 'chore: claim S1', 'Task: S1')
    commit(r, { 'src/a.js': '1\n' }, 'feat: a', 'Task: S1')
    const good = ci(r, 'pull_request', pullRequest(r, 'lane-a'))
    passed(good)
    assert.match(good.out, /✔ gates on [0-9a-f]{7}: node -e "process\.exit\(0\)" ✔ [\d.]+ s · node -e .* ✔ [\d.]+ s/)

    // The head breaks the code and removes the verify gate from its own configuration.
    commit(r, { broken: 'yes\n', '.resaledger.json': `${JSON.stringify({ version: 2, gates: { commit: ['node -e "process.exit(0)"'] } }, null, 2)}\n` }, 'chore: drop a gate', 'Task: S1')
    const bad = ci(r, 'pull_request', pullRequest(r, 'lane-a'))
    failed(bad, /✖ gates on [0-9a-f]{7}: .*✖/)
    assert.match(bad.out, /the gate "node -e .*existsSync.*" failed with 1 on [0-9a-f]{7}\. Fix the code; a gate is never weakened/)
  })

  test('the gates say when the working tree is not at the head', () => {
    const r = setup({ config: { gates: { commit: ['node -e "process.exit(0)"'] } } })
    r.git('checkout', '-q', '-b', 'lane-a')
    commit(r, { 'notes.md': 'Notes.\n' }, 'docs: notes')
    r.git('checkout', '-q', 'main')
    const result = ci(r, 'pull_request', pullRequest(r, 'lane-a'))
    passed(result)
    assert.match(result.out, /✔ gates on [0-9a-f]{7}: .* \(the working tree is at [0-9a-f]{7}, not at the head [0-9a-f]{7}\)/)
  })

  test('with ci.runGates false the head must carry a stamp for its own code', () => {
    const marker = join(temporary(), 'gate-ran').replace(/\\/g, '/')
    const gate = `node -e "require('fs').appendFileSync(process.argv[1], 'x')" "${marker}"`
    const r = setup({ config: { gates: { verify: [gate] }, ci: { runGates: false } } })
    r.git('checkout', '-q', '-b', 'lane-a')
    commit(r, task('S1', 'Bake bread', { status: 'doing', lane: 'lane-a' }), 'chore: claim S1', 'Task: S1')
    commit(r, { 'src/a.js': '1\n' }, 'feat: a', 'Task: S1')
    failed(ci(r, 'pull_request', pullRequest(r, 'lane-a')), /✖ gates: 1 problem; no stamp for the head \(ci\.runGates is false\)\n {2}ledger\/verified\/[0-9a-f]{16}\.json: the head [0-9a-f]{7} carries no stamp.*verify/)

    const verified = r.node(GUARD, 'verify')
    assert.equal(verified.status, 0, verified.out)
    commit(r, {}, 'docs: verify')
    const before = ci(r, 'pull_request', pullRequest(r, 'lane-a'))
    passed(before)
    assert.match(before.out, /✔ gates: the head carries its stamp ledger\/verified\/[0-9a-f]{16}\.json \(ci\.runGates is false\)/)
    // CI ran nothing: the one run is the verify above.
    assert.equal(readFileSync(marker, 'utf8'), 'x')
  })

  test('a pull request from a fork is checked the same way, with the fork branch as its lane', () => {
    const r = setup({ tasks: [['S1', 'Bake bread']] })
    // A branch of the same name in this repository is not the fork's branch.
    r.git('checkout', '-q', '-b', 'feature')
    commit(r, { 'ledger/tasks/S5-sell-cakes.md': taskFile('S5', 'Sell cakes') }, 'docs: add S5')
    r.git('checkout', '-q', '--detach', 'main')
    commit(r, task('S1', 'Bake bread', { status: 'doing', lane: 'feature' }), 'chore: claim S1', 'Task: S1')
    commit(r, { 'src/a.js': '1\n' }, 'feat: a', 'Task: S1')
    const head = rev(r)
    r.git('update-ref', 'refs/remotes/pull/7/head', head)
    r.git('checkout', '-q', 'main')
    const event = pullRequest(r, head, { fork: true, ref: 'feature' })
    const result = ci(r, 'pull_request', event)
    passed(result)
    assert.match(result.out, /pull request from "feature" \(a fork\)/)

    r.git('checkout', '-q', '--detach', head)
    commit(r, { 'ledger/tasks/S5-pay-rent.md': taskFile('S5', 'Pay rent') }, 'docs: add S5')
    const second = pullRequest(r, rev(r), { fork: true, ref: 'feature' })
    r.git('checkout', '-q', 'main')
    failed(ci(r, 'pull_request', second), /branch "feature" already has S5/)
  })

  test('stacked branches: a pull request from a lane built on another lane passes', () => {
    const r = setup({ tasks: [['S1', 'Bake bread'], ['S2', 'Buy flour']] })
    finishedLane(r, 'lane-a')
    r.git('checkout', '-q', '-b', 'lane-b')
    commit(r, task('S2', 'Buy flour', { status: 'doing', lane: 'lane-b' }), 'chore: claim S2', 'Task: S2')
    commit(r, { 'src/flour.js': '1\n' }, 'feat: flour', 'Task: S2')
    passed(ci(r, 'pull_request', pullRequest(r, 'lane-b')))
    passed(ci(r, 'pull_request', pullRequest(r, 'lane-b', { base: 'lane-a' })))
  })

  test('the first pull request that adds ResaLedger is judged by its own rules, and says so', () => {
    const r = repository()
    commit(r, { 'src/app.js': '1\n' }, 'feat: app')
    r.git('checkout', '-q', '-b', 'adopt')
    commit(
      r,
      { '.resaledger.json': '{ "version": 2 }\n', 'ledger/README.md': README, ...task('S1', 'Adopt ResaLedger') },
      'chore: adopt ResaLedger',
      'Task: maintenance'
    )
    const result = ci(r, 'pull_request', pullRequest(r, 'adopt'))
    passed(result)
    assert.match(result.out, /This change adds ResaLedger, so it is judged by its own rules, from the head [0-9a-f]{7}\./)
    // Its commits are still checked by those rules.
    commit(r, { 'src/app.js': '2\n' }, 'feat: change the app')
    failed(ci(r, 'pull_request', pullRequest(r, 'adopt')), /"feat: change the app" changes code but names no task/)
  })

  test('the --base, --head and --lane flags check a pull request without an event', () => {
    const r = setup({ tasks: [['S1', 'Bake bread'], ['S2', 'Buy flour']] })
    finishedLane(r)
    const result = run(r.root, process.execPath, [GUARD, 'ci', '--base', 'main', '--head', 'lane-a', '--lane', 'lane-a'])
    passed(result)
    assert.match(result.out, /pull request from "lane-a"/)
    const bare = run(r.root, process.execPath, [GUARD, 'ci', '--head', 'lane-a'])
    assert.equal(bare.status, 1)
    assert.match(bare.out, /ci needs both --base <rev> and --head <rev>/)
    const none = run(r.root, process.execPath, [GUARD, 'ci'])
    assert.equal(none.status, 1)
    assert.match(none.out, /no CI event found/)
  })
})

describe('ci on a push', () => {
  /** Commits on main with GitHub as the committer, as a squash merge does. */
  function squash(r, files, message) {
    for (const [path, text] of Object.entries(files)) r.write(path, text)
    r.git('add', '-A')
    const result = spawnSync('git', ['commit', '-q', '-m', message], { cwd: r.root, env: { ...ENV, GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: GITHUB }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }

  test('a push after a squash merge passes: GitHub committed it, with no trailer', () => {
    const r = setup({ tasks: [['S1', 'Bake bread']] })
    const before = rev(r)
    squash(r, { 'src/bread.js': '1\n', ...task('S1', 'Bake bread', { status: 'done', lane: 'lane-a' }) }, 'Bake bread (#1)')
    const result = ci(r, 'push', { before, after: rev(r), ref: 'refs/heads/main' })
    passed(result)
    assert.match(result.out, /push to refs\/heads\/main, [0-9a-f]{7}\.\.[0-9a-f]{7}/)
    assert.match(result.out, /✔ commits: 1 commit pushed/)
    assert.match(result.out, /S1 Bake bread: todo → done/)
    assert.doesNotMatch(result.out, /ownership|ids|gates/)
  })

  test('a direct code commit without a trailer fails, and the push names no lane', () => {
    const r = setup({ tasks: [['S1', 'Bake bread', { status: 'doing', lane: 'lane-a' }]] })
    const before = rev(r)
    commit(r, { 'src/a.js': '1\n' }, 'feat: a')
    commit(r, { 'src/b.js': '1\n' }, 'feat: b', 'Task: S1')
    const result = ci(r, 'push', { before, after: rev(r), ref: 'refs/heads/main' })
    failed(result, /✖ commits: 1 problem; 2 commits pushed/)
    assert.match(result.out, /"feat: a" changes code but names no task/)
  })

  test('a push after a merge commit passes; the merged commits were checked in their pull request', () => {
    const r = setup({ tasks: [['S1', 'Bake bread'], ['S2', 'Buy flour']] })
    const before = rev(r)
    finishedLane(r)
    r.git('checkout', '-q', 'main')
    assert.equal(r.git('merge', '-q', '--no-ff', '-m', 'Merge pull request #2 from team/lane-a', 'lane-a').status, 0)
    const result = ci(r, 'push', { before, after: rev(r), ref: 'refs/heads/main' })
    passed(result)
    assert.match(result.out, /✔ commits: 4 commits pushed/)
  })

  test('invalid records at the pushed commit fail', () => {
    const r = setup()
    const before = rev(r)
    commit(r, { 'ledger/tasks/S1.md': '# S1 Bake bread\n\n- Status: baking\n' }, 'docs: S1')
    failed(ci(r, 'push', { before, after: rev(r), ref: 'refs/heads/main' }), /✖ records: 1 problem/)
  })

  test('a new branch is checked for its records only', () => {
    const r = setup()
    commit(r, { 'src/a.js': '1\n' }, 'feat: a')
    const result = ci(r, 'push', { before: ZERO, after: rev(r), ref: 'refs/heads/lane-a' })
    passed(result)
    assert.match(result.out, /✔ commits: not checked \(a new branch: its commits are checked in their pull request\)/)
  })

  test('a forced push checks the commits since the merge base of before and after', () => {
    const r = setup({ tasks: [['S1', 'Bake bread', { status: 'doing', lane: 'lane-a' }]] })
    const start = rev(r)
    commit(r, { 'src/a.js': '1\n' }, 'feat: a, unrecorded')
    const before = rev(r)
    r.git('reset', '-q', '--hard', start)
    commit(r, { 'src/a.js': '2\n' }, 'feat: a', 'Task: S1')
    const result = ci(r, 'push', { before, after: rev(r), ref: 'refs/heads/main', forced: true })
    passed(result)
    assert.match(result.out, /✔ commits: 1 commit pushed/)
  })
})

describe('ci without the history it needs', () => {
  test('a shallow clone fails and says to fetch the full history', () => {
    const r = setup({ tasks: [['S1', 'Bake bread'], ['S2', 'Buy flour']] })
    finishedLane(r)
    const event = pullRequest(r, 'lane-a')
    const clone = join(temporary(), 'shallow')
    const cloned = run(r.base, 'git', ['clone', '-q', '--depth', '1', '--branch', 'lane-a', `file://${r.root.replace(/\\/g, '/')}`, clone])
    assert.equal(cloned.status, 0, cloned.out)
    const result = ci({ root: clone }, 'pull_request', event)
    assert.equal(result.status, 1, result.out)
    assert.match(result.out, /not in this clone, which is shallow\. Fetch the full history: .*"fetch-depth: 0"/)

    // Even with both commits present, a shallow clone cannot be trusted for the merge base.
    const fetched = run(clone, 'git', ['fetch', '-q', '--depth', '1', 'origin', 'main'])
    assert.equal(fetched.status, 0, fetched.out)
    const again = ci({ root: clone }, 'pull_request', event)
    assert.equal(again.status, 1, again.out)
    assert.match(again.out, /this clone is shallow.*fetch-depth: 0/)
  })

  test('a missing commit fails with the same advice', () => {
    const r = setup()
    const result = ci(r, 'push', { before: 'a'.repeat(40), after: rev(r), ref: 'refs/heads/main' })
    assert.equal(result.status, 1, result.out)
    assert.match(result.out, /commit a{40} is not in this clone\. Fetch the full history/)
  })

  test('an event ci does not check is refused', () => {
    const r = setup()
    const result = ci(r, 'issues', {})
    assert.equal(result.status, 1)
    assert.match(result.out, /the issues event is not one ci checks/)
  })
})
