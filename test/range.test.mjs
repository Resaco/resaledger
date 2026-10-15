// The commit range check: task trailers, each rule and each exemption in real repositories,
// a task renamed later in the range, a range of 200 commits within a time budget, and
// check --range through the bundle.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { parseConfig } from '../src/guard/config.mjs'
import { checkRange, taskTrailers } from '../src/guard/range.mjs'
import { budget, ENV, PACKAGE, repository, run, temporary } from './helpers.mjs'

// GitHub's committer address, in two parts for the hygiene scan.
const GITHUB = ['noreply', 'github.com'].join('@')
const CONFIG = parseConfig('{ "version": 2 }').config

/** The text of a task file. */
function task(id, status, lane = null) {
  return `# ${id} Title of ${id}\n\n- Status: ${status}\n${lane ? `- Lane: ${lane}\n` : ''}`
}

/** Writes files and commits them with the given message paragraphs; fails the test when git does. */
function commit(r, files, ...messages) {
  for (const [path, text] of Object.entries(files)) r.write(path, text)
  const committed = r.commit(...messages)
  assert.equal(committed.status, 0, committed.out)
  return head(r)
}

/** The full id of HEAD, or of another revision. */
function head(r, rev = 'HEAD') {
  return r.git('rev-parse', rev).out.trim()
}

/** The short id git prints for a revision, as the problems name it. */
function short(r, rev = 'HEAD') {
  return r.git('log', '-1', '--format=%h', rev).out.trim()
}

/**
 * A repository on branch lane-a whose first commit (on main) holds the configuration and
 * tasks S1 and S2, both todo. Returns the helpers and the id of that commit.
 */
function setup(tasks = { S1: task('S1', 'todo'), S2: task('S2', 'todo') }) {
  const r = repository()
  const files = { '.resaledger.json': '{ "version": 2 }\n' }
  for (const [id, text] of Object.entries(tasks)) files[`ledger/tasks/${id}.md`] = text
  const base = commit(r, files, 'chore: set up', 'Task: maintenance')
  r.git('checkout', '-q', '-b', 'lane-a')
  return { r, base }
}

/** Runs the check from a revision to HEAD. */
function check(r, from, { lane = 'lane-a', skipGitHubMerges = false, to = 'HEAD' } = {}) {
  return checkRange(from, to, { config: CONFIG, lane, skipGitHubMerges, root: r.root })
}

describe('taskTrailers', () => {
  test('reads every Task: line of the body, comma-separated', () => {
    assert.deepEqual(taskTrailers('feat: a\n\nTask: S1, S2\nTask: S3\n'), { ids: ['S1', 'S2', 'S3'], maintenance: false })
    assert.deepEqual(taskTrailers('feat: a\r\n\r\nTask: S1\r\n'), { ids: ['S1'], maintenance: false })
    assert.deepEqual(taskTrailers('feat: a\n\nTask: S1,S1 , ,S2.1\n'), { ids: ['S1', 'S2.1'], maintenance: false })
  })

  test('maintenance is a flag, in lowercase only', () => {
    assert.deepEqual(taskTrailers('chore: bump\n\nTask: maintenance\n'), { ids: [], maintenance: true })
    assert.deepEqual(taskTrailers('chore: bump\n\nTask: maintenance, S1\n'), { ids: ['S1'], maintenance: true })
    assert.deepEqual(taskTrailers('chore: bump\n\nTask: Maintenance\n'), { ids: ['Maintenance'], maintenance: false })
  })

  test('the subject line and near misses do not count', () => {
    assert.deepEqual(taskTrailers('Task: S1'), { ids: [], maintenance: false })
    assert.deepEqual(taskTrailers('feat: a\n\ntask: S1\nTasks: S2\n Task: S3\nThe Task: S4\nTask S5\n'), { ids: [], maintenance: false })
  })
})

describe('checkRange: the rules', () => {
  test('a recorded code commit passes; an unrecorded one is reported with its subject', () => {
    const { r, base } = setup()
    commit(r, { 'ledger/tasks/S1.md': task('S1', 'doing', 'lane-a') }, 'docs: claim S1')
    commit(r, { 'src/a.js': '1\n' }, 'feat: add a', 'Task: S1')
    assert.deepEqual(check(r, base), [])

    commit(r, { 'src/b.js': '1\n' }, 'feat: add b')
    const problems = check(r, base)
    assert.equal(problems.length, 1)
    assert.equal(problems[0].file, short(r))
    assert.equal(problems[0].line, 0)
    assert.match(problems[0].message, /^"feat: add b" changes code but names no task\. Add a trailer line "Task: <id>"/)
  })

  test('a commit that changes only records or Markdown needs no trailer', () => {
    const { r, base } = setup()
    commit(r, { 'ledger/tasks/S1.md': task('S1', 'doing', 'lane-a'), 'ledger/README.md': '# P\n' }, 'docs: records')
    commit(r, { 'docs/guide.md': '# Guide\n', 'README.md': '# Readme\n' }, 'docs: guide')
    assert.deepEqual(check(r, base), [])
  })

  test('deletions and renames count on both sides', () => {
    const { r, base } = setup()
    commit(r, { 'src/a.js': '1\n' }, 'feat: a', 'Task: maintenance')
    r.git('rm', '-q', 'src/a.js')
    commit(r, { 'docs/a.md': '1\n' }, 'docs: move a into the docs')
    assert.match(r.git('show', '--stat', '-M', '--format=', 'HEAD').out, /src\/a\.js => docs\/a\.md/)
    r.git('rm', '-q', 'docs/a.md')
    commit(r, { 'src/b.js': '1\n' }, 'chore: b')
    r.git('rm', '-q', 'src/b.js')
    commit(r, {}, 'chore: drop b')
    assert.deepEqual(
      check(r, base).map((problem) => problem.message.split(' changes')[0]),
      ['"docs: move a into the docs"', '"chore: b"', '"chore: drop b"']
    )
  })

  test('maintenance satisfies the rule; a misspelt id is reported', () => {
    const { r, base } = setup()
    commit(r, { 'package.json': '{}\n' }, 'chore: bump', 'Task: maintenance')
    assert.deepEqual(check(r, base), [])
    commit(r, { 'package.json': '{ }\n' }, 'chore: bump again', 'Task: Maintenance')
    const problems = check(r, base)
    assert.equal(problems.length, 1)
    assert.match(problems[0].message, /^"chore: bump again" has "Maintenance" in its Task: trailer, which is not a task id\./)
  })

  test('a task that is todo in that commit is reported, also when it is doing later', () => {
    const { r, base } = setup()
    commit(r, { 'src/a.js': '1\n' }, 'feat: a', 'Task: S1')
    commit(r, { 'ledger/tasks/S1.md': task('S1', 'doing', 'lane-a') }, 'docs: claim S1 too late')
    const problems = check(r, base)
    assert.equal(problems.length, 1)
    assert.equal(problems[0].file, short(r, 'HEAD~1'))
    assert.match(problems[0].message, /^"feat: a" names task S1, which is todo in that commit\./)
  })

  test('a task that does not exist in that commit is reported', () => {
    const { r, base } = setup()
    commit(r, { 'src/a.js': '1\n' }, 'feat: a', 'Task: S9')
    const problems = check(r, base)
    assert.equal(problems.length, 1)
    assert.match(problems[0].message, /names task S9, which has no file in ledger\/tasks\/ in that commit/)
  })

  test('a task claimed, or claimed and done, in the same commit passes', () => {
    const { r, base } = setup()
    commit(r, { 'src/a.js': '1\n', 'ledger/tasks/S1.md': task('S1', 'doing', 'lane-a') }, 'feat: a', 'Task: S1')
    commit(r, { 'src/b.js': '1\n', 'ledger/tasks/S1.md': task('S1', 'done', 'lane-a') }, 'feat: b', 'Task: S1')
    commit(r, { 'src/c.js': '1\n', 'ledger/tasks/S2.md': task('S2', 'done', 'lane-a') }, 'feat: c', 'Task: S2')
    assert.deepEqual(check(r, base), [])
  })

  test('a task held by another lane before the range is reported, also on later commits; no lane skips the rule', () => {
    const { r, base } = setup({ S1: task('S1', 'doing', 'lane-b'), S2: task('S2', 'todo') })
    commit(r, { 'src/a.js': '1\n' }, 'feat: a', 'Task: S1')
    commit(r, { 'src/b.js': '1\n' }, 'feat: b', 'Task: S1')
    assert.deepEqual(
      check(r, base).map((problem) => problem.message),
      ['"feat: a"', '"feat: b"'].map(
        (subject) => `${subject} names task S1, which is held by lane "lane-b" before this range, not by "lane-a". Name a task this lane holds, or take it over with claim --take`
      )
    )
    assert.deepEqual(check(r, base, { lane: null }), [])
  })

  test('a Lane set inside the range passes, in the same commit or a records-only one before it', () => {
    const { r, base } = setup()
    // Claimed under another name in the same commit as the code, and again in later commits.
    commit(r, { 'src/a.js': '1\n', 'ledger/tasks/S1.md': task('S1', 'doing', 'claude/s1') }, 'feat: a', 'Task: S1')
    commit(r, { 'src/b.js': '1\n' }, 'feat: b', 'Task: S1')
    // A records-only claim, then a code commit naming the task.
    commit(r, { 'ledger/tasks/S2.md': task('S2', 'doing', 'lane-a') }, 'chore: claim S2')
    commit(r, { 'src/c.js': '1\n' }, 'feat: c', 'Task: S2')
    assert.deepEqual(check(r, base), [])
    // From a later start, the Lane claude/s1 was already there: held before this range.
    const later = head(r, 'HEAD~2')
    assert.deepEqual(check(r, later), [])
    commit(r, { 'src/d.js': '1\n' }, 'feat: d', 'Task: S1')
    assert.match(check(r, later)[0].message, /^"feat: d" names task S1, which is held by lane "claude\/s1" before this range/)
  })

  test('a claim under a branch name that was renamed passes with the new lane', () => {
    const { r, base } = setup()
    r.git('checkout', '-q', '-b', 'wip')
    commit(r, { 'ledger/tasks/S1.md': task('S1', 'doing', 'wip') }, 'chore: claim S1')
    commit(r, { 'src/a.js': '1\n' }, 'feat: a', 'Task: S1')
    assert.equal(r.git('branch', '-m', 'wip', 'feat/storage').status, 0)
    commit(r, { 'src/b.js': '1\n' }, 'feat: b', 'Task: S1')
    assert.deepEqual(check(r, base, { lane: 'feat/storage' }), [])
  })

  test('a task created inside the range passes, also when no range start is given', () => {
    const { r, base } = setup()
    commit(r, { 'ledger/tasks/S7-new.md': task('S7', 'doing', 'other-name') }, 'chore: add S7')
    commit(r, { 'src/a.js': '1\n' }, 'feat: a', 'Task: S7')
    assert.deepEqual(check(r, base), [])
    assert.deepEqual(check(r, null), [])
  })

  test('several ids on one line and on two lines are each checked', () => {
    const { r, base } = setup({ S1: task('S1', 'doing', 'lane-a'), S2: task('S2', 'doing', 'lane-a'), S3: task('S3', 'todo') })
    commit(r, { 'src/a.js': '1\n' }, 'feat: a', 'Task: S1, S2')
    commit(r, { 'src/b.js': '1\n' }, 'feat: b', 'Task: S1\nTask: S2')
    assert.deepEqual(check(r, base), [])
    commit(r, { 'src/c.js': '1\n' }, 'feat: c', 'Task: S1, S3\nTask: S2, S4')
    assert.deepEqual(
      check(r, base).map((problem) => problem.message),
      [
        '"feat: c" names task S3, which is todo in that commit. A commit can only name a task that is doing or done in its own tree: claim the task first, or name the task the change belongs to',
        '"feat: c" names task S4, which has no file in ledger/tasks/ in that commit. Add the task file, or name the task the change belongs to'
      ]
    )
  })

  test('problems come in commit order', () => {
    const { r, base } = setup()
    commit(r, { 'src/a.js': '1\n' }, 'feat: a', 'Task: S1')
    commit(r, { 'src/b.js': '1\n' }, 'feat: b')
    assert.deepEqual(
      check(r, base).map((problem) => problem.file),
      [short(r, 'HEAD~1'), short(r)]
    )
  })

  test('a root commit is checked against all its files', () => {
    const r = repository()
    commit(r, { '.resaledger.json': '{ "version": 2 }\n', 'src/a.js': '1\n' }, 'feat: start')
    assert.match(checkRange(null, 'HEAD', { config: CONFIG, lane: 'main', skipGitHubMerges: false, root: r.root })[0].message, /^"feat: start" changes code/)

    const named = repository()
    commit(named, { 'src/a.js': '1\n', 'ledger/tasks/S1-start.md': task('S1', 'doing', 'main') }, 'feat: start', 'Task: S1')
    assert.deepEqual(checkRange(null, 'HEAD', { config: CONFIG, lane: 'main', skipGitHubMerges: false, root: named.root }), [])
    const docs = repository()
    commit(docs, { 'README.md': '# Readme\n' }, 'docs: start')
    assert.deepEqual(checkRange('', 'HEAD', { config: CONFIG, lane: 'main', skipGitHubMerges: false, root: docs.root }), [])
  })

  test('a task renamed later in the range: the old commits are checked against their own trees', () => {
    const { r, base } = setup({ S1: task('S1', 'doing', 'lane-a') })
    r.git('mv', 'ledger/tasks/S1.md', 'ledger/tasks/S1-old-title.md')
    commit(r, {}, 'docs: name the S1 file')
    commit(r, { 'src/a.js': '1\n' }, 'feat: a', 'Task: S1')
    r.git('mv', 'ledger/tasks/S1-old-title.md', 'ledger/tasks/S1-new-title.md')
    commit(r, { 'ledger/tasks/S1-new-title.md': task('S1', 'doing', 'lane-a').replace('Title of S1', 'New title') }, 'docs: retitle S1')
    commit(r, { 'src/b.js': '1\n' }, 'feat: b', 'Task: S1')
    assert.equal(r.git('cat-file', '-e', 'HEAD:ledger/tasks/S1-old-title.md').status, 128)
    assert.deepEqual(check(r, base), [])
  })

  test('the configuration decides what is code and where the tasks are', () => {
    const r = repository()
    const config = parseConfig('{ "version": 2, "dir": "work", "codePaths": ["tools"] }').config
    const base = commit(r, { '.resaledger.json': '{}\n', 'work/tasks/S1.md': task('S1', 'doing', 'main') }, 'chore: set up', 'Task: maintenance')
    commit(r, { 'work/tools/x.mjs': '1\n' }, 'feat: tool', 'Task: S1')
    commit(r, { 'work/notes/x.txt': '1\n' }, 'docs: a note')
    assert.deepEqual(checkRange(base, 'HEAD', { config, lane: 'main', skipGitHubMerges: false, root: r.root }), [])
    commit(r, { 'work/tools/y.mjs': '1\n' }, 'feat: tool y')
    assert.equal(checkRange(base, 'HEAD', { config, lane: 'main', skipGitHubMerges: false, root: r.root }).length, 1)
  })

  test('a revision git does not know is an error with git message', () => {
    const { r } = setup()
    assert.throws(() => check(r, 'no-such-rev'), /git rev-list failed/)
  })
})

describe('checkRange: the exemptions', () => {
  test('a merge commit is skipped; the commits it brings in are checked', () => {
    const { r, base } = setup({ S1: task('S1', 'doing', 'lane-a') })
    r.git('checkout', '-q', '-b', 'side')
    commit(r, { 'src/side.js': '1\n' }, 'feat: side', 'Task: S1')
    r.git('checkout', '-q', 'lane-a')
    commit(r, { 'src/main.js': '1\n' }, 'feat: main', 'Task: S1')
    const merged = r.git('merge', '-q', '--no-ff', '--no-edit', 'side')
    assert.equal(merged.status, 0, merged.out)
    assert.equal(r.git('log', '-1', '--format=%P').out.trim().split(' ').length, 2)
    assert.deepEqual(check(r, base), [])

    r.git('checkout', '-q', '-b', 'side2', 'HEAD~1')
    commit(r, { 'src/side2.js': '1\n' }, 'feat: side2')
    r.git('checkout', '-q', 'lane-a')
    r.git('merge', '-q', '--no-ff', '--no-edit', 'side2')
    assert.deepEqual(
      check(r, base).map((problem) => problem.message.split(' changes')[0]),
      ['"feat: side2"']
    )
  })

  test('a commit made by git revert is skipped', () => {
    const { r, base } = setup({ S1: task('S1', 'doing', 'lane-a') })
    commit(r, { 'src/a.js': '1\n' }, 'feat: a', 'Task: S1')
    const reverted = r.git('revert', '--no-edit', 'HEAD')
    assert.equal(reverted.status, 0, reverted.out)
    assert.match(r.git('log', '-1', '--format=%B').out, /^This reverts commit [0-9a-f]+\.$/m)
    assert.deepEqual(check(r, base), [])
  })

  test('a release subject exempts nothing: a release commit that changes code needs a Task: line', () => {
    const { r, base } = setup()
    commit(r, { 'package.json': '{ "version": "1.2.3" }\n' }, 'Release v1.2.3')
    commit(r, { 'package.json': '{ "version": "1.3.0-rc.1" }\n' }, 'Release v1.3.0-rc.1', 'Task: maintenance')
    assert.deepEqual(
      check(r, base).map((problem) => problem.message.split(' changes')[0]),
      ['"Release v1.2.3"']
    )
    commit(r, { 'CHANGELOG.md': '# 1.3.0\n' }, 'Release v1.3.0')
    assert.equal(check(r, base).length, 1)
  })

  test('a commit GitHub made is skipped only with skipGitHubMerges', () => {
    const { r, base } = setup()
    r.write('src/a.js', '1\n')
    r.git('add', '-A')
    const env = { ...ENV, GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: GITHUB }
    const made = spawnSync('git', ['commit', '-q', '-m', 'Squash of a pull request (#12)'], { cwd: r.root, env, encoding: 'utf8' })
    assert.equal(made.status, 0, made.stderr)
    assert.deepEqual(check(r, base, { skipGitHubMerges: true }), [])
    const problems = check(r, base, { skipGitHubMerges: false })
    assert.equal(problems.length, 1)
    assert.match(problems[0].message, /^"Squash of a pull request \(#12\)" changes code but names no task/)
    // Only the committer counts: an author at GitHub is not GitHub merging.
    const authored = spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'x'], { cwd: r.root, env: ENV, encoding: 'utf8' })
    assert.equal(authored.status, 0)
    r.write('src/b.js', '1\n')
    r.git('add', '-A')
    const byAuthor = spawnSync('git', ['commit', '-q', '-m', 'feat: b'], {
      cwd: r.root,
      env: { ...ENV, GIT_AUTHOR_EMAIL: GITHUB },
      encoding: 'utf8'
    })
    assert.equal(byAuthor.status, 0)
    assert.deepEqual(
      check(r, base, { skipGitHubMerges: true }).map((problem) => problem.message.split(' changes')[0]),
      ['"feat: b"']
    )
  })
})

/** Commits the staged tree with a message taken verbatim from a file, with no hooks. */
function commitFile(r, files, message) {
  for (const [path, text] of Object.entries(files)) r.write(path, text)
  r.git('add', '-A')
  r.write('.git/RANGE_MSG', message)
  const committed = r.git('commit', '-q', '--no-verify', '--cleanup=verbatim', '-F', '.git/RANGE_MSG')
  assert.equal(committed.status, 0, committed.out)
  return head(r)
}

describe('checkRange: what a message cannot fake', () => {
  test('a message with the byte 0x01 does not hide a code commit', () => {
    const { r, base } = setup()
    commitFile(r, { 'src/evil.js': '1\n' }, 'feat: hide me\n\n\x01')
    assert.match(r.git('cat-file', 'commit', 'HEAD').out, /\x01/)
    const problems = check(r, base)
    assert.equal(problems.length, 1)
    assert.equal(problems[0].file, short(r))
    assert.match(problems[0].message, /^"feat: hide me" changes code but names no task/)
  })

  test('a message that imitates the next commit record is read as a message', () => {
    const { r, base } = setup({ S1: task('S1', 'doing', 'lane-a') })
    const forged = `feat: forged\n\n\x01${base}\x00${base.slice(0, 7)}\x00\x00x\x00Task: S1\n\x00\x01\nTask: S1x\n`
    commitFile(r, { 'src/evil.js': '1\n' }, forged.replace(/\x00/g, ' '))
    commitFile(r, { 'src/fine.js': '1\n' }, 'feat: fine\n\n\x01\nTask: S1\n')
    assert.deepEqual(
      check(r, base).map((problem) => problem.message),
      ['"feat: forged" has "S1x" in its Task: trailer, which is not a task id. Write ids such as S4 or S4.1, separated by commas, or "maintenance" in lowercase']
    )
  })

  test('an evil merge, with code neither side changed, needs its own Task: line', () => {
    const { r, base } = setup({ S1: task('S1', 'doing', 'lane-a') })
    r.git('checkout', '-q', '-b', 'side')
    commit(r, { 'docs/side.md': '1\n' }, 'docs: side')
    r.git('checkout', '-q', 'lane-a')
    assert.equal(r.git('merge', '-q', '--no-ff', '--no-commit', 'side').status, 0)
    r.write('src/evil.js', '1\n')
    r.git('add', '-A')
    assert.equal(r.git('commit', '-q', '--no-verify', '-m', 'Merge branch side').status, 0)
    const problems = check(r, base)
    assert.equal(problems.length, 1)
    assert.equal(problems[0].file, short(r))
    assert.match(problems[0].message, /^"Merge branch side" is a merge that changes code neither side changed \(src\/evil\.js\), but names no task/)
    // With a Task: line it is a code commit like any other.
    assert.equal(r.git('commit', '-q', '--amend', '--no-verify', '-m', 'Merge branch side', '-m', 'Task: S1').status, 0)
    assert.deepEqual(check(r, base), [])
  })

  test("a merge that drops one side's change to code is not exempt either", () => {
    const { r, base } = setup()
    commit(r, { 'src/a.js': '1\n' }, 'feat: a', 'Task: maintenance')
    const start = head(r)
    r.git('checkout', '-q', '-b', 'side')
    commit(r, { 'src/a.js': '2\n' }, 'feat: a2', 'Task: maintenance')
    r.git('checkout', '-q', 'lane-a')
    commit(r, { 'docs/x.md': '1\n' }, 'docs: x')
    assert.equal(r.git('merge', '-q', '--no-ff', '--no-commit', 'side').status, 0)
    r.write('src/a.js', '1\n')
    r.git('add', '-A')
    assert.equal(r.git('commit', '-q', '--no-verify', '-m', 'Merge branch side').status, 0)
    assert.match(check(r, start)[0].message, /^"Merge branch side" is a merge that changes code neither side changed \(src\/a\.js\)/)
    assert.equal(check(r, base).length, 1)
  })

  test('a merge that resolves a conflict in code both sides changed is exempt', () => {
    const { r, base } = setup({ S1: task('S1', 'doing', 'lane-a') })
    commit(r, { 'src/a.js': '0\n' }, 'feat: a', 'Task: S1')
    r.git('checkout', '-q', '-b', 'side')
    commit(r, { 'src/a.js': 'side\n', 'src/side.js': '1\n' }, 'feat: side', 'Task: S1')
    r.git('checkout', '-q', 'lane-a')
    commit(r, { 'src/a.js': 'main\n' }, 'feat: main', 'Task: S1')
    assert.notEqual(r.git('merge', '-q', 'side').status, 0)
    r.write('src/a.js', 'main and side\n')
    r.git('add', '-A')
    assert.equal(r.git('commit', '-q', '--no-verify', '--no-edit').status, 0)
    assert.equal(r.git('log', '-1', '--format=%P').out.trim().split(' ').length, 2)
    assert.deepEqual(check(r, base), [])
  })

  test('a merge of unrelated histories is judged against everything each side holds', () => {
    const { r, base } = setup()
    r.git('checkout', '-q', '--orphan', 'other')
    r.git('rm', '-rq', '--cached', '.')
    r.git('clean', '-fdq')
    commit(r, { 'src/other.js': '1\n' }, 'feat: other', 'Task: maintenance')
    r.git('checkout', '-q', 'lane-a')
    assert.equal(r.git('merge', '-q', '--no-ff', '--no-edit', '--allow-unrelated-histories', 'other').status, 0)
    assert.deepEqual(check(r, base), [])
  })

  test('a "This reverts commit" line exempts only a real revert of an ancestor', () => {
    const { r, base } = setup({ S1: task('S1', 'doing', 'lane-a') })
    const added = commit(r, { 'src/a.js': '1\n2\n' }, 'feat: a', 'Task: S1')
    // A fake revert: the line names a real ancestor, but the change is not its inverse.
    commit(r, { 'src/evil.js': '1\n' }, 'feat: sneak', `This reverts commit ${added}.`)
    // A line that names no commit, and one that names a commit outside the history.
    commit(r, { 'src/evil2.js': '1\n' }, 'feat: sneak 2', 'This reverts commit 0123456.')
    r.git('checkout', '-q', '-b', 'elsewhere', base)
    const elsewhere = commit(r, { 'src/e.js': '1\n' }, 'feat: e', 'Task: maintenance')
    r.git('checkout', '-q', 'lane-a')
    r.git('rm', '-q', 'src/evil2.js')
    commit(r, {}, 'chore: drop evil2', `This reverts commit ${elsewhere}.`)
    assert.deepEqual(
      check(r, base).map((problem) => problem.message.split(' changes')[0]),
      ['"feat: sneak"', '"feat: sneak 2"', '"chore: drop evil2"']
    )
  })

  test('a real git revert is exempt, also of an older commit and with a reworded message', () => {
    const { r, base } = setup({ S1: task('S1', 'doing', 'lane-a') })
    commit(r, { 'src/a.js': '1\n' }, 'feat: a', 'Task: S1')
    commit(r, { 'src/b.js': '1\n' }, 'feat: b', 'Task: S1')
    assert.equal(r.git('revert', '--no-edit', 'HEAD~1').status, 0)
    assert.equal(r.git('revert', '--no-commit', 'HEAD~1').status, 0)
    const reverted = head(r, 'HEAD~1')
    assert.equal(r.git('commit', '-q', '-m', 'Bring b back out', '-m', `This reverts commit ${reverted}.`).status, 0)
    assert.deepEqual(check(r, base), [])
    // A real revert with one more change in it is not a revert.
    assert.equal(r.git('revert', '--no-commit', 'HEAD').status, 0)
    r.write('src/extra.js', '1\n')
    r.git('add', '-A')
    assert.equal(r.git('commit', '-q', '-m', 'Revert again', '-m', `This reverts commit ${head(r)}.`).status, 0)
    assert.equal(check(r, base).length, 1)
  })

  test('a whitespace change hidden in a revert is not a revert, where git has patch-id --verbatim', (t) => {
    const { r, base } = setup({ S1: task('S1', 'doing', 'lane-a') })
    commit(r, { 'src/a.py': 'if x:\n    y()\n    w()\n' }, 'feat: a', 'Task: S1')
    const dropped = commit(r, { 'src/a.py': 'if x:\n    w()\n' }, 'feat: drop y', 'Task: S1')
    // The inverse, with y() moved out of the if: whitespace-blind patch ids would match.
    commit(r, { 'src/a.py': 'if x:\ny()\n    w()\n' }, 'Revert "feat: drop y"', `This reverts commit ${dropped}.`)
    if (r.run('git', ['patch-id', '--verbatim'], '').status !== 0) {
      t.skip('this git has no patch-id --verbatim')
      return
    }
    assert.deepEqual(
      check(r, base).map((problem) => problem.message.split(' changes')[0]),
      ['"Revert "feat: drop y""']
    )
  })
})

describe('checkRange: speed', () => {
  test('a range of 200 code commits that name a task is checked within 3 seconds', () => {
    const { r, base } = setup({ S1: task('S1', 'doing', 'lane-a'), S2: task('S2', 'doing', 'lane-a') })
    // fast-import writes the 200 commits in one process.
    let stream = ''
    for (let index = 1; index <= 200; index += 1) {
      const message = `feat: step ${index}\n\nTask: S1, S2\n`
      const content = `export const step = ${index}\n`
      stream += `commit refs/heads/lane-a\ncommitter Test <test@example.com> ${1700000000 + index} +0000\n`
      stream += `data ${Buffer.byteLength(message)}\n${message}`
      if (index === 1) stream += `from ${base}\n`
      stream += `M 100644 inline src/step${index % 20}.js\ndata ${Buffer.byteLength(content)}\n${content}\n`
    }
    const imported = run(r.root, 'git', ['fast-import', '--quiet', '--force'], stream)
    assert.equal(imported.status, 0, imported.out)
    assert.equal(r.git('rev-list', '--count', `${base}..lane-a`).out.trim(), '200')

    const started = process.hrtime.bigint()
    const problems = check(r, base, { to: 'lane-a' })
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6
    assert.deepEqual(problems, [])
    assert.ok(elapsed < budget(3000), `200 commits took ${Math.round(elapsed)} ms`)
    console.log(`# checkRange: 200 commits in ${Math.round(elapsed)} ms`)
  })
})

describe('check --range through the bundle', () => {
  const guard = join(temporary(), 'records.mjs')
  const VALID = {
    '.resaledger.json': '{\n  "version": 2\n}\n',
    'ledger/README.md': '# Project\n\n## Goal\n\nA small app.\n\n## Environments\n\nLocal only.\n\n## Manual checks\n\nNone.\n',
    'ledger/plan/S-server.md': '# S — Server\n\nStatus: approved · 2026-10-14 · by the owner\n\n## S1 Start\n\nGoal: start.\n',
    'ledger/tasks/S1-start.md': '# S1 Start\n\n- Status: todo\n- Plan: [S-server.md](../plan/S-server.md#s1-start)\n'
  }
  const DOING = '# S1 Start\n\n- Status: doing\n- Lane: lane-a\n- Plan: [S-server.md](../plan/S-server.md#s1-start)\n\n## Handoff\n\nStarted.\n'

  test('the bundle builds', () => {
    const built = run(PACKAGE, process.execPath, [join(PACKAGE, 'scripts', 'bundle.mjs'), '--out', guard])
    assert.equal(built.status, 0, built.out)
  })

  test('passes on recorded commits and fails on an unrecorded one, with the lane from the branch', () => {
    const r = repository()
    const base = commit(r, VALID, 'chore: set up', 'Task: maintenance')
    r.git('checkout', '-q', '-b', 'lane-a')
    commit(r, { 'src/a.js': '1\n', 'ledger/tasks/S1-start.md': DOING }, 'feat: a', 'Task: S1')
    const passed = r.node(guard, 'check', '--range', `${base}..HEAD`)
    assert.equal(passed.status, 0, passed.out)
    assert.match(passed.out, /^✔ records valid: 1 tasks/)
    assert.match(passed.out, /✔ commits recorded: [0-9a-f]+\.\.HEAD \(lane lane-a\)\n$/)
    assert.equal(r.node(guard, 'check', '--range', `${base}..`).status, 0)

    commit(r, { 'src/b.js': '1\n' }, 'feat: b')
    const failed = r.node(guard, 'check', '--range', `${base}..HEAD`)
    assert.equal(failed.status, 1)
    assert.match(failed.out, new RegExp(`✖ ${short(r)}: "feat: b" changes code but names no task`))

    // Another lane holds S1 at the range start; a detached HEAD has no lane, so only that rule is skipped.
    const claimed = head(r, 'HEAD~1')
    r.git('checkout', '-q', '-b', 'lane-b', claimed)
    commit(r, { 'src/c.js': '1\n' }, 'feat: c', 'Task: S1')
    assert.match(r.node(guard, 'check', '--range', `${claimed}..HEAD`).out, /names task S1, which is held by lane "lane-a" before this range, not by "lane-b"/)
    r.git('checkout', '-q', '--detach', 'HEAD')
    const detached = r.node(guard, 'check', '--range', `${claimed}..HEAD`)
    assert.equal(detached.status, 0, detached.out)
    assert.match(detached.out, /\(detached HEAD: no lane rule\)/)
  })

  test('refuses a malformed range and reports an unknown revision', () => {
    const r = repository()
    commit(r, VALID, 'chore: set up', 'Task: maintenance')
    assert.match(r.node(guard, 'check', '--range').out, /--range needs two revisions/)
    assert.match(r.node(guard, 'check', '--range', 'HEAD').out, /--range needs two revisions/)
    assert.match(r.node(guard, 'check', '--range', 'main...HEAD').out, /--range needs two revisions/)
    const unknown = r.node(guard, 'check', '--range', 'nope..HEAD')
    assert.equal(unknown.status, 1)
    assert.match(unknown.out, /git rev-list failed/)
  })
})
