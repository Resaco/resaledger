// task and new: reading one task with its plan section, and creating tasks, decisions and log
// entries with safe ids and names, in real repositories through the bundled guard. Ids taken in
// another worktree, on another local branch and on a remote-tracking branch all count.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { nextChildId, nextTaskId } from '../src/guard/create.mjs'
import { ENV, PACKAGE, repository, run, temporary } from './helpers.mjs'

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

/** Today's date in local time, as the guard writes it. */
function today() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** A todo task file. */
function taskFile(id, title, extra = '') {
  return `# ${id} ${title}\n\n- Status: todo\n${extra}`
}

/** A repository with the bundled guard, a configuration, a README and task files ([path, text]), committed. */
function workspace(tasks = []) {
  const r = repository()
  r.write('ledger/scripts/records.mjs', readFileSync(GUARD, 'utf8'))
  r.write('.resaledger.json', `${JSON.stringify({ version: 2 }, null, 2)}\n`)
  r.write('ledger/README.md', README)
  for (const [path, text] of tasks) r.write(path, text)
  const committed = r.commit('chore: start')
  if (committed.status !== 0) throw new Error(`commit failed: ${committed.out}`)
  return r
}

function guard(r, ...args) {
  return r.node('ledger/scripts/records.mjs', ...args)
}

/** Runs new and returns the created path from its first line. */
function created(r, ...args) {
  const result = guard(r, 'new', ...args)
  assert.equal(result.status, 0, result.out)
  const match = /^✔ created (\S+)$/m.exec(result.out)
  assert.ok(match, result.out)
  return match[1]
}

function checks(r) {
  const result = guard(r, 'check')
  assert.equal(result.status, 0, result.out)
}

describe('ids', () => {
  test('the next id skips gaps and ignores other prefixes and children', () => {
    assert.equal(nextTaskId('S', []), 'S1')
    assert.equal(nextTaskId('S', ['S1', 'S3', 'API7', 'S2.9']), 'S4')
    assert.equal(nextTaskId('S', ['SA9', 'S10.1']), 'S11')
    assert.equal(nextChildId('S4', ['S4', 'S5.1', 'S44.2']), 'S4.1')
    assert.equal(nextChildId('S4', ['S4.1', 'S4.3', 'S4.3.7']), 'S4.4')
    assert.equal(nextChildId('S4.1', ['S4.1', 'S4.1.1']), 'S4.1.2')
  })

  test('no tasks yet: T1 by default, and the prefix given', () => {
    const r = workspace()
    assert.equal(created(r, 'Set up the project'), 'ledger/tasks/T1-set-up-the-project.md')
    assert.equal(created(r, 'API', 'List the orders'), 'ledger/tasks/API1-list-the-orders.md')
    checks(r)
  })

  test('a gap in the numbers is not reused', () => {
    const r = workspace([
      ['ledger/tasks/S1.md', taskFile('S1', 'One')],
      ['ledger/tasks/S3-three.md', taskFile('S3', 'Three')]
    ])
    const result = guard(r, 'new', 'S', 'Sell cakes')
    assert.equal(result.status, 0, result.out)
    assert.equal(
      result.out,
      `✔ created ledger/tasks/S4-sell-cakes.md
Next: write its goal and checks under "## Plan", or link "- Plan:" to a plan section; then node ledger/scripts/records.mjs claim S4
`
    )
    assert.equal(r.read('ledger/tasks/S4-sell-cakes.md'), '# S4 Sell cakes\n\n- Status: todo\n')
    checks(r)
  })

  test('--under makes the next child, and a child of a child', () => {
    const r = workspace([['ledger/tasks/S4.md', taskFile('S4', 'Store the orders')]])
    assert.equal(created(r, 'Fix the upload', '--under', 'S4'), 'ledger/tasks/S4.1-fix-the-upload.md')
    assert.equal(created(r, 'Fix the download', '--under', 'S4'), 'ledger/tasks/S4.2-fix-the-download.md')
    assert.equal(created(r, 'Retry once', '--under', 'S4.1'), 'ledger/tasks/S4.1.1-retry-once.md')
    assert.equal(created(r, 'S', 'Next one'), 'ledger/tasks/S5-next-one.md')
    checks(r)
    const missing = guard(r, 'new', 'Orphan', '--under', 'S9')
    assert.equal(missing.status, 1)
    assert.match(missing.out, /✖ there is no task S9 in ledger\/tasks/)
    const both = guard(r, 'new', 'S', 'Orphan', '--under', 'S4')
    assert.equal(both.status, 1)
    assert.match(both.out, /--under takes the prefix from its parent/)
  })

  test('an id taken in another worktree, on another local branch or on a remote-tracking branch counts', () => {
    const r = workspace([['ledger/tasks/S1.md', taskFile('S1', 'One')]])
    // Another worktree, with an uncommitted task.
    const other = r.worktree('other')
    other.write('ledger/tasks/S5-cakes.md', taskFile('S5', 'Cakes'))
    assert.equal(created(r, 'S', 'After the worktree'), 'ledger/tasks/S6-after-the-worktree.md')
    // A local branch with no worktree.
    r.git('branch', 'lane-b')
    const b = r.worktree('b-tree', 'lane-b-work')
    b.git('checkout', '-q', 'lane-b')
    b.write('ledger/tasks/S8.md', taskFile('S8', 'Eight'))
    assert.equal(b.commit('docs: S8').status, 0)
    assert.equal(r.git('worktree', 'remove', '--force', b.root).status, 0)
    assert.equal(created(r, 'S', 'After the branch'), 'ledger/tasks/S9-after-the-branch.md')
    // A remote-tracking branch.
    r.remote()
    r.commit('docs: S6 and S9')
    r.push('main')
    const clone = join(r.base, 'clone')
    assert.equal(run(r.base, 'git', ['clone', '-q', join(r.base, 'remote.git'), clone]).status, 0)
    run(clone, 'git', ['checkout', '-q', '-b', 'lane-c'])
    writeFileSync(join(clone, 'ledger/tasks/S12.md'), taskFile('S12', 'Twelve'))
    run(clone, 'git', ['add', '-A'])
    assert.equal(run(clone, 'git', ['commit', '-q', '-m', 'docs: S12']).status, 0)
    assert.equal(run(clone, 'git', ['push', '-q', 'origin', 'lane-c']).status, 0)
    assert.equal(created(r, 'S', 'Before the fetch'), 'ledger/tasks/S10-before-the-fetch.md')
    r.fetch()
    assert.equal(created(r, 'S', 'After the fetch'), 'ledger/tasks/S13-after-the-fetch.md')
  })

  test('an invalid prefix, an empty title and a stray argument are refused', () => {
    const r = workspace()
    for (const [args, message] of [
      [['s', 'Lowercase'], /"s" is not a prefix/],
      [['ABCDE', 'Too long'], /"ABCDE" is not a prefix/],
      [['S1', 'With a number'], /"S1" is not a prefix/],
      [['S', '   '], /the title is empty/],
      [[], /the title is empty/],
      [['S', 'Two', 'words'], /put the title in quotes/],
      [['S', 'x'.repeat(101)], /the title has 101 characters/],
      [['decision', ''], /the title is empty: write new decision/]
    ]) {
      const result = guard(r, 'new', ...args)
      assert.equal(result.status, 1, `${args.join(' ')}: ${result.out}`)
      assert.match(result.out, message)
    }
    assert.deepEqual(readdirSync(join(r.root, 'ledger')).sort(), ['README.md', 'scripts'])
  })
})

describe('slugs', () => {
  test('non-ASCII and long titles make short ASCII slugs, or none', () => {
    const r = workspace()
    assert.equal(created(r, 'S', 'Größe ändern: Æble på smørrebrød'), 'ledger/tasks/S1-grosse-andern-aeble-pa-smorrebrod.md')
    assert.equal(
      created(r, 'S', 'Store the projects and the documents on the server, with paging'),
      'ledger/tasks/S2-store-the-projects-and-the-documents-on.md'
    )
    assert.equal(created(r, 'S', '日本語のタイトル'), 'ledger/tasks/S3.md')
    assert.equal(r.read('ledger/tasks/S3.md'), '# S3 日本語のタイトル\n\n- Status: todo\n')
    checks(r)
  })

  test('the same title twice gives two tasks, decisions and log entries', () => {
    const r = workspace()
    assert.equal(created(r, 'S', 'Same title'), 'ledger/tasks/S1-same-title.md')
    assert.equal(created(r, 'S', 'Same title'), 'ledger/tasks/S2-same-title.md')
    const date = today()
    assert.equal(created(r, 'decision', 'Bullets, not YAML'), `ledger/decisions/${date}-bullets-not-yaml.md`)
    assert.equal(created(r, 'decision', 'Bullets, not YAML'), `ledger/decisions/${date}-bullets-not-yaml-2.md`)
    assert.equal(created(r, 'decision', 'Bullets not YAML'), `ledger/decisions/${date}-bullets-not-yaml-3.md`)
    assert.equal(created(r, 'log', 'Storage routes'), `ledger/log/${date}-storage-routes.md`)
    assert.equal(created(r, 'log', 'Storage routes'), `ledger/log/${date}-storage-routes-2.md`)
    assert.equal(created(r, 'log', 'ルート'), `ledger/log/${date}-entry.md`)
    checks(r)
  })

  test('a dated name taken on another branch or in another worktree is not used', () => {
    const r = workspace()
    const date = today()
    const other = r.worktree('other')
    other.write(`ledger/log/${date}-storage.md`, `# ${date} · Storage\n`)
    assert.equal(created(r, 'log', 'Storage'), `ledger/log/${date}-storage-2.md`)
    r.git('branch', 'lane-b')
    const b = r.worktree('b-tree', 'lane-b-work')
    b.git('checkout', '-q', 'lane-b')
    b.write(`ledger/decisions/${date}-paging.md`, `# Paging\n`)
    assert.equal(b.commit('docs: a decision').status, 0)
    assert.equal(created(r, 'decision', 'Paging'), `ledger/decisions/${date}-paging-2.md`)
    checks(r)
  })
})

describe('records', () => {
  test('a decision and a log entry pass check, with the author and this lane filled in', () => {
    const r = workspace([['ledger/tasks/S1.md', '# S1 Store the orders\n\n- Status: doing\n- Lane: main\n\n## Plan\n\nStore them.\n']])
    r.git('config', 'user.name', 'Ada Example')
    const date = today()
    const decision = created(r, 'decision', 'Task fields are bullets')
    assert.equal(r.read(decision), `# Task fields are bullets\n\n- Date: ${date}\n- Decided by: Ada Example\n- Status: accepted\n\n`)
    const log = created(r, 'log', 'Storage routes, and why paging waits')
    assert.equal(r.read(log), `# ${date} · Storage routes, and why paging waits\n\n- Lane: main\n- Tasks: S1\n\n`)
    created(r, 'S', 'Another')
    checks(r)
  })

  test('without a user.name, Decided by is a placeholder that check reports', () => {
    const r = workspace()
    const env = { ...ENV }
    delete env.GIT_AUTHOR_NAME
    const result = spawnSync(process.execPath, ['ledger/scripts/records.mjs', 'new', 'decision', 'Paging'], { cwd: r.root, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Fill in "Decided by" too/)
    const check = guard(r, 'check')
    assert.equal(check.status, 1)
    assert.match(check.out, /a decision needs the person who decided/)
  })

  test('a file git does not track yet keeps its name and its content', () => {
    const r = workspace()
    const date = today()
    // A file git does not see yet, under the name a new decision would take, stays as it is.
    mkdirSync(join(r.root, 'ledger', 'decisions'), { recursive: true })
    writeFileSync(join(r.root, 'ledger', 'decisions', `${date}-paging.md`), 'mine\n')
    assert.equal(created(r, 'decision', 'Paging'), `ledger/decisions/${date}-paging-2.md`)
    assert.equal(r.read(`ledger/decisions/${date}-paging.md`), 'mine\n')
  })
})

describe('--issue', { skip: process.platform === 'win32' && 'the fake gh is a shell script' }, () => {
  const gitPath = run(PACKAGE, 'git', ['--exec-path']).out.trim()

  /** Runs new with a PATH of a folder holding a fake gh (or none) and git's own folder. */
  function withGh(r, script, ...args) {
    const bin = temporary('resaledger-bin-')
    if (script !== null) {
      writeFileSync(join(bin, 'gh'), `#!/bin/sh\n${script}\n`)
      chmodSync(join(bin, 'gh'), 0o755)
    }
    const env = { ...ENV, PATH: `${bin}:${gitPath}` }
    const result = spawnSync(process.execPath, ['ledger/scripts/records.mjs', 'new', ...args], { cwd: r.root, env, encoding: 'utf8' })
    return { status: result.status, out: `${result.stdout}${result.stderr}` }
  }

  test('takes the title from gh and records the issue', () => {
    const r = workspace()
    const result = withGh(r, `[ "$1 $2 $3 $4 $5" = "issue view 42 --json title" ] || exit 3\necho '{"title":"Crash on an empty cart"}'`, 'S', '--issue', '42')
    assert.equal(result.status, 0, result.out)
    assert.equal(r.read('ledger/tasks/S1-crash-on-an-empty-cart.md'), '# S1 Crash on an empty cart\n\n- Status: todo\n- Issue: #42\n')
    const titled = withGh(r, 'exit 1', '--issue', '#43', 'Given title')
    assert.equal(titled.status, 0, titled.out)
    assert.equal(r.read('ledger/tasks/T1-given-title.md'), '# T1 Given title\n\n- Status: todo\n- Issue: #43\n')
    checks(r)
  })

  test('without gh, or when gh fails, it asks for a title', () => {
    const r = workspace()
    for (const script of [null, 'echo "not logged in" >&2; exit 1']) {
      const result = withGh(r, script, '--issue', '7')
      assert.equal(result.status, 1, result.out)
      assert.match(result.out, /✖ could not read the title of issue #7 with gh: give it yourself, as in new --issue 7 "<title>"/)
    }
    assert.equal(existsSync(join(r.root, 'ledger', 'tasks')), false)
    const bad = withGh(r, null, '--issue', 'seven', 'Title')
    assert.equal(bad.status, 1)
    assert.match(bad.out, /"seven" is not an issue number/)
  })
})

describe('task', () => {
  const PLAN = `# S — Server

Status: approved · 2026-10-14 · Ada

### S4 Store projects and documents

Routes for projects and documents, with tests.

### S5 Something else

Not this one.
`

  test('prints the file and then the plan section it links to', () => {
    const r = workspace([
      ['ledger/plan/S-server.md', PLAN],
      ['ledger/tasks/S4-store.md', taskFile('S4', 'Store projects', '- Plan: [S-server.md](../plan/S-server.md#s4-store-projects-and-documents)\n')]
    ])
    const result = guard(r, 'task', 'S4')
    assert.equal(result.status, 0, result.out)
    assert.equal(
      result.out,
      `ledger/tasks/S4-store.md

# S4 Store projects

- Status: todo
- Plan: [S-server.md](../plan/S-server.md#s4-store-projects-and-documents)

ledger/plan/S-server.md#s4-store-projects-and-documents

### S4 Store projects and documents

Routes for projects and documents, with tests.
`
    )
  })

  test('a task with no plan prints just the file', () => {
    const r = workspace([['ledger/tasks/S1.md', taskFile('S1', 'One', '\n## Plan\n\nDo it.\n')]])
    const result = guard(r, 'task', 'S1')
    assert.equal(result.status, 0, result.out)
    assert.equal(result.out, 'ledger/tasks/S1.md\n\n# S1 One\n\n- Status: todo\n\n## Plan\n\nDo it.\n')
  })

  test('a missing task, an invalid id and a link that does not resolve give clear messages', () => {
    const r = workspace([
      ['ledger/plan/S-server.md', PLAN],
      ['ledger/tasks/S1.md', taskFile('S1', 'One', '- Plan: [S-server.md](../plan/S-server.md#no-such-section)\n')],
      ['ledger/tasks/S2.md', taskFile('S2', 'Two', '- Plan: [gone.md](../plan/gone.md#s2)\n')]
    ])
    const missing = guard(r, 'task', 'S9')
    assert.equal(missing.status, 1)
    assert.match(missing.out, /✖ there is no task S9 in ledger\/tasks/)
    const invalid = guard(r, 'task', 's9')
    assert.equal(invalid.status, 1)
    assert.match(invalid.out, /"s9" is not a task id/)
    const none = guard(r, 'task')
    assert.equal(none.status, 1)
    assert.match(none.out, /task needs an id/)
    const anchor = guard(r, 'task', 'S1')
    assert.equal(anchor.status, 1)
    assert.match(anchor.out, /^ledger\/tasks\/S1\.md\n\n# S1 One/)
    assert.match(anchor.out, /✖ the Plan link points to #no-such-section, which is not a section in ledger\/plan\/S-server\.md/)
    const file = guard(r, 'task', 'S2')
    assert.equal(file.status, 1)
    assert.match(file.out, /✖ the Plan link \.\.\/plan\/gone\.md#s2 points to ledger\/plan\/gone\.md, which does not exist/)
  })
})
