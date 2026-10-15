// Task ids across branches: the batched scan of every branch's task files, the collision rule,
// pre-commit's id check through the bundled guard against a branch, a remote-tracking branch
// and another worktree, and the scan of 50 branches within a time budget.
import assert from 'node:assert/strict'
import { chmodSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { HOOK_NAMES, renderHook } from '../src/cli/hooks.mjs'
import { parseConfig } from '../src/guard/config.mjs'
import { branchTaskFiles, idCollisions } from '../src/guard/ids.mjs'
import { BUDGET, PACKAGE, repository, run, temporary } from './helpers.mjs'

const GUARD = join(temporary(), 'records.mjs')
const built = run(PACKAGE, process.execPath, [join(PACKAGE, 'scripts', 'bundle.mjs'), '--out', GUARD])
if (built.status !== 0) throw new Error(`bundle failed: ${built.out}`)

const CONFIG = parseConfig('{ "version": 2 }').config
const README = '# Shop\n\n## Goal\n\nA shop.\n\n## Environments\n\nLocal only.\n\n## Manual checks\n\nNone.\n'

function taskFile(id, title) {
  return `# ${id} ${title}\n\n- Status: todo\n`
}

function commit(r, files, message = 'docs: tasks') {
  for (const [path, text] of Object.entries(files)) r.write(path, text)
  const committed = r.commit(message)
  assert.equal(committed.status, 0, committed.out)
}

/** A repository with the hooks, the bundled guard and S1 on main, then the hooks turned on. */
function workspace() {
  const r = repository()
  for (const name of HOOK_NAMES) {
    r.write(`.githooks/${name}`, renderHook(name, 'ledger'))
    chmodSync(join(r.root, '.githooks', name), 0o755)
  }
  r.write('ledger/scripts/records.mjs', readFileSync(GUARD, 'utf8'))
  commit(r, { '.resaledger.json': '{ "version": 2 }\n', 'ledger/README.md': README, 'ledger/tasks/S1.md': taskFile('S1', 'Bake bread') }, 'chore: start')
  r.git('config', 'core.hooksPath', '.githooks')
  return r
}

function refused(result, pattern) {
  assert.notEqual(result.status, 0, result.out)
  assert.match(result.out, /✖ This commit is refused/)
  assert.match(result.out, pattern)
}

function passed(result) {
  assert.equal(result.status, 0, result.out)
  assert.doesNotMatch(result.out, /✖/)
}

describe('branchTaskFiles', () => {
  test('reads the ids of every local and remote-tracking branch from the file names', () => {
    const r = repository()
    commit(r, { 'ledger/tasks/S1.md': taskFile('S1', 'A'), 'ledger/tasks/S2-buy-flour.md': taskFile('S2', 'B'), 'ledger/tasks/notes.md': 'Notes.\n' })
    r.remote()
    r.push('main')
    r.git('remote', 'set-head', 'origin', 'main')
    r.git('checkout', '-q', '-b', 'lane')
    commit(r, { 'ledger/tasks/S3-sell.md': taskFile('S3', 'C') })
    r.git('checkout', '-q', '--orphan', 'empty')
    r.git('rm', '-rqf', '.')
    r.write('readme.txt', 'x\n')
    r.git('add', 'readme.txt')
    commit(r, {}, 'chore: empty')

    const branches = branchTaskFiles({ root: r.root, dir: 'ledger' })
    const byName = new Map(branches.map((entry) => [entry.branch, entry]))
    assert.deepEqual([...byName.keys()].sort(), ['empty', 'lane', 'main', 'origin/main'])
    assert.deepEqual(Object.fromEntries(byName.get('lane').files), {
      S1: 'ledger/tasks/S1.md',
      S2: 'ledger/tasks/S2-buy-flour.md',
      S3: 'ledger/tasks/S3-sell.md'
    })
    assert.deepEqual(byName.get('empty').files, new Map())
    assert.equal(byName.get('origin/main').ref, 'refs/remotes/origin/main')
    assert.equal(byName.get('main').commit, r.git('rev-parse', 'main').out.trim())

    const some = branchTaskFiles({ root: r.root, dir: 'ledger', exclude: ({ ref }) => ref.startsWith('refs/remotes/') })
    assert.deepEqual(some.map((entry) => entry.branch).sort(), ['empty', 'lane', 'main'])
  })
})

describe('idCollisions', () => {
  test('an added id that another branch has in another file collides; the same file does not', () => {
    const others = [
      { branch: 'lane-b', files: new Map([['S5', 'ledger/tasks/S5-sell.md']]) },
      { branch: 'lane-c', worktree: true, files: new Map([['S5', 'ledger/tasks/S5-pay.md'], ['S6', 'ledger/tasks/S6.md']]) },
      { branch: 'lane-d', files: new Map([['S5', 'ledger/tasks/S5-sell.md']]) }
    ]
    const problems = idCollisions(
      [
        { id: 'S5', file: 'ledger/tasks/S5-sell.md' },
        { id: 'S6', file: 'ledger/tasks/S6-hire.md' },
        { id: 'S7', file: 'ledger/tasks/S7.md' }
      ],
      others,
      CONFIG
    )
    assert.deepEqual(
      problems.map(({ file, line }) => [file, line]),
      [
        ['ledger/tasks/S5-sell.md', 0],
        ['ledger/tasks/S6-hire.md', 0]
      ]
    )
    assert.match(problems[0].message, /^task S5 is new here, but the worktree of branch "lane-c" already has S5 in ledger\/tasks\/S5-pay\.md\. Rename this task's file and id/)
    assert.match(problems[1].message, /"node ledger\/scripts\/records\.mjs new" takes the next free number$/)
  })
})

describe('pre-commit: new ids against the locally visible branches', () => {
  test('a local branch that has the id in another file refuses the commit; the same file passes', () => {
    const r = workspace()
    r.git('checkout', '-q', '-b', 'other')
    r.write('ledger/tasks/S5-sell-cakes.md', taskFile('S5', 'Sell cakes'))
    passed(r.commit('docs: S5'))
    r.git('checkout', '-q', '-b', 'mine', 'main')
    r.write('ledger/tasks/S5-pay-rent.md', taskFile('S5', 'Pay rent'))
    refused(r.commit('docs: S5'), /ledger\/tasks\/S5-pay-rent\.md: task S5 is new here, but branch "other" already has S5 in ledger\/tasks\/S5-sell-cakes\.md/)
    r.git('reset', '-q', '--hard')
    r.git('clean', '-qfd')
    r.write('ledger/tasks/S5-sell-cakes.md', taskFile('S5', 'Sell cakes'))
    passed(r.commit('docs: S5 too'))
  })

  test('a remote-tracking branch counts, but not this lane\'s own', () => {
    const r = workspace()
    r.remote()
    r.git('checkout', '-q', '-b', 'other')
    r.write('ledger/tasks/S5-sell-cakes.md', taskFile('S5', 'Sell cakes'))
    passed(r.commit('docs: S5'))
    r.push('other')
    r.git('checkout', '-q', 'main')
    r.git('branch', '-q', '-D', 'other')
    r.git('checkout', '-q', '-b', 'mine')
    r.write('ledger/tasks/S5-pay-rent.md', taskFile('S5', 'Pay rent'))
    refused(r.commit('docs: S5'), /branch "origin\/other" already has S5/)

    // This lane pushed S6 and renamed it since; its own pushed branch is no collision.
    r.git('reset', '-q', '--hard')
    r.git('clean', '-qfd')
    r.write('ledger/tasks/S6-old.md', taskFile('S6', 'Old'))
    passed(r.commit('docs: S6'))
    r.push('mine')
    r.git('rm', '-q', 'ledger/tasks/S6-old.md')
    passed(r.commit('docs: drop S6'))
    r.write('ledger/tasks/S6-new.md', taskFile('S6', 'New'))
    passed(r.commit('docs: S6 again'))
  })

  test('another worktree counts as it is on disk, with an uncommitted task', () => {
    const r = workspace()
    const other = r.worktree('other')
    other.write('ledger/tasks/S5-sell-cakes.md', taskFile('S5', 'Sell cakes'))
    r.git('checkout', '-q', '-b', 'mine')
    r.write('ledger/tasks/S5-pay-rent.md', taskFile('S5', 'Pay rent'))
    refused(r.commit('docs: S5'), /task S5 is new here, but the worktree of branch "other" already has S5 in ledger\/tasks\/S5-sell-cakes\.md/)
  })

  test('50 branches are scanned within the time budget, and a commit that adds a task stays fast', (t) => {
    const r = workspace()
    const base = r.git('rev-parse', 'HEAD').out.trim()
    // fast-import writes the 50 branches, 20 tasks each, in one process.
    let stream = ''
    for (let branch = 1; branch <= 50; branch += 1) {
      stream += `commit refs/heads/lane-${branch}\ncommitter Test <test@example.com> ${1700000000 + branch} +0000\ndata 6\ntasks\nfrom ${base}\n`
      for (let index = 1; index <= 20; index += 1) {
        const id = `L${branch}.${index}`
        const text = taskFile(id, 'A task')
        stream += `M 100644 inline ledger/tasks/${id}-a-task.md\ndata ${Buffer.byteLength(text)}\n${text}\n`
      }
    }
    const imported = run(r.root, 'git', ['fast-import', '--quiet', '--force'], stream)
    assert.equal(imported.status, 0, imported.out)

    const started = process.hrtime.bigint()
    const branches = branchTaskFiles({ root: r.root, dir: 'ledger' })
    const problems = idCollisions([{ id: 'L50.20', file: 'ledger/tasks/L50.20-other.md' }], branches, CONFIG)
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6
    assert.equal(branches.length, 51)
    assert.equal(branches.find((entry) => entry.branch === 'lane-7').files.size, 21)
    assert.equal(problems.length, 1)
    t.diagnostic(`branchTaskFiles: 51 branches in ${elapsed.toFixed(0)} ms`)
    assert.ok(elapsed < 1000 * BUDGET, `51 branches took ${Math.round(elapsed)} ms`)

    // The whole commit: pre-commit with the scan, and commit-msg, each in its own node process.
    r.git('checkout', '-q', '-b', 'mine')
    r.write('ledger/tasks/S2-new.md', taskFile('S2', 'New'))
    const before = process.hrtime.bigint()
    passed(r.commit('docs: S2'))
    const commitMs = Number(process.hrtime.bigint() - before) / 1e6
    t.diagnostic(`a commit that adds a task, with 51 other branches: ${commitMs.toFixed(0)} ms, including node start-up`)
    assert.ok(commitMs < 3000 * BUDGET, `the commit took ${Math.round(commitMs)} ms`)
  })
})
