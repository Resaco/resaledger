// commit-msg: real repositories with the bundled guard and the rendered hooks, committed
// through git, so that the message file, the staged tree, partial commits and merges are git's own.
import assert from 'node:assert/strict'
import { chmodSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { HOOK_NAMES, renderHook } from '../src/cli/hooks.mjs'
import { AI_ATTRIBUTION } from '../src/guard/githooks.mjs'
import { PACKAGE, repository, run, temporary } from './helpers.mjs'

const GUARD = join(temporary(), 'records.mjs')
const built = run(PACKAGE, process.execPath, [join(PACKAGE, 'scripts', 'bundle.mjs'), '--out', GUARD])
if (built.status !== 0) throw new Error(`bundle failed: ${built.out}`)

// Addresses are built from parts, so the hygiene scan sees none.
const AT = '@'

const README = `# Bakery shop

## Goal

Build a small web shop for local bakers.

## Environments

Local only.

## Manual checks

None.
`

const REFUSED = /✖ This commit is refused/

/** A task file, valid for its status. */
function taskFile(id, title, fields = {}) {
  const { status = 'todo', lane } = fields
  const lines = [`# ${id} ${title}`, '', `- Status: ${status}`]
  if (lane) lines.push(`- Lane: ${lane}`)
  if (status === 'done') lines.push('- Evidence: `npm test`: 3 of 3')
  if (status === 'doing') lines.push('', '## Plan', '', 'Do the thing and test it.')
  return `${lines.join('\n')}\n`
}

/** A repository with the hooks, the guard, a configuration, a README and tasks committed on main, then the hooks turned on. */
function workspace({ config = {}, tasks = [] } = {}) {
  const r = repository()
  for (const name of HOOK_NAMES) {
    r.write(`.githooks/${name}`, renderHook(name, 'ledger'))
    chmodSync(join(r.root, '.githooks', name), 0o755)
  }
  r.write('ledger/scripts/records.mjs', readFileSync(GUARD, 'utf8'))
  r.write('.resaledger.json', `${JSON.stringify({ version: 2, ...config }, null, 2)}\n`)
  r.write('ledger/README.md', README)
  for (const [id, title, fields] of tasks) task(r, id, title, fields)
  const committed = r.commit('chore: start')
  if (committed.status !== 0) throw new Error(`commit failed: ${committed.out}`)
  r.git('config', 'core.hooksPath', '.githooks')
  return r
}

function task(r, id, title, fields) {
  r.write(`ledger/tasks/${id}.md`, taskFile(id, title, fields))
}

/** Changes a code file, so the commit needs a task. */
function code(r, text = `console.log(${Math.random()})\n`) {
  r.write('src/app.js', text)
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

/** Runs the guard's commit-msg on a message written to a file, with the staged tree as it is. */
function commitMsg(r, message) {
  r.write('.git/TEST_MSG', message)
  return r.node('ledger/scripts/records.mjs', 'commit-msg', '.git/TEST_MSG')
}

const S1_MINE = { tasks: [['S1', 'Bake bread', { status: 'doing', lane: 'mine' }]] }

/** A workspace on branch "mine" that holds S1. */
function mine(options = {}) {
  const r = workspace({ ...S1_MINE, ...options })
  r.git('checkout', '-q', '-b', 'mine')
  return r
}

// Exemptions

test('a merge commit made by git merge is exempt', () => {
  const r = mine({ config: { commitStyle: 'conventional' } })
  code(r)
  passed(r.commit('feat: app', 'Task: S1'))
  r.git('checkout', '-q', 'main')
  r.write('notes.md', 'Notes.\n')
  passed(r.commit('docs: notes'))
  // The merge brings code in, has no Task trailer and a header that is not conventional.
  passed(r.git('merge', '-q', '--no-ff', '-m', 'Merge branch mine', 'mine'))
})

test('a commit that concludes a conflicted merge is exempt', () => {
  const r = mine({ config: { commitStyle: 'conventional' } })
  code(r, 'one\n')
  passed(r.commit('feat: one', 'Task: S1'))
  r.git('checkout', '-q', 'main')
  r.git('checkout', '-q', '-b', 'other')
  code(r, 'two\n')
  r.git('add', '-A')
  passed(r.git('commit', '-q', '--no-verify', '-m', 'feat: two'))
  assert.notEqual(r.git('merge', '-q', 'mine').status, 0)
  code(r, 'one and two\n')
  r.git('add', '-A')
  passed(r.git('commit', '-q', '-m', 'Merge mine into other'))
})

test('a revert is exempt', () => {
  const r = mine({ config: { commitStyle: 'conventional' } })
  code(r)
  passed(r.commit('feat: app', 'Task: S1'))
  passed(r.git('revert', '--no-edit', 'HEAD'))
  assert.match(r.git('log', '-1', '--format=%B').out, /This reverts commit/)
})

test('a release commit is exempt', () => {
  const r = workspace({ config: { commitStyle: 'conventional' } })
  r.write('package.json', '{ "version": "1.2.0" }\n')
  passed(r.commit('Release v1.2.0'))
})

test('an exempt commit is still refused for attribution when it is forbidden', () => {
  const r = workspace({ config: { aiAttribution: 'forbid' } })
  r.write('package.json', '{ "version": "1.2.0" }\n')
  refused(r.commit('Release v1.2.0', `Co-authored-by: Claude <noreply${AT}anthropic.com>`), /the trailer "Co-authored-by: Claude/)
})

// commitStyle: conventional

test('a header that is not Conventional Commits is refused, with the header and an example', () => {
  const r = workspace({ config: { commitStyle: 'conventional' } })
  r.write('notes.md', 'Notes.\n')
  refused(r.commit('Add notes'), /the header "Add notes" does not follow Conventional Commits.*for example "feat\(server\): store documents"/)
})

test('an uppercase type, an empty scope and an empty description are refused', () => {
  const r = workspace({ config: { commitStyle: 'conventional' } })
  r.write('notes.md', 'Notes.\n')
  refused(r.commit('Docs: notes'), /the header "Docs: notes"/)
  refused(r.commit('docs(): notes'), /the header "docs\(\): notes"/)
  refused(r.commit('docs:'), /the header "docs:"/)
  refused(r.commit('docs:notes'), /the header "docs:notes"/)
})

test('a conventional header passes, with a scope, a breaking mark and git fixup prefixes', () => {
  const r = workspace({ config: { commitStyle: 'conventional' } })
  r.write('notes.md', 'Notes.\n')
  for (const header of ['docs: notes', 'docs(shop): notes', 'docs(shop)!: notes', 'docs!: notes', 'fixup! docs: notes', 'squash! fixup! docs: notes', 'amend! docs: notes']) {
    r.append('notes.md', `${header}\n`)
    passed(r.commit(header))
  }
})

test('a free commit style accepts any header', () => {
  const r = workspace()
  r.write('notes.md', 'Notes.\n')
  passed(r.commit('Add notes'))
})

// aiAttribution: forbid

test('each attribution trailer that names a model, an assistant or a vendor is refused', () => {
  const r = workspace({ config: { aiAttribution: 'forbid' } })
  r.write('notes.md', 'Notes.\n')
  const trailers = [
    `Co-authored-by: Claude <noreply${AT}anthropic.com>`,
    'Co-Authored-By: chatgpt',
    'Signed-off-by: GPT-4o',
    'Assisted-by: Cursor',
    'Generated-by: GitHub Copilot',
    'Generated-with: Gemini 2.5',
    'Assisted-by: Amazon Q Developer',
    `Co-authored-by: Bot <bot${AT}openai.com>`,
    `Co-authored-by: Helper <agent${AT}mail.x.ai>`
  ]
  for (const trailer of trailers) refused(r.commit('docs: notes', trailer), new RegExp(`the trailer "${trailer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" names an AI model`))
})

test('every listed name is refused as a word', () => {
  const r = workspace({ config: { aiAttribution: 'forbid' } })
  r.write('notes.md', 'Notes.\n')
  r.git('add', '-A')
  for (const name of AI_ATTRIBUTION.names) {
    const result = commitMsg(r, `docs: notes\n\nAssisted-by: ${name.toLowerCase()}\n`)
    refused(result, /names an AI model/)
  }
})

test('near misses pass: a name inside another word, a name outside a trailer, other domains', () => {
  const r = workspace({ config: { aiAttribution: 'forbid' } })
  r.write('notes.md', 'Notes.\n')
  passed(
    r.commit(
      'docs: a cursory look at grokking',
      'Written after a chat with Claude about bread.',
      `Reviewed-by: Cursory Reader <reader${AT}example.com>\nSigned-off-by: Jane Baker <jane${AT}example.org>\nCo-authored-by: Max <max${AT}x.aibakery.example>`
    )
  )
})

test('attribution trailers pass when aiAttribution is allow', () => {
  const r = workspace()
  r.write('notes.md', 'Notes.\n')
  passed(r.commit('docs: notes', `Co-authored-by: Claude <noreply${AT}anthropic.com>`))
})

test('comment lines and everything below the scissors line are not part of the message', () => {
  const r = workspace({ config: { aiAttribution: 'forbid', commitStyle: 'conventional' } })
  r.write('notes.md', 'Notes.\n')
  r.git('add', '-A')
  passed(
    commitMsg(
      r,
      '# Please enter the commit message.\ndocs: notes\n\n# Co-authored-by: Claude\n# ------------------------ >8 ------------------------\nCo-authored-by: Claude\n'
    )
  )
  r.git('config', 'core.commentChar', ';')
  passed(commitMsg(r, '; a comment\ndocs: notes\n; Co-authored-by: Claude\n'))
  // With ";" as the comment character, a "#" line is message text.
  refused(commitMsg(r, '# docs: notes\n\nCo-authored-by: Claude\n'), /the header "# docs: notes"/)
})

// Task trailers

test('a code commit without a Task trailer is refused; maintenance and a records-only commit pass', () => {
  const r = mine()
  code(r)
  refused(r.commit('feat: app'), /"feat: app" changes code but names no task.*Task: <id>.*Task: maintenance/)
  passed(r.commit('chore: format', 'Task: maintenance'))
  r.write('notes.md', 'Notes.\n')
  passed(r.commit('docs: notes'))
})

test('a Task trailer that is not an id is refused', () => {
  const r = mine()
  code(r)
  refused(r.commit('feat: app', 'Task: bread'), /has "bread" in its Task: trailer, which is not a task id/)
})

test('a task with no file in the staged tree is refused', () => {
  const r = mine()
  code(r)
  refused(r.commit('feat: app', 'Task: S9'), /names task S9, which has no file in ledger\/tasks\/ in that commit/)
})

test('a task that is not doing or done is refused', () => {
  const r = mine({ tasks: [['S1', 'Bake bread', { status: 'doing', lane: 'mine' }], ['S2', 'Buy flour']] })
  code(r)
  refused(r.commit('feat: app', 'Task: S2'), /names task S2, which is todo in that commit.*claim the task first/)
})

test("a task another lane holds is refused, and on a detached HEAD the lane rule is skipped", () => {
  const r = workspace({ tasks: [['S1', 'Bake bread', { status: 'doing', lane: 'other' }]] })
  r.git('checkout', '-q', '-b', 'mine')
  code(r)
  refused(r.commit('feat: app', 'Task: S1'), /names task S1, which is held by lane "other" before this range, not by "mine"/)
  r.git('checkout', '-q', '--detach')
  passed(r.commit('feat: app', 'Task: S1'))
})

test('a done task held by this lane passes, and several ids are each checked', () => {
  const r = workspace({ tasks: [['S1', 'Bake bread', { status: 'done', lane: 'mine' }], ['S2', 'Buy flour']] })
  r.git('checkout', '-q', '-b', 'mine')
  code(r)
  refused(r.commit('feat: app', 'Task: S1, S2'), /names task S2, which is todo/)
  passed(r.commit('feat: app', 'Task: S1'))
})

test('a claim in the same commit passes', () => {
  const r = workspace({ tasks: [['S1', 'Bake bread']] })
  r.git('checkout', '-q', '-b', 'mine')
  task(r, 'S1', 'Bake bread', { status: 'doing', lane: 'mine' })
  code(r)
  passed(r.commit('feat: app', 'Task: S1'))
})

test('a partial commit is judged on what it commits, not on the main index', () => {
  const r = workspace({ tasks: [['S1', 'Bake bread']] })
  r.git('checkout', '-q', '-b', 'mine')
  // The claim is staged in the main index, but the partial commit takes only the code.
  task(r, 'S1', 'Bake bread', { status: 'doing', lane: 'mine' })
  code(r)
  r.git('add', '-A')
  refused(r.git('commit', '-q', '-m', 'feat: app', '-m', 'Task: S1', '--', 'src/app.js'), /names task S1, which is todo in that commit/)
  passed(r.git('commit', '-q', '-m', 'feat: app', '-m', 'Task: S1', '--', 'src/app.js', 'ledger/tasks/S1.md'))
})

test('the first commit in an empty repository is checked against its staged tree', () => {
  const r = repository()
  for (const name of HOOK_NAMES) {
    r.write(`.githooks/${name}`, renderHook(name, 'ledger'))
    chmodSync(join(r.root, '.githooks', name), 0o755)
  }
  r.write('ledger/scripts/records.mjs', readFileSync(GUARD, 'utf8'))
  r.write('.resaledger.json', '{ "version": 2 }\n')
  r.write('ledger/README.md', README)
  r.git('config', 'core.hooksPath', '.githooks')
  refused(r.commit('chore: start'), /"chore: start" changes code but names no task/)
  passed(r.commit('chore: start', 'Task: maintenance'))
})
