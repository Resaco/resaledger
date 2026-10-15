// Task files, spec 5.3: parsing, the shape rules of one file, the rules across a set of
// tasks, and the slugs of new file names. Every rule has a passing and a failing case.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { TASK_ID, TASK_STATUSES, parseTask, slugify, taskFileName, validateTask, validateTaskSet } from '../src/guard/tasks.mjs'

const PLAN_FILE = 'ledger/plan/S-server.md'
const PLAN_TEXT = '# S — Server\n\nStatus: approved · 2026-10-14 · by the owner\n\n### S4 Store projects\n\nGoal: store them.\n\n### S5 Empty\n\n### S6 Next\n\nText.\n'

/** A fake context: files in a Set, texts and plan statuses in Maps. */
function context({ files = [], texts = {}, statuses = {}, wip = 3, dir = 'ledger' } = {}) {
  const read = new Map(Object.entries({ [PLAN_FILE]: PLAN_TEXT, ...texts }))
  const exists = new Set([...files, ...read.keys()])
  const planStatus = new Map(Object.entries({ [PLAN_FILE]: { value: 'approved', date: '2026-10-14', by: 'the owner', line: 3 }, ...statuses }))
  return {
    exists: (path) => exists.has(path),
    read: (path) => read.get(path) ?? null,
    planStatus: (path) => planStatus.get(path) ?? null,
    taskIds: new Set(),
    config: { dir, wip }
  }
}

/** A task file from a heading, field lines and optional extra text. */
function taskText(heading, fields, rest = '') {
  return `# ${heading}\n\n${fields.map((field) => `- ${field}`).join('\n')}\n${rest}`
}

const PLAN_LINK = 'Plan: [S-server.md](../plan/S-server.md#s4-store-projects)'

/** Parses and validates a file; returns the problems. */
function check(path, text, ctx = context()) {
  const task = parseTask(path, text)
  assert.deepEqual(task.problems, [])
  return validateTask(task, ctx)
}

/** Expects no problems. */
function passes(path, text, ctx) {
  assert.deepEqual(check(path, text, ctx), [])
}

/** Expects exactly one problem whose message matches; returns it. */
function fails(path, text, pattern, ctx) {
  const problems = check(path, text, ctx)
  assert.equal(problems.length, 1, JSON.stringify(problems, null, 2))
  assert.match(problems[0].message, pattern)
  assert.equal(problems[0].file, path)
  return problems[0]
}

const FILE = 'ledger/tasks/S4-store-projects.md'

describe('TASK_ID and TASK_STATUSES', () => {
  test('ids are one to four capitals, a number and optional .number parts', () => {
    for (const id of ['S4', 'S4.1', 'S4.1.2', 'API12', 'ABCD1']) assert.ok(TASK_ID.test(id), id)
    for (const id of ['s4', 'S', '4', 'ABCDE1', 'S4.', 'S4-1', 'S4.a']) assert.ok(!TASK_ID.test(id), id)
  })

  test('the statuses are spec 5.3', () => {
    assert.deepEqual(TASK_STATUSES, ['todo', 'doing', 'blocked', 'done', 'dropped'])
  })
})

describe('parseTask', () => {
  test('reads the heading, fields, sections and links of the spec example', () => {
    const text = [
      '# S4 Store projects',
      '',
      '- Status: done',
      '- Lane: s4-store-projects',
      '- Depends on: S1, S3',
      `- ${PLAN_LINK}`,
      '- Evidence:',
      '  - `npm test -- server/storage`: 14 of 14',
      '  - Checked by hand: [storage.md](../evidence/storage.md)',
      '- Waiting for: —',
      '- Issue: #123',
      '- Owner: someone',
      '',
      '## Handoff',
      '',
      'State now.',
      '',
      '## Notes',
      '',
      'As built.',
      ''
    ].join('\n')
    const task = parseTask(FILE, text)
    assert.deepEqual(task.problems, [])
    assert.equal(task.file, FILE)
    assert.equal(task.id, 'S4')
    assert.equal(task.title, 'Store projects')
    assert.equal(task.titleLine, 1)
    assert.equal(task.fields.length, 8)
    assert.equal(task.status, 'done')
    assert.equal(task.lane, 's4-store-projects')
    assert.deepEqual(task.dependsOn, ['S1', 'S3'])
    assert.equal(task.plan, '[S-server.md](../plan/S-server.md#s4-store-projects)')
    assert.deepEqual(task.evidence, {
      value: '',
      items: ['`npm test -- server/storage`: 14 of 14', 'Checked by hand: [storage.md](../evidence/storage.md)'],
      line: 7
    })
    assert.equal(task.waitingFor, null)
    assert.equal(task.reason, null)
    assert.equal(task.issue, '#123')
    assert.equal(task.takenOverFrom, null)
    assert.deepEqual(task.sections.handoff, { line: 14, body: '\nState now.\n' })
    assert.deepEqual(task.sections.notes, { line: 18, body: '\nAs built.' })
    assert.equal(task.sections.plan, null)
    assert.deepEqual(task.unknownFields, [{ name: 'Owner', line: 12 }])
    assert.deepEqual(
      task.links.map((link) => link.path),
      ['../plan/S-server.md', '../evidence/storage.md']
    )
  })

  test('reads CRLF files the same way', () => {
    const lf = taskText('S4 Store projects', ['Status: todo', 'Depends on: S1'], '\n## Plan\n\nGoal.\n')
    const crlf = parseTask(FILE, lf.replace(/\n/g, '\r\n'))
    const plain = parseTask(FILE, lf)
    assert.deepEqual(crlf, plain)
    assert.equal(crlf.status, 'todo')
    assert.deepEqual(crlf.sections.plan, { line: 6, body: '\nGoal.' })
  })

  test('reports a file with no heading, and one with no field list', () => {
    const none = parseTask(FILE, 'Status: todo\n')
    assert.equal(none.problems.length, 1)
    assert.match(none.problems[0].message, /no heading.*# <id> <title>/)
    assert.equal(none.problems[0].line, 1)
    const bare = parseTask(FILE, '# S4 Store projects\n\nSome text.\n')
    assert.equal(bare.problems.length, 1)
    assert.match(bare.problems[0].message, /no field list.*- Status: todo/)
    assert.equal(bare.problems[0].line, 1)
    assert.deepEqual(validateTask(bare, context()), [])
  })
})

describe('validateTask: heading', () => {
  test('passes S4.1 and API12 ids', () => {
    passes('ledger/tasks/S4.1-fix-upload.md', taskText('S4.1 Fix upload', ['Status: todo']))
    passes('ledger/tasks/API12.md', taskText('API12 Rate limits', ['Status: todo']))
  })

  test('refuses an id that is not one', () => {
    const problem = fails('ledger/tasks/S4.md', taskText('s4 Store projects', ['Status: todo']), /"s4" is not a task id.*S4\.1/)
    assert.equal(problem.line, 1)
  })

  test('refuses an empty title', () => {
    fails('ledger/tasks/S4.md', taskText('S4', ['Status: todo']), /no title.*# S4 <title>/)
  })

  test('allows 100 characters of title and refuses 101', () => {
    passes('ledger/tasks/S4.md', taskText(`S4 ${'a'.repeat(100)}`, ['Status: todo']))
    fails('ledger/tasks/S4.md', taskText(`S4 ${'a'.repeat(101)}`, ['Status: todo']), /101 characters.*at most 100/)
  })
})

describe('validateTask: file name', () => {
  test('passes <id>-<slug>.md and <id>.md, with a stale slug', () => {
    passes('ledger/tasks/S4.md', taskText('S4 Store projects', ['Status: todo']))
    passes('ledger/tasks/S4-old-title.md', taskText('S4 Store projects', ['Status: todo']))
  })

  test('refuses an id mismatch between the file and the heading', () => {
    const problem = fails('ledger/tasks/S5-store-projects.md', taskText('S4 Store projects', ['Status: todo']), /file name says S5 but the heading says S4.*ledger\/tasks\/S4-store-projects\.md/)
    assert.equal(problem.line, 1)
    fails('ledger/tasks/S4.1.md', taskText('S4 Store projects', ['Status: todo']), /says S4\.1 but the heading says S4/)
  })

  test('refuses a file outside the tasks folder or with a bad name', () => {
    fails('ledger/S4.md', taskText('S4 Store projects', ['Status: todo']), /directly in ledger\/tasks\/.*ledger\/tasks\/S4-store-projects\.md/)
    fails('ledger/tasks/old/S4.md', taskText('S4 Store projects', ['Status: todo']), /directly in ledger\/tasks\//)
    fails('ledger/tasks/store.md', taskText('S4 Store projects', ['Status: todo']), /not "<id>-<slug>\.md".*S4-store-projects\.md/)
    fails('ledger/tasks/S4.txt', taskText('S4 Store projects', ['Status: todo']), /Rename it/)
  })

  test('uses the configured workspace folder', () => {
    passes('records/tasks/S4.md', taskText('S4 Store projects', ['Status: todo']), context({ dir: 'records' }))
    fails('ledger/tasks/S4.md', taskText('S4 Store projects', ['Status: todo']), /directly in records\/tasks\//, context({ dir: 'records' }))
  })
})

describe('validateTask: status and required fields', () => {
  test('passes every status with its required field', () => {
    passes(FILE, taskText('S4 Store projects', ['Status: todo']))
    passes(FILE, taskText('S4 Store projects', ['Status: doing', 'Lane: s4', PLAN_LINK]))
    passes(FILE, taskText('S4 Store projects', ['Status: blocked', 'Waiting for: owner']))
    passes(FILE, taskText('S4 Store projects', ['Status: dropped', 'Reason: split into S4.1–S4.3']))
    passes(FILE, taskText('S4 Store projects', ['Status: done', 'Evidence: `npm test`: 14 of 14']))
  })

  test('refuses a missing, empty or unknown status', () => {
    const missing = fails(FILE, taskText('S4 Store projects', ['Lane: s4']), /no status.*- Status: todo/)
    assert.equal(missing.line, 1)
    fails(FILE, taskText('S4 Store projects', ['Status: —']), /no status/)
    const unknown = fails(FILE, taskText('S4 Store projects', ['Status: in progress']), /"in progress" is not a status.*todo, doing/)
    assert.equal(unknown.line, 3)
  })

  test('doing needs a lane', () => {
    fails(FILE, taskText('S4 Store projects', ['Status: doing', 'Lane: —', PLAN_LINK]), /needs a lane.*- Lane: <branch>/)
  })

  test('blocked needs Waiting for', () => {
    fails(FILE, taskText('S4 Store projects', ['Status: blocked']), /- Waiting for:/)
  })

  test('dropped needs a reason', () => {
    fails(FILE, taskText('S4 Store projects', ['Status: dropped', 'Reason:']), /- Reason:/)
  })

  test('done needs evidence', () => {
    fails(FILE, taskText('S4 Store projects', ['Status: done']), /done task needs evidence/)
    const empty = fails(FILE, taskText('S4 Store projects', ['Status: done', 'Evidence: —']), /done task needs evidence/)
    assert.equal(empty.line, 4)
  })
})

describe('validateTask: evidence', () => {
  test('passes a command, a link or a URL', () => {
    passes(FILE, taskText('S4 Store projects', ['Status: done', 'Evidence: `npm test`: 14 of 14']))
    passes(FILE, taskText('S4 Store projects', ['Status: done', 'Evidence: [run](https://ci.example.com/run/1)']))
    passes(FILE, taskText('S4 Store projects', ['Status: done', 'Evidence: see https://ci.example.com/run/1']))
    passes(
      FILE,
      taskText('S4 Store projects', ['Status: done', 'Evidence: [storage.md](../evidence/storage.md)']),
      context({ files: ['ledger/evidence/storage.md'] })
    )
  })

  test('passes a nested list with one backticked command', () => {
    const text = '# S4 Store projects\n\n- Status: done\n- Evidence:\n  - Checked by hand at 390 px\n  - `npm test -- server`: 14 of 14\n  - Not verified: Safari\n'
    passes(FILE, text)
  })

  test('refuses evidence that is only words', () => {
    const problem = fails(FILE, taskText('S4 Store projects', ['Status: done', 'Evidence: Works.']), /command in backticks, a link or a URL, not only words/)
    assert.equal(problem.line, 4)
    fails(FILE, '# S4 Store projects\n\n- Status: done\n- Evidence:\n  - tested\n  - works\n', /not only words/)
  })

  test('checks evidence that is present before the task is done', () => {
    passes(FILE, taskText('S4 Store projects', ['Status: todo', 'Evidence: —']))
    fails(FILE, taskText('S4 Store projects', ['Status: todo', 'Evidence: tested']), /not only words/)
  })
})

describe('validateTask: plan', () => {
  test('passes a plan link with an anchor to a section with content', () => {
    passes(FILE, taskText('S4 Store projects', ['Status: todo', PLAN_LINK]))
    passes(FILE, taskText('S4 Store projects', ['Status: todo', 'Plan: [S-server.md](../plan/S-server.md)']))
  })

  test('refuses a plan that is not a link', () => {
    fails(FILE, taskText('S4 Store projects', ['Status: todo', 'Plan: see the server plan']), /Plan must be a Markdown link/)
    fails(FILE, taskText('S4 Store projects', ['Status: todo', 'Plan: [x](#plan)']), /Plan must be a Markdown link/)
  })

  test('refuses a plan link to a missing file, once', () => {
    const problem = fails(FILE, taskText('S4 Store projects', ['Status: todo', 'Plan: [T.md](../plan/T.md#t1)']), /ledger\/plan\/T\.md, which does not exist/)
    assert.equal(problem.line, 4)
  })

  test('refuses a broken anchor and names the sections there are', () => {
    const problem = fails(
      FILE,
      taskText('S4 Store projects', ['Status: todo', 'Plan: [S-server.md](../plan/S-server.md#s9-nothing)']),
      /#s9-nothing, which is not a section in ledger\/plan\/S-server\.md.*#s--server/
    )
    assert.equal(problem.line, 4)
  })

  test('a doing task with only a ## Plan section passes', () => {
    passes(FILE, taskText('S4 Store projects', ['Status: doing', 'Lane: s4'], '\n## Plan\n\nGoal: store them. Acceptance: `npm test`.\n'))
  })

  test('a doing task with no plan at all fails', () => {
    const problem = fails(FILE, taskText('S4 Store projects', ['Status: doing', 'Lane: s4']), /doing task needs a plan.*## Plan/)
    assert.equal(problem.line, 3)
  })

  test('a plan section that is only a heading is no plan', () => {
    const own = fails(FILE, taskText('S4 Store projects', ['Status: doing', 'Lane: s4'], '\n## Plan\n\n### Goal\n\n## Notes\n\nx\n'), /doing task needs a plan/)
    assert.equal(own.line, 6)
    fails(
      FILE,
      taskText('S4 Store projects', ['Status: doing', 'Lane: s4', 'Plan: [S-server.md](../plan/S-server.md#s5-empty)']),
      /doing task needs a plan\. The linked section #s5-empty in ledger\/plan\/S-server\.md has only its heading/
    )
  })

  test('an empty linked section is fine while the task is todo', () => {
    passes(FILE, taskText('S4 Store projects', ['Status: todo', 'Plan: [S-server.md](../plan/S-server.md#s5-empty)']))
  })

  test('a doing task cannot link a plan file marked proposal', () => {
    const proposal = context({ statuses: { [PLAN_FILE]: { value: 'proposal', date: '2026-10-14', by: 'the owner', line: 3 } } })
    const problem = fails(FILE, taskText('S4 Store projects', ['Status: doing', 'Lane: s4', PLAN_LINK]), /is a proposal.*Approve the plan first/, proposal)
    assert.equal(problem.line, 5)
    fails(FILE, taskText('S4 Store projects', ['Status: doing', 'Lane: s4', PLAN_LINK], '\n## Plan\n\nGoal.\n'), /Approve the plan first/, proposal)
    passes(FILE, taskText('S4 Store projects', ['Status: todo', PLAN_LINK]), proposal)
  })
})

describe('validateTask: links', () => {
  test('passes links that resolve, and ignores URLs and in-file anchors', () => {
    passes(
      FILE,
      taskText('S4 Store projects', ['Status: todo'], '\n## Notes\n\nSee [the doc](../../docs/storage.md), [web](https://example.com) and [above](#notes).\n'),
      context({ files: ['docs/storage.md'] })
    )
  })

  test('refuses a link in a section that does not resolve', () => {
    const problem = fails(FILE, taskText('S4 Store projects', ['Status: todo'], '\n## Notes\n\nSee [the doc](../../docs/gone.md).\n'), /points to docs\/gone\.md, which does not exist/)
    assert.equal(problem.line, 7)
  })

  test('refuses a link that climbs out of the repository', () => {
    fails(FILE, taskText('S4 Store projects', ['Status: todo'], '\n## Notes\n\n[x](../../../outside.md)\n'), /outside the repository/)
  })

  test('refuses a broken evidence link', () => {
    fails(FILE, taskText('S4 Store projects', ['Status: done', 'Evidence: [log](../evidence/missing.md)']), /evidence\/missing\.md, which does not exist/)
  })
})

describe('validateTask: handoff', () => {
  const handoff = (body) => taskText('S4 Store projects', ['Status: doing', 'Lane: s4', PLAN_LINK], `\n## Handoff\n\n${body}\n`)

  test('passes 1,500 characters, counted trimmed', () => {
    passes(FILE, handoff(`${'a'.repeat(1500)}\n\n\n   `))
    passes(FILE, handoff('ä'.repeat(1500)))
  })

  test('refuses 1,501 characters', () => {
    const problem = fails(FILE, handoff('a'.repeat(1501)), /1501 characters.*at most 1500/)
    assert.equal(problem.line, 7)
  })

  test('a doing task without a handoff is not a shape problem', () => {
    passes(FILE, taskText('S4 Store projects', ['Status: doing', 'Lane: s4', PLAN_LINK]))
  })
})

describe('validateTask: fields', () => {
  test('keeps other unknown fields silently', () => {
    passes(FILE, taskText('S4 Store projects', ['Status: todo', 'Owner: someone', 'Estimate: two days']))
  })

  test('reports Staus as a likely typo for Status', () => {
    const problems = check(FILE, taskText('S4 Store projects', ['Staus: todo']))
    assert.equal(problems.length, 2, JSON.stringify(problems))
    assert.match(problems[0].message, /"Staus" looks like a typo\. Write "- Status:"/)
    assert.equal(problems[0].line, 3)
    assert.match(problems[1].message, /no status/)
  })

  test('reports a known field in the wrong case as a typo', () => {
    fails(FILE, taskText('S4 Store projects', ['Status: todo', 'depends on: S1']), /"depends on" looks like a typo\. Write "- Depends on:"/)
  })

  test('reports a duplicate known field', () => {
    const problem = fails(FILE, taskText('S4 Store projects', ['Status: todo', 'Status: doing']), /"Status" appears twice \(first on line 3\)/)
    assert.equal(problem.line, 4)
  })
})

describe('validateTaskSet', () => {
  const parse = (path, heading, fields) => parseTask(path, taskText(heading, fields))

  test('passes unique ids, existing dependencies and WIP within the limit', () => {
    const tasks = [
      parse('ledger/tasks/S1.md', 'S1 One', ['Status: done']),
      parse('ledger/tasks/S2.md', 'S2 Two', ['Status: doing', 'Lane: a', 'Depends on: S1']),
      parse('ledger/tasks/S3.md', 'S3 Three', ['Status: doing', 'Lane: a', 'Depends on: S1, S2'])
    ]
    assert.deepEqual(validateTaskSet(tasks, context({ wip: 2 })), [])
  })

  test('reports a duplicate id on every file that has it', () => {
    const tasks = [
      parse('ledger/tasks/S4-a.md', 'S4 A', ['Status: todo']),
      parse('ledger/tasks/S4-b.md', 'S4 B', ['Status: todo']),
      parse('ledger/tasks/S5.md', 'S5 C', ['Status: todo'])
    ]
    const problems = validateTaskSet(tasks, context())
    assert.deepEqual(
      problems.map((problem) => [problem.file, problem.line]),
      [
        ['ledger/tasks/S4-a.md', 1],
        ['ledger/tasks/S4-b.md', 1]
      ]
    )
    assert.match(problems[0].message, /S4 is also used by ledger\/tasks\/S4-b\.md.*new id/)
  })

  test('reports a dependency that is not a task', () => {
    const tasks = [parse('ledger/tasks/S1.md', 'S1 One', ['Status: todo', 'Depends on: S0, S1'])]
    const problems = validateTaskSet(tasks, context())
    assert.equal(problems.length, 1)
    assert.equal(problems[0].line, 4)
    assert.match(problems[0].message, /names S0, which is not a task/)
  })

  test('reports WIP overflow in one lane once, but not across lanes', () => {
    const doing = (id, lane) => parse(`ledger/tasks/${id}.md`, `${id} Task`, ['Status: doing', `Lane: ${lane}`])
    const across = [doing('S1', 'a'), doing('S2', 'a'), doing('S3', 'b'), doing('S4', 'b')]
    assert.deepEqual(validateTaskSet(across, context({ wip: 2 })), [])
    const one = [doing('S1', 'a'), doing('S2', 'a'), doing('S3', 'a'), doing('S4', 'b')]
    const problems = validateTaskSet(one, context({ wip: 2 }))
    assert.equal(problems.length, 1)
    assert.equal(problems[0].file, 'ledger/tasks/S1.md')
    assert.equal(problems[0].line, 3)
    assert.match(problems[0].message, /lane a has 3 tasks doing \(S1, S2, S3\), more than the limit of 2/)
  })
})

describe('slugify and taskFileName', () => {
  test('turns Finnish and other non-ASCII titles into ASCII', () => {
    assert.equal(slugify('Käyttäjän tiedot ja yhteenveto'), 'kayttajan-tiedot-ja-yhteenveto')
    assert.equal(slugify('Åland öljy'), 'aland-oljy')
    assert.equal(slugify('Café crème brûlée'), 'cafe-creme-brulee')
    assert.equal(slugify('Ｆｕｌｌ ｗｉｄｔｈ'), 'full-width')
    assert.equal(slugify('Store projects & documents, on the server!'), 'store-projects-documents-on-the-server')
  })

  test('keeps at most 40 characters, cut at a hyphen when possible', () => {
    const slug = slugify('Store projects and documents on the server with paging')
    assert.equal(slug, 'store-projects-and-documents-on-the')
    assert.ok(slug.length <= 40)
    assert.equal(slugify('a'.repeat(50)), 'a'.repeat(40))
    assert.equal(slugify(`${'a'.repeat(40)} b`), 'a'.repeat(40))
    assert.equal(slugify(`${'a'.repeat(39)} b`), 'a'.repeat(39))
  })

  test('returns an empty slug for punctuation only', () => {
    assert.equal(slugify('!!! — ???'), '')
    assert.equal(slugify('日本語'), '')
    assert.equal(slugify(''), '')
  })

  test('builds file names with and without a slug', () => {
    assert.equal(taskFileName('ledger', 'S4', 'Store projects'), 'ledger/tasks/S4-store-projects.md')
    assert.equal(taskFileName('ledger', 'S4.1', '???'), 'ledger/tasks/S4.1.md')
  })

  test('adds "-task" to a name that Windows reserves, in any case', () => {
    assert.equal(taskFileName('ledger', 'COM1', '???'), 'ledger/tasks/COM1-task.md')
    assert.equal(taskFileName('ledger', 'nul', ''), 'ledger/tasks/nul-task.md')
    assert.equal(taskFileName('ledger', 'LPT9', undefined), 'ledger/tasks/LPT9-task.md')
    assert.equal(taskFileName('ledger', 'COM1.2', '???'), 'ledger/tasks/COM1.2-task.md')
    assert.equal(taskFileName('ledger', 'COM1', 'Open the port'), 'ledger/tasks/COM1-open-the-port.md')
    assert.equal(taskFileName('ledger', 'nul', 'Empty'), 'ledger/tasks/nul-empty.md')
    assert.equal(taskFileName('ledger', 'LPT9', 'Print it'), 'ledger/tasks/LPT9-print-it.md')
    assert.equal(taskFileName('ledger', 'COM10', '???'), 'ledger/tasks/COM10.md')
  })
})

test('an anchor in any link into a Markdown file must be a heading there', () => {
  const text = [
    '# S9 Anchors',
    '',
    '- Status: todo',
    '',
    '## Notes',
    '',
    'See [the design](../plan/S-server.md#storage) and [the gap](../plan/S-server.md#missing).'
  ].join('\n')
  const task = parseTask('ledger/tasks/S9-anchors.md', text)
  const files = new Map([['ledger/plan/S-server.md', '# S\n\n## Storage\n\nRows.\n']])
  const context = {
    exists: (path) => files.has(path),
    read: (path) => files.get(path) ?? null,
    planStatus: () => null,
    taskIds: new Set(['S9']),
    config: { dir: 'ledger', wip: 3 }
  }
  const problems = validateTask(task, context)
  assert.equal(problems.length, 1, JSON.stringify(problems))
  assert.match(problems[0].message, /#missing/)
})

test('slugify writes Latin letters that do not decompose as plain ASCII', () => {
  assert.equal(slugify('Straße und Øresund'), 'strasse-und-oresund')
  assert.equal(slugify('Æble þing'), 'aeble-thing')
})
