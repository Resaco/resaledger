// The workspace: readers over the working tree, the index and a commit; loading and checking
// every record; what counts as code; the code fingerprint; and the check command through the bundle.
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { parseConfig } from '../src/guard/config.mjs'
import { recordCounts } from '../src/guard/util.mjs'
import { checkWorkspace, fingerprint, isCode, loadWorkspace, treeReader } from '../src/guard/workspace.mjs'
import { PACKAGE, repository, run, temporary } from './helpers.mjs'

const CONFIG = parseConfig('{ "version": 2 }').config

/** The files of a valid workspace: a README, three tasks, a plan, evidence, a decision and a log entry. */
const VALID = {
  '.resaledger.json': '{\n  "version": 2\n}\n',
  'src/app.js': 'export const answer = 42\n',
  'ledger/README.md': '# Project\n\n## Goal\n\nA small app.\n\n## Environments\n\nLocal only.\n\n## Manual checks\n\nNone.\n',
  'ledger/plan/S-server.md': '# S — Server\n\nStatus: approved · 2026-10-14 · by the owner\n\n## S1 Start\n\nGoal: start.\n\n## S2 Store\n\nGoal: store.\n\n## S3 Serve\n\nGoal: serve.\n',
  'ledger/evidence/s1/output.txt': '14 of 14\n',
  'ledger/tasks/S1-start.md':
    '# S1 Start\n\n- Status: done\n- Plan: [S-server.md](../plan/S-server.md#s1-start)\n- Evidence: `npm test`: 14 of 14, see [the output](../evidence/s1)\n',
  'ledger/tasks/S2-store.md': '# S2 Store\n\n- Status: doing\n- Lane: s2-store\n- Depends on: S1\n- Plan: [S-server.md](../plan/S-server.md#s2-store)\n',
  'ledger/tasks/S3-serve.md': '# S3 Serve\n\n- Status: todo\n- Depends on: S2\n- Plan: [S-server.md](../plan/S-server.md#s3-serve)\n',
  'ledger/decisions/2026-10-14-bullet-fields.md': '# Task fields are bullets\n\n- Date: 2026-10-14\n- Decided by: the owner\n- Status: accepted\n\nWhy.\n',
  'ledger/log/2026-10-14-storage-routes.md': '# 2026-10-14 · Storage routes\n\n- Lane: s2-store\n- Tasks: S1, S2\n\nStory.\n'
}

/** A repository holding the given files, committed on main. */
function repositoryWith(files = VALID) {
  const r = repository()
  for (const [path, text] of Object.entries(files)) r.write(path, text)
  const committed = r.commit('initial')
  assert.equal(committed.status, 0, committed.out)
  return r
}

/** Loads and checks the workspace of a source. */
function checked(r, source = { kind: 'worktree' }) {
  const reader = treeReader({ ...source, root: r.root })
  const workspace = loadWorkspace(reader, CONFIG)
  return { workspace, problems: checkWorkspace(workspace, reader, CONFIG) }
}

describe('treeReader', () => {
  test('the working tree reader sees untracked files, not ignored or deleted ones', () => {
    const r = repositoryWith({ '.gitignore': 'build/\n', 'a.txt': 'a\n', 'gone.txt': 'x\n' })
    r.write('new.txt', 'new\n')
    r.write('build/out.txt', 'ignored\n')
    rmSync(join(r.root, 'gone.txt'))
    const reader = treeReader({ kind: 'worktree', root: r.root })
    assert.deepEqual(reader.list(''), ['.gitignore', 'a.txt', 'new.txt'])
    assert.equal(reader.read('new.txt'), 'new\n')
    assert.equal(reader.read('build/out.txt'), null)
    assert.equal(reader.read('gone.txt'), null)
    assert.equal(reader.exists('gone.txt'), false)
  })

  test('the index reader sees the staged content, not the working tree', () => {
    const r = repositoryWith({ 'a.txt': 'committed\n' })
    r.write('a.txt', 'staged\n')
    r.git('add', 'a.txt')
    r.write('a.txt', 'working\n')
    r.write('untracked.txt', 'x\n')
    assert.equal(treeReader({ kind: 'index', root: r.root }).read('a.txt'), 'staged\n')
    assert.equal(treeReader({ kind: 'worktree', root: r.root }).read('a.txt'), 'working\n')
    assert.equal(treeReader({ kind: 'commit', rev: 'HEAD', root: r.root }).read('a.txt'), 'committed\n')
    assert.equal(treeReader({ kind: 'index', root: r.root }).exists('untracked.txt'), false)
  })

  test('the commit reader reads a given revision', () => {
    const r = repositoryWith({ 'docs/a.md': 'one\n' })
    r.write('docs/a.md', 'two\n')
    r.write('docs/b.md', 'new\n')
    r.commit('second')
    const first = treeReader({ kind: 'commit', rev: 'HEAD~1', root: r.root })
    assert.deepEqual(first.list('docs'), ['docs/a.md'])
    assert.equal(first.read('docs/a.md'), 'one\n')
    assert.equal(first.read('docs/b.md'), null)
    const second = treeReader({ kind: 'commit', rev: 'HEAD', root: r.root })
    assert.deepEqual(second.list('docs/'), ['docs/a.md', 'docs/b.md'])
    assert.equal(second.read('docs/b.md'), 'new\n')
    assert.throws(() => treeReader({ kind: 'commit', rev: 'no-such-rev', root: r.root }).list(''), /git ls-tree failed/)
  })

  test('exists is true for a file and a folder with a file; read is null for a missing path', () => {
    const r = repositoryWith({ 'ledger/evidence/s1/output.txt': 'x\n' })
    for (const kind of ['worktree', 'index', 'commit']) {
      const reader = treeReader({ kind, rev: 'HEAD', root: r.root })
      assert.equal(reader.exists('ledger/evidence/s1/output.txt'), true, kind)
      assert.equal(reader.exists('ledger/evidence/s1'), true, kind)
      assert.equal(reader.exists('ledger/evidence/s1/'), true, kind)
      assert.equal(reader.exists('ledger'), true, kind)
      assert.equal(reader.exists('ledger/evidence/s2'), false, kind)
      assert.equal(reader.exists('ledger/evid'), false, kind)
      assert.equal(reader.read('missing.md'), null, kind)
      assert.equal(reader.read('ledger/evidence/s1'), null, kind)
      assert.equal(reader.read('ledger/evidence/s1/output.txt'), 'x\n', kind)
      assert.deepEqual(reader.list('ledger/evidence'), ['ledger/evidence/s1/output.txt'], kind)
    }
  })
})

describe('loadWorkspace and checkWorkspace', () => {
  test('a valid workspace loads every record and has no problems, from every source', () => {
    const r = repositoryWith()
    for (const source of [{ kind: 'worktree' }, { kind: 'index' }, { kind: 'commit', rev: 'HEAD' }]) {
      const { workspace, problems } = checked(r, source)
      assert.deepEqual(problems, [], source.kind)
      assert.equal(workspace.dir, 'ledger')
      assert.deepEqual(workspace.tasks.map((task) => task.id), ['S1', 'S2', 'S3'])
      assert.equal(workspace.decisions.length, 1)
      assert.equal(workspace.logs.length, 1)
      assert.deepEqual([...workspace.plans.keys()], ['ledger/plan/S-server.md'])
      assert.equal(workspace.plans.get('ledger/plan/S-server.md').value, 'approved')
      assert.ok(workspace.readme)
      assert.deepEqual(workspace.problems, [])
    }
  })

  test('only Markdown files directly in tasks/, decisions/ and log/ are records; plans at any depth', () => {
    const r = repositoryWith({
      ...VALID,
      'ledger/tasks/archive/S9-old.md': '# not a task\n',
      'ledger/tasks/notes.txt': 'x\n',
      'ledger/plan/sub/deep.md': 'Status: implemented\n\n## A\n\nText.\n'
    })
    const { workspace, problems } = checked(r)
    assert.deepEqual(problems, [])
    assert.equal(workspace.tasks.length, 3)
    assert.equal(workspace.plans.get('ledger/plan/sub/deep.md').value, 'implemented')
  })

  test('every invalid record is reported, sorted by file and line', () => {
    const r = repositoryWith({
      ...VALID,
      'ledger/tasks/S3-serve.md': '# S3 Serve\n\n- Status: maybe\n- Depends on: S8\n',
      'ledger/decisions/2026-10-14-bullet-fields.md': '# Task fields are bullets\n\n- Date: 2026-13-01\n- Decided by: the owner\n',
      'ledger/log/2026-10-14-storage-routes.md': '# 2026-10-14 · Storage routes\n\n- Tasks: S7\n',
      'ledger/plan/S-server.md': VALID['ledger/plan/S-server.md'].replace('approved', 'agreed')
    })
    const { problems } = checked(r)
    const summary = problems.map((problem) => `${problem.file}:${problem.line}`)
    assert.deepEqual(summary, [
      'ledger/decisions/2026-10-14-bullet-fields.md:3',
      'ledger/log/2026-10-14-storage-routes.md:3',
      'ledger/plan/S-server.md:3',
      'ledger/tasks/S3-serve.md:3',
      'ledger/tasks/S3-serve.md:4'
    ])
    assert.match(problems[3].message, /"maybe" is not a status/)
    assert.match(problems[4].message, /names S8, which is not a task/)
  })

  test('a parse problem is reported once, and a missing README is a problem', () => {
    const files = { ...VALID, 'ledger/tasks/S4-broken.md': 'no heading here\n' }
    delete files['ledger/README.md']
    const r = repositoryWith(files)
    const { workspace, problems } = checked(r)
    assert.equal(workspace.readme, null)
    assert.equal(workspace.problems.length, 1)
    const broken = problems.filter((problem) => problem.file === 'ledger/tasks/S4-broken.md')
    assert.equal(broken.length, 1, JSON.stringify(problems))
    assert.match(broken[0].message, /the task has no heading/)
    assert.ok(problems.some((problem) => problem.file === 'ledger/README.md' && /README is missing/.test(problem.message)))
  })

  test('a link to a file that exists only in the working tree fails in the index', () => {
    const r = repositoryWith()
    r.write('ledger/tasks/S3-serve.md', `${VALID['ledger/tasks/S3-serve.md']}\nSee [the sketch](../evidence/sketch.txt).\n`)
    r.git('add', 'ledger/tasks/S3-serve.md')
    r.write('ledger/evidence/sketch.txt', 'not staged\n')
    assert.deepEqual(checked(r).problems, [])
    const { problems } = checked(r, { kind: 'index' })
    assert.equal(problems.length, 1, JSON.stringify(problems))
    assert.match(problems[0].message, /points to ledger\/evidence\/sketch\.txt, which does not exist/)
  })

  test('a doing task whose plan is a proposal fails, also for a plan outside plan/', () => {
    const r = repositoryWith({
      ...VALID,
      'docs/design.md': 'Status: proposal\n\n## S2 Store\n\nGoal: store.\n',
      'ledger/tasks/S2-store.md': '# S2 Store\n\n- Status: doing\n- Lane: s2-store\n- Plan: [design](../../docs/design.md#s2-store)\n'
    })
    const { problems } = checked(r)
    assert.equal(problems.length, 1, JSON.stringify(problems))
    assert.match(problems[0].message, /is a proposal/)
  })
})

describe('isCode', () => {
  const config = parseConfig('{ "version": 2, "dir": "work", "codePaths": ["fixtures", "deep/data"] }').config
  const table = [
    ['src/app.js', true],
    ['package.json', true],
    ['Makefile', true],
    ['README.md', false],
    ['docs/guide.md', false],
    ['docs/GUIDE.MD', false],
    ['docs/notes.markdown', false],
    ['docs/logo.png', true],
    ['.resaledger.json', true],
    ['.githooks/pre-commit', true],
    ['.githooks/README.md', true],
    ['.github/workflows/resaledger.yml', true],
    ['work/README.md', false],
    ['work/tasks/S1-start.md', false],
    ['work/verified/3f2a9c1e5b7d4a60.json', false],
    ['work/evidence/screen.png', false],
    ['work/evidence/output.txt', false],
    ['work/scripts/records.mjs', true],
    ['work/scripts/notes.md', true],
    ['work/fixtures/input.json', true],
    ['work/fixtures/sample.md', true],
    ['work/fixtures/nested/a.txt', true],
    ['work/fixtures/photo.JPG', false],
    ['work/fixtures/photo.jpeg', false],
    ['work/fixtures/icon.svg', false],
    ['work/fixtures/anim.gif', false],
    ['work/fixtures/pic.webp', false],
    ['work/fixtures/pic.avif', false],
    ['work/fixturesx/input.csv', false],
    ['work/deep/data/x.csv', true],
    ['work/deep/other.csv', false],
    ['workshop/tool.js', true],
    ['ledger/tasks/S1.md', false],
    ['ledger/data.json', true],
    // A file in the workspace that code reads or runs is code, wherever it is (finding 8).
    ['work/evidence/config.js', true],
    ['work/evidence/settings.JSON', true],
    ['work/evidence/run.sh', true],
    ['work/notes/data.yaml', true],
    ['work/fixturesx/input.json', true],
    ['work/top.toml', true],
    ['work/evidence/report.csv', false],
    ['work/evidence/screen.svg', false],
    // ... except a stamp, and anything under the record folders.
    ['work/verified/0123456789abcdef.json', false],
    ['work/verified/notes.json', true],
    ['work/verified/nested/0123456789abcdef.json', true],
    ['work/tasks/S1-data.json', false],
    ['work/decisions/schema.yml', false],
    ['work/log/run.sh', false],
    ['work/plan/model.ts', false]
  ]
  for (const [path, expected] of table) {
    test(`${path} is ${expected ? '' : 'not '}code`, () => assert.equal(isCode(path, config), expected))
  }
})

describe('fingerprint', () => {
  const head = (r) => fingerprint({ kind: 'commit', rev: 'HEAD', root: r.root }, CONFIG)
  const index = (r) => fingerprint({ kind: 'index', root: r.root }, CONFIG)
  const withHook = { ...VALID, '.githooks/pre-commit': '#!/bin/sh\nexit 0\n', 'ledger/scripts/records.mjs': '// guard\n' }

  test('is a SHA-1 digest, equal for the index and HEAD on a clean checkout', () => {
    const r = repositoryWith(withHook)
    assert.match(head(r), /^[0-9a-f]{40}$/)
    assert.equal(index(r), head(r))
  })

  test('is the same for a checkout with CRLF line endings', () => {
    const r = repositoryWith(withHook)
    const before = head(r)
    r.git('config', 'core.autocrlf', 'true')
    for (const path of Object.keys(withHook)) rmSync(join(r.root, path))
    const restored = r.git('checkout', '--', '.')
    assert.equal(restored.status, 0, restored.out)
    assert.match(r.read('src/app.js'), /\r\n$/)
    assert.equal(index(r), before)
    assert.equal(head(r), before)
    const status = r.git('status', '--porcelain')
    assert.equal(status.out.trim(), '')
  })

  test('changes with code, the configuration, the guard and a hook; never with a record', () => {
    const r = repositoryWith(withHook)
    let previous = head(r)
    const change = (path, text, changes) => {
      r.write(path, text)
      assert.equal(r.commit(`change ${path}`).status, 0)
      const now = head(r)
      assert.equal(now !== previous, changes, path)
      assert.equal(index(r), now)
      previous = now
    }
    change('src/app.js', 'export const answer = 43\n', true)
    change('.resaledger.json', '{\n  "version": 2,\n  "wip": 2\n}\n', true)
    change('ledger/scripts/records.mjs', '// guard 2\n', true)
    change('.githooks/pre-commit', '#!/bin/sh\nexit 1\n', true)
    change('ledger/tasks/S3-serve.md', `${VALID['ledger/tasks/S3-serve.md']}\n## Notes\n\nMore.\n`, false)
    change('ledger/evidence/s1/output.txt', '15 of 15\n', false)
    change('README.md', '# Readme\n', false)
    change('ledger/verified/0123456789abcdef.json', '{}\n', false)
    // A workspace file that code reads is code (finding 8): adding it and changing it both count.
    change('ledger/evidence/config.js', 'module.exports = { ok: true }\n', true)
    change('ledger/evidence/config.js', 'module.exports = { ok: false }\n', true)
    // A file mode is part of the entry.
    r.git('update-index', '--chmod=+x', 'src/app.js')
    assert.notEqual(index(r), previous)
  })

  test('the working tree is not a fingerprint source', () => {
    const r = repositoryWith()
    assert.throws(() => fingerprint({ kind: 'worktree', root: r.root }, CONFIG), /use index or commit/)
  })
})

describe('the check command', () => {
  const guard = join(temporary(), 'records.mjs')

  test('the bundle builds', () => {
    const built = run(PACKAGE, process.execPath, [join(PACKAGE, 'scripts', 'bundle.mjs'), '--out', guard])
    assert.equal(built.status, 0, built.out)
  })

  test('counts the records in the singular for one and the plural otherwise', () => {
    assert.equal(recordCounts(1, 1, 1), '1 task, 1 decision, 1 log entry')
    assert.equal(recordCounts(0, 2, 3), '0 tasks, 2 decisions, 3 log entries')
  })

  test('passes on a valid workspace and fails on an invalid one', () => {
    const r = repositoryWith()
    const passed = r.node(guard, 'check')
    assert.equal(passed.status, 0, passed.out)
    assert.equal(passed.out, '✔ records valid: 3 tasks, 1 decision, 1 log entry\n')

    r.write('ledger/tasks/S3-serve.md', '# S3 Serve\n\n- Status: maybe\n')
    r.write('ledger/tasks/S4.md', 'no heading\n')
    const failed = r.node(guard, 'check')
    assert.equal(failed.status, 1)
    assert.equal(
      failed.out,
      [
        '✖ ledger/tasks/S3-serve.md:3: "maybe" is not a status. Write one of todo, doing, blocked, done, dropped',
        '✖ ledger/tasks/S4.md:1: the task has no heading. Start the file with "# <id> <title>", such as "# S4 Store projects and documents"',
        ''
      ].join('\n')
    )
    // The index and HEAD still hold the valid records.
    assert.equal(r.node(guard, 'check', '--index').status, 0)
    assert.equal(r.node(guard, 'check', '--rev', 'HEAD').status, 0)
    r.git('add', '-A')
    assert.equal(r.node(guard, 'check', '--index').status, 1)
    r.commit('broken')
    assert.equal(r.node(guard, 'check', '--rev', 'HEAD').status, 1)
    assert.equal(r.node(guard, 'check', '--rev', 'HEAD~1').status, 0)
  })

  test('passes on a README that still has setup markers, which only handoff asks about', () => {
    const r = repositoryWith({ ...VALID, 'ledger/README.md': VALID['ledger/README.md'].replace('A small app.', 'TODO(resaledger): what is being built, for whom.') })
    const passed = r.node(guard, 'check')
    assert.equal(passed.status, 0, passed.out)
  })

  test('prints a problem with no line without a line number, and refuses bad options', () => {
    const files = { ...VALID }
    delete files['ledger/README.md']
    const r = repositoryWith(files)
    const failed = r.node(guard, 'check')
    assert.equal(failed.status, 1)
    assert.match(failed.out, /^✖ ledger\/README\.md: the workspace README is missing/m)

    const missingConfig = repository()
    const noConfig = missingConfig.node(guard, 'check')
    assert.equal(noConfig.status, 1)
    assert.match(noConfig.out, /✖ \.resaledger\.json: \.resaledger\.json is missing/)

    assert.equal(r.node(guard, 'check', '--bogus').status, 1)
    assert.match(r.node(guard, 'check', '--rev').out, /--rev needs a revision/)
    assert.match(r.node(guard, 'check', '--rev', 'no-such-rev').out, /git ls-tree failed/)
    assert.match(r.node(guard, 'help').out, /check +validate the records/)
  })
})
