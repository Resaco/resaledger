// The output of ci and what init and update install for it (C3): the job summary and the pull
// request comment rendered from fixtures, the comment against a local API server (created,
// updated in place, a failing API), --release with an unpacked package, --only-base-pushes, the
// workflow template's structure and its shell step run in a real repository, and the files init
// and update write.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { ciMarkdown, ciText, CI_COMMENT_MARKER } from '../src/guard/report.mjs'
import { ENV, PACKAGE, repository, run, temporary } from './helpers.mjs'

const CLI = join(PACKAGE, 'bin', 'resaledger.mjs')
const FIXTURES = join(PACKAGE, 'test', 'fixtures', 'ci')
const WORKFLOW = readFileSync(join(PACKAGE, 'templates', 'workflow.yml'), 'utf8')
const { version: VERSION } = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'))

const GUARD = join(temporary(), 'records.mjs')
const built = run(PACKAGE, process.execPath, [join(PACKAGE, 'scripts', 'bundle.mjs'), '--out', GUARD])
if (built.status !== 0) throw new Error(`bundle failed: ${built.out}`)

/** A fixture: a ci result as JSON. */
function fixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))
}

/** Writes files and commits them; fails the test when git does. Returns the new HEAD. */
function commit(r, files, ...messages) {
  for (const [path, text] of Object.entries(files)) r.write(path, text)
  const committed = r.commit(...messages)
  assert.equal(committed.status, 0, committed.out)
  return rev(r)
}

/** The commit id of a revision. */
function rev(r, name = 'HEAD') {
  return r.git('rev-parse', name).out.trim()
}

/** A repository whose first commit on main sets up ResaLedger with one task, S1. No hooks run. */
function setup(config = {}) {
  const r = repository()
  commit(
    r,
    {
      '.resaledger.json': `${JSON.stringify({ version: 2, ...config }, null, 2)}\n`,
      'ledger/README.md': '# Bakery shop\n\n## Goal\n\nBuild a small web shop for local bakers.\n\n## Environments\n\nLocal only.\n\n## Manual checks\n\nNone.\n',
      'ledger/tasks/S1.md': '# S1 Bake bread\n\n- Status: todo\n'
    },
    'chore: set up',
    'Task: maintenance'
  )
  return r
}

/** A lane that claims S1, commits code for it and finishes it with evidence. */
function finishedLane(r, lane = 'lane-a') {
  r.git('checkout', '-q', '-b', lane)
  commit(r, { 'ledger/tasks/S1.md': `# S1 Bake bread\n\n- Status: doing\n- Lane: ${lane}\n\n## Plan\n\nBake it.\n` }, 'chore: claim S1', 'Task: S1')
  commit(r, { 'src/bread.js': 'export const bread = 1\n' }, 'feat: bake bread', 'Task: S1')
  commit(r, { 'ledger/tasks/S1.md': `# S1 Bake bread\n\n- Status: done\n- Lane: ${lane}\n- Evidence: \`npm test\`: 3 of 3\n` }, 'docs: finish S1', 'Task: S1')
}

/** A pull_request event file for a lane into main, at their current commits; returns its path. */
function pullRequestEvent(r, lane, { fork = false, number = 7 } = {}) {
  const file = join(temporary('resaledger-event-'), 'event.json')
  writeFileSync(
    file,
    JSON.stringify({
      number,
      pull_request: {
        number,
        base: { sha: rev(r, 'main'), ref: 'main', repo: { full_name: 'team/shop' } },
        head: { sha: rev(r, lane), ref: lane, repo: { full_name: fork ? 'someone/shop' : 'team/shop' } }
      }
    })
  )
  return file
}

/**
 * Runs a command without blocking, so that a server in this process can answer it; resolves to
 * { status, out }.
 */
function runAsync(cwd, command, args, env = ENV) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (out += chunk))
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, out }))
  })
}

/** Runs the bundled ci in GitHub's environment, with a summary file; resolves to { status, out, summary }. */
async function ci(r, eventName, eventFile, extra = {}, args = []) {
  const summary = join(temporary('resaledger-summary-'), 'summary.md')
  const env = { ...ENV, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventFile, GITHUB_STEP_SUMMARY: summary, ...extra }
  const result = await runAsync(r.root, process.execPath, [GUARD, 'ci', ...args], env)
  return { ...result, summary: existsSync(summary) ? readFileSync(summary, 'utf8') : null }
}

/**
 * A local stand-in for GitHub's REST API, holding the comments of pull request 7. failWith makes
 * every request answer that status. Resolves to { url, requests, comments, close }.
 */
function fakeApi({ comments = [], failWith = null } = {}) {
  const state = { requests: [], comments: comments.map((comment) => ({ ...comment })), nextId: 100 }
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      const url = new URL(request.url, 'http://localhost')
      state.requests.push({ method: request.method, path: url.pathname, query: url.search, authorization: request.headers.authorization, body: body ? JSON.parse(body) : null })
      const send = (status, value) => {
        response.writeHead(status, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(value))
      }
      if (failWith) return send(failWith, { message: 'Server Error' })
      if (request.method === 'GET' && url.pathname === '/repos/team/shop/issues/7/comments') return send(200, state.comments)
      if (request.method === 'POST' && url.pathname === '/repos/team/shop/issues/7/comments') {
        const comment = { id: state.nextId++, body: JSON.parse(body).body }
        state.comments.push(comment)
        return send(201, comment)
      }
      const patch = url.pathname.match(/^\/repos\/team\/shop\/issues\/comments\/(\d+)$/)
      if (request.method === 'PATCH' && patch) {
        const comment = state.comments.find(({ id }) => id === Number(patch[1]))
        if (!comment) return send(404, { message: 'Not Found' })
        comment.body = JSON.parse(body).body
        return send(200, comment)
      }
      send(404, { message: 'Not Found' })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ url: `http://127.0.0.1:${port}`, state, close: () => new Promise((done) => server.close(done)) })
    })
  })
}

/** GitHub's variables for the comment, pointed at a local API. */
function commentEnv(api) {
  return { GITHUB_API_URL: api.url, GITHUB_REPOSITORY: 'team/shop', GITHUB_TOKEN: 'test-token' }
}

describe('the job summary and the comment, rendered from fixtures', () => {
  test('a passing pull request: the tasks with their evidence, the commits, the gates with their times and the rules, enforcement unchanged', () => {
    const expected = readFileSync(join(FIXTURES, 'pull-request.md'), 'utf8').replace(/\r\n/g, '\n')
    assert.equal(ciMarkdown(fixture('pull-request')), expected)
  })

  test('task titles cannot inject HTML or a hidden marker', () => {
    const markdown = ciMarkdown(fixture('pull-request'))
    assert.match(markdown, /Fix the flaky &lt;upload> test · new, todo/)
    const result = fixture('pull-request')
    result.moved[0].title = `${CI_COMMENT_MARKER} spoof`
    assert.doesNotMatch(ciMarkdown(result), /<!-- resaledger/)
  })

  test('a failing pull request lists the problems, the failed gate and the undecided weakening change', () => {
    const markdown = ciMarkdown(fixture('pull-request-failing'))
    assert.match(markdown, /^### ResaLedger · this pull request · ✖ 3 checks failed\n/)
    assert.match(markdown, /No task changes its status\./)
    assert.match(markdown, /\*\*Commits:\*\* 2 checked, 1 problem/)
    assert.match(markdown, /\*\*Gates\*\* on `2222222`: `npm run lint` ✔ 3 s · `npm test && npm run e2e` ✖ \(exit 1\) \(rules from the base `1111111`\)/)
    assert.match(markdown, /\*\*Enforcement:\*\*\n- gates\.commit: .*\n- ✖ wip raised from 3 to 5: this weakens enforcement/)
    assert.match(markdown, /\*\*Problems:\*\*\n- ✖ commits: 1 problem; .*\n {2}- 4444444 "feat: bake" changes code but names no task/)
    assert.match(markdown, /<details><summary>Every check<\/summary>/)
  })

  test('the plain text keeps the order of the checks', () => {
    const text = ciText(fixture('pull-request'))
    const order = [...text.matchAll(/^[✔✖] (\w+)/gm)].map((match) => match[1])
    assert.deepEqual(order, ['records', 'commits', 'ownership', 'ids', 'tasks', 'gates', 'enforcement'])
    assert.match(text, /S4\.1 Fix the flaky <upload> test: new, todo/)
  })
})

describe('ci writes the job summary every time', () => {
  test('on a passing pull request', async () => {
    const r = setup()
    finishedLane(r)
    const result = await ci(r, 'pull_request', pullRequestEvent(r, 'lane-a'))
    assert.equal(result.status, 0, result.out)
    assert.match(result.summary, /^### ResaLedger · this pull request · ✔ passed\n/)
    assert.match(result.summary, /- \*\*S1\*\* Bake bread · todo → done\n {2}Evidence: `npm test`: 3 of 3/)
    assert.match(result.summary, /\*\*Commits:\*\* 3 checked, all pass/)
    assert.match(result.summary, /\*\*Gates:\*\* none configured \(rules from the base `[0-9a-f]{7}`\)/)
    assert.match(result.summary, /\*\*Enforcement:\*\* unchanged/)
  })

  test('on a failing pull request, and the exit code stays 1', async () => {
    const r = setup()
    r.git('checkout', '-q', '-b', 'lane-a')
    commit(r, { 'src/a.js': '1\n' }, 'feat: a')
    const result = await ci(r, 'pull_request', pullRequestEvent(r, 'lane-a'))
    assert.equal(result.status, 1, result.out)
    assert.match(result.summary, /✖ 1 check failed/)
    assert.match(result.summary, /"feat: a" changes code but names no task/)
  })

  test('when the check cannot run, such as for a missing commit', async () => {
    const r = setup()
    const file = join(temporary('resaledger-event-'), 'event.json')
    writeFileSync(file, JSON.stringify({ before: 'a'.repeat(40), after: rev(r), ref: 'refs/heads/main' }))
    const result = await ci(r, 'push', file)
    assert.equal(result.status, 1, result.out)
    assert.match(result.summary, /^### ResaLedger · ✖ the check could not run\n\ncommit a{40} is not in this clone/)
  })

  test('a push to the base, and with --only-base-pushes a push to a lane is not checked', async () => {
    const r = setup()
    commit(r, { 'ledger/tasks/S1.md': '# S1 Bake bread\n\n- Status: doing\n- Lane: main\n\n## Plan\n\nBake it.\n' }, 'chore: claim S1', 'Task: S1')
    const before = rev(r)
    commit(r, { 'src/a.js': '1\n' }, 'feat: a', 'Task: S1')
    const event = (ref) => {
      const file = join(temporary('resaledger-event-'), 'event.json')
      writeFileSync(file, JSON.stringify({ before, after: rev(r), ref }))
      return file
    }
    const base = await ci(r, 'push', event('refs/heads/main'), {}, ['--only-base-pushes'])
    assert.equal(base.status, 0, base.out)
    assert.match(base.out, /✔ commits: 1 commit pushed/)
    assert.match(base.out, /^Rules from the commit before the push [0-9a-f]{7}\.$/m)
    assert.match(base.summary, /^### ResaLedger · push to main · ✔ passed/)

    // An unrecorded commit on a lane is left to its pull request.
    r.git('checkout', '-q', '-b', 'lane-a')
    commit(r, { 'src/b.js': '1\n' }, 'feat: b')
    const lane = await ci(r, 'push', event('refs/heads/lane-a'), {}, ['--only-base-pushes'])
    assert.equal(lane.status, 0, lane.out)
    assert.match(lane.out, /Not checked: a push to refs\/heads\/lane-a, which is not the base branch or a protected branch/)
    assert.match(lane.summary, /^### ResaLedger · push to lane-a · not checked/)
    // Without the flag, the same push is checked, as before.
    const checked = await ci(r, 'push', event('refs/heads/lane-a'))
    assert.equal(checked.status, 1, checked.out)
  })
})

describe('the pull request comment, against a local API', () => {
  test('is created on the first run and updated in place on the next', async () => {
    const r = setup()
    finishedLane(r)
    const api = await fakeApi({ comments: [{ id: 1, body: 'Looks good to me' }] })
    try {
      const first = await ci(r, 'pull_request', pullRequestEvent(r, 'lane-a'), commentEnv(api))
      assert.equal(first.status, 0, first.out)
      assert.match(first.out, /Pull request comment created\./)
      assert.deepEqual(api.state.requests.map(({ method, path }) => `${method} ${path}`), ['GET /repos/team/shop/issues/7/comments', 'POST /repos/team/shop/issues/7/comments'])
      assert.equal(api.state.requests[0].authorization, 'Bearer test-token')
      assert.equal(api.state.requests[0].query, '?per_page=100&page=1')
      const posted = api.state.comments.find(({ id }) => id === 100)
      assert.ok(posted.body.startsWith(`${CI_COMMENT_MARKER}\n### ResaLedger · this pull request · ✔ passed`), posted.body)
      assert.match(posted.body, /Bake bread · todo → done/)

      // A later run finds the marker and edits the same comment.
      commit(r, { 'src/rye.js': '1\n' }, 'feat: rye', 'Task: S1')
      const second = await ci(r, 'pull_request', pullRequestEvent(r, 'lane-a'), commentEnv(api))
      assert.equal(second.status, 0, second.out)
      assert.match(second.out, /Pull request comment updated\./)
      assert.deepEqual(api.state.requests.slice(2).map(({ method, path }) => `${method} ${path}`), ['GET /repos/team/shop/issues/7/comments', 'PATCH /repos/team/shop/issues/comments/100'])
      assert.equal(api.state.comments.length, 2)
      assert.match(api.state.comments[1].body, /\*\*Commits:\*\* 4 checked/)
      assert.equal(api.state.comments[0].body, 'Looks good to me')
    } finally {
      await api.close()
    }
  })

  test('a failing API prints one warning and does not change the result', async () => {
    const r = setup()
    finishedLane(r)
    const api = await fakeApi({ failWith: 500 })
    try {
      const result = await ci(r, 'pull_request', pullRequestEvent(r, 'lane-a'), commentEnv(api))
      assert.equal(result.status, 0, result.out)
      const warnings = result.out.split('\n').filter((line) => line.startsWith('warning:'))
      assert.deepEqual(warnings, ['warning: ResaLedger could not comment on the pull request: GET /repos/team/shop/issues/7/comments answered 500'])
      assert.match(result.summary, /✔ passed/)
    } finally {
      await api.close()
    }
  })

  test('an API that cannot be reached is a warning too, and a failing check still fails', async () => {
    const r = setup()
    r.git('checkout', '-q', '-b', 'lane-a')
    commit(r, { 'src/a.js': '1\n' }, 'feat: a')
    const api = await fakeApi()
    await api.close()
    const result = await ci(r, 'pull_request', pullRequestEvent(r, 'lane-a'), commentEnv(api))
    assert.equal(result.status, 1, result.out)
    assert.match(result.out, /^warning: ResaLedger could not comment on the pull request: /m)
  })

  test('no comment from a fork, without a token, or on a push', async () => {
    const r = setup()
    finishedLane(r)
    const api = await fakeApi()
    try {
      const fork = await ci(r, 'pull_request', pullRequestEvent(r, 'lane-a', { fork: true }), commentEnv(api))
      assert.equal(fork.status, 0, fork.out)
      assert.match(fork.out, /No pull request comment: the pull request comes from a fork/)
      const tokenless = await ci(r, 'pull_request', pullRequestEvent(r, 'lane-a'), { ...commentEnv(api), GITHUB_TOKEN: '' })
      assert.equal(tokenless.status, 0, tokenless.out)
      const file = join(temporary('resaledger-event-'), 'event.json')
      writeFileSync(file, JSON.stringify({ before: rev(r, 'main'), after: rev(r, 'main'), ref: 'refs/heads/main' }))
      const push = await ci(r, 'push', file, commentEnv(api))
      assert.equal(push.status, 0, push.out)
      assert.deepEqual(api.state.requests, [])
    } finally {
      await api.close()
    }
  })
})

/** A copy of the package with another version and its guard built in dist/, as npm would unpack it. */
function packageAt(version) {
  const copy = join(temporary('resaledger-package-'), 'package')
  for (const part of ['bin', 'src', 'templates', 'scripts']) cpSync(join(PACKAGE, part), join(copy, part), { recursive: true })
  const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'))
  writeFileSync(join(copy, 'package.json'), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`)
  const bundled = run(copy, process.execPath, [join(copy, 'scripts', 'bundle.mjs')])
  assert.equal(bundled.status, 0, bundled.out)
  return copy
}

/** A repository whose base carries this build's guard, and a lane that updates it to the package's. */
function guardUpdate(release) {
  const r = setup()
  commit(r, { 'ledger/scripts/records.mjs': readFileSync(GUARD, 'utf8') }, 'chore: add the guard', 'Task: maintenance')
  r.git('checkout', '-q', '-b', 'lane-a')
  commit(r, { 'ledger/scripts/records.mjs': readFileSync(join(release, 'dist', 'records.mjs'), 'utf8') }, 'chore: update the guard', 'Task: maintenance')
  return r
}

describe('ci --release', () => {
  const release = packageAt('9.9.9')

  test('counts an unpacked package as released, so an update of the guard to it passes without a decision', async () => {
    const r = guardUpdate(release)
    const without = await ci(r, 'pull_request', pullRequestEvent(r, 'lane-a'))
    assert.equal(without.status, 1, without.out)
    assert.match(without.out, /✖ guard: ledger\/scripts\/records\.mjs changed, and the new text is no released version of ResaLedger's: this weakens enforcement/)

    const result = await ci(r, 'pull_request', pullRequestEvent(r, 'lane-a'), {}, ['--release', release])
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /Rules from the base [0-9a-f]{7}\. ResaLedger 9\.9\.9 counts as released \(--release\)\./)
    assert.match(result.out, /✔ enforcement: 1 change, 0 weakening\n {2}guard: ledger\/scripts\/records\.mjs changed: ResaLedger 9\.9\.9, a released version/)
    assert.match(result.summary, /ResaLedger 9\.9\.9 counts as released/)
  })

  test('a folder that is not a resaledger package stops the check', async () => {
    const r = guardUpdate(release)
    const folder = temporary('resaledger-not-a-package-')
    writeFileSync(join(folder, 'package.json'), '{ "name": "bakery", "version": "1.0.0" }\n')
    const result = await ci(r, 'pull_request', pullRequestEvent(r, 'lane-a'), {}, ['--release', folder])
    assert.equal(result.status, 1, result.out)
    assert.match(result.out, /--release: .* is not a resaledger package/)
    assert.match(result.summary, /the check could not run/)
  })
})

// A small reader for the subset of YAML the workflow uses: block mappings, block sequences of
// mappings, literal block scalars and plain or quoted scalars. Enough to check its structure
// without a YAML dependency.

/** The indentation of a line. */
function indentOf(line) {
  return line.length - line.trimStart().length
}

/** A plain or quoted scalar. */
function yamlScalar(text) {
  const value = text.trim()
  if (value === '') return null
  if (/^'.*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'")
  if (/^".*"$/.test(value)) return JSON.parse(value)
  if (/^-?\d+$/.test(value)) return Number(value)
  if (value === 'true' || value === 'false') return value === 'true'
  return value
}

/** Parses the block at lines[index] with at least `indent` spaces; returns [value, next index]. */
function yamlBlock(lines, index, indent) {
  const first = lines[index]
  if (first.trimStart().startsWith('- ')) {
    const list = []
    while (index < lines.length && indentOf(lines[index]) === indent && lines[index].trimStart().startsWith('- ')) {
      // "- key: value" opens a mapping whose keys sit two spaces further in.
      const inner = `${' '.repeat(indent + 2)}${lines[index].trimStart().slice(2)}`
      const [item, next] = yamlBlock([...lines.slice(0, index), inner, ...lines.slice(index + 1)], index, indent + 2)
      list.push(item)
      index = next
    }
    return [list, index]
  }
  const map = {}
  while (index < lines.length && indentOf(lines[index]) === indent) {
    const match = lines[index].trim().match(/^([\w.-]+):(?:\s+(.*))?$/)
    if (!match) throw new Error(`cannot read line ${index + 1}: ${lines[index]}`)
    const [, key, rest = ''] = match
    index += 1
    if (rest === '|') {
      const body = []
      const inner = index < lines.length ? indentOf(lines[index]) : indent + 2
      while (index < lines.length && (lines[index].trim() === '' || indentOf(lines[index]) >= inner)) {
        body.push(lines[index].slice(inner))
        index += 1
      }
      // A literal block keeps one final line break, not the empty lines before it.
      while (body.length > 0 && body.at(-1).trim() === '') body.pop()
      map[key] = `${body.join('\n')}\n`
    } else if (rest !== '') map[key] = yamlScalar(rest)
    else if (index < lines.length && indentOf(lines[index]) > indent) [map[key], index] = yamlBlock(lines, index, indentOf(lines[index]))
    else map[key] = null
  }
  return [map, index]
}

/** Parses the workflow; comments and empty lines outside block scalars are dropped. */
function parseWorkflow(text) {
  const lines = []
  let scalar = null
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (scalar !== null && (line.trim() === '' || indentOf(line) > scalar)) {
      lines.push(line)
      continue
    }
    scalar = null
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (/:\s+\|$/.test(line)) scalar = indentOf(line)
    lines.push(line)
  }
  while (lines.length > 0 && lines.at(-1).trim() === '') lines.pop()
  return yamlBlock(lines, 0, 0)[0]
}

describe('the workflow template', () => {
  const workflow = parseWorkflow(WORKFLOW)
  const job = workflow.jobs?.resaledger
  const script = job?.steps?.find((step) => typeof step.run === 'string')?.run ?? ''

  test('runs on pull_request and push, and never on pull_request_target', () => {
    assert.deepEqual(Object.keys(workflow.on), ['pull_request', 'push'])
    assert.doesNotMatch(WORKFLOW, /pull_request_target/)
  })

  test('is read-only by default, and the job may also write pull request comments', () => {
    assert.deepEqual(workflow.permissions, { contents: 'read' })
    assert.deepEqual(job.permissions, { contents: 'read', 'pull-requests': 'write' })
  })

  test('checks out the head with the full history that ci needs, without keeping the token', () => {
    const checkout = job.steps.find((step) => String(step.uses).startsWith('actions/checkout@'))
    assert.equal(checkout.with['fetch-depth'], 0)
    assert.equal(checkout.with['persist-credentials'], false)
    assert.equal(checkout.with.ref, '${{ github.event.pull_request.head.sha || github.sha }}')
  })

  test('takes the guard and the folder from the base commit, fetches a newer release, and runs ci', () => {
    assert.match(script, /git show "\$\{rules\}:\.resaledger\.json"/)
    assert.match(script, /git show "\$\{rules\}:\$\{dir\}\/scripts\/records\.mjs" > "\$\{work\}\/records\.mjs"/)
    assert.match(script, /npm pack --silent --ignore-scripts "resaledger@\$\{version\}"/)
    assert.match(script, /node "\$\{work\}\/records\.mjs" ci --only-base-pushes --release "\$\{release\}"/)
    // Values from the event reach the script only through the environment, never pasted into it.
    assert.doesNotMatch(script, /\$\{\{/)
    const step = job.steps.find((item) => item.run === script)
    assert.equal(step.env.GITHUB_TOKEN, '${{ github.token }}')
  })

  test('holds no workspace folder name, so one hash serves every repository', () => {
    assert.doesNotMatch(WORKFLOW, /\bledger\//)
    assert.doesNotMatch(WORKFLOW, /\{\{dir\}\}/)
  })

  test('Ruby\'s YAML parser reads the same structure, when ruby exists', (t) => {
    const ruby = spawnSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.safe_load(STDIN.read))'], { input: WORKFLOW, encoding: 'utf8' })
    if (ruby.error) return t.skip('ruby is not installed')
    assert.equal(ruby.status, 0, ruby.stderr)
    const parsed = JSON.parse(ruby.stdout)
    // YAML 1.1 reads the key "on" as true.
    if ('true' in parsed) {
      parsed.on = parsed.true
      delete parsed.true
    }
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), JSON.parse(JSON.stringify(workflow)))
  })
})

describe('the workflow step, run in a real repository', () => {
  const bash = spawnSync('bash', ['-c', 'command -v tar'], { encoding: 'utf8' })
  const skip = bash.error || bash.status !== 0 ? 'bash and tar are needed' : false
  const script = parseWorkflow(WORKFLOW).jobs.resaledger.steps.find((step) => typeof step.run === 'string').run

  /** Runs the step as GitHub does (bash -e -o pipefail), with a fake npm that packs `release`, or fails. */
  function step(r, env, release = null) {
    const bin = temporary('resaledger-bin-')
    const npm = release
      ? `#!/bin/sh\nset -e\nversion="\${4#resaledger@}"\ntar -czf "resaledger-$version.tgz" -C "${dirname(release)}" package\necho "resaledger-$version.tgz"\n`
      : '#!/bin/sh\necho "npm error 404 Not Found" >&2\nexit 1\n'
    writeFileSync(join(bin, 'npm'), npm, { mode: 0o755 })
    const runner = temporary('resaledger-runner-')
    mkdirSync(runner, { recursive: true })
    const summary = join(runner, 'summary.md')
    const path = [bin, dirname(process.execPath), process.env.PATH].join(process.platform === 'win32' ? ';' : ':')
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
      cwd: r.root,
      env: { ...ENV, PATH: path, RUNNER_TEMP: runner, GITHUB_STEP_SUMMARY: summary, GITHUB_TOKEN: '', ...env },
      encoding: 'utf8'
    })
    return { status: result.status, out: `${result.stdout}${result.stderr}` }
  }

  test('a pull request that updates the guard to a release passes with the release fetched, and needs a decision without it', { skip }, () => {
    const release = packageAt('9.9.9')
    const r = guardUpdate(release)
    const env = { EVENT: 'pull_request', BASE_SHA: rev(r, 'main'), HEAD_SHA: rev(r, 'lane-a'), GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: pullRequestEvent(r, 'lane-a') }
    const fetched = step(r, env, release)
    assert.equal(fetched.status, 0, fetched.out)
    assert.match(fetched.out, new RegExp(`ResaLedger ci: pull request from "lane-a"`))
    assert.match(fetched.out, /guard: ledger\/scripts\/records\.mjs changed: ResaLedger 9\.9\.9, a released version/)

    const offline = step(r, env)
    assert.equal(offline.status, 1, offline.out)
    assert.match(offline.out, /::warning::ResaLedger 9\.9\.9 could not be fetched from npm, so the update to it needs a decision/)
    assert.match(offline.out, /✖ guard: .*no decision this pull request adds names it/)
  })

  test('the guard and the folder come from the base, not from the head', { skip }, () => {
    const r = setup({ dir: 'records' })
    commit(r, { 'records/README.md': readFileSync(join(r.root, 'ledger', 'README.md'), 'utf8'), 'records/scripts/records.mjs': readFileSync(GUARD, 'utf8') }, 'chore: add the guard', 'Task: maintenance')
    r.git('checkout', '-q', '-b', 'lane-a')
    // The head swaps the guard for one that passes everything; the base's guard judges it.
    commit(r, { 'records/scripts/records.mjs': `#!/usr/bin/env node\n// ResaLedger ${VERSION}\nprocess.exit(0)\n` }, 'chore: a guard that passes', 'Task: maintenance')
    const env = { EVENT: 'pull_request', BASE_SHA: rev(r, 'main'), HEAD_SHA: rev(r, 'lane-a'), GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: pullRequestEvent(r, 'lane-a') }
    const result = step(r, env)
    assert.equal(result.status, 1, result.out)
    assert.match(result.out, /✖ guard: records\/scripts\/records\.mjs changed, and the new text is no released version/)
  })

  test('a push to a lane is skipped, and a new branch reads its own rules', { skip }, () => {
    const r = setup()
    commit(r, { 'ledger/scripts/records.mjs': readFileSync(GUARD, 'utf8') }, 'chore: add the guard', 'Task: maintenance')
    r.git('checkout', '-q', '-b', 'lane-a')
    commit(r, { 'src/a.js': '1\n' }, 'feat: a')
    const file = join(temporary('resaledger-event-'), 'event.json')
    writeFileSync(file, JSON.stringify({ before: '0'.repeat(40), after: rev(r), ref: 'refs/heads/lane-a' }))
    const result = step(r, { EVENT: 'push', BEFORE_SHA: '0'.repeat(40), GITHUB_SHA: rev(r), GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: file })
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /Not checked: a push to refs\/heads\/lane-a/)
  })
})

describe('init and update install the workflow', () => {
  /** A repository with one commit. */
  function project(files = {}) {
    const r = repository()
    for (const [path, text] of Object.entries({ 'src/app.js': 'console.log("app")\n', ...files })) r.write(path, text)
    assert.equal(r.commit('initial').status, 0)
    return r
  }

  test('init in the team preset writes the workflow and the pull request template, and prints CODEOWNERS', () => {
    const r = project()
    const result = r.node(CLI, 'init', '--team', '--yes')
    assert.equal(result.status, 0, result.out)
    assert.equal(r.read('.github/workflows/resaledger.yml'), WORKFLOW)
    assert.match(r.read('.github/pull_request_template.md'), /\nTask: ?\n$/)
    assert.match(result.out, /Created \(\d+\):[\s\S]*\.github\/pull_request_template\.md\n {2}\.github\/workflows\/resaledger\.yml/)
    assert.match(result.out, /add these lines to \.github\/CODEOWNERS[^\n]*\n {7}# ResaLedger's enforcement files[\s\S]*\/ledger\/scripts\/records\.mjs @your-org\/maintainers\n {7}\/\.githooks\/ @your-org\/maintainers\n {7}\/\.github\/workflows\/resaledger\.yml/)
    // The printed commit command includes both files.
    assert.match(result.out, /git add [^\n]*\.github\/pull_request_template\.md \.github\/workflows\/resaledger\.yml/)
  })

  test('init in the team preset keeps a pull request template the project has, and refuses a foreign workflow', () => {
    const own = project({ '.github/PULL_REQUEST_TEMPLATE.md': '## Our template\n' })
    const kept = own.node(CLI, 'init', '--team', '--yes')
    assert.equal(kept.status, 0, kept.out)
    assert.equal(own.read('.github/PULL_REQUEST_TEMPLATE.md'), '## Our template\n')
    // Read the folder, as a file system that ignores case finds either name.
    assert.deepEqual(readdirSync(join(own.root, '.github')), ['PULL_REQUEST_TEMPLATE.md', 'workflows'])
    assert.match(kept.out, /\.github\/pull_request_template\.md exists, so init did not write a pull request template; add a "Task: <id>" line at its end/i)

    const foreign = project({ '.github/workflows/resaledger.yml': 'name: ours\n' })
    const refused = foreign.node(CLI, 'init', '--team', '--yes')
    assert.equal(refused.status, 1, refused.out)
    assert.match(refused.out, /\.github\/workflows\/resaledger\.yml exists and is not ResaLedger's workflow/)
  })

  test('init in the solo preset writes no workflow and offers it', () => {
    const r = project()
    const result = r.node(CLI, 'init', '--yes')
    assert.equal(result.status, 0, result.out)
    assert.ok(!existsSync(join(r.root, '.github')))
    assert.match(result.out, /Optional: check pull requests in CI as well with "npx resaledger update --workflow"/)
  })

  test('update adds the workflow with --workflow, then renews it, keeps a hand edit and restores it in the team preset', () => {
    const r = project()
    assert.equal(r.node(CLI, 'init', '--yes').status, 0)
    assert.equal(r.node(CLI, 'update').status, 0)
    assert.ok(!existsSync(join(r.root, '.github')), 'a solo update adds no workflow by itself')
    const added = r.node(CLI, 'update', '--workflow')
    assert.equal(added.status, 0, added.out)
    assert.match(added.out, /Added \(1\):\n {2}\.github\/workflows\/resaledger\.yml\n/)
    assert.equal(r.read('.github/workflows/resaledger.yml'), WORKFLOW)
    assert.match(r.node(CLI, 'update').out, /Unchanged \(\d+\):[\s\S]*\.github\/workflows\/resaledger\.yml/)
    r.append('.github/workflows/resaledger.yml', '# our own line\n')
    const kept = r.node(CLI, 'update')
    assert.match(kept.out, /Kept \(1\):\n {2}\.github\/workflows\/resaledger\.yml: changed by hand, so it is kept/)

    const team = project()
    team.git('checkout', '-q', '-b', 'setup')
    assert.equal(team.node(CLI, 'init', '--team', '--yes').status, 0)
    rmSync(join(team.root, '.github', 'workflows', 'resaledger.yml'))
    const restored = team.node(CLI, 'update')
    assert.equal(restored.status, 0, restored.out)
    assert.match(restored.out, /Restored \(1\):\n {2}\.github\/workflows\/resaledger\.yml\n/)
    assert.equal(team.read('.github/workflows/resaledger.yml'), WORKFLOW)
  })

  test('the guard knows its own workflow as released, so CI lists adding it', async () => {
    const r = setup({ dir: 'docs/ledger' })
    commit(r, { 'docs/ledger/README.md': readFileSync(join(r.root, 'ledger', 'README.md'), 'utf8') }, 'docs: move the README', 'Task: maintenance')
    r.git('checkout', '-q', '-b', 'lane-a')
    commit(r, { '.github/workflows/resaledger.yml': WORKFLOW }, 'ci: add the workflow', 'Task: maintenance')
    const result = await ci(r, 'pull_request', pullRequestEvent(r, 'lane-a'))
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, new RegExp(`workflow: \\.github/workflows/resaledger\\.yml added: ResaLedger ${VERSION.replace(/\./g, '\\.')}, a released version`))
  })
})
