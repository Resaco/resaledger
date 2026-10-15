// Agent hooks: hook <agent> <event> run by the bundled guard in real repositories, with the
// input recorded in test/fixtures/agents from each agent's documentation:
// - Claude Code: the hooks reference (code.claude.com/docs/en/hooks), the common input fields
//   and the SessionStart, PreToolUse (Bash, Edit, Write) and Stop sections;
// - Codex: the hooks page (developers.openai.com/codex/hooks) and the Stop request in
//   codex-rs/core/src/hook_runtime.rs; Bash and apply_patch both send tool_input.command;
// - Cursor: the hooks page (cursor.com/docs/agent/hooks), the common fields and the
//   sessionStart, beforeShellExecution, preToolUse and stop sections;
// - Gemini CLI: docs/hooks and packages/core/src/hooks, SessionStart, BeforeTool and AfterAgent;
// - GitHub Copilot: the hooks reference, its camelCase sessionStart, preToolUse (toolArgs is a
//   JSON text) and agentStop input.
// All of them block a tool with exit code 2 and the reason on stderr (Copilot with any non-zero
// exit). A Stop or AfterAgent hook's exit 2 makes Claude Code, Codex and Gemini CLI continue
// with that reason; Cursor continues on followup_message and Copilot on decision "block".
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { HOOK_NAMES, renderHook } from '../src/cli/hooks.mjs'
import { agentConfigSnippet, agentHookEntries, isLedgerHookCommand, mergeAgentConfig, patchPaths, shellCommands } from '../src/guard/agents.mjs'
import { ENV, PACKAGE, repository, run, temporary } from './helpers.mjs'

const GUARD = join(temporary(), 'records.mjs')
const built = run(PACKAGE, process.execPath, [join(PACKAGE, 'scripts', 'bundle.mjs'), '--out', GUARD])
if (built.status !== 0) throw new Error(`bundle failed: ${built.out}`)
const CLI = join(PACKAGE, 'bin', 'resaledger.mjs')
const FIXTURES = join(PACKAGE, 'test', 'fixtures', 'agents')
const PLACEHOLDER = '/home/user/project'

const README = `# Bakery shop

## Goal

Build a small web shop for local bakers. It is finished when a customer can order bread.

## Environments

Local only.

## Manual checks

None.
`

/** A repository with the hooks, the bundled guard, a configuration and a README, committed with the hooks off. */
function workspace(config = {}) {
  const r = repository()
  for (const name of HOOK_NAMES) {
    r.write(`.githooks/${name}`, renderHook(name, 'ledger'))
    chmodSync(join(r.root, '.githooks', name), 0o755)
  }
  r.write('ledger/scripts/records.mjs', readFileSync(GUARD, 'utf8'))
  r.write('.resaledger.json', `${JSON.stringify({ version: 2, ...config }, null, 2)}\n`)
  r.write('ledger/README.md', README)
  r.write('src/app.js', 'console.log("app")\n')
  r.write('.gitignore', 'local/\n')
  const committed = r.commit('chore: start', 'Task: maintenance')
  if (committed.status !== 0) throw new Error(`commit failed: ${committed.out}`)
  return r
}

/** A recorded input with the placeholder project folder replaced by folder, and the changes applied. */
function fixture(name, folder, changes = {}) {
  const text = readFileSync(join(FIXTURES, `${name}.json`), 'utf8').replaceAll(PLACEHOLDER, folder.replace(/\\/g, '/'))
  const input = JSON.parse(text)
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'tool_input') input.tool_input = { ...input.tool_input, ...value }
    else if (key === 'toolArgs') input.toolArgs = JSON.stringify({ ...JSON.parse(input.toolArgs), ...value })
    else input[key] = value
  }
  return JSON.stringify(input)
}

/** Runs the repository's guard as an agent's hook would, from cwd (default the root), with input on stdin. */
function hook(r, agent, event, input, cwd = r.root) {
  return run(cwd, process.execPath, [join(r.root, 'ledger', 'scripts', 'records.mjs'), 'hook', agent, event], input)
}

/** Like hook, with stdout and stderr apart: { status, stdout, stderr }. */
function hookIO(r, agent, event, input, cwd = r.root) {
  const result = spawnSync(process.execPath, [join(r.root, 'ledger', 'scripts', 'records.mjs'), 'hook', agent, event], { cwd, env: ENV, input, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, out: `${result.stdout}${result.stderr}` }
}

/** A Bash call from Claude Code with this command. */
const bash = (r, command, session = 'shell') => hook(r, 'claude', 'pre-tool', fixture('claude/pre-tool-bash', r.root, { session_id: session, tool_input: { command } }))

/**
 * Starts the repository's guard with these arguments and writes input to its stdin only after
 * delay milliseconds, as an agent or git may; resolves to { status, out }.
 */
function late(r, args, input, delay) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(r.root, 'ledger', 'scripts', 'records.mjs'), ...args], { cwd: r.root, env: ENV })
    let out = ''
    child.stdout.on('data', (data) => (out += data))
    child.stderr.on('data', (data) => (out += data))
    child.on('close', (status) => done({ status, out }))
    setTimeout(() => child.stdin.end(input), delay)
  })
}

function refused(result, pattern) {
  assert.equal(result.status, 2, result.out)
  assert.match(result.out, /✖ ResaLedger: /)
  if (pattern) assert.match(result.out, pattern)
}

function allowed(result) {
  assert.equal(result.status, 0, result.out)
}

describe('recorded input for every event', () => {
  for (const agent of ['claude', 'codex']) {
    test(`${agent}: session start turns the git hooks on and prints work`, () => {
      const r = workspace()
      assert.notEqual(r.git('config', 'core.hooksPath').out.trim(), '.githooks')
      const result = hook(r, agent, 'session-start', fixture(`${agent}/session-start`, r.root))
      allowed(result)
      assert.equal(r.git('config', 'core.hooksPath').out.trim(), '.githooks')
      assert.match(result.out, /git hooks turned on/)
      assert.match(result.out, /Bakery shop|Build a small web shop/)
    })

    test(`${agent}: a harmless shell command before a tool is allowed`, () => {
      const r = workspace({ preset: 'team' })
      allowed(hook(r, agent, 'pre-tool', fixture(`${agent}/pre-tool-bash`, r.root)))
    })

    test(`${agent}: the end of a turn that changed nothing passes`, () => {
      const r = workspace()
      allowed(hook(r, agent, 'session-start', fixture(`${agent}/session-start`, r.root)))
      allowed(hook(r, agent, 'stop', fixture(`${agent}/stop`, r.root)))
    })
  }

  test('claude: Edit and Write on a lane are allowed, and refused on a protected branch', () => {
    const r = workspace({ preset: 'team' })
    for (const name of ['claude/pre-tool-edit', 'claude/pre-tool-write']) refused(hook(r, 'claude', 'pre-tool', fixture(name, r.root)), /"main" is a protected branch, so files are not edited on it \(src\//)
    r.git('switch', '-q', '-c', 'S1-lane')
    for (const name of ['claude/pre-tool-edit', 'claude/pre-tool-write']) allowed(hook(r, 'claude', 'pre-tool', fixture(name, r.root)))
  })

  test('codex: apply_patch on a lane is allowed, and refused on a protected branch', () => {
    const r = workspace({ preset: 'team' })
    refused(hook(r, 'codex', 'pre-tool', fixture('codex/pre-tool-apply-patch', r.root)), /src\/app\.js/)
    r.git('switch', '-q', '-c', 'S1-lane')
    allowed(hook(r, 'codex', 'pre-tool', fixture('codex/pre-tool-apply-patch', r.root)))
  })

  test('the paths of an apply_patch envelope', () => {
    const input = JSON.parse(readFileSync(join(FIXTURES, 'codex', 'pre-tool-apply-patch.json'), 'utf8'))
    assert.deepEqual(patchPaths(input.tool_input.command), ['src/app.js', 'src/new.js'])
    assert.deepEqual(patchPaths('*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n*** Delete File: c.txt\n*** End Patch'), ['a.txt', 'b.txt', 'c.txt'])
  })
})

describe('text inside quotes never triggers a refusal', () => {
  // On a protected branch, where a redirection would be refused, and on a lane, where a commit passes.
  const r = workspace({ preset: 'team' })
  const lane = workspace({ preset: 'team' })
  lane.git('switch', '-q', '-c', 'S1-lane')
  const commits = [
    'git commit -m "explain --no-verify"',
    "git commit -m 'why not git push --force origin main'",
    'git commit -m "-n is the short form" -m "Task: S1"',
    'git commit -F - <<EOF\nNever use --no-verify or git push -f.\nEOF'
  ]
  for (const command of commits) test(JSON.stringify(command), () => allowed(bash(lane, command)))
  const commands = [
    'echo "git push --force" && echo \'core.hooksPath\'',
    'echo "a > b.txt" | grep ">"',
    'printf "%s\\n" "sed -i s/a/b/ src/app.js"',
    'git log --grep="--no-verify" --oneline',
    'git config --get core.hooksPath',
    'git config core.hooksPath',
    'echo "$HOME" "tee src/app.js"',
    'cat <<\'EOF\' | node -\nconsole.log("git push --force > src/app.js")\nEOF'
  ]
  for (const command of commands) test(JSON.stringify(command), () => allowed(bash(r, command)))
})

describe('each refusal kind', () => {
  const r = workspace({ preset: 'team' })
  const cases = [
    ['git commit --no-verify -m "x"', /--no-verify skips the git hooks/],
    ['git commit --no-veri -m x', /--no-verify/],
    ['git commit -n -m x', /--no-verify/],
    ['git commit -anm "work"', /--no-verify/],
    ['git push --no-verify origin S1-lane', /--no-verify/],
    ['git merge --no-verify S1-lane', /--no-verify/],
    ['git -c core.hooksPath=/dev/null commit -m x', /core\.hooksPath/],
    ['git -c core.hookspath= commit -m x', /core\.hooksPath/],
    ['git config core.hooksPath .git/hooks', /core\.hooksPath/],
    ['git config --unset core.hooksPath', /core\.hooksPath/],
    ['git config set --local core.hooksPath x', /core\.hooksPath/],
    ['GIT_CONFIG_PARAMETERS="\'core.hooksPath\'=\'\'" git commit -m x', /core\.hooksPath/],
    ['git push --force origin S1-lane', /forced push/],
    ['git push -f origin S1-lane', /forced push/],
    ['git push -uf origin S1-lane', /forced push/],
    ['git push --force-with-lease origin S1-lane', /forced push/],
    ['git push origin +S1-lane', /forced push/],
    ['git push --mirror', /forced push/],
    ['git push origin main', /"main" is a protected branch, so nothing is pushed to it/],
    ['git push origin HEAD:main', /"main" is a protected branch/],
    ['git push origin S1-lane:refs/heads/main', /"main" is a protected branch/],
    ['git push origin --delete main', /nothing is deleted from it/],
    ['git push', /"main" is a protected branch/],
    ['git push --all origin', /pushes every branch/],
    ['git commit -m "on main"', /"main" is a protected branch, so nothing is committed on it/],
    ['echo x > src/app.js', /files are not edited on it \(src\/app\.js\)/],
    ['echo x >> src/new.txt', /src\/new\.txt/],
    ['echo x 2> notes.txt', /notes\.txt/],
    ['echo x | tee -a src/app.js', /src\/app\.js/],
    ["sed -i 's/app/shop/' src/app.js", /src\/app\.js/],
    ["sed -i '' -e 's/app/shop/' src/app.js", /src\/app\.js/],
    ['cd src && echo x > app.js', /src\/app\.js/],
    ['bash -lc "git push -f origin S1-lane"', /forced push/],
    ['echo "$(git push --force origin S1-lane)"', /forced push/],
    ['(git commit --no-verify -m x)', /--no-verify/],
    ['sudo -u builder env CI=1 git push -f', /forced push/],
    ['/usr/bin/git push origin main', /protected branch/],
    ["eval 'git push --force'", /forced push/],
    ['apply_patch <<\'EOF\'\n*** Begin Patch\n*** Add File: src/x.js\n+x\n*** End Patch\nEOF', /src\/x\.js/]
  ]
  for (const [command, pattern] of cases) test(JSON.stringify(command), () => refused(bash(r, command), pattern))

  test('on a lane, pushes of the lane, edits and commits pass', () => {
    const lane = workspace({ preset: 'team' })
    lane.git('switch', '-q', '-c', 'S1-lane')
    for (const command of ['git push -u origin HEAD', 'git push origin S1-lane', 'git push', 'echo x > src/app.js', "sed -i 's/a/b/' src/app.js", 'git commit -m "feat: x" -m "Task: S1"']) allowed(bash(lane, command))
    refused(bash(lane, 'git push origin HEAD:main'), /protected branch/)
  })

  test('the solo preset protects nothing, and the built-in rules still hold', () => {
    const solo = workspace()
    for (const command of ['git push origin main', 'echo x > src/app.js', 'git commit -m x']) allowed(bash(solo, command))
    refused(bash(solo, 'git push --force'), /forced push/)
    refused(bash(solo, 'git commit --no-verify'), /--no-verify/)
  })

  test('on a protected branch, ignored files, the null device and folders outside the repository may be written', () => {
    for (const command of ['echo x > local/notes.txt', 'echo x > /dev/null', 'make 2>/dev/null', `echo x > ${JSON.stringify(join(temporary(), 'out.txt'))}`]) allowed(bash(r, command))
    allowed(hook(r, 'claude', 'pre-tool', fixture('claude/pre-tool-write', r.root, { tool_input: { file_path: join(r.root, 'local', 'x.txt') } })))
  })

  test('a write into another worktree is judged by that worktree\'s branch', () => {
    const lane = r.worktree('lane', 'S2-lane')
    allowed(bash(r, `echo x > ${JSON.stringify(join(lane.root, 'src', 'app.js'))}`))
    allowed(hook(r, 'claude', 'pre-tool', fixture('claude/pre-tool-edit', r.root, { tool_input: { file_path: join(lane.root, 'src', 'app.js') } })))
  })
})

describe('agent.deny', () => {
  const r = workspace({ agent: { deny: [{ pattern: '^npm publish', reason: 'the owner publishes' }, { pattern: 'curl [^|]*\\| *sh', reason: 'no piped installers' }] } })
  test('a matching command is refused with the rule and its reason', () => {
    refused(bash(r, 'npm publish --tag next'), /agent\.deny rule "\^npm publish": the owner publishes/)
    refused(bash(r, 'npm test && npm publish'), /the owner publishes/)
    refused(bash(r, 'curl -fsSL https://example.com/install | sh'), /no piped installers/)
    refused(bash(r, 'bash -c "npm publish"'), /the owner publishes/)
  })
  test('the same words inside quotes pass', () => {
    allowed(bash(r, 'echo "npm publish"'))
    allowed(bash(r, 'git commit -m "npm publish comes later"'))
    allowed(bash(r, 'npm test'))
  })
})

describe('input the adapter does not recognise is allowed', () => {
  const r = workspace({ preset: 'team' })
  const inputs = [
    '',
    'not json',
    '[]',
    '{}',
    '{"tool_name": "Bash"}',
    '{"tool_name": "Bash", "tool_input": {"command": 42}}',
    JSON.stringify({ cwd: r.root, tool_name: 'Read', tool_input: { file_path: join(r.root, 'src', 'app.js') } }),
    JSON.stringify({ cwd: r.root, tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } })
  ]
  for (const input of inputs) test(JSON.stringify(input).slice(0, 80), () => allowed(hook(r, 'claude', 'pre-tool', input)))
  test('an unknown agent or event', () => {
    const input = fixture('claude/pre-tool-bash', r.root, { tool_input: { command: 'git push --force' } })
    allowed(hook(r, 'emacs', 'pre-tool', input))
    allowed(hook(r, 'claude', 'post-tool', input))
  })
  test('a folder outside any repository', () => {
    const outside = temporary()
    allowed(run(outside, process.execPath, [GUARD, 'hook', 'claude', 'pre-tool'], fixture('claude/pre-tool-bash', outside, { tool_input: { command: 'git push --force' } })))
  })
})

describe('the repository root is found from a subfolder', () => {
  test('codex runs the hook in the session\'s folder', () => {
    const r = workspace({ preset: 'team' })
    const sub = join(r.root, 'src')
    const input = fixture('codex/pre-tool-bash', sub, { tool_input: { command: 'echo x > app.js' } })
    refused(hook(r, 'codex', 'pre-tool', input, sub), /src\/app\.js/)
    refused(hook(r, 'codex', 'pre-tool', fixture('codex/pre-tool-bash', sub, { tool_input: { command: 'git push origin main' } }), sub), /protected branch/)
    allowed(hook(r, 'codex', 'session-start', fixture('codex/session-start', sub), sub))
    assert.equal(r.git('config', 'core.hooksPath').out.trim(), '.githooks')
  })
  test('the cwd in the input wins over the folder the hook runs in', () => {
    const r = workspace({ preset: 'team' })
    const elsewhere = temporary()
    refused(hook(r, 'claude', 'pre-tool', fixture('claude/pre-tool-bash', r.root, { tool_input: { command: 'git push --force' } }), elsewhere), /forced push/)
  })
})

describe('the end-of-turn reminder', () => {
  test('fires once when the session changed the repository and handoff fails', () => {
    const r = workspace()
    allowed(hook(r, 'claude', 'session-start', fixture('claude/session-start', r.root, { session_id: 'once' })))
    r.write('src/app.js', 'console.log("changed")\n')
    const first = hook(r, 'claude', 'stop', fixture('claude/stop', r.root, { session_id: 'once' }))
    refused(first, /this session changed the repository, and "node ledger\/scripts\/records\.mjs handoff" does not pass yet/)
    assert.match(first.out, /uncommitted path/)
    assert.match(first.out, /tell the user exactly what is left/)
    allowed(hook(r, 'claude', 'stop', fixture('claude/stop', r.root, { session_id: 'once', stop_hook_active: true })))
    // A second configuration calling it for the same session, as the Copilot CLI does with .claude/settings.json.
    allowed(hook(r, 'codex', 'stop', fixture('codex/stop', r.root, { session_id: 'once' })))
  })

  test('fires once when several configurations call it at the same time, every time', async () => {
    // Each round runs a new session against the same changed tree: six stop hooks start at once,
    // and their input arrives a little after they start, as an agent may write it.
    const r = workspace()
    for (let round = 0; round < 8; round++) {
      const session = `race-${round}`
      // Every third session's start is never seen, so its first hook call records it.
      if (round % 3 === 2) allowed(bash(r, 'npm test', session))
      else allowed(hook(r, 'claude', 'session-start', fixture('claude/session-start', r.root, { session_id: session })))
      r.write('src/app.js', `console.log("changed ${round}")\n`)
      const statuses = await Promise.all(['claude', 'codex', 'claude', 'codex', 'claude', 'codex'].map((agent, index) => late(r, ['hook', agent, 'stop'], fixture(`${agent}/stop`, r.root, { session_id: session }), index % 2 ? 30 : 0)))
      assert.deepEqual(statuses.map(({ status }) => status).sort(), [0, 0, 0, 0, 0, 2], `round ${round}: ${statuses.map(({ out }) => out).join('\n')}`)
    }
  })

  test('stays quiet when the session changed nothing, though handoff fails', () => {
    const r = workspace()
    r.write('src/app.js', 'console.log("changed before the session")\n')
    allowed(hook(r, 'claude', 'session-start', fixture('claude/session-start', r.root, { session_id: 'quiet' })))
    allowed(hook(r, 'claude', 'stop', fixture('claude/stop', r.root, { session_id: 'quiet' })))
  })

  test('stays quiet when the session changed the repository and handoff passes', () => {
    const r = workspace()
    allowed(hook(r, 'claude', 'session-start', fixture('claude/session-start', r.root, { session_id: 'clean' })))
    r.write('docs/notes.md', 'Notes.\n')
    const committed = r.commit('docs: notes')
    assert.equal(committed.status, 0, committed.out)
    const handoff = r.node(join(r.root, 'ledger', 'scripts', 'records.mjs'), 'handoff')
    assert.equal(handoff.status, 0, handoff.out)
    allowed(hook(r, 'claude', 'stop', fixture('claude/stop', r.root, { session_id: 'clean' })))
  })

  test('a session whose start was not seen starts at its first hook call', () => {
    const r = workspace()
    allowed(bash(r, 'npm test', 'late'))
    r.write('src/app.js', 'console.log("changed")\n')
    refused(hook(r, 'claude', 'stop', fixture('claude/stop', r.root, { session_id: 'late' })), /handoff/)
    const unseen = workspace()
    unseen.write('src/app.js', 'console.log("changed")\n')
    allowed(hook(unseen, 'claude', 'stop', fixture('claude/stop', unseen.root, { session_id: 'unseen' })))
  })

  test('the state lives under the git folder', () => {
    const r = workspace()
    allowed(hook(r, 'claude', 'session-start', fixture('claude/session-start', r.root, { session_id: 'a/../b c' })))
    assert.ok(existsSync(join(r.root, '.git', 'resaledger', 'sessions', 'a_.._b_c.start')))
    assert.equal(r.git('status', '--porcelain').out, '')
  })
})

describe('input that arrives after the guard starts', () => {
  const r = workspace({ preset: 'team' })
  test('a pre-tool refusal still refuses', async () => {
    const result = await late(r, ['hook', 'claude', 'pre-tool'], fixture('claude/pre-tool-bash', r.root, { tool_input: { command: 'git push --force' } }), 300)
    refused(result, /forced push/)
  })
  test('pre-push still refuses a push to a protected branch', async () => {
    const head = r.git('rev-parse', 'HEAD').out.trim()
    const result = await late(r, ['pre-push', 'origin', 'url'], `refs/heads/main ${head} refs/heads/main ${'0'.repeat(40)}\n`, 300)
    assert.equal(result.status, 1, result.out)
    assert.match(result.out, /"main" is a protected branch/)
  })
  test('no stdin and an empty pipe are read as no input, at once', async () => {
    const guard = join(r.root, 'ledger', 'scripts', 'records.mjs')
    const started = Date.now()
    const none = spawnSync(process.execPath, [guard, 'hook', 'claude', 'pre-tool'], { cwd: r.root, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    assert.equal(none.status, 0)
    allowed(await late(r, ['hook', 'claude', 'pre-tool'], '', 0))
    assert.ok(Date.now() - started < 5000)
  })
})

describe('the shell parser', () => {
  test('splits commands at operators, newlines and subshells, and reads substitutions', () => {
    const commands = shellCommands('a 1 && b "2 3"; c | d\ne $(f g) `h`\n(i) &')
    assert.deepEqual(
      commands.map((command) => command.args),
      [['a', '1'], ['b', '2 3'], ['c'], ['d'], ['f', 'g'], ['h'], ['e', '$(f g)', '`h`'], ['i']]
    )
  })
  test('keeps here-document bodies out of the commands', () => {
    const [command, next] = shellCommands("cat > out.txt <<-'END'\n\tgit push -f\n\tEND\nls")
    assert.deepEqual(command.args, ['cat'])
    assert.deepEqual(command.heredocs, ['\tgit push -f'])
    assert.deepEqual(next.args, ['ls'])
  })
  test('reads redirections with file descriptors', () => {
    const [command] = shellCommands('make 2>&1 >build.log 2>>err.log &>all.log')
    assert.deepEqual(command.redirects.map(({ op, target }) => `${op}${target.value}`), ['>&1', '>build.log', '>>err.log', '&>all.log'])
  })
})

describe('the agents\' configurations', () => {
  const EXISTING = `{
  "permissions": {
    "allow": ["Bash(npm test)"],
    "deny": ["Read(./.env)"]
  },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "./scripts/check-bash.sh" }] },
      { "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "command": "node \\"$CLAUDE_PROJECT_DIR/ledger/scripts/records.mjs\\" hook pre-tool", "timeout": 20 }] }
    ],
    "PostToolUse": [
      { "matcher": "Write", "hooks": [{ "type": "command", "command": "npx prettier --write" }] }
    ],
    "Stop": [
      { "hooks": [
        { "type": "command", "command": "node \\"$CLAUDE_PROJECT_DIR/ledger/scripts/records.mjs\\" hook claude stop", "timeout": 20 },
        { "type": "command", "command": "./scripts/notify.sh" }
      ] }
    ]
  },
  "model": "opus"
}
`

  test('merging keeps the project\'s settings and hooks and replaces only ResaLedger\'s entries', () => {
    const merged = mergeAgentConfig('claude', EXISTING, 'ledger')
    assert.equal(merged.changed, true)
    const before = JSON.parse(EXISTING)
    const after = JSON.parse(merged.text)
    assert.deepEqual(after.permissions, before.permissions)
    assert.equal(after.model, 'opus')
    assert.deepEqual(after.hooks.PostToolUse, before.hooks.PostToolUse)
    assert.deepEqual(after.hooks.PreToolUse[0], before.hooks.PreToolUse[0])
    const entries = agentHookEntries('claude', 'ledger')
    assert.deepEqual(after.hooks.PreToolUse[1], entries.PreToolUse)
    assert.equal(after.hooks.PreToolUse.length, 2)
    assert.deepEqual(after.hooks.Stop, [entries.Stop, { hooks: [{ type: 'command', command: './scripts/notify.sh' }] }])
    assert.deepEqual(after.hooks.SessionStart, [entries.SessionStart])
    assert.deepEqual(Object.keys(after), Object.keys(before))
    const again = mergeAgentConfig('claude', merged.text, 'ledger')
    assert.equal(again.changed, false)
    assert.equal(again.text, merged.text)
  })

  test('a file that is ours already, in other formatting, is left as it is', () => {
    const text = `${JSON.stringify(JSON.parse(mergeAgentConfig('codex', null, 'ledger').text))}\n`
    assert.equal(mergeAgentConfig('codex', text, 'ledger').changed, false)
  })

  test('invalid JSON and wrong shapes are refused', () => {
    assert.match(mergeAgentConfig('claude', '{ "hooks": ', 'ledger').error, /is not valid JSON/)
    assert.match(mergeAgentConfig('claude', '[]', 'ledger').error, /is not a JSON object/)
    assert.match(mergeAgentConfig('claude', '{ "hooks": [] }', 'ledger').error, /"hooks" value that is not an object/)
    assert.match(mergeAgentConfig('codex', '{ "hooks": { "Stop": {} } }', 'ledger').error, /"hooks\.Stop" value that is not an array/)
    assert.deepEqual(Object.keys(JSON.parse(agentConfigSnippet('codex', 'ledger')).hooks), ['SessionStart', 'PreToolUse', 'Stop'])
  })

  test('the command lines name the agent and the event, and are recognised', () => {
    const claude = agentHookEntries('claude', 'records')
    assert.equal(claude.PreToolUse.hooks[0].command, 'node "$CLAUDE_PROJECT_DIR/records/scripts/records.mjs" hook claude pre-tool')
    assert.equal(claude.PreToolUse.matcher, 'Bash|Edit|Write|MultiEdit|NotebookEdit')
    const codex = agentHookEntries('codex', 'records')
    assert.equal(codex.Stop.hooks[0].command, 'node "$(git rev-parse --show-toplevel)/records/scripts/records.mjs" hook codex stop')
    assert.equal(codex.PreToolUse.matcher, 'Bash|apply_patch')
    for (const entries of [claude, codex]) for (const group of Object.values(entries)) assert.ok(isLedgerHookCommand(group.hooks[0].command))
    assert.equal(isLedgerHookCommand('./scripts/notify.sh'), false)
  })

  test('every configured command line runs the bundled guard through a shell', () => {
    const r = workspace({ preset: 'team' })
    const sub = join(r.root, 'src')
    const shell = (command, cwd, input) => {
      const result = spawnSync('sh', ['-c', command], { cwd, env: { ...ENV, CLAUDE_PROJECT_DIR: r.root }, input, encoding: 'utf8' })
      return { status: result.status, out: `${result.stdout}${result.stderr}` }
    }
    for (const agent of ['claude', 'codex']) {
      const entries = agentHookEntries(agent, 'ledger')
      allowed(shell(entries.SessionStart.hooks[0].command, sub, fixture(`${agent}/session-start`, sub)))
      refused(shell(entries.PreToolUse.hooks[0].command, sub, fixture(`${agent}/pre-tool-bash`, sub, { tool_input: { command: 'git push --force' } })), /forced push/)
      allowed(shell(entries.Stop.hooks[0].command, sub, fixture(`${agent}/stop`, sub)))
    }
  })

  test('every command line migrate writes into .claude/settings.json runs, and is never an unknown command', () => {
    // The rewrite migrate applies to a 0.3 .claude/settings.json, read from its source.
    const source = readFileSync(join(PACKAGE, 'src', 'cli', 'migrate.mjs'), 'utf8')
    const found = source.match(/\.replace\((\/\(records.*?\/g), '([^']+)'\)/)
    assert.ok(found, 'the rewrite of the hook commands in migrate.mjs')
    const pattern = new RegExp(found[1].slice(1, -2), 'g')
    const r = workspace({ preset: 'team' })
    for (const event of ['session-start', 'pre-tool', 'stop']) {
      const legacy = `node "$CLAUDE_PROJECT_DIR/ledger/scripts/records.mjs" hook ${event}`
      // migrate rewrites the file's text, where the quotes are escaped.
      const command = JSON.parse(JSON.stringify(legacy).replace(pattern, found[2]))
      assert.equal(command, `node "$CLAUDE_PROJECT_DIR/ledger/scripts/records.mjs" hook claude ${event}`)
      assert.ok(isLedgerHookCommand(legacy) && isLedgerHookCommand(command))
      const name = event === 'pre-tool' ? 'claude/pre-tool-bash' : `claude/${event}`
      for (const input of [fixture(name, r.root), fixture(name, r.root, { tool_input: { command: 'git push --force' } })]) {
        const result = spawnSync('sh', ['-c', command], { cwd: r.root, env: { ...ENV, CLAUDE_PROJECT_DIR: r.root }, input, encoding: 'utf8' })
        assert.ok([0, 2].includes(result.status), `${command}: ${result.status} ${result.stderr}`)
        assert.doesNotMatch(`${result.stdout}${result.stderr}`, /unknown command/)
      }
    }
  })
})

// The configuration files' shapes, as each agent documents them.
const CONFIG_FILES = { cursor: '.cursor/hooks.json', gemini: '.gemini/settings.json', copilot: '.github/hooks/resaledger.json' }
const CURSOR_EVENTS = ['sessionStart', 'sessionEnd', 'preToolUse', 'postToolUse', 'postToolUseFailure', 'subagentStart', 'subagentStop', 'beforeShellExecution', 'afterShellExecution', 'beforeMCPExecution', 'afterMCPExecution', 'beforeReadFile', 'afterFileEdit', 'beforeSubmitPrompt', 'preCompact', 'stop', 'afterAgentResponse', 'afterAgentThought']
const GEMINI_EVENTS = ['SessionStart', 'SessionEnd', 'BeforeAgent', 'AfterAgent', 'BeforeModel', 'AfterModel', 'BeforeToolSelection', 'BeforeTool', 'AfterTool', 'PreCompress', 'Notification']
const COPILOT_EVENTS = ['sessionStart', 'sessionEnd', 'userPromptSubmitted', 'userPromptTransformed', 'preToolUse', 'postToolUse', 'postToolUseFailure', 'permissionRequest', 'agentStop', 'subagentStart', 'subagentStop', 'errorOccurred', 'preCompact', 'notification']

/** Checks an agent's configuration text against its documented shape, and returns it parsed. */
function validConfiguration(agent, text) {
  const config = JSON.parse(text)
  const own = (handler) => isLedgerHookCommand(handler.command ?? handler.bash)
  if (agent === 'cursor') {
    assert.equal(config.version, 1)
    for (const [event, handlers] of Object.entries(config.hooks)) {
      assert.ok(CURSOR_EVENTS.includes(event), event)
      for (const handler of handlers) {
        assert.equal(typeof handler.command, 'string')
        for (const key of Object.keys(handler)) assert.ok(['command', 'matcher', 'failClosed', 'loop_limit', 'timeout'].includes(key), key)
      }
    }
    const ours = Object.fromEntries(Object.entries(config.hooks).map(([event, handlers]) => [event, handlers.filter(own)]).filter(([, handlers]) => handlers.length > 0))
    assert.deepEqual(Object.keys(ours).sort(), ['beforeShellExecution', 'preToolUse', 'sessionStart', 'stop'])
    assert.equal(ours.beforeShellExecution[0].failClosed, true)
    assert.equal(ours.preToolUse[0].failClosed, true)
    assert.equal(ours.stop[0].loop_limit, 1)
    for (const [event, handlers] of Object.entries(ours)) assert.match(handlers[0].command, new RegExp(`^node ledger/scripts/records\\.mjs hook cursor ${event === 'sessionStart' ? 'session-start' : event === 'stop' ? 'stop' : 'pre-tool'}$`))
  } else if (agent === 'gemini') {
    for (const [event, groups] of Object.entries(config.hooks)) {
      assert.ok(GEMINI_EVENTS.includes(event), event)
      for (const group of groups) {
        if (group.matcher !== undefined) new RegExp(group.matcher)
        for (const handler of group.hooks) {
          assert.equal(handler.type, 'command')
          assert.equal(typeof handler.command, 'string')
          if (handler.timeout !== undefined) assert.ok(Number.isInteger(handler.timeout) && handler.timeout >= 1000, 'a timeout in milliseconds')
        }
      }
    }
    const before = config.hooks.BeforeTool.find((group) => group.hooks.some(own))
    for (const tool of ['run_shell_command', 'write_file', 'replace']) assert.ok(new RegExp(`^(?:${before.matcher})$`).test(tool), tool)
    assert.equal(new RegExp(`^(?:${before.matcher})$`).test('read_file'), false)
    for (const event of ['SessionStart', 'BeforeTool', 'AfterAgent']) assert.ok(config.hooks[event].some((group) => group.hooks.some(own)), event)
  } else {
    assert.equal(config.version, 1)
    for (const [event, handlers] of Object.entries(config.hooks)) {
      assert.ok(COPILOT_EVENTS.includes(event), event)
      for (const handler of handlers) {
        assert.equal(handler.type, 'command')
        assert.equal(typeof handler.bash, 'string', 'the cloud agent runs only "bash"')
        assert.ok(Number.isInteger(handler.timeoutSec) && handler.timeoutSec > 0, 'a timeout in seconds')
      }
    }
    assert.deepEqual(Object.keys(config.hooks), ['sessionStart', 'preToolUse', 'agentStop'])
  }
  return config
}

describe('the configurations of Cursor, Gemini CLI and Copilot', () => {
  for (const agent of ['cursor', 'gemini', 'copilot']) {
    test(`${agent}: a new file has the documented shape, merges idempotently, and the snippet matches`, () => {
      const merged = mergeAgentConfig(agent, null, 'ledger')
      validConfiguration(agent, merged.text)
      assert.equal(mergeAgentConfig(agent, merged.text, 'ledger').changed, false)
      assert.deepEqual(JSON.parse(agentConfigSnippet(agent, 'ledger')), JSON.parse(merged.text))
      // An older entry of ours is replaced in its place, not added twice.
      const old = JSON.parse(merged.text)
      const [first] = Object.keys(old.hooks)
      if (agent === 'gemini') old.hooks[first][0].hooks[0].timeout = 5000
      else old.hooks[first][0][agent === 'copilot' ? 'timeoutSec' : 'failClosed'] = 1
      assert.equal(mergeAgentConfig(agent, JSON.stringify(old), 'ledger').text, merged.text)
    })
  }

  test('the command lines never name a version, and run the bundled guard through a shell', () => {
    const r = workspace({ preset: 'team' })
    const sub = join(r.root, 'src')
    const shell = (command, cwd, input) => {
      const result = spawnSync('sh', ['-c', command], { cwd, env: { ...ENV, GEMINI_PROJECT_DIR: r.root }, input, encoding: 'utf8' })
      return { status: result.status, out: `${result.stdout}${result.stderr}` }
    }
    const runs = {
      // Cursor runs project hooks from the project's root; Copilot's CLI may run them in a subfolder.
      cursor: { cwd: r.root, start: 'sessionStart', tool: ['beforeShellExecution', 'cursor/before-shell', { command: 'git push --force' }], stop: 'stop' },
      gemini: { cwd: sub, start: 'SessionStart', tool: ['BeforeTool', 'gemini/before-tool-shell', { tool_input: { command: 'git push --force' } }], stop: 'AfterAgent' },
      copilot: { cwd: sub, start: 'sessionStart', tool: ['preToolUse', 'copilot/pre-tool-bash', { toolArgs: { command: 'git push --force' } }], stop: 'agentStop' }
    }
    for (const [agent, { cwd, start, tool, stop }] of Object.entries(runs)) {
      const entries = agentHookEntries(agent, 'ledger')
      const command = (name) => {
        const entry = entries[name]
        const text = entry.hooks ? entry.hooks[0].command : (entry.command ?? entry.bash)
        assert.doesNotMatch(text, /\d+\.\d+/)
        return text
      }
      allowed(shell(command(start), cwd, fixture(NEW_AGENTS[agent].start, r.root)))
      refused(shell(command(tool[0]), cwd, fixture(tool[1], r.root, tool[2])), /forced push/)
      allowed(shell(command(stop), cwd, fixture(NEW_AGENTS[agent].stop, r.root)))
    }
  })
})

describe('init and update write the agents\' configurations', () => {
  /** A repository with one commit holding the given files. */
  function project(files = {}) {
    const r = repository()
    for (const [path, text] of Object.entries(files)) r.write(path, text)
    r.write('src/app.js', 'console.log("app")\n')
    const committed = r.commit('initial')
    assert.equal(committed.status, 0, committed.out)
    return r
  }

  test('init finds Claude Code by CLAUDE.md and Codex by .codex/', () => {
    const r = project({ 'CLAUDE.md': '# Notes\n', '.codex/config.toml': '[features]\nhooks = true\n' })
    const result = r.node(CLI, 'init', '--yes')
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /\.claude\/settings\.json/)
    assert.match(result.out, /\.codex\/hooks\.json/)
    assert.match(result.out, /Agent hooks for: claude, codex/)
    const settings = JSON.parse(r.read('.claude/settings.json'))
    assert.deepEqual(settings.hooks.Stop, [agentHookEntries('claude', 'ledger').Stop])
    assert.deepEqual(JSON.parse(r.read('.codex/hooks.json')).hooks.PreToolUse, [agentHookEntries('codex', 'ledger').PreToolUse])
  })

  test('init writes no configuration when no agent is found, and --agents names them', () => {
    const none = project()
    assert.equal(none.node(CLI, 'init', '--yes').status, 0)
    assert.equal(existsSync(join(none.root, '.claude')), false)
    assert.equal(existsSync(join(none.root, '.codex')), false)
    const named = project({ 'CLAUDE.md': '# Notes\n' })
    const result = named.node(CLI, 'init', '--yes', '--agents', 'codex', '--dir', 'records')
    assert.equal(result.status, 0, result.out)
    assert.equal(existsSync(join(named.root, '.claude', 'settings.json')), false)
    assert.equal(JSON.parse(named.read('.codex/hooks.json')).hooks.SessionStart[0].hooks[0].command, 'node "$(git rev-parse --show-toplevel)/records/scripts/records.mjs" hook codex session-start')
  })

  test('init merges into an existing settings.json, and the printed commit command commits it', () => {
    const r = project({ '.claude/settings.json': '{\n  "permissions": { "allow": ["Bash(npm test)"] }\n}\n' })
    const result = r.node(CLI, 'init', '--yes')
    assert.equal(result.status, 0, result.out)
    const settings = JSON.parse(r.read('.claude/settings.json'))
    assert.deepEqual(settings.permissions, { allow: ['Bash(npm test)'] })
    assert.ok(settings.hooks.PreToolUse)
    const command = result.out.match(/^\s+(git add .*)$/m)[1]
    const committed = r.run('sh', ['-c', command])
    assert.equal(committed.status, 0, committed.out)
    assert.equal(r.git('status', '--porcelain').out, '')
  })

  test('init with an invalid settings.json leaves it and prints the entries to add', () => {
    const r = project({ '.claude/settings.json': '{ "permissions": ' })
    const result = r.node(CLI, 'init', '--yes')
    assert.equal(result.status, 0, result.out)
    assert.equal(r.read('.claude/settings.json'), '{ "permissions": ')
    assert.match(result.out, /\.claude\/settings\.json is not valid JSON .*so init did not add ResaLedger's agent hooks/)
    assert.match(result.out, /hook claude pre-tool/)
  })

  test('update renews ResaLedger\'s entries and keeps the project\'s', () => {
    const r = project({ 'CLAUDE.md': '# Notes\n' })
    assert.equal(r.node(CLI, 'init', '--yes').status, 0)
    r.commit('chore: set up', 'Task: maintenance')
    const settings = JSON.parse(r.read('.claude/settings.json'))
    settings.hooks.Stop[0].hooks[0].timeout = 1
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command: './notify.sh' }] })
    r.write('.claude/settings.json', `${JSON.stringify(settings, null, 2)}\n`)
    const result = r.node(CLI, 'update')
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /\.claude\/settings\.json: ResaLedger's hook entries/)
    const after = JSON.parse(r.read('.claude/settings.json'))
    assert.deepEqual(after.hooks.Stop, [agentHookEntries('claude', 'ledger').Stop, { hooks: [{ type: 'command', command: './notify.sh' }] }])
    const again = r.node(CLI, 'update')
    assert.match(again.out, /Unchanged[\s\S]*\.claude\/settings\.json/)
  })

  test('update adds no configuration for an agent found later, nor one deleted on purpose; update --agents adds it', () => {
    const r = project({ 'CLAUDE.md': '# Notes\n', '.cursor/rules/shop.mdc': 'Bake bread.\n' })
    assert.equal(r.node(CLI, 'init', '--yes').status, 0)
    r.commit('chore: set up', 'Task: maintenance')
    r.git('rm', '-q', '.cursor/hooks.json')
    r.commit('chore: no Cursor hooks', 'Task: maintenance')
    mkdirSync(join(r.root, '.codex'))
    const result = r.node(CLI, 'update')
    assert.equal(result.status, 0, result.out)
    assert.equal(existsSync(join(r.root, '.cursor', 'hooks.json')), false)
    assert.equal(existsSync(join(r.root, '.codex', 'hooks.json')), false)
    assert.doesNotMatch(result.out, /\.cursor\/hooks\.json|\.codex\/hooks\.json/)
    const added = r.node(CLI, 'update', '--agents', 'codex,cursor')
    assert.equal(added.status, 0, added.out)
    assert.match(added.out, /Restored[\s\S]*\.codex\/hooks\.json[\s\S]*\.cursor\/hooks\.json/)
    assert.deepEqual(JSON.parse(r.read('.cursor/hooks.json')).hooks.stop, [agentHookEntries('cursor', 'ledger').stop])
    assert.match(r.node(CLI, 'update', '--agents', 'emacs').out, /unknown agent "emacs"/)
  })

  test('init finds Cursor, Gemini CLI and Copilot, and writes configurations of the documented shape', () => {
    const r = project({ '.cursorrules': 'Bake bread.\n', 'GEMINI.md': '# Shop\n', '.github/copilot-instructions.md': '# Shop\n' })
    const result = r.node(CLI, 'init', '--yes')
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /Agent hooks for: cursor, gemini, copilot/)
    for (const agent of ['cursor', 'gemini', 'copilot']) validConfiguration(agent, r.read(CONFIG_FILES[agent]))
    const command = result.out.match(/^\s+(git add .*)$/m)[1]
    assert.equal(r.run('sh', ['-c', command]).status, 0)
    assert.equal(r.git('status', '--porcelain').out, '')
    // Found by their folders as well.
    const folders = project({ '.cursor/rules/shop.mdc': 'x\n', '.gemini/styleguide.md': 'x\n', '.github/instructions/shop.instructions.md': 'x\n' })
    assert.match(folders.node(CLI, 'init', '--yes').out, /Agent hooks for: cursor, gemini, copilot/)
    // A plain .github folder is not Copilot.
    const plain = project({ '.github/workflows/ci.yml': 'on: push\n' })
    assert.equal(plain.node(CLI, 'init', '--yes').status, 0)
    assert.equal(existsSync(join(plain.root, '.github', 'hooks')), false)
  })

  test('init merges into an existing .gemini/settings.json and .cursor/hooks.json, keeping the foreign keys', () => {
    const gemini = { context: { fileName: ['GEMINI.md'] }, model: { name: 'pro' }, hooks: { BeforeTool: [{ matcher: 'write_file', hooks: [{ name: 'lint', type: 'command', command: './lint.sh' }] }] } }
    const cursor = { version: 1, hooks: { afterFileEdit: [{ command: './format.sh' }], stop: [{ command: './notify.sh' }] }, extra: true }
    const r = project({ '.gemini/settings.json': JSON.stringify(gemini, null, 2), '.cursor/hooks.json': JSON.stringify(cursor, null, 2) })
    const result = r.node(CLI, 'init', '--yes')
    assert.equal(result.status, 0, result.out)
    const geminiAfter = validConfiguration('gemini', r.read('.gemini/settings.json'))
    assert.deepEqual(geminiAfter.context, gemini.context)
    assert.deepEqual(geminiAfter.model, gemini.model)
    assert.deepEqual(geminiAfter.hooks.BeforeTool, [gemini.hooks.BeforeTool[0], agentHookEntries('gemini', 'ledger').BeforeTool])
    const cursorAfter = validConfiguration('cursor', r.read('.cursor/hooks.json'))
    assert.equal(cursorAfter.extra, true)
    assert.deepEqual(cursorAfter.hooks.afterFileEdit, cursor.hooks.afterFileEdit)
    assert.deepEqual(cursorAfter.hooks.stop, [{ command: './notify.sh' }, agentHookEntries('cursor', 'ledger').stop])
  })
})

// Cursor, Gemini CLI and GitHub Copilot: each one's recorded input for each event.
const NEW_AGENTS = {
  cursor: {
    start: 'cursor/session-start',
    shells: [['cursor/before-shell', (command) => ({ command })], ['cursor/pre-tool-shell', (command) => ({ tool_input: { command } })]],
    edits: ['cursor/pre-tool-write'],
    stop: 'cursor/stop',
    session: (id) => ({ conversation_id: id, session_id: id }),
    context: (output) => output.additional_context,
    denied: (output) => output.permission === 'deny' && /ResaLedger/.test(output.agent_message)
  },
  gemini: {
    start: 'gemini/session-start',
    shells: [['gemini/before-tool-shell', (command) => ({ tool_input: { command } })]],
    edits: ['gemini/before-tool-write', 'gemini/before-tool-replace'],
    stop: 'gemini/after-agent',
    session: (id) => ({ session_id: id }),
    context: (output) => output.hookSpecificOutput.additionalContext,
    denied: (output) => output.decision === 'deny' && /ResaLedger/.test(output.reason)
  },
  copilot: {
    start: 'copilot/session-start',
    shells: [['copilot/pre-tool-bash', (command) => ({ toolArgs: { command } })]],
    edits: ['copilot/pre-tool-edit', 'copilot/pre-tool-create'],
    stop: 'copilot/agent-stop',
    session: (id) => ({ sessionId: id }),
    context: (output) => output.additionalContext,
    denied: (output) => output.permissionDecision === 'deny' && /ResaLedger/.test(output.permissionDecisionReason)
  }
}

describe('Cursor, Gemini CLI and Copilot: recorded input for every event', () => {
  for (const [agent, events] of Object.entries(NEW_AGENTS)) {
    test(`${agent}: session start turns the git hooks on and gives work as JSON context`, () => {
      const r = workspace()
      const result = hookIO(r, agent, 'session-start', fixture(events.start, r.root))
      assert.equal(result.status, 0, result.out)
      assert.equal(r.git('config', 'core.hooksPath').out.trim(), '.githooks')
      const context = events.context(JSON.parse(result.stdout))
      assert.match(context, /git hooks turned on/)
      assert.match(context, /Bakery shop|Build a small web shop/)
    })

    test(`${agent}: a harmless shell command is allowed with nothing on stdout, and a forced push refused`, () => {
      const r = workspace({ preset: 'team' })
      for (const [name, command] of events.shells) {
        const harmless = hookIO(r, agent, 'pre-tool', fixture(name, r.root))
        assert.equal(harmless.status, 0, harmless.out)
        assert.equal(harmless.stdout, '')
        const forced = hookIO(r, agent, 'pre-tool', fixture(name, r.root, command('git push --force origin S1-lane')))
        refused(forced, /forced push/)
        assert.match(forced.stderr, /✖ ResaLedger: a forced push/)
        assert.ok(events.denied(JSON.parse(forced.stdout)), forced.stdout)
        refused(hookIO(r, agent, 'pre-tool', fixture(name, r.root, command('echo x > src/app.js'))), /files are not edited on it \(src\/app\.js\)/)
      }
    })

    test(`${agent}: file edits on a lane are allowed, and refused on a protected branch`, () => {
      const r = workspace({ preset: 'team' })
      for (const name of events.edits) refused(hook(r, agent, 'pre-tool', fixture(name, r.root)), /"main" is a protected branch, so files are not edited on it \(src\//)
      r.git('switch', '-q', '-c', 'S1-lane')
      for (const name of events.edits) allowed(hook(r, agent, 'pre-tool', fixture(name, r.root)))
    })

    test(`${agent}: the end of a turn that changed nothing passes`, () => {
      const r = workspace()
      allowed(hook(r, agent, 'session-start', fixture(events.start, r.root)))
      const result = hookIO(r, agent, 'stop', fixture(events.stop, r.root))
      assert.equal(result.status, 0, result.out)
      assert.equal(result.stdout, '')
    })
  }

  test('cursor: in a cloud agent, without sessionStart, the first shell call turns the git hooks on', () => {
    const r = workspace()
    assert.notEqual(r.git('config', 'core.hooksPath').out.trim(), '.githooks')
    // A tool call that is not a shell call leaves them as they are.
    allowed(hook(r, 'cursor', 'pre-tool', fixture('cursor/pre-tool-write', r.root, { conversation_id: 'cloud' })))
    allowed(hook(r, 'cursor', 'pre-tool', fixture('cursor/before-shell', r.root, { conversation_id: 'cloud-2' })))
    assert.equal(r.git('config', 'core.hooksPath').out.trim(), '.githooks')
    // Turned off later in the same session, they stay off: only the session's first shell call turns them on.
    r.git('config', '--unset', 'core.hooksPath')
    allowed(hook(r, 'cursor', 'pre-tool', fixture('cursor/before-shell', r.root, { conversation_id: 'cloud-2' })))
    assert.equal(r.git('config', 'core.hooksPath').out.trim(), '')
  })

  test('cursor: the folder of a beforeShellExecution call comes from its cwd, or else the workspace root', () => {
    const r = workspace({ preset: 'team' })
    refused(hook(r, 'cursor', 'pre-tool', fixture('cursor/before-shell', r.root, { cwd: join(r.root, 'src'), command: 'echo x > app.js' }), temporary()), /src\/app\.js/)
    refused(hook(r, 'cursor', 'pre-tool', fixture('cursor/before-shell', r.root, { cwd: '', command: 'echo x > src/app.js' }), temporary()), /src\/app\.js/)
  })

  test('gemini: a shell command runs in its dir_path', () => {
    const r = workspace({ preset: 'team' })
    refused(hook(r, 'gemini', 'pre-tool', fixture('gemini/before-tool-shell', r.root, { tool_input: { command: 'echo x > app.js', dir_path: 'src' } })), /src\/app\.js/)
  })

  test('copilot: a shell call in Claude Code\'s shape, as the CLI sends for .claude/settings.json, is read too', () => {
    const r = workspace({ preset: 'team' })
    refused(hook(r, 'copilot', 'pre-tool', fixture('claude/pre-tool-bash', r.root, { tool_input: { command: 'git push --force' } })), /forced push/)
    refused(hook(r, 'copilot', 'pre-tool', JSON.stringify({ sessionId: 'x', cwd: r.root, toolName: 'bash', toolArgs: { command: 'git push --force' } })), /forced push/)
  })
})

describe('Cursor, Gemini CLI and Copilot: input the adapter does not recognise is allowed', () => {
  const r = workspace({ preset: 'team' })
  const file = join(r.root, 'src', 'app.js')
  const inputs = {
    cursor: ['{}', JSON.stringify({ cwd: r.root, tool_name: 'Read', tool_input: { file_path: file } }), JSON.stringify({ cwd: r.root, tool_name: 'Write', tool_input: 'not json' }), JSON.stringify({ cwd: r.root, tool_name: 'Shell', tool_input: { command: 7 } })],
    gemini: ['{}', JSON.stringify({ cwd: r.root, tool_name: 'read_file', tool_input: { file_path: file } }), JSON.stringify({ cwd: r.root, tool_name: 'run_shell_command', tool_input: {} }), JSON.stringify({ cwd: r.root, tool_name: 'mcp_shop_order', tool_input: { command: 'git push --force' } })],
    copilot: ['{}', JSON.stringify({ cwd: r.root, toolName: 'view', toolArgs: JSON.stringify({ path: file }) }), JSON.stringify({ cwd: r.root, toolName: 'bash', toolArgs: 'not json' }), JSON.stringify({ cwd: r.root, toolName: 'edit', toolArgs: '{}' })]
  }
  for (const [agent, list] of Object.entries(inputs)) {
    for (const input of list) {
      test(`${agent}: ${input.slice(0, 70)}`, () => {
        const result = hookIO(r, agent, 'pre-tool', input)
        assert.equal(result.status, 0, result.out)
        assert.equal(result.stdout, '')
      })
    }
  }
})

describe('Cursor, Gemini CLI and Copilot: the end-of-turn reminder', () => {
  test('gemini: AfterAgent runs after every turn, and the reminder still fires once per session', () => {
    const r = workspace()
    const session = NEW_AGENTS.gemini.session('turns')
    allowed(hook(r, 'gemini', 'session-start', fixture('gemini/session-start', r.root, session)))
    allowed(hook(r, 'gemini', 'stop', fixture('gemini/after-agent', r.root, session)))
    r.write('src/app.js', 'console.log("changed")\n')
    refused(hook(r, 'gemini', 'stop', fixture('gemini/after-agent', r.root, session)), /does not pass yet/)
    allowed(hook(r, 'gemini', 'stop', fixture('gemini/after-agent', r.root, { ...session, stop_hook_active: true })))
    r.write('src/app.js', 'console.log("changed again")\n')
    for (let turn = 0; turn < 3; turn++) allowed(hook(r, 'gemini', 'stop', fixture('gemini/after-agent', r.root, session)))
  })

  test('cursor: the reminder is a followup_message, once', () => {
    const r = workspace()
    const session = NEW_AGENTS.cursor.session('follow')
    allowed(hook(r, 'cursor', 'session-start', fixture('cursor/session-start', r.root, session)))
    r.write('src/app.js', 'console.log("changed")\n')
    const first = hookIO(r, 'cursor', 'stop', fixture('cursor/stop', r.root, session))
    assert.equal(first.status, 0, first.out)
    assert.match(JSON.parse(first.stdout).followup_message, /ResaLedger: this session changed the repository[\s\S]*tell the user exactly what is left/)
    const second = hookIO(r, 'cursor', 'stop', fixture('cursor/stop', r.root, { ...session, loop_count: 1 }))
    assert.equal(second.status, 0, second.out)
    assert.equal(second.stdout, '')
  })

  for (const order of [['copilot', 'claude'], ['claude', 'copilot']]) {
    test(`copilot with Claude: the CLI calls both configurations, and the reminder fires once (${order.join(' first, then ')})`, () => {
      const r = workspace()
      const id = `both-${order[0]}`
      const inputs = {
        copilot: (name) => fixture(name === 'start' ? 'copilot/session-start' : 'copilot/agent-stop', r.root, { sessionId: id }),
        claude: (name) => fixture(name === 'start' ? 'claude/session-start' : 'claude/stop', r.root, { session_id: id })
      }
      for (const agent of order) allowed(hook(r, agent, 'session-start', inputs[agent]('start')))
      r.write('src/app.js', 'console.log("changed")\n')
      const [first, second] = order.map((agent) => ({ agent, result: hookIO(r, agent, 'stop', inputs[agent]('stop')) }))
      if (first.agent === 'copilot') {
        assert.equal(first.result.status, 0, first.result.out)
        const output = JSON.parse(first.result.stdout)
        assert.equal(output.decision, 'block')
        assert.match(output.reason, /does not pass yet/)
      } else refused(first.result, /does not pass yet/)
      assert.equal(second.result.status, 0, second.result.out)
      assert.equal(second.result.stdout, '')
    })
  }
})

describe('commands that throw work away', () => {
  const r = workspace({ preset: 'team' })
  r.write('src/app.js', 'console.log("unsaved work")\n')
  const discards = [
    'git reset --hard',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git clean -xdf',
    'git clean --force src',
    'git checkout -- src/app.js',
    'git checkout HEAD -- src',
    'git checkout .',
    'git checkout src/app.js',
    'git checkout HEAD src/app.js',
    'git checkout -f',
    'git restore src/app.js',
    'git restore --source HEAD~1 .',
    'git restore --staged --worktree src/app.js',
    'git restore -SW .',
    'git switch -f S1-lane',
    'git switch --discard-changes S1-lane',
    'npm test && git reset --hard',
    'bash -c "git clean -fdx"',
    'sudo git reset --hard'
  ]
  for (const command of discards) test(`refused on a protected branch: ${JSON.stringify(command)}`, () => refused(bash(r, command), /in the checkout of the protected branch "main"/))

  const kept = [
    'git reset --soft HEAD~1',
    'git reset HEAD src/app.js',
    'git restore --staged src/app.js',
    'git clean -n',
    'git clean -fn',
    'git clean --dry-run -f',
    'git checkout -b S2-lane',
    'git switch -c S2-lane',
    'git status && git diff'
  ]
  for (const command of kept) test(`allowed, as it keeps the work: ${JSON.stringify(command)}`, () => allowed(bash(r, command)))

  const quoted = [
    'echo "git reset --hard"',
    "printf '%s\\n' 'git clean -fdx' 'git checkout .'",
    'git log --grep="git restore src" --oneline',
    'bash -c \'echo "git switch -f main"\'',
    'cat <<EOF\ngit reset --hard HEAD~1\nEOF'
  ]
  for (const command of quoted) test(`text inside quotes is not a command: ${JSON.stringify(command)}`, () => allowed(bash(r, command)))

  test('on the session\'s own lane, in its own worktree, they are allowed', () => {
    const lane = workspace({ preset: 'team' })
    lane.git('switch', '-q', '-c', 'S1-lane')
    for (const command of discards.filter((text) => !text.includes('switch'))) allowed(bash(lane, command))
    allowed(bash(lane, 'git switch -f main'))
  })

  test('a checkout of a protected branch earlier in the same script counts, as in the incident', () => {
    const lane = workspace({ preset: 'team' })
    lane.git('switch', '-q', '-c', 'S1-lane')
    refused(bash(lane, 'git status; git checkout main; git reset --hard HEAD~1'), /protected branch "main"/)
    refused(bash(lane, 'git switch main && git clean -fd'), /protected branch "main"/)
    refused(bash(lane, 'git checkout main && echo x > src/app.js'), /"main" is a protected branch, so files are not edited/)
    allowed(bash(lane, 'git checkout main; git checkout S1-lane; git reset --hard'))
    allowed(bash(lane, 'echo x > src/app.js; git checkout main'))
  })

  test('another lane\'s worktree, through cd or git -C, is refused; its own is not', () => {
    const solo = workspace()
    const own = solo.worktree('own', 'S1-own')
    const other = solo.worktree('other', 'S2-other')
    const session = (command) => bash(own, command, 'lanes')
    refused(session(`git -C ${JSON.stringify(other.root)} reset --hard`), /in another worktree \(.*other, branch "S2-other"\), not this session's own/)
    refused(session(`cd ${JSON.stringify(other.root)} && git clean -fd`), /in another worktree/)
    refused(session(`cd ${JSON.stringify(solo.root)} && git checkout .`), /in another worktree/)
    allowed(session(`cd ${JSON.stringify(other.root)} && git status`))
    allowed(session(`git -C ${JSON.stringify(own.root)} reset --hard`))
    allowed(session('git reset --hard'))
    // A repository of its own, such as a scratch one, is not this repository's lane.
    const scratch = repository()
    allowed(session(`cd ${JSON.stringify(scratch.root)} && git reset --hard`))
  })

  test('a session is judged by the worktree it started in, even after its folder moved', () => {
    const solo = workspace()
    const own = solo.worktree('own', 'S1-own')
    allowed(hook(own, 'claude', 'session-start', fixture('claude/session-start', own.root, { session_id: 'moved' })))
    refused(hook(own, 'claude', 'pre-tool', fixture('claude/pre-tool-bash', solo.root, { session_id: 'moved', tool_input: { command: 'git reset --hard' } })), /in another worktree/)
    allowed(hook(solo, 'claude', 'pre-tool', fixture('claude/pre-tool-bash', solo.root, { session_id: 'main-session', tool_input: { command: 'git reset --hard' } })))
  })

  test('every agent refuses them', () => {
    refused(hook(r, 'codex', 'pre-tool', fixture('codex/pre-tool-bash', r.root, { tool_input: { command: 'git reset --hard' } })), /protected branch "main"/)
    for (const [agent, events] of Object.entries(NEW_AGENTS)) {
      for (const [name, command] of events.shells) refused(hook(r, agent, 'pre-tool', fixture(name, r.root, command('git clean -fd'))), /protected branch "main"/)
    }
  })
})
