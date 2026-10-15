// The git hooks on the guard side: what each hook checks, whether the hooks are active
// in this clone, and turning them on.
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { CONFIG_FILE, loadConfig } from './config.mjs'
import { runGates } from './gates.mjs'
import { branchTaskFiles, idCollisions } from './ids.mjs'
import { currentLane, localLanes } from './lanes.mjs'
import { ownershipProblems, taskRecordsById } from './ownership.mjs'
import { checkCommit, checkRange, commitExemption, commitPaths, isRevert, mergeOwnPaths, readCommits, taskFileFor } from './range.mjs'
import { parseTask } from './tasks.mjs'
import { fail, git, repositoryRoot } from './util.mjs'
import { checkWorkspace, isCode, loadWorkspace, treeReader } from './workspace.mjs'

export const HOOKS_PATH = '.githooks'

// The YAML files of the hook managers whose installed hooks do not name the guard themselves.
const MANAGER_FILES = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml', '.pre-commit-config.yaml']

/** The text of a file, or '' when it cannot be read. */
function readHookFile(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** The value of core.hooksPath, or '' when it is unset. */
function configuredHooksPath(root) {
  try {
    return git('-C', root, 'config', '--get', 'core.hooksPath')
  } catch {
    return ''
  }
}

/** True when the path names the .githooks folder at the repository root. */
function isOwnHooksPath(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') === HOOKS_PATH
}

/**
 * True when git runs the guard's commit-msg check in this clone: the effective hooks folder
 * (core.hooksPath or the git folder's hooks, per worktree) holds the ResaLedger commit-msg
 * hook, or a hook manager's commit-msg hook is installed and its configuration calls the guard.
 */
export function hooksActive() {
  const root = repositoryRoot()
  let folder = git('-C', root, 'rev-parse', '--git-path', 'hooks')
  if (!isAbsolute(folder)) folder = join(root, folder)
  const hook = readHookFile(join(folder, 'commit-msg'))
  if (hook === '') return false
  if (hook.split(/\r?\n/).includes('# resaledger: commit-msg hook, managed by ResaLedger; do not edit')) return true
  const calls = /scripts\/records\.mjs"?\s+commit-msg\b/
  if (calls.test(hook)) return true
  // husky runs .husky/<hook> from its own scripts in .husky/_.
  if (folder.replace(/\\/g, '/').replace(/\/+$/, '').endsWith('.husky/_') && calls.test(readHookFile(join(folder, '..', 'commit-msg'))))
    return true
  return MANAGER_FILES.some((file) => calls.test(readHookFile(join(root, file))))
}

/**
 * Points core.hooksPath at .githooks when it is unset. Returns 'activated' when it set it,
 * 'active' when it already pointed there, and { foreign: value } without changing anything
 * when it holds another value, such as a hook manager's folder.
 */
export function activateHooks() {
  const root = repositoryRoot()
  const current = configuredHooksPath(root)
  if (current === '') {
    git('-C', root, 'config', '--local', 'core.hooksPath', HOOKS_PATH)
    return 'activated'
  }
  if (isOwnHooksPath(current)) return 'active'
  return { foreign: current }
}

/** Prints the refusal of a commit with one line per problem, and exits 1. */
function githooksRefuse(problems) {
  console.error('✖ This commit is refused')
  for (const { file, line, message } of problems) console.error(`  ${file ? `${file}${line ? `:${line}` : ''}: ` : ''}${message}`)
  process.exit(1)
}

/** The full object id of a revision's commit, or null when it does not resolve. */
function githooksCommit(rev) {
  try {
    return git('rev-parse', '--verify', '-q', `${rev}^{commit}`) || null
  } catch {
    return null
  }
}

/** The problems with the branch: a protected branch, or a name that fails branchPattern. */
function githooksBranchProblems(branch, config) {
  if (branch === null) return []
  const guard = `node ${config.dir}/scripts/records.mjs`
  if (config.protected.includes(branch)) {
    return [
      {
        file: '',
        line: 0,
        message: `"${branch}" is a protected branch, so nothing is committed on it, not even a merge. Work in a lane branch, for example with "${guard} claim <id>", which creates one, and open a pull request`
      }
    ]
  }
  if (config.branchRegex && branch !== config.base && !config.branchRegex.test(branch)) {
    return [
      {
        file: '',
        line: 0,
        message: `the branch name "${branch}" does not match branchPattern ${JSON.stringify(config.branchPattern)} in .resaledger.json. Rename it with "git branch -m <name>"`
      }
    ]
  }
  return []
}

/**
 * The ownership problems of the staged tasks (spec 6.2), compared by id with HEAD: a task that
 * exists on the base branch was deleted or had its id renamed, or a task another lane holds was
 * changed without a takeover. During a merge, a task staged exactly as the merged commit has it
 * is that lane's own change and passes.
 */
function githooksOwnershipProblems(root, branch, config, head, headTasks, stagedTasks) {
  let kept = new Set(headTasks.keys())
  const deleted = [...headTasks.keys()].some((id) => !stagedTasks.has(id))
  const base = deleted && branch !== config.base ? githooksCommit(config.base) : null
  if (base !== null) {
    let mergeBase = head
    try {
      mergeBase = git('merge-base', head, base) || head
    } catch {
      // Unrelated histories: HEAD stands for the base.
    }
    if (mergeBase !== head) kept = new Set(taskRecordsById(treeReader({ kind: 'commit', rev: mergeBase, root }), config.dir).keys())
  }
  const mergeHead = githooksCommit('MERGE_HEAD')
  const accepted = mergeHead === null ? [] : [taskRecordsById(treeReader({ kind: 'commit', rev: mergeHead, root }), config.dir)]
  return ownershipProblems({ before: headTasks, after: stagedTasks, lane: branch, config, kept, accepted })
}

/**
 * The id problems of the staged tasks (spec 6.7 and 9): an id that this commit adds and that a
 * locally visible branch has in another file. The other branches are the local branches and the
 * remote-tracking branches, except this lane's own, and the other worktrees as they are on disk.
 */
function githooksIdProblems(root, branch, config, headTasks, stagedTasks) {
  const added = [...stagedTasks.values()].filter(({ task }) => !headTasks.has(task.id)).map(({ task }) => ({ id: task.id, file: task.file }))
  if (added.length === 0) return []
  let own = new Set()
  if (branch !== null) {
    const remotes = git('-C', root, 'remote').split('\n').filter((name) => name !== '')
    own = new Set([`refs/heads/${branch}`, ...remotes.map((remote) => `refs/remotes/${remote}/${branch}`)])
  }
  const others = branchTaskFiles({ root, dir: config.dir, exclude: (ref) => own.has(ref.ref) })
  for (const lane of localLanes(config)) {
    others.push({ branch: lane.branch, worktree: true, files: new Map(lane.tasks.filter((task) => task.id).map((task) => [task.id, task.file])) })
  }
  return idCollisions(added, others, config)
}

/** The staged paths, compared with HEAD (or with nothing before the first commit), deletions included. */
function githooksStagedPaths() {
  return git('diff', '--cached', '--name-only', '--no-renames', '-z')
    .split('\0')
    .filter((path) => path !== '')
}

/**
 * The pre-commit hook, judged on the staged content (the index git names in GIT_INDEX_FILE,
 * which is a temporary one for `git commit -- <paths>`): the configuration, the branch rules,
 * the records, task ownership against HEAD, new ids against the other local branches and
 * worktrees, and the commit gates when code is staged.
 * A refusal prints every problem and exits 1; a pass prints only the gate lines.
 */
export function preCommit() {
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }
  const reader = treeReader({ kind: 'index', root })
  const { config, problems: configProblems } = loadConfig(reader)
  if (!config) githooksRefuse(configProblems)

  const branch = currentLane()
  const problems = githooksBranchProblems(branch, config)
  problems.push(...checkWorkspace(loadWorkspace(reader, config), reader, config))
  const head = githooksCommit('HEAD')
  const headTasks = head === null ? new Map() : taskRecordsById(treeReader({ kind: 'commit', rev: head, root }), config.dir)
  const stagedTasks = taskRecordsById(reader, config.dir)
  if (branch !== null && head !== null) problems.push(...githooksOwnershipProblems(root, branch, config, head, headTasks, stagedTasks))
  problems.push(...githooksIdProblems(root, branch, config, headTasks, stagedTasks))
  if (problems.length > 0) githooksRefuse(problems)

  if (config.gates.commit.length === 0 || !githooksStagedPaths().some((path) => isCode(path, config))) return
  const { failure } = runGates(config.gates.commit, { root })
  if (failure) {
    githooksRefuse([{ file: '', line: 0, message: `the commit gate "${failure.command}" failed. Fix the code; a gate is never weakened to make it pass` }])
  }
}

/**
 * What aiAttribution "forbid" refuses in a trailer. names are models, assistants and vendors,
 * matched as whole words in any case. qualified are names that are also people's first names,
 * so they match only in the forms listed (<version> is a version number, <digit> one digit).
 * domains are the vendors' e-mail domains. A GitHub bot address ("<login>[bot]" at GitHub's
 * users.noreply host) is refused when its login contains any of the names.
 */
export const AI_ATTRIBUTION = Object.freeze({
  names: Object.freeze([
    'Anthropic',
    'OpenAI',
    'ChatGPT',
    'GPT',
    'Codex',
    'Copilot',
    'Gemini',
    'Cursor',
    'Grok',
    'xAI',
    'Moonshot',
    'Mistral',
    'Aider',
    'Windsurf',
    'Codeium',
    'DeepSeek',
    'Qwen',
    'Amazon Q'
  ]),
  qualified: Object.freeze([
    Object.freeze({
      name: 'Claude',
      forms: Object.freeze(['Claude Code', 'Claude Opus', 'Claude Sonnet', 'Claude Haiku', 'Claude Fable', 'Claude Instant', 'Claude <version>'])
    }),
    Object.freeze({ name: 'Devin', forms: Object.freeze(['Devin AI', 'devin-ai']) }),
    Object.freeze({ name: 'Jules', forms: Object.freeze(['google-labs-jules', 'Jules[bot]']) }),
    Object.freeze({ name: 'Kimi', forms: Object.freeze(['Kimi K<digit>', 'Kimi Code', 'Kimi AI']) })
  ]),
  domains: Object.freeze([
    'anthropic.com',
    'openai.com',
    'cursor.com',
    'cursor.sh',
    'x.ai',
    'moonshot.ai',
    'moonshot.cn',
    'mistral.ai',
    'cognition.ai',
    'aider.chat',
    'codeium.com',
    'windsurf.com',
    'deepseek.com'
  ])
})

const GITHOOKS_ESCAPE = /[.*+?^${}()|[\]\\]/g
// A name as a word: no letter or digit before it, no letter after it (so "GPT-4o" matches, "cursory" does not).
const GITHOOKS_AI_NAME = new RegExp(
  `(?<![A-Za-z0-9])(?:${AI_ATTRIBUTION.names.map((name) => name.replace(GITHOOKS_ESCAPE, '\\$&').replace(/ /g, '[\\s-]+')).join('|')})(?![A-Za-z])`,
  'i'
)
// The qualified forms of AI_ATTRIBUTION, one pattern for each name, in the same order.
const GITHOOKS_AI_QUALIFIED = [
  /(?<![A-Za-z0-9])claude(?:[\s-]+(?:code|opus|sonnet|haiku|fable|instant)(?![A-Za-z])|[\s-]*v?\d)/i,
  /(?<![A-Za-z0-9])devin[\s-]ai(?![A-Za-z])/i,
  /(?<![A-Za-z0-9])(?:google-labs-jules|jules\[bot\])/i,
  /(?<![A-Za-z0-9])kimi[\s-]*(?:k\d|code(?![A-Za-z])|ai(?![A-Za-z]))/i
]
const GITHOOKS_AI_DOMAIN = new RegExp(
  `@(?:[A-Za-z0-9-]+\\.)*(?:${AI_ATTRIBUTION.domains.map((domain) => domain.replace(GITHOOKS_ESCAPE, '\\$&')).join('|')})(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`,
  'i'
)
// A GitHub bot address: the login (after an optional "<id>+") ends in [bot].
const GITHOOKS_GITHUB_BOT = /(?:\d+\+)?([A-Za-z0-9-]+)\[bot\]@users\.noreply\.github\.com/gi
const GITHOOKS_AI_LOGIN_NAMES = [...AI_ATTRIBUTION.names, ...AI_ATTRIBUTION.qualified.map(({ name }) => name)].map((name) =>
  name.toLowerCase().replace(/ /g, '')
)

/** Whether a trailer line names an AI model, assistant or vendor, as AI_ATTRIBUTION lists them. */
function githooksNamesAi(line) {
  if (GITHOOKS_AI_NAME.test(line) || GITHOOKS_AI_DOMAIN.test(line)) return true
  if (GITHOOKS_AI_QUALIFIED.some((pattern) => pattern.test(line))) return true
  for (const [, login] of line.matchAll(GITHOOKS_GITHUB_BOT)) {
    const plain = login.toLowerCase()
    if (GITHOOKS_AI_LOGIN_NAMES.some((name) => plain.includes(name))) return true
  }
  return false
}

// A trailer whose key ends in -by or -with: Co-authored-by, Signed-off-by, Assisted-by, Generated-with.
const GITHOOKS_ATTRIBUTION_TRAILER = /^[A-Za-z0-9][A-Za-z0-9-]*-(?:by|with)[ \t]*:/i
// type(scope)!: description, after any of git's fixup!, squash! and amend! prefixes.
const GITHOOKS_CONVENTIONAL = /^(?:(?:fixup|squash|amend)! )*[a-z]+(?:\([^()\s][^()]*\))?!?: \S/
const GITHOOKS_ZERO_OID = /^0+$/

/** The comment prefix of commit messages: core.commentString or core.commentChar, '#' by default and for "auto". */
function githooksCommentPrefix() {
  for (const key of ['core.commentString', 'core.commentChar']) {
    let value = ''
    try {
      value = git('config', '--get', key)
    } catch {
      // Unset.
    }
    if (value !== '' && value !== 'auto') return value
  }
  return '#'
}

/**
 * The message as git stores it with the default cleanup: comment lines and everything from
 * the scissors line of `git commit -v` down are dropped, trailing spaces trimmed, runs of
 * blank lines collapsed, and blank lines at the start and the end removed.
 */
function githooksCleanMessage(text, comment) {
  const scissors = `${comment} ------------------------ >8 ------------------------`
  const kept = []
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    if (line === scissors) break
    if (line.startsWith(comment)) continue
    kept.push(line.trimEnd())
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '')
}

/** The attribution trailers of a message that name a model, an assistant or its vendor, as problems. */
function githooksAttributionProblems(message) {
  const problems = []
  for (const line of message.split('\n').slice(1)) {
    if (!GITHOOKS_ATTRIBUTION_TRAILER.test(line)) continue
    if (!githooksNamesAi(line)) continue
    problems.push({
      file: '',
      line: 0,
      message: `the trailer "${line.trim()}" names an AI model, assistant or vendor, and aiAttribution is "forbid" in .resaledger.json. Remove the trailer`
    })
  }
  return problems
}

/** The task with an id in the tasks folder of a reader, parsed, or null when it has no file there. */
function githooksTaskIn(reader, dir, id) {
  const folder = `${dir}/tasks/`
  const names = reader
    .list(`${dir}/tasks`)
    .map((path) => path.slice(folder.length))
    .filter((name) => !name.includes('/'))
  const name = taskFileFor(names, id)
  return name === null ? null : parseTask(`${folder}${name}`, reader.read(`${folder}${name}`) ?? '')
}

/** The commits a merge being concluded brings in, from MERGE_HEAD (one per line), or [] when none is. */
function githooksMergeHeads(root) {
  let text
  try {
    const path = git('rev-parse', '--git-path', 'MERGE_HEAD')
    text = readFileSync(isAbsolute(path) ? path : join(root, path), 'utf8')
  } catch {
    return []
  }
  const heads = text.split('\n').filter((line) => line.trim() !== '')
  const resolved = heads.map((line) => githooksCommit(line.trim()))
  if (resolved.includes(null)) fail('cannot read MERGE_HEAD, so this merge is not checked')
  return resolved
}

/**
 * What commit-msg judges, spec 5.9: { parents, paths, exemption }. While a merge is concluded,
 * paths are the code paths the merge changes of its own, and none exempts it. Otherwise paths
 * are the staged ones against HEAD; when nothing is staged and HEAD is not a merge (as in
 * `commit --amend` with only a new message), HEAD's own paths against its parent are judged too,
 * so dropping the trailer from a code commit is refused. A real revert is exempt.
 */
function githooksJudged(root, config, head, message) {
  const mergeHeads = head === null ? [] : githooksMergeHeads(root)
  if (mergeHeads.length > 0) {
    const parents = [head, ...mergeHeads]
    const paths = mergeOwnPaths(root, config, parents, null)
    return { parents, paths, exemption: paths.length === 0 ? 'merge' : null }
  }
  let paths = githooksStagedPaths()
  let parent = head
  let target = null
  if (head !== null && paths.length === 0) {
    const [current] = readCommits(root, ['--no-walk', head])
    if (current === undefined || current.hash !== head) fail('cannot read HEAD, so this commit is not checked')
    if (current.parents.length < 2) {
      paths = commitPaths(root, head)
      parent = current.parents[0] ?? null
      target = head
    }
  }
  const revert = paths.some((path) => isCode(path, config)) && isRevert(root, message, parent, target)
  return { parents: [], paths, exemption: revert ? 'revert' : null }
}

/**
 * The commit-msg hook, given the message file. The message is cleaned as git will store it,
 * then judged: attribution trailers when aiAttribution is "forbid" (on every commit), the
 * Conventional Commits header when commitStyle is "conventional" (not on a merge or a real
 * revert), and the task trailers against the staged tree (the index in GIT_INDEX_FILE), with
 * the rules checkRange applies to one commit and HEAD as the start (see githooksJudged).
 */
export function commitMsg(file) {
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    fail(`cannot read the commit message file ${file}: ${error.message}`)
  }
  const message = githooksCleanMessage(text, githooksCommentPrefix())
  const reader = treeReader({ kind: 'index', root })
  const { config, problems: configProblems } = loadConfig(reader)
  if (!config) githooksRefuse(configProblems)

  const head = githooksCommit('HEAD')
  let judged
  try {
    judged = githooksJudged(root, config, head, message)
  } catch (error) {
    fail(`${error.message}; the commit is refused`)
  }
  const subject = message.split('\n')[0]
  const commit = { short: '', committer: '', subject, message, ...judged }
  const problems = config.aiAttribution === 'forbid' ? githooksAttributionProblems(message) : []
  if (commit.parents.length < 2 && commitExemption(commit, { skipGitHubMerges: false }) === null && config.commitStyle === 'conventional' && !GITHOOKS_CONVENTIONAL.test(subject)) {
    problems.unshift({
      file: '',
      line: 0,
      message: `the header "${subject}" does not follow Conventional Commits, and commitStyle is "conventional" in .resaledger.json. Write "type(scope): description", for example "feat(server): store documents"`
    })
  }
  const headReader = head === null ? null : treeReader({ kind: 'commit', rev: head, root })
  problems.push(
    ...checkCommit(commit, {
      config,
      lane: currentLane(),
      skipGitHubMerges: false,
      task: (id) => githooksTaskIn(reader, config.dir, id),
      startLane: (id) => (headReader === null ? null : (githooksTaskIn(headReader, config.dir, id)?.lane ?? null))
    })
  )
  if (problems.length > 0) githooksRefuse(problems)
}

/** The merge base of two revisions, or null when they have none. */
function githooksMergeBase(a, b) {
  try {
    return git('merge-base', a, b) || null
  } catch {
    return null
  }
}

/**
 * The lines of a push as [localRef, localOid, remoteRef, remoteOid]: git's stdin, or, when it
 * is empty, the variables the pre-commit framework sets instead of passing stdin on.
 */
function githooksPushLines(input, env) {
  const lines = String(input)
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 4)
  if (lines.length > 0 || !env.PRE_COMMIT_REMOTE_BRANCH) return lines
  const localRef = env.PRE_COMMIT_LOCAL_BRANCH || 'HEAD'
  const localOid = githooksCommit(env.PRE_COMMIT_TO_REF || localRef)
  if (localOid === null) return []
  const remoteOid = (env.PRE_COMMIT_FROM_REF && githooksCommit(env.PRE_COMMIT_FROM_REF)) || '0'.repeat(localOid.length)
  return [[localRef, localOid, env.PRE_COMMIT_REMOTE_BRANCH, remoteOid]]
}

/**
 * Where the commits a push adds start: the remote commit when git has it; otherwise the merge
 * base with the remote's base branch; otherwise, for a branch other than the base, the merge
 * base with the local base branch; otherwise the commit that added .resaledger.json, so an
 * adopting project is not judged on its history. null means every ancestor.
 */
function githooksPushStart(localOid, remoteOid, remote, branch, config) {
  if (!GITHOOKS_ZERO_OID.test(remoteOid) && githooksCommit(remoteOid) !== null) return remoteOid
  const remoteBase = remote ? githooksCommit(`refs/remotes/${remote}/${config.base}`) : null
  if (remoteBase !== null) {
    const start = githooksMergeBase(localOid, remoteBase)
    if (start !== null) return start
  }
  if (branch !== config.base) {
    const localBase = githooksCommit(`refs/heads/${config.base}`)
    const start = localBase === null ? null : githooksMergeBase(localOid, localBase)
    if (start !== null) return start
  }
  try {
    return git('log', '--diff-filter=A', '--format=%H', localOid, '--', CONFIG_FILE).split('\n')[0] || null
  } catch {
    return null
  }
}

/**
 * The pre-push hook, given git's lines on stdin and its arguments (the remote's name and URL).
 * For each pushed branch: no push to a protected branch and no deletion of one, and the
 * commits the push adds pass checkRange with the local branch as the lane. Tags are skipped.
 * The configuration is the pushed commit's own (HEAD's for a deletion).
 */
export function prePush(input, args = []) {
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }
  const remote = args[0] || process.env.PRE_COMMIT_REMOTE_NAME || ''
  const configs = new Map()
  const configAt = (rev) => {
    if (!configs.has(rev)) {
      const reader = treeReader({ kind: 'commit', rev, root })
      configs.set(rev, reader.exists(CONFIG_FILE) ? loadConfig(reader) : { config: null, problems: [] })
    }
    return configs.get(rev)
  }
  const problems = []
  for (const [localRef, localOid, remoteRef, remoteOid] of githooksPushLines(input, process.env)) {
    if (!remoteRef.startsWith('refs/heads/')) continue
    const branch = remoteRef.slice('refs/heads/'.length)
    const refuse = (message) => problems.push(`${branch}: ${message}`)
    const deletion = GITHOOKS_ZERO_OID.test(localOid)
    const rev = githooksCommit(deletion ? 'HEAD' : localOid)
    if (rev === null) continue
    const { config, problems: configProblems } = configAt(rev)
    if (!config) {
      for (const { file, line, message } of configProblems) refuse(`${file}${line ? `:${line}` : ''}: ${message}`)
      continue
    }
    if (config.protected.includes(branch)) {
      refuse(
        deletion
          ? `"${branch}" is a protected branch, so it is not deleted`
          : `"${branch}" is a protected branch, so nothing is pushed to it directly. Push a lane branch and open a pull request`
      )
      continue
    }
    if (deletion) continue
    const lane = localRef.startsWith('refs/heads/') ? localRef.slice('refs/heads/'.length) : branch
    const from = githooksPushStart(localOid, remoteOid, remote, branch, config)
    for (const { file, line, message } of checkRange(from, localOid, { config, lane, skipGitHubMerges: false, root })) {
      refuse(`${file}${line ? `:${line}` : ''}: ${message}`)
    }
  }
  if (problems.length === 0) return
  console.error('✖ This push is refused')
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
