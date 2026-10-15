// `resaledger init` on real repositories, driven through the package's command line with
// stdin that is not a terminal: solo and team, --dir, every refusal, an existing AGENTS.md
// and CLAUDE.md, husky, the project name, and the printed commit command run through the
// installed hooks. The interactive path is covered through initOptions.
import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, rmSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { GOAL_MARKER, goModuleName, initOptions, parseInitArgs, planInit, presetFromAnswer, projectName, tomlTableName } from '../src/cli/init.mjs'
import { PACKAGE, repository, run, temporary } from './helpers.mjs'

const CLI = join(PACKAGE, 'bin', 'resaledger.mjs')
const BLOCK_START = '<!-- resaledger:start'

/** A repository with one commit holding the given files. */
function project(files = {}) {
  const r = repository()
  for (const [path, text] of Object.entries(files)) r.write(path, text)
  r.write('src/app.js', 'console.log("app")\n')
  const committed = r.commit('initial')
  assert.equal(committed.status, 0, committed.out)
  return r
}

const init = (r, ...args) => r.node(CLI, 'init', ...args)

/** Every file under the root except .git, with its content and mode. */
function snapshot(root) {
  const files = {}
  const walk = (folder) => {
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
      const path = folder ? `${folder}/${entry.name}` : entry.name
      if (path === '.git') continue
      if (entry.isDirectory()) walk(path)
      else if (entry.isSymbolicLink()) files[path] = `-> ${readlinkSync(join(root, path))}`
      else files[path] = `${statSync(join(root, path)).mode.toString(8)} ${readFileSync(join(root, path), 'utf8')}`
    }
  }
  walk('')
  return files
}

/** The commit command printed in init's next steps. */
function printedCommit(out) {
  const line = out.split('\n').find((text) => text.trim().startsWith('git add '))
  assert.ok(line, out)
  return line.trim()
}

describe('a solo setup off a terminal', () => {
  const r = project({ 'package.json': '{ "name": "shop-front", "private": true }\n' })
  const result = init(r)

  test('runs without asking, takes the defaults and passes check', () => {
    assert.equal(result.status, 0, result.out)
    assert.doesNotMatch(result.out, /Solo or team\?/)
    assert.match(result.out, /set up in ledger\/, with the solo preset/)
    assert.match(result.out, /✔ records valid/)
  })

  test('writes the configuration, which parses, with empty gates', () => {
    assert.deepEqual(JSON.parse(r.read('.resaledger.json')), { version: 2, preset: 'solo', gates: { commit: [], verify: [] } })
    assert.equal(r.node('ledger/scripts/records.mjs', 'config').status, 0)
  })

  test('the workspace holds the README and the guard, and no empty folder', () => {
    assert.deepEqual(readdirSync(join(r.root, 'ledger')).sort(), ['README.md', 'scripts'])
    assert.deepEqual(readdirSync(join(r.root, 'ledger', 'scripts')), ['records.mjs'])
    if (process.platform !== 'win32') assert.ok(statSync(join(r.root, 'ledger', 'scripts', 'records.mjs')).mode & 0o100)
    const readme = r.read('ledger/README.md')
    assert.match(readme, /^# shop-front\n\n## Goal\n\nTODO\(resaledger\): what is being built/)
    assert.match(readme, /## Environments\n\nTODO\(resaledger\): /)
    assert.match(readme, /## Manual checks\n\nTODO\(resaledger\): /)
  })

  test('writes the git hooks and turns them on', () => {
    for (const name of ['pre-commit', 'commit-msg', 'pre-push']) {
      assert.match(r.read(`.githooks/${name}`), new RegExp(`"ledger/scripts/records\\.mjs" ${name}`))
      if (process.platform !== 'win32') assert.ok(statSync(join(r.root, '.githooks', name)).mode & 0o100)
    }
    assert.equal(r.git('config', '--get', 'core.hooksPath').out.trim(), '.githooks')
    assert.match(result.out, /✔ git hooks turned on/)
    assert.match(result.out, /✔ the git hooks run the guard in this clone/)
  })

  test('creates AGENTS.md with the managed block, and no CLAUDE.md', () => {
    const agents = r.read('AGENTS.md')
    assert.ok(agents.startsWith(BLOCK_START))
    assert.match(agents, /node ledger\/scripts\/records\.mjs work/)
    assert.equal(lstatSync(join(r.root, 'CLAUDE.md'), { throwIfNoEntry: false }), undefined)
  })

  test('prints what it did and the next steps', () => {
    assert.match(result.out, /Created \(7\):\n {2}\.githooks\/commit-msg\n {2}\.githooks\/pre-commit\n {2}\.githooks\/pre-push\n {2}\.resaledger\.json\n {2}AGENTS\.md\n {2}ledger\/README\.md\n {2}ledger\/scripts\/records\.mjs\n/)
    assert.match(result.out, /Write the project's own text in ledger\/README\.md .*\(Goal, Environments, Manual checks\)/)
    assert.match(result.out, /3\. Start working: node ledger\/scripts\/records\.mjs work/)
    assert.equal(
      printedCommit(result.out),
      'git add .resaledger.json AGENTS.md ledger/README.md ledger/scripts/records.mjs && git add --chmod=+x .githooks/commit-msg .githooks/pre-commit .githooks/pre-push && git commit -m "chore: set up ResaLedger" -m "Task: maintenance"'
    )
  })

  test('the printed commit command commits through the installed hooks and leaves the tree clean', () => {
    r.write('notes.txt', 'unrelated work in progress\n')
    // The hooks run: the same files with a broken task file staged are refused by pre-commit.
    r.write('ledger/tasks/X1-broken.md', '# X1 Broken\n\n- Status: nonsense\n')
    const files = printedCommit(result.out)
      .split(' && ')
      .filter((part) => part.startsWith('git add '))
      .flatMap((part) => part.replace(/^git add (--chmod=\+x )?/, '').split(' '))
    assert.equal(r.git('add', ...files, 'ledger/tasks/X1-broken.md').status, 0)
    const refused = r.git('commit', '-q', '-m', 'chore: set up ResaLedger', '-m', 'Task: maintenance')
    assert.notEqual(refused.status, 0, refused.out)
    assert.match(refused.out, /"nonsense" is not a status/)
    assert.equal(r.git('rm', '-q', '--cached', 'ledger/tasks/X1-broken.md').status, 0)
    rmSync(join(r.root, 'ledger', 'tasks'), { recursive: true })
    const committed = r.run('sh', ['-c', printedCommit(result.out)])
    assert.equal(committed.status, 0, committed.out)
    assert.equal(r.git('status', '--porcelain').out, '?? notes.txt\n')
    assert.match(r.git('log', '-1', '--format=%B').out, /^chore: set up ResaLedger\n\nTask: maintenance\n/)
    // The hooks are committed as executable on every platform, Windows included.
    for (const name of ['pre-commit', 'commit-msg', 'pre-push']) assert.match(r.git('ls-files', '-s', `.githooks/${name}`).out, /^100755 /)
  })

  test('a second init is refused as already set up and changes nothing', () => {
    const before = snapshot(r.root)
    const again = init(r, '--yes')
    assert.equal(again.status, 1)
    assert.match(again.out, /\.resaledger\.json exists: this repository is already set up with ResaLedger\. "npx resaledger update" renews the guard/)
    assert.deepEqual(snapshot(r.root), before)
  })
})

describe('the team preset and --dir', () => {
  test('--team --yes writes the team preset', () => {
    const r = project()
    const result = init(r, '--team', '--yes')
    assert.equal(result.status, 0, result.out)
    assert.equal(JSON.parse(r.read('.resaledger.json')).preset, 'team')
    assert.match(result.out, /with the team preset/)
  })

  test('--dir names the workspace folder in the configuration, the hooks and the block', () => {
    const r = project()
    const result = init(r, '--dir', 'records', '--yes')
    assert.equal(result.status, 0, result.out)
    assert.deepEqual(JSON.parse(r.read('.resaledger.json')), { version: 2, preset: 'solo', dir: 'records', gates: { commit: [], verify: [] } })
    assert.deepEqual(readdirSync(join(r.root, 'records')).sort(), ['README.md', 'scripts'])
    assert.match(r.read('.githooks/pre-commit'), /"records\/scripts\/records\.mjs" pre-commit/)
    assert.match(r.read('AGENTS.md'), /node records\/scripts\/records\.mjs work/)
    assert.match(result.out, /Start working: node records\/scripts\/records\.mjs work/)
  })

  test('--dir=ledger is the default and is not written', () => {
    const r = project()
    assert.equal(init(r, '--dir=./ledger/').status, 0)
    assert.equal('dir' in JSON.parse(r.read('.resaledger.json')), false)
  })

  test('a --dir outside the repository is refused with the configuration\'s rule', () => {
    const r = project()
    const before = snapshot(r.root)
    const result = init(r, '--dir', '../outside')
    assert.equal(result.status, 1)
    assert.match(result.out, /✖ --dir: "dir" must be a relative folder inside the repository/)
    assert.deepEqual(snapshot(r.root), before)
  })

  test('an existing ledger/ is refused with the --dir hint, and nothing changes', () => {
    const r = project({ 'ledger/notes.md': '# Someone else\'s ledger\n' })
    const before = snapshot(r.root)
    const result = init(r)
    assert.equal(result.status, 1)
    assert.match(result.out, /✖ ledger\/ exists, and ResaLedger did not create it; choose another workspace folder with --dir <name>/)
    assert.deepEqual(snapshot(r.root), before)
    assert.equal(r.git('config', '--get', 'core.hooksPath').out, '')
  })
})

describe('AGENTS.md and CLAUDE.md', () => {
  const OWN = '# Project rules\n\nUse tabs.\n\n\n- Keep the  spacing   as it is'

  test('an existing AGENTS.md keeps its text byte for byte and gets the block once', () => {
    const r = project({ 'AGENTS.md': OWN })
    assert.equal(init(r).status, 0)
    const agents = r.read('AGENTS.md')
    assert.ok(agents.startsWith(`${OWN}\n\n${BLOCK_START}`))
    assert.equal(agents.split(BLOCK_START).length, 2)
    assert.ok(agents.endsWith('<!-- resaledger:end -->\n'))
  })

  test('an existing managed block is replaced where it stands', () => {
    const r = project({ 'AGENTS.md': `# Rules\n\n${BLOCK_START} · old -->\nold text\n<!-- resaledger:end -->\n\n## After\n` })
    assert.equal(init(r).status, 0)
    const agents = r.read('AGENTS.md')
    assert.equal(agents.split(BLOCK_START).length, 2)
    assert.doesNotMatch(agents, /old text/)
    assert.ok(agents.startsWith(`# Rules\n\n${BLOCK_START}`))
    assert.ok(agents.endsWith('<!-- resaledger:end -->\n\n## After\n'))
  })

  test('an existing CLAUDE.md imports AGENTS.md once', () => {
    const r = project({ 'CLAUDE.md': '# Notes for Claude\n\nUse the test command.' })
    const result = init(r)
    assert.equal(result.status, 0, result.out)
    assert.equal(r.read('CLAUDE.md'), '# Notes for Claude\n\nUse the test command.\n\n@AGENTS.md\n')
    assert.match(result.out, /Changed \(1\):\n {2}CLAUDE\.md/)
  })

  test('a CLAUDE.md that imports AGENTS.md already is left alone', () => {
    const r = project({ 'CLAUDE.md': '@AGENTS.md\n\n# Notes\n' })
    const result = init(r)
    assert.equal(result.status, 0, result.out)
    assert.equal(r.read('CLAUDE.md'), '@AGENTS.md\n\n# Notes\n')
    assert.doesNotMatch(result.out, /CLAUDE\.md/)
  })

  test('a CLAUDE.md that is a link to AGENTS.md is left a link, and reads the block', () => {
    const r = repository()
    r.write('AGENTS.md', '# Rules\n')
    symlinkSync('AGENTS.md', join(r.root, 'CLAUDE.md'))
    assert.equal(r.commit('initial').status, 0)
    const result = init(r)
    assert.equal(result.status, 0, result.out)
    assert.equal(readlinkSync(join(r.root, 'CLAUDE.md')), 'AGENTS.md')
    assert.match(r.read('CLAUDE.md'), /<!-- resaledger:start/)
    assert.doesNotMatch(r.read('CLAUDE.md'), /@AGENTS\.md/)
    assert.doesNotMatch(result.out, /^ {2}CLAUDE\.md$/m)
  })
})

describe('hook managers', () => {
  test('husky: the guard\'s calls go into .husky/, and core.hooksPath is not set', () => {
    const r = project({ '.husky/pre-commit': 'npm run lint\n', 'package.json': '{ "name": "app", "scripts": { "prepare": "husky" } }\n' })
    const result = init(r)
    assert.equal(result.status, 0, result.out)
    assert.equal(r.git('config', '--get', 'core.hooksPath').out, '')
    assert.equal(lstatSync(join(r.root, '.githooks'), { throwIfNoEntry: false }), undefined)
    assert.match(r.read('.husky/pre-commit'), /^npm run lint\n# resaledger: pre-commit call, managed by ResaLedger; do not edit\nnode "ledger\/scripts\/records\.mjs" pre-commit\n$/)
    assert.match(r.read('.husky/commit-msg'), /node "ledger\/scripts\/records\.mjs" commit-msg "\$1"/)
    assert.match(result.out, /Created \(6\):\n {2}\.husky\/commit-msg\n {2}\.husky\/pre-push\n {2}\.resaledger\.json\n {2}AGENTS\.md\n/)
    assert.match(result.out, /! the git hooks do not run the guard in this clone yet; install husky's hooks with "npx husky"/)
    assert.match(result.out, /Changed \(1\):\n {2}\.husky\/pre-commit\n/)
    assert.match(result.out, /! husky manages the git hooks here, so core\.hooksPath was not changed/)
    assert.match(printedCommit(result.out), /^git add \.husky\/commit-msg \.husky\/pre-commit \.husky\/pre-push \.resaledger\.json AGENTS\.md ledger\/README\.md ledger\/scripts\/records\.mjs && /)
  })

  test('a dirty husky hook is refused', () => {
    const r = project({ '.husky/pre-commit': 'npm run lint\n' })
    r.append('.husky/pre-commit', 'npm test\n')
    const result = init(r)
    assert.equal(result.status, 1)
    assert.match(result.out, /uncommitted changes, and init would change them: \.husky\/pre-commit\./)
  })

  test('lefthook: the snippet is printed and core.hooksPath is not set', () => {
    const r = project({ 'lefthook.yml': 'pre-commit:\n  commands: {}\n' })
    const result = init(r)
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /Add the guard's calls to your lefthook configuration/)
    assert.equal(r.read('lefthook.yml'), 'pre-commit:\n  commands: {}\n')
    assert.equal(r.git('config', '--get', 'core.hooksPath').out, '')
  })

  test('a .githooks hook that is not ResaLedger\'s is refused', () => {
    const r = project({ '.githooks/pre-commit': '#!/bin/sh\nmake lint\n' })
    const result = init(r)
    assert.equal(result.status, 1)
    assert.match(result.out, /\.githooks\/pre-commit exists and is not ResaLedger's hook/)
  })

  test('core.hooksPath naming another folder is reported and kept', () => {
    const r = project()
    r.git('config', 'core.hooksPath', 'tools/hooks')
    const result = init(r)
    assert.equal(result.status, 0, result.out)
    assert.equal(r.git('config', '--get', 'core.hooksPath').out.trim(), 'tools/hooks')
    assert.match(result.out, /! core\.hooksPath is "tools\/hooks", so the hooks in \.githooks\/ do not run/)
    assert.match(result.out, /! the git hooks do not run the guard in this clone yet/)
  })
})

describe('refusals', () => {
  test('outside a git repository', () => {
    const folder = temporary()
    const result = run(folder, process.execPath, [CLI, 'init'])
    assert.equal(result.status, 1)
    assert.match(result.out, /✖ this folder is not in a git repository/)
    assert.deepEqual(readdirSync(folder), [])
  })

  test('a dirty AGENTS.md, with every file unchanged byte for byte', () => {
    const r = project({ 'AGENTS.md': '# Rules\n', 'CLAUDE.md': '# Claude\n' })
    r.append('AGENTS.md', 'A rule in progress.\n')
    r.write('src/app.js', 'console.log("changed elsewhere, which is fine")\n')
    const before = snapshot(r.root)
    const result = init(r, '--yes')
    assert.equal(result.status, 1)
    assert.match(result.out, /✖ resaledger init changed nothing:\n {2}✖ these files have uncommitted changes, and init would change them: AGENTS\.md\. Commit or stash them first/)
    assert.deepEqual(snapshot(r.root), before)
    assert.equal(r.git('config', '--get', 'core.hooksPath').out, '')
  })

  test('an untracked CLAUDE.md counts as uncommitted', () => {
    const r = project()
    r.write('CLAUDE.md', '# New\n')
    const result = init(r)
    assert.equal(result.status, 1)
    assert.match(result.out, /init would change them: CLAUDE\.md\./)
  })

  test('an agent-ledger 0.x workspace is pointed to migrate', () => {
    const r = project({ '.agent-ledger.json': '{ "version": 1, "dir": "project" }\n' })
    const before = snapshot(r.root)
    const result = init(r)
    assert.equal(result.status, 1)
    assert.match(result.out, /\.agent-ledger\.json exists: this is an agent-ledger 0\.x workspace\. Run "npx resaledger migrate"/)
    assert.deepEqual(snapshot(r.root), before)
  })

  test('an unknown option', () => {
    const r = project()
    const result = init(r, '--ci')
    assert.equal(result.status, 1)
    assert.match(result.out, /unknown option "--ci" for init; use --team, --dir <name>, --agents <names> or --yes/)
  })

  test('the plan lists every refusal before anything is written', () => {
    const r = project({ 'ledger/x.md': 'x\n', 'AGENTS.md': '# Rules\n' })
    r.append('AGENTS.md', 'more\n')
    const plan = planInit(r.root, { preset: 'solo', dir: 'ledger', goal: '', agents: null })
    assert.equal(plan.refusals.length, 2, plan.refusals.join('\n'))
    assert.match(plan.refusals[0], /^ledger\/ exists/)
    assert.match(plan.refusals[1], /uncommitted changes.*AGENTS\.md/)
  })
})

describe('the project name', () => {
  const folder = (files) => {
    const root = join(temporary(), 'folder-name')
    mkdirSync(root)
    for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text)
    return root
  }

  test('comes from package.json first', () => {
    assert.equal(projectName(folder({ 'package.json': '{"name":"@scope/web"}', 'Cargo.toml': '[package]\nname = "crate"\n' })), '@scope/web')
  })

  test('from pyproject.toml [project]', () => {
    const text = '[tool.poetry]\nname = "not-this"\n\n[project]\nversion = "1"\nname = "py-app"  # the name\n'
    assert.equal(projectName(folder({ 'pyproject.toml': text, 'go.mod': 'module x/y\n' })), 'py-app')
    assert.equal(tomlTableName("[project]\nname = 'single'\n", 'project'), 'single')
    assert.equal(tomlTableName('[project.urls]\nname = "no"\n', 'project'), null)
  })

  test('from Cargo.toml [package]', () => {
    assert.equal(projectName(folder({ 'Cargo.toml': '[workspace]\nmembers = []\n[package]\nname = "rusty"\n' })), 'rusty')
  })

  test('from the last part of go.mod\'s module path', () => {
    assert.equal(projectName(folder({ 'go.mod': '// comment\nmodule example.com/team/service\n\ngo 1.22\n' })), 'service')
    assert.equal(goModuleName('module example.com/team/tool/v2\n'), 'tool')
    assert.equal(goModuleName('module "quoted"\n'), 'quoted')
  })

  test('from the folder name, when nothing names it or a file is broken', () => {
    assert.equal(projectName(folder({})), 'folder-name')
    assert.equal(projectName(folder({ 'package.json': '{ broken', 'pyproject.toml': '[project]\nversion = "1"\n' })), 'folder-name')
  })

  test('goes into the README heading', () => {
    const r = project({ 'pyproject.toml': '[project]\nname = "data-tools"\n' })
    assert.equal(init(r).status, 0)
    assert.match(r.read('ledger/README.md'), /^# data-tools\n/)
  })
})

describe('the answers', () => {
  test('parseInitArgs reads the flags', () => {
    assert.deepEqual(parseInitArgs(['--team', '--dir', 'records', '--yes']), { flags: { team: true, dir: 'records', yes: true, agents: null }, error: null })
    assert.deepEqual(parseInitArgs([]).flags, { team: false, dir: null, yes: false, agents: null })
    assert.deepEqual(parseInitArgs(['--agents', 'codex,claude']).flags.agents, ['codex', 'claude'])
    assert.deepEqual(parseInitArgs(['--agents=none']).flags.agents, [])
    assert.match(parseInitArgs(['--agents', 'emacs']).error, /unknown agent "emacs"/)
    assert.match(parseInitArgs(['--agents']).error, /--agents needs a list/)
    assert.match(parseInitArgs(['--dir']).error, /--dir needs a folder name/)
    assert.match(parseInitArgs(['--no-ci']).error, /unknown option "--no-ci"/)
  })

  test('presetFromAnswer: empty is solo, and anything else is asked again', () => {
    for (const answer of ['', '  ', 's', 'Solo']) assert.equal(presetFromAnswer(answer), 'solo')
    for (const answer of ['t', 'TEAM ']) assert.equal(presetFromAnswer(answer), 'team')
    assert.equal(presetFromAnswer('both'), null)
  })

  test('initOptions turns the answers into options', () => {
    const flags = { team: false, dir: null, yes: false }
    assert.deepEqual(initOptions(flags), { preset: 'solo', dir: 'ledger', goal: '', agents: null })
    assert.deepEqual(initOptions(flags, { preset: 'team', goal: '  A shop for\n vinyl records.  ' }), { preset: 'team', dir: 'ledger', goal: 'A shop for vinyl records.', agents: null })
    assert.deepEqual(initOptions({ ...flags, team: true, dir: 'records' }, { goal: '' }), { preset: 'team', dir: 'records', goal: '', agents: null })
  })

  test('a goal sentence replaces the goal marker, and the next steps do not ask for it', () => {
    const r = project()
    const plan = planInit(r.root, initOptions({ team: false, dir: null, yes: false }, { goal: 'A tool that keeps a task ledger.' }))
    assert.deepEqual(plan.refusals, [])
    const readme = plan.writes.get('ledger/README.md')
    assert.match(readme, /## Goal\n\nA tool that keeps a task ledger\.\n/)
    assert.equal(readme.includes(GOAL_MARKER), false)
    assert.equal(plan.goalMarker, false)
  })
})
