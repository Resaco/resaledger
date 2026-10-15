// task and new (spec 6.7 and 8): read one task with its plan section, and create task,
// decision and log files with safe ids and names. A new id takes the next number after the
// highest visible in this worktree, the other local worktrees and every fetched branch, so
// that concurrent lanes do not pick the same one. Nothing is ever overwritten.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadConfig } from './config.mjs'
import { branchFolderNames, branchTaskFiles } from './ids.mjs'
import { currentLane, laneTasks, localLanes } from './lanes.mjs'
import { findSection, relativeLinks, resolveLinkPath } from './markdown.mjs'
import { slugify, TASK_ID, taskFileName } from './tasks.mjs'
import { fail, git, repositoryRoot } from './util.mjs'
import { treeReader } from './workspace.mjs'

const CREATE_PREFIX = /^[A-Z]{1,4}$/
const CREATE_FILE_ID = /^([A-Z]{1,4}\d+(?:\.\d+)*)(?:-[^/]+)?\.md$/
const CREATE_TITLE_MAX = 100
const CREATE_PLACEHOLDER = '—'

/** The numbers of an id with a given prefix, or null when the id has another prefix. */
function createIdNumbers(id, prefix) {
  const match = /^([A-Z]+)(\d+(?:\.\d+)*)$/.exec(id ?? '')
  if (!match || match[1] !== prefix) return null
  return match[2].split('.').map(Number)
}

/** The next top-level id for a prefix: one more than the highest number among the known ids (a gap is not reused). */
export function nextTaskId(prefix, known) {
  let highest = 0
  for (const id of known) {
    const numbers = createIdNumbers(id, prefix)
    if (numbers && numbers[0] > highest) highest = numbers[0]
  }
  return `${prefix}${highest + 1}`
}

/** The next child id of a parent: S4 gives S4.1, then S4.2; S4.1 gives S4.1.1. */
export function nextChildId(parent, known) {
  let highest = 0
  for (const id of known) {
    if (!id || !id.startsWith(`${parent}.`)) continue
    const rest = id.slice(parent.length + 1)
    if (/^\d+$/.test(rest) && Number(rest) > highest) highest = Number(rest)
  }
  return `${parent}.${highest + 1}`
}

/** The repository root and the effective configuration, or a refusal. */
function createSetup() {
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }
  const reader = treeReader({ kind: 'worktree', root })
  const loaded = loadConfig(reader)
  if (!loaded.config) {
    for (const { file, line, message } of loaded.problems) console.error(`✖ ${file}${line ? `:${line}` : ''}: ${message}`)
    process.exit(1)
  }
  return { root, reader, config: loaded.config }
}

/** Prints a refusal and stops with exit code 1. */
function createRefuse(message) {
  console.error(`✖ ${message}`)
  process.exit(1)
}

/** The ids in a folder on disk, from the file names. */
function createIdsOnDisk(folder) {
  let names = []
  try {
    names = readdirSync(folder)
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
  }
  return names.map((name) => name.match(CREATE_FILE_ID)?.[1]).filter(Boolean)
}

/** Every task id visible from here: this worktree, the other local worktrees and every local and remote-tracking branch. */
function createKnownIds(root, config) {
  const known = new Set(createIdsOnDisk(join(root, config.dir, 'tasks')))
  for (const lane of localLanes(config)) {
    for (const task of lane.tasks) {
      if (task.id) known.add(task.id)
      const named = task.file.slice(task.file.lastIndexOf('/') + 1).match(CREATE_FILE_ID)
      if (named) known.add(named[1])
    }
  }
  for (const branch of branchTaskFiles({ root, dir: config.dir })) for (const id of branch.files.keys()) known.add(id)
  return known
}

/** Writes a new file and refuses when it exists; nothing is ever overwritten. */
function createWrite(root, path, text) {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  try {
    writeFileSync(full, text, { flag: 'wx' })
  } catch (error) {
    if (error.code === 'EEXIST') createRefuse(`${path} already exists; nothing was overwritten`)
    throw error
  }
}

/** One line typed on a terminal, or null when stdin is not a terminal or cannot be read. */
function createPrompt(question) {
  if (!process.stdin.isTTY) return null
  process.stderr.write(question)
  const buffer = Buffer.alloc(1)
  const bytes = []
  try {
    for (;;) {
      const read = readSync(0, buffer, 0, 1, null)
      if (read === 0 || buffer[0] === 10) break
      bytes.push(buffer[0])
    }
  } catch {
    return null
  }
  return Buffer.from(bytes).toString('utf8').replace(/\r$/, '')
}

/** An issue's title from the GitHub CLI, or null when gh is missing or fails. */
function createIssueTitle(root, issue) {
  const result = spawnSync('gh', ['issue', 'view', issue, '--json', 'title'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error || result.status !== 0) return null
  try {
    const title = JSON.parse(result.stdout).title
    return typeof title === 'string' ? title : null
  } catch {
    return null
  }
}

/** A title on one line, with runs of white space collapsed. */
function createCleanTitle(title) {
  return (title ?? '').replace(/\s+/g, ' ').trim()
}

/** Today's date in local time, as YYYY-MM-DD. */
function createToday() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** The names in a folder on disk, or none. */
function createNamesOnDisk(folder) {
  try {
    return readdirSync(folder)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []
    throw error
  }
}

/**
 * A dated file name that no visible tree has: <folder>/<date>-<slug>.md, or with -2, -3, …
 * when this worktree, another local worktree or any branch already has the name.
 */
function createDatedPath(root, config, folder, title, fallback) {
  const path = `${config.dir}/${folder}`
  const taken = new Set(createNamesOnDisk(join(root, path)))
  for (const lane of localLanes(config)) for (const name of createNamesOnDisk(join(lane.path, path))) taken.add(name)
  for (const branch of branchFolderNames({ root, folder: path })) for (const name of branch.names) taken.add(name)
  const base = `${createToday()}-${slugify(title) || fallback}`
  let name = `${base}.md`
  for (let number = 2; taken.has(name); number += 1) name = `${base}-${number}.md`
  return `${path}/${name}`
}

/** The person who decides: git's user.name, then the author name git would use, or null. */
function createAuthorName() {
  try {
    const name = git('config', 'user.name')
    if (name) return name
  } catch {
    // Not set.
  }
  return process.env.GIT_AUTHOR_NAME?.trim() || null
}

/** new decision "<title>" and new log "<title>". */
function createRecord(kind, title) {
  const { root, reader, config } = createSetup()
  const guard = `node ${config.dir}/scripts/records.mjs`
  if (kind === 'decision') {
    const path = createDatedPath(root, config, 'decisions', title, 'decision')
    const author = createAuthorName()
    // The file ends on the field list, so that a field appended at once, such as Weakens, joins it.
    createWrite(root, path, `# ${title}\n\n- Date: ${createToday()}\n- Decided by: ${author ?? CREATE_PLACEHOLDER}\n- Status: accepted\n`)
    console.log(`✔ created ${path}`)
    const missing = author ? '' : ' Fill in "Decided by" too: git has no user.name here.'
    console.log(`Next: add any more fields, such as "- Weakens: <id>", straight below the list, then a blank line and what was decided and why.${missing} Then run ${guard} check.`)
    return
  }
  const path = createDatedPath(root, config, 'log', title, 'entry')
  const lane = currentLane()
  const held = lane === null ? [] : laneTasks(reader, config.dir).filter((task) => task.id && task.status === 'doing' && task.lane === lane).map((task) => task.id)
  createWrite(root, path, `# ${createToday()} · ${title}\n\n- Lane: ${lane ?? CREATE_PLACEHOLDER}\n- Tasks: ${held.length > 0 ? held.join(', ') : CREATE_PLACEHOLDER}\n\n`)
  console.log(`✔ created ${path}`)
  console.log(`Next: write below the fields what was tried, what failed and what was learned. Then run ${guard} check.`)
}

/** The arguments of new, as { kind, prefix, title, under, issue }. */
function createParseArgs(args) {
  const positionals = []
  let under = null
  let issue = null
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--under' || arg === '--issue') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) createRefuse(`${arg} needs a value, such as ${arg === '--under' ? '--under S4' : '--issue 123'}`)
      if (arg === '--under') under = value
      else issue = value
      index += 1
    } else if (arg.startsWith('--')) createRefuse(`unknown option "${arg}" for new; use --under <id> or --issue <n>`)
    else positionals.push(arg)
  }
  if (positionals[0] === 'decision' || positionals[0] === 'log') {
    const kind = positionals[0]
    if (under !== null || issue !== null) createRefuse(`--under and --issue are for tasks, not for new ${kind}`)
    if (positionals.length > 2) createRefuse(`new ${kind} takes one title: put it in quotes, as in new ${kind} "<title>"`)
    return { kind, prefix: null, title: positionals[1] ?? '', under, issue }
  }
  if (positionals.length > 2) createRefuse('new takes a prefix and one title: put the title in quotes, as in new S "Store the orders"')
  let prefix = null
  let title = null
  if (positionals.length === 2) [prefix, title] = positionals
  else if (positionals.length === 1 && issue !== null && CREATE_PREFIX.test(positionals[0])) prefix = positionals[0]
  else title = positionals[0] ?? null
  if (prefix !== null && !CREATE_PREFIX.test(prefix)) createRefuse(`"${prefix}" is not a prefix: write one to four capital letters, such as S or API`)
  if (issue !== null) {
    if (!/^#?\d+$/.test(issue)) createRefuse(`"${issue}" is not an issue number: write --issue 123`)
    issue = issue.replace(/^#/, '')
  }
  if (under !== null) {
    if (!TASK_ID.test(under)) createRefuse(`"${under}" is not a task id: --under takes the id of an existing task, such as S4`)
    if (prefix !== null) createRefuse('--under takes the prefix from its parent: leave out the prefix')
  }
  return { kind: 'task', prefix, title, under, issue }
}

/**
 * new [<prefix>] "<title>" [--under <id>] [--issue <n>], new decision "<title>" and new log "<title>".
 * Creates the file, prints its path and the next step.
 */
export function newCommand(args) {
  const options = createParseArgs(args)
  if (options.kind !== 'task') {
    const title = createCleanTitle(options.title)
    if (title === '') createRefuse(`the title is empty: write new ${options.kind} "<title>"`)
    createRecord(options.kind, title)
    return
  }

  const { root, config } = createSetup()
  const guard = `node ${config.dir}/scripts/records.mjs`
  let title = createCleanTitle(options.title)
  if (title === '' && options.title === null && options.issue !== null) {
    title = createCleanTitle(createIssueTitle(root, options.issue) ?? createPrompt(`Title for the task from issue #${options.issue}: `))
    if (title === '') createRefuse(`could not read the title of issue #${options.issue} with gh: give it yourself, as in new --issue ${options.issue} "<title>"`)
  }
  if (title === '') createRefuse('the title is empty: write new [<prefix>] "<title>", such as new S "Store the orders"')
  if ([...title].length > CREATE_TITLE_MAX) createRefuse(`the title has ${[...title].length} characters; shorten it to at most ${CREATE_TITLE_MAX} and put the detail in the task's ## Plan`)

  const known = createKnownIds(root, config)
  let id
  if (options.under !== null) {
    if (!createIdsOnDisk(join(root, config.dir, 'tasks')).includes(options.under))
      createRefuse(`there is no task ${options.under} in ${config.dir}/tasks: --under takes the id of a task in this worktree`)
    id = nextChildId(options.under, known)
  } else id = nextTaskId(options.prefix ?? 'T', known)

  const path = taskFileName(config.dir, id, title)
  // Evidence is written empty, so that finishing the task shows where its evidence goes.
  const fields = ['- Status: todo', `- Evidence: ${CREATE_PLACEHOLDER}`]
  if (options.issue !== null) fields.push(`- Issue: #${options.issue}`)
  createWrite(root, path, `# ${id} ${title}\n\n${fields.join('\n')}\n`)
  console.log(`✔ created ${path}`)
  console.log(`Next: write its goal and checks under "## Plan", or link "- Plan:" to a plan section; then ${guard} claim ${id}`)
}

/** task <id>: prints the task file, then the plan section its Plan link points to. */
export function taskCommand(id) {
  if (!id) createRefuse('task needs an id, as in task S4')
  if (!TASK_ID.test(id)) createRefuse(`"${id}" is not a task id: write one to four capital letters and a number, such as S4 or S4.1`)
  const { reader, config } = createSetup()
  const task = laneTasks(reader, config.dir).find((each) => each.id === id)
  if (!task) createRefuse(`there is no task ${id} in ${config.dir}/tasks; run work to see the tasks, or new to create one`)

  const text = reader.read(task.file) ?? ''
  process.stdout.write(`${task.file}\n\n${text.endsWith('\n') ? text : `${text}\n`}`)
  if (task.plan === null) return

  const link = relativeLinks(task.plan)[0]
  if (!link || link.path === '') createRefuse(`the Plan field is not a link to a plan section: "${task.plan}". Write "- Plan: [<file>](../plan/<file>.md#<section>)"`)
  const path = resolveLinkPath(task.file, link.path)
  const planText = path === null ? null : reader.read(path)
  if (planText === null) createRefuse(`the Plan link ${link.target} points to ${path ?? 'outside the repository'}, which does not exist. Fix the link in ${task.file}`)
  let shown = planText
  if (link.anchor) {
    const section = findSection(planText, link.anchor)
    if (!section) createRefuse(`the Plan link points to #${link.anchor}, which is not a section in ${path}. Fix the anchor in ${task.file}`)
    const heading = planText.split(/\r?\n/)[section.line - 1]
    shown = [heading, ...section.lines].join('\n').replace(/\s+$/, '')
  }
  process.stdout.write(`\n${path}${link.anchor ? `#${link.anchor}` : ''}\n\n${shown.replace(/\s+$/, '')}\n`)
}
