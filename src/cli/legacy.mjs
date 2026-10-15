// Reads agent-ledger 0.x workspaces exactly as they are, for `migrate`. Every parser is a
// pure function over text that keeps every line: what it does not understand goes into a
// preamble, an extra list or a trailing text, never away. Each parser has a `…Lines`
// function that renders the parsed result back into lines, and lostLegacyLines() compares
// those with the input, so a test or migrate can prove that no line was dropped.
// Package side: the published package has no src/guard, so this file imports only node:.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const LEGACY_CONFIG_FILE = '.agent-ledger.json'
export const LEGACY_TASK_ID = /^[A-Z]\d+(?:\.\d+)?$/
export const LEGACY_TASK_FIELDS = ['Status', 'Depends on', 'Plan', 'Evidence', 'Notes']
export const LEGACY_STATUS_SECTIONS = ['Phase', 'Active work', 'Last verified', 'Next step', 'Waiting for the owner']
// The 0.x records, relative to the workspace folder.
export const LEGACY_FILES = Object.freeze({
  readme: 'README.md',
  agents: 'AGENTS.md',
  status: 'STATUS.md',
  decisions: 'DECISIONS.md',
  standards: 'standards.md',
  ledger: 'work/ledger.md',
  log: 'work/log.md'
})

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*$/
const LEGACY_FIELD = /^- ([A-Z][\p{L}]*(?: [\p{L}]+)*):(?:[ \t]+(.*))?$/u
const LOG_HEADING = /^## (\d{4}-\d{2}-\d{2}) · (.*\S)\s*$/
const UPDATED = /^Updated: (\d{4}-\d{2}-\d{2}) · by (\S.*?)\s*$/
const TASK_LIKE_ID = /^[A-Za-z]{1,4}\d[\w.-]*$/

/** The lines of a text: CRLF and lone CR as LF, a leading BOM dropped, no line after a final newline. */
function legacyLines(text) {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Lines joined back into a text, without the blank lines at either end. */
function legacyBlock(lines) {
  let start = 0
  let end = lines.length
  while (start < end && !lines[start].trim()) start += 1
  while (end > start && !lines[end - 1].trim()) end -= 1
  return lines.slice(start, end).join('\n')
}

/** For each line, the heading it is ({ level, text }) or null; headings inside fenced code are not headings. */
function legacyHeadings(lines) {
  let fence = null
  return lines.map((line) => {
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null
      return null
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = open[1]
      return null
    }
    const match = line.match(HEADING)
    return match ? { level: match[1].length, text: match[2] } : null
  })
}

/** GitHub's anchors for the headings of a file, numbered for duplicates, by line index. */
function legacyAnchors(heads) {
  const taken = new Map()
  const anchors = []
  heads.forEach((head, index) => {
    if (!head) return
    const base = head.text
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\p{Pc}\- ]/gu, '')
      .replaceAll(' ', '-')
    let anchor = base
    while (taken.has(anchor)) {
      const next = taken.get(base) + 1
      taken.set(base, next)
      anchor = `${base}-${next}`
    }
    taken.set(anchor, 0)
    anchors[index] = anchor
  })
  return anchors
}

function problem(file, line, message) {
  return { file, line, message }
}

/**
 * The 1-based line of the first byte in a buffer that is not part of valid UTF-8, or null when
 * the whole buffer is valid UTF-8: then decoding and encoding it again gives the same bytes.
 */
export function invalidUtf8Line(buffer) {
  let index = 0
  let line = 1
  while (index < buffer.length) {
    const byte = buffer[index]
    if (byte < 0x80) {
      if (byte === 0x0a) line += 1
      index += 1
      continue
    }
    // The length of the sequence and the range its second byte must be in (no overlong forms, no surrogates).
    let length = 0
    let low = 0x80
    let high = 0xbf
    if (byte >= 0xc2 && byte <= 0xdf) length = 2
    else if (byte >= 0xe0 && byte <= 0xef) {
      length = 3
      if (byte === 0xe0) low = 0xa0
      if (byte === 0xed) high = 0x9f
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      length = 4
      if (byte === 0xf0) low = 0x90
      if (byte === 0xf4) high = 0x8f
    } else return line
    if (index + length > buffer.length) return line
    if (buffer[index + 1] < low || buffer[index + 1] > high) return line
    for (let next = 2; next < length; next += 1) if (buffer[index + next] < 0x80 || buffer[index + next] > 0xbf) return line
    index += length
  }
  return null
}

/** The message for a line with a byte that is not UTF-8, which migrate refuses: it would replace the byte. */
export const INVALID_UTF8 = 'this line has a byte that is not UTF-8, which migrate would replace; re-save the file as UTF-8'

/** A file's text and, when it is not valid UTF-8, the line of the first bad byte (else null). */
export function readSourceText(path) {
  const buffer = readFileSync(path)
  return { text: buffer.toString('utf8'), invalidLine: invalidUtf8Line(buffer) }
}

// ── The configuration ──────────────────────────────────────────────────────────────

/** A version-1 .agent-ledger.json, every key kept as written. config is null when the text is not a JSON object. */
export function parseLegacyConfig(text, file = LEGACY_CONFIG_FILE) {
  const problems = []
  let config
  try {
    config = JSON.parse(text.replace(/^﻿/, ''))
  } catch (error) {
    return { config: null, problems: [problem(file, 0, `not valid JSON: ${error.message}`)] }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config))
    return { config: null, problems: [problem(file, 0, 'must be a JSON object')] }
  if (config.version !== 1)
    problems.push(problem(file, 0, `"version" is ${JSON.stringify(config.version)}; only an agent-ledger 0.x configuration (version 1) can be read`))
  const dir = String(config.dir ?? '').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!dir || dir.startsWith('/') || dir.split('/').includes('..'))
    problems.push(problem(file, 0, '"dir" must name the workspace folder inside the repository, for example "project"'))
  if (config.mode === 'guard')
    problems.push(
      problem(file, 0, '"mode" is "guard": guard-only mode is not part of ResaLedger 1.0, so this repository stays on agent-ledger 0.x')
    )
  return { config, problems }
}

/** The workspace folder a version-1 configuration names, as 0.x reads it, or null. */
export function legacyWorkspaceDir(config) {
  const dir = String(config?.dir ?? '').replace(/^\.\//, '').replace(/\/+$/, '')
  return !dir || dir.startsWith('/') || dir.split('/').includes('..') ? null : dir
}

// ── The task ledger ────────────────────────────────────────────────────────────────

/**
 * work/ledger.md: the preamble, the phase headings with the text under them, and the tasks.
 * A task's fields are the five 0.x fields wherever they stand in the task (the last one wins,
 * as in 0.x), plus any other `- Name: value` line in the field block right after the heading.
 * Every other line under the task is kept in extra, verbatim and in order: an earlier copy of
 * a field that appears twice stays where it stood, with its continuation lines after it.
 * attached lists the extra lines that continue a field that counts, such as a second line of
 * evidence, as { name, index } with index into extra: the indented lines in the block of
 * fields right after the heading.
 */
export function parseLegacyLedger(text, file = LEGACY_FILES.ledger) {
  const lines = legacyLines(text)
  const heads = legacyHeadings(lines)
  const anchors = legacyAnchors(heads)
  const preamble = []
  const phases = []
  const tasks = []
  const problems = []
  let phase = null
  let task = null
  let phaseLines = null
  let started = false

  const closePhaseText = () => {
    if (phase && phaseLines) phase.text = legacyBlock(phaseLines)
    phaseLines = null
  }

  lines.forEach((line, index) => {
    const head = heads[index]
    const number = index + 1
    if (head && head.level <= 2 && (started || head.level === 2)) {
      closePhaseText()
      started = true
      task = null
      phase = { heading: head.text, level: head.level, line: number, anchor: anchors[index], text: '' }
      phases.push(phase)
      phaseLines = []
      return
    }
    if (head && head.level === 3) {
      const [id = '', ...rest] = head.text.split(/\s+/)
      const valid = LEGACY_TASK_ID.test(id) && rest.length > 0
      let end = index + 1
      while (end < lines.length && !heads[end]) end += 1
      const hasStatus = lines.slice(index + 1, end).some((next) => /^- Status:/.test(next))
      if (valid || TASK_LIKE_ID.test(id) || hasStatus) {
        closePhaseText()
        started = true
        task = {
          id,
          title: rest.join(' '),
          line: number,
          anchor: anchors[index],
          phase: phase ? phase.heading : null,
          valid,
          fields: {},
          extra: [],
          attached: [],
          // Each line under the heading as { text, kind: 'field' | 'continuation' | 'extra', name }.
          entries: [],
          fieldBlock: true,
          // While the block of fields lasts, the field an indented line continues.
          continues: null,
          inBlock: true
        }
        tasks.push(task)
        if (!valid)
          problems.push(
            problem(file, number, `"### ${head.text}" looks like a task, but "${id}" is not a 0.x task id (a capital letter, a number and an optional .number) or the title is missing; it is kept`)
          )
        return
      }
      problems.push(problem(file, number, `"### ${head.text}" is not a task heading; 0.x ended the task above it here. It is kept as text`))
    }
    if (task) {
      const field = line.match(LEGACY_FIELD)
      const known = field && LEGACY_TASK_FIELDS.includes(field[1])
      if (field && (known || task.fieldBlock)) {
        const name = field[1]
        if (name in task.fields) {
          problems.push(
            problem(file, number, `${task.id}: a second "${name}" field; the last one counts, as in 0.x, and the earlier one and its continuation lines move to the task's Notes, word for word and in order`)
          )
          for (const entry of task.entries) if (entry.name === name && entry.kind !== 'extra') entry.kind = 'extra'
        }
        task.fields[name] = (field[2] ?? '').trim()
        task.entries.push({ text: line, kind: 'field', name })
        if (task.inBlock) task.continues = name
        return
      }
      if (task.inBlock && task.continues !== null && /^[ \t]+\S/.test(line)) {
        task.entries.push({ text: line, kind: 'continuation', name: task.continues })
        task.fieldBlock = false
        return
      }
      if (!line.trim() && task.entries.every((entry) => entry.kind === 'field')) {
        // A blank line ends the field block, and blank lines before the extra text are dropped.
        if (Object.keys(task.fields).length > 0) {
          task.fieldBlock = false
          task.inBlock = false
        }
        return
      }
      task.fieldBlock = false
      task.inBlock = false
      task.entries.push({ text: line, kind: 'extra', name: null })
      return
    }
    if (phaseLines) phaseLines.push(line)
    else preamble.push(line)
  })
  closePhaseText()

  const seen = new Set()
  for (const task of tasks) {
    for (const entry of task.entries) {
      if (entry.kind === 'field') continue
      if (entry.kind === 'continuation') task.attached.push({ name: entry.name, index: task.extra.length })
      task.extra.push(entry.text)
    }
    for (const key of ['entries', 'fieldBlock', 'continues', 'inBlock']) delete task[key]
    while (task.extra.length > 0 && !task.extra[task.extra.length - 1].trim()) task.extra.pop()
    for (const name of LEGACY_TASK_FIELDS)
      if (task.valid && !(name in task.fields)) problems.push(problem(file, task.line, `${task.id}: the "${name}" field is missing`))
    if (seen.has(task.id)) problems.push(problem(file, task.line, `${task.id}: duplicate id`))
    seen.add(task.id)
  }
  return { preamble: legacyBlock(preamble), phases, tasks, problems }
}

/** The parsed ledger rendered back into lines, for the lossless check. */
export function legacyLedgerLines(ledger) {
  const out = ledger.preamble ? ledger.preamble.split('\n') : []
  for (const phase of ledger.phases) {
    out.push(`${'#'.repeat(phase.level)} ${phase.heading}`)
    if (phase.text) out.push(...phase.text.split('\n'))
  }
  for (const task of ledger.tasks) {
    out.push(`### ${task.id} ${task.title}`)
    for (const [name, value] of Object.entries(task.fields)) out.push(`- ${name}: ${value}`)
    out.push(...task.extra)
  }
  return out
}

// ── The session log ────────────────────────────────────────────────────────────────

/** work/log.md: the preamble and one entry per `## YYYY-MM-DD · title` heading, with its body verbatim. */
export function parseLegacyLog(text, file = LEGACY_FILES.log) {
  const lines = legacyLines(text)
  const heads = legacyHeadings(lines)
  const anchors = legacyAnchors(heads)
  const preamble = []
  const entries = []
  const problems = []
  let body = preamble
  lines.forEach((line, index) => {
    const head = heads[index]
    const match = head && head.level === 2 ? line.match(LOG_HEADING) : null
    if (match) {
      const entry = { date: match[1], title: match[2], heading: head.text, line: index + 1, anchor: anchors[index], body: [] }
      entries.push(entry)
      body = entry.body
      return
    }
    if (head && head.level === 2)
      problems.push(problem(file, index + 1, `"## ${head.text}" is not a log entry heading ("## YYYY-MM-DD · title"); it is kept as text`))
    body.push(line)
  })
  for (const entry of entries) entry.body = legacyBlock(entry.body)
  return { preamble: legacyBlock(preamble), entries, problems }
}

export function legacyLogLines(log) {
  const out = log.preamble ? log.preamble.split('\n') : []
  for (const entry of log.entries) {
    out.push(`## ${entry.heading}`)
    if (entry.body) out.push(...entry.body.split('\n'))
  }
  return out
}

// ── The decision table ─────────────────────────────────────────────────────────────

/** The cells of a table row: split at pipes that are not escaped, with `\|` read as `|`. */
export function legacyTableCells(line) {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  const cells = []
  let cell = ''
  for (let i = 0; i < row.length; i += 1) {
    if (row[i] === '\\' && row[i + 1] === '|') {
      cell += '|'
      i += 1
    } else if (row[i] === '|') {
      cells.push(cell.trim())
      cell = ''
    } else cell += row[i]
  }
  cells.push(cell.trim())
  return cells
}

function legacyTableRow(cells) {
  return `| ${cells.map((cell) => cell.replaceAll('|', '\\|')).join(' | ')} |`
}

const TABLE_SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

/**
 * DECISIONS.md: the text before the table, the header row, one row per decision, and any
 * text after the table. Date, Decision and Decided by are found by the header's names, or by
 * position (first, second, third) when the header does not name them.
 */
export function parseLegacyDecisions(text, file = LEGACY_FILES.decisions) {
  const lines = legacyLines(text)
  const problems = []
  const start = lines.findIndex((line) => line.trim().startsWith('|'))
  if (start < 0) {
    problems.push(problem(file, 0, 'has no decision table'))
    return { preamble: legacyBlock(lines), header: null, rows: [], trailing: '', problems }
  }
  const header = { cells: legacyTableCells(lines[start]), line: start + 1, separator: null }
  let index = start + 1
  if (index < lines.length && TABLE_SEPARATOR.test(lines[index].trim())) {
    header.separator = lines[index].trim()
    index += 1
  } else problems.push(problem(file, start + 1, 'the table header has no separator row ("| --- | --- | --- |")'))

  const names = header.cells.map((cell) => cell.toLowerCase())
  const column = (name, fallback) => (names.includes(name) ? names.indexOf(name) : fallback)
  const at = { date: column('date', 0), decision: column('decision', 1), decidedBy: column('decided by', 2) }

  const rows = []
  let trailingStart = lines.length
  for (; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) continue
    if (!line.trim().startsWith('|')) {
      trailingStart = index
      break
    }
    const cells = legacyTableCells(line)
    const row = {
      date: cells[at.date] ?? '',
      decision: cells[at.decision] ?? '',
      decidedBy: cells[at.decidedBy] ?? '',
      cells,
      line: index + 1
    }
    if (cells.length !== header.cells.length)
      problems.push(problem(file, index + 1, `the row has ${cells.length} cells and the header ${header.cells.length}; every cell is kept`))
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) problems.push(problem(file, index + 1, `"${row.date}" is not a date (YYYY-MM-DD)`))
    rows.push(row)
  }
  const trailing = lines.slice(trailingStart)
  trailing.forEach((line, offset) => {
    if (line.trim().startsWith('|'))
      problems.push(problem(file, trailingStart + offset + 1, 'a table row after the text that follows the table; it is kept in the trailing text'))
  })
  return { preamble: legacyBlock(lines.slice(0, start)), header, rows, trailing: legacyBlock(trailing), problems }
}

export function legacyDecisionsLines(decisions) {
  const out = decisions.preamble ? decisions.preamble.split('\n') : []
  if (decisions.header) {
    out.push(legacyTableRow(decisions.header.cells))
    if (decisions.header.separator) out.push(decisions.header.separator)
  }
  for (const row of decisions.rows) out.push(legacyTableRow(row.cells))
  if (decisions.trailing) out.push(...decisions.trailing.split('\n'))
  return out
}

// ── Files made of sections: STATUS.md, README.md, standards.md, AGENTS.md ──────────

/**
 * A Markdown file as its title (the first `#` heading), the text before the first section,
 * and its sections: a Map from each `#` or `##` heading's text to { heading, level, line,
 * text }, where text holds everything up to the next such heading, deeper headings included.
 */
export function parseLegacySections(text, file) {
  const lines = legacyLines(text)
  const heads = legacyHeadings(lines)
  const preamble = []
  const sections = new Map()
  const problems = []
  let title = null
  let current = null
  lines.forEach((line, index) => {
    const head = heads[index]
    if (head && head.level === 1 && !title && !current) {
      title = { text: head.text, line: index + 1 }
      return
    }
    if (head && head.level <= 2) {
      let key = head.text
      if (sections.has(key)) {
        let count = 2
        while (sections.has(`${head.text} (${count})`)) count += 1
        key = `${head.text} (${count})`
        problems.push(problem(file, index + 1, `a second section "${head.text}"; it is kept as "${key}"`))
      }
      current = { heading: head.text, level: head.level, line: index + 1, text: [] }
      sections.set(key, current)
      return
    }
    ;(current ? current.text : preamble).push(line)
  })
  for (const section of sections.values()) section.text = legacyBlock(section.text)
  return { title, preamble: legacyBlock(preamble), sections, problems }
}

export function legacySectionsLines(parsed) {
  const out = parsed.title ? [`# ${parsed.title.text}`] : []
  if (parsed.preamble) out.push(...parsed.preamble.split('\n'))
  for (const section of parsed.sections.values()) {
    out.push(`${'#'.repeat(section.level)} ${section.heading}`)
    if (section.text) out.push(...section.text.split('\n'))
  }
  return out
}

/**
 * STATUS.md: the Updated line ({ date, by, line, text }, or null), every section, and extra:
 * the text outside the sections other than the Updated line. The five 0.x sections that are
 * missing are reported.
 */
export function parseLegacyStatus(text, file = LEGACY_FILES.status) {
  const parsed = parseLegacySections(text, file)
  const problems = [...parsed.problems]
  const lines = legacyLines(text)
  const firstSection = parsed.sections.size > 0 ? [...parsed.sections.values()][0].line - 1 : lines.length
  const at = lines.slice(0, firstSection).findIndex((line) => UPDATED.test(line))
  let updated = null
  const extra = parsed.preamble ? parsed.preamble.split('\n') : []
  if (at >= 0) {
    const match = lines[at].match(UPDATED)
    updated = { date: match[1], by: match[2], text: lines[at].trim(), line: at + 1 }
    extra.splice(extra.indexOf(lines[at]), 1)
  } else problems.push(problem(file, 0, 'has no line "Updated: YYYY-MM-DD · by <agent or person>"'))
  for (const name of LEGACY_STATUS_SECTIONS)
    if (!parsed.sections.has(name)) problems.push(problem(file, 0, `section "## ${name}" is missing`))
  return { updated, title: parsed.title, sections: parsed.sections, extra: legacyBlock(extra), problems }
}

export function legacyStatusLines(status) {
  const out = status.title ? [`# ${status.title.text}`] : []
  if (status.updated) out.push(status.updated.text)
  if (status.extra) out.push(...status.extra.split('\n'))
  return out.concat(legacySectionsLines({ title: null, preamble: '', sections: status.sections }))
}

export function parseLegacyReadme(text, file = LEGACY_FILES.readme) {
  return parseLegacySections(text, file)
}

export function parseLegacyStandards(text, file = LEGACY_FILES.standards) {
  return parseLegacySections(text, file)
}

export function parseLegacyAgents(text, file = LEGACY_FILES.agents) {
  return parseLegacySections(text, file)
}

function sectionText(parsed, name) {
  return parsed?.sections.get(name)?.text ?? null
}

// ── The released 0.x template sections ─────────────────────────────────────────────

// The sentences 0.x init wrote for {{attribution}}, by --forbid-ai-attribution.
const LEGACY_ATTRIBUTIONS = [
  'Commits carry no AI attribution: no co-author, sign-off or assisted-by trailer naming a model or a vendor.',
  'Commits may carry an AI co-author trailer.'
]
const MANUAL_GATES_MARKER = /gates that need eyes or judge?ment/i
const LAST_GATE = /^The last gate is always the same/

/**
 * A section of the workspace AGENTS.md or standards.md as it is compared with the released
 * templates: the workspace's own values back as the templates' placeholders ({{guard}},
 * {{dir}}, {{attribution}}) and every run of whitespace, line ends included, as one space.
 * In Quality gates, the manual gates (after the "Gates that need eyes or judgement" line, or
 * in 0.1 after the section's first line, up to "The last gate …") are the project's to fill
 * in and move to the README's Manual checks, so they count as one placeholder.
 */
export function legacyTemplateComparable(heading, text, dir) {
  let lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (heading === 'Quality gates') {
    const marker = lines.findIndex((line) => MANUAL_GATES_MARKER.test(line))
    const start = marker === -1 ? lines.findIndex((line) => line.trim()) : marker
    const end = lines.findIndex((line, index) => index > start && LAST_GATE.test(line))
    lines = [...lines.slice(0, start + 1), '{{manual gates}}', ...(end === -1 ? [] : lines.slice(end))]
  }
  let comparable = lines.join('\n').replaceAll(`node ${dir}/scripts/records.mjs`, '{{guard}}').replaceAll(`\`${dir}/\``, '`{{dir}}/`')
  for (const sentence of LEGACY_ATTRIBUTIONS) comparable = comparable.replaceAll(sentence, '{{attribution}}')
  return comparable.replace(/\s+/g, ' ').trim()
}

// SHA-256 of legacyTemplateComparable() for each section of the workspace AGENTS.md and
// standards.md that agent-ledger 0.1.0, 0.2.0 and 0.3.0 wrote (0.2.0 and 0.3.0 share their
// templates), by heading. Project rules is not here: it is always the project's own.
const LEGACY_TEMPLATE_HASHES = {
  agents: {
    'Start here, every session': ['413ea91e39d00f6c03b242a895db3a767cdd6e6aacbe75369338f09e019dfe17'],
    'Session protocol': ['37467ceb6f73f907fb75d70fc0ebcdf02d9ee4704db15b91a5431b952395119d', 'aa5e5c1fcc5073fabe152f29b6faf0714b0e35298eb367ba2aa76fce3843e721'],
    'Non-negotiables': ['cec7210dca00b7df4128ce79ff41e12b2edde2dae7426fc53c9156e5e1ea2b10', 'd9c4bca48ccc77b601a63bd1363d60d0679ab84ca2f9aabda342861ab442df10'],
    'Orchestrated work': ['3af9a79afd34e7f21e0b0453727fac1969375e63f6aa45ab6ef4d92ff6bb59b1'],
    'Working agreements': ['ba70a26b31b52c588e47aa1b85a0a8dd9387f8c4e067404513f2a40bf0547545']
  },
  standards: {
    'Who owns what': ['bf89644ed021adbbaee59e2ba413beb88fa867f6d61b0ca3c887c777463b0fe9'],
    'STATUS.md': ['b6264953f71c43fdc52273223f10c2bfdd2b95283ef0de68cd7c39493a567bf5'],
    'The task ledger': ['ca1abf381304fe40b18bcd8ee34c4e469f329bb81dc60468ea83c154cddee1f9'],
    Plans: ['d6c5997264e4105a666e3c00c65aecddf5aeaf4c74321e1acad7f1fdeb044bfd'],
    Commits: ['1cee6859739ec1d6ce255ae27dc860fcb065d7268cb1df0f8f3ff54d23a64487'],
    'Quality gates': ['0eb712fc6defbd3ff0002438531b1860ae29246a3847803b86b87a7d72e95bdc', 'b7b69a83d2cdb42ed537155fa0c9c6aff3a24e668c76f333a94a0436fc675928']
  }
}

/** The SHA-256 of a section's comparable text, as LEGACY_TEMPLATE_HASHES holds it. */
export function legacyTemplateHash(heading, text, dir) {
  return createHash('sha256').update(legacyTemplateComparable(heading, text, dir)).digest('hex')
}

/**
 * Whether a section of the workspace AGENTS.md ('agents') or standards.md ('standards') is a
 * 0.x template section that the project edited: its heading is a template's, and its text is
 * none of the released texts. Whitespace and line ends do not count.
 */
export function editedLegacyTemplateSection(file, heading, text, dir) {
  const hashes = LEGACY_TEMPLATE_HASHES[file]?.[heading]
  return hashes !== undefined && !hashes.includes(legacyTemplateHash(heading, text, dir))
}

/** What spec 14 takes from the workspace README: each section's text, or null when it is missing. */
export function legacyReadmeParts(readme) {
  return {
    whatIsBeingBuilt: sectionText(readme, 'What is being built'),
    whereTheCodeIs: sectionText(readme, 'Where the code is'),
    environments: sectionText(readme, 'Environments')
  }
}

/** The Project rules section of the workspace AGENTS.md, verbatim, or null. */
export function legacyProjectRules(agents) {
  return sectionText(agents, 'Project rules')
}

/**
 * The manual gates in standards.md: the numbered list in the Quality gates section, after the
 * "Gates that need eyes or judgement" paragraph when there is one. Returns { text, items,
 * other } or null without the section: text is the list verbatim, items one string per gate
 * with its continuation lines, other the rest of that part of the section (such as a TODO
 * placeholder or "None.").
 */
export function legacyManualGates(standards) {
  const section = standards?.sections.get('Quality gates')
  if (!section) return null
  const lines = section.text.split('\n')
  const marker = lines.findIndex((line) => /gates that need eyes or judge?ment/i.test(line))
  const part = lines.slice(marker + 1)
  const items = []
  const list = []
  const other = []
  let inItem = false
  for (const line of part) {
    if (/^\d+[.)] /.test(line)) {
      items.push(line.replace(/^\d+[.)] /, ''))
      list.push(line)
      inItem = true
    } else if (inItem && /^\s+\S/.test(line)) {
      items[items.length - 1] += `\n${line}`
      list.push(line)
    } else {
      inItem = false
      other.push(line)
    }
  }
  return { text: legacyBlock(list), items, other: legacyBlock(other) }
}

// ── The lossless check ─────────────────────────────────────────────────────────────

/** A line as the lossless check compares it: trimmed, inner whitespace collapsed, a table row without its padding. */
function comparable(line) {
  let text = line.trim().replace(/\s+/g, ' ')
  if (text.startsWith('|')) text = legacyTableCells(text).map((cell) => cell.replace(/\s+/g, ' ')).join('|')
  return text
}

/** The non-empty lines of text that the output lines do not hold, as { line, text }; each line counted as often as it occurs. */
export function lostLegacyLines(text, outputLines) {
  const available = new Map()
  for (const line of outputLines.flatMap((item) => item.split('\n'))) {
    if (!line.trim()) continue
    const key = comparable(line)
    available.set(key, (available.get(key) ?? 0) + 1)
  }
  const lost = []
  legacyLines(text).forEach((line, index) => {
    if (!line.trim()) return
    const key = comparable(line)
    const count = available.get(key) ?? 0
    if (count > 0) available.set(key, count - 1)
    else lost.push({ line: index + 1, text: line })
  })
  return lost
}

// ── The workspace on disk ──────────────────────────────────────────────────────────

function listFiles(root, folder) {
  const found = []
  const walk = (relative) => {
    const entries = readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const path = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(path)
      else found.push(path)
    }
  }
  walk(folder)
  return found
}

const PARSERS = {
  readme: parseLegacyReadme,
  agents: parseLegacyAgents,
  status: parseLegacyStatus,
  decisions: parseLegacyDecisions,
  standards: parseLegacyStandards,
  ledger: parseLegacyLedger,
  log: parseLegacyLog
}

/**
 * Reads a 0.x workspace from a repository root without writing anything. Returns the
 * configuration, each record parsed (null when its file is missing), sources (a Map of path
 * to text for every file read), files (every path in the workspace folder, relative to the
 * root) and problems. Paths are POSIX and relative to the root.
 */
export function readLegacyWorkspace(root) {
  const result = {
    config: null,
    dir: null,
    readme: null,
    agents: null,
    status: null,
    decisions: null,
    standards: null,
    ledger: null,
    log: null,
    sources: new Map(),
    files: [],
    problems: []
  }
  const configPath = join(root, LEGACY_CONFIG_FILE)
  if (!existsSync(configPath)) {
    result.problems.push(problem(LEGACY_CONFIG_FILE, 0, 'is missing in the repository root'))
    return result
  }
  const { text: configText, invalidLine: configInvalid } = readSourceText(configPath)
  if (configInvalid !== null) {
    result.problems.push(problem(LEGACY_CONFIG_FILE, configInvalid, INVALID_UTF8))
    return result
  }
  result.sources.set(LEGACY_CONFIG_FILE, configText)
  const { config, problems } = parseLegacyConfig(configText)
  result.config = config
  result.problems.push(...problems)
  const dir = legacyWorkspaceDir(config)
  if (!dir) return result
  result.dir = dir
  if (!existsSync(join(root, dir))) {
    result.problems.push(problem(dir, 0, 'the workspace folder is missing'))
    return result
  }
  result.files = listFiles(root, dir)
  for (const [name, relative] of Object.entries(LEGACY_FILES)) {
    const path = `${dir}/${relative}`
    if (!existsSync(join(root, path))) {
      result.problems.push(problem(path, 0, 'is missing'))
      continue
    }
    const { text, invalidLine } = readSourceText(join(root, path))
    if (invalidLine !== null) {
      result.problems.push(problem(path, invalidLine, INVALID_UTF8))
      continue
    }
    result.sources.set(path, text)
    const parsed = PARSERS[name](text, path)
    result[name] = parsed
    result.problems.push(...parsed.problems)
  }
  return result
}

/** The rendered lines of a parsed record, by the name readLegacyWorkspace gives it. */
export function legacyRecordLines(name, parsed) {
  if (name === 'ledger') return legacyLedgerLines(parsed)
  if (name === 'log') return legacyLogLines(parsed)
  if (name === 'decisions') return legacyDecisionsLines(parsed)
  if (name === 'status') return legacyStatusLines(parsed)
  return legacySectionsLines(parsed)
}
