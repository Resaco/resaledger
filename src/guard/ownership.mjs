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
 * Map is a problem, unless `after` records a takeover from that lane. A task in `kept` that
 * `after` no longer has is a problem: deleted, or its id renamed.
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
    if (after.has(id) || !kept.has(id)) continue
    problems.push({
      file: task.file,
      line: 0,
      message: `task ${id} is deleted or its id renamed, but it exists on ${baseName}. Tasks are never deleted: keep the file and set "Status: dropped" with a "Reason"`
    })
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
