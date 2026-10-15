// pre-push: real repositories with the bundled guard and the rendered hooks, pushed through
// git to a bare repository, so that the pushed refs and object ids are git's own.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { HOOK_NAMES, renderHook } from '../src/cli/hooks.mjs'
import { ENV, PACKAGE, repository, run, temporary } from './helpers.mjs'

const GUARD = join(temporary(), 'records.mjs')
const built = run(PACKAGE, process.execPath, [join(PACKAGE, 'scripts', 'bundle.mjs'), '--out', GUARD])
if (built.status !== 0) throw new Error(`bundle failed: ${built.out}`)

const README = `# Bakery shop

## Goal

Build a small web shop for local bakers.

## Environments

Local only.

## Manual checks

None.
`

const REFUSED = /✖ This push is refused/

/** A task file, valid for its status. */
function taskFile(id, title, fields = {}) {
  const { status = 'todo', lane } = fields
  const lines = [`# ${id} ${title}`, '', `- Status: ${status}`]
  if (lane) lines.push(`- Lane: ${lane}`)
  if (status === 'doing') lines.push('', '## Plan', '', 'Do the thing and test it.')
  return `${lines.join('\n')}\n`
}

/** Writes the hooks, the guard, a configuration, a README and the tasks. */
function install(r, config, tasks) {
  for (const name of HOOK_NAMES) {
    r.write(`.githooks/${name}`, renderHook(name, 'ledger'))
    chmodSync(join(r.root, '.githooks', name), 0o755)
  }
  r.write('ledger/scripts/records.mjs', readFileSync(GUARD, 'utf8'))
  r.write('.resaledger.json', `${JSON.stringify({ version: 2, ...config }, null, 2)}\n`)
  r.write('ledger/README.md', README)
  for (const [id, title, fields] of tasks) task(r, id, title, fields)
}

/**
 * A repository with a bare remote: the workspace committed on main with the hooks off (and,
 * with history, earlier code commits made before ResaLedger), then the hooks turned on.
 * main is pushed unless push is false.
 */
function workspace({ config = {}, tasks = [['S1', 'Bake bread']], history = false, push = true } = {}) {
  const r = repository()
  r.remote()
  if (history) {
    r.write('src/old.js', 'console.log("old")\n')
    must(r.commit('add the old shop'))
    r.write('src/old.js', 'console.log("older")\n')
    must(r.commit('tweak the old shop'))
  }
  install(r, config, tasks)
  must(r.commit('chore: start'))
  r.git('config', 'core.hooksPath', '.githooks')
  if (push) must(r.push('main'))
  return r
}

function must(result) {
  assert.equal(result.status, 0, result.out)
  return result
}

function task(r, id, title, fields) {
  r.write(`ledger/tasks/${id}.md`, taskFile(id, title, fields))
}

/** A lane branch that claims S1, then commits code naming it. */
function lane(r, name = 'lane') {
  r.git('checkout', '-q', '-b', name)
  task(r, 'S1', 'Bake bread', { status: 'doing', lane: name })
  must(r.commit('chore: claim S1'))
  r.write('src/app.js', 'console.log(1)\n')
  must(r.commit('feat: app', 'Task: S1'))
}

/** A code commit without a trailer, made with --no-verify. */
function unrecorded(r, file = 'src/sneak.js') {
  r.write(file, `console.log(${Math.random()})\n`)
  r.git('add', '-A')
  must(r.git('commit', '-q', '--no-verify', '-m', 'feat: sneak'))
  return r.git('log', '-1', '--format=%h').out.trim()
}

function refused(result, pattern) {
  assert.notEqual(result.status, 0, result.out)
  assert.match(result.out, REFUSED)
  assert.match(result.out, pattern)
}

function passed(result) {
  assert.equal(result.status, 0, result.out)
  assert.doesNotMatch(result.out, /✖/)
}

test('a push to a protected branch is refused', () => {
  const r = workspace({ config: { protected: ['release'] } })
  lane(r)
  refused(r.push('lane:release'), /release: "release" is a protected branch, so nothing is pushed to it directly/)
})

test('deleting a protected branch is refused', () => {
  const r = workspace({ config: { protected: ['release'] } })
  // The remote has the branch already, made there rather than pushed.
  const head = r.git('rev-parse', 'main').out.trim()
  must(run(join(r.base, 'remote.git'), 'git', ['update-ref', 'refs/heads/release', head]))
  refused(r.push(':release'), /release: "release" is a protected branch, so it is not deleted/)
  must(run(join(r.base, 'remote.git'), 'git', ['update-ref', 'refs/heads/old', head]))
  passed(r.push(':old'))
})

test('a commit made with --no-verify and no trailer is refused when it is pushed', () => {
  const r = workspace()
  lane(r)
  passed(r.push('lane'))
  const sneak = unrecorded(r)
  refused(r.push('lane'), new RegExp(`lane: ${sneak}: "feat: sneak" changes code but names no task`))
})

test('a new branch is judged on its own commits, from the merge base with the remote base', () => {
  const r = workspace()
  // main's own first commit changes code without a trailer, but the remote has it.
  lane(r)
  passed(r.push('-u', 'lane'))
  r.git('checkout', '-q', '-b', 'second')
  const sneak = unrecorded(r)
  const result = r.push('second')
  refused(result, new RegExp(`second: ${sneak}: "feat: sneak"`))
  assert.doesNotMatch(result.out, /chore: start|feat: app/)
})

test('a new branch to a remote without the base starts from the local base', () => {
  const r = workspace({ push: false })
  lane(r)
  passed(r.push('lane'))
})

test("an adopted project's history before ResaLedger is not judged", () => {
  const r = workspace({ history: true, push: false })
  passed(r.push('main'))
  const sneak = unrecorded(r)
  refused(r.push('main'), new RegExp(`main: ${sneak}: "feat: sneak"`))
})

test('a range that starts before adoption starts at the commit that added the configuration', () => {
  // The remote's main predates ResaLedger; a branch adopts it, so the merge base is older.
  const r = repository()
  r.remote()
  r.write('src/old.js', 'console.log("old")\n')
  must(r.commit('add the old shop'))
  must(r.push('main'))
  r.git('checkout', '-q', '-b', 'adopt')
  install(r, {}, [['S1', 'Bake bread']])
  must(r.commit('chore: start'))
  r.git('config', 'core.hooksPath', '.githooks')
  passed(r.push('adopt'))
  const sneak = unrecorded(r)
  refused(r.push('adopt'), new RegExp(`adopt: ${sneak}: "feat: sneak"`))
})

test("a task another lane holds before the push is refused, with the local branch as the lane", () => {
  const r = workspace({ tasks: [['S1', 'Bake bread', { status: 'doing', lane: 'other' }]] })
  r.git('checkout', '-q', '-b', 'mine')
  r.write('src/app.js', 'console.log(1)\n')
  r.git('add', '-A')
  must(r.git('commit', '-q', '--no-verify', '-m', 'feat: app', '-m', 'Task: S1'))
  refused(r.push('mine:elsewhere'), /elsewhere: [0-9a-f]+: "feat: app" names task S1, which is held by lane "other" before this range, not by "mine"/)
})

test('from a detached HEAD the remote branch is the lane; tags are skipped', () => {
  const r = workspace()
  lane(r)
  r.git('checkout', '-q', '--detach')
  passed(r.push('HEAD:refs/heads/lane'))
  r.git('tag', 'v0.1.0')
  passed(r.push('v0.1.0'))
})

test("the pre-commit framework's variables stand in for an empty stdin", () => {
  const r = workspace()
  lane(r)
  passed(r.push('lane'))
  const sneak = unrecorded(r)
  const local = r.git('rev-parse', 'lane').out.trim()
  const remote = r.git('rev-parse', 'origin/lane').out.trim()
  const hook = (variables) => spawnHook(r, variables)
  const variables = {
    PRE_COMMIT_FROM_REF: remote,
    PRE_COMMIT_TO_REF: local,
    PRE_COMMIT_REMOTE_NAME: 'origin',
    PRE_COMMIT_REMOTE_URL: join(r.base, 'remote.git'),
    PRE_COMMIT_REMOTE_BRANCH: 'refs/heads/lane',
    PRE_COMMIT_LOCAL_BRANCH: 'refs/heads/lane'
  }
  refused(hook(variables), new RegExp(`lane: ${sneak}: "feat: sneak"`))
  // A new branch, as the framework reports it when it found no commit on the remote.
  const { PRE_COMMIT_FROM_REF, PRE_COMMIT_TO_REF, ...newBranch } = variables
  refused(hook({ ...newBranch, PRE_COMMIT_REMOTE_BRANCH: 'refs/heads/fresh' }), new RegExp(`fresh: ${sneak}`))
  passed(hook({ ...variables, PRE_COMMIT_TO_REF: remote }))
  // Without the variables and without stdin there is nothing to check.
  passed(spawnHook(r, {}))
})

/** Runs the guard's pre-push with empty stdin and extra environment variables. */
function spawnHook(r, variables) {
  const result = spawnSync(process.execPath, ['ledger/scripts/records.mjs', 'pre-push'], {
    cwd: r.root,
    env: { ...ENV, ...variables },
    encoding: 'utf8',
    input: ''
  })
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

/** A team workspace whose main reached the remote past the hooks, as an administrator would set it up. */
function teamWorkspace() {
  const r = workspace({ config: { preset: 'team' }, push: false })
  must(r.git('push', '-q', '--no-verify', 'origin', 'main'))
  must(r.fetch())
  return r
}

test('a fast-forward merge onto the protected base makes no commit, and pre-push refuses it', () => {
  const r = teamWorkspace()
  const setup = r.git('rev-parse', 'HEAD').out.trim()
  lane(r)
  r.git('checkout', '-q', 'main')
  must(r.git('merge', '-q', 'lane'))
  assert.notEqual(r.git('rev-parse', 'HEAD').out.trim(), setup, 'main moved without a commit hook')
  refused(r.push('main'), /main: "main" is a protected branch, so nothing is pushed to it directly, not even a fast-forward merge, which no commit hook sees/)
})

test("a pushed configuration does not lift the remote base's protection", () => {
  const r = teamWorkspace()
  // A lane may commit a looser configuration; it never judges the push that carries it.
  r.git('checkout', '-q', '-b', 'loosen')
  r.write('.resaledger.json', '{ "version": 2, "preset": "team", "protected": [], "gates": { "commit": [], "verify": [] } }\n')
  r.write('evil.js', 'evil\n')
  must(r.commit('chore: loosen', 'Task: maintenance'))
  r.git('checkout', '-q', 'main')
  must(r.git('merge', '-q', 'loosen'))
  refused(r.push('main'), /main: "main" is a protected branch/)
  refused(r.push('loosen:main'), /main: "main" is a protected branch/)
})

test('without a remote base, the rules are local HEAD\'s', () => {
  const r = workspace({ config: { protected: ['release'] }, push: false })
  r.git('checkout', '-q', '-b', 'loosen')
  r.write('.resaledger.json', '{ "version": 2, "protected": [] }\n')
  must(r.commit('chore: loosen', 'Task: maintenance'))
  r.git('checkout', '-q', 'main')
  refused(r.push('loosen:release'), /release: "release" is a protected branch/)
})

test('a pushed commit without a configuration is judged by the rules, never skipped', () => {
  const r = workspace()
  r.git('checkout', '-q', '-b', 'lane')
  r.git('rm', '-q', '.resaledger.json')
  r.write('src/sneak.js', 'console.log(1)\n')
  r.git('add', '-A')
  must(r.git('commit', '-q', '--no-verify', '-m', 'feat: sneak'))
  const sneak = r.git('log', '-1', '--format=%h').out.trim()
  refused(r.push('lane'), new RegExp(`lane: ${sneak}: "feat: sneak" changes code but names no task`))
})

test('a push with no configuration anywhere is refused', () => {
  const r = workspace({ push: false })
  r.git('checkout', '-q', '--orphan', 'bare')
  r.git('rm', '-q', '-r', '--cached', '.')
  r.write('.gitignore', '*\n')
  r.git('add', '-f', '.gitignore')
  must(r.git('commit', '-q', '--no-verify', '-m', 'start'))
  refused(r.push('bare'), /bare: the pushed commit has no \.resaledger\.json, and neither has HEAD, so there are no rules to judge it by/)
})

// Git LFS: a stand-in git-lfs first on PATH records each pre-push call (its arguments and its
// input) and exits with a chosen code; "git lfs" runs it from PATH as it would the real one.
describe('Git LFS', { skip: process.platform === 'win32' && 'the stand-in git-lfs and the git wrapper are sh scripts' }, () => {
  const ZERO = '0'.repeat(40)

  /** A folder with a stand-in git-lfs that logs to log and exits with code from pre-push. */
  function standIn(code = 0) {
    const bin = temporary('resaledger-lfs-')
    const log = join(bin, 'calls.log')
    const script = `#!/bin/sh
if [ "$1" = version ]; then echo "git-lfs/0.0.0 (stand-in)"; exit 0; fi
{ printf 'args:'; for arg in "$@"; do printf ' %s' "$arg"; done; printf '\\n'; cat; } >> '${log}'
echo "stand-in git-lfs ran" >&2
exit ${code}
`
    writeFileSync(join(bin, 'git-lfs'), script, { mode: 0o755 })
    return { bin, log, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('args: ').slice(1) : []) }
  }

  /** git push with the given PATH, through the hooks. */
  function pushWith(r, path, ...args) {
    const result = spawnSync('git', ['push', '-q', 'origin', ...args], { cwd: r.root, env: { ...ENV, PATH: path }, encoding: 'utf8' })
    return { status: result.status, out: `${result.stdout}${result.stderr}` }
  }

  /** A workspace with a lane whose last commit adds a .gitattributes at file. */
  function lfsLane(attributes = '*.psd filter=lfs diff=lfs merge=lfs -text\n', file = '.gitattributes') {
    const r = workspace()
    lane(r)
    r.write(file, attributes)
    must(r.commit('chore: track images', 'Task: S1'))
    return r
  }

  test('a push in a repository with filter=lfs runs git lfs pre-push once, with the remote, the URL and the refs', () => {
    const r = lfsLane()
    const lfs = standIn()
    passed(pushWith(r, `${lfs.bin}:${process.env.PATH}`, 'lane'))
    const calls = lfs.calls()
    assert.equal(calls.length, 1, calls.join('---'))
    const head = r.git('rev-parse', 'lane').out.trim()
    assert.equal(calls[0], `pre-push origin ${join(r.base, 'remote.git')}\nrefs/heads/lane ${head} refs/heads/lane ${ZERO}\n`)
  })

  test('a .gitattributes in a folder counts too', () => {
    const r = lfsLane('*.bin filter=lfs diff=lfs merge=lfs -text\n', 'assets/.gitattributes')
    const lfs = standIn()
    passed(pushWith(r, `${lfs.bin}:${process.env.PATH}`, 'lane'))
    assert.equal(lfs.calls().length, 1)
  })

  test('a push the guard refuses runs nothing of Git LFS', () => {
    const r = lfsLane()
    const sneak = unrecorded(r)
    const lfs = standIn()
    refused(pushWith(r, `${lfs.bin}:${process.env.PATH}`, 'lane'), new RegExp(`lane: ${sneak}: "feat: sneak" changes code but names no task`))
    assert.deepEqual(lfs.calls(), [])
  })

  test('a repository without filter=lfs does not run it', () => {
    const r = lfsLane('*.sh text eol=lf\n# not filter=lfs\n')
    const lfs = standIn()
    passed(pushWith(r, `${lfs.bin}:${process.env.PATH}`, 'lane'))
    assert.deepEqual(lfs.calls(), [])
  })

  test('a failing git lfs pre-push fails the push, and its output reaches the user', () => {
    const r = lfsLane()
    const lfs = standIn(2)
    const result = pushWith(r, `${lfs.bin}:${process.env.PATH}`, 'lane')
    assert.notEqual(result.status, 0, result.out)
    assert.match(result.out, /stand-in git-lfs ran/)
    assert.equal(lfs.calls().length, 1)
    assert.equal(r.git('ls-remote', 'origin', 'refs/heads/lane').out.trim(), '')
  })

  test('without git-lfs on the PATH, a push in a repository with filter=lfs is refused with the advice', () => {
    const r = lfsLane()
    // A PATH with git and node only: git through a wrapper, since git-lfs often sits next to it.
    const bin = temporary('resaledger-nolfs-')
    const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nexec '${real}' "$@"\n`, { mode: 0o755 })
    writeFileSync(join(bin, 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 })
    const result = pushWith(r, bin, 'lane')
    refused(result, /this repository uses Git LFS \(a \.gitattributes file names filter=lfs\), but git-lfs was not found on your PATH/)
    assert.match(result.out, /git lfs pre-push/)
    assert.equal(r.git('ls-remote', 'origin', 'refs/heads/lane').out.trim(), '')
  })
})
