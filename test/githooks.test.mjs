// The git hooks: the rendered scripts, that git runs them and they reach the guard, finding
// a runtime, turning the hooks on, and adding the guard's calls to hook managers.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import { detectHookManager, HOOK_NAMES, integrateHookManager, renderHook } from '../src/cli/hooks.mjs'
import { activateHooks, hooksActive } from '../src/guard/githooks.mjs'
import { ENV, PACKAGE, repository, run, temporary } from './helpers.mjs'

const GUARD = join(temporary(), 'records.mjs')
const built = run(PACKAGE, process.execPath, [join(PACKAGE, 'scripts', 'bundle.mjs'), '--out', GUARD])
if (built.status !== 0) throw new Error(`bundle failed: ${built.out}`)

// A stand-in guard that records how the hook called it: arguments, stdin and runtime.
const RECORDER = `import { appendFileSync, readFileSync } from 'node:fs'
const stdin = process.argv[2] === 'pre-push' ? readFileSync(0, 'utf8') : ''
appendFileSync('hook-calls.log', JSON.stringify({ args: process.argv.slice(2), stdin, runtime: process.execPath }) + '\\n')
process.exit(Number(process.env.RECORDER_EXIT ?? 0))
`

/** Installs the rendered hooks in .githooks/ and a guard at <dir>/scripts/records.mjs. */
function install(r, guard = readFileSync(GUARD, 'utf8'), dir = 'ledger') {
  for (const name of HOOK_NAMES) {
    r.write(`.githooks/${name}`, renderHook(name, dir))
    chmodSync(join(r.root, '.githooks', name), 0o755)
  }
  r.write(`${dir}/scripts/records.mjs`, guard)
  r.write('.gitignore', 'hook-calls.log\n')
}

function calls(r) {
  const path = join(r.root, 'hook-calls.log')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

/** Runs a guard function with the current folder set to cwd. */
function inside(cwd, action) {
  const previous = process.cwd()
  const saved = Object.fromEntries(Object.keys(ENV).map((name) => [name, process.env[name]]))
  Object.assign(process.env, ENV)
  process.chdir(cwd)
  try {
    return action()
  } finally {
    process.chdir(previous)
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test('the rendered hooks carry the marker, call the guard in the workspace folder and leave no placeholder', () => {
  for (const name of HOOK_NAMES) {
    for (const dir of ['ledger', 'tools/ledger']) {
      const text = renderHook(name, dir)
      assert.ok(!text.includes('{{'), `${name} still holds a placeholder`)
      const lines = text.split('\n')
      assert.equal(lines[0], '#!/bin/sh')
      assert.equal(lines[1], `# resaledger: ${name} hook, managed by ResaLedger; do not edit`)
      assert.match(text, new RegExp(`exec "\\$runtime" "${dir}/scripts/records\\.mjs" ${name}`))
    }
  }
  assert.match(renderHook('commit-msg', 'ledger'), /commit-msg "\$1"\n$/)
  assert.match(renderHook('pre-push', 'ledger'), /pre-push "\$@"\n$/)
  assert.throws(() => renderHook('post-merge', 'ledger'), /unknown hook/)
})

test('the hook templates are POSIX sh without bash-only syntax', () => {
  for (const name of HOOK_NAMES) {
    const text = readFileSync(join(PACKAGE, 'templates', 'hooks', name), 'utf8')
    assert.ok(!text.includes('\r'), `${name} has CRLF line endings`)
    for (const bashism of ['[[', 'function ', 'local ', '$(<', '<<<', 'source ', '${!', 'declare '])
      assert.ok(!text.includes(bashism), `${name} uses ${bashism}`)
    const checked = run(PACKAGE, 'sh', ['-n', join(PACKAGE, 'templates', 'hooks', name)])
    assert.equal(checked.status, 0, checked.out)
  }
})

test('git runs the hooks on commit and push, and they pass git\'s arguments and stdin to the guard', () => {
  const r = repository()
  install(r, RECORDER)
  r.git('config', 'core.hooksPath', '.githooks')
  const committed = r.commit('chore: start')
  assert.equal(committed.status, 0, committed.out)
  const [preCommit, commitMsg] = calls(r)
  assert.deepEqual(preCommit.args, ['pre-commit'])
  assert.deepEqual(commitMsg.args, ['commit-msg', '.git/COMMIT_EDITMSG'])

  const remote = r.remote()
  const pushed = r.push('main')
  assert.equal(pushed.status, 0, pushed.out)
  const prePush = calls(r)[2]
  assert.deepEqual(prePush.args, ['pre-push', 'origin', remote])
  const head = r.git('rev-parse', 'HEAD').out.trim()
  assert.match(prePush.stdin, new RegExp(`^refs/heads/main ${head} refs/heads/main 0{40}\\n$`))
})

test('a hook that the guard refuses stops the commit', () => {
  const r = repository()
  install(r, RECORDER.replace("process.env.RECORDER_EXIT ?? 0", '3'))
  r.git('config', 'core.hooksPath', '.githooks')
  const committed = r.commit('chore: start')
  assert.notEqual(committed.status, 0)
  assert.equal(r.git('rev-parse', '--verify', '-q', 'HEAD').status, 1, 'no commit was made')
})

test('the hooks reach the bundled guard, which accepts the commit and the push', () => {
  const r = repository()
  install(r)
  // pre-commit checks the records, so the commit carries a valid workspace.
  r.write('.resaledger.json', '{ "version": 2 }\n')
  r.write('ledger/README.md', '# Shop\n\n## Goal\n\nSell bread.\n\n## Environments\n\nLocal only.\n\n## Manual checks\n\nNone.\n')
  r.git('config', 'core.hooksPath', '.githooks')
  const committed = r.commit('chore: start', 'Task: maintenance')
  assert.equal(committed.status, 0, committed.out)
  r.remote()
  const pushed = r.push('main')
  assert.equal(pushed.status, 0, pushed.out)

  const guard = join(r.root, 'ledger', 'scripts', 'records.mjs')
  assert.equal(r.node(guard, 'pre-commit').status, 0)
  assert.equal(r.node(guard, 'commit-msg', '.git/COMMIT_EDITMSG').status, 0)
  assert.equal(r.run(process.execPath, [guard, 'pre-push', 'origin', 'url'], 'refs/heads/main a refs/heads/main b\n').status, 0)
  const missing = r.node(guard, 'commit-msg')
  assert.equal(missing.status, 1)
  assert.match(missing.out, /commit-msg needs the message file/)
  assert.match(r.node(guard, 'help').out, /hooks \[--activate\]/)
})

test('a hook finds node when PATH holds only the system folders and the folder of node', () => {
  const r = repository()
  install(r, RECORDER)
  const nodeFolder = dirname(process.execPath)
  const system =
    process.platform === 'win32'
      ? (process.env.PATH ?? '')
          .split(delimiter)
          .filter((folder) => folder !== '' && !['node.exe', 'bun.exe'].some((file) => existsSync(join(folder, file))))
      : ['/usr/bin', '/bin']
  const env = { ...ENV, PATH: [...system, nodeFolder].join(delimiter), HOME: temporary() }
  const shell = process.platform === 'win32' ? 'sh' : '/bin/sh'
  const result = spawn(r.root, shell, ['.githooks/pre-commit'], env)
  assert.equal(result.status, 0, result.out)
  const [call] = calls(r)
  assert.deepEqual(call.args, ['pre-commit'])
  assert.equal(realpathSync(call.runtime), realpathSync(process.execPath))
})

const FALLBACKS = ['/opt/homebrew/bin/node', '/usr/local/bin/node']
const noFallback = process.platform !== 'win32' && !FALLBACKS.some((path) => existsSync(path))

test('without node on PATH, a hook takes the newest Node that nvm installed', { skip: !noFallback && 'a fixed fallback path holds node here' }, () => {
  const r = repository()
  install(r, RECORDER)
  const home = temporary()
  for (const version of ['9.9.9', '20.10.2', '20.9.0', '18.20.4']) {
    const path = join(home, '.nvm', 'versions', 'node', `v${version}`, 'bin', 'node')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `#!/bin/sh\necho "v${version} $*" > picked.txt\n`, { mode: 0o755 })
  }
  const result = spawn(r.root, '/bin/sh', ['.githooks/commit-msg', 'MSG'], { ...ENV, PATH: '/usr/bin:/bin', HOME: home })
  assert.equal(result.status, 0, result.out)
  assert.equal(r.read('picked.txt'), 'v20.10.2 ledger/scripts/records.mjs commit-msg MSG\n')
})

test('without any runtime, a hook says so in one line and fails', { skip: !noFallback && 'a fixed fallback path holds node here' }, () => {
  const r = repository()
  install(r, RECORDER)
  const result = spawn(r.root, '/bin/sh', ['.githooks/pre-push', 'origin', 'url'], { ...ENV, PATH: '/usr/bin:/bin', HOME: temporary() })
  assert.equal(result.status, 1)
  assert.equal(result.out, 'resaledger: neither node nor bun was found, so this push cannot be checked; install Node 20 or newer\n')
})

/** Runs a command with its own environment and returns its exit status and combined output. */
function spawn(cwd, command, args, env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' })
  if (result.error) throw result.error
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

/** Clones a repository whose main branch holds the installed hooks. */
function freshClone() {
  const r = repository()
  install(r)
  r.commit('chore: add the hooks')
  const remote = r.remote()
  r.push('main')
  const clone = join(r.base, 'clone')
  const cloned = run(r.base, 'git', ['clone', '-q', remote, clone])
  assert.equal(cloned.status, 0, cloned.out)
  return { r, clone }
}

test('a fresh clone has the hooks off; activation turns them on', () => {
  const { clone } = freshClone()
  const guard = join(clone, 'ledger', 'scripts', 'records.mjs')
  assert.equal(inside(clone, hooksActive), false)
  const off = run(clone, process.execPath, [guard, 'hooks'])
  assert.equal(off.status, 1)
  assert.match(off.out, /not active in this clone; run "node ledger\/scripts\/records\.mjs hooks --activate"/)

  assert.equal(inside(clone, activateHooks), 'activated')
  assert.equal(run(clone, 'git', ['config', 'core.hooksPath']).out.trim(), '.githooks')
  assert.equal(inside(clone, hooksActive), true)
  assert.equal(inside(clone, activateHooks), 'active')
  const on = run(clone, process.execPath, [guard, 'hooks'])
  assert.equal(on.status, 0, on.out)
  assert.match(on.out, /✔ the git hooks are active/)
})

test('the hooks command activates the hooks and reports each case', () => {
  const { clone } = freshClone()
  const guard = join(clone, 'ledger', 'scripts', 'records.mjs')
  const first = run(clone, process.execPath, [guard, 'hooks', '--activate'])
  assert.equal(first.status, 0, first.out)
  assert.match(first.out, /✔ git hooks turned on: core\.hooksPath is \.githooks/)
  const again = run(clone, process.execPath, [guard, 'hooks', '--activate'])
  assert.equal(again.status, 0, again.out)
  assert.match(again.out, /already \.githooks/)

  run(clone, 'git', ['config', 'core.hooksPath', '.husky/_'])
  const foreign = run(clone, process.execPath, [guard, 'hooks', '--activate'])
  assert.equal(foreign.status, 1)
  assert.match(foreign.out, /core\.hooksPath is already "\.husky\/_", so ResaLedger changed nothing/)
  assert.match(foreign.out, /node ledger\/scripts\/records\.mjs commit-msg "\$1"/)
  assert.equal(run(clone, 'git', ['config', 'core.hooksPath']).out.trim(), '.husky/_')
})

test('activateHooks leaves a foreign hooks path alone', () => {
  const { clone } = freshClone()
  run(clone, 'git', ['config', 'core.hooksPath', 'tools/hooks'])
  assert.deepEqual(inside(clone, activateHooks), { foreign: 'tools/hooks' })
  assert.equal(run(clone, 'git', ['config', 'core.hooksPath']).out.trim(), 'tools/hooks')
  assert.equal(inside(clone, hooksActive), false)
})

test('activation from a worktree turns the hooks on for every worktree', () => {
  const { r } = freshClone()
  const lane = r.worktree('lane', 'feature/lane')
  assert.equal(inside(lane.root, hooksActive), false)
  assert.equal(inside(lane.root, activateHooks), 'activated')
  assert.equal(inside(lane.root, hooksActive), true)
  assert.equal(inside(r.root, hooksActive), true)
  assert.equal(inside(lane.root, activateHooks), 'active')
  mkdirSync(join(lane.root, 'deep', 'er'), { recursive: true })
  assert.equal(inside(join(lane.root, 'deep', 'er'), hooksActive), true)

  install(lane, RECORDER)
  const committed = lane.commit('chore: record the calls')
  assert.equal(committed.status, 0, committed.out)
  assert.deepEqual(
    calls(lane).map((call) => call.args[0]),
    ['pre-commit', 'commit-msg']
  )

  run(lane.root, 'git', ['config', 'core.hooksPath', 'other'])
  assert.deepEqual(inside(lane.root, activateHooks), { foreign: 'other' })
})

/** Every file under root with its content, to prove that nothing changed. */
function snapshot(root) {
  const files = {}
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.name === '.git') continue
      if (entry.isDirectory()) walk(path)
      else files[path.slice(root.length + 1)] = readFileSync(path, 'utf8')
    }
  }
  walk(root)
  return files
}

test('detectHookManager recognises each hook manager and its absence', () => {
  const sample = (files) => {
    const root = temporary()
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    return detectHookManager(root)
  }
  assert.equal(sample({}), null)
  assert.equal(sample({ 'package.json': '{"name":"app"}' }), null)
  assert.equal(sample({ '.husky/pre-commit': 'npm test\n' }), 'husky')
  assert.equal(sample({ 'package.json': '{"scripts":{"prepare":"husky"}}' }), 'husky')
  assert.equal(sample({ 'lefthook.yml': 'pre-commit:\n' }), 'lefthook')
  assert.equal(sample({ 'lefthook.yaml': 'pre-commit:\n' }), 'lefthook')
  assert.equal(sample({ '.lefthook.yml': 'pre-commit:\n' }), 'lefthook')
  assert.equal(sample({ '.pre-commit-config.yaml': 'repos: []\n' }), 'pre-commit')
  assert.equal(sample({ 'package.json': '{"simple-git-hooks":{"pre-commit":"npx lint-staged"}}' }), 'simple-git-hooks')
})

test('the husky integration appends the guard\'s calls once and creates missing hook files', () => {
  const root = temporary()
  mkdirSync(join(root, '.husky'))
  writeFileSync(join(root, '.husky', 'pre-commit'), 'npx lint-staged')
  const first = integrateHookManager(root, 'husky', 'ledger')
  assert.deepEqual(first, { changed: ['.husky/pre-commit', '.husky/pre-merge-commit', '.husky/commit-msg', '.husky/pre-push'], instructions: null })
  assert.equal(
    readFileSync(join(root, '.husky', 'pre-commit'), 'utf8'),
    'npx lint-staged\n# resaledger: pre-commit call, managed by ResaLedger; do not edit\nnode "ledger/scripts/records.mjs" pre-commit\n'
  )
  assert.match(readFileSync(join(root, '.husky', 'commit-msg'), 'utf8'), /node "ledger\/scripts\/records\.mjs" commit-msg "\$1"\n$/)
  assert.match(readFileSync(join(root, '.husky', 'pre-push'), 'utf8'), /node "ledger\/scripts\/records\.mjs" pre-push "\$@"\n$/)

  const before = snapshot(root)
  const second = integrateHookManager(root, 'husky', 'ledger')
  assert.deepEqual(second, { changed: [], instructions: null })
  assert.deepEqual(snapshot(root), before)
})

test('hooksActive recognises the husky integration', () => {
  const r = repository()
  install(r)
  integrateHookManager(r.root, 'husky', 'ledger')
  for (const name of HOOK_NAMES) r.write(`.husky/_/${name}`, '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n')
  r.git('config', 'core.hooksPath', '.husky/_')
  assert.equal(inside(r.root, hooksActive), true)
  r.write('.husky/commit-msg', 'npx commitlint --edit "$1"\n')
  assert.equal(inside(r.root, hooksActive), false)
})

test('the simple-git-hooks integration extends the hooks and keeps the rest of package.json', () => {
  const root = temporary()
  const original = {
    name: 'app',
    version: '1.2.3',
    scripts: { test: 'node --test', prepare: 'simple-git-hooks' },
    'simple-git-hooks': { 'pre-commit': 'npx lint-staged', 'post-merge': 'npm install' },
    'lint-staged': { '*.js': 'prettier --write' }
  }
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(original, null, 4)}\n`)
  const first = integrateHookManager(root, 'simple-git-hooks', 'ledger')
  assert.deepEqual(first.changed, ['package.json'])
  assert.match(first.instructions, /npx simple-git-hooks/)
  const text = readFileSync(join(root, 'package.json'), 'utf8')
  assert.match(text, /^\{\n {4}"name": "app",\n/, 'the indentation is kept')
  const manifest = JSON.parse(text)
  assert.deepEqual(Object.keys(manifest), Object.keys(original))
  assert.deepEqual(manifest.scripts, original.scripts)
  assert.deepEqual(manifest['lint-staged'], original['lint-staged'])
  assert.deepEqual(manifest['simple-git-hooks'], {
    'pre-commit': 'npx lint-staged && node "ledger/scripts/records.mjs" pre-commit',
    'post-merge': 'npm install',
    'pre-merge-commit': 'node "ledger/scripts/records.mjs" pre-merge-commit',
    'commit-msg': 'node "ledger/scripts/records.mjs" commit-msg "$1"',
    'pre-push': 'node "ledger/scripts/records.mjs" pre-push "$@"'
  })

  const second = integrateHookManager(root, 'simple-git-hooks', 'ledger')
  assert.deepEqual(second, { changed: [], instructions: null })
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), text)
})

test('the lefthook and pre-commit integrations change nothing and return the snippet to paste', () => {
  const root = temporary()
  writeFileSync(join(root, 'lefthook.yml'), 'pre-commit:\n  commands:\n    lint:\n      run: npm run lint\n')
  writeFileSync(join(root, '.pre-commit-config.yaml'), 'repos: []\n')
  const before = snapshot(root)

  const lefthook = integrateHookManager(root, 'lefthook', 'tools/ledger')
  assert.deepEqual(lefthook.changed, [])
  assert.match(lefthook.instructions, /run: node "tools\/ledger\/scripts\/records\.mjs" commit-msg \{1\}/)
  assert.match(lefthook.instructions, /use_stdin: true/)

  const preCommit = integrateHookManager(root, 'pre-commit', 'tools/ledger')
  assert.deepEqual(preCommit.changed, [])
  for (const name of HOOK_NAMES) assert.match(preCommit.instructions, new RegExp(`stages: \\[${name}\\]`))
  assert.match(preCommit.instructions, /entry: node "tools\/ledger\/scripts\/records\.mjs" pre-push/)

  assert.deepEqual(snapshot(root), before)
  assert.throws(() => integrateHookManager(root, 'overcommit', 'ledger'), /unknown hook manager/)
})

test('git runs pre-merge-commit, not pre-commit, for a merge that commits by itself', () => {
  const r = repository()
  install(r, RECORDER)
  r.git('config', 'core.hooksPath', '.githooks')
  assert.equal(r.commit('chore: start').status, 0)
  r.git('checkout', '-q', '-b', 'lane')
  r.write('notes.md', 'Notes.\n')
  assert.equal(r.commit('docs: notes').status, 0)
  r.git('checkout', '-q', 'main')
  const before = calls(r).length
  const merged = r.git('merge', '-q', '--no-ff', '-m', 'Merge lane', 'lane')
  assert.equal(merged.status, 0, merged.out)
  assert.deepEqual(
    calls(r)
      .slice(before)
      .map((call) => call.args),
    [['pre-merge-commit'], ['commit-msg', '.git/MERGE_MSG']]
  )
})

test('a clone whose hooks predate pre-merge-commit is not active', () => {
  const r = repository()
  install(r)
  r.git('config', 'core.hooksPath', '.githooks')
  assert.equal(inside(r.root, hooksActive), true)
  r.write('.githooks/pre-merge-commit', '#!/bin/sh\nexit 0\n')
  assert.equal(inside(r.root, hooksActive), false)
  // A hook manager whose configuration calls the guard for every hook is active.
  r.git('config', 'core.hooksPath', '.lefthook-hooks')
  for (const name of HOOK_NAMES) r.write(`.lefthook-hooks/${name}`, '#!/bin/sh\nlefthook run "$0"\n')
  const snippet = integrateHookManager(r.root, 'lefthook', 'ledger').instructions
  r.write('lefthook.yml', snippet.slice(snippet.indexOf('pre-commit:'), snippet.indexOf('\n\nThen')))
  assert.equal(inside(r.root, hooksActive), true)
  r.write('lefthook.yml', r.read('lefthook.yml').replace(/pre-merge-commit:[\s\S]*?(?=commit-msg:)/, ''))
  assert.equal(inside(r.root, hooksActive), false)
})
