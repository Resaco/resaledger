// The package's own command line: `npx resaledger <command>`.
// update comes in a later task.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { hooksActive } from '../guard/githooks.mjs'
import { SETUP_MARKER } from '../guard/records.mjs'
import { applyInit, commitCommand, initOptions, parseInitArgs, planInit, presetFromAnswer } from './init.mjs'
import { applyMigration, COMMIT_COMMAND, planMigration, UNDO_COMMAND } from './migrate.mjs'
import { ensureGuard, hooksNote, turnOnHooks } from './setup.mjs'

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

const HELP = `ResaLedger ${version}

Usage: npx resaledger <command>

Commands:
  init [--team] [--dir <name>] [--yes]
            set ResaLedger up in this repository: the configuration, the
            workspace README, the guard, the git hooks and the AGENTS.md block;
            --team chooses the team preset, --dir names the workspace folder
            (default ledger), --yes asks nothing and takes the defaults
  migrate [--dry-run] [--force] [--accept-problems]
            convert an agent-ledger 0.x workspace to ResaLedger 1.0 in place;
            --dry-run only shows the plan, --force replaces 0.x git hooks that
            were changed by hand, --accept-problems writes even when the result
            breaks a 1.0 rule and lists those problems as work to do
  version   print the version
  help      print this help
`

function list(title, items) {
  if (items.length === 0) return
  console.log(`\n${title} (${items.length}):`)
  for (const item of items) console.log(`  ${item}`)
}

function printProblem({ file, line, message }) {
  console.error(`  ✖ ${file}${line ? `:${line}` : ''}: ${message}`)
}

/** migrate [--dry-run] [--force] [--accept-problems], in the repository of the current folder. */
export function migrateCommand(args) {
  const options = { dryRun: false, force: false, acceptProblems: false }
  for (const arg of args) {
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--force') options.force = true
    else if (arg === '--accept-problems') options.acceptProblems = true
    else {
      console.error(`resaledger: unknown option "${arg}" for migrate; use --dry-run, --force or --accept-problems`)
      process.exit(1)
    }
  }
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  if (top.status !== 0) {
    console.error('resaledger: not inside a git repository')
    process.exit(1)
  }
  const root = top.stdout.trim()
  if (!ensureGuard()) {
    console.error('resaledger: the guard could not be built')
    process.exit(1)
  }

  const plan = planMigration(root, { force: options.force })
  if (plan.refusals.length > 0) {
    console.error('✖ resaledger migrate changed nothing:')
    for (const { message, detail } of plan.refusals) {
      console.error(`  ✖ ${message}`)
      if (detail) console.error(detail.replace(/^/gm, '      '))
    }
    process.exit(1)
  }

  const { report } = plan
  console.log(`resaledger migrate: agent-ledger 0.x to ResaLedger 1.0 (${report.counts.tasks} tasks, ${report.counts.decisions} decisions, ${report.counts.logEntries} log entries)`)
  list('Create', report.created)
  list('Change', report.changed)
  list('Rename', report.renamed)
  list('Delete', report.deleted)
  const rewritten = report.links.filter((link) => !link.unresolved)
  const unresolved = report.links.filter((link) => link.unresolved)
  if (rewritten.length > 0) console.log(`\nLinks rewritten into the new files: ${rewritten.length}`)
  list(
    'Links rewritten less precisely',
    rewritten.filter((link) => link.note).map((link) => `${link.file}:${link.line}: ${link.target} → ${link.rewritten} (${link.note})`)
  )
  list('Links that could not be rewritten', unresolved.map((link) => `${link.file}:${link.line}: ${link.target} (${link.unresolved})`))
  list('Waiting for, taken from the notes of blocked tasks', report.waiting.map(({ id, value }) => `${id}: ${value}`))
  list('Warnings', report.warnings.map((warning) => `! ${warning}`))
  if (plan.problems.length > 0) {
    console.error(`\nProblems with the 1.0 rules in the result (${plan.problems.length}):`)
    plan.problems.forEach(printProblem)
  }

  if (plan.problems.length > 0 && !options.acceptProblems) {
    console.error('\n✖ Nothing was written. Fix these in the 0.x records and commit, or run again with --accept-problems to write anyway and fix them afterwards.')
    process.exit(1)
  }
  if (options.dryRun) {
    console.log('\n--dry-run: nothing was written.')
    return
  }

  applyMigration(root, plan)
  const dir = JSON.parse(plan.writes.get('.resaledger.json')).dir
  const hooks = turnOnHooks(root)
  const undoHooks = hooks.state === 'activated' ? ' && git config --unset core.hooksPath' : ''
  if (hooks.state !== 'active') console.log(`\n${hooksNote(hooks, dir)}`)
  console.log(`\nwritten. Checking with the new guard: node ${dir}/scripts/records.mjs check`)
  const check = spawnSync(process.execPath, [join(root, dir, 'scripts', 'records.mjs'), 'check'], { cwd: root, stdio: 'inherit' })
  if (check.status !== 0 && plan.problems.length === 0) {
    console.error('✖ the migrated workspace does not pass check although it passed in memory; this is a bug in resaledger. Undo with the command below.')
  }
  if (plan.problems.length > 0) console.log(`\nFollow-up work: the ${plan.problems.length} problems listed above. Fix them before you commit, or commit and fix them next.`)
  console.log(`
Review the change, then commit it:
  ${COMMIT_COMMAND}
Then run "node ${dir}/scripts/records.mjs verify" to write the first stamp.
To undo everything instead:
  ${UNDO_COMMAND}${undoHooks}`)
  if (check.status !== 0 && plan.problems.length === 0) process.exit(1)
}

/** Asks solo or team (unless --team answered it) and the goal, on a terminal. */
async function askInit(flags) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answers = {}
    if (!flags.team) {
      for (;;) {
        answers.preset = await prompt.question('Solo or team? A team protects the base branch and pushes claims. [solo] ')
        if (presetFromAnswer(answers.preset)) break
        console.log('  Answer "solo" or "team".')
      }
    }
    answers.goal = await prompt.question('The goal, in one sentence: what is being built, for whom, and what counts as finished? (empty leaves a marker) ')
    return answers
  } finally {
    prompt.close()
  }
}

function refuseInit(messages) {
  console.error('✖ resaledger init changed nothing:')
  for (const message of messages) console.error(`  ✖ ${message}`)
  process.exit(1)
}

/** init [--team] [--dir <name>] [--yes], in the repository of the current folder. */
export async function initCommand(args) {
  const { flags, error } = parseInitArgs(args)
  if (error) {
    console.error(`resaledger: ${error}`)
    process.exit(1)
  }
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  if (top.status !== 0) refuseInit(['this folder is not in a git repository; run "git init" first, or run init inside a repository'])
  const root = top.stdout.trim()
  if (!ensureGuard()) refuseInit(['the guard could not be built'])

  // The refusals do not depend on the answers, so they come before the questions.
  let plan = planInit(root, initOptions(flags))
  if (plan.refusals.length > 0) refuseInit(plan.refusals)
  if (!flags.yes && process.stdin.isTTY && process.stdout.isTTY) {
    plan = planInit(root, initOptions(flags, await askInit(flags)))
    if (plan.refusals.length > 0) refuseInit(plan.refusals)
  }

  const result = applyInit(root, plan)
  const { dir } = plan
  console.log(`resaledger init: ResaLedger is set up in ${dir}/, with the ${plan.preset} preset`)
  list('Created', result.created)
  list('Changed', result.changed)
  list('Warnings', plan.warnings.map((warning) => `! ${warning}`))
  console.log(`\n${hooksNote(result.hooks, dir)}`)
  if (result.instructions) console.log(`\n${result.instructions}`)
  const active = hooksActive()
  const how = plan.manager === 'husky' ? 'install husky\'s hooks with "npx husky"' : 'see above'
  console.log(active ? '✔ the git hooks run the guard in this clone' : `! the git hooks do not run the guard in this clone yet; ${how}`)

  console.log(`\nChecking with the installed guard: node ${dir}/scripts/records.mjs check`)
  const check = spawnSync(process.execPath, [join(root, dir, 'scripts', 'records.mjs'), 'check'], { cwd: root, stdio: 'inherit' })
  if (check.status !== 0) console.error('✖ the new workspace does not pass check; this is a bug in resaledger, please report it')

  const files = [...new Set([...result.created, ...result.changed])].sort()
  const steps = []
  const sections = [...(plan.goalMarker ? ['Goal'] : []), 'Environments', 'Manual checks']
  steps.push(`Write the project's own text in ${dir}/README.md where a ${SETUP_MARKER} marker is (${sections.join(', ')}); "handoff" asks for it.`)
  steps.push(`Commit the setup:\n       ${commitCommand(files)}`)
  steps.push(`Start working: node ${dir}/scripts/records.mjs work`)
  console.log(`\nNext steps:\n${steps.map((step, index) => `  ${index + 1}. ${step}`).join('\n')}`)
  if (check.status !== 0) process.exit(1)
}

export function main(argv) {
  const [command = 'help'] = argv
  if (command === 'version' || command === '--version') console.log(version)
  else if (command === 'help' || command === '--help') process.stdout.write(HELP)
  else if (command === 'init')
    initCommand(argv.slice(1)).catch((error) => {
      console.error(`resaledger: ${error.message}`)
      process.exitCode = 1
    })
  else if (command === 'migrate') migrateCommand(argv.slice(1))
  else {
    console.error(`resaledger: unknown command "${command}"; run "resaledger help" for the list`)
    process.exitCode = 1
  }
}

main(process.argv.slice(2))
