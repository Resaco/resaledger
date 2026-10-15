// changes: the tasks that became done since a tag, grouped from the Conventional Commits that
// name them, in real repositories through the bundled guard. Read-only.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { PACKAGE, repository, run, temporary } from './helpers.mjs'

const GUARD = join(temporary(), 'records.mjs')
const built = run(PACKAGE, process.execPath, [join(PACKAGE, 'scripts', 'bundle.mjs'), '--out', GUARD])
if (built.status !== 0) throw new Error(`bundle failed: ${built.out}`)

const README = '# Bakery shop\n\n## Goal\n\nBuild a small web shop for local bakers.\n'

/** A task file with a status and optional extra field lines. */
function taskText(id, title, status, extra = '') {
  return `# ${id} ${title}\n\n- Status: ${status}\n${extra}`
}

/** The fields of a done task whose evidence links to a file under evidence/. */
function doneText(id, title) {
  return taskText(id, title, 'done', `- Evidence: \`npm test\`: 4 of 4; [log](../evidence/${id.toLowerCase()}.txt)\n`)
}

/** A repository with the guard, a configuration and todo tasks, committed. */
function workspace(titles) {
  const r = repository()
  r.write('ledger/scripts/records.mjs', readFileSync(GUARD, 'utf8'))
  r.write('.resaledger.json', `${JSON.stringify({ version: 2 }, null, 2)}\n`)
  r.write('ledger/README.md', README)
  for (const [id, title] of Object.entries(titles)) {
    r.write(`ledger/tasks/${id}.md`, taskText(id, title, 'todo'))
    r.write(`ledger/evidence/${id.toLowerCase()}.txt`, 'passed\n')
  }
  commit(r, 'chore: start')
  return r
}

/** Commits everything with the given message lines; throws when git fails. */
function commit(r, ...messages) {
  const result = r.commit(...messages)
  if (result.status !== 0) throw new Error(`commit failed: ${result.out}`)
}

/** Marks a task done in a commit with a subject that names it. */
function finish(r, id, title, subject) {
  r.write(`ledger/tasks/${id}.md`, doneText(id, title))
  commit(r, subject, `Task: ${id}`)
}

/** Runs changes and returns its result, after checking that it wrote nothing. */
function changes(r, ...args) {
  const result = r.node('ledger/scripts/records.mjs', 'changes', ...args)
  assert.equal(r.git('status', '--porcelain').out, '', 'changes wrote a file')
  return result
}

/** The lines of a passing run. */
function lines(result) {
  assert.equal(result.status, 0, result.out)
  return result.out.split('\n')
}

describe('changes', () => {
  test('two tags: the default is the newest tag, --since takes the older one, grouped from Conventional Commits', () => {
    const titles = { T1: 'Order form', T2: 'Round prices', T3: 'Basket', T4: 'Tidy the menu', T5: 'Gift cards', T6: 'Opening hours' }
    const r = workspace(titles)
    finish(r, 'T1', titles.T1, 'feat: order form')
    r.git('tag', 'v0.1.0')
    // The commit claim makes says nothing about the change, so T2 stays Fixed.
    r.write('ledger/tasks/T2.md', taskText('T2', titles.T2, 'doing', '- Lane: prices\n'))
    commit(r, 'chore: claim T2', 'Task: T2')
    finish(r, 'T2', titles.T2, 'fix: round prices to cents')
    r.write('ledger/tasks/T3.md', taskText('T3', titles.T3, 'doing', '- Lane: basket\n'))
    commit(r, 'feat: basket', 'Task: T3')
    finish(r, 'T3', titles.T3, 'fix: basket total')
    finish(r, 'T4', titles.T4, 'refactor: menu')
    r.write('ledger/tasks/T5.md', taskText('T5', titles.T5, 'dropped', '- Reason: not needed\n'))
    commit(r, 'chore: drop T5')
    r.git('tag', 'v0.2.0')
    finish(r, 'T6', titles.T6, 'fix: opening hours on Sundays')

    const newest = lines(changes(r))
    assert.equal(newest[0], '## Changes since v0.2.0')
    assert.ok(newest.includes('### Fixed'), newest.join('\n'))
    assert.ok(newest.includes('- T6 Opening hours — `npm test`: 4 of 4; [log](ledger/evidence/t6.txt)'), newest.join('\n'))
    assert.ok(!newest.some((line) => /^- T[1-5] /.test(line)), newest.join('\n'))
    assert.ok(!newest.includes('### Added'), newest.join('\n'))

    const older = changes(r, '--since', 'v0.1.0')
    assert.equal(older.status, 0, older.out)
    assert.equal(
      older.out,
      [
        '## Changes since v0.1.0',
        '',
        '### Added',
        '',
        '- T3 Basket — `npm test`: 4 of 4; [log](ledger/evidence/t3.txt)',
        '',
        '### Changed',
        '',
        '- T4 Tidy the menu — `npm test`: 4 of 4; [log](ledger/evidence/t4.txt)',
        '',
        '### Fixed',
        '',
        '- T2 Round prices — `npm test`: 4 of 4; [log](ledger/evidence/t2.txt)',
        '- T6 Opening hours — `npm test`: 4 of 4; [log](ledger/evidence/t6.txt)',
        '',
        'Not listed: T5, dropped in this range.',
        ''
      ].join('\n')
    )
  })

  test('free-form commits give one list without groups', () => {
    const titles = { T1: 'Order form', T2: 'Round prices' }
    const r = workspace(titles)
    r.git('tag', 'v1.0.0')
    finish(r, 'T1', titles.T1, 'Add the order form')
    finish(r, 'T2', titles.T2, 'Round prices to cents')
    const out = lines(changes(r))
    assert.equal(out[0], '## Changes since v1.0.0')
    assert.ok(!out.some((line) => line.startsWith('###')), out.join('\n'))
    assert.deepEqual(
      out.filter((line) => line.startsWith('- ')).map((line) => line.split(' — ')[0]),
      ['- T1 Order form', '- T2 Round prices']
    )
  })

  test('a task finished, reopened and finished again since the tag counts; one left done does not', () => {
    const titles = { T1: 'Order form', T2: 'Round prices', T3: 'Basket' }
    const r = workspace(titles)
    finish(r, 'T1', titles.T1, 'feat: order form')
    finish(r, 'T2', titles.T2, 'feat: round prices')
    finish(r, 'T3', titles.T3, 'feat: basket')
    r.git('tag', 'v1.0.0')
    r.write('ledger/tasks/T1.md', taskText('T1', titles.T1, 'doing', '- Lane: order-form\n'))
    commit(r, 'chore: reopen T1', 'Task: T1')
    finish(r, 'T1', titles.T1, 'fix: order form keeps the date')
    r.write('ledger/tasks/T2.md', `${doneText('T2', titles.T2)}\n## Notes\n\nA typo fixed in the notes.\n`)
    commit(r, 'docs: notes on T2')
    const out = lines(changes(r))
    // chore and fix name T1 in the range: not all fix, so Changed.
    assert.ok(out.includes('### Changed'), out.join('\n'))
    assert.ok(out.some((line) => line.startsWith('- T1 Order form')), out.join('\n'))
    assert.ok(!out.some((line) => /^- T[23] /.test(line)), out.join('\n'))
  })

  test('with no tag, everything since the first commit counts, and the output says so', () => {
    const titles = { T1: 'Order form', T2: 'Round prices' }
    const r = workspace(titles)
    finish(r, 'T1', titles.T1, 'feat: order form')
    const out = lines(changes(r))
    assert.equal(out[0], '## Changes since the first commit')
    assert.ok(out.includes('No tag is reachable from HEAD, so this covers the whole history.'), out.join('\n'))
    assert.ok(out.includes('### Added'), out.join('\n'))
    assert.ok(out.some((line) => line.startsWith('- T1 Order form')), out.join('\n'))
    assert.ok(!out.some((line) => line.startsWith('- T2 ')), out.join('\n'))
  })

  test('with no task done, it says so', () => {
    const r = workspace({ T1: 'Order form' })
    r.git('tag', 'v1.0.0')
    assert.ok(lines(changes(r)).includes('No task became done since v1.0.0.'))
  })

  test('--json prints the same data', () => {
    const titles = { T1: 'Order form', T2: 'Round prices' }
    const r = workspace(titles)
    r.git('tag', 'v1.0.0')
    finish(r, 'T1', titles.T1, 'feat(shop): order form')
    finish(r, 'T2', titles.T2, 'Round prices')
    const result = changes(r, '--json')
    assert.equal(result.status, 0, result.out)
    const data = JSON.parse(result.out)
    assert.equal(data.since, 'v1.0.0')
    assert.equal(data.from, r.git('rev-parse', 'v1.0.0^{commit}').out.trim())
    assert.equal(data.to, r.git('rev-parse', 'HEAD').out.trim())
    assert.equal(data.grouped, true)
    assert.deepEqual(data.dropped, [])
    assert.deepEqual(data.tasks, [
      { id: 'T1', title: 'Order form', file: 'ledger/tasks/T1.md', group: 'Added', evidence: '`npm test`: 4 of 4; [log](ledger/evidence/t1.txt)' },
      { id: 'T2', title: 'Round prices', file: 'ledger/tasks/T2.md', group: 'Changed', evidence: '`npm test`: 4 of 4; [log](ledger/evidence/t2.txt)' }
    ])
  })

  test('a bad ref is refused with exit code 1', () => {
    const r = workspace({ T1: 'Order form' })
    const result = changes(r, '--since', 'v9.9.9')
    assert.equal(result.status, 1)
    assert.match(result.out, /"v9\.9\.9" is not a tag, branch or commit in this repository/)
    const option = changes(r, '--since', '--json')
    assert.equal(option.status, 1)
    const unknown = changes(r, '--all')
    assert.equal(unknown.status, 1)
    assert.match(unknown.out, /unknown option "--all"/)
  })
})
