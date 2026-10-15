// Decisions, log entries, plan status lines and the workspace README.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  SETUP_MARKER,
  parseDecision,
  parseLogEntry,
  parseReadme,
  readmeMarkerProblems,
  planStatus,
  validateDecision,
  validateLogEntry,
  validatePlanStatus,
  validateReadme
} from '../src/guard/records.mjs'

const DECISION_FILE = 'ledger/decisions/2026-10-14-bullet-fields.md'
const LOG_FILE = 'ledger/log/2026-10-14-storage-routes.md'
const README_FILE = 'ledger/README.md'

function existing(...paths) {
  const known = new Set(paths)
  return { exists: (path) => known.has(path) }
}

function decision({ date = '2026-10-14', by = 'Niko Alho', status = 'accepted', file = DECISION_FILE } = {}) {
  const fields = [
    date === null ? null : `- Date: ${date}`,
    by === null ? null : `- Decided by: ${by}`,
    status === null ? null : `- Status: ${status}`
  ].filter((line) => line !== null)
  const text = ['# Task fields are bullets, not YAML front matter', '', ...fields, '', 'Why.', ''].join('\n')
  return parseDecision(file, text)
}

function messages(problems) {
  return problems.map((problem) => problem.message)
}

describe('parseDecision', () => {
  test('reads the H1 and the fields after it, in CRLF text', () => {
    const text = '# Bullets, not YAML\r\n\r\n- Date: 2026-10-14\r\n- Decided by: Niko Alho\r\n\r\nWhy.\r\n'
    const parsed = parseDecision(DECISION_FILE, text)
    assert.equal(parsed.file, DECISION_FILE)
    assert.equal(parsed.title, 'Bullets, not YAML')
    assert.equal(parsed.titleLine, 1)
    assert.deepEqual(
      parsed.fields.map((field) => [field.name, field.value, field.line]),
      [['Date', '2026-10-14', 3], ['Decided by', 'Niko Alho', 4]]
    )
    assert.deepEqual(parsed.problems, [])
    assert.deepEqual(validateDecision(parsed, existing()), [])
  })

  test('reports a field written twice', () => {
    const parsed = parseDecision(DECISION_FILE, '# A\n\n- Date: 2026-10-14\n- Date: 2026-10-15\n')
    assert.equal(parsed.problems.length, 1)
    assert.equal(parsed.problems[0].line, 4)
    assert.match(parsed.problems[0].message, /appears twice/)
  })
})

describe('validateDecision', () => {
  test('passes a complete decision', () => {
    assert.deepEqual(validateDecision(decision(), existing()), [])
  })

  test('needs an H1', () => {
    const parsed = parseDecision(DECISION_FILE, '- Date: 2026-10-14\n- Decided by: Niko Alho\n')
    const problems = validateDecision(parsed, existing())
    assert.equal(problems.length, 3)
    assert.match(problems[0].message, /starts with a heading/)
    assert.equal(problems[0].file, DECISION_FILE)
  })

  test('needs a Date', () => {
    const problems = validateDecision(decision({ date: null }), existing())
    assert.equal(problems.length, 1)
    assert.match(problems[0].message, /needs a date/)
  })

  test('needs the Date as YYYY-MM-DD', () => {
    const problems = validateDecision(decision({ date: '14.10.2026' }), existing())
    assert.equal(problems.length, 1)
    assert.match(problems[0].message, /not in the form YYYY-MM-DD/)
    assert.equal(problems[0].line, 3)
  })

  test('needs a real calendar date', () => {
    const file = 'ledger/decisions/2026-02-30-bullet-fields.md'
    const problems = validateDecision(decision({ date: '2026-02-30', file }), existing())
    assert.equal(problems.length, 2)
    assert.match(problems[0].message, /2026-02-30 does not exist/)
    assert.match(problems[1].message, /file name should be/)
    assert.deepEqual(validateDecision(decision({ date: '2024-02-29', file: 'ledger/decisions/2024-02-29-leap.md' }), existing()), [])
  })

  test('needs a Decided by that is not empty', () => {
    for (const by of ['—', '', null]) {
      const problems = validateDecision(decision({ by }), existing())
      assert.equal(problems.length, 1, `Decided by: ${by}`)
      assert.match(problems[0].message, /needs the person who decided/)
    }
  })

  test('accepts a missing or accepted Status', () => {
    assert.deepEqual(validateDecision(decision({ status: null }), existing()), [])
    assert.deepEqual(validateDecision(decision({ status: '—' }), existing()), [])
  })

  test('accepts superseded by a link to a decision that exists', () => {
    const parsed = decision({ status: 'superseded by [front matter after all](2026-11-02-front-matter.md)' })
    assert.deepEqual(validateDecision(parsed, existing('ledger/decisions/2026-11-02-front-matter.md')), [])
  })

  test('rejects superseded by a link that does not resolve', () => {
    const parsed = decision({ status: 'superseded by [front matter after all](2026-11-02-front-matter.md)' })
    const problems = validateDecision(parsed, existing())
    assert.equal(problems.length, 1)
    assert.match(problems[0].message, /does not exist/)
    assert.equal(problems[0].line, 5)
  })

  test('rejects any other Status, and superseded by without a link', () => {
    for (const status of ['Accepted', 'rejected', 'superseded by the newer one', 'superseded by [web](https://example.com/x)']) {
      const problems = validateDecision(decision({ status }), existing())
      assert.equal(problems.length, 1, status)
      assert.match(problems[0].message, /"accepted" or "superseded by <link>"/)
    }
  })

  test('needs the file name decisions/<date>-<slug>.md with the Date field\'s date', () => {
    const differs = validateDecision(decision({ file: 'ledger/decisions/2026-10-13-bullet-fields.md' }), existing())
    assert.equal(differs.length, 1)
    assert.match(differs[0].message, /2026-10-13 differs from the record's date 2026-10-14/)
    assert.equal(differs[0].line, 0)
    for (const file of ['ledger/decisions/bullet-fields.md', 'ledger/decisions/2026-10-14.md', 'ledger/notes/2026-10-14-bullet-fields.md']) {
      const problems = validateDecision(decision({ file }), existing())
      assert.equal(problems.length, 1, file)
      assert.match(problems[0].message, /file name should be decisions\/<YYYY-MM-DD>-<slug>\.md/)
    }
  })
})

describe('log entries', () => {
  const tasks = new Set(['S4', 'S4.1'])

  test('parse the date and title from "<date> · <title>" in CRLF text', () => {
    const text = '# 2026-10-14 · Storage routes, and why paging waits\r\n\r\n- Lane: s4-store-documents\r\n- Tasks: S4, S4.1\r\n\r\nStory.\r\n'
    const entry = parseLogEntry(LOG_FILE, text)
    assert.equal(entry.date, '2026-10-14')
    assert.equal(entry.title, 'Storage routes, and why paging waits')
    assert.equal(entry.titleLine, 1)
    assert.deepEqual(entry.fields.map((field) => field.name), ['Lane', 'Tasks'])
    assert.deepEqual(validateLogEntry(entry, { taskIds: tasks }), [])
  })

  test('Lane and Tasks are optional', () => {
    assert.deepEqual(validateLogEntry(parseLogEntry(LOG_FILE, '# 2026-10-14 · A story\n\nText.\n'), { taskIds: tasks }), [])
    assert.deepEqual(validateLogEntry(parseLogEntry(LOG_FILE, '# 2026-10-14 · A story\n\n- Tasks: —\n'), { taskIds: tasks }), [])
  })

  test('report an unknown task id', () => {
    const entry = parseLogEntry(LOG_FILE, '# 2026-10-14 · A story\n\n- Tasks: S4, S9\n')
    const problems = validateLogEntry(entry, { taskIds: tasks })
    assert.equal(problems.length, 1)
    assert.match(problems[0].message, /the task S9 does not exist/)
    assert.equal(problems[0].line, 3)
  })

  test('need the heading "<date> · <title>"', () => {
    for (const heading of ['Storage routes', '2026-10-14 - Storage routes', '2026-10-14·Storage routes']) {
      const problems = validateLogEntry(parseLogEntry(LOG_FILE, `# ${heading}\n`), { taskIds: tasks })
      assert.match(problems[0].message, /is not "<YYYY-MM-DD> · <title>"/, heading)
    }
    const none = validateLogEntry(parseLogEntry(LOG_FILE, 'Text.\n'), { taskIds: tasks })
    assert.match(none[0].message, /starts with a heading/)
  })

  test('need a real calendar date', () => {
    const problems = validateLogEntry(parseLogEntry('ledger/log/2026-02-30-x.md', '# 2026-02-30 · X\n'), { taskIds: tasks })
    assert.match(problems[0].message, /2026-02-30 does not exist/)
  })

  test('need the file name log/<date>-<slug>.md with the heading\'s date', () => {
    const differs = validateLogEntry(parseLogEntry('ledger/log/2026-10-15-storage-routes.md', '# 2026-10-14 · X\n'), { taskIds: tasks })
    assert.equal(differs.length, 1)
    assert.match(differs[0].message, /2026-10-15 differs from the record's date 2026-10-14/)
    const misnamed = validateLogEntry(parseLogEntry('ledger/log/storage-routes.md', '# 2026-10-14 · X\n'), { taskIds: tasks })
    assert.equal(misnamed.length, 1)
    assert.match(misnamed[0].message, /log\/<YYYY-MM-DD>-<slug>\.md/)
  })
})

describe('plan status', () => {
  test('reads the value, date and who decided, in CRLF text', () => {
    const text = '# Plan\r\n\r\nStatus: approved · 2026-10-15 · by Niko Alho\r\n\r\n## Section\r\n'
    assert.deepEqual(planStatus(text), { value: 'approved', date: '2026-10-15', by: 'by Niko Alho', line: 3 })
    assert.deepEqual(validatePlanStatus('ledger/plan/x.md', planStatus(text)), [])
  })

  test('the date and the person are optional', () => {
    assert.deepEqual(planStatus('Status: in progress\n'), { value: 'in progress', date: null, by: null, line: 1 })
    assert.deepEqual(planStatus('Status: proposal · 2026-10-15\n'), { value: 'proposal', date: '2026-10-15', by: null, line: 1 })
  })

  test('is null without a status line before the first ## heading', () => {
    assert.equal(planStatus('# Plan\n\nText.\n'), null)
    assert.equal(planStatus('# Plan\n\n## Section\n\nStatus: approved\n'), null)
    assert.deepEqual(validatePlanStatus('ledger/plan/x.md', null), [])
  })

  test('accepts exactly the four values', () => {
    for (const value of ['proposal', 'approved', 'in progress', 'implemented']) {
      assert.deepEqual(validatePlanStatus('ledger/plan/x.md', planStatus(`# P\n\nStatus: ${value} · 2026-10-15\n`)), [], value)
    }
  })

  test('rejects odd spacing, capitals and other words', () => {
    for (const value of ['Approved', 'in  progress', 'In Progress', 'inprogress', 'done', '']) {
      const problems = validatePlanStatus('ledger/plan/x.md', planStatus(`# P\n\nStatus: ${value} · 2026-10-15\n`))
      assert.equal(problems.length, 1, value)
      assert.equal(problems[0].file, 'ledger/plan/x.md')
      assert.equal(problems[0].line, 3)
      assert.match(problems[0].message, /is not one of proposal, approved, in progress, implemented/)
    }
  })
})

describe('the workspace README', () => {
  const complete = [
    '# Project',
    '',
    '## Goal',
    '',
    'A ledger for agents.',
    '',
    '## Environments',
    '',
    'Local only.',
    '',
    '## Manual checks',
    '',
    'None.',
    ''
  ].join('\n')

  test('parses sections and passes when complete, in CRLF text', () => {
    const readme = parseReadme(README_FILE, complete.replaceAll('\n', '\r\n'))
    assert.equal(readme.file, README_FILE)
    assert.deepEqual([...readme.sections.keys()], ['Goal', 'Environments', 'Manual checks'])
    assert.deepEqual(readme.sections.get('Goal'), { line: 3, body: 'A ledger for agents.' })
    assert.deepEqual(readme.markers, [])
    assert.deepEqual(validateReadme(readme), [])
  })

  test('keeps ### subsections in a section body, and Risks is optional', () => {
    const readme = parseReadme(README_FILE, `${complete}\n## Risks\n\n### Scope\n\nToo much.\n`)
    assert.equal(readme.sections.get('Risks').body, '### Scope\n\nToo much.')
    assert.deepEqual(validateReadme(readme), [])
  })

  test('compares the required section names case-insensitively', () => {
    const readme = parseReadme(README_FILE, complete.replace('## Manual checks', '## Manual Checks'))
    assert.deepEqual(validateReadme(readme), [])
  })

  test('reports a missing section', () => {
    const problems = validateReadme(parseReadme(README_FILE, complete.replace('## Environments', '## Hosting')))
    assert.deepEqual(messages(problems), ['the README has no "## Environments" section; add it with the project\'s own text'])
    assert.equal(problems[0].line, 0)
  })

  test('reports an empty section', () => {
    const problems = validateReadme(parseReadme(README_FILE, complete.replace('A ledger for agents.', '')))
    assert.equal(problems.length, 1)
    assert.equal(problems[0].line, 3)
    assert.match(problems[0].message, /"## Goal" is empty/)
  })

  test('a marker keeps the shape valid, and is reported for handoff until the text is written', () => {
    const marked = complete.replace('A ledger for agents.', `${SETUP_MARKER}: what is being built, for whom.`).replace('None.', `${SETUP_MARKER}`)
    const readme = parseReadme(README_FILE, marked)
    assert.deepEqual(readme.markers, [5, 13])
    assert.deepEqual(validateReadme(readme), [])
    const problems = readmeMarkerProblems(readme)
    assert.equal(problems.length, 2)
    assert.deepEqual(problems.map((problem) => [problem.file, problem.line]), [[README_FILE, 5], [README_FILE, 13]])
    assert.match(problems[0].message, /write the project's own text here/)
    assert.deepEqual(readmeMarkerProblems(parseReadme(README_FILE, complete)), [])
  })

  test('reports every required section of an empty README', () => {
    assert.equal(validateReadme(parseReadme(README_FILE, '')).length, 3)
  })
})

test('decision and log field names are exact, and a near miss names the right spelling', () => {
  const decision = parseDecision(
    'ledger/decisions/2026-10-14-exact-fields.md',
    '# Exact fields\n\n- Date: 2026-10-14\n- Decided By: Niko\n'
  )
  const problems = validateDecision(decision, { exists: () => true })
  assert.ok(problems.some((problem) => /"Decided By" is not known; write it as "Decided by"/.test(problem.message)), JSON.stringify(problems))
  assert.ok(problems.some((problem) => /Decided by/.test(problem.message)))
  const entry = parseLogEntry('ledger/log/2026-10-14-a-day.md', '# 2026-10-14 · A day\n\n- tasks: S1\n')
  const logProblems = validateLogEntry(entry, { exists: () => true, taskIds: new Set(['S1']) })
  assert.ok(logProblems.some((problem) => /"tasks" is not known; write it as "Tasks"/.test(problem.message)), JSON.stringify(logProblems))
})
