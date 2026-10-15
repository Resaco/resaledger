// The guides in docs/ run as written. Every `bash` block of every guide runs, in order, in a
// temporary repository built for that guide, through the local CLI: an `npx` shim on PATH runs
// bin/resaledger.mjs. A block marked `<!-- not run: <reason> -->` is skipped and listed; it may
// name a `stand-in:` command that the test runs in its place, such as a merge that GitHub would
// make. `<!-- exits <n> -->` sets the exit code a block must end with (default 0). A `text`
// block after a command block, before the next one, is its output: each of its lines must be a
// whole line of what the command printed. A line with `…` is shortened and not compared; hashes,
// dates and durations may differ. Every relative link in docs/ must resolve.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { describe, test } from 'node:test'
import { headings, relativeLinks, resolveLinkPath } from '../src/guard/markdown.mjs'
import { ENV, PACKAGE, temporary } from './helpers.mjs'

const DOCS = join(PACKAGE, 'docs')
const GUIDES = join(DOCS, 'guides')
const CLI = join(PACKAGE, 'bin', 'resaledger.mjs')
// Links to files that another lane writes; they must resolve once those files exist.
const PENDING = new Set(['docs/format.md'])
const WINDOWS = process.platform === 'win32'

/** The fenced blocks of a guide, each with its language, text, line and the directives before it. */
export function blocks(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const found = []
  let comments = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    // A fence may be indented, as in a list item; its lines lose the same indent.
    const open = line.match(/^( *)(`{3,})(\w*)\s*$/)
    if (open) {
      const body = []
      let end = index + 1
      while (end < lines.length && !lines[end].trimStart().startsWith(open[2])) body.push(lines[end++].slice(open[1].length))
      found.push({ lang: open[3], text: body.join('\n'), line: index + 1, comments })
      comments = []
      index = end
      continue
    }
    const comment = line.trim().match(/^<!--\s*(.*?)\s*-->$/)
    if (comment) comments.push(comment[1])
    else if (line.trim()) comments = []
  }
  return found
}

/** The command blocks of a guide, each with what to do and the output it must print. */
export function steps(markdown) {
  const all = blocks(markdown)
  const result = []
  all.forEach((block, index) => {
    if (block.lang !== 'bash') return
    const step = { line: block.line, script: block.text, status: 0, skip: null, standIn: null, output: null }
    for (const comment of block.comments) {
      const skipped = comment.match(/^not run: (.*?)(?:; stand-in: (.*))?$/)
      if (skipped) {
        step.skip = skipped[1]
        step.standIn = skipped[2] ?? null
      }
      const exits = comment.match(/^exits (\d+)$/)
      if (exits) step.status = Number(exits[1])
    }
    const next = all[index + 1]
    if (next && next.lang === 'text') step.output = next.text
    result.push(step)
  })
  return result
}

const PLACEHOLDER = /(\d{4}-\d{2}-\d{2})|\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b|(\d+(?:\.\d+)? s)\b/g

/** A shown output line as a pattern: hashes, dates and durations may differ. */
function linePattern(line) {
  let pattern = ''
  let at = 0
  for (const match of line.matchAll(PLACEHOLDER)) {
    pattern += escape(line.slice(at, match.index))
    pattern += match[1] ? '\\d{4}-\\d{2}-\\d{2}' : match[2] ? '\\d+(?:\\.\\d+)? s' : '[0-9a-f]{7,40}'
    at = match.index + match[0].length
  }
  return new RegExp(`^${pattern}${escape(line.slice(at))}$`)
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The lines of the shown output that the actual output lacks. */
export function missingLines(shown, actual) {
  const printed = actual.split('\n').map((line) => line.trim())
  return shown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('…'))
    .filter((line) => !printed.some((candidate) => linePattern(line).test(candidate)))
}

// The people and the shop of the examples.
const PERSON = { GIT_AUTHOR_NAME: 'alice', GIT_AUTHOR_EMAIL: 'alice@example.com', GIT_COMMITTER_NAME: 'alice', GIT_COMMITTER_EMAIL: 'alice@example.com' }
const PACKAGE_JSON = `${JSON.stringify({ name: 'bakery-shop', private: true, scripts: { lint: 'node -e ""', test: 'node -e ""' } }, null, 2)}\n`

/** A folder with the npx shim, and the environment that puts it first on PATH. */
function environment(base) {
  const bin = join(base, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'npx'),
    `#!/bin/sh\nif [ "$1" = resaledger ]; then shift; exec "${process.execPath}" "${CLI}" "$@"; fi\necho "npx: only resaledger runs in the guides test" >&2\nexit 127\n`
  )
  chmodSync(join(bin, 'npx'), 0o755)
  const path = Object.keys(ENV).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  return { ...ENV, ...PERSON, [path]: `${bin}:${dirname(process.execPath)}:${ENV[path]}` }
}

function bash(cwd, env, script) {
  const result = spawnSync('bash', ['-eo', 'pipefail', '-c', script], { cwd, env, encoding: 'utf8' })
  if (result.error) throw result.error
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

function must(cwd, env, script) {
  const result = bash(cwd, env, script)
  assert.equal(result.status, 0, `fixture failed: ${script}\n${result.out}`)
}

// 0.3's git hooks as agent-ledger wrote them, for the migration fixture.
const legacyHook = (dir, comment, fix, call, what) => `#!/bin/sh
# agent-ledger: ${comment}
# Do not bypass with --no-verify; ${fix}
for runtime in node bun "$HOME/.bun/bin/bun" /opt/homebrew/bin/node /usr/local/bin/node; do
  if command -v "$runtime" >/dev/null 2>&1; then
    exec "$runtime" ${dir}/scripts/records.mjs ${call}
  fi
done
echo "agent-ledger: neither node nor bun was found, so this ${what} cannot be checked" >&2
exit 1
`

/** A small agent-ledger 0.3 workspace in build/, as the migration guide starts from. */
function legacyFiles() {
  const dir = 'build'
  return {
    '.agent-ledger.json': `${JSON.stringify({ version: 1, mode: 'ledger', dir, aiAttribution: 'forbid', codePaths: [], gates: { commit: [], verify: ['npm test'] }, commitStyle: 'conventional', branches: { protected: [], pattern: '' }, requirePushed: false }, null, 2)}\n`,
    'AGENTS.md': '# Bakery shop\n\nRun npm test before you push.\n',
    'README.md': `# Bakery shop\n\nThe tasks are in [work/ledger.md](${dir}/work/ledger.md).\n`,
    [`${dir}/README.md`]: '# Bakery shop\n\n## What is being built\n\nAn online shop for a small bakery.\n\n## Environments\n\nLocal only.\n',
    [`${dir}/AGENTS.md`]: '# Bakery shop: agent rules\n\n## Project rules\n\n1. **Prices come from the price list.** Never type a price by hand.\n',
    [`${dir}/STATUS.md`]:
      '# Status\n\nUpdated: 2026-03-04 · by alice\n\n## Phase\n\nBuilding the shop.\n\n## Active work\n\nA2.\n\n## Last verified\n\n- `npm test` passed.\n\n## Next step\n\nFinish A2.\n\n## Waiting for the owner\n\n- Nothing.\n',
    [`${dir}/DECISIONS.md`]: '# Decisions\n\n| Date | Decision | Decided by |\n| --- | --- | --- |\n| 2026-03-02 | Orders are picked up, never delivered. | alice |\n',
    [`${dir}/standards.md`]: '# Working standards\n\n## Commits\n\nConventional Commits with a `Task: <id>` trailer.\n',
    [`${dir}/work/ledger.md`]:
      '# Task ledger\n\n## A: The shop\n\n### A1 Show the opening hours\n- Status: done\n- Depends on: —\n- Plan: —\n- Evidence: `npm test`: ok\n- Notes: —\n\n' +
      '### A2 Add a price list\n- Status: doing\n- Depends on: A1\n- Plan: [A-shop.md](../plan/A-shop.md#a2-add-a-price-list)\n- Evidence: —\n- Notes: Next: the rye bread price.\n',
    [`${dir}/work/log.md`]: '# Session log\n\n## 2026-03-04 · First session\n\nShowed the opening hours. See [A1](ledger.md#a1-show-the-opening-hours).\n',
    [`${dir}/plan/A-shop.md`]: '# The shop\n\n### A2 Add a price list\n\nA page with every bread and its price.\n',
    [`${dir}/scripts/records.mjs`]: '#!/usr/bin/env node\n// agent-ledger 0.3.0\n',
    '.githooks/pre-commit': legacyHook(dir, `Shape of the records, and the commit gates when code changes (${dir}/standards.md).`, 'fix the records or the code instead.', 'pre-commit', 'commit'),
    '.githooks/commit-msg': legacyHook(dir, `Commit header and task trailer (${dir}/standards.md#commits).`, 'fix the message or the ledger instead.', 'commit-msg "$1"', 'commit'),
    '.githooks/pre-push': legacyHook(dir, 'No pushes straight to a protected branch (.agent-ledger.json).', 'push your branch and open a pull request.', 'pre-push "$@"', 'push'),
    'package.json': PACKAGE_JSON
  }
}

const README = '# bakery-shop\n\n## Goal\n\nAn online shop for a small bakery.\n\n## Environments\n\nLocal only.\n\n## Manual checks\n\nNone.\n'

/** The repository each guide starts in: { base, root, env }. */
const FIXTURES = {
  // A project with a lint and a test script, and no ResaLedger yet.
  project(base, env) {
    const root = join(base, 'bakery-shop')
    mkdirSync(root)
    writeFileSync(join(root, 'package.json'), PACKAGE_JSON)
    must(root, env, 'git init -q -b main && git add -A && git commit -q -m "chore: start the shop"')
    return root
  },
  // The project as a clone of a remote, which stands in for GitHub.
  remote(base, env) {
    const root = FIXTURES.project(base, env)
    must(base, env, 'git init -q --bare -b main origin.git')
    must(root, env, 'git remote add origin ../origin.git && git push -q -u origin main')
    return root
  },
  // The project with a CLAUDE.md, for the agents guide.
  agents(base, env) {
    const root = FIXTURES.project(base, env)
    writeFileSync(join(root, 'CLAUDE.md'), '# Bakery shop\n\nRun npm test before you push.\n')
    must(root, env, 'git add CLAUDE.md && git commit -q -m "docs: notes for Claude Code"')
    return root
  },
  // A team repository with ResaLedger on main and a lane that finished T1, for the CI guide.
  ci(base, env) {
    const root = FIXTURES.remote(base, env)
    must(root, env, 'npx resaledger init --team --yes > /dev/null')
    writeFileSync(join(root, 'ledger', 'README.md'), README)
    must(root, env, 'git switch -q -c resaledger-setup && git add -A && git commit -q -m "chore: set up ResaLedger" -m "Task: maintenance" && git push -q origin HEAD')
    must(root, env, 'git -C ../origin.git update-ref refs/heads/main refs/heads/resaledger-setup && git switch -q main && git pull -q --ff-only')
    must(root, env, 'node ledger/scripts/records.mjs new "Add a price list" > /dev/null && printf "\\n## Plan\\n\\nA price list page. Done when npm test passes.\\n" >> ledger/tasks/T1-add-a-price-list.md')
    must(root, env, 'node ledger/scripts/records.mjs claim T1 > /dev/null && echo "export const prices = { rye: 4 }" > prices.js && git add prices.js && git commit -q -m "feat: add a price list" -m "Task: T1"')
    return root
  },
  // An agent-ledger 0.3 workspace, with a lane that is not merged.
  legacy(base, env) {
    const root = join(base, 'bakery-shop')
    for (const [path, text] of Object.entries(legacyFiles())) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    must(root, env, 'chmod 755 .githooks/* && git init -q -b main && git config core.hooksPath .githooks && git add -A && git commit -q -m "chore: an agent-ledger 0.3 workspace"')
    must(root, env, 'git switch -q -c a2-prices && echo "export const prices = { rye: 4 }" > prices.js && git add prices.js && git commit -q -m "feat: add the rye bread price" -m "Task: A2" && git switch -q main')
    return root
  }
}

const GUIDE_FIXTURES = {
  'concepts.md': 'project',
  'solo.md': 'project',
  'team.md': 'remote',
  'ci.md': 'ci',
  'agents.md': 'agents',
  'migration.md': 'legacy'
}

describe('the guides run as written', { skip: WINDOWS && 'the guides are shell sessions; Windows runs them in WSL or Git Bash, which this test does not set up' }, () => {
  test('every guide has a fixture', () => {
    assert.deepEqual(readdirSync(GUIDES).filter((name) => name.endsWith('.md')).sort(), Object.keys(GUIDE_FIXTURES).sort())
  })

  for (const [guide, fixture] of Object.entries(GUIDE_FIXTURES)) {
    test(guide, (t) => {
      const markdown = readFileSync(join(GUIDES, guide), 'utf8')
      const base = temporary('resaledger-guide-')
      const env = environment(base)
      let cwd = FIXTURES[fixture](base, env)
      const skipped = []
      const state = join(base, 'cwd')
      for (const step of steps(markdown)) {
        const where = `${guide}:${step.line}`
        if (step.skip) {
          skipped.push(`${where}: ${step.skip}`)
          if (step.standIn) must(cwd, env, step.standIn)
          continue
        }
        const result = bash(cwd, env, `${step.script}\nprintf '%s' "$PWD" > '${state}'`)
        assert.equal(result.status, step.status, `${where} exited ${result.status}, not ${step.status}:\n${step.script}\n---\n${result.out}`)
        if (result.status === 0) cwd = readFileSync(state, 'utf8')
        if (step.output !== null) assert.deepEqual(missingLines(step.output, result.out), [], `${where}: shown output that the command did not print; it printed:\n${result.out}`)
      }
      for (const line of skipped) t.diagnostic(`not run: ${line}`)
    })
  }
})

describe('the docs', () => {
  const files = []
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'assets') walk(join(folder, entry.name))
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(relative(PACKAGE, join(folder, entry.name)).split('\\').join('/'))
    }
  }
  walk(DOCS)

  test('every relative link resolves, anchors included', () => {
    const broken = []
    for (const file of files) {
      for (const link of relativeLinks(readFileSync(join(PACKAGE, file), 'utf8'))) {
        const target = link.path ? resolveLinkPath(file, link.path) : file
        if (target === null) {
          broken.push(`${file}:${link.line}: ${link.target} leaves the repository`)
          continue
        }
        if (!existsSync(join(PACKAGE, target))) {
          if (!PENDING.has(target)) broken.push(`${file}:${link.line}: ${link.target} does not exist`)
          continue
        }
        if (link.anchor && target.endsWith('.md')) {
          const anchors = headings(readFileSync(join(PACKAGE, target), 'utf8')).map((heading) => heading.anchor)
          if (!anchors.includes(link.anchor)) broken.push(`${file}:${link.line}: ${link.target} has no such heading`)
        }
      }
    }
    assert.deepEqual(broken, [])
  })

  test('every command block is bash and either runs or says why not', () => {
    for (const file of files) {
      for (const block of blocks(readFileSync(join(PACKAGE, file), 'utf8'))) {
        assert.ok(['bash', 'text', 'json', 'yaml', 'markdown', ''].includes(block.lang), `${file}:${block.line}: a ${block.lang} block`)
        if (block.lang === '') assert.fail(`${file}:${block.line}: a block without a language`)
      }
    }
  })

  test('the docs index links every guide', () => {
    const index = readFileSync(join(DOCS, 'README.md'), 'utf8')
    for (const guide of Object.keys(GUIDE_FIXTURES)) assert.ok(index.includes(`(guides/${guide})`), guide)
    assert.ok(index.includes('(format.md)'))
  })
})

describe('the guide runner', () => {
  test('reads directives, outputs and exit codes', () => {
    const parsed = steps(
      [
        '<!-- not run: needs GitHub; stand-in: echo merged -->',
        '',
        '```bash',
        'gh pr merge',
        '```',
        '',
        '<!-- exits 1 -->',
        '```bash',
        'false',
        '```',
        'You see:',
        '',
        '```text',
        'nothing',
        '```',
        '- In a list:',
        '',
        '  <!-- exits 2 -->',
        '',
        '  ```bash',
        '  exit 2',
        '  ```',
        ''
      ].join('\n')
    )
    assert.deepEqual(parsed, [
      { line: 3, script: 'gh pr merge', status: 0, skip: 'needs GitHub', standIn: 'echo merged', output: null },
      { line: 8, script: 'false', status: 1, skip: null, standIn: null, output: 'nothing' },
      { line: 20, script: 'exit 2', status: 2, skip: null, standIn: null, output: null }
    ])
  })

  test('compares whole lines, allows hashes, dates and durations to differ, and skips shortened lines', () => {
    const actual = '✔ npm test (0.3 s)\n[main 47e03c0] feat: x\ncreated ledger/decisions/2026-10-15-a.md\n'
    assert.deepEqual(missingLines('✔ npm test (2.6 s)\n[main abcdef1] feat: x\ncreated ledger/decisions/2026-01-01-a.md\nanything …', actual), [])
    assert.deepEqual(missingLines('✔ npm test', actual), ['✔ npm test'])
    assert.deepEqual(missingLines('feat: x', actual), ['feat: x'])
  })
})
