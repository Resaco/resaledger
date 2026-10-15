// changes (spec 8): the tasks that became done since a tag, with their evidence, grouped as
// Keep a Changelog does, as a draft for the changelog and the release notes. It only reads git
// and never writes a file.
import { spawnSync } from 'node:child_process'
import { loadConfig } from './config.mjs'
import { resolveLinkPath } from './markdown.mjs'
import { rangeObjects, readCommits, taskTrailers } from './range.mjs'
import { parseTask } from './tasks.mjs'
import { fail, repositoryRoot } from './util.mjs'
import { compareTaskIds } from './work.mjs'
import { treeReader } from './workspace.mjs'

const CHANGES_TYPE = /^([A-Za-z]+)(?:\([^()]*\))?!?: \S/
const CHANGES_FILE_ID = /^([A-Z]{1,4}\d+(?:\.\d+)*)(?:-[^/]+)?\.md$/
const CHANGES_LINK = /\]\((<[^>]*>|[^)\s]+)\)/g
const CHANGES_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const CHANGES_HASH_LINE = /^@([0-9a-f]{40}|[0-9a-f]{64})$/
// Keep a Changelog order; Deprecated, Removed and Security have no Conventional Commit type.
const CHANGES_GROUPS = ['Added', 'Changed', 'Fixed']

/** Runs git in the repository: { status, stdout } with stdout as trimmed text. */
function changesGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  return { status: result.status, stdout: (result.stdout ?? '').trim() }
}

/** The options: { since, json }; anything else is a refusal. */
function changesOptions(args) {
  const options = { since: null, json: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') options.json = true
    else if (arg === '--since') {
      if (!args[index + 1]) fail('--since needs a tag, branch or commit, such as --since v1.0.0')
      options.since = args[index + 1]
      index += 1
    } else fail(`unknown option "${arg}" for changes; use changes [--since <ref>] [--json]`)
  }
  return options
}

/** The start of the range: { ref, commit }, from --since or the newest tag; both null with no tag. */
function changesStart(root, since) {
  if (since !== null) {
    const resolved = since.startsWith('-') ? { status: 1 } : changesGit(root, ['rev-parse', '--verify', '--quiet', `${since}^{commit}`])
    if (resolved.status !== 0) fail(`"${since}" is not a tag, branch or commit in this repository; give one that exists, such as a tag from "git tag"`)
    return { ref: since, commit: resolved.stdout }
  }
  const tag = changesGit(root, ['describe', '--tags', '--abbrev=0', 'HEAD'])
  if (tag.status !== 0) return { ref: null, commit: null }
  return { ref: tag.stdout, commit: changesGit(root, ['rev-parse', '--verify', '--quiet', `${tag.stdout}^{commit}`]).stdout }
}

/** The tasks in a commit, as a Map from id to the parsed task. */
function changesTasks(root, rev, dir) {
  const reader = treeReader({ kind: 'commit', rev, root })
  const tasks = new Map()
  for (const path of reader.list(`${dir}/tasks`)) {
    if (!path.endsWith('.md')) continue
    const task = parseTask(path, reader.read(path) ?? '')
    if (task.id && !tasks.has(task.id)) tasks.set(task.id, task)
  }
  return tasks
}

/**
 * The ids among candidates (done at both ends) whose task file was not done in some commit of
 * the range: reopened and finished again. One git log lists the commits that touch the task
 * files, and one batch reads only the files of the candidates.
 */
function changesReopened(root, dir, from, candidates) {
  if (candidates.size === 0) return new Set()
  const log = changesGit(root, ['-c', 'core.quotePath=false', 'log', '--format=@%H', '--name-only', `${from}..HEAD`, '--', `${dir}/tasks/`])
  if (log.status !== 0) fail('cannot read the history of the task files from git')
  const specs = []
  let hash = null
  for (const line of log.stdout.split('\n')) {
    const commit = CHANGES_HASH_LINE.exec(line)
    if (commit) hash = commit[1]
    else if (hash && line.startsWith(`${dir}/tasks/`)) {
      const id = CHANGES_FILE_ID.exec(line.slice(dir.length + 7))?.[1]
      if (candidates.has(id)) specs.push(`${hash}:${line}`)
    }
  }
  const reopened = new Set()
  for (const [spec, object] of rangeObjects(root, specs)) {
    const path = spec.slice(spec.indexOf(':') + 1)
    const task = parseTask(path, object.data.toString('utf8'))
    if (candidates.has(task.id) && task.status !== 'done') reopened.add(task.id)
  }
  return reopened
}

/**
 * The Conventional Commit types of the commits in the range that name each task, as a Map from
 * id to types (null for a free-form subject). The commit claim makes is left out: it says
 * nothing about the change.
 */
function changesTypes(commits, ids) {
  const types = new Map([...ids].map((id) => [id, []]))
  for (const commit of commits) {
    const type = CHANGES_TYPE.exec(commit.subject)?.[1].toLowerCase() ?? null
    for (const id of taskTrailers(commit.message).ids) {
      if (!types.has(id) || commit.subject === `chore: claim ${id}`) continue
      types.get(id).push(type)
    }
  }
  return types
}

/** The group of a task from its commit types: Added for any feat, Fixed when all are fix, else Changed. */
function changesGroup(types) {
  if (types.includes('feat')) return 'Added'
  if (types.length > 0 && types.every((type) => type === 'fix')) return 'Fixed'
  return 'Changed'
}

/** A task's evidence as one line, its relative links rewritten from the task file to the repository root. */
function changesEvidence(task) {
  if (!task.evidence) return ''
  const parts = [task.evidence.value, ...task.evidence.items].map((part) => part.trim()).filter((part) => part !== '')
  return parts.join('; ').replace(CHANGES_LINK, (whole, raw) => {
    const target = raw.startsWith('<') ? raw.slice(1, -1) : raw
    if (target === '' || target.startsWith('#') || target.startsWith('//') || CHANGES_SCHEME.test(target)) return whole
    const hash = target.indexOf('#')
    const path = resolveLinkPath(task.file, hash === -1 ? target : target.slice(0, hash))
    if (path === null) return whole
    const rewritten = `${path}${hash === -1 ? '' : target.slice(hash)}`
    return raw.startsWith('<') ? `](<${rewritten}>)` : `](${rewritten})`
  })
}

/** The draft as data: { since, from, to, grouped, tasks: [{ id, title, file, group, evidence }], dropped }. */
export function changesData(root, since) {
  const head = changesGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  if (head.status !== 0) fail('this repository has no commits yet')
  const loaded = loadConfig(treeReader({ kind: 'commit', rev: head.stdout, root }))
  if (!loaded.config) fail(loaded.problems.map((problem) => problem.message).join('; '))
  const { dir } = loaded.config
  const start = changesStart(root, since)

  const now = changesTasks(root, head.stdout, dir)
  const before = start.commit ? changesTasks(root, start.commit, dir) : new Map()
  const doneBefore = new Set([...now.keys()].filter((id) => now.get(id).status === 'done' && before.get(id)?.status === 'done'))
  const reopened = start.commit ? changesReopened(root, dir, start.commit, doneBefore) : new Set()
  const finished = [...now.values()].filter((task) => task.status === 'done' && (!doneBefore.has(task.id) || reopened.has(task.id)))
  const dropped = [...now.values()].filter((task) => task.status === 'dropped' && before.get(task.id)?.status !== 'dropped')

  const commits = readCommits(root, start.commit ? [`${start.commit}..${head.stdout}`] : [head.stdout])
  const types = changesTypes(commits, finished.map((task) => task.id))
  const grouped = [...types.values()].some((list) => list.some((type) => type !== null))
  const tasks = finished
    .sort((a, b) => compareTaskIds(a.id, b.id))
    .map((task) => ({ id: task.id, title: task.title, file: task.file, group: grouped ? changesGroup(types.get(task.id)) : null, evidence: changesEvidence(task) }))
  return { since: start.ref, from: start.commit, to: head.stdout, grouped, tasks, dropped: dropped.map((task) => task.id).sort(compareTaskIds) }
}

/** One Markdown list line: the id and title, then the evidence. */
function changesLine(task) {
  return `- ${task.id} ${task.title}${task.evidence ? ` — ${task.evidence}` : ''}`
}

/** The draft as Markdown, ready to paste into a CHANGELOG. */
export function changesMarkdown(data) {
  const lines = [data.since ? `## Changes since ${data.since}` : '## Changes since the first commit', '']
  if (!data.since) lines.push('No tag is reachable from HEAD, so this covers the whole history.', '')
  if (data.tasks.length === 0) lines.push(`No task became done since ${data.since ?? 'the first commit'}.`, '')
  else if (!data.grouped) lines.push(...data.tasks.map(changesLine), '')
  else {
    for (const group of CHANGES_GROUPS) {
      const members = data.tasks.filter((task) => task.group === group)
      if (members.length > 0) lines.push(`### ${group}`, '', ...members.map(changesLine), '')
    }
  }
  if (data.dropped.length > 0) lines.push(`Not listed: ${data.dropped.join(', ')}, dropped in this range.`, '')
  return `${lines.join('\n').trimEnd()}\n`
}

/** changes [--since <ref>] [--json]: prints the draft; read-only. */
export function changesCommand(args) {
  const options = changesOptions(args)
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }
  const data = changesData(root, options.since)
  if (options.json) console.log(JSON.stringify(data, null, 2))
  else process.stdout.write(changesMarkdown(data))
}
