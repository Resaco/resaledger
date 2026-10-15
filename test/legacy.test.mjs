// Reading agent-ledger 0.x workspaces: every parser on synthetic fixtures that cover the
// quirks of real workspaces, this repository's own 0.x records, and the lossless check.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import {
  LEGACY_FILES,
  legacyDecisionsLines,
  legacyLedgerLines,
  legacyLogLines,
  legacyManualGates,
  legacyProjectRules,
  legacyReadmeParts,
  legacyRecordLines,
  legacySectionsLines,
  legacyStatusLines,
  legacyTableCells,
  lostLegacyLines,
  parseLegacyAgents,
  parseLegacyConfig,
  parseLegacyDecisions,
  parseLegacyLedger,
  parseLegacyLog,
  parseLegacyReadme,
  parseLegacyStandards,
  parseLegacyStatus,
  readLegacyWorkspace
} from '../src/cli/legacy.mjs'
import { legacyClone, temporary } from './helpers.mjs'

// This repository at its last 0.x commit.
const LEGACY = legacyClone()

const crlf = (text) => text.replace(/\n/g, '\r\n')

const LEDGER = `# Task ledger

Every task, in the order it should be done.

- **Legend**: \`doing\` means claimed.

## A: Groundwork

Text under the phase heading, before its first task.

| Step | What |
| --- | --- |
| 1 | Lay the base |

## B: Overview only

1. A phase with a list and no tasks.
2. Second item.

## C: The work

### C1 Lay the base
- Status: done
- Lane: main
- Depends on: —
- Plan: [C-work.md](../plan/C-work.md#c1-lay-the-base)
- Evidence: \`npm test\` passes, 12 of 12.
  The second line of the evidence, indented.
- Notes: —

Afterwards a paragraph about the task.

- a bullet after the fields
  - a nested bullet
#### A deeper heading stays inside the task

### C1.2 A child task
- Status: doing
- Depends on: C1
- Plan: [C-work.md](../plan/C-work.md#c12-a-child-task)
- Evidence: —
- Notes: next step written here

### c3 Lowercase id is not valid
- Status: todo
- Depends on: —
- Plan: —
- Evidence: —
- Notes: —

### Just a heading

Loose text that 0.x read as outside any task.

### C4 Duplicate field
- Status: todo
- Status: blocked
- Depends on: C1, C1.2
- Plan: —
- Evidence: —
- Notes: waiting for the owner
`

const LOG_HEAD = `# Session log

What each session did, oldest first.
`
const logEntries = (count) =>
  Array.from({ length: count }, (_, index) => `## 2026-03-04 · Session ${index + 1}\n\nWork number ${index + 1} was done.\n\n### A subheading\n\n- a detail ${index + 1}\n`).join('\n')

const DECISIONS = `# Decisions

Decisions the owner made.

A second paragraph before the table.

| Date | Decision | Decided by |
| --- | --- | --- |
| 2026-01-02 | Use \`a \\| b\` as the separator, because both sides read it. | Owner |

| 2026-01-03 | A row after a blank line, with a fourth cell. | Owner | extra |
| 2026-01-04 | A row with a missing cell. |
|   2026-01-05   |   Padded cells.   |   Lead agent   |

Text after the table: rows dated before January were reconstructed.
`

const STATUS = `# Status

Updated: 2026-03-04 · by the lead agent

## Phase

Building.

## Active work

[C1.2](work/ledger.md#c12-a-child-task).

## Last verified

- \`npm test\` passed.

## Next step

Finish C1.2.

## Waiting for the owner

Nothing.

## Risks

An extra section the project added.
`

const README = `# Sample workspace

Read in this order.

## What is being built

A small tool for counting things.

## Where the code is

- \`src/\`: the code.

## Environments

| Environment | Address | Role |
| --- | --- | --- |
| Local | — | development |
`

const STANDARDS = `# Working standards

## The task ledger

\`\`\`md
## Not a heading, it is in a fence
### S1 Storage interface
\`\`\`

## Definition of done

Extra section.

## Quality gates

Before a task is \`done\`, two kinds of gates pass.

**Gates that need eyes or judgement** are listed here:

1. **The page looks right.** Compared at 375 and 1280 px.
   Passing: no overflow.
2. **The data comes out unchanged.** Passing: the diff is empty.

The last gate is always the same: handoff passes.
`

const AGENTS = `# Sample workspace: agent rules

## Start here, every session

1. Read STATUS.md.

## Project rules

1. **Tuotantoon ei kirjoiteta ilman lupaa.** Syy: asiakkaan tiedot ovat siellä.
2. **Kaikki siirrot tehdään skriptillä.** Syy: käsin tehty vaihe unohtuu.

## Working agreements

- Records are written in English.
`

const CONFIG = {
  version: 1,
  mode: 'ledger',
  dir: 'work-space',
  aiAttribution: 'forbid',
  codePaths: ['app'],
  gates: { commit: ['npm run lint'], verify: ['npm test'], skipPaths: ['docs'] },
  commitStyle: 'free',
  branches: { protected: ['main'], pattern: '^(feat|fix)/' },
  requirePushed: true,
  agent: { deny: [{ pattern: 'git\\s+push', reason: 'Vain omistaja pushaa.' }] },
  customKey: { kept: true }
}

/** Asserts that every non-empty input line is in the rendered output. */
function assertLossless(text, lines) {
  assert.deepEqual(lostLegacyLines(text, lines), [])
}

describe('parseLegacyConfig', () => {
  test('keeps every key, commitStyle and deny rules included', () => {
    const { config, problems } = parseLegacyConfig(JSON.stringify(CONFIG, null, 2))
    assert.deepEqual(problems, [])
    assert.deepEqual(config, CONFIG)
    assert.equal(config.agent.deny[0].reason, 'Vain omistaja pushaa.')
  })

  test('refuses guard mode with the reason', () => {
    const { config, problems } = parseLegacyConfig(JSON.stringify({ version: 1, mode: 'guard', dir: 'project' }))
    assert.equal(config.mode, 'guard')
    assert.equal(problems.length, 1)
    assert.match(problems[0].message, /guard-only mode is not part of ResaLedger 1\.0/)
  })

  test('reports invalid JSON, an unknown version and a bad dir', () => {
    assert.equal(parseLegacyConfig('{').config, null)
    assert.match(parseLegacyConfig('{').problems[0].message, /not valid JSON/)
    const messages = parseLegacyConfig('{"version": 2, "dir": "../x"}').problems.map((item) => item.message)
    assert.equal(messages.length, 2)
    assert.match(messages[0], /version/)
    assert.match(messages[1], /dir/)
  })
})

describe('parseLegacyLedger', () => {
  const ledger = parseLegacyLedger(LEDGER)

  test('keeps the preamble and the phases with the text under them', () => {
    assert.match(ledger.preamble, /^# Task ledger\n\nEvery task/)
    assert.match(ledger.preamble, /\*\*Legend\*\*/)
    assert.deepEqual(
      ledger.phases.map((phase) => [phase.heading, phase.line, phase.anchor]),
      [
        ['A: Groundwork', 7, 'a-groundwork'],
        ['B: Overview only', 15, 'b-overview-only'],
        ['C: The work', 20, 'c-the-work']
      ]
    )
    assert.equal(ledger.phases[0].text, 'Text under the phase heading, before its first task.\n\n| Step | What |\n| --- | --- |\n| 1 | Lay the base |')
    assert.equal(ledger.phases[1].text, '1. A phase with a list and no tasks.\n2. Second item.')
    assert.equal(ledger.phases[2].text, '')
  })

  test('reads tasks, sub-ids, fields, unknown fields and extra lines', () => {
    assert.deepEqual(
      ledger.tasks.map((task) => [task.id, task.valid, task.phase]),
      [
        ['C1', true, 'C: The work'],
        ['C1.2', true, 'C: The work'],
        ['c3', false, 'C: The work'],
        ['C4', true, 'C: The work']
      ]
    )
    const [first, child] = ledger.tasks
    assert.equal(first.title, 'Lay the base')
    assert.equal(first.line, 22)
    assert.equal(first.anchor, 'c1-lay-the-base')
    assert.deepEqual(Object.keys(first.fields), ['Status', 'Lane', 'Depends on', 'Plan', 'Evidence', 'Notes'])
    assert.equal(first.fields.Lane, 'main')
    assert.equal(first.fields.Evidence, '`npm test` passes, 12 of 12.')
    assert.deepEqual(first.extra, [
      '  The second line of the evidence, indented.',
      '',
      'Afterwards a paragraph about the task.',
      '',
      '- a bullet after the fields',
      '  - a nested bullet',
      '#### A deeper heading stays inside the task'
    ])
    assert.equal(child.anchor, 'c12-a-child-task')
    assert.equal(child.fields['Depends on'], 'C1')
    assert.equal(child.fields.Notes, 'next step written here')
  })

  test('reports an invalid id, a stray heading and a duplicate field, and keeps them', () => {
    const messages = ledger.problems.map((item) => `${item.line}: ${item.message}`)
    assert.equal(messages.length, 3, messages.join('\n'))
    assert.match(messages[0], /^44: .*"c3" is not a 0\.x task id/)
    assert.match(messages[1], /^51: .*"### Just a heading" is not a task heading/)
    assert.match(messages[2], /^57: C4: a second "Status" field/)
    const stray = ledger.tasks[2]
    assert.deepEqual(stray.extra, ['### Just a heading', '', 'Loose text that 0.x read as outside any task.'])
    const duplicate = ledger.tasks[3]
    assert.equal(duplicate.fields.Status, 'blocked')
    assert.deepEqual(duplicate.extra, ['- Status: todo'])
    assert.deepEqual(duplicate.attached, [])
    assert.deepEqual(ledger.tasks[0].attached, [{ name: 'Evidence', index: 0 }])
  })

  test('reads CRLF text the same, and keeps every line', () => {
    assert.deepEqual(parseLegacyLedger(crlf(LEDGER)), ledger)
    assertLossless(LEDGER, legacyLedgerLines(ledger))
    assertLossless(crlf(LEDGER), legacyLedgerLines(parseLegacyLedger(crlf(LEDGER))))
  })

  test('the lossless check finds a dropped line, also a repeated one', () => {
    const lines = legacyLedgerLines(ledger)
    const without = lines.filter((line) => line !== 'Afterwards a paragraph about the task.')
    assert.deepEqual(lostLegacyLines(LEDGER, without), [{ line: 31, text: 'Afterwards a paragraph about the task.' }])
    const once = lines.filter((line, index) => line !== '- Evidence: —' || index === lines.indexOf('- Evidence: —'))
    assert.equal(lostLegacyLines(LEDGER, once).length, 2)
  })
})

describe('parseLegacyLog', () => {
  const text = `${LOG_HEAD}\n${logEntries(25)}\n## Not an entry\n\nText under a stray heading.\n`
  const log = parseLegacyLog(text)

  test('splits 25 entries on one day, with bodies verbatim', () => {
    assert.equal(log.preamble, '# Session log\n\nWhat each session did, oldest first.')
    assert.equal(log.entries.length, 25)
    assert.ok(log.entries.every((entry) => entry.date === '2026-03-04'))
    assert.deepEqual(log.entries.slice(0, 2).map((entry) => [entry.title, entry.heading, entry.line, entry.anchor]), [
      ['Session 1', '2026-03-04 · Session 1', 5, '2026-03-04--session-1'],
      ['Session 2', '2026-03-04 · Session 2', 13, '2026-03-04--session-2']
    ])
    assert.equal(log.entries[0].body, 'Work number 1 was done.\n\n### A subheading\n\n- a detail 1')
  })

  test('keeps a heading that is not an entry in the body before it, and reports it', () => {
    assert.match(log.entries[24].body, /## Not an entry\n\nText under a stray heading\.$/)
    assert.equal(log.problems.length, 1)
    assert.match(log.problems[0].message, /"## Not an entry" is not a log entry heading/)
  })

  test('keeps every line, with CRLF too', () => {
    assertLossless(text, legacyLogLines(log))
    assert.deepEqual(parseLegacyLog(crlf(text)), log)
  })
})

describe('parseLegacyDecisions', () => {
  const decisions = parseLegacyDecisions(DECISIONS)

  test('reads the table with escaped pipes, odd rows, padding and blank lines', () => {
    assert.equal(decisions.preamble, '# Decisions\n\nDecisions the owner made.\n\nA second paragraph before the table.')
    assert.deepEqual(decisions.header, { cells: ['Date', 'Decision', 'Decided by'], line: 7, separator: '| --- | --- | --- |' })
    assert.equal(decisions.rows.length, 4)
    assert.deepEqual(decisions.rows[0], {
      date: '2026-01-02',
      decision: 'Use `a | b` as the separator, because both sides read it.',
      decidedBy: 'Owner',
      cells: ['2026-01-02', 'Use `a | b` as the separator, because both sides read it.', 'Owner'],
      line: 9
    })
    assert.deepEqual(decisions.rows[1].cells, ['2026-01-03', 'A row after a blank line, with a fourth cell.', 'Owner', 'extra'])
    assert.equal(decisions.rows[2].decidedBy, '')
    assert.deepEqual(decisions.rows[3].cells, ['2026-01-05', 'Padded cells.', 'Lead agent'])
    assert.equal(decisions.trailing, 'Text after the table: rows dated before January were reconstructed.')
    assert.deepEqual(
      decisions.problems.map((item) => item.line),
      [11, 12]
    )
  })

  test('finds the columns by the header names', () => {
    const text = '| Decided by | Date | Why | Decision |\n|---|---|---|---|\n| Owner | 2026-02-01 | because | Ship it |\n'
    const [row] = parseLegacyDecisions(text).rows
    assert.deepEqual([row.date, row.decision, row.decidedBy], ['2026-02-01', 'Ship it', 'Owner'])
  })

  test('splits cells at unescaped pipes only', () => {
    assert.deepEqual(legacyTableCells('| a \\| b | c |'), ['a | b', 'c'])
    assert.deepEqual(legacyTableCells('a | b'), ['a', 'b'])
  })

  test('keeps every line, with CRLF too', () => {
    assertLossless(DECISIONS, legacyDecisionsLines(decisions))
    assert.deepEqual(parseLegacyDecisions(crlf(DECISIONS)), decisions)
  })
})

describe('parseLegacyStatus', () => {
  const status = parseLegacyStatus(STATUS)

  test('reads the Updated line, the five sections and an extra one', () => {
    assert.deepEqual(status.updated, { date: '2026-03-04', by: 'the lead agent', text: 'Updated: 2026-03-04 · by the lead agent', line: 3 })
    assert.deepEqual([...status.sections.keys()], ['Phase', 'Active work', 'Last verified', 'Next step', 'Waiting for the owner', 'Risks'])
    assert.equal(status.sections.get('Risks').text, 'An extra section the project added.')
    assert.equal(status.sections.get('Phase').line, 5)
    assert.equal(status.extra, '')
    assert.deepEqual(status.problems, [])
  })

  test('reports a missing section and a missing Updated line', () => {
    const messages = parseLegacyStatus('# Status\n\nStray text.\n\n## Phase\n\nx\n').problems.map((item) => item.message)
    assert.equal(messages.length, 5)
    assert.match(messages[0], /Updated/)
    assert.equal(parseLegacyStatus('# Status\n\nStray text.\n').extra, 'Stray text.')
  })

  test('keeps every line, with CRLF too', () => {
    assertLossless(STATUS, legacyStatusLines(status))
    assert.deepEqual(parseLegacyStatus(crlf(STATUS)), status)
  })
})

describe('README, standards.md and AGENTS.md', () => {
  test('README: sections by heading, and the parts spec 14 maps', () => {
    const readme = parseLegacyReadme(README)
    assert.deepEqual(readme.title, { text: 'Sample workspace', line: 1 })
    assert.equal(readme.preamble, 'Read in this order.')
    assert.deepEqual(legacyReadmeParts(readme), {
      whatIsBeingBuilt: 'A small tool for counting things.',
      whereTheCodeIs: '- `src/`: the code.',
      environments: '| Environment | Address | Role |\n| --- | --- | --- |\n| Local | — | development |'
    })
    assertLossless(README, legacySectionsLines(readme))
    assert.deepEqual(parseLegacyReadme(crlf(README)), readme)
  })

  test('standards.md: headings in fences are text, and the manual gates come out', () => {
    const standards = parseLegacyStandards(STANDARDS)
    assert.deepEqual([...standards.sections.keys()], ['The task ledger', 'Definition of done', 'Quality gates'])
    assert.match(standards.sections.get('The task ledger').text, /## Not a heading/)
    const gates = legacyManualGates(standards)
    assert.deepEqual(gates.items, [
      '**The page looks right.** Compared at 375 and 1280 px.\n   Passing: no overflow.',
      '**The data comes out unchanged.** Passing: the diff is empty.'
    ])
    assert.match(gates.text, /^1\. \*\*The page/)
    assert.equal(gates.other, 'The last gate is always the same: handoff passes.')
    assertLossless(STANDARDS, legacySectionsLines(standards))
    assert.equal(legacyManualGates(parseLegacyStandards('# S\n')), null)
  })

  test('standards.md: a placeholder instead of gates gives no items', () => {
    const gates = legacyManualGates(parseLegacyStandards('## Quality gates\n\n**Gates that need eyes or judgement** are listed here:\n\nTODO(agent-ledger): the gates.\n'))
    assert.deepEqual(gates.items, [])
    assert.equal(gates.other, 'TODO(agent-ledger): the gates.')
  })

  test('AGENTS.md: project rules in another language, verbatim', () => {
    const agents = parseLegacyAgents(AGENTS)
    assert.equal(
      legacyProjectRules(agents),
      '1. **Tuotantoon ei kirjoiteta ilman lupaa.** Syy: asiakkaan tiedot ovat siellä.\n2. **Kaikki siirrot tehdään skriptillä.** Syy: käsin tehty vaihe unohtuu.'
    )
    assertLossless(AGENTS, legacySectionsLines(agents))
    assert.equal(legacyProjectRules(parseLegacyAgents('# x\n')), null)
  })

  test('a repeated section heading is kept under a numbered key', () => {
    const parsed = parseLegacyReadme('# R\n\n## Notes\n\none\n\n## Notes\n\ntwo\n')
    assert.deepEqual([...parsed.sections.keys()], ['Notes', 'Notes (2)'])
    assert.equal(parsed.problems.length, 1)
    assertLossless('# R\n\n## Notes\n\none\n\n## Notes\n\ntwo\n', legacySectionsLines(parsed))
  })
})

function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}

describe('readLegacyWorkspace', () => {
  test('reads a whole synthetic workspace with CRLF files, extra Markdown and an image folder', () => {
    const root = temporary()
    const dir = CONFIG.dir
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    writeFiles(root, {
      '.agent-ledger.json': JSON.stringify(CONFIG, null, 2),
      [`${dir}/README.md`]: README,
      [`${dir}/AGENTS.md`]: AGENTS,
      [`${dir}/STATUS.md`]: crlf(STATUS),
      [`${dir}/DECISIONS.md`]: crlf(DECISIONS),
      [`${dir}/standards.md`]: STANDARDS,
      [`${dir}/work/ledger.md`]: crlf(LEDGER),
      [`${dir}/work/log.md`]: `${LOG_HEAD}\n${logEntries(25)}`,
      [`${dir}/work/verified.json`]: '{}\n',
      [`${dir}/DESIGN.md`]: '# Design notes\n',
      [`${dir}/plan/README.md`]: '# Plan\n',
      [`${dir}/progress/.gitkeep`]: '',
      [`${dir}/design/screen-1.png`]: png,
      [`${dir}/design/screen-2.png`]: png,
      [`${dir}/scripts/records.mjs`]: '// guard\n'
    })
    const workspace = readLegacyWorkspace(root)
    assert.equal(workspace.dir, dir)
    assert.deepEqual(workspace.config, CONFIG)
    assert.deepEqual(workspace.files, [
      `${dir}/AGENTS.md`,
      `${dir}/DECISIONS.md`,
      `${dir}/DESIGN.md`,
      `${dir}/README.md`,
      `${dir}/STATUS.md`,
      `${dir}/design/screen-1.png`,
      `${dir}/design/screen-2.png`,
      `${dir}/plan/README.md`,
      `${dir}/progress/.gitkeep`,
      `${dir}/scripts/records.mjs`,
      `${dir}/standards.md`,
      `${dir}/work/ledger.md`,
      `${dir}/work/log.md`,
      `${dir}/work/verified.json`
    ])
    assert.equal(workspace.ledger.tasks.length, 4)
    assert.equal(workspace.log.entries.length, 25)
    assert.equal(workspace.decisions.rows.length, 4)
    assert.ok(workspace.status.sections.has('Risks'))
    assert.ok(workspace.problems.every((item) => item.file.startsWith(`${dir}/`)))
    assert.ok(workspace.problems.some((item) => item.file === `${dir}/work/ledger.md` && item.line === 44))
    for (const name of Object.keys(LEGACY_FILES)) {
      const path = `${dir}/${LEGACY_FILES[name]}`
      assertLossless(workspace.sources.get(path), legacyRecordLines(name, workspace[name]))
    }
  })

  test('reports a missing configuration, a guard-mode one and missing records, and writes nothing', () => {
    const empty = temporary()
    assert.match(readLegacyWorkspace(empty).problems[0].message, /is missing/)
    const guard = temporary()
    writeFiles(guard, { '.agent-ledger.json': JSON.stringify({ version: 1, mode: 'guard', dir: 'project' }), 'project/verified.json': '{}' })
    const workspace = readLegacyWorkspace(guard)
    assert.match(workspace.problems[0].message, /guard-only mode/)
    assert.equal(workspace.problems.filter((item) => item.message === 'is missing').length, 7)
    assert.deepEqual(workspace.files, ['project/verified.json'])
  })
})

describe("this repository's own 0.x records", { skip: LEGACY === null && 'the history before this repository moved to 1.0 is not in this clone' }, () => {
  const workspace = LEGACY === null ? null : readLegacyWorkspace(LEGACY)
  const read = (path) => readFileSync(join(LEGACY, path), 'utf8')
  const count = (path, pattern) => read(path).split(/\r?\n/).filter((line) => pattern.test(line)).length

  test('parse without a problem, with the counts of a plain line scan', () => {
    assert.equal(workspace.dir, 'ledger')
    assert.deepEqual(workspace.problems, [])
    // The records grow as the build goes on: these were the counts when M1 was written.
    assert.ok(workspace.ledger.tasks.length >= 50)
    assert.ok(workspace.ledger.phases.length >= 14)
    assert.ok(workspace.log.entries.length >= 11)
    assert.ok(workspace.decisions.rows.length >= 23)
    assert.equal(workspace.ledger.tasks.length, count('ledger/work/ledger.md', /^### /))
    assert.equal(workspace.ledger.phases.length, count('ledger/work/ledger.md', /^## /))
    assert.equal(workspace.log.entries.length, count('ledger/work/log.md', /^## \d{4}-\d{2}-\d{2} · /))
    assert.equal(workspace.decisions.rows.length, count('ledger/DECISIONS.md', /^\| \d{4}-/))
    assert.ok(workspace.ledger.tasks.some((task) => task.fields.Lane !== undefined))
    assert.deepEqual([...workspace.status.sections.keys()].slice(0, 5), ['Phase', 'Active work', 'Last verified', 'Next step', 'Waiting for the owner'])
    assert.equal(legacyManualGates(workspace.standards).items.length, 3)
    assert.match(legacyProjectRules(workspace.agents), /^1\. \*\*This repository will be public\.\*\*/)
    assert.match(legacyReadmeParts(workspace.readme).whatIsBeingBuilt, /^ResaLedger 1\.0/)
    assert.ok(workspace.files.includes('ledger/plan/spec.md'))
  })

  test('every non-empty line of every record is kept', () => {
    for (const name of Object.keys(LEGACY_FILES)) {
      const path = `ledger/${LEGACY_FILES[name]}`
      assert.deepEqual(lostLegacyLines(workspace.sources.get(path), legacyRecordLines(name, workspace[name])), [], path)
    }
  })
})
