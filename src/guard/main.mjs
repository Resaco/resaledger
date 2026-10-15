// The command line of the guard. This module runs last in the bundle.
// VERSION is defined by scripts/bundle.mjs from package.json.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ciCommand } from './ci.mjs'
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
  work [--json]
            the state: this lane, the other local worktrees, what is ready
            (also: status); turns on the git hooks
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
  check     validate the records in the working tree
            (--index: the staged files; --rev <rev>: a commit;
            --range <from>..<to>: also that every commit names its task)
  ci [--base <rev> --head <rev> [--lane <branch>]]
            the CI check of a pull request or a push, read from the GitHub
            event; with --lane, a pull request from that lane, and without
            it, a push of the commits from --base to --head
  config    print the effective configuration
  gates     list the commit gates and the verify gates
  handoff   the end-of-session check: records, hooks, a clean tree, the
            stamp, current handoff notes and recorded, pushed commits
  hooks [--activate]
            say whether the git hooks are active; --activate turns them on
  verify [--force]
            run the gates on the committed code and write its stamp
            (--force: run them even when the stamp exists)
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

/** All of stdin as text, or '' when there is nothing to read. */
function readStdin() {
  if (process.stdin.isTTY) return ''
  try {
    return readFileSync(0, 'utf8')
  } catch (error) {
    if (error.code === 'EOF' || error.code === 'EAGAIN') return ''
    throw error
  }
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
    ${guard} commit-msg "$1"       (commit-msg)
    ${guard} pre-push "$@"         (pre-push, with its stdin)`)
      process.exit(1)
    }
  }
  if (hooksActive()) console.log('✔ the git hooks are active in this clone')
  else if (activate) fail('.githooks/commit-msg is missing or is not the ResaLedger hook; run "npx resaledger update" to restore it')
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
  else if (command === 'ci') ciCommand(argv.slice(1))
  else if (command === 'check') checkCommand(argv.slice(1), checkRange)
  else if (command === 'config') configCommand()
  else if (command === 'gates') gatesCommand()
  else if (command === 'verify') verifyCommand(argv.slice(1))
  else if (command === 'handoff') handoffCommand(argv.slice(1))
  else if (command === 'hooks') hooksCommand(argv.slice(1))
  else if (command === 'pre-commit') preCommit()
  else if (command === 'commit-msg') {
    if (!argv[1]) fail('commit-msg needs the message file, as git passes it: commit-msg <file>')
    commitMsg(argv[1])
  } else if (command === 'pre-push') prePush(readStdin(), argv.slice(1))
  else fail(`unknown command "${command}"; run "help" for the list`)
}

main(process.argv.slice(2))
