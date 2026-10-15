// Task ownership (spec 6.2): one lane changes a held task, and tasks are never deleted.
// pre-commit compares HEAD with the index; ci compares the merge base with the head and the
// base branch's tip. Both pass the task maps in, so the rules are the same for every source.
import { laneTasks } from './lanes.mjs'

/** The tasks of a reader by id, each as { task, text }; the first file wins for a duplicate id. */
export function taskRecordsById(reader, dir) {
  const byId = new Map()
  for (const task of laneTasks(reader, dir)) {
    if (task.id && !byId.has(task.id)) byId.set(task.id, { task, text: reader.read(task.file) })
  }
  return byId
}

/** The lane that holds a task: its Lane while doing, or blocked with a Lane; otherwise null. */
function ownershipHolder(task) {
  if (task.status === 'doing' || task.status === 'blocked') return task.lane
  return null
}

/** Whether a task is a takeover by a lane: doing, that Lane, and Taken over from naming the holder. */
function ownershipIsTakeover(task, lane, holder) {
  if (task.status !== 'doing' || task.lane !== lane || !task.takenOverFrom) return false
  return task.takenOverFrom.split(/[\s,;`]+/).includes(holder)
}

/**
 * The ownership problems of a change from `before` to `after`, two Maps from taskRecordsById.
 *
 * context:
 * - before, after: the tasks the change starts from and ends with.
 * - lane: the branch that makes the change.
 * - config: the effective configuration.
 * - kept: the ids that must not disappear (they exist on the base branch), or null for every
 *   id in `before`.
 * - holders: more task Maps whose holders count, besides `before`, such as the base's tip.
 * - accepted: task Maps whose exact text for a task is not this lane's change, such as the
 *   commit being merged, or the base's tip.
 * - baseName: how messages name the base branch.
 *
 * A task that `after` changes (or adds) and another lane holds in `before` or in a `holders`
 * Map is a problem, unless `after` records a takeover from that lane. A task that `after` no
 * longer has (deleted, or its id renamed) is a problem when it is in `kept`, or when another
 * lane holds it in `before`, as after merging that lane in, whatever `kept` says.
 */
export function ownershipProblems(context) {
  const { before, after, lane, config } = context
  const kept = context.kept ?? new Set(before.keys())
  const holders = context.holders ?? []
  const accepted = context.accepted ?? []
  const baseName = context.baseName ?? config.base
  const guard = `node ${config.dir}/scripts/records.mjs`
  const problems = []

  for (const [id, { task }] of before) {
    if (after.has(id)) continue
    const holder = ownershipHolder(task)
    if (kept.has(id)) {
      problems.push({
        file: task.file,
        line: 0,
        message: `task ${id} is deleted or its id renamed, but it exists on ${baseName}. Tasks are never deleted: keep the file and set "Status: dropped" with a "Reason"`
      })
    } else if (holder && holder !== lane) {
      problems.push({
        file: task.file,
        line: 0,
        message: `task ${id} is deleted or its id renamed, but lane "${holder}" holds it (Status: ${task.status}), so only that lane changes it`
      })
    }
  }

  for (const [id, { task, text }] of after) {
    if (before.get(id)?.text === text) continue
    if (accepted.some((tasks) => tasks.get(id)?.text === text)) continue
    const reported = new Set()
    for (const source of [before, ...holders]) {
      const held = source.get(id)?.task
      if (!held) continue
      const holder = ownershipHolder(held)
      if (!holder || holder === lane || reported.has(holder)) continue
      if (ownershipIsTakeover(task, lane, holder)) continue
      reported.add(holder)
      problems.push({
        file: task.file,
        line: 0,
        message: `task ${id} is held by lane "${holder}" (Status: ${held.status}), so only that lane changes it. To take it over, run "${guard} claim ${id} --take"`
      })
    }
  }
  return problems
}

/**
 * The tasks of `after` that name another lane and change here: a Lane other than `lane`, and
 * text that is neither in `before` nor in any `accepted` Map. A branch carries such a task only
 * as a copy of the lane it names, as when it is stacked on that lane. Returns [{ id, task, text,
 * holder }], holder being the Lane the task names.
 */
export function foreignLaneTasks(context) {
  const { before, after, lane } = context
  const accepted = context.accepted ?? []
  const foreign = []
  for (const [id, { task, text }] of after) {
    if (!task.lane || task.lane === lane) continue
    if (before.get(id)?.text === text) continue
    if (accepted.some((tasks) => tasks.get(id)?.text === text)) continue
    foreign.push({ id, task, text, holder: task.lane })
  }
  return foreign
}

/**
 * The problems of the tasks from foreignLaneTasks against the copies on their lanes' branches.
 * copies is a Map from id to { branch, task, text } (task and text null when that branch has no
 * such file); an id is missing when the lane has no branch to read.
 *
 * A copy equal to the lane's is fine. Otherwise it is a problem when this copy holds the task,
 * or the lane's copy does: only that lane changes a task it holds (spec 6.2), and a branch that
 * claims a task names its own lane. A done, dropped or todo task the lane no longer holds can be
 * edited by anyone.
 */
export function laneCopyProblems(tasks, copies, config) {
  const guard = `node ${config.dir}/scripts/records.mjs`
  const problems = []
  for (const { id, task, text, holder } of tasks) {
    const copy = copies.get(id)
    if (copy?.text === text) continue
    const held = ownershipHolder(task) !== null
    const copyHeld = copy?.task ? ownershipHolder(copy.task) !== null : false
    if (!held && !copyHeld) continue
    const where = copy ? `branch "${copy.branch}"` : `lane "${holder}", whose branch is not in this clone`
    problems.push({
      file: task.file,
      line: 0,
      message: `task ${id} is held by lane "${holder}", and this branch's copy differs from that of ${where}. Only that lane changes it: rebase on "${holder}" for its latest copy, or claim the task for this lane with "${guard} claim ${id}" (with --take while "${holder}" holds it)`
    })
  }
  return problems
}
