// The parallel-lanes acceptance test (spec 16, plan T1). One repository set up by the real init,
// three lanes in three worktrees that each claim a task, add a child task, commit code, verify,
// write a decision and a log entry, finish the task and hand off, all through the product's
// commands and the installed hooks. The lanes then merge into main with merge commits in all six
// orders and once with squash merges, each on a fresh clone of the same state: no merge
// conflicts, check passes and work shows the right state. A fourth lane that edits another
// lane's task is refused by pre-commit and by ci.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { PACKAGE, repository, run } from './helpers.mjs'

const CLI = join(PACKAGE, 'bin', 'resaledger.mjs')
const GATE = 'node -e ""'

const README = `# Bakery shop

## Goal

Build a small web shop for local bakers.

## Environments

Local only.

## Manual checks

None.
`

// Each lane works on its own task and code file. They share the title of their log entry on
// purpose: new log must give each lane its own file name.
const LANES = [
  { id: 'S1', title: 'Bake bread', branch: 's1-bake-bread', code: 'src/bread.js', child: 'Slice the bread', decision: 'Bread is baked at night' },
  { id: 'S2', title: 'Ice cakes', branch: 's2-ice-cakes', code: 'src/cakes.js', child: 'Box the cakes', decision: 'Cakes are iced to order' },
  { id: 'S3', title: 'Fill pies', branch: 's3-fill-pies', code: 'src/pies.js', child: 'Price the pies', decision: 'Pies use seasonal fruit' }
]
const LOG_TITLE = 'Session notes'

/** Helpers for one working folder: a repository, one of its worktrees or a clone. */
function at(root) {
  const where = {
    root,
    git: (...args) => run(root, 'git', args),
    /** npx resaledger <args>, as a person or an agent runs it. */
    cli: (...args) => run(root, process.execPath, [CLI, ...args]),
    read: (path) => readFileSync(join(root, path), 'utf8'),
    write: (path, text) => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    },
    append: (path, text) => where.write(path, `${where.read(path)}${text}`)
  }
  return where
}

/** Asserts that a command succeeded and returns its output. */
function ok(result) {
  assert.equal(result.status, 0, result.out)
  return result.out
}

/** Stages everything and commits through the hooks; the messages become paragraphs. */
function commit(where, ...messages) {
  ok(where.git('add', '-A'))
  return ok(where.git('commit', '-q', ...messages.flatMap((message) => ['-m', message])))
}

/** The path that a "✔ created <path>" line names. */
function created(out) {
  const match = /✔ created (\S+)/.exec(out)
  assert.ok(match, out)
  return match[1]
}

const rev = (where, name = 'HEAD') => ok(where.git('rev-parse', name)).trim()

// 1. Setup: init, the printed commit command, the gates, the README and three planned tasks.
const repo = repository()
const main = at(repo.root)
main.write('package.json', '{ "name": "bakery-shop", "private": true }\n')
commit(main, 'initial')
const initialised = ok(main.cli('init', '--agents', 'none'))
const printed = initialised.split('\n').find((line) => line.trim().startsWith('git add '))
assert.ok(printed, initialised)
ok(run(main.root, 'sh', ['-c', printed.trim()]))
assert.equal(ok(main.git('config', '--get', 'core.hooksPath')).trim(), '.githooks')

const config = JSON.parse(main.read('.resaledger.json'))
config.gates = { commit: [GATE], verify: [GATE] }
main.write('.resaledger.json', `${JSON.stringify(config, null, 2)}\n`)
main.write('ledger/README.md', README)
commit(main, 'chore: run the gates on every commit', 'Task: maintenance')

for (const lane of LANES) {
  const path = created(ok(main.cli('new', 'S', lane.title)))
  assert.equal(path, `ledger/tasks/${lane.id}-${lane.branch.slice(lane.id.length + 1)}.md`)
  lane.task = path
  main.append(path, `\n## Plan\n\n${lane.title}, with a test that proves it.\n`)
}
commit(main, 'docs: plan S1, S2 and S3')
// A stamp on main that every lane's verify replaces: three lanes delete the same file.
ok(main.cli('verify'))
commit(main, 'chore: stamp the gates on main')
const mainStamp = ok(main.git('ls-files', 'ledger/verified')).trim()
assert.match(mainStamp, /^ledger\/verified\/[0-9a-f]{16}\.json$/)

// 2. Three lanes, each step taken in all three before the next, so they really work at once.
for (const lane of LANES) {
  const out = ok(main.cli('claim', lane.id, '--worktree', join(repo.base, lane.branch)))
  assert.match(out, new RegExp(`✔ ${lane.id} claimed on the new branch ${lane.branch} in the worktree`))
  lane.at = at(join(repo.base, lane.branch))
  assert.equal(ok(lane.at.git('branch', '--show-current')).trim(), lane.branch)
}
for (const lane of LANES) {
  lane.child = created(ok(lane.at.cli('new', '--under', lane.id, lane.child)))
  assert.match(lane.child, new RegExp(`^ledger/tasks/${lane.id}\\.1-`))
  commit(lane.at, `chore: claim ${lane.id}`, `Task: ${lane.id}`)
  lane.claimCommit = rev(lane.at)
}
for (const lane of LANES) {
  lane.at.write(lane.code, `export const ${lane.branch.split('-')[1]} = '${lane.title}'\n`)
  commit(lane.at, `feat: ${lane.title.toLowerCase()}`, `Task: ${lane.id}`)
}
for (const lane of LANES) {
  ok(lane.at.cli('verify'))
  const status = ok(lane.at.git('status', '--porcelain', '--', 'ledger/verified'))
  assert.match(status, new RegExp(` D ${mainStamp}`), status)
  assert.match(status, /\?\? ledger\/verified\/[0-9a-f]{16}\.json/, status)
  commit(lane.at, 'chore: stamp the gates')
}
for (const lane of LANES) {
  lane.decision = created(ok(lane.at.cli('new', 'decision', lane.decision)))
  lane.at.append(lane.decision, `The ${lane.id} lane decided this while building ${lane.title.toLowerCase()}.\n`)
  lane.log = created(ok(lane.at.cli('new', 'log', LOG_TITLE)))
  assert.match(lane.at.read(lane.log), new RegExp(`- Lane: ${lane.branch}\n- Tasks: ${lane.id}\n`))
  lane.at.append(lane.log, `What was tried for ${lane.id}, and what was learned.\n`)
  ok(lane.at.cli('check'))
  commit(lane.at, `docs: record a decision and the session for ${lane.id}`)
}
for (const lane of LANES) {
  const text = lane.at.read(lane.task)
  assert.match(text, new RegExp(`- Status: doing\n- Lane: ${lane.branch}\n`))
  lane.at.write(lane.task, text.replace(`- Status: doing\n- Lane: ${lane.branch}\n`, `- Status: done\n- Lane: ${lane.branch}\n- Evidence:\n  - \`${GATE}\`: passed\n  - [the decision](../${lane.decision.slice('ledger/'.length)})\n`))
  commit(lane.at, `docs: finish ${lane.id}`)
}
for (const lane of LANES) {
  lane.at.append(lane.task, `\n## Handoff\n\n${lane.id} is done. ${lane.child.match(/S\d\.1/)[0]} waits as todo for the next lane.\n`)
  commit(lane.at, `docs: hand off ${lane.id}`)
}
for (const lane of LANES) assert.match(ok(lane.at.cli('handoff')), /✔ handed off/)

/** A fresh clone of the repository as the lanes left it, with the lanes as local branches and the hooks on. */
let clones = 0
function cloneOfLanes() {
  const path = join(repo.base, `clone-${++clones}`)
  ok(run(repo.base, 'git', ['clone', '-q', repo.root, path]))
  const clone = at(path)
  for (const lane of LANES) ok(clone.git('branch', '-q', lane.branch, `origin/${lane.branch}`))
  // work turns the hooks on in a clone where they are off.
  ok(clone.cli('work'))
  assert.equal(ok(clone.git('config', '--get', 'core.hooksPath')).trim(), '.githooks')
  return clone
}

/** The checks after every way of merging: no conflict anywhere, check passes, work shows the state. */
function assertMerged(clone) {
  assert.equal(ok(clone.git('ls-files', '--unmerged')), '')
  const markers = clone.git('grep', '-n', '-E', '^(<{7}|={7}|>{7})( |$)')
  assert.equal(markers.status, 1, `conflict markers:\n${markers.out}`)
  assert.equal(ok(clone.git('status', '--porcelain')), '')
  assert.match(ok(clone.cli('check')), /✔ records valid/)

  const state = JSON.parse(ok(clone.cli('work', '--json')))
  assert.equal(state.lane, 'main')
  assert.deepEqual(state.inProgress, [])
  assert.deepEqual(state.progress, { done: 3, total: 6, byPrefix: [{ prefix: 'S', done: 3, total: 6 }] })
  assert.deepEqual(state.ready.map((task) => task.id), ['S1.1', 'S2.1', 'S3.1'])
  assert.deepEqual(state.warnings, { doubleClaims: [], staleClaims: [], problems: [] })
  for (const lane of state.lanes) assert.deepEqual(lane.holds, [], JSON.stringify(lane))
  for (const lane of LANES) {
    const text = clone.read(lane.task)
    assert.match(text, new RegExp(`- Status: done\n- Lane: ${lane.branch}\n- Evidence:`))
    assert.match(text, /## Handoff\n/)
    assert.match(clone.read(lane.child), /- Status: todo/)
    assert.match(clone.read(lane.decision), /- Status: accepted/)
    assert.match(clone.read(lane.log), new RegExp(`- Tasks: ${lane.id}`))
    assert.match(clone.read(lane.code), new RegExp(lane.title))
  }
  // The three log entries share a title and still have three names.
  assert.equal(new Set(LANES.map((lane) => lane.log)).size, 3)
  // Main's old stamp is gone, and each lane's stamp arrived.
  const stamps = ok(clone.git('ls-files', 'ledger/verified')).trim().split('\n')
  assert.equal(stamps.length, 3, stamps.join('\n'))
  assert.ok(!stamps.includes(mainStamp))
}

/** Every order of the items. */
function orders(items) {
  if (items.length <= 1) return [items]
  return items.flatMap((item, index) => orders([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]))
}

describe('three lanes work at once', () => {
  test('each lane passes ci as a pull request into main', () => {
    for (const lane of LANES) {
      // CI runs in a checkout of the head: the gates refuse to judge any other working tree.
      const out = ok(lane.at.cli('ci', '--base', 'main', '--head', lane.branch, '--lane', lane.branch))
      assert.doesNotMatch(out, /✖/)
    }
  })
})

describe('the lanes merge into main without a conflict', () => {
  for (const order of orders(LANES)) {
    test(`with merge commits, in the order ${order.map((lane) => lane.id).join(', ')}`, () => {
      const clone = cloneOfLanes()
      for (const lane of order) ok(clone.git('merge', '-q', '--no-ff', '--no-edit', lane.branch))
      assert.equal(ok(clone.git('rev-list', '--count', '--merges', 'main')).trim(), '3')
      assertMerged(clone)
    })
  }

  test('with squash merges, each commit naming its lane\'s task', () => {
    const clone = cloneOfLanes()
    for (const lane of LANES) {
      ok(clone.git('merge', '-q', '--squash', lane.branch))
      commit(clone, `feat: ${lane.title.toLowerCase()}`, `Task: ${lane.id}`)
      assert.match(ok(clone.git('log', '-1', '--format=%B')), new RegExp(`\nTask: ${lane.id}\n`))
    }
    assert.equal(ok(clone.git('rev-list', '--count', '--merges', 'main')).trim(), '0')
    assertMerged(clone)
  })
})

describe('a fourth lane that edits another lane\'s task', () => {
  // Lane A's claim has reached main (a first part of its work merged, S1 still doing), so
  // main records that lane A holds S1. Lane D starts from main and edits S1 without --take.
  const clone = cloneOfLanes()
  const holder = LANES[0]
  ok(clone.git('merge', '-q', '--no-ff', '--no-edit', holder.claimCommit))
  assert.match(clone.read(holder.task), new RegExp(`- Status: doing\n- Lane: ${holder.branch}\n`))
  ok(clone.git('switch', '-q', '-c', 'lane-d'))
  clone.append(holder.task, '\n## Notes\n\nLane D thinks the bread needs more salt.\n')
  const held = new RegExp(`task S1 is held by lane "${holder.branch}"`)

  test('is refused by pre-commit', () => {
    ok(clone.git('add', '-A'))
    const refused = clone.git('commit', '-q', '-m', 'docs: note on S1')
    assert.notEqual(refused.status, 0, refused.out)
    assert.match(refused.out, held)
  })

  test('is refused by ci as a pull request into main', () => {
    // Committed past the hooks on purpose: ci must catch what --no-verify let through.
    ok(clone.git('commit', '-q', '--no-verify', '-m', 'docs: note on S1'))
    const refused = clone.cli('ci', '--base', 'main', '--head', 'lane-d', '--lane', 'lane-d')
    assert.equal(refused.status, 1, refused.out)
    assert.match(refused.out, held)
  })
})
