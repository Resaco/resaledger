// The CI check (spec 10): the hooks' rules where nobody can skip them, judged by the rules of the
// branch a pull request merges into. ciResult returns the result as data; ciCommand prints it,
// writes the job summary, comments on the pull request (report.mjs) and sets the exit code.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { adoptionStart } from './adoption.mjs'
import { CONFIG_FILE, loadConfig } from './config.mjs'
import { enforcementCheck } from './enforcement.mjs'
import { runGates, stampPath, verifiedStamp } from './gates.mjs'
import { branchTaskFiles, idCollisions } from './ids.mjs'
import { mergeReleased, packageReleased, releasedTable } from './managed.mjs'
import { foreignLaneTasks, laneCopyProblems, ownershipProblems, taskRecordsById } from './ownership.mjs'
import { checkRange, rangeObjects } from './range.mjs'
import { ciComment, ciErrorMarkdown, ciMarkdown, ciShort, ciText, writeSummary } from './report.mjs'
import { parseTask } from './tasks.mjs'
import { fail, repositoryRoot } from './util.mjs'
import { compareTaskIds } from './work.mjs'
import { checkWorkspace, fingerprint, loadWorkspace, treeReader } from './workspace.mjs'

const CI_ZERO = /^0+$/
const CI_PULL_REQUEST_EVENTS = ['pull_request', 'pull_request_target']
const CI_FETCH_HINT =
  'Fetch the full history: in GitHub Actions, give actions/checkout "fetch-depth: 0"; elsewhere, run "git fetch --unshallow" or fetch the missing commits'

/** A failure that stops the check before it can judge anything, such as a missing commit. */
class CiError extends Error {}

/** Runs git in a folder and returns its trimmed output; throws with git's message when it fails. */
function ciGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

/** The full id of a revision's commit, or null when the clone does not have it. */
function ciCommit(root, rev) {
  try {
    return ciGit(root, ['rev-parse', '--verify', '-q', `${rev}^{commit}`]) || null
  } catch {
    return null
  }
}

/**
 * Resolves the revisions the check needs, or stops: a shallow clone or a missing commit cannot
 * be judged, because the merge base and the commit range would be wrong.
 */
function ciRequireHistory(root, revs) {
  let shallow = false
  try {
    shallow = ciGit(root, ['rev-parse', '--is-shallow-repository']) === 'true'
  } catch {
    throw new CiError('not inside a git repository')
  }
  const commits = revs.map((rev) => ({ rev, commit: ciCommit(root, rev) }))
  const missing = commits.filter(({ commit }) => commit === null).map(({ rev }) => rev)
  if (missing.length > 0) {
    throw new CiError(`${missing.length === 1 ? 'commit' : 'commits'} ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in this clone${shallow ? ', which is shallow' : ''}. ${CI_FETCH_HINT}`)
  }
  if (shallow) throw new CiError(`this clone is shallow, so the merge base and the commit range cannot be trusted. ${CI_FETCH_HINT}`)
  return commits.map(({ commit }) => commit)
}

/** The merge base of two commits, or a stop when they share no history. */
function ciMergeBase(root, a, b) {
  try {
    const base = ciGit(root, ['merge-base', a, b])
    if (base !== '') return base
  } catch {
    // Unrelated histories, reported below.
  }
  throw new CiError(`${ciShort(a)} and ${ciShort(b)} share no history, so there is no merge base to judge the change from. ${CI_FETCH_HINT}`)
}

/** Whether `ancestor` is an ancestor of `commit`. */
function ciIsAncestor(root, ancestor, commit) {
  return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, commit], { cwd: root, stdio: 'ignore' }).status === 0
}

/**
 * The rules: the configuration of `primary` (the base, or the commit before a push). When that
 * commit has no configuration, the change adds ResaLedger and is judged by the configuration of
 * `fallback`. Returns { config, from, commit, adds }; an invalid configuration stops the check.
 */
function ciRules(root, primary, fallback) {
  const candidates = [primary, fallback].filter((item) => item.commit !== null)
  for (const { commit, from } of candidates) {
    const reader = treeReader({ kind: 'commit', rev: commit, root })
    if (reader.read(CONFIG_FILE) === null) continue
    const { config, problems } = loadConfig(reader)
    if (!config) {
      const lines = problems.map(({ file, line, message }) => `  ${file}${line ? `:${line}` : ''}: ${message}`).join('\n')
      throw new CiError(`the configuration in ${ciShort(commit)} (the ${from}), which sets the rules, is invalid:\n${lines}`)
    }
    return { config, from, commit, adds: primary.commit !== null && from !== primary.from }
  }
  throw new CiError(`neither ${candidates.map(({ commit, from }) => `the ${from} ${ciShort(commit)}`).join(' nor ')} has ${CONFIG_FILE}, so there are no rules to check against`)
}

/** The records check of a commit: its own configuration must be valid, and every record. */
function ciRecordsCheck(root, commit, config) {
  const reader = treeReader({ kind: 'commit', rev: commit, root })
  const problems = []
  const own = loadConfig(reader)
  if (!own.config) problems.push(...own.problems)
  const workspace = loadWorkspace(reader, config)
  problems.push(...checkWorkspace(workspace, reader, config))
  return {
    name: 'records',
    ok: problems.length === 0,
    problems,
    counts: { tasks: workspace.tasks.length, decisions: workspace.decisions.length, logs: workspace.logs.length },
    note: null
  }
}

/**
 * The commits check of a range, with checkRange; `from` null checks nothing (a new branch). A
 * start older than the commit that added .resaledger.json moves up to it, as in handoff and
 * pre-push, so commits made before the project adopted ResaLedger are not judged.
 */
function ciCommitsCheck(root, from, to, config, lane, skipGitHubMerges, note) {
  if (from === null) return { name: 'commits', ok: true, skipped: true, problems: [], counts: { commits: 0 }, note }
  const start = adoptionStart(root, from, to)
  const commits = Number(ciGit(root, ['rev-list', '--count', `${start}..${to}`]))
  const problems = checkRange(start, to, { config, lane, skipGitHubMerges, root })
  return { name: 'commits', ok: problems.length === 0, problems, counts: { commits }, note }
}

/** The text of a task's Evidence field, or null. */
function ciEvidence(task) {
  if (!task.evidence) return null
  const parts = [task.evidence.value, ...task.evidence.items].map((part) => (part ?? '').trim()).filter((part) => part !== '')
  return parts.length > 0 ? parts.join('; ') : null
}

/** The tasks whose status differs between two task Maps, in id order: { id, title, file, from, to, evidence }. */
function ciMovedTasks(before, after) {
  const moved = []
  for (const [id, { task }] of after) {
    const from = before.get(id)?.task.status ?? null
    if (from === task.status) continue
    moved.push({ id, title: task.title, file: task.file, from, to: task.status, evidence: ciEvidence(task) })
  }
  return moved.sort((a, b) => compareTaskIds(a.id, b.id))
}

/** The names of the remotes of a clone. */
function ciRemotes(root) {
  return ciGit(root, ['remote'])
    .split('\n')
    .filter((name) => name !== '')
}

/**
 * The branch of each lane in the clone, from one `git for-each-ref`: a Map from lane to
 * { ref, branch, commit }. A remote-tracking branch (refs/remotes/<remote>/<lane>) comes before
 * a local one (refs/heads/<lane>); a lane with neither is left out.
 */
function ciLaneBranches(root, lanes) {
  const remotes = ciRemotes(root)
  const refsOf = new Map(lanes.map((lane) => [lane, [...remotes.map((remote) => `refs/remotes/${remote}/${lane}`), `refs/heads/${lane}`]]))
  const patterns = [...refsOf.values()].flat()
  const commits = new Map()
  const output = ciGit(root, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(refname:short)', ...patterns])
  for (const line of output.split('\n')) {
    const [ref, commit, type, branch] = line.split('\0')
    if (type === 'commit') commits.set(ref, { ref, branch, commit })
  }
  const branches = new Map()
  for (const [lane, refs] of refsOf) {
    const found = refs.find((ref) => commits.has(ref))
    if (found) branches.set(lane, commits.get(found))
  }
  return branches
}

/**
 * The copies of tasks on the branches of the lanes they name (spec 6.2), read in one
 * `git cat-file --batch`. tasks is [{ id, task, holder }] from foreignLaneTasks. Returns a Map
 * from id to { branch, task, text }, task and text null when that branch has no such file; an
 * id whose lane has no branch in the clone is left out. No fetch: the workflow fetches every branch.
 */
function ciLaneCopies(root, tasks) {
  const copies = new Map()
  if (tasks.length === 0) return copies
  const branches = ciLaneBranches(root, [...new Set(tasks.map(({ holder }) => holder))])
  const wanted = tasks.filter(({ holder }) => branches.has(holder)).map(({ id, task, holder }) => ({ id, branch: branches.get(holder), spec: `${branches.get(holder).commit}:${task.file}` }))
  const objects = rangeObjects(root, wanted.map(({ spec }) => spec))
  for (const { id, branch, spec } of wanted) {
    const object = objects.get(spec)
    const text = object?.type === 'blob' ? object.data.toString('utf8') : null
    const file = spec.slice(spec.indexOf(':') + 1)
    copies.set(id, { branch: branch.branch, task: text === null ? null : parseTask(file, text), text })
  }
  return copies
}

/**
 * The ids check of a pull request: ids the head adds (not at the merge base) against the base's
 * tip and every other branch in the clone, except the pull request's own branch.
 */
function ciIdsCheck(root, config, context) {
  const { mergeBaseTasks, headTasks, baseTasks, base, head, lane, fork } = context
  const added = [...headTasks.values()].filter(({ task }) => !mergeBaseTasks.has(task.id)).map(({ task }) => ({ id: task.id, file: task.file }))
  const own = new Set()
  // A fork's branch name says nothing about the branches of this repository.
  if (!fork && lane) {
    own.add(`refs/heads/${lane}`)
    for (const remote of ciRemotes(root)) own.add(`refs/remotes/${remote}/${lane}`)
  }
  const others = [{ branch: config.base, files: new Map([...baseTasks.values()].map(({ task }) => [task.id, task.file])) }]
  let branches = 0
  if (added.length > 0) {
    const scanned = branchTaskFiles({ root, dir: config.dir, exclude: ({ ref, commit }) => commit === head || commit === base || own.has(ref) })
    branches = scanned.length
    others.push(...scanned)
  }
  const problems = idCollisions(added, others, config)
  return { name: 'ids', ok: problems.length === 0, problems, counts: { added: added.length, branches: branches + 1 }, note: null }
}

/**
 * The gates of a pull request. With ci.runGates, the base's commit gates and then its verify
 * gates run in the working tree, which the workflow checks out at the head. Without it, the
 * head must carry a stamp for its own code and these gates.
 */
function ciGatesCheck(root, config, head) {
  const guard = `node ${config.dir}/scripts/records.mjs`
  const commands = [...config.gates.commit, ...config.gates.verify]
  const result = { name: 'gates', ok: true, problems: [], counts: { gates: commands.length }, note: null }
  const gates = { mode: 'none', ranOn: null, passed: [], failure: null, stamp: null }
  if (commands.length === 0) return { check: { ...result, skipped: true, note: 'no gates are configured' }, gates }

  if (!config.ci.runGates) {
    const code = fingerprint({ kind: 'commit', rev: head, root }, config)
    const path = stampPath(config, code)
    const stamp = verifiedStamp(treeReader({ kind: 'commit', rev: head, root }), config, code)
    gates.mode = 'stamp'
    gates.ranOn = head
    gates.stamp = stamp === null ? null : path
    if (stamp === null) {
      result.ok = false
      result.problems.push({
        file: path,
        line: 0,
        message: `the head ${ciShort(head)} carries no stamp for its own code and these gates (ci.runGates is false, so CI checks the stamp instead of running the gates). Run "${guard} verify" on the head and commit the stamp`
      })
    }
    return { check: result, gates }
  }

  gates.mode = 'run'
  gates.ranOn = ciCommit(root, 'HEAD')
  if (gates.ranOn !== head) result.note = `the working tree is at ${ciShort(gates.ranOn)}, not at the head ${ciShort(head)}`
  const { passed, failure } = runGates(commands, { root })
  gates.passed = passed
  if (failure) {
    gates.failure = { command: failure.command, status: failure.status }
    result.ok = false
    result.problems.push({
      file: '',
      line: 0,
      message: `the gate "${failure.command}" failed with ${failure.status} on ${ciShort(gates.ranOn)}. Fix the code; a gate is never weakened to make it pass`
    })
  }
  return { check: result, gates }
}

/** The checks of a pull request, in order, and its result. */
function ciPullRequest(root, options) {
  const [base, head] = ciRequireHistory(root, [options.base, options.head])
  const mergeBase = ciMergeBase(root, base, head)
  const rules = ciRules(root, { commit: base, from: 'base' }, { commit: head, from: 'head' })
  const { config } = rules
  const { lane } = options
  const tasksAt = (commit) => taskRecordsById(treeReader({ kind: 'commit', rev: commit, root }), config.dir)
  const mergeBaseTasks = tasksAt(mergeBase)
  const headTasks = tasksAt(head)
  const baseTasks = base === mergeBase ? mergeBaseTasks : tasksAt(base)

  const checks = [ciRecordsCheck(root, head, config)]
  checks.push(ciCommitsCheck(root, mergeBase, head, config, lane, false, null))

  const ownership = ownershipProblems({
    before: mergeBaseTasks,
    after: headTasks,
    lane,
    config,
    holders: [baseTasks],
    accepted: [baseTasks],
    baseName: config.base
  })
  // A task that names another lane and changes here must be that lane's copy (a stacked branch).
  const reported = new Set(ownership.map(({ file }) => file))
  const foreign = foreignLaneTasks({ before: mergeBaseTasks, after: headTasks, lane, accepted: [baseTasks] }).filter(({ task }) => !reported.has(task.file))
  ownership.push(...laneCopyProblems(foreign, ciLaneCopies(root, foreign), config))
  const changed = [...headTasks].filter(([id, { text }]) => mergeBaseTasks.get(id)?.text !== text).length
  checks.push({ name: 'ownership', ok: ownership.length === 0, problems: ownership, counts: { changed }, note: null })
  checks.push(ciIdsCheck(root, config, { mergeBaseTasks, headTasks, baseTasks, base, head, lane, fork: options.fork }))

  const moved = ciMovedTasks(mergeBaseTasks, headTasks)
  checks.push({ name: 'moved', ok: true, problems: [], counts: { moved: moved.length }, note: null })

  const { check, gates } = ciGatesCheck(root, config, head)
  checks.push(check)

  // The pull request's own changes start at the merge base; a merge base from before the base
  // added ResaLedger has no configuration, so the base stands in for it.
  const mergeBaseConfig = loadConfig(treeReader({ kind: 'commit', rev: mergeBase, root })).config
  const from = mergeBaseConfig ? mergeBase : base
  const enforcement = enforcementCheck(root, { from, mergeBase, head, adds: rules.adds, released: options.released ?? releasedTable() })
  checks.push(enforcement.check)
  return { mergeBase, rules, checks, moved, gates, enforcement: enforcement.changes }
}

/**
 * Why a push is not checked, or null. With --only-base-pushes, as the workflow runs it, only a
 * push to the base branch or a protected branch is checked; a lane's commits are checked in
 * its pull request.
 */
function ciSkippedPush(options, config) {
  if (!options.onlyBasePushes || !options.ref) return null
  const branches = [config.base, ...config.protected]
  const branch = options.ref.replace(/^refs\/heads\//, '')
  if (options.ref.startsWith('refs/heads/') && branches.includes(branch)) return null
  return `a push to ${options.ref}, which is not the base branch or a protected branch (--only-base-pushes); its commits are checked in their pull request`
}

/** The checks of a push, in order, and its result. */
function ciPush(root, options) {
  const newBranch = options.before === null || CI_ZERO.test(options.before)
  const [after] = ciRequireHistory(root, [options.after])
  let before = null
  let from = null
  if (!newBranch) {
    before = ciRequireHistory(root, [options.before])[0]
    // A forced push: only the commits that are new since the common history are checked.
    from = ciIsAncestor(root, before, after) ? before : ciMergeBase(root, before, after)
  }
  const rules = ciRules(root, { commit: before, from: 'before' }, { commit: after, from: 'after' })
  const { config } = rules
  const skipped = ciSkippedPush(options, config)
  if (skipped) return { from: null, rules, checks: [], moved: [], gates: null, enforcement: null, skipped }
  const checks = [ciRecordsCheck(root, after, config)]
  const note = newBranch ? 'a new branch: its commits are checked in their pull request' : null
  checks.push(ciCommitsCheck(root, from, after, config, null, true, note))
  const tasksAt = (commit) => taskRecordsById(treeReader({ kind: 'commit', rev: commit, root }), config.dir)
  const moved = from === null ? [] : ciMovedTasks(tasksAt(from), tasksAt(after))
  checks.push({ name: 'moved', ok: true, problems: [], counts: { moved: moved.length }, note: null })
  return { from, rules, checks, moved, gates: null, enforcement: null }
}

/**
 * The released table of ci --release: this guard's own table with the unpacked package's added,
 * so that an update of the guard to that release passes without a decision. { version, table }.
 */
function ciRelease(folder) {
  try {
    const { version, table } = packageReleased(folder)
    return { version, table: mergeReleased(releasedTable(), table) }
  } catch (error) {
    throw new CiError(`--release: ${error.message}`)
  }
}

/**
 * The CI check as data. options is { event, source, base, head, lane, fork, number } for a pull
 * request or { event: 'push', source, before, after, ref } for a push, plus an optional root,
 * release (an unpacked package's folder) and onlyBasePushes.
 *
 * Returns { event, source, base, head, lane, fork, ref, mergeBase, from, rules, checks, moved,
 * gates, enforcement, release, skipped, ok }:
 * - rules: { from: 'base' | 'head' | 'before' | 'after', commit, adds } (adds: the change adds
 *   ResaLedger and is judged by its own rules);
 * - checks: [{ name, ok, skipped?, problems, counts, note }] in the order they ran: records,
 *   commits, ownership, ids, moved, gates, enforcement for a pull request; records, commits,
 *   moved for a push;
 * - moved: [{ id, title, file, from, to, evidence }];
 * - gates: { mode: 'run' | 'stamp' | 'none', ranOn, passed: [{ command, seconds }], failure,
 *   stamp } for a pull request, null for a push;
 * - enforcement: for a pull request, the changes to enforcement from the merge base to the head,
 *   [{ id, kind: 'listed' | 'weakening', file, what, decidedBy: { file, by } | null }]; empty
 *   when nothing changed or when the change adds ResaLedger; null for a push;
 * - release: { version, folder } when options.release names an unpacked package, else null;
 * - skipped: why a push is not checked (options.onlyBasePushes), else null; then checks is empty.
 * Throws a CiError when the check cannot run, such as for a missing commit.
 */
export function ciResult(options) {
  let root = options.root
  if (!root) {
    try {
      root = repositoryRoot()
    } catch {
      throw new CiError('not inside a git repository')
    }
  }
  const pullRequest = options.event !== 'push'
  const release = options.release ? ciRelease(options.release) : null
  const outcome = pullRequest ? ciPullRequest(root, { ...options, released: release?.table }) : ciPush(root, options)
  return {
    event: options.event,
    source: options.source ?? 'flags',
    base: pullRequest ? ciCommit(root, options.base) : null,
    head: pullRequest ? ciCommit(root, options.head) : ciCommit(root, options.after),
    lane: pullRequest ? options.lane : null,
    fork: pullRequest ? Boolean(options.fork) : false,
    ref: options.ref ?? null,
    before: pullRequest ? null : options.before,
    mergeBase: outcome.mergeBase ?? null,
    from: outcome.from ?? null,
    rules: { from: outcome.rules.from, commit: outcome.rules.commit, adds: outcome.rules.adds },
    checks: outcome.checks,
    moved: outcome.moved,
    gates: outcome.gates,
    enforcement: outcome.enforcement,
    release: release ? { version: release.version, folder: options.release } : null,
    skipped: outcome.skipped ?? null,
    ok: outcome.checks.every((check) => check.ok)
  }
}

const CI_USAGE = 'use --base <rev> --head <rev> [--lane <branch>], --release <folder> and --only-base-pushes'

/** The flags of ci: { base, head, lane, release, onlyBasePushes }; throws on an unknown one. */
function ciFlags(args) {
  const flags = { onlyBasePushes: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--only-base-pushes') {
      flags.onlyBasePushes = true
      continue
    }
    if (!['--base', '--head', '--lane', '--release'].includes(arg)) throw new CiError(`unknown option "${arg}" for ci; ${CI_USAGE}`)
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new CiError(`${arg} needs a value`)
    flags[arg.slice(2)] = value
    index += 1
  }
  return flags
}

/**
 * The options of ci from its arguments, or from the GitHub event when --base and --head are not
 * given. --base and --head with --lane check a pull request from that lane; without --lane, they
 * check a push of the commits from --base to --head. --release and --only-base-pushes apply to both.
 */
export function ciOptions(args, env = process.env) {
  const { base, head, lane, release = null, onlyBasePushes } = ciFlags(args)
  const extra = { release, onlyBasePushes }
  if (base || head || lane) {
    if (!base || !head) throw new CiError('ci needs both --base <rev> and --head <rev>, and --lane <branch> for a pull request')
    if (lane) return { event: 'pull_request', source: 'flags', base, head, lane, fork: false, number: null, ...extra }
    return { event: 'push', source: 'flags', before: base, after: head, ref: null, ...extra }
  }

  const name = env.GITHUB_EVENT_NAME
  const path = env.GITHUB_EVENT_PATH
  if (!name || !path) throw new CiError('no CI event found: run ci in GitHub Actions, or pass --base <rev> --head <rev> [--lane <branch>]')
  let payload
  try {
    payload = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new CiError(`cannot read the event file GITHUB_EVENT_PATH: ${error.message}`)
  }
  if (CI_PULL_REQUEST_EVENTS.includes(name)) {
    const pr = payload.pull_request
    if (!pr?.base?.sha || !pr?.head?.sha || !pr?.head?.ref) throw new CiError(`the ${name} event has no pull_request.base.sha, head.sha and head.ref`)
    const baseRepo = pr.base.repo?.full_name ?? null
    const headRepo = pr.head.repo?.full_name ?? null
    const number = Number.isInteger(pr.number) ? pr.number : null
    return { event: 'pull_request', source: 'github', base: pr.base.sha, head: pr.head.sha, lane: pr.head.ref, fork: headRepo === null || headRepo !== baseRepo, number, ...extra }
  }
  if (name === 'push') {
    if (!payload.after) throw new CiError('the push event has no "after" commit')
    return { event: 'push', source: 'github', before: payload.before ?? null, after: payload.after, ref: payload.ref ?? null, ...extra }
  }
  throw new CiError(`the ${name} event is not one ci checks; run it on pull_request and push, or pass --base <rev> --head <rev> [--lane <branch>]`)
}

/**
 * ci [--base <rev> --head <rev> [--lane <branch>]] [--release <folder>] [--only-base-pushes]:
 * runs the CI check and prints it; writes the job summary when GITHUB_STEP_SUMMARY is set, also
 * when the check fails or cannot run; comments on the pull request when it can; exits 1 when a
 * check fails.
 */
export async function ciCommand(args, env = process.env) {
  let options
  let result
  try {
    options = ciOptions(args, env)
    result = ciResult(options)
  } catch (error) {
    if (!(error instanceof CiError)) throw error
    writeSummary(env, ciErrorMarkdown(error.message))
    fail(error.message)
  }
  console.log(ciText(result))
  const markdown = ciMarkdown(result)
  writeSummary(env, markdown)
  await ciComment(env, options, markdown)
  if (!result.ok) process.exit(1)
}
