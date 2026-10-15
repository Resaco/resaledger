// The command line of the guard. This module runs last in the bundle.
// VERSION is defined by scripts/bundle.mjs from package.json.
import { readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { isatty } from 'node:tty'
import { hookCommand } from './agents.mjs'
import { changesCommand } from './changes.mjs'
import { ciCommand } from './ci.mjs'
import { claimCommand } from './claim.mjs'
import { DEFAULTS, effectiveConfigJson, loadConfig } from './config.mjs'
import { newCommand, taskCommand } from './create.mjs'
import { gatesCommand, verifyCommand } from './gates.mjs'
import { handoffCommand } from './handoff.mjs'
import { activateHooks, commitMsg, hooksActive, preCommit, prePush } from './githooks.mjs'
import { checkRange } from './range.mjs'
import { fail, repositoryRoot } from './util.mjs'
import { checkCommand } from './workspace.mjs'
import { workCommand } from './work.mjs'

const HELP = `ResaLedger ${VERSION}

Usage: node ledger/scripts/records.mjs <command>

Commands:
  work [--all] [--fetch] [--json]
            the state: this lane, the other local worktrees, what is ready
            (also: status); turns on the git hooks; --all adds the pushed
            branches not merged into the base, --fetch fetches them first
  task <id> one task file, then the plan section its Plan link points to
  new [<prefix>] "<title>" [--under <id>] [--issue <n>]
            a todo task with the next free id (prefix T by default):
            higher than any in this worktree, the other worktrees and
            the fetched branches; --under S4 makes the next child, S4.1;
            --issue records the issue and, with no title, asks gh for it
  new decision "<title>"
            a decision file with today's date
  new log "<title>"
            a log entry with today's date and this lane
  claim <id> [--take] [--branch <name>] [--worktree <path>] [--push]
            take a task: refuses one another lane holds (here, in another
            worktree or on a pushed branch; team fetches first), sets
            Status: doing and Lane, and checks the WIP limit and the plan;
            --take takes it over and records where from; on a protected
            base, or with --branch, it creates the lane branch first;
            --worktree creates it in a new worktree; with claimPush or
            --push it commits the claim alone and pushes the branch
  changes [--since <ref>] [--json]
            the tasks that became done since a tag (the newest by default),
            with their evidence, grouped as Added, Changed and Fixed from
            the Conventional Commits that name them: a changelog draft in
            Markdown; read-only
  check     validate the records in the working tree
            (--index: the staged files; --rev <rev>: a commit;
            --range <from>..<to>: also that every commit names its task)
  ci [--base <rev> --head <rev> [--lane <branch>]] [--release <folder>]
     [--only-base-pushes]
            the CI check of a pull request or a push, read from the GitHub
            event; with --lane, a pull request from that lane, and without
            it, a push of the commits from --base to --head. It writes the
            job summary and comments on the pull request when it can.
            --release counts an unpacked resaledger package as released;
            --only-base-pushes checks only pushes to the base or a
            protected branch
  config    print the effective configuration
  gates     list the commit gates and the verify gates
  handoff   the end-of-session check: records, hooks, a clean tree, the
            stamp, current handoff notes and recorded, pushed commits
  hooks [--activate]
            say whether the git hooks are active; --activate turns them on
  verify [--force]
            run the gates on the committed code and write its stamp
            (--force: run them even when the stamp exists)
  hook <agent> <event>
            called by an agent's own hooks with its JSON on stdin; agent is
            claude, codex, cursor, gemini or copilot, event is session-start,
            pre-tool or stop. It refuses --no-verify, changes to
            core.hooksPath, forced pushes, pushes and edits on a protected
            branch, commands that throw work away (reset --hard, clean -f,
            checkout of paths, restore, switch -f) in a protected branch's
            checkout or another worktree, and agent.deny commands
            (exit code 2, the reason on stderr), and reminds once per
            session when handoff fails after the session changed the
            repository
  version   print the version
  help      print this help
`

/** A reader for files in the working tree at the repository root: text, or null when missing. */
function workingTreeReader(root) {
  return (path) => {
    try {
      return readFileSync(join(root, path), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
      throw error
    }
  }
}

/** Prints each problem as a refusal line on stderr. */
function printProblems(problems) {
  for (const { file, line, message } of problems) console.error(`✖ ${file}${line ? `:${line}` : ''}: ${message}`)
}

function configCommand() {
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }
  const { config, problems } = loadConfig(workingTreeReader(root))
  if (problems.length > 0) {
    printProblems(problems)
    process.exit(1)
  }
  console.log(effectiveConfigJson(config))
}

/**
 * All of stdin as text, up to its end; '' for a terminal. The caller (an agent, or git for
 * pre-push) may write after this process starts, and a pipe can be non-blocking, so a read
 * that finds nothing yet (EAGAIN) waits and tries again instead of taking the input as empty.
 * That wait ends after STDIN_WAIT_MS with what was read; a blocking pipe that never closes is
 * left to the caller's own hook timeout, as any read would be. process.stdin is never touched:
 * opening it makes the pipe non-blocking.
 */
const STDIN_WAIT_MS = 10 * 1000
function readStdin() {
  if (isatty(0)) return ''
  const chunks = []
  const buffer = Buffer.alloc(64 * 1024)
  const pause = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + STDIN_WAIT_MS
  for (;;) {
    let count
    try {
      count = readSync(0, buffer, 0, buffer.length, null)
    } catch (error) {
      if (error.code === 'EAGAIN' && Date.now() < deadline) {
        Atomics.wait(pause, 0, 0, 5)
        continue
      }
      if (['EAGAIN', 'EOF', 'EBADF'].includes(error.code)) break
      throw error
    }
    if (count === 0) break
    chunks.push(Buffer.from(buffer.subarray(0, count)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function hooksCommand(args) {
  let root
  try {
    root = repositoryRoot()
  } catch {
    fail('not inside a git repository')
  }
  const dir = loadConfig(workingTreeReader(root)).config?.dir ?? DEFAULTS.dir
  const guard = `node ${dir}/scripts/records.mjs`
  const activate = args.includes('--activate')
  if (activate) {
    const result = activateHooks()
    if (result === 'activated') console.log('✔ git hooks turned on: core.hooksPath is .githooks')
    else if (result === 'active') console.log('✔ core.hooksPath is already .githooks')
    else {
      console.error(`✖ core.hooksPath is already "${result.foreign}", so ResaLedger changed nothing.
  Call the guard from those hooks instead:
    ${guard} pre-commit            (pre-commit)
    ${guard} pre-merge-commit      (pre-merge-commit)
    ${guard} commit-msg "$1"       (commit-msg)
    ${guard} pre-push "$@"         (pre-push, with its stdin)`)
      process.exit(1)
    }
  }
  if (hooksActive()) console.log('✔ the git hooks are active in this clone')
  else if (activate) fail('a hook in .githooks/ is missing or is not the ResaLedger hook; run "npx resaledger update" to restore it')
  else {
    console.error(`✖ the git hooks are not active in this clone; run "${guard} hooks --activate"`)
    process.exit(1)
  }
}

export function main(argv) {
  const [command = 'help'] = argv
  if (command === 'version' || command === '--version') console.log(VERSION)
  else if (command === 'help' || command === '--help') process.stdout.write(HELP)
  else if (command === 'work' || command === 'status') workCommand(argv.slice(1))
  else if (command === 'task') taskCommand(argv[1])
  else if (command === 'new') newCommand(argv.slice(1))
  else if (command === 'claim') claimCommand(argv.slice(1))
  else if (command === 'changes') changesCommand(argv.slice(1))
  else if (command === 'ci') ciCommand(argv.slice(1))
  else if (command === 'check') checkCommand(argv.slice(1), checkRange)
  else if (command === 'config') configCommand()
  else if (command === 'gates') gatesCommand()
  else if (command === 'verify') verifyCommand(argv.slice(1))
  else if (command === 'handoff') handoffCommand(argv.slice(1))
  else if (command === 'hooks') hooksCommand(argv.slice(1))
  else if (command === 'pre-commit' || command === 'pre-merge-commit') preCommit(command)
  else if (command === 'commit-msg') {
    if (!argv[1]) fail('commit-msg needs the message file, as git passes it: commit-msg <file>')
    commitMsg(argv[1])
  } else if (command === 'pre-push') prePush(readStdin(), argv.slice(1))
  else if (command === 'hook') hookCommand(argv[1], argv[2], readStdin())
  else fail(`unknown command "${command}"; run "help" for the list`)
}

main(process.argv.slice(2))
