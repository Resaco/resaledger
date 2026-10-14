#!/usr/bin/env node
// agent-ledger 0.3.0
// Guard for a repository that agents and people share. In ledger mode it checks the
// project records (task ledger, status file, session log) and commit messages. In both
// modes it runs the project's own quality gates, keeps commits and pushes off protected
// branches, and answers the agent hooks of Claude Code.
// One file with no dependencies, for Node or Bun, so the git hooks work on any machine.
// `agent-ledger update` replaces this file. Change behaviour in .agent-ledger.json,
// not here.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, posix, relative, resolve } from 'node:path'

const VERSION = '0.3.0'
const CONFIG = '.agent-ledger.json'
const STATUSES = ['todo', 'doing', 'blocked', 'done']
const STATUS_SECTIONS = [
  'Phase',
  'Active work',
  'Last verified',
  'Next step',
  'Waiting for the owner'
]
const STATUS_MAX_LINES = 80
const MAX_DOING = 3
const COMMIT_TYPES = 'feat|fix|refactor|perf|docs|test|build|ci|chore'
const AI_TRAILER =
  /^(co-authored-by|ai-assisted-by|generated-by|signed-off-by):.*\b(claude|anthropic|openai|chatgpt|gpt|codex|kimi|moonshot|cursor|copilot|gemini|grok)\b/im
const IMAGE = /\.(avif|gif|jpe?g|png|svg|webp)$/i
// init leaves this marker where the project has to write its own text.
const SETUP_MARK = 'TODO(agent-ledger)'

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function stop(message, code = 1) {
  console.error(`\n✖ ${message}\n`)
  process.exit(code)
}

// Every path below is relative to the repository root, whatever folder the guard is run from.
try {
  process.chdir(git('rev-parse', '--show-toplevel'))
} catch {
  stop('records.mjs must be run inside a git repository')
}

function loadConfig() {
  if (!existsSync(CONFIG)) stop(`${CONFIG} is missing in the repository root: run "agent-ledger init"`)
  let raw
  try {
    raw = JSON.parse(readFileSync(CONFIG, 'utf8'))
  } catch (error) {
    stop(`${CONFIG} is not valid JSON: ${error.message}`)
  }
  const dir = String(raw.dir ?? '').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!dir || dir.startsWith('/') || dir.split('/').includes('..'))
    stop(`${CONFIG}: "dir" must name the workspace folder inside the repository, for example "project"`)
  const strings = (list) =>
    Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item.trim()) : []
  const prefixes = (list) =>
    strings(list).map((path) => `${path.replace(/^\.?\//, '').replace(/\/+$/, '')}/`)
  const mode = raw.mode === 'guard' ? 'guard' : 'ledger'
  const patternText = typeof raw.branches?.pattern === 'string' ? raw.branches.pattern : ''
  let pattern = null
  try {
    if (patternText) pattern = new RegExp(patternText)
  } catch (error) {
    stop(`${CONFIG}: branches.pattern is not a regular expression: ${error.message}`)
  }
  const deny = (Array.isArray(raw.agent?.deny) ? raw.agent.deny : []).filter(
    (rule) => rule && typeof rule.pattern === 'string'
  )
  return {
    dir,
    mode,
    forbidAiAttribution: raw.aiAttribution === 'forbid',
    conventionalCommits:
      (raw.commitStyle ?? (mode === 'guard' ? 'free' : 'conventional')) === 'conventional',
    branches: { protected: strings(raw.branches?.protected), pattern, patternText },
    requirePushed: raw.requirePushed === true,
    gates: {
      commit: strings(raw.gates?.commit),
      verify: strings(raw.gates?.verify),
      skipPaths: prefixes(raw.gates?.skipPaths)
    },
    codePaths: prefixes(raw.codePaths),
    deny
  }
}

const config = loadConfig()
// Guard mode has no ledger and no records: only the gates, the branch rules and the hooks.
const GUARD_MODE = config.mode === 'guard'
const DIR = config.dir
const LEDGER = `${DIR}/work/ledger.md`
const STATUS = `${DIR}/STATUS.md`
const LOG = `${DIR}/work/log.md`
const DECISIONS = `${DIR}/DECISIONS.md`
const STAMP = GUARD_MODE ? `${DIR}/verified.json` : `${DIR}/work/verified.json`
const GATE_OUTPUT_LINES = 80
const GUARD = `node ${DIR}/scripts/records.mjs`

function isEmpty(value) {
  return !value || /^[—–-]$/.test(value.trim())
}

/**
 * A record is a document in the workspace folder. Its scripts, the hooks and the
 * configured code paths count as code, and so does everything outside it that is not
 * Markdown.
 */
function isCode(path) {
  if (GUARD_MODE)
    return path !== STAMP && !config.gates.skipPaths.some((prefix) => path.startsWith(prefix))
  if (path.startsWith('.githooks/')) return true
  if (!path.startsWith(`${DIR}/`)) return !path.endsWith('.md')
  const inside = path.slice(DIR.length + 1)
  if (inside.startsWith('scripts/')) return true
  if (config.codePaths.some((prefix) => inside.startsWith(prefix))) return !IMAGE.test(path)
  return false
}

function parseLedger(markdown) {
  const tasks = []
  let current = null
  markdown.split('\n').forEach((line, index) => {
    const heading = line.match(/^### ([A-Z]\d+(?:\.\d+)?) (.+)$/)
    if (heading) {
      current = {
        id: heading[1],
        title: heading[2].trim(),
        status: '',
        dependsOn: [],
        plan: '',
        evidence: '',
        notes: '',
        line: index + 1
      }
      tasks.push(current)
      return
    }
    if (/^#{1,3} /.test(line)) current = null
    const field = line.match(/^- (Status|Depends on|Plan|Evidence|Notes): (.*)$/)
    if (!current || !field) return
    const value = field[2].trim()
    if (field[1] === 'Status') current.status = value
    if (field[1] === 'Depends on')
      current.dependsOn = isEmpty(value) ? [] : value.split(/,\s*/).map((id) => id.trim())
    if (field[1] === 'Plan') current.plan = isEmpty(value) ? '' : value
    if (field[1] === 'Evidence') current.evidence = isEmpty(value) ? '' : value
    if (field[1] === 'Notes') current.notes = isEmpty(value) ? '' : value
  })
  return tasks
}

/** Headings of a Markdown text with the anchors a renderer gives them. Fenced blocks are skipped. */
function headings(markdown) {
  const found = []
  const seen = new Map()
  let fence = false
  markdown.split('\n').forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    const heading = fence ? null : line.match(/^(#{1,6}) +(.+?)\s*#*\s*$/)
    if (!heading) return
    const base = heading[2]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\p{Pc}\- ]/gu, '')
      .replaceAll(' ', '-')
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    found.push({ level: heading[1].length, anchor: count ? `${base}-${count}` : base, index })
  })
  return found
}

/** The lines of the section an anchor names, heading first, or null when there is none. */
function section(file, anchor) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const all = headings(lines.join('\n'))
  const start = all.find((heading) => heading.anchor === anchor.toLowerCase())
  if (!start) return null
  const next = all.find((heading) => heading.index > start.index && heading.level <= start.level)
  return lines.slice(start.index, next ? next.index : lines.length)
}

/** Links in a ledger field that point into the repository, as { file, anchor }. */
function localLinks(value) {
  const links = []
  for (const match of value.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1]
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue
    const [path, anchor = ''] = target.split('#')
    let decoded = path
    try {
      decoded = decodeURI(path)
    } catch {
      // keep the raw path
    }
    links.push({ file: posix.normalize(posix.join(posix.dirname(LEDGER), decoded)), anchor, target })
  }
  return links
}

function linkProblems(task) {
  const problems = []
  const at = `${LEDGER}: ${task.id} (line ${task.line})`
  for (const [field, value] of [
    ['Plan', task.plan],
    ['Evidence', task.evidence],
    ['Notes', task.notes]
  ])
    for (const link of localLinks(value)) {
      if (!existsSync(link.file)) {
        problems.push(`${at}: ${field} links to ${link.target}, which does not exist`)
        continue
      }
      if (field !== 'Plan' || !link.anchor || !link.file.endsWith('.md')) continue
      const body = section(link.file, link.anchor)
      if (!body)
        problems.push(`${at}: Plan links to #${link.anchor}, but ${link.file} has no such section`)
      else if (task.status === 'doing' && !body.slice(1).some((line) => line.trim()))
        problems.push(
          `${at}: the plan section #${link.anchor} is only a heading; write the goal and the acceptance checks before the work starts`
        )
    }
  return problems
}

function ledgerProblems(tasks) {
  const problems = []
  const ids = new Set()
  for (const task of tasks) {
    const at = `${LEDGER}: ${task.id} (line ${task.line})`
    if (ids.has(task.id)) problems.push(`${at}: duplicate id`)
    ids.add(task.id)
    if (!STATUSES.includes(task.status))
      problems.push(`${at}: Status must be one of ${STATUSES.join(', ')}`)
    if (task.plan && !/\]\([^)]+\)/.test(task.plan))
      problems.push(`${at}: Plan must be a Markdown link to a plan section, or —`)
    if (task.status === 'doing' && !task.plan)
      problems.push(`${at}: a task needs a Plan link before it is doing`)
    if (task.status === 'done' && !task.evidence)
      problems.push(`${at}: a done task needs Evidence someone else can rerun or open`)
    if (task.status === 'blocked' && !task.notes)
      problems.push(`${at}: a blocked task needs Notes: the reason and who can unblock it`)
    problems.push(...linkProblems(task))
  }
  for (const task of tasks)
    for (const dep of task.dependsOn)
      if (!ids.has(dep)) problems.push(`${LEDGER}: ${task.id} depends on unknown task ${dep}`)
  const doing = tasks.filter((task) => task.status === 'doing')
  if (doing.length > MAX_DOING)
    problems.push(
      `${LEDGER}: ${doing.length} tasks are doing (${doing.map((task) => task.id).join(', ')}); finish or hand off before starting more (at most ${MAX_DOING})`
    )
  return problems
}

function statusProblems(text) {
  const problems = []
  const lines = text.split('\n')
  if (!/^Updated: \d{4}-\d{2}-\d{2} · by \S.*$/m.test(text))
    problems.push(`${STATUS}: needs a line "Updated: YYYY-MM-DD · by <agent or person>"`)
  for (const section of STATUS_SECTIONS)
    if (!lines.includes(`## ${section}`)) problems.push(`${STATUS}: section "## ${section}" is missing`)
  if (text.trimEnd().split('\n').length > STATUS_MAX_LINES)
    problems.push(
      `${STATUS}: longer than ${STATUS_MAX_LINES} lines; history belongs in ${LOG}, not in the status file`
    )
  return problems
}

function recordProblems() {
  if (GUARD_MODE) return []
  const problems = []
  for (const file of [LEDGER, STATUS, LOG, DECISIONS])
    if (!existsSync(file)) problems.push(`${file} is missing`)
  if (problems.length > 0) return problems
  return [
    ...ledgerProblems(parseLedger(readFileSync(LEDGER, 'utf8'))),
    ...statusProblems(readFileSync(STATUS, 'utf8'))
  ]
}

/** Text that init left for the project to write: the workspace is not set up until it is gone. */
function setupProblems() {
  if (GUARD_MODE) return []
  const files = readdirSync(DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => `${DIR}/${name}`)
  if (existsSync(`${DIR}/plan/README.md`)) files.push(`${DIR}/plan/README.md`)
  const problems = []
  for (const file of files) {
    const count = readFileSync(file, 'utf8').split(SETUP_MARK).length - 1
    if (count > 0)
      problems.push(`${file}: ${count} ${SETUP_MARK} marker(s) left; write the project's own text there`)
  }
  return problems
}

/** A clone without the hooks skips every check silently. */
function hookProblems() {
  let hooks = ''
  try {
    hooks = git('rev-parse', '--git-path', 'hooks')
  } catch {
    return []
  }
  const file = posix.join(hooks, 'commit-msg')
  if (existsSync(file) && readFileSync(file, 'utf8').includes('records.mjs')) return []
  return ['the git hooks are not active in this clone: run "git config core.hooksPath .githooks"']
}

function report(title, problems) {
  if (problems.length === 0) return
  console.error(`\n✖ ${title}\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error(
    GUARD_MODE ? `\nRules: AGENTS.md and ${CONFIG}\n` : `\nRules: ${DIR}/AGENTS.md and ${DIR}/standards.md\n`
  )
  process.exit(1)
}

function currentBranch() {
  try {
    return git('symbolic-ref', '--short', '-q', 'HEAD')
  } catch {
    return ''
  }
}

/** Work happens on a named branch, never directly on a protected one. */
function branchProblems() {
  const branch = currentBranch()
  if (!branch || existsSync(git('rev-parse', '--git-path', 'MERGE_HEAD'))) return []
  if (config.branches.protected.includes(branch))
    return [`commits are not made on ${branch}: create a branch and open a pull request`]
  if (config.branches.pattern && !config.branches.pattern.test(branch))
    return [`the branch name "${branch}" does not match ${config.branches.patternText}`]
  return []
}

/** How far the current branch is from its remote, as problems, when the project wants work pushed. */
function pushProblems() {
  const branch = currentBranch()
  if (!config.requirePushed || !branch) return []
  let upstream = ''
  try {
    upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
  } catch {
    // no upstream
  }
  if (!upstream) {
    let unique = '1'
    try {
      unique = git('rev-list', '--count', 'HEAD', '--not', '--remotes')
    } catch {
      // no commits yet
    }
    return unique === '0' ? [] : [`the branch ${branch} is not on the remote: git push -u origin HEAD`]
  }
  const ahead = git('rev-list', '--count', '@{u}..HEAD')
  return ahead === '0' ? [] : [`${ahead} commit(s) on ${branch} are not pushed: git push`]
}

/**
 * Runs the project's gate commands from the repository root, in order, and stops at the
 * first failure. Output is shown only for the gate that fails, so a passing run stays short.
 */
function runGates(commands) {
  const passed = []
  for (const run of commands) {
    const started = Date.now()
    const result = spawnSync(run, {
      shell: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024
    })
    const seconds = Math.round((Date.now() - started) / 100) / 10
    if (result.status !== 0) {
      const lines = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd().split('\n')
      if (lines.length > GATE_OUTPUT_LINES) console.error(`… ${lines.length - GATE_OUTPUT_LINES} lines above`)
      console.error(lines.slice(-GATE_OUTPUT_LINES).join('\n'))
      const how = result.error ? result.error.message : `exited with ${result.status ?? result.signal}`
      report('A quality gate failed', [
        `\`${run}\` ${how}. Fix the code; a gate is never weakened to make it pass`
      ])
    }
    console.error(`✔ ${run} (${seconds} s)`)
    passed.push({ run, seconds })
  }
  return passed
}

/** A hash of every tracked code file, so a gate result can be tied to the code it was run on. */
function codeFingerprint() {
  const entries = git('ls-files', '-s', '-z')
    .split('\0')
    .filter((entry) => entry && isCode(entry.slice(entry.indexOf('\t') + 1)))
  return createHash('sha1').update(entries.join('\n')).digest('hex')
}

function uncommittedCode() {
  let changed = ''
  try {
    changed = git('diff', '--name-only', 'HEAD')
  } catch {
    changed = git('ls-files')
  }
  const untracked = git('ls-files', '--others', '--exclude-standard')
  return `${changed}\n${untracked}`.split('\n').filter((path) => path && isCode(path))
}

function gateProblems() {
  if (config.gates.verify.length === 0) return []
  let stamp = null
  try {
    stamp = JSON.parse(readFileSync(STAMP, 'utf8'))
  } catch {
    // no stamp, or not readable
  }
  if (!stamp) return [`the quality gates have not been run: run "${GUARD} verify" and commit ${STAMP}`]
  if (stamp.code !== codeFingerprint())
    return [
      `the code changed after the quality gates last passed (${stamp.verified}): run "${GUARD} verify" and commit ${STAMP}`
    ]
  return []
}

/** The pre-commit hook: the shape of the records, then the fast gates when code is committed. */
function preCommit() {
  report('This commit is not allowed', branchProblems())
  report('The project records have problems', recordProblems())
  if (config.gates.commit.length === 0) return
  const staged = git('diff', '--cached', '--name-only').split('\n').filter(Boolean)
  if (staged.some(isCode)) runGates(config.gates.commit)
}

/** The pre-push hook: nothing is pushed straight to a protected branch. */
function prePush() {
  let refs = ''
  try {
    refs = readFileSync(0, 'utf8')
  } catch {
    // no refs on stdin
  }
  const problems = new Set()
  for (const line of refs.split('\n').filter(Boolean)) {
    const name = (line.split(' ')[2] ?? '').replace(/^refs\/heads\//, '')
    if (config.branches.protected.includes(name))
      problems.add(`pushing to ${name} is not allowed: push your branch and open a pull request`)
  }
  report('This push is not allowed', [...problems])
}

/** Runs every gate on the committed code and records that they passed on exactly that code. */
function verify() {
  const commands = [...config.gates.commit, ...config.gates.verify]
  if (commands.length === 0) {
    console.log(`No gates are configured in ${CONFIG}.`)
    return
  }
  const pending = uncommittedCode()
  if (pending.length > 0)
    report('Not ready to verify', [
      `uncommitted code (${pending.slice(0, 5).join(', ')}${pending.length > 5 ? ', …' : ''}): commit it first, because the result is recorded for committed code`
    ])
  const gates = runGates(commands)
  const stamp = { version: 1, code: codeFingerprint(), verified: new Date().toISOString(), gates }
  writeFileSync(STAMP, `${JSON.stringify(stamp, null, 2)}\n`)
  console.log(`All ${gates.length} gates passed. Commit ${STAMP} with the records.`)
}

function showGates() {
  const print = (title, list) => {
    console.log(`\n${title}`)
    if (list.length === 0) console.log('  none')
    for (const run of list) console.log(`  ${run}`)
  }
  print('On every commit that changes code (pre-commit hook)', config.gates.commit)
  print(`Before handoff ("${GUARD} verify" runs these and the ones above)`, config.gates.verify)
  console.log(
    GUARD_MODE
      ? `\nCommands: ${CONFIG}\n`
      : `\nGates that need eyes or judgement are in ${DIR}/standards.md. Commands: ${CONFIG}\n`
  )
}

/** Guard mode has no ledger: where the clone stands and what the hooks will hold it to. */
function guardStatus() {
  const branch = currentBranch()
  const isProtected = config.branches.protected.includes(branch)
  const dirty = git('status', '--porcelain').split('\n').filter(Boolean).length
  console.log(`\nBranch: ${branch || '(detached)'}${isProtected ? ' (protected)' : ''}`)
  if (isProtected)
    console.log('  Create a branch before you change anything; commits and pushes here are refused.')
  for (const problem of [...branchProblems().filter(() => !isProtected), ...pushProblems()])
    console.log(`  ${problem}`)
  console.log(`Uncommitted paths: ${dirty}`)
  if (config.branches.protected.length > 0)
    console.log(`Protected branches: ${config.branches.protected.join(', ')}`)
  if (config.branches.patternText) console.log(`Branch names: ${config.branches.patternText}`)
  console.log(`Gates on every commit: ${config.gates.commit.length}, before handoff: ${config.gates.verify.length} (${GUARD} gates)`)
  console.log(`Before you stop: ${GUARD} handoff. Rules: AGENTS.md\n`)
}

function work() {
  if (GUARD_MODE) return guardStatus()
  const tasks = parseLedger(readFileSync(LEDGER, 'utf8'))
  const done = new Set(tasks.filter((task) => task.status === 'done').map((task) => task.id))
  const ready = tasks.filter(
    (task) => task.status === 'todo' && task.dependsOn.every((dep) => done.has(dep))
  )
  const print = (heading, list, withNotes) => {
    console.log(`\n${heading}`)
    if (list.length === 0) console.log('  none')
    for (const task of list) {
      console.log(`  ${task.id}  ${task.title}`)
      if (withNotes && task.notes) console.log(`        ${task.notes}`)
    }
  }
  print('Doing (read the notes: they are the handoff)', tasks.filter((t) => t.status === 'doing'), true)
  print('Blocked', tasks.filter((t) => t.status === 'blocked'), true)
  print('Ready next, in ledger order', ready.slice(0, 5), false)
  console.log(`\n${done.size} of ${tasks.length} tasks done. Ledger: ${LEDGER}`)
  console.log(`One task with its plan section: ${GUARD} task <id>\n`)
}

/** One task and the plan section it links to, so nobody has to read the whole ledger. */
function showTask(id) {
  const text = readFileSync(LEDGER, 'utf8')
  const task = parseLedger(text).find((candidate) => candidate.id === id)
  if (!task) stop(`task ${id} is not in ${LEDGER}`)
  const lines = text.split('\n')
  let end = task.line
  while (end < lines.length && !/^#{1,3} /.test(lines[end])) end++
  console.log(lines.slice(task.line - 1, end).join('\n').trimEnd())
  const plan = localLinks(task.plan).find((link) => link.anchor && existsSync(link.file))
  const body = plan && section(plan.file, plan.anchor)
  if (!body) return
  console.log(`\n--- ${plan.file}#${plan.anchor} ---\n`)
  console.log(body.join('\n').trimEnd())
}

function commitMessage(file) {
  const fail = (message) => report('Commit message rejected', [message])
  const message = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .trim()
  const header = message.split('\n')[0] ?? ''
  if (/^(Merge|Revert) /.test(header) || /^Release v\d+\.\d+\.\d+$/.test(header)) return

  if (
    config.conventionalCommits &&
    !new RegExp(`^(${COMMIT_TYPES})(\\([A-Za-z0-9./-]+\\))?!?: \\S.{0,99}$`).test(header)
  )
    fail(
      `the first line must be "type(scope): summary" with type ${COMMIT_TYPES.replaceAll('|', ', ')} and at most 100 characters of summary`
    )
  if (config.forbidAiAttribution && AI_TRAILER.test(message))
    fail('no AI attribution in commits: remove the co-author, sign-off or assisted-by trailer')
  if (GUARD_MODE) return

  const staged = git('diff', '--cached', '--name-only').split('\n').filter(Boolean)
  if (!staged.some(isCode)) return

  const trailer = message.match(/^Task:\s*(\S+)\s*$/m)
  if (!trailer)
    fail(
      `a commit that changes code needs a "Task: <ledger id>" trailer, or "Task: maintenance" when no behaviour changes. See ${LEDGER}`
    )
  const id = trailer[1]
  if (id === 'maintenance') return

  let ledger = ''
  try {
    ledger = git('show', `:${LEDGER}`)
  } catch {
    ledger = readFileSync(LEDGER, 'utf8')
  }
  const task = parseLedger(ledger).find((candidate) => candidate.id === id)
  if (!task) fail(`task ${id} is not in ${LEDGER}; add it with a plan link before the code`)
  if (!['doing', 'done'].includes(task.status))
    fail(
      `task ${id} is ${task.status}. Claim it first: set it to doing in ${LEDGER}, in this commit or an earlier one`
    )
}

/** The newest commit whose files satisfy the test, or '' when there is none. */
function newestCommit(test) {
  let log = ''
  try {
    log = git('log', '-n', '300', '--name-only', '--format=%x00%H')
  } catch {
    return ''
  }
  for (const entry of log.split('\0').filter(Boolean)) {
    const [hash, ...files] = entry.split('\n').filter(Boolean)
    if (files.some(test)) return hash
  }
  return ''
}

function isAncestor(older, newer) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', older, newer])
    return true
  } catch {
    return false
  }
}

function handoffProblems() {
  const problems = recordProblems()
  if (problems.length === 0) problems.push(...setupProblems())
  problems.push(...hookProblems())
  problems.push(...gateProblems())
  const dirty = git('status', '--porcelain')
  if (dirty)
    problems.push(
      `uncommitted changes (${dirty.split('\n').length} paths): commit them or remove them; uncommitted work is not a handoff`
    )
  problems.push(...pushProblems())
  if (GUARD_MODE) return problems
  const code = newestCommit(isCode)
  if (code) {
    const short = code.slice(0, 9)
    for (const [file, what] of [
      [STATUS, 'the phase, the last verified state and the next step'],
      [LOG, 'a dated entry on what this session did'],
      [LEDGER, 'the status, evidence and notes of the task']
    ]) {
      const record = newestCommit((path) => path === file)
      if (!record || !isAncestor(code, record))
        problems.push(`${file} is older than the last code commit ${short}: record ${what}`)
    }
  }
  if (existsSync(LEDGER))
    for (const task of parseLedger(readFileSync(LEDGER, 'utf8')))
      if (task.status === 'doing' && !task.notes)
        problems.push(`${LEDGER}: ${task.id} is doing without Notes; write the exact next step`)
  return problems
}

function handoff() {
  report('Not ready to hand off', handoffProblems())
  const gates = config.gates.verify.length > 0 ? ', and the quality gates passed on this code' : ''
  if (GUARD_MODE)
    console.log(`Nothing is left behind: the tree is clean${config.requirePushed ? ' and pushed' : ''}${gates}.`)
  else if (gates) console.log(`Records are complete${gates}.`)
  else console.log('Records are complete: ledger, status and log cover the last code commit.')
}

// --- Agent hooks (Claude Code): the same rules, applied before the agent acts ---

const BUILT_IN_DENY = [
  {
    pattern: '--no-verify\\b|\\bgit\\s+commit\\b[^\\n;&|]*\\s-[a-mo-zA-Z]*n[a-zA-Z]*(?:\\s|$)',
    reason: 'Hooks are never bypassed. Fix what the hook reports.'
  },
  {
    pattern: 'core\\.hooksPath(?!\\s+\\.githooks(?:\\s|$))',
    reason: 'The hooks path stays .githooks.'
  },
  {
    pattern: '\\bgit\\s+push\\b[^\\n;&|]*\\s(?:--force(?!-with-lease)|-f)(?:\\s|$)',
    reason: 'No forced pushes. If your own branch was rebased, use --force-with-lease.'
  }
]

function hookInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return {}
  }
}

function sessionFile(input) {
  const id = String(input.session_id ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_')
  return join(tmpdir(), `agent-ledger-${id}.json`)
}

function repositoryState() {
  let head = ''
  try {
    head = git('rev-parse', 'HEAD')
  } catch {
    // no commits yet
  }
  return createHash('sha1').update(`${head}\n${git('status', '--porcelain')}`).digest('hex')
}

/** A file's path inside the repository, also through a linked folder, or '' when it is outside. */
function repositoryPath(file) {
  let base = resolve(file)
  const rest = []
  while (!existsSync(base) && dirname(base) !== base) {
    rest.unshift(basename(base))
    base = dirname(base)
  }
  try {
    base = realpathSync(base)
  } catch {
    // keep the path as given
  }
  const path = relative(process.cwd(), join(base, ...rest)).split('\\').join('/')
  return path.startsWith('..') ? '' : path
}

/** The reason a tool call is refused, or '' when it may run. */
function denied(input) {
  const tool = String(input.tool_name ?? '')
  const args = input.tool_input ?? {}
  const branch = currentBranch()
  const onProtected = config.branches.protected.includes(branch)
  if (tool === 'Bash') {
    const command = String(args.command ?? '')
    // Quoted text, such as a commit message that mentions a flag, is not a flag.
    const bare = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""')
    const rules = [
      ...BUILT_IN_DENY.map((rule) => ({ ...rule, text: bare })),
      ...config.deny.map((rule) => ({ ...rule, text: command }))
    ]
    for (const rule of rules) {
      let matches = false
      try {
        matches = new RegExp(rule.pattern).test(rule.text)
      } catch {
        // a broken pattern in the configuration denies nothing
      }
      if (matches) return rule.reason || `This command is not allowed here (${CONFIG}).`
    }
    for (const push of bare.matchAll(/\bgit\s+push\b([^\n;&|]*)/g)) {
      const refs = push[1].split(/\s+/).filter((word) => word && !word.startsWith('-')).slice(1)
      const targets = refs.map((ref) => ref.split(':').pop().replace(/^\+/, ''))
      const target = targets.find((name) => config.branches.protected.includes(name))
      if (target || (refs.length === 0 && onProtected))
        return `Pushing to ${target ?? branch} is not allowed. Push your branch and open a pull request.`
    }
    return ''
  }
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool) && onProtected) {
    const file = String(args.file_path ?? args.notebook_path ?? '')
    const inside = file ? repositoryPath(file) : ''
    if (inside && isCode(inside))
      return `You are on ${branch}, which is protected. Create a branch before you change files.`
  }
  return ''
}

function agentHook(event) {
  const input = hookInput()
  if (event === 'session-start') {
    writeFileSync(sessionFile(input), JSON.stringify({ state: repositoryState(), nudged: false }))
    console.log(
      'This repository is guarded: git hooks check every commit and push, and the rules are in AGENTS.md.'
    )
    work()
    return
  }
  if (event === 'pre-tool') {
    const reason = denied(input)
    if (!reason) return
    console.error(reason)
    process.exit(2)
  }
  if (event === 'stop') {
    if (input.stop_hook_active) return
    let session = {}
    try {
      session = JSON.parse(readFileSync(sessionFile(input), 'utf8'))
    } catch {
      // the session did not start through the hook
    }
    // One reminder per session, and only when this session changed the repository.
    if (session.nudged || session.state === repositoryState()) return
    const problems = handoffProblems()
    if (problems.length === 0) return
    writeFileSync(sessionFile(input), JSON.stringify({ ...session, nudged: true }))
    const reason = `The work in this repository is not handed off:\n${problems.map((problem) => `- ${problem}`).join('\n')}\nFinish it as AGENTS.md says. If it cannot be finished now, tell the user exactly what is left. Never bypass a hook.`
    console.log(JSON.stringify({ decision: 'block', reason }))
  }
}

const [command, argument] = process.argv.slice(2)
if (command === 'work' || command === 'status') work()
else if (command === 'task' && argument && !GUARD_MODE) showTask(argument)
else if (command === 'check') report('The project records have problems', recordProblems())
else if (command === 'pre-commit') preCommit()
else if (command === 'pre-push') prePush()
else if (command === 'hook' && argument) agentHook(argument)
else if (command === 'verify') verify()
else if (command === 'gates') showGates()
else if (command === 'commit-msg' && argument) commitMessage(argument)
else if (command === 'handoff') handoff()
else if (command === 'version') console.log(VERSION)
else {
  console.error(`agent-ledger ${VERSION}
Usage: records.mjs work | task <id> | gates | verify | handoff | check | version
Hooks: pre-commit | commit-msg <file> | pre-push | hook session-start|pre-tool|stop`)
  process.exit(2)
}
