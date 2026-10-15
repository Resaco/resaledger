// The gates and their stamps: running the gate commands, the content-addressed stamp, its
// idempotence and pruning, merges of stamps between branches, and the commands through the bundle.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { parseConfig } from '../src/guard/config.mjs'
import { gatesDigest, stampPath, verifiedStamp } from '../src/guard/gates.mjs'
import { fingerprint, treeReader } from '../src/guard/workspace.mjs'
import { PACKAGE, repository, run, temporary } from './helpers.mjs'

const GUARD = join(temporary(), 'records.mjs')
const built = run(PACKAGE, process.execPath, [join(PACKAGE, 'scripts', 'bundle.mjs'), '--out', GUARD])
if (built.status !== 0) throw new Error(`bundle failed: ${built.out}`)

const PASS = 'node -e "process.exit(0)"'
const LOUD_FAILURE = 'node -e "for (let i = 1; i <= 100; i++) console.log(\'line \' + i); process.exit(3)"'

/** A gate that appends one character to a file outside the repository, so a test can count runs. */
function counting(file) {
  return `node -e "require('fs').appendFileSync(process.argv[1], 'x')" "${file}"`
}

function runs(file) {
  return existsSync(file) ? readFileSync(file, 'utf8').length : 0
}

/** A repository with a configuration, a minimal workspace and some code, committed on main. */
function project(gates = { commit: [PASS], verify: [PASS] }) {
  const r = repository()
  r.write('.resaledger.json', `${JSON.stringify({ version: 2, gates }, null, 2)}\n`)
  r.write('ledger/README.md', '# Project\n\n## Goal\n\nA small app.\n\n## Environments\n\nLocal only.\n\n## Manual checks\n\nNone.\n')
  r.write('src/app.js', 'export const answer = 42\n')
  const committed = r.commit('initial')
  assert.equal(committed.status, 0, committed.out)
  return r
}

function config(r) {
  return parseConfig(r.read('.resaledger.json')).config
}

function stamps(r) {
  const folder = join(r.root, 'ledger', 'verified')
  return existsSync(folder) ? readdirSync(folder).sort() : []
}

function headFingerprint(r) {
  return fingerprint({ kind: 'commit', rev: 'HEAD', root: r.root }, config(r))
}

function verify(r, ...args) {
  return r.node(GUARD, 'verify', ...args)
}

/** Verifies and commits the stamp, failing the test when either step fails. */
function verifyAndCommit(r, message = 'chore: verify') {
  const verified = verify(r)
  assert.equal(verified.status, 0, verified.out)
  const committed = r.commit(message)
  assert.equal(committed.status, 0, committed.out)
}

describe('stamps', () => {
  test('stampPath names the stamp by the first 16 hex digits of the fingerprint', () => {
    const fp = '3f2a9c1e5b7d4a60aaaabbbbccccddddeeeeffff'
    assert.equal(stampPath({ dir: 'ledger' }, fp), 'ledger/verified/3f2a9c1e5b7d4a60.json')
    assert.equal(stampPath({ dir: 'work/ledger' }, fp), 'work/ledger/verified/3f2a9c1e5b7d4a60.json')
  })

  test('the stamp content is deterministic and binds the commit gates, then the verify gates, to the code', () => {
    const second = 'node -e "process.exit(0)" && node -e "0"'
    const r = project({ commit: [PASS], verify: [second] })
    const verified = verify(r)
    assert.equal(verified.status, 0, verified.out)
    const fp = headFingerprint(r)
    const path = stampPath(config(r), fp)
    const digest = gatesDigest(fp, [PASS, second])
    assert.match(digest, /^[0-9a-f]{64}$/)
    assert.notEqual(digest, gatesDigest(fp, [second, PASS]))
    assert.notEqual(digest, gatesDigest(`${fp.slice(0, -1)}0`, [PASS, second]))
    assert.equal(r.read(path), `${JSON.stringify({ version: 1, fingerprint: fp, gates: digest }, null, 2)}\n`)
    assert.match(verified.out, /✔ node -e "process.exit\(0\)" \(\d+(\.\d)? s\)/)
    assert.match(verified.out, new RegExp(`wrote ${path.replace(/\./g, '\\.')}\\. Commit it with the records`))
  })

  test('verifiedStamp refuses a forged stamp and invalid JSON', () => {
    const r = project()
    const c = config(r)
    const fp = headFingerprint(r)
    const reader = () => treeReader({ kind: 'worktree', root: r.root })
    assert.equal(verifiedStamp(reader(), c, fp), null)

    const other = `${fp.slice(0, 16)}${'0'.repeat(24)}`
    r.write(stampPath(c, fp), JSON.stringify({ version: 1, fingerprint: other, gates: gatesDigest(other, [PASS, PASS]) }))
    assert.equal(verifiedStamp(reader(), c, fp), null)
    r.write(stampPath(c, fp), '{ "version": 1, "fingerprint": ')
    assert.equal(verifiedStamp(reader(), c, fp), null)
    const genuine = { version: 1, fingerprint: fp, gates: gatesDigest(fp, [PASS, PASS]) }
    r.write(stampPath(c, fp), JSON.stringify(genuine))
    assert.deepEqual(verifiedStamp(reader(), c, fp), genuine)
  })

  test('verifiedStamp refuses a stamp whose gates digest does not match the configured gates', () => {
    const r = project()
    verifyAndCommit(r)
    const c = config(r)
    const fp = headFingerprint(r)
    const path = stampPath(c, fp)
    const reader = () => treeReader({ kind: 'worktree', root: r.root })
    assert.notEqual(verifiedStamp(reader(), c, fp), null)

    const stamp = JSON.parse(r.read(path))
    const edited = `${stamp.gates.slice(0, -1)}${stamp.gates.endsWith('0') ? '1' : '0'}`
    r.write(path, `${JSON.stringify({ ...stamp, gates: edited }, null, 2)}\n`)
    assert.equal(verifiedStamp(reader(), c, fp), null)

    // The genuine stamp, read with other configured gates, no longer counts either.
    r.write(path, `${JSON.stringify(stamp, null, 2)}\n`)
    const changed = { ...c, gates: { commit: [PASS], verify: [] } }
    assert.equal(verifiedStamp(reader(), changed, fp), null)
  })

  test('a commit that changes only a record keeps the stamp valid', () => {
    const r = project()
    verifyAndCommit(r)
    const before = headFingerprint(r)
    r.write('ledger/tasks/S1-start.md', '# S1 Start\n\n- Status: todo\n')
    r.write('docs/notes.md', '# Notes\n')
    assert.equal(r.commit('docs: a task and notes').status, 0)
    const after = headFingerprint(r)
    assert.equal(after, before)
    const reader = treeReader({ kind: 'commit', rev: 'HEAD', root: r.root })
    assert.notEqual(verifiedStamp(reader, config(r), after), null)
  })
})

describe('verify', () => {
  test('a failing gate stops the run, shows the last 80 lines and exits 1', () => {
    const r = project()
    const counter = join(temporary(), 'count')
    r.write('.resaledger.json', `${JSON.stringify({ version: 2, gates: { commit: [PASS, LOUD_FAILURE], verify: [counting(counter)] } }, null, 2)}\n`)
    assert.equal(r.commit('chore: gates').status, 0)
    const failed = verify(r)
    assert.equal(failed.status, 1, failed.out)
    assert.equal(runs(counter), 0)
    assert.match(failed.out, /✔ node -e "process\.exit\(0\)"/)
    assert.match(failed.out, /… 20 lines above\nline 21\n/)
    assert.match(failed.out, /line 100\n✖ node -e .* exited with 3\n/)
    assert.doesNotMatch(failed.out, /line 20\n/)
    assert.match(failed.out, /no stamp was written/)
    assert.deepEqual(stamps(r), [])
  })

  test('a failure leaves the existing stamps as they are', () => {
    const r = project()
    verifyAndCommit(r)
    const before = stamps(r)
    r.write('.resaledger.json', `${JSON.stringify({ version: 2, gates: { commit: ['node -e "process.exit(2)"'], verify: [] } }, null, 2)}\n`)
    assert.equal(r.commit('chore: a failing gate').status, 0)
    const failed = verify(r)
    assert.equal(failed.status, 1, failed.out)
    assert.match(failed.out, /✖ node -e "process\.exit\(2\)" exited with 2/)
    assert.deepEqual(stamps(r), before)
  })

  test('two runs on the same code leave one identical file, and the second runs nothing', () => {
    const counter = join(temporary(), 'count')
    const r = project({ commit: [], verify: [counting(counter)] })
    const first = verify(r)
    assert.equal(first.status, 0, first.out)
    assert.equal(runs(counter), 1)
    const [name] = stamps(r)
    const bytes = r.read(`ledger/verified/${name}`)

    const second = verify(r)
    assert.equal(second.status, 0, second.out)
    assert.match(second.out, /already verified/)
    assert.equal(runs(counter), 1)
    assert.deepEqual(stamps(r), [name])
    assert.equal(r.read(`ledger/verified/${name}`), bytes)

    // Committing the stamp changes no code, so the stamp still describes HEAD.
    assert.equal(r.commit('chore: verify').status, 0)
    assert.match(verify(r).out, /already verified/)
    assert.equal(runs(counter), 1)
  })

  test('--force runs the gates again and writes the same bytes', () => {
    const counter = join(temporary(), 'count')
    const r = project({ commit: [], verify: [counting(counter)] })
    verifyAndCommit(r)
    const [name] = stamps(r)
    const bytes = r.read(`ledger/verified/${name}`)
    const forced = verify(r, '--force')
    assert.equal(forced.status, 0, forced.out)
    assert.equal(runs(counter), 2)
    assert.equal(r.read(`ledger/verified/${name}`), bytes)
    assert.equal(r.git('status', '--porcelain').out, '')
  })

  test('changed gates run again even when the stamp for the code exists', () => {
    const r = project()
    verifyAndCommit(r)
    const c = config(r)
    const path = stampPath(c, headFingerprint(r))
    const stamp = JSON.parse(r.read(path))
    r.write(path, `${JSON.stringify({ ...stamp, gates: gatesDigest(stamp.fingerprint, ['node -e "0"']) }, null, 2)}\n`)
    const again = verify(r)
    assert.equal(again.status, 0, again.out)
    assert.doesNotMatch(again.out, /already verified/)
    assert.equal(JSON.parse(r.read(path)).gates, gatesDigest(stamp.fingerprint, [PASS, PASS]))
  })

  test('a code change writes a new stamp and deletes the old one', () => {
    const r = project()
    verifyAndCommit(r)
    const [old] = stamps(r)
    r.write('ledger/verified/notes.txt', 'not a stamp\n')
    r.write('src/app.js', 'export const answer = 43\n')
    assert.equal(r.commit('feat: a new answer').status, 0)
    const verified = verify(r)
    assert.equal(verified.status, 0, verified.out)
    assert.match(verified.out, /removed 1 old stamp\b/)
    const expected = stampPath(config(r), headFingerprint(r)).split('/').pop()
    assert.notEqual(expected, old)
    assert.deepEqual(stamps(r), [expected, 'notes.txt'])
  })

  test('prunes only regular files named like a stamp, and leaves other files and folders alone', () => {
    const r = project()
    verifyAndCommit(r)
    const [old] = stamps(r)
    r.write('ledger/verified/notes.json', '{ "mine": true }\n')
    r.write('ledger/verified/dir.json/inner.txt', 'a folder named like JSON\n')
    r.write('ledger/verified/ABCDEF0123456789.json', '{}\n')
    r.write('src/app.js', 'export const answer = 44\n')
    assert.equal(r.commit('feat: another answer').status, 0)
    const verified = verify(r)
    assert.equal(verified.status, 0, verified.out)
    assert.match(verified.out, /removed 1 old stamp\b/)
    const expected = stampPath(config(r), headFingerprint(r)).split('/').pop()
    assert.notEqual(expected, old)
    assert.deepEqual(stamps(r), [expected, 'ABCDEF0123456789.json', 'dir.json', 'notes.json'].sort())
  })

  test('an old stamp that cannot be removed is a clear refusal, not a crash', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    const r = project()
    verifyAndCommit(r)
    const [old] = stamps(r)
    r.write('src/app.js', 'export const answer = 45\n')
    assert.equal(r.commit('feat: a fifth answer').status, 0)
    // The new stamp already exists as a file, so it can be written; the read-only folder keeps the old one.
    const fresh = stampPath(config(r), headFingerprint(r))
    r.write(fresh, 'not yet\n')
    const folder = join(r.root, 'ledger', 'verified')
    chmodSync(folder, 0o555)
    let result
    try {
      result = verify(r)
    } finally {
      chmodSync(folder, 0o755)
    }
    assert.equal(result.status, 1, result.out)
    assert.match(result.out, new RegExp(`resaledger: wrote ${fresh}, but could not remove the old stamp ledger/verified/${old} \\(EACCES\\)\\. Delete it yourself`))
    assert.doesNotMatch(result.out, /at .*gates|Error:/)
  })

  test('code that git hides with skip-worktree or assume-unchanged is refused, with how to undo it', () => {
    for (const flag of ['--skip-worktree', '--assume-unchanged']) {
      const counter = join(temporary(), 'count')
      const r = project({ commit: [], verify: [counting(counter)] })
      r.git('update-index', flag, 'src/app.js')
      r.write('src/app.js', 'export const answer = 0\n')
      assert.equal(r.git('status', '--porcelain').out, '', flag)
      const refused = verify(r)
      assert.equal(refused.status, 1, `${flag}: ${refused.out}`)
      assert.match(refused.out, /git hides working-tree changes to code: src\/app\.js is marked skip-worktree or assume-unchanged/, flag)
      assert.match(refused.out, /git update-index --no-skip-worktree --no-assume-unchanged <path>/, flag)
      assert.equal(runs(counter), 0, flag)
      assert.deepEqual(stamps(r), [], flag)
    }
  })

  test('a hidden record does not stop verify', () => {
    const r = project()
    r.git('update-index', '--skip-worktree', 'ledger/README.md')
    const verified = verify(r)
    assert.equal(verified.status, 0, verified.out)
  })

  test('a workspace file that code reads is code: changing it makes the stamp stale', () => {
    const r = project({ commit: [], verify: ['node app.js'] })
    r.write('ledger/evidence/config.js', 'module.exports = { ok: true }\n')
    r.write('app.js', 'process.exit(require("./ledger/evidence/config.js").ok ? 0 : 1)\n')
    assert.equal(r.commit('feat: read the configuration').status, 0)
    verifyAndCommit(r)
    r.write('ledger/evidence/config.js', 'module.exports = { ok: false }\n')
    const refused = verify(r)
    assert.equal(refused.status, 1, refused.out)
    assert.match(refused.out, /uncommitted code: ledger\/evidence\/config\.js\./)
    assert.equal(r.commit('docs: tweak').status, 0)
    const failed = verify(r)
    assert.equal(failed.status, 1, failed.out)
    assert.doesNotMatch(failed.out, /already verified/)
    assert.match(failed.out, /a gate failed, so no stamp was written/)
  })

  test('uncommitted code is refused and named: staged, unstaged and untracked', () => {
    const cases = {
      staged: (r) => {
        r.write('src/app.js', 'export const answer = 1\n')
        r.git('add', 'src/app.js')
        return 'src/app.js'
      },
      unstaged: (r) => {
        r.write('src/app.js', 'export const answer = 2\n')
        return 'src/app.js'
      },
      untracked: (r) => {
        r.write('src/new.js', 'export const added = true\n')
        return 'src/new.js'
      }
    }
    for (const [kind, change] of Object.entries(cases)) {
      const counter = join(temporary(), 'count')
      const r = project({ commit: [], verify: [counting(counter)] })
      const path = change(r)
      const refused = verify(r)
      assert.equal(refused.status, 1, `${kind}: ${refused.out}`)
      assert.match(refused.out, new RegExp(`uncommitted code: ${path.replace(/\./g, '\\.')}\\. Commit it first`), kind)
      assert.equal(runs(counter), 0, kind)
      assert.deepEqual(stamps(r), [], kind)
    }
  })

  test('the refusal names at most five paths, and uncommitted records do not count', () => {
    const r = project()
    for (let index = 1; index <= 7; index += 1) r.write(`src/file${index}.js`, `${index}\n`)
    r.write('ledger/tasks/S1-start.md', '# S1 Start\n\n- Status: todo\n')
    r.write('README.md', '# Readme\n')
    const refused = verify(r)
    assert.equal(refused.status, 1, refused.out)
    assert.match(refused.out, /uncommitted code: src\/file1\.js, src\/file2\.js, src\/file3\.js, src\/file4\.js, src\/file5\.js and 2 more\./)

    const clean = project()
    clean.write('ledger/tasks/S1-start.md', '# S1 Start\n\n- Status: todo\n')
    const verified = verify(clean)
    assert.equal(verified.status, 0, verified.out)
  })

  test('no gates: says so and exits 0', () => {
    const r = project({ commit: [], verify: [] })
    const result = verify(r)
    assert.equal(result.status, 0, result.out)
    assert.match(result.out, /No gates are configured/)
    assert.deepEqual(stamps(r), [])
  })

  test('an unknown option is refused', () => {
    const r = project()
    const result = verify(r, '--quick')
    assert.equal(result.status, 1)
    assert.match(result.out, /unknown option "--quick" for verify/)
  })
})

describe('merging stamps', () => {
  test('two branches that verify the same code merge without a conflict', () => {
    const r = project()
    const a = r.worktree('a')
    const b = r.worktree('b')
    verifyAndCommit(a, 'chore: verify on a')
    verifyAndCommit(b, 'chore: verify on b')
    const merged = a.git('merge', '--no-edit', 'b')
    assert.equal(merged.status, 0, merged.out)
    assert.deepEqual(stamps(a), stamps(b))
    assert.equal(stamps(a).length, 1)
  })

  // Ten gates of about 40 characters: the shared part of two stamps would dominate a readable list.
  const LONG = Array.from({ length: 10 }, (_, index) => `node -e "process.exit(0)" gate-number-${index}-ok`)
  const cases = [
    ['new stamp into prune', undefined],
    ['prune into new stamp', undefined],
    ['new stamp into prune, ten long gates', { commit: LONG.slice(0, 5), verify: LONG.slice(5) }],
    ['prune into new stamp, ten long gates', { commit: LONG.slice(0, 5), verify: LONG.slice(5) }]
  ]
  for (const [order, gates] of cases) {
    test(`a branch with a new stamp and a branch that pruned the old one merge cleanly: ${order}`, () => {
      const r = project(gates)
      verifyAndCommit(r)
      const [old] = stamps(r)
      const fresh = r.worktree('fresh')
      const pruned = r.worktree('pruned')

      fresh.write('src/fresh.js', 'export const fresh = true\n')
      assert.equal(fresh.commit('feat: fresh').status, 0)
      verifyAndCommit(fresh)
      pruned.write('src/other.js', 'export const other = true\n')
      assert.equal(pruned.commit('feat: other').status, 0)
      verifyAndCommit(pruned)
      assert.ok(!stamps(fresh).includes(old) && !stamps(pruned).includes(old))

      const [into, from] = order.startsWith('new stamp into prune') ? [pruned, 'fresh'] : [fresh, 'pruned']
      const merged = into.git('merge', '--no-edit', from)
      assert.equal(merged.status, 0, merged.out)
      const after = stamps(into)
      assert.equal(after.length, 2)
      assert.ok(!after.includes(old))

      // The merged code is new; verifying it leaves one stamp again.
      verifyAndCommit(into)
      assert.deepEqual(stamps(into), [stampPath(config(into), headFingerprint(into)).split('/').pop()])
    })
  }

  test('a branch that keeps the old stamp merges cleanly with one that pruned it', () => {
    const r = project()
    verifyAndCommit(r)
    const [old] = stamps(r)
    const pruned = r.worktree('pruned')
    pruned.write('src/other.js', 'export const other = true\n')
    assert.equal(pruned.commit('feat: other').status, 0)
    verifyAndCommit(pruned)
    r.write('ledger/tasks/S1-start.md', '# S1 Start\n\n- Status: todo\n')
    assert.equal(r.commit('docs: a task').status, 0)
    const merged = r.git('merge', '--no-edit', 'pruned')
    assert.equal(merged.status, 0, merged.out)
    assert.ok(!stamps(r).includes(old))
  })
})

describe('gates', () => {
  test('lists the commit gates and the verify gates, with none for an empty list', () => {
    const r = project({ commit: ['npm run lint'], verify: [] })
    const listed = r.node(GUARD, 'gates')
    assert.equal(listed.status, 0, listed.out)
    assert.equal(
      listed.out,
      'Commit gates (pre-commit runs them on every commit that changes code):\n  npm run lint\nVerify gates ("verify" runs them after the commit gates):\n  none\n'
    )
  })

  test('refuses a missing configuration', () => {
    const r = repository()
    const listed = r.node(GUARD, 'gates')
    assert.equal(listed.status, 1)
    assert.match(listed.out, /\.resaledger\.json is missing/)
  })
})
