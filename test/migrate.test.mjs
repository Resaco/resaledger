// `resaledger migrate` on real repositories built from synthetic agent-ledger 0.x workspaces:
// a whole migration that passes, every refusal, a hand-edited hook, an injected loss,
// --dry-run, a 1.0 problem, a second run, and this repository's own 0.x workspace.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { convertConfig, lineDiff, planMigration, UNDO_COMMAND } from '../src/cli/migrate.mjs'
import { legacyClone, PACKAGE, repository, run, temporary } from './helpers.mjs'

const CLI = join(PACKAGE, 'bin', 'resaledger.mjs')
const DIR = 'project'
const GUARD = `node ${DIR}/scripts/records.mjs`

// The git hooks and the pointer block as agent-ledger 0.3 wrote them for DIR.
const legacyHook = (comment, fix, call, what) => `#!/bin/sh
# agent-ledger: ${comment}
# Do not bypass with --no-verify; ${fix}
for runtime in node bun "$HOME/.bun/bin/bun" /opt/homebrew/bin/node /usr/local/bin/node; do
  if command -v "$runtime" >/dev/null 2>&1; then
    exec "$runtime" ${DIR}/scripts/records.mjs ${call}
  fi
done
echo "agent-ledger: neither node nor bun was found, so this ${what} cannot be checked" >&2
exit 1
`
const HOOKS = {
  'pre-commit': legacyHook(`Shape of the records, and the commit gates when code changes (${DIR}/standards.md).`, 'fix the records or the code instead.', 'pre-commit', 'commit'),
  'commit-msg': legacyHook(`Commit header and task trailer (${DIR}/standards.md#commits).`, 'fix the message or the ledger instead.', 'commit-msg "$1"', 'commit'),
  'pre-push': legacyHook('No pushes straight to a protected branch (.agent-ledger.json).', 'push your branch and open a pull request.', 'pre-push "$@"', 'push')
}
const POINTER = `<!-- agent-ledger:start -->
## Build workspace

The build in this repository is run from [\`${DIR}/\`](${DIR}/README.md). Before any work, read [\`${DIR}/AGENTS.md\`](${DIR}/AGENTS.md) and [\`${DIR}/STATUS.md\`](${DIR}/STATUS.md), then run \`${GUARD} work\`. Before you stop, run \`${GUARD} handoff\`.
<!-- agent-ledger:end -->
`

const CONFIG = {
  version: 1,
  mode: 'ledger',
  dir: DIR,
  aiAttribution: 'forbid',
  codePaths: [],
  gates: { commit: [], verify: [], skipPaths: ['docs'] },
  commitStyle: 'conventional',
  branches: { protected: [], pattern: '' },
  requirePushed: false,
  agent: { deny: [{ pattern: 'git\\s+push', reason: 'Only the owner pushes.' }] },
  customKey: { kept: true }
}

const LEDGER = `# Task ledger

Every task, in the order it should be done. Format and rules: [standards.md](../standards.md#the-task-ledger).

## A: Groundwork

Text under the phase heading, before its first task.

### A1 Lay the base
- Status: done
- Depends on: —
- Plan: [A-groundwork.md](../plan/A-groundwork.md#a1-lay-the-base)
- Evidence: \`npm test\`: 12 of 12.
  The second line of the evidence, indented.
- Notes: Built as planned; see [A2](#a2-another-task) and [the session](log.md#2026-03-04--session-1-claude-opus-55).

Afterwards a paragraph about the task.

- a bullet after the fields

### A1.1 A child task
- Status: doing
- Lane: feature/a11
- Depends on: A1
- Plan: [A-groundwork.md](../plan/A-groundwork.md#a11-a-child-task)
- Evidence: —
- Notes: Next: the second half of the child.

## B: The rest

### A2 Another task
- Status: doing
- Depends on: A1
- Plan: [A-groundwork.md](../plan/A-groundwork.md#a2-another-task)
- Evidence: —
- Notes: Half done; the tree is clean.

### A3 Waits
- Status: todo
- Depends on: A2
- Plan: —
- Evidence: —
- Notes: —
`

const LOG = `# Session log

What each session did, oldest first.

## 2026-03-04 · Session 1 (Claude Opus 5.5)

Laid the base. The separator is in [the decisions](../DECISIONS.md#2026-03-02).

### What was learned

- a detail

## 2026-03-04 · Session 1 (Claude Opus 5.5)

The same title on the same day, a second time.
`

const DECISIONS = `# Decisions

Decisions the owner made.

| Date | Decision | Decided by |
| --- | --- | --- |
| 2026-03-02 | Use \`a \\| b\` as the separator, because both sides read it. See [the plan](plan/A-groundwork.md). | Owner |
| 2026-03-03 | Keep the session log. | Lead agent |

Rows before March were reconstructed.
`

const STATUS = `# Status

Updated: 2026-03-04 · by the lead agent

## Phase

Building the base; [A2](work/ledger.md#a2-another-task) is next.

## Active work

A1.1 and A2.

## Last verified

- \`npm test\` passed.

## Next step

Finish A2.

## Waiting for the owner

- Approve the release plan.
`

const README = `# Sample workspace

Read in this order:

- [STATUS.md](STATUS.md): where the work stands.
- [AGENTS.md](AGENTS.md): the rules.
- [work/ledger.md](work/ledger.md): every task.

## What is being built

A small tool for counting things, for one team.

## Where the code is

- \`src/\`: the code.

## Environments

Local only.
`

const STANDARDS = `# Working standards

The session protocol is in [AGENTS.md](AGENTS.md).

## Who owns what

| File | Owns |
| --- | --- |
| [STATUS.md](STATUS.md) | Live state |

## Commits

Conventional Commits with a \`Task: <id>\` trailer.

## Quality gates

Before a task is \`done\`, two kinds of gates pass.

**Gates that need eyes or judgement** are listed here:

1. **The page looks right.** Compared at 375 and 1280 px.
   Passing: no overflow.
2. **The data comes out unchanged.** Passing: the diff is empty.

The last gate is always the same: \`${GUARD} handoff\` passes.

## Release checklist

Tag only from main, after the owner says so.
`

const AGENTS = `# Sample workspace: agent rules

These rules bind every agent.

## Start here, every session

1. Read [STATUS.md](STATUS.md).

## Project rules

1. **Tuotantoon ei kirjoiteta ilman lupaa.** Syy: asiakkaan tiedot ovat siellä.
2. **Kaikki siirrot tehdään skriptillä.** Syy: käsin tehty vaihe unohtuu.

## Working agreements

- Records are written in English.

## Local conventions

Screenshots go into [progress/](progress/).
`

const PLAN = `# Groundwork

Status: approved · 2026-03-01 · Owner

## Tasks

### A1 Lay the base

Goal: the base. See the [ledger entry](../work/ledger.md#a1-lay-the-base) and the [status](../STATUS.md).

### A1.1 A child task

Goal: the child.

### A2 Another task

Goal: another.
`

const ROOT_README = `# Sample

The work is recorded in [the ledger](${DIR}/work/ledger.md#a2-another-task), with [a decision](${DIR}/DECISIONS.md#2026-03-02-keep) and [the stamp](${DIR}/work/verified.json).

\`\`\`md
[left alone](${DIR}/work/ledger.md)
\`\`\`
`

const SETTINGS = `{
  "permissions": {
    "allow": ["Bash(npm test)"]
  },
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node \\"$CLAUDE_PROJECT_DIR/${DIR}/scripts/records.mjs\\" hook session-start", "timeout": 20 }] }
    ],
    "PreToolUse": [
      { "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "command": "node \\"$CLAUDE_PROJECT_DIR/${DIR}/scripts/records.mjs\\" hook pre-tool", "timeout": 20 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node \\"$CLAUDE_PROJECT_DIR/${DIR}/scripts/records.mjs\\" hook stop", "timeout": 20 }] }
    ]
  }
}
`

/** A repository holding a committed 0.x workspace. claude: 'file', 'link' or 'none'. */
function legacyRepository({ claude = 'file', files = {} } = {}) {
  const r = repository()
  const all = {
    '.agent-ledger.json': `${JSON.stringify(CONFIG, null, 2)}\n`,
    '.gitattributes': `* text=auto\n\n# agent-ledger: records that only grow at the end merge without conflicts\n${DIR}/work/log.md merge=union\n${DIR}/DECISIONS.md merge=union\n`,
    '.claude/settings.json': SETTINGS,
    'AGENTS.md': `# Sample\n\nThe project's own instructions.\n\n${POINTER}`,
    'README.md': ROOT_README,
    [`${DIR}/README.md`]: README,
    [`${DIR}/AGENTS.md`]: AGENTS,
    [`${DIR}/STATUS.md`]: STATUS,
    [`${DIR}/DECISIONS.md`]: DECISIONS,
    [`${DIR}/standards.md`]: STANDARDS,
    [`${DIR}/work/ledger.md`]: LEDGER,
    [`${DIR}/work/log.md`]: LOG,
    [`${DIR}/work/verified.json`]: '{ "fingerprint": "abc" }\n',
    [`${DIR}/plan/A-groundwork.md`]: PLAN,
    [`${DIR}/progress/2026-03-04/report.md`]: `# Report\n\nFor [A1](../../work/ledger.md#a1-lay-the-base).\n`,
    [`${DIR}/scripts/records.mjs`]: '#!/usr/bin/env node\n// agent-ledger 0.3.0\n',
    ...Object.fromEntries(Object.entries(HOOKS).map(([name, text]) => [`.githooks/${name}`, text])),
    ...files
  }
  if (claude === 'file') all['CLAUDE.md'] = `# Notes for Claude\n\nUse the test command.\n\n${POINTER}`
  for (const [path, text] of Object.entries(all)) if (text !== null) r.write(path, text)
  if (claude === 'link') symlinkSync('AGENTS.md', join(r.root, 'CLAUDE.md'))
  for (const name of Object.keys(HOOKS)) r.run('chmod', ['755', `.githooks/${name}`])
  const committed = r.commit('chore: a 0.x workspace')
  assert.equal(committed.status, 0, committed.out)
  return r
}

const migrate = (r, ...args) => r.node(CLI, 'migrate', ...args)

/** Every file under root except .git, as path → content (a link as "-> target"). */
function snapshot(root) {
  const files = new Map()
  const walk = (folder) => {
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
      const path = folder ? `${folder}/${entry.name}` : entry.name
      if (path === '.git') continue
      if (entry.isSymbolicLink()) files.set(path, `-> ${readlinkSync(join(root, path))}`)
      else if (entry.isDirectory()) walk(path)
      else files.set(path, readFileSync(join(root, path)).toString('base64'))
    }
  }
  walk('')
  return files
}

/** Asserts that a refused run printed the reason and changed nothing at all. */
function assertRefused(r, args, pattern) {
  const before = snapshot(r.root)
  const hooksPath = r.git('config', '--get', 'core.hooksPath').out
  const result = migrate(r, ...args)
  assert.equal(result.status, 1, result.out)
  assert.match(result.out, /changed nothing/)
  assert.match(result.out, pattern)
  assert.deepEqual(snapshot(r.root), before)
  assert.equal(r.git('config', '--get', 'core.hooksPath').out, hooksPath)
  return result
}

describe('migrate, from end to end', () => {
  const r = legacyRepository()
  const result = migrate(r)
  const read = (path) => r.read(path)
  const tasks = () => readdirSync(join(r.root, DIR, 'tasks')).sort()

  test('runs, writes the 1.0 files and passes check with the new guard', () => {
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /4 tasks, 2 decisions, 2 log entries/)
    assert.match(result.out, /Rename \(1\):\n {2}\.agent-ledger\.json → \.resaledger\.json/)
    assert.match(result.out, /✔ records valid: 4 tasks, 2 decisions, 3 log entries/)
    assert.match(
      result.out,
      /git add -A && git add --chmod=\+x \.githooks\/pre-commit \.githooks\/pre-merge-commit \.githooks\/commit-msg \.githooks\/pre-push && git commit -m "chore: migrate to ResaLedger 1\.0" -m "Task: maintenance"/
    )
    assert.match(result.out, /git restore -- :\/ && git clean -fd -- :\/ && git config --unset core\.hooksPath/)
    const check = r.node(`${DIR}/scripts/records.mjs`, 'check')
    assert.equal(check.status, 0, check.out)
    assert.equal(r.git('config', '--get', 'core.hooksPath').out.trim(), '.githooks')
    assert.equal(read(`${DIR}/scripts/records.mjs`), readFileSync(join(PACKAGE, 'dist', 'records.mjs'), 'utf8'))
    for (const name of Object.keys(HOOKS)) {
      assert.match(read(`.githooks/${name}`), /^# resaledger: .* hook, managed by ResaLedger; do not edit$/m)
      if (process.platform !== 'win32') assert.ok((lstatSync(join(r.root, '.githooks', name)).mode & 0o111) !== 0, name)
    }
  })

  test('removes the 0.x files and converts the configuration', () => {
    for (const path of ['.agent-ledger.json', 'AGENTS.md', 'STATUS.md', 'DECISIONS.md', 'standards.md', 'work/ledger.md', 'work/log.md', 'work/verified.json'])
      assert.equal(existsSync(join(r.root, path.startsWith('.') ? path : `${DIR}/${path}`)), false, path)
    assert.equal(existsSync(join(r.root, DIR, 'work')), false)
    assert.deepEqual(JSON.parse(read('.resaledger.json')), {
      version: 2,
      dir: DIR,
      aiAttribution: 'forbid',
      commitStyle: 'conventional',
      codePaths: [],
      protected: [],
      branchPattern: '',
      requirePushed: false,
      gates: { commit: [], verify: [] },
      agent: { deny: [{ pattern: 'git\\s+push', reason: 'Only the owner pushes.' }] }
    })
    assert.match(result.out, /keys with no 1\.0 meaning, kept in the migration's log entry: gates\.skipPaths, customKey/)
  })

  test('writes one file per task, with Lane and Handoff for doing tasks and the extra lines in Notes', () => {
    assert.deepEqual(tasks(), ['A1-lay-the-base.md', 'A1.1-a-child-task.md', 'A2-another-task.md', 'A3-waits.md'])
    assert.equal(
      read(`${DIR}/tasks/A1-lay-the-base.md`),
      `# A1 Lay the base

- Status: done
- Depends on: —
- Plan: [A-groundwork.md](../plan/A-groundwork.md#a1-lay-the-base)
- Evidence: \`npm test\`: 12 of 12.
  The second line of the evidence, indented.

## Notes

Built as planned; see [A2](A2-another-task.md) and [the session](../log/2026-03-04-session-1.md).

Afterwards a paragraph about the task.

- a bullet after the fields
`
    )
    assert.equal(
      read(`${DIR}/tasks/A1.1-a-child-task.md`),
      `# A1.1 A child task

- Status: doing
- Lane: feature/a11
- Depends on: A1
- Plan: [A-groundwork.md](../plan/A-groundwork.md#a11-a-child-task)
- Evidence: —

## Handoff

Next: the second half of the child.
`
    )
    assert.match(read(`${DIR}/tasks/A2-another-task.md`), /^- Status: doing\n- Lane: main\n- Depends on: A1\n/m)
    assert.match(read(`${DIR}/tasks/A2-another-task.md`), /## Handoff\n\nHalf done; the tree is clean\.\n$/)
    assert.equal(read(`${DIR}/tasks/A3-waits.md`), '# A3 Waits\n\n- Status: todo\n- Depends on: A2\n- Plan: —\n- Evidence: —\n')
  })

  test('writes log entries with unique slugs and the agent suffix kept, and one file per decision', () => {
    const log = readdirSync(join(r.root, DIR, 'log')).sort()
    assert.equal(log.length, 3)
    assert.deepEqual(log.slice(0, 2), ['2026-03-04-session-1-2.md', '2026-03-04-session-1.md'])
    assert.match(log[2], /^\d{4}-\d{2}-\d{2}-migrated-to-resaledger-1-0\.md$/)
    assert.match(read(`${DIR}/log/2026-03-04-session-1.md`), /^# 2026-03-04 · Session 1 \(Claude Opus 5\.5\)\n\nLaid the base\. The separator is in \[the decisions\]\(\.\.\/decisions\/2026-03-02-use-a-b-as-the-separator-because-both\.md\)\./)
    assert.equal(
      read(`${DIR}/decisions/2026-03-02-use-a-b-as-the-separator-because-both.md`),
      `# Use \`a | b\` as the separator, because both sides read it

- Date: 2026-03-02
- Decided by: Owner
- Status: accepted

Use \`a | b\` as the separator, because both sides read it. See [the plan](../plan/A-groundwork.md).
`
    )
    assert.match(read(`${DIR}/decisions/2026-03-03-keep-the-session-log.md`), /^- Decided by: Lead agent$/m)
  })

  test('the README gets Goal, Manual checks, the project sections of standards.md and At migration', () => {
    const readme = read(`${DIR}/README.md`)
    assert.match(readme, /^## Goal\n\nA small tool for counting things, for one team\.$/m)
    assert.doesNotMatch(readme, /What is being built/)
    assert.match(readme, /## Manual checks\n\n1\. \*\*The page looks right\.\*\* Compared at 375 and 1280 px\.\n {3}Passing: no overflow\.\n2\. /)
    assert.match(readme, /## Release checklist\n\nTag only from main, after the owner says so\./)
    assert.match(readme, /## At migration\n\n.*\n\n### Phase\n\nBuilding the base; \[A2\]\(tasks\/A2-another-task\.md\) is next\.\n\n### Waiting for the owner\n\n- Approve the release plan\.\n$/)
    assert.match(readme, /- \[STATUS\.md\]\(README\.md\): where the work stands\./)
    assert.match(readme, /- \[AGENTS\.md\]\(\.\.\/AGENTS\.md\): the rules\./)
    assert.match(readme, /- \[work\/ledger\.md\]\(tasks\/\): every task\./)
  })

  test('the root AGENTS.md loses the pointer and gets the project rules, the own sections and the managed block', () => {
    const agents = read('AGENTS.md')
    assert.doesNotMatch(agents, /agent-ledger:start/)
    const block = readFileSync(join(PACKAGE, 'templates', 'agents-block.md'), 'utf8').replaceAll('{{dir}}', DIR)
    assert.ok(agents.endsWith(block), agents)
    assert.ok(
      agents.startsWith(`# Sample

The project's own instructions.

## Project rules

1. **Tuotantoon ei kirjoiteta ilman lupaa.** Syy: asiakkaan tiedot ovat siellä.
2. **Kaikki siirrot tehdään skriptillä.** Syy: käsin tehty vaihe unohtuu.

## Local conventions

Screenshots go into [progress/](${DIR}/progress/).

<!-- resaledger:start`),
      agents
    )
  })

  test('CLAUDE.md as a separate file loses the pointer and imports AGENTS.md', () => {
    assert.equal(read('CLAUDE.md'), ['# Notes for Claude', '', 'Use the test command.', '', '@AGENTS.md', ''].join('\n'))
  })

  test('.claude/settings.json names the agent in its hook commands and keeps everything else', () => {
    const before = JSON.parse(SETTINGS)
    const after = JSON.parse(read('.claude/settings.json'))
    assert.deepEqual(after.permissions, before.permissions)
    const commands = Object.values(after.hooks).flatMap((entries) => entries.flatMap((entry) => entry.hooks.map((hook) => hook.command)))
    assert.deepEqual(commands, ['session-start', 'pre-tool', 'stop'].map((event) => `node "$CLAUDE_PROJECT_DIR/${DIR}/scripts/records.mjs" hook claude ${event}`))
    assert.equal(after.hooks.PreToolUse[0].matcher, before.hooks.PreToolUse[0].matcher)
    assert.equal(read('.claude/settings.json'), SETTINGS.replace(/records\.mjs\\" hook /g, 'records.mjs\\" hook claude '))
  })

  test('.gitattributes keeps its own rules, loses the union rules and gets the LF rule for the hooks', () => {
    assert.equal(read('.gitattributes'), '* text=auto\n.githooks/* text eol=lf\n')
  })

  test('links into the removed files are rewritten everywhere, and what cannot be is listed', () => {
    assert.match(read(`${DIR}/plan/A-groundwork.md`), /\[ledger entry\]\(\.\.\/tasks\/A1-lay-the-base\.md\) and the \[status\]\(\.\.\/README\.md\)/)
    assert.match(read(`${DIR}/progress/2026-03-04/report.md`), /\[A1\]\(\.\.\/\.\.\/tasks\/A1-lay-the-base\.md\)/)
    const root = read('README.md')
    assert.match(root, /\[the ledger\]\(project\/tasks\/A2-another-task\.md\)/)
    assert.match(root, /\[a decision\]\(project\/decisions\/2026-03-02-use-a-b-as-the-separator-because-both\.md\)/)
    assert.match(root, /\[the stamp\]\(project\/work\/verified\.json\)/)
    assert.match(root, /\[left alone\]\(project\/work\/ledger\.md\)/)
    assert.match(result.out, /Links that could not be rewritten \(1\):\n {2}README\.md:3: project\/work\/verified\.json \(project\/work\/verified\.json is removed by the migration\)/)
  })

  test('the log entry keeps, word for word, everything that has no other place', () => {
    const name = readdirSync(join(r.root, DIR, 'log')).find((file) => file.includes('migrated-to-resaledger'))
    const entry = read(`${DIR}/log/${name}`)
    assert.match(entry, /^# \d{4}-\d{2}-\d{2} · Migrated to ResaLedger 1\.0\n/)
    for (const text of [
      'Every task, in the order it should be done. Format and rules: [standards.md](../standards.md#the-task-ledger).',
      '## A: Groundwork\n\nText under the phase heading, before its first task.',
      '## B: The rest',
      '# Session log\n\nWhat each session did, oldest first.',
      '# Decisions\n\nDecisions the owner made.\n\nRows before March were reconstructed.',
      STATUS.trimEnd(),
      '## Who owns what',
      '## Commits\n\nConventional Commits with a `Task: <id>` trailer.',
      '## Start here, every session',
      '## Working agreements\n\n- Records are written in English.',
      '"gates.skipPaths": [\n    "docs"\n  ]',
      '"customKey": {\n    "kept": true\n  }'
    ])
      assert.ok(entry.includes(text), text)
    assert.doesNotMatch(entry, /Tuotantoon/)
    assert.doesNotMatch(entry, /## Release checklist/)
  })

  test('every line of the status file, standards.md, the workspace AGENTS.md and the log is in a new file', () => {
    const tree = run(r.root, 'git', ['ls-files', '-co', '--exclude-standard']).out.split('\n').filter((path) => path.endsWith('.md') && existsSync(join(r.root, path)))
    // Link targets may differ: moved text has its links rewritten relative to its new file.
    const comparable = (line) => line.trim().replace(/\]\([^)]*\)/g, ']()')
    const lines = new Set(tree.flatMap((path) => r.read(path).split('\n').map(comparable)))
    for (const text of [STATUS, STANDARDS, AGENTS, LOG.replace(/^## /gm, '# ')])
      for (const line of text.split('\n')) if (line.trim()) assert.ok(lines.has(comparable(line)), line)
  })

  test('a commit of the result passes the new hooks and leaves a clean tree', () => {
    const committed = r.commit('chore: migrate to ResaLedger 1.0', 'Task: maintenance')
    assert.equal(committed.status, 0, committed.out)
    assert.equal(r.git('status', '--porcelain').out, '')
    const check = r.node(`${DIR}/scripts/records.mjs`, 'check')
    assert.equal(check.status, 0, check.out)
  })

  test('says which branch the doing tasks without a Lane get', () => {
    assert.match(
      result.out,
      /\ndoing tasks without a Lane get Lane: main; run migrate on the branch the work continues on, or take them over with claim --take afterwards\.\n/
    )
  })

  test('running it again reports that the repository is already migrated', () => {
    assertRefused(r, [], /\.resaledger\.json exists: this repository is already migrated to ResaLedger 1\.0/)
  })
})

describe('CLAUDE.md as a link to AGENTS.md', () => {
  test('is left a link, and reads the new AGENTS.md', () => {
    const r = legacyRepository({ claude: 'link' })
    const result = migrate(r)
    assert.equal(result.status, 0, result.out)
    assert.ok(lstatSync(join(r.root, 'CLAUDE.md')).isSymbolicLink())
    assert.equal(readlinkSync(join(r.root, 'CLAUDE.md')), 'AGENTS.md')
    assert.match(r.read('CLAUDE.md'), /<!-- resaledger:start/)
    assert.doesNotMatch(r.read('CLAUDE.md'), /@AGENTS\.md/)
    assert.doesNotMatch(result.out, /^ {2}CLAUDE\.md$/m)
  })
})

describe('other shapes of a 0.x repository', () => {
  test('a pointer block changed by hand is removed and kept in the log entry, and no CLAUDE.md is created', () => {
    const pointer = POINTER.replace('Before you stop,', 'Read the plan too. Before you stop,')
    const r = legacyRepository({ claude: 'none', files: { 'AGENTS.md': `# Sample\n\n${pointer}` } })
    const result = migrate(r)
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /! the 0\.x pointer block in AGENTS\.md was changed by hand; it is removed and kept word for word in the migration's log entry/)
    assert.doesNotMatch(r.read('AGENTS.md'), /agent-ledger:start/)
    const name = readdirSync(join(r.root, DIR, 'log')).find((file) => file.includes('migrated-to-resaledger'))
    assert.ok(r.read(`${DIR}/log/${name}`).includes(pointer.trimEnd()))
    assert.equal(existsSync(join(r.root, 'CLAUDE.md')), false)
  })

  test('a blocked task gets Waiting for from its notes when they say it, and is a problem when they do not', () => {
    const blocked = (id, title, notes) => `\n### ${id} ${title}\n- Status: blocked\n- Depends on: —\n- Plan: —\n- Evidence: —\n- Notes: ${notes}\n`
    const ledger =
      LEDGER +
      blocked('B1', 'Waits in a later sentence', 'Live impact: none. Waits for the owner. The rest of the note stays.') +
      blocked('B2', 'Blocked at the start', 'Blocked on research: what the API offers.') +
      blocked('B3', 'Waiting with a colon', 'Waiting for: A2 to merge') +
      blocked('B5', 'Waits on a child task', 'Blocked by A1.1. The rest of the note.') +
      blocked('B4', 'Says nothing', 'The deploy needs a decision first.')
    const r = legacyRepository({ files: { [`${DIR}/work/ledger.md`]: ledger } })
    const dry = migrate(r, '--dry-run')
    assert.equal(dry.status, 1, dry.out)
    assert.match(dry.out, /Waiting for, taken from the notes of blocked tasks \(4\):\n {2}B1: owner\n {2}B2: research\n {2}B3: A2 to merge\n {2}B5: A1\.1\n/)
    assert.match(dry.out, /B4-says-nothing\.md:3: a blocked task needs "- Waiting for: <who or what>"/)
    assert.doesNotMatch(dry.out, /B[1235]-[\w-]+\.md:\d+: a blocked task needs/)

    const result = migrate(r, '--accept-problems')
    assert.equal(result.status, 0, result.out)
    assert.equal(
      r.read(`${DIR}/tasks/B1-waits-in-a-later-sentence.md`),
      '# B1 Waits in a later sentence\n\n- Status: blocked\n- Waiting for: owner\n- Depends on: —\n- Plan: —\n- Evidence: —\n\n## Notes\n\nLive impact: none. Waits for the owner. The rest of the note stays.\n'
    )
  })

  test('in a detached HEAD a doing task without a Lane is a problem, with a warning', () => {
    const r = legacyRepository()
    r.git('checkout', '-q', '--detach')
    const result = migrate(r, '--dry-run')
    assert.equal(result.status, 1, result.out)
    assert.match(result.out, /! A2 is doing, and HEAD is detached, so it has no lane/)
    assert.match(result.out, /A2-another-task\.md:3: a doing task needs a lane/)
  })
})

describe('a faithful conversion', () => {
  test('a duplicated field keeps the one that counts with its lines, and moves the earlier one with its lines to Notes, in order', () => {
    const task = `
### A4 Two evidence fields
- Status: done
- Depends on: —
- Plan: —
- Evidence: \`npm test\`: the first run.
  The first run's second line.
  The first run's third line.
- Evidence: \`npm test\`: the second run.
  The second run's second line.
- Notes: —
`
    const r = legacyRepository({ files: { [`${DIR}/work/ledger.md`]: LEDGER + task } })
    const result = migrate(r)
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /! project\/work\/ledger\.md:\d+: A4: a second "Evidence" field; the last one counts, as in 0\.x, and the earlier one and its continuation lines move to the task's Notes, word for word and in order/)
    assert.equal(
      r.read(`${DIR}/tasks/A4-two-evidence-fields.md`),
      `# A4 Two evidence fields

- Status: done
- Depends on: —
- Plan: —
- Evidence: \`npm test\`: the second run.
  The second run's second line.

## Notes

- Evidence: \`npm test\`: the first run.
  The first run's second line.
  The first run's third line.
`
    )
  })

  test('blank lines inside fenced code, and the project text around it, are kept as they were', () => {
    const code = '```text\nfirst\n\n\nafter two blank lines\n```'
    const readme = README.replace('Local only.\n', `Local only.\n\n\nTwo blank lines above this paragraph.\n\n${code}\n`)
    const agents = `# Sample\n\n${code}\n\n${POINTER}\nAfter the pointer.\n`
    const r = legacyRepository({ files: { [`${DIR}/README.md`]: readme, 'AGENTS.md': agents } })
    const result = migrate(r)
    assert.equal(result.status, 0, result.out)
    assert.ok(r.read(`${DIR}/README.md`).includes(`Local only.\n\n\nTwo blank lines above this paragraph.\n\n${code}\n\n## Manual checks`), r.read(`${DIR}/README.md`))
    assert.ok(r.read('AGENTS.md').startsWith(`# Sample\n\n${code}\n\nAfter the pointer.\n\n## Project rules`), r.read('AGENTS.md'))
  })

  test('a standards.md anchor that is not a manual check is listed, an HTML link is listed, and a link in indented code is left alone', () => {
    const extra = [
      '',
      'See [the commit rules](../standards.md#commits), [the gates](../standards.md#quality-gates) and [the release](../standards.md#release-checklist).',
      '',
      '<a href="../work/ledger.md#a1-lay-the-base">the ledger entry</a>',
      '',
      '    [indented code](../work/ledger.md)',
      ''
    ]
    const plan = PLAN + extra.join('\n')
    const r = legacyRepository({ files: { [`${DIR}/plan/A-groundwork.md`]: plan } })
    const result = migrate(r)
    assert.equal(result.status, 0, result.out)
    const lines = plan.split('\n')
    const lineOf = (text) => lines.findIndex((line) => line.includes(text)) + 1
    const after = r.read(`${DIR}/plan/A-groundwork.md`)
    assert.ok(after.includes('See [the commit rules](../README.md#manual-checks), [the gates](../README.md#manual-checks) and [the release](../README.md#release-checklist).'), after)
    assert.match(
      result.out,
      new RegExp(`project/plan/A-groundwork\\.md:${lineOf('the commit rules')}: \\.\\./standards\\.md#commits → \\.\\./README\\.md#manual-checks \\(#commits is not a manual check; the link goes to the README's Manual checks\\)`)
    )
    assert.doesNotMatch(result.out, /standards\.md#(quality-gates|release-checklist) →/)
    assert.ok(after.includes('<a href="../work/ledger.md#a1-lay-the-base">the ledger entry</a>'))
    assert.match(
      result.out,
      new RegExp(`project/plan/A-groundwork\\.md:${lineOf('<a href')}: \\.\\./work/ledger\\.md#a1-lay-the-base \\(an HTML link, which migrate does not rewrite; change it to \\.\\./tasks/A1-lay-the-base\\.md\\)`)
    )
    assert.ok(after.includes('    [indented code](../work/ledger.md)'))
    assert.doesNotMatch(result.out, /indented code|A-groundwork\.md:\d+: \.\.\/work\/ledger\.md \(/)
  })

  test('the README, AGENTS.md and CLAUDE.md keep their byte order mark and CRLF line endings', () => {
    const windows = (text) => `﻿${text.replace(/\n/g, '\r\n')}`
    const r = legacyRepository({
      claude: 'none',
      files: {
        '.gitattributes': null,
        [`${DIR}/README.md`]: windows(README),
        'AGENTS.md': windows(`# Sample\n\nThe project's own instructions.\n\n${POINTER}`),
        'CLAUDE.md': windows(`# Notes for Claude\n\nUse the test command.\n\n${POINTER}`)
      }
    })
    const result = migrate(r)
    assert.equal(result.status, 0, result.out)
    for (const path of [`${DIR}/README.md`, 'AGENTS.md', 'CLAUDE.md']) {
      const text = r.read(path)
      assert.ok(text.startsWith('﻿'), `${path} lost its byte order mark`)
      assert.ok(text.includes('\r\n'), path)
      assert.doesNotMatch(text, /(?<!\r)\n/, `${path} has a line that does not end in CRLF`)
    }
    assert.match(r.read(`${DIR}/README.md`), /\r\n## Goal\r\n/)
    assert.equal(r.read('CLAUDE.md'), windows('# Notes for Claude\n\nUse the test command.\n\n@AGENTS.md\n'))
    const check = r.node(`${DIR}/scripts/records.mjs`, 'check')
    assert.equal(check.status, 0, check.out)
  })

  test('a 0.x guard without its version line is warned about and replaced', () => {
    const r = legacyRepository({ files: { [`${DIR}/scripts/records.mjs`]: '#!/usr/bin/env node\n// my own guard\nconsole.log("checked")\n' } })
    const result = migrate(r)
    assert.equal(result.status, 0, result.out)
    assert.match(
      result.out,
      /! project\/scripts\/records\.mjs has no "\/\/ agent-ledger 0\.x\.y" version line near its top, which every released 0\.x guard has, so it was changed by hand or is not agent-ledger's guard; it is replaced with the 1\.0 guard, and the old one stays in git history/
    )
    assert.equal(r.read(`${DIR}/scripts/records.mjs`), readFileSync(join(PACKAGE, 'dist', 'records.mjs'), 'utf8'))
  })

  test('a released 0.x guard is replaced without a warning', () => {
    const r = legacyRepository()
    assert.doesNotMatch(migrate(r, '--dry-run').out, /version line/)
  })
})

describe('refusals, each of which changes nothing', () => {
  test('a dirty tree', () => {
    const r = legacyRepository()
    r.write('notes.txt', 'work in progress\n')
    assertRefused(r, [], /uncommitted changes[\s\S]*\?\? notes\.txt/)
  })

  test('an untracked file that status.showUntrackedFiles hides, which the undo command would delete', () => {
    const r = legacyRepository()
    r.git('config', 'status.showUntrackedFiles', 'no')
    r.write('notes.txt', 'work in progress\n')
    assertRefused(r, [], /uncommitted changes[\s\S]*\?\? notes\.txt/)
  })

  test('a configuration version other than 1', () => {
    const r = legacyRepository({ files: { '.agent-ledger.json': JSON.stringify({ ...CONFIG, version: 3 }) } })
    assertRefused(r, [], /\.agent-ledger\.json: "version" is 3; only an agent-ledger 0\.x configuration \(version 1\) can be read/)
  })

  test('guard mode', () => {
    const r = legacyRepository({ files: { '.agent-ledger.json': JSON.stringify({ ...CONFIG, mode: 'guard' }) } })
    assertRefused(r, [], /guard-only mode is not part of ResaLedger 1\.0/)
  })

  test('a missing file', () => {
    const r = legacyRepository({ files: { [`${DIR}/STATUS.md`]: null } })
    assertRefused(r, [], /project\/STATUS\.md: is missing; every 0\.x workspace has it/)
  })

  test('no 0.x configuration at all', () => {
    const r = repository()
    r.write('README.md', '# Nothing here\n')
    r.commit('docs: a readme')
    assertRefused(r, [], /\.agent-ledger\.json: is missing in the repository root/)
  })

  test('an existing .resaledger.json', () => {
    const r = legacyRepository({ files: { '.resaledger.json': '{ "version": 2 }\n' } })
    assertRefused(r, ['--dry-run'], /already migrated/)
  })

  test('a workspace folder whose name would break out of the hooks', () => {
    const r = legacyRepository({ files: { '.agent-ledger.json': JSON.stringify({ ...CONFIG, dir: 'x"; touch pwned; "' }) } })
    assertRefused(r, [], /\.agent-ledger\.json: "dir" is "x\\"; touch pwned; \\""; ResaLedger 1\.0 pastes it into the git hooks, so it must be '\/'-separated names/)
    assert.equal(existsSync(join(r.root, 'pwned')), false)
  })

  test('an unknown option', () => {
    const r = legacyRepository()
    const result = migrate(r, '--yes')
    assert.equal(result.status, 1)
    assert.match(result.out, /unknown option "--yes" for migrate/)
  })
})

describe('the LF rule for the hooks and a protected base', () => {
  const UNION = `# agent-ledger: records that only grow at the end merge without conflicts\n${DIR}/work/log.md merge=union\n${DIR}/DECISIONS.md merge=union\n`

  test('a .gitattributes with only the union rules keeps only the LF rule, and a missing one is created', () => {
    for (const before of [UNION, null]) {
      const r = legacyRepository({ files: { '.gitattributes': before } })
      const result = migrate(r)
      assert.equal(result.status, 0, result.out)
      assert.equal(r.read('.gitattributes'), '.githooks/* text eol=lf\n')
    }
  })

  test('an existing LF rule is kept as it is', () => {
    const r = legacyRepository({ files: { '.gitattributes': `* text=auto eol=lf\n${UNION}` } })
    assert.equal(migrate(r).status, 0)
    assert.equal(r.read('.gitattributes'), '* text=auto eol=lf\n')
  })

  test('on a protected base, the printed steps commit the migration on a setup branch and push it', () => {
    const r = legacyRepository({ files: { '.agent-ledger.json': JSON.stringify({ ...CONFIG, branches: { protected: ['main'], pattern: '' } }) } })
    r.remote()
    assert.equal(r.push('main').status, 0)
    const result = migrate(r)
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /1\. "main" is protected, so commit the migration on a new branch:\n {7}git switch -c resaledger-setup && git add -A && /)
    assert.match(result.out, /2\. Push it and open a pull request into main; the first pull request that adds ResaLedger is judged by its own rules:\n {7}git push -u origin resaledger-setup\n/)
    const commands = result.out.split('\n').map((line) => line.trim())
    const commit = commands.find((line) => line.startsWith('git switch -c'))
    const push = commands.find((line) => line.startsWith('git push'))
    // Without the branch, the new pre-commit hook refuses the commit on main.
    const onMain = r.run('sh', ['-c', commit.replace('git switch -c resaledger-setup && ', '')])
    assert.notEqual(onMain.status, 0, onMain.out)
    assert.match(onMain.out, /"main" is a protected branch/)
    const committed = r.run('sh', ['-c', commit])
    assert.equal(committed.status, 0, committed.out)
    assert.equal(r.git('symbolic-ref', '--short', 'HEAD').out.trim(), 'resaledger-setup')
    assert.equal(r.git('status', '--porcelain').out, '')
    assert.match(r.git('log', '-1', '--format=%B').out, /^chore: migrate to ResaLedger 1\.0\n\nTask: maintenance\n/)
    const pushed = r.run('sh', ['-c', push])
    assert.equal(pushed.status, 0, pushed.out)
    assert.equal(r.git('rev-parse', 'origin/resaledger-setup').out, r.git('rev-parse', 'HEAD').out)
  })
})

describe('data safety at the edges of git', () => {
  test('a .gitignore rule that matches a folder migrate writes into is refused, naming the rule', () => {
    const r = legacyRepository({ files: { '.gitignore': '# build output\nnode_modules/\nlog/\n' } })
    assertRefused(r, [], /\.gitignore:3: log\/ ignores project\/log\/2026-03-04-session-1-2\.md and 2 more, so the files migrate writes there would never be committed; change the rule/)
  })

  test("a rule in the user's global excludes file is refused too", () => {
    const r = legacyRepository()
    const excludes = join(r.base, 'global-excludes')
    writeFileSync(excludes, '*.swp\ntasks/\n')
    r.git('config', '--global', 'core.excludesFile', excludes)
    try {
      assertRefused(r, [], /global-excludes:2: tasks\/ ignores project\/tasks\/A1-lay-the-base\.md and 3 more, so the files migrate writes there would never be committed/)
    } finally {
      r.git('config', '--global', '--unset', 'core.excludesFile')
    }
  })

  test('an ignored stamp that git does not track is left where it is, with a warning', () => {
    const r = legacyRepository({ files: { '.gitignore': 'verified.json\n' } })
    assert.equal(r.git('ls-files', `${DIR}/work/verified.json`).out, '')
    const result = migrate(r)
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /! project\/work\/verified\.json is not tracked, so migrate leaves it/)
    assert.ok(existsSync(join(r.root, DIR, 'work', 'verified.json')))
  })

  const unprivileged = process.platform !== 'win32' && process.getuid?.() !== 0
  test('a failure halfway through writing prints the undo command, which restores everything', { skip: !unprivileged && 'needs a read-only folder: not on Windows or as root' }, () => {
    const r = legacyRepository()
    // An empty folder is not part of the tree, so the run is not refused; it cannot take files.
    mkdirSync(join(r.root, DIR, 'tasks'))
    chmodSync(join(r.root, DIR, 'tasks'), 0o555)
    const before = snapshot(r.root)
    const result = migrate(r)
    assert.equal(result.status, 1, result.out)
    assert.match(result.out, /✖ writing the migration failed: .*EACCES/)
    assert.match(result.out, /Some files were already written/)
    assert.ok(result.out.includes(`\n  ${UNDO_COMMAND}\n`), result.out)
    assert.notDeepEqual(snapshot(r.root), before)
    assert.equal(r.git('config', '--get', 'core.hooksPath').out, '')
    const undo = r.run('sh', ['-c', UNDO_COMMAND])
    assert.equal(undo.status, 0, undo.out)
    assert.deepEqual(snapshot(r.root), before)
    assert.equal(r.git('status', '--porcelain', '--untracked-files=all').out, '')
  })

  test('a byte that is not UTF-8 in a file whose links are rewritten is refused, naming the line', () => {
    const r = legacyRepository()
    const plan = Buffer.concat([Buffer.from('# Groundwork\n\nStatus: approved \x2d it'), Buffer.from([0x92]), Buffer.from('s fine\n'), Buffer.from(PLAN.split('\n').slice(3).join('\n'))])
    writeFileSync(join(r.root, DIR, 'plan', 'A-groundwork.md'), plan)
    r.commit('docs: a plan saved in cp1252')
    assertRefused(r, [], /project\/plan\/A-groundwork\.md:3: this line has a byte that is not UTF-8, which migrate would replace; re-save the file as UTF-8/)
  })

  test('a byte that is not UTF-8 in a decision is refused, naming the line', () => {
    const r = legacyRepository()
    const decisions = DECISIONS.replace('Keep the session log.', 'Keep the session log\u0000.')
    const at = decisions.indexOf('\u0000')
    writeFileSync(join(r.root, DIR, 'DECISIONS.md'), Buffer.concat([Buffer.from(decisions.slice(0, at)), Buffer.from([0xe9]), Buffer.from(decisions.slice(at + 1))]))
    r.commit('docs: a decision saved in cp1252')
    assertRefused(r, [], /project\/DECISIONS\.md:8: this line has a byte that is not UTF-8/)
  })

  test('a workspace folder that is a symbolic link is refused', () => {
    const r = legacyRepository()
    r.git('mv', DIR, 'real')
    symlinkSync('real', join(r.root, DIR))
    assert.equal(r.commit('chore: the workspace behind a link').status, 0)
    assertRefused(r, [], /project is a symbolic link, so project\/\S+ and the other files migrate writes there would land wherever it points, outside what git tracks/)
  })

  test('a git hook that is a symbolic link is refused', () => {
    const r = legacyRepository({ files: { 'hooks/pre-commit': HOOKS['pre-commit'] } })
    rmSync(join(r.root, '.githooks', 'pre-commit'))
    symlinkSync('../hooks/pre-commit', join(r.root, '.githooks', 'pre-commit'))
    assert.equal(r.commit('chore: the hook behind a link').status, 0)
    assertRefused(r, [], /\.githooks\/pre-commit is a symbolic link, so migrate would overwrite the file it points to/)
  })

  test('two task ids that differ only in case get two file names that differ in more than case', () => {
    const task = (id) => `\n### ${id} Same name\n- Status: todo\n- Depends on: —\n- Plan: —\n- Evidence: —\n- Notes: —\n`
    const r = legacyRepository({ files: { [`${DIR}/work/ledger.md`]: LEDGER + task('A9') + task('a9') } })
    const plan = planMigration(r.root)
    assert.deepEqual(plan.refusals, [])
    const names = [...plan.writes.keys()].filter((path) => /\/tasks\/a9/i.test(path))
    assert.deepEqual(names.sort(), [`${DIR}/tasks/A9-same-name.md`, `${DIR}/tasks/a9-same-name-2.md`])
  })
})

describe('a git hook changed by hand', () => {
  const edited = HOOKS['pre-commit'].replace('exit 1\n', 'echo "custom check"\nexit 1\n')

  test('is refused with the difference, and replaced with --force', () => {
    const r = legacyRepository({ files: { '.githooks/pre-commit': edited } })
    const refused = assertRefused(r, [], /\.githooks\/pre-commit differs from the hook agent-ledger 0\.x wrote, so it was changed by hand/)
    assert.match(refused.out, /\+ echo "custom check"/)
    assert.match(refused.out, / {2}exit 1/)
    const forced = migrate(r, '--force')
    assert.equal(forced.status, 0, forced.out)
    assert.match(forced.out, /! \.githooks\/pre-commit was changed by hand; --force replaces it with the 1\.0 hook/)
    assert.match(r.read('.githooks/pre-commit'), /# resaledger: pre-commit hook/)
  })

  test('the 0.1 pre-commit hook, which called check, is recognised', () => {
    const old = legacyHook(`Shape of the project records on every commit (${DIR}/standards.md#who-owns-what).`, 'fix the records instead.', 'check', 'commit')
    const r = legacyRepository({ files: { '.githooks/pre-commit': old, '.githooks/pre-push': null } })
    const result = migrate(r, '--dry-run')
    assert.equal(result.status, 0, result.out)
  })

  test('lineDiff marks removed and added lines', () => {
    assert.equal(lineDiff('a\nb\nc\n', 'a\nx\nc\n'), '  a\n- b\n+ x\n  c')
  })
})

describe('the content check', () => {
  test('a line dropped from the planned files stops the plan, naming the line', () => {
    const r = legacyRepository()
    const plan = planMigration(r.root, { testDropLine: 'Afterwards a paragraph about the task.' })
    assert.equal(plan.refusals.length, 1)
    assert.match(plan.refusals[0].message, /^project\/work\/ledger\.md:17: this line of the 0\.x records is not in any new file: Afterwards a paragraph about the task\.$/)
    assert.equal(plan.writes.size, 0)
  })

  test('a reshaped line that is dropped is caught too', () => {
    const r = legacyRepository()
    const plan = planMigration(r.root, { testDropLine: 'Half done; the tree is clean.' })
    assert.match(plan.refusals[0].message, /work\/ledger\.md:\d+: .*- Notes: Half done; the tree is clean\.$/)
  })

  test('nothing is lost in an untouched plan', () => {
    const r = legacyRepository()
    const plan = planMigration(r.root)
    assert.deepEqual(plan.refusals, [])
    assert.deepEqual(plan.problems, [])
  })
})

describe('--dry-run', () => {
  test('prints the plan and writes nothing, byte for byte', () => {
    const r = legacyRepository()
    const before = snapshot(r.root)
    const result = migrate(r, '--dry-run')
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /Create \(\d+\):\n {2}\.githooks\/pre-merge-commit\n {2}\.resaledger\.json\n/)
    assert.match(result.out, /Delete \(7\):/)
    assert.match(result.out, /--dry-run: nothing was written\./)
    assert.deepEqual(snapshot(r.root), before)
    assert.equal(r.git('status', '--porcelain').out, '')
    assert.equal(r.git('config', '--get', 'core.hooksPath').out.trim(), '')
  })
})

describe('a problem with the 1.0 rules', () => {
  const ledger = LEDGER.replace('- Evidence: `npm test`: 12 of 12.\n  The second line of the evidence, indented.', '- Evidence: tested by hand')

  test('stops the run by default and writes with --accept-problems', () => {
    const r = legacyRepository({ files: { [`${DIR}/work/ledger.md`]: ledger } })
    const before = snapshot(r.root)
    const stopped = migrate(r)
    assert.equal(stopped.status, 1, stopped.out)
    assert.match(stopped.out, /Problems with the 1\.0 rules in the result \(1\):\n {2}✖ project\/tasks\/A1-lay-the-base\.md:6: evidence needs a command in backticks/)
    assert.match(stopped.out, /Nothing was written\. .* --accept-problems to write anyway; the commit of the migration is then refused until they are fixed\./)
    assert.deepEqual(snapshot(r.root), before)

    const dry = migrate(r, '--dry-run')
    assert.equal(dry.status, 1, dry.out)
    assert.deepEqual(snapshot(r.root), before)

    const accepted = migrate(r, '--accept-problems')
    assert.equal(accepted.status, 0, accepted.out)
    assert.match(
      accepted.out,
      /Before you commit, fix the 1 problems listed above: the pre-commit hook refuses the commit until they are fixed\. See them again with: node project\/scripts\/records\.mjs check/
    )
    assert.doesNotMatch(accepted.out, /commit and fix them/)
    assert.equal(existsSync(join(r.root, '.resaledger.json')), true)
    const check = r.node(`${DIR}/scripts/records.mjs`, 'check')
    assert.equal(check.status, 1)
    assert.match(check.out, /A1-lay-the-base\.md:6: evidence needs a command/)
    // What the advice says: the hooks refuse the commit.
    assert.notEqual(r.commit('chore: migrate to ResaLedger 1.0', 'Task: maintenance').status, 0)
  })
})

describe('unmerged branches', () => {
  test('a branch that changes the workspace is named in a warning', () => {
    const r = legacyRepository()
    r.git('checkout', '-q', '-b', 'feature/a11')
    r.append(`${DIR}/work/ledger.md`, '\n### A4 From the lane\n- Status: todo\n- Depends on: —\n- Plan: —\n- Evidence: —\n- Notes: —\n')
    assert.equal(r.commit('docs: add A4').status, 0)
    r.git('checkout', '-q', 'main')
    r.git('branch', 'merged-already')
    const result = migrate(r, '--dry-run')
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /! the branch feature\/a11 is not merged\. Its commit stays in the 0\.x format/)
    assert.doesNotMatch(result.out, /merged-already/)
  })

  test('a lane that changes only code is named too; merged as it is it fails the range check, rebased it passes', () => {
    const r = legacyRepository()
    r.git('checkout', '-q', '-b', 'lane-b')
    r.write('src/oven.js', 'export const oven = 1\n')
    r.git('add', '-A')
    assert.equal(r.git('commit', '-q', '--no-verify', '-m', 'feat: the oven', '-m', 'Task: A2').status, 0)
    r.git('checkout', '-q', 'main')
    const result = migrate(r)
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /! the branch lane-b is not merged\. Its commit stays in the 0\.x format, and the 1\.0 range check judges each commit by its own tree/)
    assert.match(result.out, /rebase it onto this branch afterwards/)
    // A2 is doing without a Lane, and only lane-b's commits name it, so it belongs to lane-b.
    assert.match(result.out, /Lanes taken from the one unmerged branch whose commits name the task \(1\):\n {2}A2: Lane: lane-b/)
    assert.match(r.read(`${DIR}/tasks/A2-another-task.md`), /^- Lane: lane-b$/m)
    r.git('add', '-A')
    assert.equal(r.git('commit', '-q', '--no-verify', '-m', 'chore: migrate to ResaLedger 1.0', '-m', 'Task: maintenance').status, 0)
    const migrated = r.git('rev-parse', 'HEAD').out.trim()
    const check = () => r.run(process.execPath, [`${DIR}/scripts/records.mjs`, 'check', '--range', `${migrated}..HEAD`])
    // The base after a merge, as CI's push check judges it: on a detached HEAD, without the lane rule.
    const checkBase = () => {
      r.git('checkout', '-q', '--detach')
      const checked = check()
      r.git('checkout', '-q', 'main')
      return checked
    }

    assert.equal(r.git('merge', '-q', '--no-ff', '--no-verify', '-m', 'Merge lane-b', 'lane-b').status, 0)
    const asIs = checkBase()
    assert.notEqual(asIs.status, 0, asIs.out)
    assert.match(asIs.out, /"feat: the oven" names task A2, which has no file in project\/tasks\/ in that commit/)

    r.git('reset', '-q', '--hard', migrated)
    r.git('checkout', '-q', 'lane-b')
    assert.equal(r.git('rebase', '-q', 'main').status, 0)
    // On the rebased lane, its commits pass, and it rewrites its handoff through the hooks,
    // which refuse a change to a task another lane holds.
    const onLane = check()
    assert.equal(onLane.status, 0, onLane.out)
    const taskFile = `${DIR}/tasks/A2-another-task.md`
    r.write(taskFile, r.read(taskFile).replace('Half done; the tree is clean.', 'The oven is in; next, the timer.'))
    const rewritten = r.commit('docs: rewrite the handoff of A2', 'Task: A2')
    assert.equal(rewritten.status, 0, rewritten.out)
    const handoff = r.node(`${DIR}/scripts/records.mjs`, 'handoff')
    assert.equal(handoff.status, 0, handoff.out)
    r.git('checkout', '-q', 'main')
    assert.equal(r.git('merge', '-q', '--no-ff', '--no-verify', '-m', 'Merge lane-b', 'lane-b').status, 0)
    const rebased = checkBase()
    assert.equal(rebased.status, 0, rebased.out)
  })

  test('a task that the commits of two lanes name keeps the current branch as its lane, and the warning names both', () => {
    const r = legacyRepository()
    for (const lane of ['lane-c', 'lane-b']) {
      r.git('checkout', '-q', '-b', lane, 'main')
      r.write(`src/${lane}.js`, 'export const part = 1\n')
      r.git('add', '-A')
      assert.equal(r.git('commit', '-q', '--no-verify', '-m', `feat: ${lane}`, '-m', 'Task: A2').status, 0)
    }
    r.git('checkout', '-q', 'main')
    const result = migrate(r, '--dry-run')
    assert.equal(result.status, 0, result.out)
    assert.doesNotMatch(result.out, /Lanes taken from/)
    assert.match(result.out, /doing tasks without a Lane get Lane: main/)
    assert.match(result.out, /! A2 is doing, and commits on more than one unmerged branch name it \(lane-b, lane-c\), so it gets Lane: main\./)
    const plan = planMigration(r.root)
    assert.match(plan.writes.get(`${DIR}/tasks/A2-another-task.md`), /^- Lane: main$/m)
  })
})

describe('the configuration', () => {
  test('branches become protected and branchPattern, and unknown keys are reported', () => {
    const { config, unmapped } = convertConfig({
      version: 1,
      mode: 'ledger',
      dir: 'w',
      branches: { protected: ['main'], pattern: '^feat/', other: 1 },
      gates: { commit: ['a'], verify: ['b'], skipPaths: [] },
      requirePushed: true,
      extra: 'x'
    })
    assert.deepEqual(config, { version: 2, dir: 'w', protected: ['main'], branchPattern: '^feat/', requirePushed: true, gates: { commit: ['a'], verify: ['b'] } })
    assert.deepEqual(unmapped, { 'branches.other': 1, 'gates.skipPaths': [], extra: 'x' })
  })
})

describe("this repository's own 0.x workspace", () => {
  // This repository at its last 0.x commit, on a branch of its own.
  const root = legacyClone()

  test('migrates in a clone without losing a line, and the result commits through the new hooks', { skip: root === null && 'the history before this repository moved to 1.0 is not in this clone' }, () => {
    const result = run(root, process.execPath, [CLI, 'migrate', '--accept-problems'])
    assert.equal(result.status, 0, result.out)
    assert.doesNotMatch(result.out, /not in any new file/)
    // Every problem check finds was foreseen by the plan in memory.
    const check = run(root, process.execPath, ['ledger/scripts/records.mjs', 'check'])
    const found = check.out.split('\n').filter((line) => line.startsWith('✖ '))
    for (const line of found) assert.ok(result.out.includes(`  ${line}`), line)
    if (found.length === 0) assert.equal(check.status, 0, check.out)
    assert.equal(run(root, 'git', ['add', '-A']).status, 0)
    const committed = run(root, 'git', ['commit', '-q', '-m', 'chore: migrate to ResaLedger 1.0', '-m', 'Task: maintenance'])
    assert.equal(committed.status, 0, committed.out)
    assert.equal(run(root, 'git', ['status', '--porcelain']).out, '')
  })
})
