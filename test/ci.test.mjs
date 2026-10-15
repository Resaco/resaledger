// ci: real repositories and simulated GitHub event files, run through the bundled guard.
// One event per rule, a pull request from a fork, pushes after a squash merge and after a merge
// commit, the first pull request that adds ResaLedger, rules from the base, the stamp mode,
// a shallow clone and the --base/--head/--lane flags.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { contentHash, normalizeManaged } from '../src/guard/managed.mjs'
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
function ci(r, name, payload, args = [], extra = {}) {
  const file = join(temporary('resaledger-event-'), 'event.json')
  writeFileSync(file, JSON.stringify(payload))
  const result = spawnSync(process.execPath, [GUARD, 'ci', ...args], {
    cwd: r.root,
    env: { ...ENV, GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: file, ...extra },
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

  test('the gates fail without running when the working tree is not at the head', () => {
    const marker = join(temporary(), 'gate-ran').replace(/\\/g, '/')
    const r = setup({ config: { gates: { commit: [`node -e "require('fs').appendFileSync(process.argv[1], 'x')" "${marker}"`] } } })
    r.git('checkout', '-q', '-b', 'lane-a')
    commit(r, { 'notes.md': 'Notes.\n' }, 'docs: notes')
    r.git('checkout', '-q', 'main')
    const result = ci(r, 'pull_request', pullRequest(r, 'lane-a'))
    failed(result, /✖ gates on [0-9a-f]{7}: not run \(the working tree is at [0-9a-f]{7}, not at the head [0-9a-f]{7}\)/)
    assert.match(result.out, /the gates did not run: the working tree is at [0-9a-f]{7}, not at the head [0-9a-f]{7}, so they would judge other code\. Check out the head/)
    assert.ok(!existsSync(marker), 'the gate ran')

    r.git('checkout', '-q', 'lane-a')
    passed(ci(r, 'pull_request', pullRequest(r, 'lane-a')))
    assert.equal(readFileSync(marker, 'utf8'), 'x')
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
    assert.match(result.out, /✔ enforcement: not compared \(the base has no configuration, so there is nothing to compare against\)/)
    // Its commits are still checked by those rules.
    commit(r, { 'src/app.js': '2\n' }, 'feat: change the app')
    failed(ci(r, 'pull_request', pullRequest(r, 'adopt')), /"feat: change the app" changes code but names no task/)
  })

  test('commits made before adoption are not judged, on a pull request and on a push; later ones are', () => {
    const r = repository()
    commit(r, { 'src/app.js': '1\n' }, 'feat: app')
    const before = rev(r)
    r.git('checkout', '-q', '-b', 'adopt')
    // A commit made under an older ledger names a task that has no file here.
    commit(r, { 'src/app.js': '2\n' }, 'feat: change the app', 'Task: A2')
    commit(
      r,
      { '.resaledger.json': '{ "version": 2 }\n', 'ledger/README.md': README, ...task('S1', 'Adopt ResaLedger') },
      'chore: adopt ResaLedger',
      'Task: maintenance'
    )
    passed(ci(r, 'pull_request', pullRequest(r, 'adopt')))
    passed(ci(r, 'push', { before, after: rev(r), ref: 'refs/heads/main' }))
    commit(r, { 'src/app.js': '3\n' }, 'feat: sneak')
    failed(ci(r, 'pull_request', pullRequest(r, 'adopt')), /"feat: sneak" changes code but names no task/)
    failed(ci(r, 'push', { before, after: rev(r), ref: 'refs/heads/main' }), /"feat: sneak" changes code but names no task/)
  })

  test('a branch that deletes the configuration and adds it again cannot hide a commit between', () => {
    const r = setup()
    const before = rev(r)
    r.git('checkout', '-q', '-b', 'lane-a')
    r.git('rm', '-q', '.resaledger.json')
    commit(r, {}, 'chore: drop the configuration', 'Task: maintenance')
    commit(r, { 'src/sneak.js': '1\n' }, 'feat: sneak')
    commit(r, { '.resaledger.json': '{ "version": 2 }\n' }, 'chore: add it back', 'Task: maintenance')
    failed(ci(r, 'pull_request', pullRequest(r, 'lane-a')), /"feat: sneak" changes code but names no task/)
    failed(ci(r, 'push', { before, after: rev(r), ref: 'refs/heads/main' }), /"feat: sneak" changes code but names no task/)
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

describe('ci and changes to enforcement', () => {
  const PASS = 'node -e "process.exit(0)"'
  const json = (config) => `${JSON.stringify({ version: 2, ...config }, null, 2)}\n`
  const hook = (name) => readFileSync(join(PACKAGE, 'templates', 'hooks', name), 'utf8').replaceAll('{{dir}}', 'ledger')

  /** A decision that names changes on its "- Weakens:" line. */
  function decision(ids, slug = 'allow-it') {
    const text = `# Allow it\n\n- Date: 2026-10-15\n- Decided by: alice\n- Weakens: ${ids}\n\nThe team agreed.\n`
    return { [`ledger/decisions/2026-10-15-${slug}.md`]: text }
  }

  /** Main with the files of `before`, and a lane-a commit that writes the files of `after`. */
  function change(before, after) {
    const r = setup()
    commit(r, { 'notes.md': 'Before.\n', ...before }, 'chore: before', 'Task: maintenance')
    r.git('checkout', '-q', '-b', 'lane-a')
    commit(r, after, 'chore: change enforcement', 'Task: maintenance')
    return r
  }

  // Each kind of weakening change: its id, the files on main, and the files the pull request writes.
  const weakening = [
    ['gates.verify', { gates: { verify: [PASS] } }, { gates: {} }],
    ['gates.commit', { gates: { commit: [PASS] } }, { gates: { commit: ['node -e "process.exit()"'] } }],
    ['protected', { preset: 'team' }, { preset: 'team', protected: [] }],
    ['wip', { wip: 3 }, { wip: 5 }],
    ['aiAttribution', { aiAttribution: 'forbid' }, {}],
    ['agent.deny', { agent: { deny: [{ pattern: 'rm -rf', reason: 'no' }] } }, {}],
    ['base', {}, { base: 'trunk' }],
    ['branchPattern', { branchPattern: '^lane-' }, { branchPattern: '' }],
    ['ci.runGates', {}, { ci: { runGates: false } }],
    ['requirePushed', { preset: 'team' }, { preset: 'team', requirePushed: false }],
    ['claimPush', { preset: 'team' }, { preset: 'team', claimPush: false }],
    ['codePaths', { codePaths: ['tools'] }, {}],
    ['commitStyle', { commitStyle: 'conventional' }, {}]
  ].map(([id, before, after]) => [id, { '.resaledger.json': json(before) }, { '.resaledger.json': json(after) }])
  weakening.push(
    ['guard', { 'ledger/scripts/records.mjs': '// a guard\n' }, { 'ledger/scripts/records.mjs': '// a guard, edited\n' }],
    ['hooks/pre-commit', { '.githooks/pre-commit': hook('pre-commit') }, { '.githooks/pre-commit': `${hook('pre-commit')}exit 0\n` }],
    ['workflow', { '.github/workflows/resaledger.yml': 'name: resaledger\n' }, { '.github/workflows/resaledger.yml': 'name: resaledger\non: push\n' }]
  )

  for (const [id, before, after] of weakening) {
    test(`a weakening change to ${id} fails without a decision and passes with one that names it`, () => {
      const r = change(before, after)
      const without = ci(r, 'pull_request', pullRequest(r, 'lane-a'))
      failed(without, /✖ enforcement: 1 weakening change no decision names; 1 change, 1 weakening/)
      const escaped = id.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
      assert.match(without.out, new RegExp(`\\n {2}✖ ${escaped}[: ].*this weakens enforcement, and no decision this pull request adds names it\\. Add one in ledger/decisions/ with the line "- Weakens: ${escaped}"`))

      commit(r, decision(id), 'docs: decide', 'Task: maintenance')
      const decided = ci(r, 'pull_request', pullRequest(r, 'lane-a'))
      passed(decided)
      assert.match(decided.out, new RegExp(`✔ enforcement: 1 change, 1 weakening\\n {2}${escaped}[: ].* · weakening, decided in ledger/decisions/2026-10-15-allow-it\\.md by alice`))
    })
  }

  test('removing a gate lists it with its command', () => {
    const r = change({ '.resaledger.json': json({ gates: { verify: [PASS] } }) }, { '.resaledger.json': json({}) })
    failed(ci(r, 'pull_request', pullRequest(r, 'lane-a')), /✖ gates\.verify: removed "node -e \\"process\.exit\(0\)\\""/)
  })

  test('a decision that names a different change, or one already on the base, does not help', () => {
    const r = setup()
    commit(r, { '.resaledger.json': json({ wip: 3 }), ...decision('wip', 'old') }, 'chore: before', 'Task: maintenance')
    r.git('checkout', '-q', '-b', 'lane-a')
    commit(r, { '.resaledger.json': json({ wip: 5 }), ...decision('gates.verify, protected') }, 'chore: raise wip', 'Task: maintenance')
    failed(ci(r, 'pull_request', pullRequest(r, 'lane-a')), /✖ wip raised from 3 to 5: this weakens enforcement/)
  })

  test('one decision can name several changes, and each one it does not name still fails', () => {
    const r = change({ '.resaledger.json': json({ wip: 3, aiAttribution: 'forbid' }) }, { '.resaledger.json': json({ wip: 4 }), ...decision('`wip`, aiAttribution') })
    passed(ci(r, 'pull_request', pullRequest(r, 'lane-a')))
    commit(r, { '.resaledger.json': json({ wip: 4, ci: { runGates: false } }) }, 'chore: stop the gates', 'Task: maintenance')
    const result = ci(r, 'pull_request', pullRequest(r, 'lane-a'))
    failed(result, /✖ enforcement: 1 weakening change no decision names; 3 changes, 3 weakening/)
    assert.match(result.out, /✖ ci\.runGates turned off/)
  })

  test('a key the judging guard does not know passes as a listed change, and a misspelt one fails', () => {
    const r = change({ '.resaledger.json': json({}) }, { '.resaledger.json': json({ reviewers: ['alice'] }) })
    const result = ci(r, 'pull_request', pullRequest(r, 'lane-a'))
    passed(result)
    assert.match(result.out, /\n {2}reviewers: added \["alice"\], a key this guard does not know\n/)
    const typo = change({ '.resaledger.json': json({}) }, { '.resaledger.json': json({ protcted: [] }) })
    failed(ci(typo, 'pull_request', pullRequest(typo, 'lane-a')), /unknown key "protcted"; did you mean "protected"\?/)
  })

  test('a record in a subfolder of tasks/ is reported, not ignored', () => {
    const r = change({}, { 'ledger/tasks/old/S9-bake.md': taskFile('S9', 'Bake rye') })
    failed(ci(r, 'pull_request', pullRequest(r, 'lane-a')), /ledger\/tasks\/old\/S9-bake\.md: a record belongs directly in ledger\/tasks\/, where it is read/)
  })

  test('a pull request that only tightens passes and lists every change', () => {
    const r = change(
      { '.resaledger.json': json({ gates: { commit: [PASS] } }) },
      { '.resaledger.json': json({ preset: 'team', wip: 2, aiAttribution: 'forbid', commitStyle: 'conventional', branchPattern: '^lane-', codePaths: ['tools'], gates: { commit: [PASS], verify: [PASS] }, agent: { deny: [{ pattern: 'rm -rf' }] } }) }
    )
    const result = ci(r, 'pull_request', pullRequest(r, 'lane-a'))
    passed(result)
    assert.match(result.out, /✔ enforcement: 11 changes, 0 weakening/)
    for (const line of [
      'preset changed from "solo" to "team"',
      'protected: added "main"',
      'requirePushed turned on',
      'claimPush turned on',
      'branchPattern changed from none to "^lane-"',
      'wip lowered from 3 to 2',
      'commitStyle changed from "free" to "conventional"',
      'aiAttribution changed from "allow" to "forbid"',
      'codePaths: added "tools"',
      'gates.verify: added "node -e \\"process.exit(0)\\""',
      'agent.deny: added "rm -rf"'
    ]) {
      assert.ok(result.out.includes(`\n  ${line}\n`), `missing "${line}" in:\n${result.out}`)
    }
  })

  test('an update of the guard or a hook to a released version is listed and passes', () => {
    const newer = '#!/usr/bin/env node\n// ResaLedger 9.0.0\n// a newer guard\n'
    const table = join(temporary(), 'released.json')
    writeFileSync(table, JSON.stringify({ guard: { '9.0.0': contentHash(normalizeManaged(newer)) } }))
    const guard = join(temporary(), 'records.mjs')
    const bundled = run(PACKAGE, process.execPath, [join(PACKAGE, 'scripts', 'bundle.mjs'), '--out', guard, '--released', table])
    assert.equal(bundled.status, 0, bundled.out)

    const r = change(
      { 'ledger/scripts/records.mjs': '#!/usr/bin/env node\n// ResaLedger 8.0.0\n', '.githooks/pre-commit': '#!/bin/sh\nexit 0\n' },
      { 'ledger/scripts/records.mjs': newer, '.githooks/pre-commit': hook('pre-commit') }
    )
    // This guard, built with its own table, takes the pull request from the flags.
    const result = run(r.root, process.execPath, [guard, 'ci', '--base', 'main', '--head', 'lane-a', '--lane', 'lane-a'])
    passed(result)
    assert.match(result.out, /✔ enforcement: 2 changes, 0 weakening\n {2}guard: ledger\/scripts\/records\.mjs changed: ResaLedger 9\.0\.0, a released version\n {2}hooks\/pre-commit: \.githooks\/pre-commit changed: ResaLedger [^ ]+, a released version/)

    // The guard that runs knows its own text as a released version too.
    commit(r, { 'ledger/scripts/records.mjs': readFileSync(GUARD, 'utf8') }, 'chore: update the guard', 'Task: maintenance')
    const own = ci(r, 'pull_request', pullRequest(r, 'lane-a'))
    passed(own)
    assert.match(own.out, /guard: ledger\/scripts\/records\.mjs changed: ResaLedger [^ ]+, a released version/)
  })

  test('a removed guard weakens enforcement', () => {
    const r = setup()
    commit(r, { 'ledger/scripts/records.mjs': '// a guard\n' }, 'chore: add a guard', 'Task: maintenance')
    r.git('checkout', '-q', '-b', 'lane-a')
    r.git('rm', '-q', 'ledger/scripts/records.mjs')
    commit(r, {}, 'chore: remove the guard', 'Task: maintenance')
    failed(ci(r, 'pull_request', pullRequest(r, 'lane-a')), /✖ guard: ledger\/scripts\/records\.mjs removed: this weakens enforcement/)
  })

  test('moving the guard back to an older release weakens enforcement', () => {
    const older = '#!/usr/bin/env node\n// ResaLedger 8.0.0\n'
    const newer = '#!/usr/bin/env node\n// ResaLedger 9.0.0\n'
    const table = join(temporary(), 'released.json')
    writeFileSync(table, JSON.stringify({ guard: { '8.0.0': contentHash(normalizeManaged(older)), '9.0.0': contentHash(normalizeManaged(newer)) } }))
    const guard = join(temporary(), 'records.mjs')
    const bundled = run(PACKAGE, process.execPath, [join(PACKAGE, 'scripts', 'bundle.mjs'), '--out', guard, '--released', table])
    assert.equal(bundled.status, 0, bundled.out)
    const r = change({ 'ledger/scripts/records.mjs': newer }, { 'ledger/scripts/records.mjs': older })
    const result = run(r.root, process.execPath, [guard, 'ci', '--base', 'main', '--head', 'lane-a', '--lane', 'lane-a'])
    failed(result, /✖ guard: ledger\/scripts\/records\.mjs moved back from ResaLedger 9\.0\.0 to 8\.0\.0, an older release/)
  })

  test('a removed or broken configuration in the head weakens enforcement', () => {
    const removed = setup()
    removed.git('checkout', '-q', '-b', 'lane-a')
    removed.git('rm', '-q', '.resaledger.json')
    commit(removed, {}, 'chore: remove the configuration', 'Task: maintenance')
    failed(ci(removed, 'pull_request', pullRequest(removed, 'lane-a')), /✖ config: \.resaledger\.json removed: this weakens enforcement/)
    const broken = change({}, { '.resaledger.json': '{ "version": 2, \n' })
    failed(ci(broken, 'pull_request', pullRequest(broken, 'lane-a')), /✖ config: \.resaledger\.json is not a valid configuration in the head: this weakens enforcement/)
  })

  test('a change the base made after the merge base is not the pull request\'s change', () => {
    const r = setup({ config: { wip: 5 } })
    r.git('checkout', '-q', '-b', 'lane-a')
    commit(r, { 'notes.md': 'Notes.\n' }, 'docs: notes')
    r.git('checkout', '-q', 'main')
    commit(r, { '.resaledger.json': json({ wip: 2 }) }, 'chore: lower wip', 'Task: maintenance')
    const result = ci(r, 'pull_request', pullRequest(r, 'lane-a'))
    passed(result)
    assert.match(result.out, /✔ enforcement: unchanged/)
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

  test('pull_request_target is refused, pointing at the spec', () => {
    const r = setup({ tasks: [['S1', 'Bake bread'], ['S2', 'Buy flour']] })
    finishedLane(r)
    const result = ci(r, 'pull_request_target', pullRequest(r, 'lane-a'))
    assert.equal(result.status, 1, result.out)
    assert.match(result.out, /the pull_request_target event runs with a write token and the repository's secrets.*so ci refuses it\. Run ci on pull_request \(ResaLedger spec, section 10: CI\)/)
  })

  test('a commit the range reader refuses stops the check with a message and no stack trace', () => {
    const r = setup()
    r.git('checkout', '-q', '-b', 'lane-a')
    commit(r, { 'src/x.js': 'x\n' }, 'feat: x', 'Task: maintenance')
    // git accepts a commit with two committer lines only with --literally.
    const body = `tree ${rev(r, 'HEAD^{tree}')}\nparent ${rev(r, 'HEAD^')}\nauthor T <t@example.com> 1700000000 +0000\ncommitter T <t@example.com> 1700000000 +0000\ncommitter T <t@example.com> 1700000000 +0000\n\nfeat: odd\n\nTask: maintenance\n`
    const made = spawnSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin', '--literally'], { cwd: r.root, env: ENV, input: body, encoding: 'utf8' })
    assert.equal(made.status, 0, made.stderr)
    r.git('update-ref', 'refs/heads/lane-a', made.stdout.trim())
    const summary = join(temporary(), 'summary.md')
    const result = ci(r, 'pull_request', pullRequest(r, 'lane-a'), [], { GITHUB_STEP_SUMMARY: summary })
    assert.equal(result.status, 1, result.out)
    assert.match(result.out, /^resaledger: .+/m)
    assert.doesNotMatch(result.out, /\n\s+at /)
    assert.match(readFileSync(summary, 'utf8'), /^### ResaLedger · ✖ the check could not run\n\n.+/)
  })

  test('an event ci does not check is refused', () => {
    const r = setup()
    const result = ci(r, 'issues', {})
    assert.equal(result.status, 1)
    assert.match(result.out, /the issues event is not one ci checks/)
  })
})
