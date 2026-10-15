// The configuration: every key and its default for both presets, the failures, the
// missing-file messages, the typo helpers and the config command through the bundle.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { CONFIG_FILE, DEFAULTS, PRESETS, effectiveConfigJson, loadConfig, parseConfig, unknownKeyNotices } from '../src/guard/config.mjs'
import { editDistance, likelyTypo } from '../src/guard/util.mjs'
import { PACKAGE, repository, run, temporary } from './helpers.mjs'

/** Parses a configuration given as an object and expects it to pass. */
function valid(object) {
  const { config, problems } = parseConfig(JSON.stringify(object, null, 2))
  assert.deepEqual(problems, [])
  return config
}

/** Parses text and expects exactly one problem; returns it. */
function invalid(text) {
  const { config, problems } = parseConfig(typeof text === 'string' ? text : JSON.stringify(text, null, 2))
  assert.equal(config, null)
  assert.equal(problems.length, 1, JSON.stringify(problems))
  assert.equal(problems[0].file, CONFIG_FILE)
  return problems[0]
}

test('a minimal solo configuration gets every default', () => {
  const config = valid({ version: 2 })
  assert.equal(config.version, 2)
  assert.equal(config.dir, 'ledger')
  assert.equal(config.preset, 'solo')
  assert.equal(config.base, 'main')
  assert.deepEqual(config.protected, [])
  assert.equal(config.requirePushed, false)
  assert.equal(config.claimPush, false)
  assert.equal(config.branchPattern, '')
  assert.equal(config.branchRegex, null)
  assert.equal(config.branchPrefix, '')
  assert.equal(config.wip, 3)
  assert.equal(config.commitStyle, 'free')
  assert.equal(config.aiAttribution, 'allow')
  assert.deepEqual(config.codePaths, [])
  assert.deepEqual(config.gates, { commit: [], verify: [] })
  assert.deepEqual(config.ci, { runGates: true })
  assert.deepEqual(config.phases, [])
  assert.deepEqual(config.agent, { deny: [] })
})

test('the team preset protects the base and wants pushes', () => {
  const config = valid({ version: 2, preset: 'team' })
  assert.deepEqual(config.protected, ['main'])
  assert.equal(config.requirePushed, true)
  assert.equal(config.claimPush, true)
  assert.deepEqual(valid({ version: 2, preset: 'team', base: 'staging' }).protected, ['staging'])
  // The keys outside the preset keep their defaults.
  assert.equal(config.wip, DEFAULTS.wip)
  assert.equal(config.commitStyle, DEFAULTS.commitStyle)
})

test('the exported presets and defaults match the specification', () => {
  assert.deepEqual(Object.keys(PRESETS).sort(), ['solo', 'team'])
  assert.deepEqual(PRESETS.solo.protected('main'), [])
  assert.deepEqual(PRESETS.team.protected('main'), ['main'])
  assert.equal(DEFAULTS.dir, 'ledger')
  assert.equal(DEFAULTS.ci.runGates, true)
})

test('explicit keys beat the preset', () => {
  const team = valid({ version: 2, preset: 'team', protected: ['main', 'release'], requirePushed: false, claimPush: false })
  assert.deepEqual(team.protected, ['main', 'release'])
  assert.equal(team.requirePushed, false)
  assert.equal(team.claimPush, false)
  const solo = valid({ version: 2, protected: ['main'], requirePushed: true, claimPush: true })
  assert.deepEqual(solo.protected, ['main'])
  assert.equal(solo.requirePushed, true)
  assert.equal(solo.claimPush, true)
})

test('every key can be set', () => {
  const config = valid({
    version: 2,
    dir: 'work/ledger',
    preset: 'team',
    base: 'staging',
    branchPattern: '^(feat|fix)/',
    branchPrefix: 'feat/',
    wip: 1,
    commitStyle: 'conventional',
    aiAttribution: 'forbid',
    codePaths: ['scripts', 'tools'],
    gates: { commit: ['npm run lint'], verify: ['npm test', 'npm run build'] },
    ci: { runGates: false },
    phases: ['S', 'API'],
    agent: { deny: [{ pattern: 'rm -rf /', reason: 'never' }, { pattern: 'deploy' }] }
  })
  assert.equal(config.dir, 'work/ledger')
  assert.equal(config.base, 'staging')
  assert.deepEqual(config.protected, ['staging'])
  assert.ok(config.branchRegex.test('feat/x'))
  assert.ok(!config.branchRegex.test('main'))
  assert.equal(config.branchPrefix, 'feat/')
  assert.equal(config.wip, 1)
  assert.equal(config.commitStyle, 'conventional')
  assert.equal(config.aiAttribution, 'forbid')
  assert.deepEqual(config.codePaths, ['scripts', 'tools'])
  assert.deepEqual(config.gates, { commit: ['npm run lint'], verify: ['npm test', 'npm run build'] })
  assert.deepEqual(config.ci, { runGates: false })
  assert.deepEqual(config.phases, ['S', 'API'])
  assert.equal(config.agent.deny.length, 2)
  assert.equal(config.agent.deny[1].reason, '')
  assert.ok(config.agent.deny[0].regex.test('sudo rm -rf /'))
})

test('the effective JSON has every key and no compiled regular expressions', () => {
  const config = valid({ version: 2, branchPattern: '^lane/', agent: { deny: [{ pattern: 'x', reason: 'y' }] } })
  const json = JSON.parse(effectiveConfigJson(config))
  assert.equal(json.branchRegex, undefined)
  assert.deepEqual(json.agent, { deny: [{ pattern: 'x', reason: 'y' }] })
  assert.deepEqual(Object.keys(json), [
    'version',
    'dir',
    'preset',
    'base',
    'protected',
    'requirePushed',
    'claimPush',
    'branchPattern',
    'branchPrefix',
    'wip',
    'commitStyle',
    'aiAttribution',
    'codePaths',
    'gates',
    'ci',
    'phases',
    'agent'
  ])
})

test('invalid JSON names the line', () => {
  const problem = invalid('{\n  "version": 2,\n  "dir": "ledger",\n}\n')
  assert.match(problem.message, /not valid JSON/)
  assert.ok(problem.line === 4 || problem.line === 3, `line ${problem.line}`)
  assert.match(invalid('[]').message, /must be a JSON object/)
})

test('a missing or unknown version stops with what to run', () => {
  assert.match(invalid({ dir: 'ledger' }).message, /"version" is missing; this guard reads version 2/)
  const one = invalid('{\n  "version": 1,\n  "mode": "ledger"\n}')
  assert.equal(one.line, 2)
  assert.match(one.message, /this guard reads version 2/)
  assert.match(one.message, /npx resaledger migrate/)
  const three = invalid({ version: 3, futureKey: true })
  assert.match(three.message, /version 3 is not supported; this guard reads version 2/)
  assert.match(three.message, /npx resaledger update/)
  assert.match(invalid({ version: '2' }).message, /this guard reads version 2/)
})

test('dir must be a safe relative folder inside the repository', () => {
  assert.equal(valid({ version: 2, dir: 'docs/ledger' }).dir, 'docs/ledger')
  assert.equal(valid({ version: 2, dir: '.ledger/v1.0_x-y' }).dir, '.ledger/v1.0_x-y')
  const unsafe = ['../ledger', 'docs/../../ledger', '/abs/ledger', 'C:/ledger', 'docs\\ledger', '', '.', './', './ledger', 'ledger/', 'docs//ledger', '-ledger', 'docs/-x']
  const shell = ['x"; touch pwned; "', "x'y", 'a b', 'x$(id)', 'x`id`', 'x;y', 'x\ny', 'x:y', 'x#y', 'x*', 'läger']
  for (const dir of [...unsafe, ...shell]) {
    const problem = invalid({ version: 2, dir })
    assert.equal(problem.line, 3, dir)
    assert.match(problem.message, /"dir" must be a relative folder inside the repository/, dir)
  }
  assert.match(invalid({ version: 2, dir: 5 }).message, /"dir" must be a string/)
})

test('codePaths follow the same rule as dir', () => {
  assert.deepEqual(valid({ version: 2, codePaths: ['fixtures', 'deep/data_1.x'] }).codePaths, ['fixtures', 'deep/data_1.x'])
  for (const item of ['../out', 'tools/', './tools', 'a b', 'x"y', '-x', 'src/**']) {
    assert.match(invalid({ version: 2, codePaths: [item] }).message, /"codePaths\[0\]" must be a relative folder inside the workspace/, item)
  }
})

test('a bad regular expression is a problem with its line', () => {
  const branch = invalid({ version: 2, branchPattern: '(' })
  assert.equal(branch.line, 3)
  assert.match(branch.message, /"branchPattern" is not a valid regular expression/)
  const text = JSON.stringify({ version: 2, agent: { deny: [{ pattern: 'ok', reason: 'a' }, { pattern: '[', reason: 'b' }] } }, null, 2)
  const { problems } = parseConfig(text)
  assert.equal(problems.length, 1)
  assert.match(problems[0].message, /"agent\.deny\[1\]\.pattern" is not a valid regular expression/)
  assert.equal(problems[0].line, text.split('\n').findIndex((line) => line.includes('"pattern": "["')) + 1)
})

test('wrong types and values are problems', () => {
  const cases = [
    [{ preset: 'duo' }, /"preset" must be one of "solo", "team"/],
    [{ base: '' }, /"base" must be a non-empty string/],
    [{ base: 1 }, /"base" must be a non-empty string/],
    [{ protected: 'main' }, /"protected" must be an array of strings/],
    [{ protected: [1] }, /"protected\[0\]" must be a non-empty string/],
    [{ requirePushed: 'yes' }, /"requirePushed" must be true or false/],
    [{ claimPush: 1 }, /"claimPush" must be true or false/],
    [{ branchPattern: 1 }, /"branchPattern" must be a string/],
    [{ branchPrefix: null }, /"branchPrefix" must be a string/],
    [{ wip: 0 }, /"wip" must be a positive integer/],
    [{ wip: 1.5 }, /"wip" must be a positive integer/],
    [{ wip: '3' }, /"wip" must be a positive integer/],
    [{ commitStyle: 'strict' }, /"commitStyle" must be one of "free", "conventional"/],
    [{ aiAttribution: 'deny' }, /"aiAttribution" must be one of "allow", "forbid"/],
    [{ codePaths: ['../out'] }, /"codePaths\[0\]" must be a relative folder inside the workspace/],
    [{ gates: [] }, /"gates" must be an object/],
    [{ gates: { commit: 'npm test' } }, /"gates\.commit" must be an array of strings/],
    [{ gates: { verify: [''] } }, /"gates\.verify\[0\]" must be a non-empty string/],
    [{ ci: { runGates: 'no' } }, /"ci\.runGates" must be true or false/],
    [{ phases: ['s'] }, /"phases\[0\]" must be an id prefix of one to four capital letters/],
    [{ phases: ['ABCDE'] }, /"phases\[0\]" must be an id prefix/],
    [{ agent: { deny: {} } }, /"agent\.deny" must be an array/],
    [{ agent: { deny: ['rm'] } }, /"agent\.deny\[0\]" must be an object/],
    [{ agent: { deny: [{ reason: 'x' }] } }, /"agent\.deny\[0\]\.pattern" must be a non-empty string/],
    [{ agent: { deny: [{ pattern: 'x', reason: 1 }] } }, /"agent\.deny\[0\]\.reason" must be a string/]
  ]
  for (const [keys, message] of cases) {
    const problem = invalid({ version: 2, ...keys })
    assert.match(problem.message, message, JSON.stringify(keys))
    assert.ok(problem.line > 0, `${JSON.stringify(keys)} has no line`)
  }
})

test('an unknown key at any level suggests the closest known key', () => {
  const top = invalid('{\n  "version": 2,\n  "Dirr": "ledger"\n}')
  assert.equal(top.line, 3)
  assert.equal(top.message, 'unknown key "Dirr"; did you mean "dir"?')
  assert.match(invalid({ version: 2, gates: { comit: [] } }).message, /unknown key "gates\.comit"; did you mean "gates\.commit"\?/)
  assert.match(invalid({ version: 2, ci: { rungate: true } }).message, /did you mean "ci\.runGates"\?/)
  assert.match(invalid({ version: 2, agent: { deny: [{ pattern: 'x', reson: 'y' }] } }).message, /unknown key "agent\.deny\[0\]\.reson"; did you mean "agent\.deny\[0\]\.reason"\?/)
})

test('a key this guard does not know is kept, with a notice, when it is no typo of a known one', () => {
  const { config, problems } = parseConfig(JSON.stringify({ version: 2, reviewers: ['alice'], gates: { commit: [], nightly: ['npm run e2e'] } }))
  assert.deepEqual(problems, [])
  assert.deepEqual(config.unknown, { reviewers: ['alice'], 'gates.nightly': ['npm run e2e'] })
  assert.deepEqual(
    unknownKeyNotices(config).map((notice) => notice.message.slice(0, 40)),
    ['"reviewers" is not a key this guard know', '"gates.nightly" is not a key this guard ']
  )
  // The effective configuration shows only what this guard applies.
  assert.doesNotMatch(effectiveConfigJson(config), /reviewers|nightly|unknown/)
})

test('every problem is reported, not only the first', () => {
  const { config, problems } = parseConfig(JSON.stringify({ version: 2, wip: 0, preset: 'x', dri: 'y' }, null, 2))
  assert.equal(config, null)
  assert.equal(problems.length, 3)
  assert.deepEqual(
    problems.map((problem) => problem.line),
    [...problems.map((problem) => problem.line)].sort((a, b) => a - b)
  )
})

test('loadConfig reads the file, and a missing file says what to run', () => {
  const files = (map) => (path) => map[path] ?? null
  assert.equal(loadConfig(files({ [CONFIG_FILE]: '{"version":2}' })).config.dir, 'ledger')
  assert.equal(loadConfig({ read: files({ [CONFIG_FILE]: '{"version":2}' }) }).config.dir, 'ledger')

  const legacy = loadConfig(files({ '.agent-ledger.json': '{"version":1}' }))
  assert.equal(legacy.config, null)
  assert.equal(legacy.problems.length, 1)
  assert.deepEqual({ ...legacy.problems[0], message: '' }, { file: CONFIG_FILE, line: 0, message: '' })
  assert.match(legacy.problems[0].message, /agent-ledger 0\.x workspace; run npx resaledger migrate/)

  const none = loadConfig(files({}))
  assert.equal(none.problems.length, 1)
  assert.match(none.problems[0].message, /\.resaledger\.json is missing; run npx resaledger init/)
})

test('editDistance counts insertions, deletions and substitutions', () => {
  assert.equal(editDistance('', ''), 0)
  assert.equal(editDistance('abc', ''), 3)
  assert.equal(editDistance('', 'ab'), 2)
  assert.equal(editDistance('dir', 'dir'), 0)
  assert.equal(editDistance('kitten', 'sitting'), 3)
  assert.equal(editDistance('wip', 'wipe'), 1)
  assert.equal(editDistance('ä', 'a'), 1)
})

test('likelyTypo finds the closest known name within two edits, ignoring case', () => {
  const known = ['dir', 'base', 'branchPattern', 'branchPrefix']
  assert.equal(likelyTypo('DIR', known), 'dir')
  assert.equal(likelyTypo('bse', known), 'base')
  assert.equal(likelyTypo('branchprefx', known), 'branchPrefix')
  assert.equal(likelyTypo('branchPatern', known), 'branchPattern')
  assert.equal(likelyTypo('directory', known), null)
  assert.equal(likelyTypo('x', []), null)
})

test('the config command prints the effective JSON, and fails on an invalid file', () => {
  const guard = join(temporary(), 'records.mjs')
  const built = run(PACKAGE, process.execPath, [join(PACKAGE, 'scripts', 'bundle.mjs'), '--out', guard])
  assert.equal(built.status, 0, built.out)

  const r = repository()
  const missing = r.node(guard, 'config')
  assert.equal(missing.status, 1)
  assert.match(missing.out, /✖ \.resaledger\.json: \.resaledger\.json is missing; run npx resaledger init/)

  r.write(CONFIG_FILE, JSON.stringify({ version: 2, preset: 'team', gates: { verify: ['npm test'] } }, null, 2))
  r.write('sub/file.txt', 'x\n')
  const printed = run(join(r.root, 'sub'), process.execPath, [guard, 'config'])
  assert.equal(printed.status, 0, printed.out)
  const json = JSON.parse(printed.out)
  assert.equal(json.preset, 'team')
  assert.deepEqual(json.protected, ['main'])
  assert.deepEqual(json.gates, { commit: [], verify: ['npm test'] })
  assert.equal(json.wip, 3)

  r.write(CONFIG_FILE, '{\n  "version": 2,\n  "dir": "../outside"\n}\n')
  const failed = r.node(guard, 'config')
  assert.equal(failed.status, 1)
  assert.match(failed.out, /✖ \.resaledger\.json:3: "dir" must be a relative folder inside the repository/)
})
