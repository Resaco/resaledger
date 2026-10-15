// work (spec 6.4 and 8): the state on one screen, for this lane and the other local
// worktrees. It is the first context of every session, so it says what this lane holds,
// what waits, what is ready and what to type next. It never fetches.
import { loadConfig } from './config.mjs'
import { activateHooks, hooksActive } from './githooks.mjs'
import { currentLane, localBranches, localLanes } from './lanes.mjs'
import { fail, repositoryRoot } from './util.mjs'
import { checkWorkspace, loadWorkspace, treeReader } from './workspace.mjs'

const WORK_READY_MAX = 5
const WORK_HANDOFF_LINES = 3
const WORK_PROBLEMS_MAX = 5
const WORK_SETTLED = ['done', 'dropped']

/** The parts of a task id: its letters and its numbers, as { prefix, numbers }. */
function workIdParts(id) {
  const match = /^([A-Z]+)(\d+(?:\.\d+)*)$/.exec(id ?? '')
  if (!match) return { prefix: id ?? '', numbers: [] }
  return { prefix: match[1], numbers: match[2].split('.').map(Number) }
}

/** Natural id order: by prefix, then number by number, so S2 < S10 and S4 < S4.1 < S5. */
export function compareTaskIds(a, b) {
  const left = workIdParts(a)
  const right = workIdParts(b)
  if (left.prefix !== right.prefix) return left.prefix < right.prefix ? -1 : 1
  for (let index = 0; index < Math.min(left.numbers.length, right.numbers.length); index += 1) {
    if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] - right.numbers[index]
  }
  return left.numbers.length - right.numbers.length
}

/** Ids ordered by the phases setting first (prefixes it does not name go last), then naturally. */
function workPhaseOrder(phases) {
  const rank = (id) => {
    const position = phases.indexOf(workIdParts(id).prefix)
    return position === -1 ? phases.length : position
  }
  return (a, b) => rank(a) - rank(b) || compareTaskIds(a, b)
}

/** The first sentence of the README's Goal section, or null. */
function workGoal(readme) {
  if (!readme) return null
  const name = [...readme.sections.keys()].find((heading) => heading.trim().toLowerCase() === 'goal')
  if (name === undefined) return null
  const paragraph = readme.sections.get(name).body.split(/\n[ \t]*\n/)[0].replace(/\s+/g, ' ').trim()
  if (paragraph === '') return null
  const sentence = /^.*?[.!?](?=\s|$)/.exec(paragraph)
  return sentence ? sentence[0] : paragraph
}

/** The first lines of a task's Handoff that hold text. */
function workHandoff(task) {
  const body = task.sections.handoff?.body ?? ''
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, WORK_HANDOFF_LINES)
}

/** The ids a lane holds: tasks doing, or blocked with a Lane, whose Lane is that lane's branch. */
function workHeldBy(lane) {
  return lane.tasks
    .filter((task) => task.id && (task.status === 'doing' || (task.status === 'blocked' && task.lane !== null)) && task.lane === lane.branch)
    .map((task) => task.id)
    .sort(compareTaskIds)
}

/** The lane named first in a "Taken over from" value, such as "s4-old at 1a2b3c4". */
function workTakenFrom(task) {
  return task.takenOverFrom ? task.takenOverFrom.split(/\s+/)[0] : null
}

/** Ids that are doing in more than one lane, as [{ id, lanes }], across every visible tree. */
function workDoubleClaims(lanes) {
  const claims = new Map() // id → Map of lane → the tasks that name it
  for (const lane of lanes) {
    for (const task of lane.tasks) {
      if (!task.id || task.status !== 'doing' || task.lane === null) continue
      if (!claims.has(task.id)) claims.set(task.id, new Map())
      const byLane = claims.get(task.id)
      if (!byLane.has(task.lane)) byLane.set(task.lane, [])
      byLane.get(task.lane).push(task)
    }
  }
  const doubles = []
  for (const [id, byLane] of claims) {
    // A lane that took the task over with claim --take replaces the lane it names.
    const replaced = new Set([...byLane.values()].flat().map(workTakenFrom).filter(Boolean))
    const holders = [...byLane.keys()].filter((lane) => !replaced.has(lane))
    if (holders.length > 1) doubles.push({ id, lanes: holders.sort() })
  }
  return doubles.sort((a, b) => compareTaskIds(a.id, b.id))
}

/** Doing tasks whose Lane is no branch here: not this one, not a worktree's, not a local branch. */
function workStaleClaims(lanes, known) {
  const stale = []
  const seen = new Set()
  for (const lane of lanes) {
    for (const task of lane.tasks) {
      if (!task.id || task.status !== 'doing' || task.lane === null || known.has(task.lane)) continue
      const key = `${task.id}\0${task.lane}`
      if (seen.has(key)) continue
      seen.add(key)
      stale.push({ id: task.id, lane: task.lane, file: task.file })
    }
  }
  return stale.sort((a, b) => compareTaskIds(a.id, b.id))
}

/** Done or dropped out of all tasks, per id prefix, ordered by phases and then by prefix. */
function workProgress(tasks, phases) {
  const byPrefix = new Map()
  for (const task of tasks) {
    if (!task.id) continue
    const { prefix } = workIdParts(task.id)
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, { prefix, done: 0, total: 0 })
    const entry = byPrefix.get(prefix)
    entry.total += 1
    if (WORK_SETTLED.includes(task.status)) entry.done += 1
  }
  const order = workPhaseOrder(phases)
  return [...byPrefix.values()].sort((a, b) => order(`${a.prefix}0`, `${b.prefix}0`))
}

/** A task as the sections show it. */
function workSummary(task) {
  return { id: task.id, title: task.title ?? '', file: task.file }
}

/** Computes everything work shows, as one plain object (the --json output). */
function workState(options) {
  const { config, workspace, problems, lane, hooks, others, branches, root } = options
  const tasks = workspace.tasks.filter((task) => task.id)
  const thisLane = { branch: lane, path: root, source: 'this', tasks: workspace.tasks }
  if (lane !== null && branches.has(lane)) thisLane.lastCommit = branches.get(lane)
  const lanes = [thisLane, ...others]

  const inProgress = lane === null ? [] : tasks.filter((task) => task.status === 'doing' && task.lane === lane)
  const blocked = tasks.filter((task) => task.status === 'blocked')
  const forOwner = (task) => /^owner\b/i.test(task.waitingFor ?? '')

  // A task is held when any visible tree has it doing, or blocked with a lane.
  const held = new Set()
  for (const each of lanes) {
    for (const task of each.tasks) {
      if (task.id && (task.status === 'doing' || (task.status === 'blocked' && task.lane !== null))) held.add(task.id)
    }
  }
  const statuses = new Map(tasks.map((task) => [task.id, task.status]))
  const order = workPhaseOrder(config.phases)
  const ready = tasks
    .filter((task) => task.status === 'todo' && !held.has(task.id))
    .filter((task) => task.dependsOn.every((id) => WORK_SETTLED.includes(statuses.get(id))))
    .sort((a, b) => order(a.id, b.id))
    .slice(0, WORK_READY_MAX)

  const known = new Set([...branches.keys(), ...others.map((other) => other.branch)])
  if (lane !== null) known.add(lane)
  const progress = workProgress(tasks, config.phases)
  const byInProgress = [...inProgress].sort((a, b) => compareTaskIds(a.id, b.id))
  const focus = byInProgress[0]?.id ?? ready[0]?.id ?? '<id>'
  const guard = `node ${config.dir}/scripts/records.mjs`

  return {
    lane,
    preset: config.preset,
    hooks,
    goal: workGoal(workspace.readme),
    inProgress: byInProgress.map((task) => ({ ...workSummary(task), handoff: workHandoff(task) })),
    waitingForOwner: blocked.filter(forOwner).sort((a, b) => compareTaskIds(a.id, b.id)).map((task) => ({ ...workSummary(task), waitingFor: task.waitingFor })),
    blocked: blocked.filter((task) => !forOwner(task)).sort((a, b) => compareTaskIds(a.id, b.id)).map((task) => ({ ...workSummary(task), waitingFor: task.waitingFor })),
    ready: ready.map(workSummary),
    lanes: lanes.map((each) => {
      const shown = { branch: each.branch, path: each.path, source: each.source, holds: each.branch === null ? [] : workHeldBy(each) }
      if (each.lastCommit) shown.lastCommit = each.lastCommit
      return shown
    }),
    progress: {
      done: progress.reduce((sum, entry) => sum + entry.done, 0),
      total: progress.reduce((sum, entry) => sum + entry.total, 0),
      byPrefix: progress
    },
    // The verification state (whether a stamp exists for the code at HEAD) goes here, after V1.
    warnings: {
      doubleClaims: workDoubleClaims(lanes),
      staleClaims: workStaleClaims(lanes, known),
      problems
    },
    next: [`${guard} task ${focus}`, `${guard} handoff`]
  }
}

/** The state as text, one section after another; empty sections are left out. */
function workText(state) {
  const out = []
  const section = (heading, lines) => {
    if (lines.length === 0) return
    out.push('', heading, ...lines)
  }
  const line = (task, extra) => `  ${task.id}  ${task.title}${extra ? ` — ${extra}` : ''}`

  out.push(`ResaLedger · lane ${state.lane ?? '(detached HEAD)'} · ${state.preset} · hooks ${state.hooks.active ? 'on' : 'off'}`)
  if (state.goal) out.push(`Goal: ${state.goal}`)

  const progressLines = state.inProgress.flatMap((task) => [line(task), ...task.handoff.map((text) => `      ${text}`)])
  section('In progress in this lane', progressLines.length > 0 ? progressLines : ['  none'])
  section('Waiting for the owner', state.waitingForOwner.map((task) => line(task, task.waitingFor)))
  section('Blocked', state.blocked.map((task) => line(task, `waiting for ${task.waitingFor}`)))
  section('Ready next', state.ready.map((task) => line(task)))
  section(
    'Other lanes',
    state.lanes.filter((lane) => lane.source !== 'this').map((lane) => `  ${lane.branch}: ${lane.holds.length > 0 ? lane.holds.join(', ') : 'holds nothing'}`)
  )
  if (state.progress.total > 0) {
    const parts = state.progress.byPrefix.map((entry) => `${entry.prefix} ${entry.done}/${entry.total}`)
    section('Progress', [`  ${state.progress.done} of ${state.progress.total} done or dropped${parts.length > 1 ? ` · ${parts.join(' · ')}` : ''}`])
  }

  const warnings = [
    ...state.warnings.doubleClaims.map((claim) => `  ${claim.id} is doing in ${claim.lanes.length} lanes: ${claim.lanes.join(', ')}. One of them sets it back or takes it over with claim --take`),
    ...state.warnings.staleClaims.map(
      (claim) => `  ${claim.id} is held by ${claim.lane}, which is no branch here: a stale claim. Take it over with claim ${claim.id} --take`
    ),
    ...state.warnings.problems.slice(0, WORK_PROBLEMS_MAX).map(({ file, line: at, message }) => `  ${file}${at ? `:${at}` : ''}: ${message}`)
  ]
  const more = state.warnings.problems.length - WORK_PROBLEMS_MAX
  if (more > 0) warnings.push(`  and ${more} more record problem${more === 1 ? '' : 's'}; run check for the list`)
  section('Warnings', warnings)

  out.push('', `Next: ${state.next[0]} for the plan, then ${state.next[1]} before you stop.`)
  return `${out.join('\n')}\n`
}

/** work [--json]: turns on the git hooks, then prints the state of this lane and the local worktrees. */
export function workCommand(args) {
  let json = false
  for (const arg of args) {
    if (arg === '--json') json = true
    else fail(`unknown option "${arg}" for work; use --json`)
  }
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }

  const notes = []
  const hooks = { active: false, activated: false, foreign: null }
  try {
    const result = activateHooks()
    if (result === 'activated') {
      hooks.activated = true
      notes.push('✔ git hooks turned on: core.hooksPath is .githooks')
    } else if (result !== 'active') {
      hooks.foreign = result.foreign
      notes.push(`✖ core.hooksPath is "${result.foreign}", not .githooks: call the guard from those hooks, or run "hooks --activate" for the details`)
    }
    hooks.active = hooksActive()
  } catch (error) {
    notes.push(`✖ could not turn on the git hooks: ${error.message}`)
  }

  const reader = treeReader({ kind: 'worktree', root })
  const loaded = loadConfig(reader)
  if (!loaded.config) {
    for (const { file, line, message } of loaded.problems) console.error(`✖ ${file}${line ? `:${line}` : ''}: ${message}`)
    process.exit(1)
  }
  const { config } = loaded
  const workspace = loadWorkspace(reader, config)
  const problems = checkWorkspace(workspace, reader, config)
  const branches = localBranches()
  const state = workState({ config, workspace, problems, lane: currentLane(), hooks, others: localLanes(config, branches), branches, root })

  if (json) {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
    return
  }
  for (const note of notes) console.log(note)
  process.stdout.write(workText(state))
}
