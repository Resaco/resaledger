// I2: init finds the project's checks, proves each one by running it once, and keeps only those
// that pass. cargo, go, uv, make and pnpm are stubs in a temporary bin folder, since the tests
// cannot assume they are installed; npm scripts run for real, as trivial node -e commands.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { describe, test } from 'node:test'
import { detectCommitStyle, detectGates, gateCandidates, makeTargets, OFFLINE_ENV, packageManager, proveCandidate, pythonTools, scriptCommand, tomlRequirements, tomlTables } from '../src/cli/detect.mjs'
import { initOptions, parseInitArgs, planInit } from '../src/cli/init.mjs'
import { parseConfig } from '../src/guard/config.mjs'
import { ENV, PACKAGE, repository, temporary } from './helpers.mjs'

const CLI = join(PACKAGE, 'bin', 'resaledger.mjs')
const POSIX = process.platform !== 'win32'
const pass = 'node -e "process.exit(0)"'
const failing = 'node -e "console.log(\'two tests failed\'); process.exit(1)"'

/** A repository with one commit holding the given files. */
function project(files = {}, message = 'initial') {
  const r = repository()
  for (const [path, text] of Object.entries(files)) r.write(path, text)
  r.write('src/app.js', 'console.log("app")\n')
  const committed = r.commit(message)
  assert.equal(committed.status, 0, committed.out)
  return r
}

/**
 * A bin folder of stub programs and the environment that puts it first on PATH. programs maps a
 * name to { '<arguments>': exit status }; any other arguments exit 0. Each call is appended to
 * the log file with the offline variables it saw.
 */
function stubs(programs) {
  const bin = join(temporary(), 'bin')
  mkdirSync(bin)
  const log = join(bin, 'calls.log')
  writeFileSync(log, '')
  for (const [name, statuses] of Object.entries(programs)) {
    const cases = Object.entries(statuses).map(([args, status]) => `  '${args}') exit ${status} ;;\n`).join('')
    const script = `#!/bin/sh\necho "${name} $* offline=$npm_config_offline,$UV_OFFLINE,$CARGO_NET_OFFLINE,$GOPROXY" >> '${log}'\ncase "$*" in\n${cases}esac\nexit 0\n`
    writeFileSync(join(bin, name), script)
    chmodSync(join(bin, name), 0o755)
  }
  return { env: { ...ENV, PATH: `${bin}${delimiter}${ENV.PATH}` }, calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean) }
}

/** detectGates with its progress collected instead of printed. */
async function detect(root, options = {}) {
  const lines = []
  const result = await detectGates(root, { env: ENV, ...options, log: (line) => lines.push(line) })
  return { ...result, out: lines.join('\n') }
}

/** True once the process has ended, waiting up to three seconds. */
async function ended(pid) {
  for (let tries = 0; tries < 30; tries++) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

const commands = (root) => gateCandidates(root).map(({ command, kind }) => `${kind}: ${command}`)

describe('the sources of candidates', () => {
  test('package.json scripts with the lockfile\'s package manager, only the names that count', () => {
    const scripts = { lint: 'x', typecheck: 'x', 'check-types': 'x', 'format:check': 'x', test: 'x', build: 'x', dev: 'x', start: 'x', format: 'x', e2e: 'x' }
    const r = project({ 'package.json': JSON.stringify({ scripts }) })
    assert.deepEqual(commands(r.root), ['commit: npm run lint', 'commit: npm run typecheck', 'commit: npm run check-types', 'commit: npm run format:check', 'verify: npm test', 'verify: npm run build'])
    for (const [file, manager] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm']]) {
      const locked = project({ 'package.json': '{ "scripts": { "test": "x" } }', [file]: '' })
      assert.equal(packageManager(locked.root), manager, file)
    }
    assert.equal(scriptCommand('pnpm', 'test'), 'pnpm run test')
    assert.equal(scriptCommand('bun', 'test'), 'bun run test')
    assert.equal(scriptCommand('npm', 'lint'), 'npm run lint')
  })

  test('a broken package.json or an empty script names nothing', () => {
    assert.deepEqual(commands(project({ 'package.json': '{ broken' }).root), [])
    assert.deepEqual(commands(project({ 'package.json': '{ "scripts": { "test": " " } }' }).root), [])
  })

  test('Makefile targets lint, check, test and build; a target a package.json script covers is skipped', () => {
    const makefile = 'VAR := 1\n.PHONY: lint test\nlint:\n\t@echo lint\ncheck test: build\n\t@echo $@\nbuild:\n\t@echo build\n%.o: %.c\n\tcc $<\ninstall:\n'
    assert.deepEqual([...makeTargets(makefile)].sort(), ['build', 'check', 'install', 'lint', 'test'])
    assert.deepEqual(commands(project({ Makefile: makefile }).root), ['commit: make lint', 'verify: make check', 'verify: make test', 'verify: make build'])
    const both = project({ Makefile: makefile, 'package.json': '{ "scripts": { "test": "x" } }' })
    assert.deepEqual(commands(both.root), ['verify: npm test', 'commit: make lint', 'verify: make check', 'verify: make build'])
  })

  test('pyproject.toml: ruff, mypy and pytest from their tool tables or requirements, under uv run with a uv.lock', () => {
    const pyproject = '[project]\nname = "bakery"\ndescription = "ruff is not named here"\ndependencies = ["requests>=2"]\n\n[dependency-groups]\ndev = [\n  "pytest >= 8",\n  "mypy[faster-cache]==1.11",\n]\n\n[tool.ruff.lint]\nselect = ["E"]\n'
    assert.deepEqual(pythonTools(pyproject), ['ruff', 'mypy', 'pytest'])
    assert.ok(tomlTables(pyproject).has('tool.ruff.lint'))
    assert.ok(tomlRequirements('[tool.poetry.group.dev.dependencies]\npytest = "^8"\n').has('pytest'))
    assert.deepEqual(pythonTools('[project]\nname = "pytest-free"\n'), [])
    assert.deepEqual(commands(project({ 'pyproject.toml': pyproject }).root), ['commit: ruff check', 'commit: mypy .', 'verify: pytest'])
    assert.deepEqual(commands(project({ 'pyproject.toml': pyproject, 'uv.lock': '' }).root), ['commit: uv run ruff check', 'commit: uv run mypy .', 'verify: uv run pytest'])
  })

  test('Cargo.toml and go.mod', () => {
    assert.deepEqual(commands(project({ 'Cargo.toml': '[package]\nname = "bakery"\n' }).root), ['commit: cargo fmt --check', 'verify: cargo clippy -- -D warnings', 'verify: cargo test'])
    assert.deepEqual(commands(project({ 'go.mod': 'module example.com/bakery\n' }).root), ['commit: go vet ./...', 'verify: go test ./...'])
  })

  test('nothing to find', async () => {
    const found = await detect(project().root)
    assert.deepEqual(found.gates, { commit: [], verify: [] })
    assert.match(found.out, /names no check that ResaLedger knows/)
  })
})

describe('the proof, with stub toolchains', { skip: !POSIX && 'the stubs are sh scripts' }, () => {
  test('pnpm: the scripts run through pnpm, and a failing one is reported and not added', async () => {
    const r = project({ 'package.json': '{ "scripts": { "lint": "x", "test": "x" } }', 'pnpm-lock.yaml': '' })
    const stub = stubs({ pnpm: { 'run test': 1 } })
    const found = await detect(r.root, { env: stub.env })
    assert.deepEqual(found.gates, { commit: ['pnpm run lint'], verify: [] })
    assert.match(found.out, /✔ pnpm run lint passed/)
    assert.match(found.out, /✖ pnpm run test exited with 1, so it is not added/)
    assert.deepEqual(stub.calls().map((line) => line.split(' offline')[0]), ['pnpm run lint', 'pnpm run test'])
  })

  test('make', async () => {
    const stub = stubs({ make: { build: 2 } })
    const found = await detect(project({ Makefile: 'lint:\n\ttrue\ntest:\n\ttrue\nbuild:\n\ttrue\n' }).root, { env: stub.env })
    assert.deepEqual(found.gates, { commit: ['make lint'], verify: ['make test'] })
    assert.match(found.out, /✖ make build exited with 2/)
  })

  test('uv: the tools run under uv run', async () => {
    const stub = stubs({ uv: { 'run mypy .': 1 } })
    const found = await detect(project({ 'pyproject.toml': '[tool.ruff]\n[tool.mypy]\n[tool.pytest.ini_options]\n', 'uv.lock': '' }).root, { env: stub.env })
    assert.deepEqual(found.gates, { commit: ['uv run ruff check'], verify: ['uv run pytest'] })
    assert.match(found.out, /✖ uv run mypy \. exited with 1/)
  })

  test('cargo: a clippy warning keeps clippy out, not added in a weaker form', async () => {
    const stub = stubs({ cargo: { 'clippy -- -D warnings': 101 } })
    const found = await detect(project({ 'Cargo.toml': '[package]\nname = "bakery"\n' }).root, { env: stub.env })
    assert.deepEqual(found.gates, { commit: ['cargo fmt --check'], verify: ['cargo test'] })
    assert.match(found.out, /✖ cargo clippy -- -D warnings exited with 101/)
  })

  test('go', async () => {
    const stub = stubs({ go: {} })
    const found = await detect(project({ 'go.mod': 'module example.com/bakery\n' }).root, { env: stub.env })
    assert.deepEqual(found.gates, { commit: ['go vet ./...'], verify: ['go test ./...'] })
  })

  test('a missing tool fails its candidate and is reported', async () => {
    const found = await detect(project({ 'go.mod': 'module example.com/bakery\n' }).root, { env: { ...ENV, PATH: temporary() } })
    assert.deepEqual(found.gates, { commit: [], verify: [] })
    assert.match(found.out, /✖ go vet \.\/\.\.\. exited with 127, so it is not added/)
  })

  test('no network: every candidate runs with the offline variables and no input', async () => {
    const stub = stubs({ cargo: {} })
    await detect(project({ 'Cargo.toml': '[package]\nname = "bakery"\n' }).root, { env: stub.env })
    for (const line of stub.calls()) assert.match(line, /offline=true,1,true,off$/)
    assert.equal(OFFLINE_ENV.GOTOOLCHAIN, 'local')
    // Detection itself opens no connection: the module imports no network API and calls no fetch.
    const source = readFileSync(join(PACKAGE, 'src', 'cli', 'detect.mjs'), 'utf8')
    assert.doesNotMatch(source, /from 'node:(?:http|https|http2|net|dns|tls|dgram)'|\bfetch\(/)
  })
})

describe('npm scripts, run for real', () => {
  test('a failing script is reported with its last lines and not added', async () => {
    const r = project({ 'package.json': JSON.stringify({ scripts: { lint: pass, test: failing } }) })
    const found = await detect(r.root)
    assert.deepEqual(found.gates, { commit: ['npm run lint'], verify: [] })
    assert.match(found.out, /\[1\/2\] npm run lint \(commit gate, from package\.json, up to 60 s\)…/)
    assert.match(found.out, /✖ npm test exited with 1, so it is not added\n.*\n( {6}.*\n)*? {6}two tests failed/)
  })

  test('a script that hangs is stopped at its time limit, with everything it started', { skip: !POSIX && 'process groups' }, async () => {
    const r = project({ 'package.json': JSON.stringify({ scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'hung.pid\', String(process.pid)); setInterval(() => {}, 1000)"' } }) })
    const started = Date.now()
    const found = await detect(r.root, { timeLimits: { verify: 4 } })
    assert.ok(Date.now() - started < 10000, 'it waited for the hanging script')
    assert.deepEqual(found.gates, { commit: [], verify: [] })
    assert.match(found.out, /✖ npm test stopped after 4 s, its time limit, so it is not added/)
    // A killed process lingers until its new parent reaps it, so its end is awaited briefly.
    const pid = Number(readFileSync(join(r.root, 'hung.pid'), 'utf8'))
    assert.ok(await ended(pid), `the script's node process ${pid} still runs`)
  })

  test('a command that cannot start fails without throwing', async () => {
    const result = await proveCandidate(project().root, { command: 'no-such-program-here', kind: 'commit', source: 'test' }, { env: ENV })
    assert.equal(result.passed, false)
    assert.match(result.reason, /exited with (127|1)/)
  })
})

describe('the commit style', () => {
  test('conventional when most of the last commits follow Conventional Commits', () => {
    const r = project({}, 'feat: start the bakery shop')
    for (const message of ['fix(cart): round the prices', 'docs: say how to bake', 'update stuff']) {
      r.write('src/app.js', `// ${message}\n`)
      assert.equal(r.commit(message).status, 0)
    }
    assert.equal(detectCommitStyle(r.root), 'conventional')
  })

  test('free when half or fewer follow it, or there is no commit', () => {
    const r = project({}, 'initial')
    r.write('src/app.js', '// two\n')
    assert.equal(r.commit('feat: one').status, 0)
    assert.equal(detectCommitStyle(r.root), 'free')
    assert.equal(detectCommitStyle(repository().root), 'free')
  })

  test('conventional with a commitlint configuration, as a file or in package.json', () => {
    assert.equal(detectCommitStyle(project({ 'commitlint.config.mjs': 'export default {}\n' }).root), 'conventional')
    assert.equal(detectCommitStyle(project({ '.commitlintrc.json': '{}\n' }).root), 'conventional')
    assert.equal(detectCommitStyle(project({ 'package.json': '{ "commitlint": { "extends": [] } }' }).root), 'conventional')
  })
})

describe('init', () => {
  test('planInit writes the gates and the commit style, and the configuration stays valid', () => {
    const r = project()
    const plan = planInit(r.root, { ...initOptions(parseInitArgs([]).flags), gates: { commit: ['npm run lint'], verify: ['npm test'] }, commitStyle: 'conventional' })
    assert.deepEqual(plan.refusals, [])
    const config = JSON.parse(plan.writes.get('.resaledger.json'))
    assert.deepEqual(config, { version: 2, preset: 'solo', commitStyle: 'conventional', gates: { commit: ['npm run lint'], verify: ['npm test'] } })
    assert.ok(parseConfig(plan.writes.get('.resaledger.json')).config)
    const free = planInit(r.root, { ...initOptions(parseInitArgs([]).flags), commitStyle: 'free' })
    assert.deepEqual(JSON.parse(free.writes.get('.resaledger.json')), { version: 2, preset: 'solo', gates: { commit: [], verify: [] } })
  })

  test('--no-gates is parsed, and the help names it', () => {
    assert.equal(parseInitArgs(['--no-gates']).flags.gates, false)
    assert.equal(parseInitArgs([]).flags.gates, true)
    const r = repository()
    assert.match(r.node(CLI, 'help').out, /--no-gates runs no\n\s+check and leaves the gates for you to write/)
  })

  test('init --no-gates runs nothing and writes no gates', () => {
    const r = project({ 'package.json': JSON.stringify({ scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'ran\', \'\')"' } }) })
    const result = r.node(CLI, 'init', '--yes', '--no-gates')
    assert.equal(result.status, 0, result.out)
    assert.equal(existsSync(join(r.root, 'ran')), false)
    assert.deepEqual(JSON.parse(r.read('.resaledger.json')).gates, { commit: [], verify: [] })
    assert.match(result.out, /Gates: none\. Add your checks to "gates" in \.resaledger\.json\./)
  })

  test('init --yes writes passing test and lint scripts as verify and commit gates, and the setup commit passes the installed hooks', () => {
    const r = project({ 'package.json': JSON.stringify({ name: 'bakery-shop', scripts: { lint: pass, test: pass, build: failing } }) }, 'feat: open the bakery shop')
    const result = r.node(CLI, 'init', '--yes')
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /✖ npm run build exited with 1, so it is not added/)
    assert.match(result.out, /Gates: 1 commit, 1 verify/)
    const config = JSON.parse(r.read('.resaledger.json'))
    assert.deepEqual(config.gates, { commit: ['npm run lint'], verify: ['npm test'] })
    assert.equal(config.commitStyle, 'conventional')
    assert.equal(r.node('ledger/scripts/records.mjs', 'config').status, 0)

    const line = result.out.split('\n').find((text) => text.trim().startsWith('git add '))
    const committed = r.run('sh', ['-c', line.trim()])
    assert.equal(committed.status, 0, committed.out)
    // pre-commit ran the commit gate on the setup commit, which changes code.
    assert.match(committed.out, /✔ npm run lint/)
    assert.equal(r.git('status', '--porcelain').out, '')
    const verified = r.node('ledger/scripts/records.mjs', 'verify')
    assert.equal(verified.status, 0, verified.out)
    assert.match(verified.out, /all 2 gates passed/)
  })
})
