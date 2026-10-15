// work (spec 6.4 and 8): the state on one screen, for this lane and the other local
// worktrees, and with --all the pushed branches not merged into the base. It is the first
// context of every session, so it says what this lane holds, what waits, what is ready and
// what to type next. It fetches only with --fetch.
import { spawnSync } from 'node:child_process'
import { loadConfig } from './config.mjs'
import { verifiedStamp } from './gates.mjs'
import { activateHooks, hooksActive } from './githooks.mjs'
import { currentLane, defaultRemote, localBranches, localLanes, remoteLanes } from './lanes.mjs'
import { fail, repositoryRoot } from './util.mjs'
import { checkWorkspace, fingerprint, loadWorkspace, treeReader } from './workspace.mjs'

const WORK_READY_MAX = 5
const WORK_HANDOFF_LINES = 3
const WORK_PROBLEMS_MAX = 5
const WORK_SETTLED = ['done', 'dropped']
const WORK_FETCH_TIMEOUT = 60 * 1000

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

/**
 * Doing tasks whose Lane is not a known lane. Without --all, known is this lane, the worktrees'
 * and the local branches. With --all, known is this lane, the worktrees' and the branches not
 * merged into the base, and each claim says why it is stale: its branch is 'merged' or 'gone'.
 */
function workStaleClaims(taskLists, known, merged = null) {
  const stale = []
  const seen = new Set()
  for (const tasks of taskLists) {
    for (const task of tasks) {
      if (!task.id || task.status !== 'doing' || task.lane === null || known.has(task.lane)) continue
      const key = `${task.id}\0${task.lane}`
      if (seen.has(key)) continue
      seen.add(key)
      const claim = { id: task.id, lane: task.lane, file: task.file }
      if (merged !== null) claim.reason = merged.has(task.lane) ? 'merged' : 'gone'
      stale.push(claim)
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

/**
 * Whether the gates passed on the code at HEAD: 'verified' when a stamp for it is in the
 * working tree, 'unverified' when not, 'no-gates' or 'no-commits' when there is nothing to check.
 */
function workVerification(config, reader, root) {
  const gates = config.gates.commit.length + config.gates.verify.length
  if (gates === 0) return { state: 'no-gates', gates }
  let code
  try {
    code = fingerprint({ kind: 'commit', rev: 'HEAD', root }, config)
  } catch {
    return { state: 'no-commits', gates }
  }
  return { state: verifiedStamp(reader, config, code) ? 'verified' : 'unverified', gates }
}

/** Computes everything work shows, as one plain object (the --json output). */
function workState(options) {
  const { config, workspace, problems, lane, hooks, others, branches, root, verification } = options
  const remote = options.remote ?? null // remoteLanes() with --all
  const tasks = workspace.tasks.filter((task) => task.id)
  const thisLane = { branch: lane, path: root, source: 'this', tasks: workspace.tasks }
  if (lane !== null && branches.has(lane)) thisLane.lastCommit = branches.get(lane)
  const localLaneList = [thisLane, ...others]
  if (remote !== null) for (const each of localLaneList) each.pushed = remote.pushed.has(each.branch)
  const lanes = remote === null ? localLaneList : [...localLaneList, ...remote.lanes]

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

  const known = new Set([...(remote === null ? branches.keys() : remote.live), ...others.map((other) => other.branch)])
  if (lane !== null) known.add(lane)
  const merged = remote === null ? null : new Set([...branches.keys(), ...remote.branches].filter((name) => !known.has(name)))
  const progress = workProgress(tasks, config.phases)
  const byInProgress = [...inProgress].sort((a, b) => compareTaskIds(a.id, b.id))
  const focus = byInProgress[0]?.id ?? ready[0]?.id ?? '<id>'
  const guard = `node ${config.dir}/scripts/records.mjs`

  const state = {
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
      if (each.pushed !== undefined) shown.pushed = each.pushed
      if (each.source === 'remote') {
        Object.assign(shown, { pushed: true, remote: each.remote, ref: each.ref, commit: each.commit, ahead: each.ahead, verification: each.verification })
      }
      return shown
    }),
    progress: {
      done: progress.reduce((sum, entry) => sum + entry.done, 0),
      total: progress.reduce((sum, entry) => sum + entry.total, 0),
      byPrefix: progress
    },
    verification,
    warnings: {
      doubleClaims: workDoubleClaims(lanes),
      staleClaims: workStaleClaims([...lanes.map((each) => each.tasks), remote?.baseTasks ?? []], known, merged),
      problems
    },
    next: [`${guard} task ${focus}`, `${guard} handoff`]
  }
  if (remote !== null) {
    state.base = remote.base
    state.fetch = options.fetched ?? null
  }
  return state
}

/** The state as text, one section after another; empty sections are left out. */
function workText(state) {
  const out = []
  const section = (heading, lines) => {
    if (lines.length === 0) return
    out.push('', heading, ...lines)
  }
  const line = (task, extra) => `  ${task.id}  ${task.title}${extra ? ` — ${extra}` : ''}`

  const verified = { verified: ' · verified', unverified: ' · not verified', 'no-commits': '', 'no-gates': '' }[state.verification.state]
  out.push(`ResaLedger · lane ${state.lane ?? '(detached HEAD)'} · ${state.preset} · hooks ${state.hooks.active ? 'on' : 'off'}${verified}`)
  if (state.goal) out.push(`Goal: ${state.goal}`)

  const progressLines = state.inProgress.flatMap((task) => [line(task), ...task.handoff.map((text) => `      ${text}`)])
  section('In progress in this lane', progressLines.length > 0 ? progressLines : ['  none'])
  section('Waiting for the owner', state.waitingForOwner.map((task) => line(task, task.waitingFor)))
  section('Blocked', state.blocked.map((task) => line(task, `waiting for ${task.waitingFor}`)))
  section('Ready next', state.ready.map((task) => line(task)))
  const holds = (lane) => (lane.holds.length > 0 ? lane.holds.join(', ') : 'holds nothing')
  section(
    'Other lanes',
    state.lanes.filter((lane) => lane.source === 'worktree').map((lane) => `  ${lane.branch}: ${holds(lane)}${lane.pushed ? ' · pushed' : ''}`)
  )
  if ('base' in state) {
    const verified = { verified: ' · verified', unverified: ' · not verified' }
    const remoteLines = state.lanes
      .filter((lane) => lane.source === 'remote')
      .map((lane) => {
        const ahead = lane.ahead === null ? '' : ` · ${lane.ahead} ahead`
        const last = lane.lastCommit ? ` · ${lane.lastCommit.author} ${lane.lastCommit.date.slice(0, 10)}` : ''
        return `  ${lane.remote}/${lane.branch}: ${holds(lane)}${ahead}${last}${verified[lane.verification] ?? ''}`
      })
    section(state.base === null ? 'Pushed lanes' : `Pushed lanes not merged into ${state.base}`, remoteLines.length > 0 ? remoteLines : ['  none'])
  }
  if (state.progress.total > 0) {
    const parts = state.progress.byPrefix.map((entry) => `${entry.prefix} ${entry.done}/${entry.total}`)
    section('Progress', [`  ${state.progress.done} of ${state.progress.total} done or dropped${parts.length > 1 ? ` · ${parts.join(' · ')}` : ''}`])
  }

  const warnings = [
    ...state.warnings.doubleClaims.map((claim) => `  ${claim.id} is doing in ${claim.lanes.length} lanes: ${claim.lanes.join(', ')}. One of them sets it back or takes it over with claim --take`),
    ...state.warnings.staleClaims.map((claim) => {
      const why = claim.reason === 'merged' ? `is merged into ${state.base}` : claim.reason === 'gone' ? 'is gone' : 'is no branch here'
      return `  ${claim.id} is held by ${claim.lane}, which ${why}: a stale claim. Take it over with claim ${claim.id} --take`
    }),
    ...state.warnings.problems.slice(0, WORK_PROBLEMS_MAX).map(({ file, line: at, message }) => `  ${file}${at ? `:${at}` : ''}: ${message}`)
  ]
  const more = state.warnings.problems.length - WORK_PROBLEMS_MAX
  if (more > 0) warnings.push(`  and ${more} more record problem${more === 1 ? '' : 's'}; run check for the list`)
  section('Warnings', warnings)

  if (state.verification.state === 'unverified')
    out.push('', `The gates have not passed on the code at HEAD: run ${state.next[1].replace(/handoff$/, 'verify')} once your code is committed.`)
  out.push('', `Next: ${state.next[0]} for the plan, then ${state.next[1]} before you stop.`)
  return `${out.join('\n')}\n`
}

/**
 * git fetch --prune from the default remote, as { remote, ok, message }: message is git's first
 * line of error when the fetch fails, or why there is nothing to fetch from.
 */
function workFetch(root, base) {
  const remote = defaultRemote(root, base)
  if (remote === null) return { remote: null, ok: false, message: 'there is no remote' }
  const result = spawnSync('git', ['fetch', '--prune', '--quiet', remote], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: WORK_FETCH_TIMEOUT
  })
  if (result.status === 0) return { remote, ok: true, message: null }
  const reason = result.error ? result.error.message : (result.stderr ?? '').split('\n').map((text) => text.replace(/^fatal:\s*/, '').trim()).find((text) => text !== '')
  return { remote, ok: false, message: reason ?? `git fetch exited with ${result.status}` }
}

/**
 * work [--all] [--fetch] [--json]: turns on the git hooks, then prints the state of this lane
 * and the local worktrees; --all adds the pushed branches not merged into the base, and
 * --fetch (which implies --all) fetches them first.
 */
export function workCommand(args) {
  let json = false
  let all = false
  let fetch = false
  for (const arg of args) {
    if (arg === '--json') json = true
    else if (arg === '--all') all = true
    else if (arg === '--fetch') {
      all = true
      fetch = true
    } else fail(`unknown option "${arg}" for work; use --all, --fetch or --json`)
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
  let fetched = null
  if (fetch) {
    fetched = workFetch(root, config.base)
    if (!fetched.ok) notes.push(`✖ could not fetch${fetched.remote ? ` from ${fetched.remote}` : ''}: ${fetched.message}; showing the branches as last fetched`)
  }
  const workspace = loadWorkspace(reader, config)
  const problems = checkWorkspace(workspace, reader, config)
  const branches = localBranches()
  const verification = workVerification(config, reader, root)
  const lane = currentLane()
  const others = localLanes(config, branches)
  const remote = all ? remoteLanes({ root, config, local: new Set([lane, ...others.map((other) => other.branch)].filter((name) => name !== null)) }) : null
  const state = workState({ config, workspace, problems, lane, hooks, others, branches, root, verification, remote, fetched })

  if (json) {
    // The fetch note goes to stderr, so that stdout stays one JSON object.
    if (fetched !== null && !fetched.ok) console.error(notes[notes.length - 1])
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
    return
  }
  for (const note of notes) console.log(note)
  process.stdout.write(workText(state))
}
