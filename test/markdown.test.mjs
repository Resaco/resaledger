// The Markdown primitives: lines, headings and anchors, sections, links and bullet fields.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  findSection,
  headings,
  isEmptyValue,
  parseFields,
  relativeLinks,
  resolveLinkPath,
  splitLines
} from '../src/guard/markdown.mjs'

describe('splitLines', () => {
  test('treats CRLF and lone CR as LF', () => {
    assert.deepEqual(splitLines('a\r\nb\rc\nd'), ['a', 'b', 'c', 'd'])
  })

  test('drops the empty element after a trailing newline, and keeps inner blank lines', () => {
    assert.deepEqual(splitLines('a\n\nb\n'), ['a', '', 'b'])
    assert.deepEqual(splitLines('a\r\n'), ['a'])
    assert.deepEqual(splitLines(''), [])
    assert.deepEqual(splitLines('a\n\n'), ['a', ''])
  })
})

describe('headings', () => {
  test('finds levels, text, anchors and 1-based lines in CRLF text', () => {
    const text = '# S4 Store projects\r\n\r\n- Status: doing\r\n\r\n## Handoff\r\n###### Deep\r\n'
    assert.deepEqual(headings(text), [
      { level: 1, text: 'S4 Store projects', anchor: 's4-store-projects', line: 1 },
      { level: 2, text: 'Handoff', anchor: 'handoff', line: 5 },
      { level: 6, text: 'Deep', anchor: 'deep', line: 6 }
    ])
  })

  test('needs a space after the hashes and at most six of them', () => {
    assert.deepEqual(headings('#tag\n####### seven\n#\tTab'), [{ level: 1, text: 'Tab', anchor: 'tab', line: 3 }])
  })

  test('keeps Finnish and other non-ASCII letters in anchors', () => {
    const anchors = headings('# Työn tila ja jäljellä oleva\n## Åland – päätös\n## Straße 東京 Ünïcödé\n').map((h) => h.anchor)
    assert.deepEqual(anchors, ['työn-tila-ja-jäljellä-oleva', 'åland--päätös', 'straße-東京-ünïcödé'])
  })

  test('removes punctuation, keeps hyphens and underscores, and uses link text', () => {
    const anchors = headings(
      '## 5.3 Task files\n## What `check` does?\n## See [the plan](plan.md#x) now\n## snake_case & more-dashes!\n'
    ).map((h) => h.anchor)
    assert.deepEqual(anchors, ['53-task-files', 'what-check-does', 'see-the-plan-now', 'snake_case--more-dashes'])
  })

  test('numbers duplicate anchors in order, past anchors that are already taken', () => {
    const anchors = headings('# Notes\n## Notes\n### Notes-1\n## Notes\n## notes\n').map((h) => h.anchor)
    assert.deepEqual(anchors, ['notes', 'notes-1', 'notes-1-1', 'notes-2', 'notes-3'])
  })

  test('strips a closing run of hashes but not a hash inside a word', () => {
    const found = headings('## Plan ##\n# C#\n### Done ###   \n# #\n')
    assert.deepEqual(
      found.map((h) => [h.text, h.anchor]),
      [
        ['Plan', 'plan'],
        ['C#', 'c'],
        ['Done', 'done'],
        ['', '']
      ]
    )
  })

  test('skips headings inside backtick and tilde fences', () => {
    const text = [
      '# Real',
      '```markdown',
      '# Not a heading',
      '~~~',
      '# Still inside: a tilde does not close a backtick fence',
      '```',
      '## After backticks',
      '~~~~',
      '# Inside tildes',
      '~~~',
      '# A shorter fence does not close it',
      '~~~~~',
      '## After tildes',
      '````',
      '# Unclosed fence runs to the end'
    ].join('\n')
    assert.deepEqual(
      headings(text).map((h) => [h.text, h.line]),
      [
        ['Real', 1],
        ['After backticks', 7],
        ['After tildes', 13]
      ]
    )
  })
})

describe('findSection', () => {
  const text = [
    '# Plan', // 1
    'Intro.', // 2
    '## Goal', // 3
    'Ship it.', // 4
    '### Detail', // 5
    'Fine print.', // 6
    '## Acceptance', // 7
    'Tests pass.', // 8
    '# Other', // 9
    'Elsewhere.' // 10
  ].join('\r\n')

  test('a section runs to the next heading of the same or a higher level', () => {
    const goal = findSection(text, 'goal')
    assert.equal(goal.line, 3)
    assert.equal(goal.heading.text, 'Goal')
    assert.deepEqual(goal.lines, ['Ship it.', '### Detail', 'Fine print.'])
    assert.deepEqual(findSection(text, 'detail').lines, ['Fine print.'])
    assert.deepEqual(findSection(text, 'acceptance').lines, ['Tests pass.'])
  })

  test('a top-level section holds its subsections, and the last runs to the end', () => {
    assert.deepEqual(findSection(text, 'plan').lines, splitLines(text).slice(1, 8))
    assert.deepEqual(findSection(text, 'other').lines, ['Elsewhere.'])
  })

  test('ignores case, finds numbered duplicates and returns null for a missing anchor', () => {
    assert.equal(findSection(text, 'ACCEPTANCE').line, 7)
    assert.equal(findSection('# A\none\n# A\ntwo\n', 'a-1').lines[0], 'two')
    assert.equal(findSection(text, 'missing'), null)
  })

  test('works with non-ASCII anchors', () => {
    assert.deepEqual(findSection('# Yö\n\nUni.\n', 'YÖ').lines, ['', 'Uni.'])
  })
})

describe('relativeLinks', () => {
  test('finds links and images with paths, anchors and lines', () => {
    const text = [
      '- Plan: [S-server.md](../plan/S-server.md#s4-store-projects)',
      'See ![chart](images/chart.png) and [notes](notes.md "Title").'
    ].join('\r\n')
    assert.deepEqual(relativeLinks(text), [
      { target: '../plan/S-server.md#s4-store-projects', path: '../plan/S-server.md', anchor: 's4-store-projects', line: 1 },
      { target: 'images/chart.png', path: 'images/chart.png', anchor: '', line: 2 },
      { target: 'notes.md', path: 'notes.md', anchor: '', line: 2 }
    ])
  })

  test('decodes percent-encoding and reads the angle-bracket form with spaces', () => {
    const links = relativeLinks('[a](my%20file.md#ty%C3%B6n-tila) [b](<folder/with space.md#x>) [c](bad%E0%A4%A.md)')
    assert.deepEqual(
      links.map((link) => [link.path, link.anchor]),
      [
        ['my file.md', 'työn-tila'],
        ['folder/with space.md', 'x'],
        ['bad%E0%A4%A.md', '']
      ]
    )
    assert.equal(links[1].target, 'folder/with space.md#x')
  })

  test('skips external links and links to an anchor in the same file', () => {
    const text =
      '[w](https://example.com/a.md) [m](mailto:someone@example.com) [p](//cdn.example.com/x) [f](file:///x) [h](#plan) [k](ok.md)'
    assert.deepEqual(
      relativeLinks(text).map((link) => link.path),
      ['ok.md']
    )
  })

  test('skips links inside inline code and fenced code', () => {
    const text = [
      'Write `[label](skip.md)` or ``a ` [b](skip2.md)`` then [real](real.md).',
      '```',
      '[fenced](skip3.md)',
      '```',
      '~~~',
      '[tilde](skip4.md)',
      '~~~',
      '[after](after.md)'
    ].join('\n')
    assert.deepEqual(
      relativeLinks(text).map((link) => [link.path, link.line]),
      [
        ['real.md', 1],
        ['after.md', 8]
      ]
    )
  })

  test('keeps parentheses that are balanced inside a path', () => {
    assert.deepEqual(
      relativeLinks('[x](docs/a(1).md)').map((link) => link.path),
      ['docs/a(1).md']
    )
  })
})

describe('resolveLinkPath', () => {
  test('resolves relative to the linking file', () => {
    assert.equal(resolveLinkPath('ledger/tasks/S4.md', '../plan/S-server.md'), 'ledger/plan/S-server.md')
    assert.equal(resolveLinkPath('ledger/tasks/S4.md', './S5.md'), 'ledger/tasks/S5.md')
    assert.equal(resolveLinkPath('README.md', 'docs/a.md'), 'docs/a.md')
    assert.equal(resolveLinkPath('ledger/tasks/S4.md', '../../src/'), 'src')
  })

  test('stays inside the repository with .. and returns null when it climbs out', () => {
    assert.equal(resolveLinkPath('ledger/tasks/S4.md', '../../README.md'), 'README.md')
    assert.equal(resolveLinkPath('ledger/tasks/S4.md', '../../../outside.md'), null)
    assert.equal(resolveLinkPath('README.md', '../x.md'), null)
    assert.equal(resolveLinkPath('README.md', '..'), null)
  })

  test('a leading slash starts at the repository root', () => {
    assert.equal(resolveLinkPath('ledger/tasks/S4.md', '/src/guard/main.mjs'), 'src/guard/main.mjs')
  })
})

describe('parseFields', () => {
  test('reads fields with nested evidence lists and stops at a blank line', () => {
    const lines = splitLines(
      [
        '# S4 Store projects', // 0
        '', // 1
        '- Status: done', // 2
        '- Depends on: S1, S3', // 3
        '- Evidence:', // 4
        '  - `npm test -- server/storage`: 14 of 14', // 5
        '  - Checked by hand: [storage.md](../evidence/storage.md)', // 6
        '    at 1440 and 390 px', // 7
        '  - Not verified: Safari', // 8
        '- Notes: —', // 9
        '', // 10
        '## Notes' // 11
      ].join('\r\n')
    )
    const { fields, end } = parseFields(lines, 1)
    assert.equal(end, 10)
    assert.deepEqual(fields, [
      { name: 'Status', value: 'done', items: [], line: 3 },
      { name: 'Depends on', value: 'S1, S3', items: [], line: 4 },
      {
        name: 'Evidence',
        value: '',
        items: [
          '`npm test -- server/storage`: 14 of 14',
          'Checked by hand: [storage.md](../evidence/storage.md) at 1440 and 390 px',
          'Not verified: Safari'
        ],
        line: 5
      },
      { name: 'Notes', value: '—', items: [], line: 10 }
    ])
  })

  test('an indented line without a bullet continues the value', () => {
    const { fields, end } = parseFields(['- Reason: split into', '  S7.1 and S7.2,', '\tas planned'], 0)
    assert.equal(end, 3)
    assert.deepEqual(fields[0], { name: 'Reason', value: 'split into S7.1 and S7.2, as planned', items: [], line: 1 })
  })

  test('the list ends at a heading', () => {
    const { fields, end } = parseFields(['- Status: todo', '## Plan', '- Lane: x'], 0)
    assert.equal(end, 1)
    assert.deepEqual(
      fields.map((field) => field.name),
      ['Status']
    )
  })

  test('the list ends at plain text and at a bullet that is not a field', () => {
    assert.equal(parseFields(['- Status: todo', 'Some prose.', '- Lane: x'], 0).end, 1)
    assert.equal(parseFields(['- Status: todo', '- just a note', '- Lane: x'], 0).end, 1)
    assert.equal(parseFields(['- Status: todo', '- Lane2: x'], 0).end, 1)
  })

  test('keeps duplicate field names in order', () => {
    const { fields } = parseFields(['- Status: todo', '- Status: done', '- Staus: doing'], 0)
    assert.deepEqual(
      fields.map((field) => [field.name, field.value, field.line]),
      [
        ['Status', 'todo', 1],
        ['Status', 'done', 2],
        ['Staus', 'doing', 3]
      ]
    )
  })

  test('reads non-ASCII field names and values', () => {
    const { fields } = parseFields(['- Tila: työn alla', '- Päätös tehty: kyllä'], 0)
    assert.deepEqual(
      fields.map((field) => [field.name, field.value]),
      [
        ['Tila', 'työn alla'],
        ['Päätös tehty', 'kyllä']
      ]
    )
  })

  test('returns no fields and end = start when no field list starts there', () => {
    assert.deepEqual(parseFields(['Prose first.', '- Status: todo'], 0), { fields: [], end: 0 })
    assert.deepEqual(parseFields(['', ''], 0), { fields: [], end: 0 })
    assert.deepEqual(parseFields([], 0), { fields: [], end: 0 })
  })
})

describe('isEmptyValue', () => {
  test('is true for nothing and for dashes, false for anything else', () => {
    for (const value of ['', '—', '–', '-', '  —  ']) assert.equal(isEmptyValue(value), true, JSON.stringify(value))
    for (const value of ['none', '0', '--', 'S1']) assert.equal(isEmptyValue(value), false, value)
  })
})
