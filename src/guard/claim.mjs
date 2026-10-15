// claim (spec 6.3 and 6.5): take a task safely. It refuses a task that another visible lane
// holds (this worktree, the other local worktrees and the pushed branches as last fetched; the
// team preset fetches first) unless --take records the takeover. On a protected base, or with
// --branch or --worktree, it creates the lane first. It sets Status and Lane, keeping the rest of
// the file byte for byte, after checking the WIP limit and the plan. With claimPush or --push it
// commits the claim on its own, through the hooks, and pushes the branch.
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadConfig } from './config.mjs'
import { currentLane, defaultRemote, laneTasks, localLanes, remoteLanes } from './lanes.mjs'
import { planStatus } from './records.mjs'
import { parseTask, slugify, TASK_ID, validateTask } from './tasks.mjs'
import { fail, repositoryRoot } from './util.mjs'
import { treeReader } from './workspace.mjs'

const CLAIM_FETCH_TIMEOUT = 60 * 1000
const CLAIM_LINE_BREAK = /(\r\n|\r|\n)/

/** Prints a refusal and stops with exit code 1. */
function claimRefuse(message, details = []) {
  console.error(`✖ ${message}`)
  for (const detail of details) console.error(`  ${detail}`)
  process.exit(1)
}

/** Runs git in a folder: { status, stdout, stderr }, with stdout trimmed. */
function claimGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  return { status: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() }
}

/** git's first meaningful line of output, without its "fatal:" or "error:" prefix. */
function claimGitReason(result) {
  const lines = `${result.stderr}\n${result.stdout}`.split('\n').map((line) => line.replace(/^(?:fatal|error):\s*/, '').trim())
  return lines.find((line) => line !== '') ?? `git exited with ${result.status}`
}

/** The arguments of claim, as { id, take, branch, worktree, push }. */
function claimParseArgs(args) {
  const options = { id: null, take: false, branch: null, worktree: null, push: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--take') options.take = true
    else if (arg === '--push') options.push = true
    else if (arg === '--branch' || arg === '--worktree') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--') || value === '')
        claimRefuse(`${arg} needs a value, such as ${arg === '--branch' ? '--branch s4-store-documents' : '--worktree ../s4'}`)
      options[arg.slice(2)] = value
      index += 1
    } else if (arg.startsWith('--')) claimRefuse(`unknown option "${arg}" for claim; use --take, --branch <name>, --worktree <path> or --push`)
    else if (options.id === null) options.id = arg
    else claimRefuse(`claim takes one task id, not "${options.id}" and "${arg}"`)
  }
  if (options.id === null) claimRefuse('claim needs a task id, as in claim S4')
  if (!TASK_ID.test(options.id)) claimRefuse(`"${options.id}" is not a task id: write one to four capital letters and a number, such as S4 or S4.1`)
  return options
}

/**
 * git fetch --prune from the default remote, as { remote, ok, message }: message is git's first
 * line of error when the fetch fails, or why there is nothing to fetch from.
 */
function claimFetch(root, base) {
  const remote = defaultRemote(root, base)
  if (remote === null) return { remote: null, ok: false, message: 'there is no remote' }
  const result = spawnSync('git', ['fetch', '--prune', '--quiet', remote], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: CLAIM_FETCH_TIMEOUT
  })
  if (result.status === 0) return { remote, ok: true, message: null }
  const reason = result.error ? result.error.message : (result.stderr ?? '').split('\n').map((text) => text.replace(/^fatal:\s*/, '').trim()).find((text) => text !== '')
  return { remote, ok: false, message: reason ?? `git fetch exited with ${result.status}` }
}

/** The lane that holds a task: its Lane while doing, or blocked with a Lane; otherwise null. */
function claimHolder(task) {
  if (task.status === 'doing' || task.status === 'blocked') return task.lane
  return null
}

/**
 * The lanes other than `lane` (null for none) that hold the task anywhere visible, as [{ lane, where, commit }],
 * the first sighting of each lane. A lane that some visible copy says was taken over from (with
 * claim --take) no longer holds the task. sources is [{ where, tasks, commit }].
 */
function claimOtherHolders(id, lane, sources) {
  const copies = sources.flatMap((source) => source.tasks.filter((task) => task.id === id).map((task) => ({ task, source })))
  const replaced = new Set(copies.flatMap(({ task }) => (task.takenOverFrom ? task.takenOverFrom.split(/[\s,;`]+/) : [])))
  const holders = new Map()
  for (const { task, source } of copies) {
    const holder = claimHolder(task)
    if (!holder || holder === lane || replaced.has(holder) || holders.has(holder)) continue
    holders.set(holder, { lane: holder, where: source.where, commit: source.commit ?? null })
  }
  return [...holders.values()]
}

/** The short id of a holder's newest commit: its local branch, else where the claim was seen. */
function claimHolderCommit(root, holder) {
  for (const rev of [`refs/heads/${holder.lane}`, holder.commit]) {
    if (!rev) continue
    const result = claimGit(root, ['rev-parse', '--verify', '-q', '--short', `${rev}^{commit}`])
    if (result.status === 0 && result.stdout !== '') return result.stdout
  }
  return null
}

/**
 * The text with a field set: the field's line replaced when it exists, else a new line after
 * the block of the field `after` (or of the last field). Every other byte is kept, line breaks
 * included.
 */
function claimSetField(text, name, value, after) {
  const task = parseTask('task.md', text)
  const parts = text.split(CLAIM_LINE_BREAK)
  const line = `- ${name}: ${value}`
  const existing = task.fields.find((field) => field.name === name)
  if (existing) {
    parts[(existing.line - 1) * 2] = line
    return parts.join('')
  }
  const anchor = task.fields.findIndex((field) => field.name === after)
  const at = anchor === -1 ? task.fields.length - 1 : anchor
  let end // the 1-based last line of the anchor field's block
  if (at + 1 < task.fields.length) end = task.fields[at + 1].line - 1
  else {
    end = task.fields[at].line
    while (parts[end * 2] !== undefined && /^[ \t]+\S/.test(parts[end * 2])) end += 1
  }
  const separator = parts[(end - 1) * 2 + 1]
  if (separator === undefined) parts.push(text.includes('\r\n') ? '\r\n' : '\n', line)
  else parts.splice(end * 2, 0, line, separator)
  return parts.join('')
}

/** The task file's text claimed for a lane: Status doing, Lane, and Taken over from with --take. */
function claimText(text, lane, takenOver) {
  let claimed = claimSetField(text, 'Status', 'doing', null)
  claimed = claimSetField(claimed, 'Lane', lane, 'Status')
  if (takenOver) claimed = claimSetField(claimed, 'Taken over from', takenOver, 'Lane')
  return claimed
}

/** Commits the claimed task file on its own, through the hooks; refuses with git's output when that fails. */
function claimCommit(cwd, file, id) {
  const added = claimGit(cwd, ['add', '--', file])
  if (added.status !== 0) claimRefuse(`could not stage ${file}: ${claimGitReason(added)}`)
  const result = spawnSync('git', ['commit', '-q', '-m', `chore: claim ${id}`, '-m', `Task: ${id}`, '--', file], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.split('\n').filter((line) => line.trim() !== '')
    claimRefuse(`the claim commit was refused, so ${id} is claimed in ${file} but not committed:`, output)
  }
}

/**
 * claim <id> [--take] [--branch <name>] [--worktree <path>] [--push]: takes a task for a lane.
 * Prints one line saying what happened, then the next step.
 */
export function claimCommand(args) {
  const options = claimParseArgs(args)
  const { id } = options
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
  const { config } = loaded
  const guard = `node ${config.dir}/scripts/records.mjs`
  const here = currentLane()

  // Where the claim goes: in place, on a new branch here, or on a new branch in a new worktree.
  const protectedBase = here !== null && config.protected.includes(here)
  const mode = options.worktree !== null ? 'worktree' : options.branch !== null || protectedBase ? 'branch' : 'here'
  if (mode === 'here' && here === null)
    claimRefuse(`HEAD is detached, and a detached HEAD is not a lane. Switch to a branch first, or create one with "${guard} claim ${id} --branch <name>"`)

  const tasks = laneTasks(reader, config.dir)
  const task = tasks.find((each) => each.id === id)
  if (!task) claimRefuse(`there is no task ${id} in ${config.dir}/tasks; run "${guard} work" to see the tasks, or "${guard} new" to create one`)
  if (task.problems.length > 0) claimRefuse(`${task.file} cannot be read as a task:`, task.problems.map((problem) => problem.message))
  if (task.status === 'done' || task.status === 'dropped')
    claimRefuse(`${id} is ${task.status}, so there is nothing to claim. For more work on it, add a task with ${guard} new --under ${id} "<title>"`)

  // A new lane is named <branchPrefix><id>-<slug>, with the id in lowercase as branch names usually are.
  const slug = slugify(task.title ?? '')
  const lane = mode === 'here' ? here : (options.branch ?? `${config.branchPrefix}${id.toLowerCase()}${slug ? `-${slug}` : ''}`)
  if (mode !== 'here') {
    if (claimGit(root, ['check-ref-format', '--branch', lane]).status !== 0) claimRefuse(`"${lane}" is not a valid branch name; give another with --branch <name>`)
    if (claimGit(root, ['rev-parse', '--verify', '-q', `refs/heads/${lane}`]).status === 0)
      claimRefuse(`the branch "${lane}" already exists. Switch to it with "git switch ${lane}" and claim there, or name a new branch with --branch <name>`)
    if (config.branchRegex && lane !== config.base && !config.branchRegex.test(lane))
      claimRefuse(`the branch name "${lane}" does not match branchPattern ${JSON.stringify(config.branchPattern)} in .resaledger.json; name one that does with --branch <name>`)
  }
  let worktreePath = null
  if (mode === 'worktree') {
    worktreePath = resolve(options.worktree)
    if (existsSync(worktreePath)) claimRefuse(`${options.worktree} already exists; give --worktree a new folder`)
    const committed = treeReader({ kind: 'commit', rev: 'HEAD', root }).read(task.file)
    if (committed !== reader.read(task.file))
      claimRefuse(`${task.file} has changes that are not committed, and the new worktree starts from the last commit. Commit the task file first, then claim it`)
  }

  const remote = defaultRemote(root, config.base)
  const push = options.push || config.claimPush
  if (options.push && remote === null) claimRefuse('--push needs a remote to push to, and this repository has none. Add one with "git remote add origin <url>", or claim without --push')

  // Who else holds the task: the team preset fetches first, and goes on as last fetched when that fails.
  const notes = []
  if (config.preset === 'team') {
    const fetched = claimFetch(root, config.base)
    if (!fetched.ok) notes.push(`could not fetch${fetched.remote ? ` from ${fetched.remote}` : ''}: ${fetched.message}; checking the branches as last fetched`)
  }
  const head = claimGit(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])
  const others = localLanes(config)
  const sources = [{ where: 'this worktree', tasks, commit: head.status === 0 ? head.stdout : null }]
  for (const other of others) sources.push({ where: `the worktree at ${other.path}`, tasks: other.tasks, commit: null })
  try {
    const local = new Set([here, ...others.map((other) => other.branch)].filter((name) => name !== null))
    const pushed = remoteLanes({ root, config, local })
    for (const each of pushed.lanes) sources.push({ where: `the pushed branch ${each.remote}/${each.branch}`, tasks: each.tasks, commit: each.commit })
    if (pushed.base !== null) sources.push({ where: pushed.base, tasks: pushed.baseTasks, commit: null })
  } catch (error) {
    notes.push(`could not read the pushed branches: ${error.message}`)
  }
  for (const note of notes) console.error(`! ${note}`)

  // A new branch holds nothing yet: a lane of the same name elsewhere is another lane.
  const holders = claimOtherHolders(id, mode === 'here' ? lane : null, sources)
  if (holders.length > 0 && !options.take) {
    claimRefuse(
      `${id} is held by ${holders.length === 1 ? 'another lane' : `${holders.length} other lanes`}:`,
      [
        ...holders.map((holder) => `lane "${holder.lane}", in ${holder.where}`),
        `If that lane has stopped, take the task over with "${guard} claim ${id} --take"; it records where the task came from.`
      ]
    )
  }
  if (mode === 'here' && holders.length === 0 && task.status === 'doing' && task.lane === lane) {
    console.log(`✔ ${id} is already claimed in lane ${lane}; nothing changed`)
    console.log(`Next: ${guard} task ${id} for the plan, then work; run ${guard} handoff before you stop.`)
    return
  }
  const takenOver = holders.map((holder) => {
    const commit = claimHolderCommit(root, holder)
    return commit ? `${holder.lane} at ${commit}` : holder.lane
  })

  // The claim, checked before anything changes: the WIP limit, then the plan and the file's shape.
  const doing = tasks.filter((each) => each.id !== id && each.status === 'doing' && each.lane === lane).map((each) => each.id)
  if (doing.length + 1 > config.wip)
    claimRefuse(
      `the lane ${lane} already has ${doing.length} task${doing.length === 1 ? '' : 's'} doing (${doing.join(', ')}), and the limit is ${config.wip}. Finish one, or set it back to todo or blocked, then claim ${id}`
    )
  const text = reader.read(task.file) ?? ''
  const claimed = claimText(text, lane, takenOver.length > 0 ? takenOver.join(', ') : null)
  const context = {
    exists: (path) => reader.exists(path),
    read: (path) => reader.read(path),
    planStatus: (path) => {
      const plan = reader.read(path)
      return plan === null ? null : planStatus(plan)
    },
    taskIds: new Set(tasks.map((each) => each.id).filter(Boolean)),
    config
  }
  const problems = validateTask(parseTask(task.file, claimed), context)
  if (problems.length > 0) {
    const planMissing = problems.some((problem) => /needs a plan|is a proposal|^Plan /.test(problem.message))
    claimRefuse(
      `${id} cannot be claimed yet${planMissing ? ': it has no plan' : ''}. Nothing was changed.`,
      [
        ...problems.map((problem) => `${problem.file}${problem.line ? `:${problem.line}` : ''}: ${problem.message}`),
        planMissing ? `Write the plan, then run "${guard} claim ${id}" again.` : `Fix the task file, then run "${guard} claim ${id}" again.`
      ]
    )
  }

  // The lane, then the claim. A new lane's name must be free on the remote too.
  if (mode !== 'here' && remote !== null && claimGit(root, ['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${lane}`]).status === 0)
    claimRefuse(`a branch named "${lane}" is already pushed to ${remote}. Name a new branch with --branch <name>`)
  let target = root
  if (mode === 'branch') {
    const created = claimGit(root, ['checkout', '-q', '-b', lane])
    if (created.status !== 0) claimRefuse(`could not create the branch ${lane}: ${claimGitReason(created)}`)
  } else if (mode === 'worktree') {
    const created = claimGit(root, ['worktree', 'add', '-q', '-b', lane, worktreePath])
    if (created.status !== 0) claimRefuse(`could not create the worktree ${options.worktree}: ${claimGitReason(created)}`)
    target = worktreePath
  }
  writeFileSync(join(target, task.file), claimed)

  let pushedTo = null
  let unpushed = null
  if (push) {
    claimCommit(target, task.file, id)
    if (remote === null) unpushed = 'there is no remote, so the claim commit is not pushed. Add a remote and push the branch'
    else {
      const result = spawnSync('git', ['push', '-q', '-u', remote, lane], { cwd: target, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] })
      if (result.error) throw result.error
      if (result.status !== 0)
        claimRefuse(`${id} is claimed and committed, but the push failed: ${claimGitReason({ status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' })}`, [
          `Push it with "git push -u ${remote} ${lane}" so that others see the claim.`
        ])
      pushedTo = remote
    }
  }

  const how = []
  if (mode === 'branch') how.push(`on the new branch ${lane}${here === null ? '' : ` from ${here}`}`)
  else if (mode === 'worktree') how.push(`on the new branch ${lane} in the worktree ${options.worktree}`)
  else how.push(`in lane ${lane}`)
  if (takenOver.length > 0) how.push(`taken over from ${takenOver.join(', ')}`)
  if (pushedTo !== null) how.push(`committed and pushed to ${pushedTo}/${lane}`)
  else if (push) how.push('committed')
  console.log(`✔ ${id} claimed ${how.join(', ')}`)
  if (unpushed !== null) console.log(`! ${unpushed}`)
  else if (!push) console.log(`The claim is visible to the local worktrees now${remote === null ? '' : ', and to others once the branch is pushed'}.`)
  const cd = mode === 'worktree' ? `cd ${options.worktree}, then ` : ''
  console.log(`Next: ${cd}${guard} task ${id} for the plan, then start work; run ${guard} handoff before you stop.`)
}
