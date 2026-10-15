// `resaledger update` and the commands the package passes to the repository's guard, on real
// repositories through the package's command line: a clean update, an upgrade from a released
// version (built by a copy of the package with an older version and its own release hashes),
// a hand-edited hook and managed block, a missing guard, a newer guard, and guard commands
// from a subfolder with their exit codes and stdin.
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { compactDiff, compareVersions, guardVersion, normalizeManaged, withVersionHashes } from '../src/cli/update.mjs'
import { PACKAGE, repository, run, temporary } from './helpers.mjs'

const CLI = join(PACKAGE, 'bin', 'resaledger.mjs')
const GUARD = 'ledger/scripts/records.mjs'
const { version: VERSION } = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'))

/** A repository set up by the package at cli, with the setup committed through its hooks. */
function setUp(cli = CLI, files = {}, ...flags) {
  const r = repository()
  for (const [path, text] of Object.entries(files)) r.write(path, text)
  r.write('src/app.js', 'console.log("app")\n')
  assert.equal(r.commit('initial').status, 0)
  if (flags.includes('--team')) r.git('checkout', '-q', '-b', 'setup')
  const init = r.node(cli, 'init', '--yes', ...flags)
  assert.equal(init.status, 0, init.out)
  const committed = r.run('sh', ['-c', printedCommit(init.out)])
  assert.equal(committed.status, 0, committed.out)
  return r
}

/** The commit command a command printed. */
function printedCommit(out) {
  const line = out.split('\n').find((text) => text.trim().startsWith('git add '))
  assert.ok(line, out)
  return line.trim()
}

/** A copy of the package with another version, its guard built, and optionally changes to its files. */
function packageCopy(version, change = () => {}) {
  const copy = join(temporary('resaledger-package-'), 'package')
  for (const part of ['bin', 'src', 'templates', 'scripts']) cpSync(join(PACKAGE, part), join(copy, part), { recursive: true })
  const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'))
  writeFileSync(join(copy, 'package.json'), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`)
  change(copy)
  const built = run(copy, process.execPath, [join(copy, 'scripts', 'bundle.mjs')])
  assert.equal(built.status, 0, built.out)
  return copy
}

const update = (r, ...args) => r.node(CLI, 'update', ...args)
// Windows keeps no executable bit on disk; there the commit command stages the hooks as executable.
const executable = (r, path) => process.platform === 'win32' || (statSync(join(r.root, path)).mode & 0o111) !== 0

describe('a clean update', () => {
  const r = setUp()
  const result = update(r)

  test('finds every managed file unchanged and writes nothing', () => {
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /Unchanged \(7\):\n {2}ledger\/scripts\/records\.mjs\n {2}\.githooks\/pre-commit\n {2}\.githooks\/pre-merge-commit\n {2}\.githooks\/commit-msg\n {2}\.githooks\/pre-push\n {2}\.gitattributes\n {2}AGENTS\.md \(managed block\)\n/)
    assert.match(result.out, /Nothing to change\./)
    assert.equal(r.git('status', '--porcelain').out, '')
  })
})

describe('an update from a released version', () => {
  // An older release whose pre-commit hook and AGENTS.md block were worded differently,
  // with its hashes recorded by the release script as at a real release.
  const old = packageCopy('0.9.0', (copy) => {
    const hook = join(copy, 'templates', 'hooks', 'pre-commit')
    writeFileSync(hook, readFileSync(hook, 'utf8').replace('#!/bin/sh\n', '#!/bin/sh\n# an older wording\n'))
    const block = join(copy, 'templates', 'agents-block.md')
    writeFileSync(block, readFileSync(block, 'utf8').replace('## How work is recorded here', '## How work is recorded'))
  })
  const released = run(old, process.execPath, [join(old, 'scripts', 'release-hashes.mjs')])
  // This version's package, which knows the older release from its table.
  const current = packageCopy(VERSION, (copy) => cpSync(join(old, 'templates', 'released.json'), join(copy, 'templates', 'released.json')))
  const r = setUp(join(old, 'bin', 'resaledger.mjs'), { 'AGENTS.md': '# Rules\n\nThe project\'s own text.\n' })
  r.append('AGENTS.md', '\nText after the block.\n')
  assert.equal(r.commit('docs: add to the rules', 'Task: maintenance').status, 0)
  const before = r.read('AGENTS.md')
  const result = r.node(join(current, 'bin', 'resaledger.mjs'), 'update')

  test('the release script records the older version', () => {
    assert.equal(released.status, 0, released.out)
    const table = JSON.parse(readFileSync(join(old, 'templates', 'released.json'), 'utf8'))
    assert.deepEqual(Object.keys(table).sort(), ['agents-block', 'guard', 'hooks/commit-msg', 'hooks/pre-commit', 'hooks/pre-merge-commit', 'hooks/pre-push'])
    for (const versions of Object.values(table)) assert.deepEqual(Object.keys(versions), ['0.9.0'])
    const check = run(old, process.execPath, [join(old, 'scripts', 'release-hashes.mjs'), '--check'])
    assert.equal(check.status, 0, check.out)
  })

  test('replaces the files that are the older release and keeps the rest', () => {
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /Replaced \(3\):\n {2}ledger\/scripts\/records\.mjs \(was 0\.9\.0\)\n {2}\.githooks\/pre-commit \(was 0\.9\.0\)\n {2}AGENTS\.md \(managed block\) \(was 0\.9\.0\)\n/)
    assert.match(result.out, /Unchanged \(4\):\n {2}\.githooks\/pre-merge-commit\n {2}\.githooks\/commit-msg\n {2}\.githooks\/pre-push\n {2}\.gitattributes\n/)
    assert.equal(r.read(GUARD), readFileSync(join(current, 'dist', 'records.mjs'), 'utf8'))
    assert.ok(executable(r, GUARD))
    assert.doesNotMatch(r.read('.githooks/pre-commit'), /an older wording/)
    assert.ok(executable(r, '.githooks/pre-commit'))
  })

  test('changes only the block in AGENTS.md', () => {
    const after = r.read('AGENTS.md')
    assert.match(after, /^# Rules\n\nThe project's own text\.\n\n<!-- resaledger:start/)
    assert.match(after, /## How work is recorded here\n/)
    assert.match(after, /<!-- resaledger:end -->\n\nText after the block\.\n$/)
    assert.notEqual(after, before)
  })

  test('never touches the README, the configuration or the records', () => {
    const changed = r.git('status', '--porcelain').out.split('\n').filter(Boolean).map((line) => line.slice(3)).sort()
    assert.deepEqual(changed, ['.githooks/pre-commit', 'AGENTS.md', GUARD])
  })

  test('prints a commit command that commits through the new hooks, and a second run changes nothing', () => {
    const command = printedCommit(result.out)
    assert.equal(
      command,
      `git add AGENTS.md ${GUARD} && git add --chmod=+x .githooks/pre-commit && git commit -m "chore: update ResaLedger to ${VERSION}" -m "Task: maintenance"`
    )
    const committed = r.run('sh', ['-c', command])
    assert.equal(committed.status, 0, committed.out)
    const again = r.node(join(current, 'bin', 'resaledger.mjs'), 'update')
    assert.equal(again.status, 0, again.out)
    assert.match(again.out, /Unchanged \(7\)/)
    assert.match(again.out, /Nothing to change\./)
  })
})

describe('the LF rule for the hooks in .gitattributes', () => {
  test('an install without it gets it as one listed change, which commits through the hooks', () => {
    const r = setUp(CLI, { '.gitattributes': '*.png binary\n' })
    assert.equal(r.read('.gitattributes'), '*.png binary\n.githooks/* text eol=lf\n')
    // An install from before the rule: the line is gone.
    r.write('.gitattributes', '*.png binary\n')
    assert.equal(r.commit('chore: an older install', 'Task: maintenance').status, 0)
    const result = update(r)
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /Replaced \(1\):\n {2}\.gitattributes: the line "\.githooks\/\* text eol=lf" added\n/)
    assert.equal(r.read('.gitattributes'), '*.png binary\n.githooks/* text eol=lf\n')
    const command = printedCommit(result.out)
    assert.equal(command, `git add .gitattributes && git commit -m "chore: update ResaLedger to ${VERSION}" -m "Task: maintenance"`)
    const committed = r.run('sh', ['-c', command])
    assert.equal(committed.status, 0, committed.out)
    const again = update(r)
    assert.match(again.out, /Nothing to change\./)
  })

  test('a missing .gitattributes is restored with the rule, and an equivalent rule is left alone', () => {
    const r = setUp()
    assert.equal(r.git('rm', '-q', '.gitattributes').status, 0)
    assert.equal(r.commit('chore: drop the attributes', 'Task: maintenance').status, 0)
    const restored = update(r)
    assert.match(restored.out, /Restored \(1\):\n {2}\.gitattributes: the line "\.githooks\/\* text eol=lf" added\n/)
    assert.equal(r.read('.gitattributes'), '.githooks/* text eol=lf\n')
    r.write('.gitattributes', '* text=auto eol=lf\n')
    assert.equal(r.commit('chore: one rule for every file', 'Task: maintenance').status, 0)
    const kept = update(r)
    assert.match(kept.out, /Nothing to change\./)
    assert.equal(r.read('.gitattributes'), '* text=auto eol=lf\n')
  })
})

describe('a hand-edited hook', () => {
  const r = setUp()
  r.append('.githooks/pre-push', 'echo "my own step"\n')
  const edited = r.read('.githooks/pre-push')
  const refused = update(r)
  const kept = r.read('.githooks/pre-push')
  const forced = update(r, '--force')

  test('is kept, with a diff and the way to replace it', () => {
    assert.equal(refused.status, 1, refused.out)
    assert.match(refused.out, /Kept \(1\):\n {2}\.githooks\/pre-push: changed by hand, so it is kept\n/)
    assert.match(refused.out, /\n {6}- echo "my own step"\n/)
    assert.match(refused.out, /run "npx resaledger update --force" to replace it/)
    assert.equal(kept, edited)
  })

  test('is replaced with --force', () => {
    assert.equal(forced.status, 0, forced.out)
    assert.match(forced.out, /Replaced \(1\):\n {2}\.githooks\/pre-push: changed by hand, replaced with --force\n/)
    assert.doesNotMatch(r.read('.githooks/pre-push'), /my own step/)
    assert.equal(r.read('.githooks/pre-push'), readFileSync(join(PACKAGE, 'templates', 'hooks', 'pre-push'), 'utf8').replaceAll('{{dir}}', 'ledger'))
    assert.ok(executable(r, '.githooks/pre-push'))
  })
})

describe('a hand-edited managed block', () => {
  const r = setUp(CLI, { 'AGENTS.md': '# Rules\n\nOwn text.\n' })
  r.write('AGENTS.md', r.read('AGENTS.md').replace('Decisions go into', 'Decisions always go into'))
  const edited = r.read('AGENTS.md')
  const refused = update(r)
  const kept = r.read('AGENTS.md')
  const forced = update(r, '--force')

  test('is kept, with a diff of the block only', () => {
    assert.equal(refused.status, 1, refused.out)
    assert.match(refused.out, /Kept \(1\):\n {2}AGENTS\.md \(managed block\): changed by hand, so it is kept\n/)
    assert.match(refused.out, /- Decisions always go into/)
    assert.match(refused.out, /\+ Decisions go into/)
    assert.doesNotMatch(refused.out, /Own text/)
    assert.equal(kept, edited)
  })

  test('is replaced with --force, keeping the project\'s own text', () => {
    assert.equal(forced.status, 0, forced.out)
    const text = r.read('AGENTS.md')
    assert.match(text, /^# Rules\n\nOwn text\.\n\n<!-- resaledger:start/)
    assert.doesNotMatch(text, /Decisions always/)
    assert.equal(r.git('status', '--porcelain').out, '') // back to the committed block
  })
})

describe('the guard\'s calls in husky\'s hooks', () => {
  const r = setUp(CLI, { '.husky/pre-commit': 'npm run lint\n', 'package.json': '{ "name": "app", "scripts": { "prepare": "husky" } }\n' })
  r.write('.husky/pre-push', '')
  r.write('.husky/commit-msg', r.read('.husky/commit-msg').replace('commit-msg "$1"', 'commit-msg "$1" || true'))
  const refused = update(r)
  const forced = update(r, '--force')

  test('a missing call is restored and an edited one is kept, with its diff', () => {
    assert.equal(refused.status, 1, refused.out)
    assert.match(refused.out, /Restored \(1\):\n {2}\.husky\/pre-push: the guard's call\n/)
    assert.match(refused.out, /Kept \(1\):\n {2}\.husky\/commit-msg: the guard's call was changed by hand, so it is kept\n/)
    assert.match(refused.out, /- node "ledger\/scripts\/records\.mjs" commit-msg "\$1" \|\| true\n {6}\+ node "ledger\/scripts\/records\.mjs" commit-msg "\$1"/)
    assert.match(r.read('.husky/pre-push'), /^# resaledger: pre-push call, managed by ResaLedger; do not edit\nnode "ledger\/scripts\/records\.mjs" pre-push "\$@"\n$/)
    assert.equal(r.read('.husky/pre-commit'), 'npm run lint\n# resaledger: pre-commit call, managed by ResaLedger; do not edit\nnode "ledger/scripts/records.mjs" pre-commit\n')
  })

  test('--force replaces the edited call and nothing else', () => {
    assert.equal(forced.status, 0, forced.out)
    assert.match(forced.out, /Replaced \(1\):\n {2}\.husky\/commit-msg: the guard's call, changed by hand, replaced with --force\n/)
    assert.match(r.read('.husky/commit-msg'), /^# resaledger: commit-msg call, managed by ResaLedger; do not edit\nnode "ledger\/scripts\/records\.mjs" commit-msg "\$1"\n$/)
  })
})

describe('a setup from before pre-merge-commit was shipped', () => {
  const r = setUp()
  r.git('rm', '-q', '.githooks/pre-merge-commit')
  assert.equal(r.git('commit', '-q', '-m', 'chore: an older setup', '-m', 'Task: maintenance').status, 0)
  const off = r.node(GUARD, 'hooks')
  const result = update(r)

  test('has its hooks reported as off, and update restores the hook', () => {
    assert.equal(off.status, 1, off.out)
    assert.match(off.out, /the git hooks are not active in this clone/)
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /Restored \(1\):\n {2}\.githooks\/pre-merge-commit\n/)
    assert.equal(r.read('.githooks/pre-merge-commit'), readFileSync(join(PACKAGE, 'templates', 'hooks', 'pre-merge-commit'), 'utf8').replaceAll('{{dir}}', 'ledger'))
    assert.ok(executable(r, '.githooks/pre-merge-commit'))
    assert.match(printedCommit(result.out), /git add --chmod=\+x \.githooks\/pre-merge-commit/)
    assert.equal(r.node(GUARD, 'hooks').status, 0)
  })
})

describe('a missing guard', () => {
  const r = setUp()
  rmSync(join(r.root, GUARD))
  const passed = r.node(CLI, 'work')
  const result = update(r)

  test('a guard command says to run update', () => {
    assert.equal(passed.status, 1)
    assert.match(passed.out, /the guard ledger\/scripts\/records\.mjs is missing; run "npx resaledger update" to restore it/)
  })

  test('is restored, executable, and the tree is clean again', () => {
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /Restored \(1\):\n {2}ledger\/scripts\/records\.mjs\n/)
    assert.equal(r.read(GUARD), readFileSync(join(PACKAGE, 'dist', 'records.mjs'), 'utf8'))
    assert.ok(executable(r, GUARD))
    assert.equal(r.git('status', '--porcelain').out, '')
  })
})

describe('a guard newer than the package', () => {
  const r = setUp()
  r.write('.githooks/pre-push', '#!/bin/sh\necho edited\n')
  const newer = r.read(GUARD).replace(`// ResaLedger ${VERSION}\n`, '// ResaLedger 99.0.0\n')
  r.write(GUARD, newer)
  const result = update(r, '--force')

  test('is refused, even with --force, and nothing is written', () => {
    assert.equal(result.status, 1, result.out)
    assert.match(result.out, /✖ resaledger update changed nothing:\n {2}✖ ledger\/scripts\/records\.mjs is ResaLedger 99\.0\.0, newer than this package/)
    assert.match(result.out, /run "npx resaledger@latest update" instead/)
    assert.equal(r.read(GUARD), newer)
    assert.equal(r.read('.githooks/pre-push'), '#!/bin/sh\necho edited\n')
  })
})

describe('update without a ResaLedger workspace', () => {
  test('says to run init, or migrate for a 0.x workspace', () => {
    const r = repository()
    const plain = update(r)
    assert.equal(plain.status, 1)
    assert.match(plain.out, /\.resaledger\.json is missing: ResaLedger is not set up in this repository\. Run "npx resaledger init"/)
    r.write('.agent-ledger.json', '{}\n')
    const legacy = update(r)
    assert.equal(legacy.status, 1)
    assert.match(legacy.out, /Run "npx resaledger migrate"/)
  })
})

describe('commands passed to the repository\'s guard', () => {
  const r = setUp(CLI, {}, '--team')
  const sub = join(r.root, 'src', 'deep')
  mkdirSync(sub, { recursive: true })
  const head = r.git('rev-parse', 'HEAD').out.trim()
  const zero = '0'.repeat(40)
  const pushToMain = `refs/heads/setup ${head} refs/heads/main ${zero}\n`

  test('run from a subfolder with the guard\'s output and exit code', () => {
    const direct = r.node(GUARD, 'task', 'ZZ9')
    const passed = run(sub, process.execPath, [CLI, 'task', 'ZZ9'])
    assert.equal(direct.status, 1, direct.out)
    assert.equal(passed.status, direct.status)
    assert.equal(passed.out, direct.out)
    const work = run(sub, process.execPath, [CLI, 'work'])
    assert.equal(work.status, 0, work.out)
  })

  test('pass stdin on, as pre-push needs it', () => {
    const refused = run(sub, process.execPath, [CLI, 'pre-push', 'origin', 'example'], pushToMain)
    assert.equal(refused.status, 1, refused.out)
    assert.match(refused.out, /main: "main" is a protected branch/)
    const empty = run(sub, process.execPath, [CLI, 'pre-push', 'origin', 'example'], '')
    assert.equal(empty.status, 0, empty.out)
  })

  test('without a configuration, say to run init or migrate', () => {
    const plain = repository()
    const init = plain.node(CLI, 'work')
    assert.equal(init.status, 1)
    assert.match(init.out, /\.resaledger\.json is missing\); run "npx resaledger init"/)
    plain.write('.agent-ledger.json', '{}\n')
    const migrate = plain.node(CLI, 'work')
    assert.equal(migrate.status, 1)
    assert.match(migrate.out, /run "npx resaledger migrate"/)
  })
})

describe('the helpers', () => {
  test('compareVersions orders releases and pre-releases', () => {
    const sorted = ['1.0.0', '0.9.0', '1.0.0-rc.2', '1.0.0-rc.10', '1.0.0-dev.0', '1.1.0', '1.0.0-rc.1'].sort(compareVersions)
    assert.deepEqual(sorted, ['0.9.0', '1.0.0-dev.0', '1.0.0-rc.1', '1.0.0-rc.2', '1.0.0-rc.10', '1.0.0', '1.1.0'])
  })

  test('normalizeManaged puts the folder back as {{dir}} only where it starts a path', () => {
    assert.equal(normalizeManaged('node "records/scripts/x" in `records/`\r\nmyrecords/ x.records/\n\n', 'records'), 'node "{{dir}}/scripts/x" in `{{dir}}/`\nmyrecords/ x.records/')
  })

  test('guardVersion reads the second line', () => {
    assert.equal(guardVersion('#!/usr/bin/env node\n// ResaLedger 1.2.3\n'), '1.2.3')
    assert.equal(guardVersion('#!/usr/bin/env node\nconsole.log(1)\n'), null)
  })

  test('withVersionHashes adds a version and keeps the others in order', () => {
    const table = withVersionHashes({ guard: { '1.0.0': 'a' } }, '0.9.0', { guard: 'b', 'hooks/pre-push': 'c' })
    assert.deepEqual(table, { guard: { '0.9.0': 'b', '1.0.0': 'a' }, 'hooks/pre-push': { '0.9.0': 'c' } })
    assert.deepEqual(Object.keys(table.guard), ['0.9.0', '1.0.0'])
  })

  test('compactDiff keeps the changes and two lines around them', () => {
    const diff = ['  1', '  2', '  3', '  4', '- 5', '+ 5b', '  6', '  7', '  8'].join('\n')
    assert.equal(compactDiff(diff), ['  …', '  3', '  4', '- 5', '+ 5b', '  6', '  7', '  …'].join('\n'))
  })
})
