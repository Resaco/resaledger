// Decisions, log entries, plan status lines and the workspace README: parsers over text and
// validators over parsed records. No file access; a validator returns problems.
import { posix } from 'node:path'
import { headings, isEmptyValue, parseFields, relativeLinks, resolveLinkPath, splitLines } from './markdown.mjs'

export const SETUP_MARKER = 'TODO(resaledger)'

const RECORD_DATE = /^\d{4}-\d{2}-\d{2}$/
const DATED_FILE = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/
const LOG_HEADING = /^(\d{4}-\d{2}-\d{2}) · (\S.*)$/
const PLAN_STATUS_LINE = /^Status:(.*)$/
const PLAN_STATUSES = ['proposal', 'approved', 'in progress', 'implemented']
const README_SECTIONS = ['Goal', 'Environments', 'Manual checks']

/** Whether a YYYY-MM-DD string names a day that exists in the calendar. */
function isCalendarDate(value) {
  if (!RECORD_DATE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** The first H1 of a text and the bullet fields straight after it, with a problem for each repeated field. */
function titleAndFields(file, text) {
  const lines = splitLines(text)
  const title = headings(text).find((heading) => heading.level === 1)
  const problems = []
  if (!title) return { title: null, titleLine: 0, fields: [], problems }
  const { fields } = parseFields(lines, title.line)
  const seen = new Set()
  for (const field of fields) {
    const key = field.name.toLowerCase()
    if (seen.has(key)) {
      problems.push({ file, line: field.line, message: `the field "${field.name}" appears twice; keep one "- ${field.name}: …" line` })
    }
    seen.add(key)
  }
  return { title: title.text, titleLine: title.line, fields, problems }
}

/** The first field with a name, compared case-insensitively, or undefined. */
function recordField(record, name) {
  return record.fields.find((field) => field.name.toLowerCase() === name.toLowerCase())
}

/** Problems with a dated file name: <folder>/<date>-<slug>.md, whose date equals the record's. */
function datedFileProblems(file, folder, date, example) {
  const parent = posix.basename(posix.dirname(file))
  const match = posix.basename(file).match(DATED_FILE)
  if (parent !== folder || !match || !isCalendarDate(match[1])) {
    return [{ file, line: 0, message: `the file name should be ${folder}/<YYYY-MM-DD>-<slug>.md, for example ${folder}/${example}` }]
  }
  if (date && isCalendarDate(date) && match[1] !== date) {
    return [{ file, line: 0, message: `the file name's date ${match[1]} differs from the record's date ${date}; rename the file to ${folder}/${date}-${match[2]}.md or correct the date` }]
  }
  return []
}

// Decisions (spec 5.4).

/** A decision file as { file, title, titleLine, fields, problems }. */
export function parseDecision(path, text) {
  return { file: path, ...titleAndFields(path, text) }
}

/** Problems with a decision: its heading, Date, Decided by, Status and file name. context.exists(path) checks links. */
export function validateDecision(decision, context) {
  const { file } = decision
  const problems = []
  const at = decision.titleLine || 1
  if (!decision.title) {
    problems.push({ file, line: 1, message: 'a decision starts with a heading that says what was decided: "# <decision>"' })
  }

  const date = recordField(decision, 'Date')
  const dateValue = date && !isEmptyValue(date.value) ? date.value : null
  if (!dateValue) {
    problems.push({ file, line: date ? date.line : at, message: 'a decision needs a date: add "- Date: YYYY-MM-DD" after the heading' })
  } else if (!RECORD_DATE.test(dateValue)) {
    problems.push({ file, line: date.line, message: `the date "${dateValue}" is not in the form YYYY-MM-DD; write it as "- Date: 2026-10-14"` })
  } else if (!isCalendarDate(dateValue)) {
    problems.push({ file, line: date.line, message: `the date ${dateValue} does not exist in the calendar; write the real day the decision was made` })
  }

  const decidedBy = recordField(decision, 'Decided by')
  if (!decidedBy || isEmptyValue(decidedBy.value)) {
    problems.push({ file, line: decidedBy ? decidedBy.line : at, message: 'a decision needs the person who decided: write "- Decided by: <name>"' })
  }

  const status = recordField(decision, 'Status')
  if (status && !isEmptyValue(status.value) && status.value !== 'accepted') {
    const superseded = status.value.match(/^superseded by\s+(.+)$/)
    const link = superseded ? relativeLinks(superseded[1])[0] : undefined
    if (!link) {
      problems.push({ file, line: status.line, message: `the status "${status.value}" is not "accepted" or "superseded by <link>"; write "- Status: accepted" or "- Status: superseded by [the newer decision](<date>-<slug>.md)"` })
    } else {
      const target = resolveLinkPath(file, link.path)
      if (target === null || !context.exists(target)) {
        problems.push({ file, line: status.line, message: `the superseding decision "${link.path}" does not exist; link to the decision file that replaces this one` })
      }
    }
  }

  problems.push(...datedFileProblems(file, 'decisions', dateValue, '2026-10-14-bullet-fields.md'))
  return problems
}

// Log entries (spec 5.5).

/** A log entry as { file, title, date, titleLine, fields, problems }; date and title come from "# <date> · <title>". */
export function parseLogEntry(path, text) {
  const parsed = titleAndFields(path, text)
  const match = parsed.title ? parsed.title.match(LOG_HEADING) : null
  return {
    file: path,
    title: match ? match[2].trim() : parsed.title,
    date: match ? match[1] : null,
    heading: parsed.title,
    titleLine: parsed.titleLine,
    fields: parsed.fields,
    problems: parsed.problems
  }
}

/** Problems with a log entry: its heading, file name and Tasks. context.taskIds is the Set of known task ids. */
export function validateLogEntry(entry, context) {
  const { file } = entry
  const problems = []
  if (!entry.heading) {
    problems.push({ file, line: 1, message: 'a log entry starts with a heading: "# YYYY-MM-DD · <title>"' })
  } else if (!entry.date) {
    problems.push({ file, line: entry.titleLine, message: `the heading "${entry.heading}" is not "<YYYY-MM-DD> · <title>"; write it as "# 2026-10-14 · ${entry.heading}"` })
  } else if (!isCalendarDate(entry.date)) {
    problems.push({ file, line: entry.titleLine, message: `the date ${entry.date} does not exist in the calendar; write the real day of the entry` })
  }

  const tasks = recordField(entry, 'Tasks')
  if (tasks) {
    const known = context.taskIds ?? new Set()
    const ids = [tasks.value, ...tasks.items]
      .flatMap((value) => value.split(','))
      .map((id) => id.trim())
      .filter((id) => !isEmptyValue(id))
    for (const id of ids) {
      if (!known.has(id)) {
        problems.push({ file, line: tasks.line, message: `the task ${id} does not exist; list ids of existing tasks, comma-separated, or remove it` })
      }
    }
  }

  problems.push(...datedFileProblems(file, 'log', entry.date, '2026-10-14-storage-routes.md'))
  return problems
}

// Plans (spec 5.6).

/** The status line before a plan's first ## heading, as { value, date, by, line }, or null. date and by are null when left out. */
export function planStatus(text) {
  const lines = splitLines(text)
  const firstSection = headings(text).find((heading) => heading.level === 2)
  const end = firstSection ? firstSection.line - 1 : lines.length
  for (let index = 0; index < end; index += 1) {
    const match = lines[index].match(PLAN_STATUS_LINE)
    if (!match) continue
    const [value, date, ...by] = match[1].split('·').map((part) => part.trim())
    return { value, date: date || null, by: by.join(' · ') || null, line: index + 1 }
  }
  return null
}

/** A problem when a plan's status is not exactly proposal, approved, in progress or implemented. */
export function validatePlanStatus(path, status) {
  if (!status || PLAN_STATUSES.includes(status.value)) return []
  return [{
    file: path,
    line: status.line,
    message: `the plan status "${status.value}" is not one of ${PLAN_STATUSES.join(', ')}; write for example "Status: approved · 2026-10-14 · <who decided>"`
  }]
}

// The workspace README (spec 5.8).

/** The README as { file, sections, markers }: sections maps each ## heading's text to { line, body }; markers are the lines with SETUP_MARKER. */
export function parseReadme(path, text) {
  const lines = splitLines(text)
  const all = headings(text)
  const sections = new Map()
  all.forEach((heading, position) => {
    if (heading.level !== 2 || sections.has(heading.text)) return
    const next = all.slice(position + 1).find((other) => other.level <= 2)
    const body = lines.slice(heading.line, next ? next.line - 1 : lines.length).join('\n').trim()
    sections.set(heading.text, { line: heading.line, body })
  })
  const markers = []
  lines.forEach((line, index) => {
    if (line.includes(SETUP_MARKER)) markers.push(index + 1)
  })
  return { file: path, sections, markers }
}

/** Problems with the README: a missing required section, an empty section, and every setup marker left. */
export function validateReadme(readme) {
  const { file } = readme
  const problems = []
  const names = [...readme.sections.keys()].map((name) => name.trim().toLowerCase())
  for (const required of README_SECTIONS) {
    if (!names.includes(required.toLowerCase())) {
      problems.push({ file, line: 0, message: `the README has no "## ${required}" section; add it with the project's own text` })
    }
  }
  for (const [name, section] of readme.sections) {
    if (section.body === '') {
      problems.push({ file, line: section.line, message: `the section "## ${name}" is empty; write the project's own text under it` })
    }
  }
  for (const line of readme.markers) {
    problems.push({ file, line, message: `a ${SETUP_MARKER} marker is left; write the project's own text here and remove the marker` })
  }
  return problems
}
