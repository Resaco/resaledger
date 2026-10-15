// Task files, spec 5.3: parsed from text and validated against a context, with no file access.
// One file at a time checks the shape; the set checks unique ids, dependencies and WIP per lane.
import { findSection, headings, isEmptyValue, parseFields, relativeLinks, resolveLinkPath, splitLines } from './markdown.mjs'
import { likelyTypo } from './util.mjs'

export const TASK_ID = /^[A-Z]{1,4}\d+(\.\d+)*$/
export const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done', 'dropped']

/** The field names spec 5.3 defines, spelled as they are written. */
export const TASK_FIELDS = ['Status', 'Lane', 'Depends on', 'Plan', 'Evidence', 'Waiting for', 'Reason', 'Issue', 'Taken over from']

const TASK_SECTIONS = { plan: 'Plan', handoff: 'Handoff', notes: 'Notes' }
const TASK_TITLE_MAX = 100
const TASK_HANDOFF_MAX = 1500
const TASK_SLUG_MAX = 40
// Latin letters that NFKD does not split into a base letter and a mark.
const TASK_SLUG_LETTERS = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ł: 'l', þ: 'th', Æ: 'AE', Œ: 'OE', Ø: 'O', Đ: 'D', Ł: 'L', Þ: 'TH' }
const TASK_FILE_NAME = /^([A-Z]{1,4}\d+(?:\.\d+)*)(?:-[^/]+)?\.md$/
const TASK_ID_HINT = 'one to four capital letters, a number and optional .number parts, such as S4, S4.1 or API12'

/** A field's text: its value, or its nested items joined, or null when both are empty. */
function taskFieldText(field) {
  if (!field) return null
  if (!isEmptyValue(field.value)) return field.value
  const items = field.items.filter((item) => !isEmptyValue(item))
  return items.length > 0 ? items.join('; ') : null
}

/** A level-2 section's line and body: the lines up to the next heading of level 1 or 2. */
function taskSection(lines, all, name) {
  const position = all.findIndex((heading) => heading.level === 2 && heading.text === name)
  if (position === -1) return null
  const heading = all[position]
  const next = all.slice(position + 1).find((other) => other.level <= 2)
  return { line: heading.line, body: lines.slice(heading.line, next ? next.line - 1 : lines.length).join('\n') }
}

/** Whether section lines hold content: a line that is neither blank nor a heading. */
function taskHasContent(lines) {
  return lines.some((line) => line.trim() !== '' && !/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line))
}

/** Parses a task file. Problems are only what made parsing impossible; validateTask checks the rest. */
export function parseTask(path, text) {
  const lines = splitLines(text)
  const all = headings(text)
  const task = {
    file: path,
    id: null,
    title: null,
    titleLine: 0,
    fields: [],
    status: null,
    lane: null,
    dependsOn: [],
    plan: null,
    evidence: null,
    waitingFor: null,
    reason: null,
    issue: null,
    takenOverFrom: null,
    sections: { plan: null, handoff: null, notes: null },
    unknownFields: [],
    links: relativeLinks(text),
    problems: []
  }
  for (const [key, name] of Object.entries(TASK_SECTIONS)) task.sections[key] = taskSection(lines, all, name)

  const heading = all.find((candidate) => candidate.level === 1)
  if (!heading) {
    task.problems.push({
      file: path,
      line: lines.length > 0 ? 1 : 0,
      message: 'the task has no heading. Start the file with "# <id> <title>", such as "# S4 Store projects and documents"'
    })
    return task
  }
  const [id, ...rest] = heading.text.split(/[ \t]+/)
  task.id = id || null
  task.title = rest.join(' ').trim()
  task.titleLine = heading.line

  const { fields } = parseFields(lines, heading.line)
  task.fields = fields
  if (fields.length === 0) {
    task.problems.push({
      file: path,
      line: heading.line,
      message: 'the task has no field list after its heading. Put the fields straight after the heading, starting with "- Status: todo"'
    })
    return task
  }

  const first = new Map()
  for (const field of fields) {
    if (!TASK_FIELDS.includes(field.name)) task.unknownFields.push({ name: field.name, line: field.line })
    else if (!first.has(field.name)) first.set(field.name, field)
  }
  task.status = taskFieldText(first.get('Status'))
  task.lane = taskFieldText(first.get('Lane'))
  task.waitingFor = taskFieldText(first.get('Waiting for'))
  task.reason = taskFieldText(first.get('Reason'))
  task.issue = taskFieldText(first.get('Issue'))
  task.takenOverFrom = taskFieldText(first.get('Taken over from'))
  const plan = first.get('Plan')
  task.plan = plan && !isEmptyValue(plan.value) ? plan.value : null
  const evidence = first.get('Evidence')
  if (evidence) task.evidence = { value: evidence.value, items: evidence.items, line: evidence.line }
  const depends = first.get('Depends on')
  if (depends) {
    task.dependsOn = [depends.value, ...depends.items]
      .flatMap((part) => part.split(','))
      .map((part) => part.trim())
      .filter((part) => !isEmptyValue(part))
  }
  return task
}

/** Whether evidence text has a command in backticks, a Markdown link or a web URL. */
function taskEvidenceIsConcrete(text) {
  return /`[^`\n]*\S[^`\n]*`/.test(text) || /\[[^\]]*\]\([^)\s]+[^)]*\)/.test(text) || /\bhttps?:\/\/\S+/.test(text)
}

/** The first field of a name, or undefined. */
function taskField(task, name) {
  return task.fields.find((field) => field.name === name)
}

/**
 * Checks one parsed task. The context is { exists, read, planStatus, taskIds, config }.
 * A task whose parse problems are not empty is not checked further: report task.problems instead.
 */
export function validateTask(task, context) {
  if (task.problems.length > 0) return []
  const problems = []
  const report = (line, message) => problems.push({ file: task.file, line, message })
  const { dir } = context.config
  const headingLine = task.titleLine

  // Heading.
  const idValid = TASK_ID.test(task.id)
  if (!idValid) report(headingLine, `"${task.id}" is not a task id. Write the heading as "# <id> <title>", where the id is ${TASK_ID_HINT}`)
  if (task.title === '') report(headingLine, `the heading has no title. Write "# ${idValid ? task.id : 'S4'} <title>", such as "# ${idValid ? task.id : 'S4'} Store projects and documents"`)
  else if ([...task.title].length > TASK_TITLE_MAX)
    report(headingLine, `the title has ${[...task.title].length} characters. Shorten it to at most ${TASK_TITLE_MAX} and put the detail in a ## Plan or ## Notes section`)

  // File name.
  const folder = `${dir}/tasks/`
  const name = task.file.startsWith(folder) ? task.file.slice(folder.length) : null
  const named = name === null ? null : name.match(TASK_FILE_NAME)
  const suggestion = idValid ? taskFileName(dir, task.id, task.title) : `${folder}<id>-<slug>.md`
  if (name === null || name.includes('/')) report(0, `a task file belongs directly in ${folder}. Move it to ${suggestion}`)
  else if (!named) report(0, `the file name is not "<id>-<slug>.md" or "<id>.md". Rename it to ${suggestion}`)
  else if (idValid && named[1] !== task.id)
    report(headingLine, `the file name says ${named[1]} but the heading says ${task.id}. Rename the file to ${suggestion}, or write "# ${named[1]} ${task.title}"`)

  // Fields: duplicates and likely typos.
  const seen = new Map()
  for (const field of task.fields) {
    if (TASK_FIELDS.includes(field.name)) {
      if (seen.has(field.name)) report(field.line, `"${field.name}" appears twice (first on line ${seen.get(field.name)}). Keep one "- ${field.name}:" line`)
      else seen.set(field.name, field.line)
    }
  }
  for (const unknown of task.unknownFields) {
    const known = likelyTypo(unknown.name, TASK_FIELDS)
    if (known) report(unknown.line, `"${unknown.name}" looks like a typo. Write "- ${known}:"`)
  }

  // Status and the fields it requires.
  const status = taskField(task, 'Status')
  const statusLine = status ? status.line : headingLine
  if (!status || task.status === null) {
    report(statusLine, `the task has no status. Write "- Status: todo", or one of ${TASK_STATUSES.join(', ')}`)
  } else if (!TASK_STATUSES.includes(task.status)) {
    report(statusLine, `"${task.status}" is not a status. Write one of ${TASK_STATUSES.join(', ')}`)
  } else if (task.status === 'doing' && task.lane === null) {
    report(statusLine, 'a doing task needs a lane. Add "- Lane: <branch>" with the branch that holds the task')
  } else if (task.status === 'blocked' && task.waitingFor === null) {
    report(statusLine, 'a blocked task needs "- Waiting for: <who or what>", such as owner, a person, a task id or an outside party')
  } else if (task.status === 'dropped' && task.reason === null) {
    report(statusLine, 'a dropped task needs "- Reason: <why>", such as "split into S7.1–S7.5", "superseded by S9" or "not needed"')
  }

  // Evidence.
  const evidenceText = task.evidence ? [task.evidence.value, ...task.evidence.items].filter((part) => !isEmptyValue(part)).join('\n') : ''
  if (task.status === 'done' && evidenceText === '') {
    report(task.evidence ? task.evidence.line : statusLine, 'a done task needs evidence. Add "- Evidence:" with a command in backticks, a link or a URL, such as "`npm test`: 14 of 14"')
  } else if (evidenceText !== '' && !taskEvidenceIsConcrete(evidenceText)) {
    report(task.evidence.line, 'evidence needs a command in backticks, a link or a URL, not only words. Write, for example, "`npm test`: 14 of 14" or a link to a file under evidence/')
  }

  // Plan.
  const planField = taskField(task, 'Plan')
  const planLine = planField ? planField.line : statusLine
  let planContent = false
  let planNote = ''
  if (task.plan !== null) {
    const link = relativeLinks(task.plan)[0]
    const path = link ? resolveLinkPath(task.file, link.path) : null
    if (!link) {
      report(planLine, `Plan must be a Markdown link to a plan section, such as "[S-server.md](../plan/S-server.md#s4-store-projects)", not "${task.plan}"`)
    } else if (path !== null && link.path !== '' && context.exists(path)) {
      // A missing file is reported with the other links below.
      const text = context.read(path)
      if (text !== null && text !== undefined) {
        if (link.anchor) {
          const section = findSection(text, link.anchor)
          if (!section) {
            const anchors = headings(text).map((heading) => `#${heading.anchor}`)
            const hint = anchors.length > 0 ? ` Link to one of its sections, such as ${anchors.slice(0, 3).join(', ')}` : ' Add the section to the plan, or link to the file without an anchor'
            report(planLine, `Plan links to #${link.anchor}, which is not a section in ${path}.${hint}`)
          } else {
            planContent = taskHasContent(section.lines)
            if (!planContent) planNote = ` The linked section #${link.anchor} in ${path} has only its heading.`
          }
        } else {
          planContent = taskHasContent(splitLines(text))
          if (!planContent) planNote = ` The linked plan ${path} is empty.`
        }
      }
      const planStatus = context.planStatus(path)
      if (task.status === 'doing' && String(planStatus?.value ?? '').toLowerCase() === 'proposal') {
        report(planLine, `the plan ${path} is a proposal, and a task cannot be doing until its plan is approved. Approve the plan first (its status line says "Status: approved"), or set this task back to todo`)
      }
    }
  }
  if (task.status === 'doing') {
    const own = task.sections.plan
    const ownContent = own !== null && taskHasContent(own.body.split('\n'))
    if (!planContent && !ownContent) {
      report(
        own && task.plan === null ? own.line : planLine,
        `a doing task needs a plan.${planNote} Link "- Plan:" to a plan section with content, or write the goal and acceptance checks in a "## Plan" section`
      )
    }
  }

  // Handoff length; whether a doing task has one is a session check, not a shape check.
  if (task.sections.handoff) {
    const length = [...task.sections.handoff.body.trim()].length
    if (length > TASK_HANDOFF_MAX)
      report(task.sections.handoff.line, `the handoff has ${length} characters. Shorten it to at most ${TASK_HANDOFF_MAX}: the state now, with the story moved to ## Notes or a log entry`)
  }

  // Every relative link resolves.
  for (const link of task.links) {
    if (link.path === '') continue
    const path = resolveLinkPath(task.file, link.path)
    if (path === null) report(link.line, `the link ${link.target} points outside the repository. Link to a file inside it`)
    else if (!context.exists(path)) report(link.line, `the link ${link.target} points to ${path}, which does not exist. Fix the path or add the file`)
    else if (link.anchor && path.endsWith('.md') && !(planField && link.line === planField.line)) {
      // The Plan link's anchor is checked above, with a hint; every other anchor here.
      const target = context.read(path)
      const wanted = link.anchor.toLowerCase()
      if (target !== null && !headings(target).some((heading) => heading.anchor === wanted))
        report(link.line, `the link ${link.target} points to #${link.anchor}, which is not a heading in ${path}. Fix the anchor or link to the file without it`)
    }
  }
  return problems
}

/** Checks a set of tasks together: unique ids, dependencies that exist and WIP per lane. */
export function validateTaskSet(tasks, context) {
  const problems = []
  const byId = new Map()
  for (const task of tasks) {
    if (!task.id) continue
    if (!byId.has(task.id)) byId.set(task.id, [])
    byId.get(task.id).push(task)
  }
  for (const [id, same] of byId) {
    if (same.length < 2) continue
    for (const task of same) {
      const others = same.filter((other) => other !== task).map((other) => other.file)
      problems.push({ file: task.file, line: task.titleLine, message: `the id ${id} is also used by ${others.join(', ')}. Ids are unique: give one of them a new id` })
    }
  }

  for (const task of tasks) {
    const missing = task.dependsOn.filter((id) => !byId.has(id))
    if (missing.length === 0) continue
    const field = taskField(task, 'Depends on')
    for (const id of missing)
      problems.push({ file: task.file, line: field ? field.line : task.titleLine, message: `"Depends on" names ${id}, which is not a task. Write the id of an existing task, or remove it` })
  }

  const byLane = new Map()
  for (const task of tasks) {
    if (task.status !== 'doing' || task.lane === null) continue
    if (!byLane.has(task.lane)) byLane.set(task.lane, [])
    byLane.get(task.lane).push(task)
  }
  const limit = context.config.wip
  for (const [lane, doing] of byLane) {
    if (doing.length <= limit) continue
    const sorted = [...doing].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    const first = sorted[0]
    const status = taskField(first, 'Status')
    problems.push({
      file: first.file,
      line: status ? status.line : first.titleLine,
      message: `the lane ${lane} has ${doing.length} tasks doing (${sorted.map((task) => task.id).join(', ')}), more than the limit of ${limit}. Finish one or set it back to todo or blocked`
    })
  }
  return problems
}

/** A file-name slug: lowercase ASCII words joined by hyphens, at most 40 characters, or ''. */
export function slugify(title) {
  const slug = title
    .replace(/[ßæœøđłþÆŒØĐŁÞ]/g, (letter) => TASK_SLUG_LETTERS[letter])
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length <= TASK_SLUG_MAX) return slug
  let cut = slug.slice(0, TASK_SLUG_MAX)
  if (slug[TASK_SLUG_MAX] !== '-') {
    const hyphen = cut.lastIndexOf('-')
    if (hyphen > 0) cut = cut.slice(0, hyphen)
  }
  return cut.replace(/-+$/, '')
}

// The device names Windows reserves, in any case and with any extension: no file can have them.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * The path of a new task file: <dir>/tasks/<id>-<slug>.md, or <dir>/tasks/<id>.md with no slug.
 * A name Windows reserves before its first dot, such as COM1.md, gets "-task" after the id.
 */
export function taskFileName(dir, id, title) {
  const slug = slugify(title ?? '')
  let name = `${id}${slug ? `-${slug}` : ''}`
  if (WINDOWS_RESERVED.test(name.split('.')[0])) name = `${id}-task${slug ? `-${slug}` : ''}`
  return `${dir}/tasks/${name}.md`
}
