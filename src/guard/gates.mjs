// The quality gates and their stamps (spec 5.7): running the gate commands, and the
// content-addressed record that they passed on exactly the committed code.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.mjs'
import { fail, plural, repositoryRoot } from './util.mjs'
import { fingerprint, isCode, treeReader } from './workspace.mjs'

const GATES_OUTPUT_LINES = 80
const GATES_STAMP_VERSION = 1
const GATES_SHOWN_PATHS = 5
const GATES_STAMP_NAME = /^[0-9a-f]{16}\.json$/

/**
 * Runs each command through the shell (sh, or cmd.exe on Windows) from the repository root,
 * in order, and stops at the first failure. A pass prints one line; a failure prints the last
 * 80 lines of the command's combined output. Never exits: returns
 * { passed: [{ command, seconds }], failure: { command, status, output } | null }.
 */
export function runGates(commands, options = {}) {
  const root = options.root ?? repositoryRoot()
  const passed = []
  for (const command of commands) {
    const started = Date.now()
    // stdout and stderr share one file, so the output keeps the order the command wrote it in.
    const folder = mkdtempSync(join(tmpdir(), 'resaledger-gate-'))
    const file = join(folder, 'output')
    let result
    let output
    try {
      const descriptor = openSync(file, 'w')
      try {
        result = spawnSync(command, { cwd: root, shell: true, stdio: ['ignore', descriptor, descriptor], windowsHide: true })
      } finally {
        closeSync(descriptor)
      }
      output = readFileSync(file, 'utf8')
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
    const seconds = Math.round((Date.now() - started) / 100) / 10
    if (result.error || result.status !== 0) {
      if (result.error) output += `${output === '' || output.endsWith('\n') ? '' : '\n'}${result.error.message}\n`
      const status = result.status ?? result.signal ?? 1
      const lines = output.replace(/\s+$/, '').split(/\r?\n/)
      if (lines.length > GATES_OUTPUT_LINES) console.error(`… ${lines.length - GATES_OUTPUT_LINES} lines above`)
      if (output.trim() !== '') console.error(lines.slice(-GATES_OUTPUT_LINES).join('\n'))
      console.error(`✖ ${command} exited with ${status}`)
      return { passed, failure: { command, status, output } }
    }
    console.log(`✔ ${command} (${seconds} s)`)
    passed.push({ command, seconds })
  }
  return { passed, failure: null }
}

/** The repository-relative path of the stamp for a fingerprint: <dir>/verified/<first 16 hex>.json. */
export function stampPath(config, fingerprint) {
  return `${config.dir}/verified/${fingerprint.slice(0, 16)}.json`
}

/** The gates of a stamp: a SHA-256 hex digest of the fingerprint and the gate commands, one per line. */
export function gatesDigest(fingerprint, gates) {
  return createHash('sha256').update([fingerprint, ...gates].join('\n')).digest('hex')
}

/**
 * The exact text of a stamp: no time, durations or names, so equal code gives equal bytes.
 * Its content must depend on the fingerprint almost everywhere. Otherwise git's rename detection
 * pairs a stamp that a branch deletes with the one it adds, and two branches that both prune the
 * same stamp conflict (rename/rename) when they merge.
 */
function gatesStampText(fingerprint, gates) {
  return `${JSON.stringify({ version: GATES_STAMP_VERSION, fingerprint, gates: gatesDigest(fingerprint, gates) }, null, 2)}\n`
}

/**
 * The parsed stamp for a fingerprint in the reader's source, or null when the file is missing,
 * is not valid JSON, names another full fingerprint or was written for other gates than the
 * configured ones. A stamp is a claim, not a proof (spec 12).
 */
export function verifiedStamp(reader, config, fingerprint) {
  const text = reader.read(stampPath(config, fingerprint))
  if (text === null || text === undefined) return null
  let stamp
  try {
    stamp = JSON.parse(text)
  } catch {
    return null
  }
  if (stamp === null || typeof stamp !== 'object' || stamp.fingerprint !== fingerprint) return null
  if (stamp.gates !== gatesDigest(fingerprint, gatesConfigured(config))) return null
  return stamp
}

/** Every configured gate: the commit gates, then the verify gates. */
function gatesConfigured(config) {
  return [...config.gates.commit, ...config.gates.verify]
}

/** The configuration from the working tree of the repository, or a refusal. */
function gatesLoadConfig(root) {
  const { config, problems } = loadConfig(treeReader({ kind: 'worktree', root }))
  if (!config) {
    for (const { file, line, message } of problems) console.error(`✖ ${file}${line ? `:${line}` : ''}: ${message}`)
    process.exit(1)
  }
  return config
}

/** The code paths with staged, unstaged or untracked changes, in git's order. */
function gatesUncommittedCode(root, config) {
  // Not util's git(): its trim would cut the leading space of the first status code.
  const result = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) fail(`git status failed: ${result.stderr.trim()}`)
  const records = result.stdout.split('\0')
  const paths = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.length < 4) continue
    const state = record.slice(0, 2)
    paths.push(record.slice(3))
    // A rename or copy in the index is followed by its original path, which changed too.
    if (state[0] === 'R' || state[0] === 'C') {
      index += 1
      if (records[index]) paths.push(records[index])
    }
  }
  return [...new Set(paths)].filter((path) => isCode(path, config))
}

/**
 * The tracked code paths whose working-tree changes git hides: marked skip-worktree (tag S in
 * `git ls-files -v`) or assume-unchanged (a lowercase tag). git status shows no change for them,
 * so the gates could run on code that differs from the commit the stamp names.
 */
function gatesHiddenCode(root, config) {
  const result = spawnSync('git', ['ls-files', '-v', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) fail(`git ls-files failed: ${result.stderr.trim()}`)
  const paths = []
  for (const record of result.stdout.split('\0')) {
    if (record.length < 3) continue
    const tag = record[0]
    if ((tag === 'S' || (tag >= 'a' && tag <= 'z')) && isCode(record.slice(2), config)) paths.push(record.slice(2))
  }
  return [...new Set(paths)]
}

/** The first five paths, and how many more there are. */
function gatesShown(paths) {
  const shown = paths.slice(0, GATES_SHOWN_PATHS).join(', ')
  return paths.length > GATES_SHOWN_PATHS ? `${shown} and ${paths.length - GATES_SHOWN_PATHS} more` : shown
}

/**
 * verify [--force]: runs the commit gates, then the verify gates, on the committed code and
 * writes the stamp for its fingerprint, deleting every other stamp. When the stamp already
 * exists with the same gates, runs nothing; --force runs the gates anyway.
 */
export function verifyCommand(args = []) {
  let force = false
  for (const arg of args) {
    if (arg === '--force') force = true
    else fail(`unknown option "${arg}" for verify; use --force`)
  }
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }
  const config = gatesLoadConfig(root)
  const gates = gatesConfigured(config)
  if (gates.length === 0) {
    console.log('No gates are configured in .resaledger.json, so there is nothing to verify.')
    return
  }

  const uncommitted = gatesUncommittedCode(root, config)
  if (uncommitted.length > 0) {
    fail(`uncommitted code: ${gatesShown(uncommitted)}. Commit it first: the gates run on the committed code, and the stamp names it`)
  }
  const hidden = gatesHiddenCode(root, config)
  if (hidden.length > 0) {
    fail(
      `git hides working-tree changes to code: ${gatesShown(hidden)} ${hidden.length === 1 ? 'is' : 'are'} marked skip-worktree or assume-unchanged, so the gates could run on code the stamp does not name. Undo it with "git update-index --no-skip-worktree --no-assume-unchanged <path>" (or "git sparse-checkout disable" in a sparse checkout), commit any change it reveals, and run verify again`
    )
  }

  let code
  try {
    code = fingerprint({ kind: 'commit', rev: 'HEAD', root }, config)
  } catch {
    fail('there is no commit to verify yet; commit the code first')
  }
  const path = stampPath(config, code)
  const existing = verifiedStamp(treeReader({ kind: 'worktree', root }), config, code)
  if (existing !== null && !force) {
    console.log(`✔ this code is already verified: ${path}. Run "verify --force" to run the gates again.`)
    return
  }

  const { passed, failure } = runGates(gates, { root })
  if (failure) {
    console.error(`✖ a gate failed, so no stamp was written. Fix the code; a gate is never weakened to make it pass`)
    process.exit(1)
  }

  const folder = join(root, config.dir, 'verified')
  mkdirSync(folder, { recursive: true })
  const name = path.slice(path.lastIndexOf('/') + 1)
  writeFileSync(join(folder, name), gatesStampText(code, gates))
  // Only regular files named like a stamp are stamps; anything else in verified/ is left alone.
  const pruned = readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && GATES_STAMP_NAME.test(entry.name) && entry.name !== name)
    .map((entry) => entry.name)
  for (const entry of pruned) {
    try {
      unlinkSync(join(folder, entry))
    } catch (error) {
      fail(`wrote ${path}, but could not remove the old stamp ${config.dir}/verified/${entry} (${error.code ?? error.message}). Delete it yourself, then commit the stamps with the records`)
    }
  }
  const removed = pruned.length > 0 ? `, removed ${plural(pruned.length, 'old stamp')}` : ''
  console.log(`✔ ${passed.length === 1 ? 'the gate' : `all ${passed.length} gates`} passed: wrote ${path}${removed}. Commit it with the records.`)
}

/** gates: lists the commit gates and the verify gates. */
export function gatesCommand() {
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }
  const config = gatesLoadConfig(root)
  const print = (title, commands) => {
    console.log(title)
    if (commands.length === 0) console.log('  none')
    for (const command of commands) console.log(`  ${command}`)
  }
  print('Commit gates (pre-commit runs them on every commit that changes code):', config.gates.commit)
  print('Verify gates ("verify" runs them after the commit gates):', config.gates.verify)
}
