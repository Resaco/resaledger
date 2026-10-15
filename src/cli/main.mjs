// The package's own command line: `npx resaledger <command>`.
// init and update come in later tasks.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyMigration, BUILT_GUARD, COMMIT_COMMAND, PACKAGE_ROOT, planMigration, UNDO_COMMAND } from './migrate.mjs'

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

const HELP = `ResaLedger ${version}

Usage: npx resaledger <command>

Commands:
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
  if (!existsSync(BUILT_GUARD)) {
    const built = spawnSync(process.execPath, [join(PACKAGE_ROOT, 'scripts', 'bundle.mjs')], { stdio: 'inherit' })
    if (built.status !== 0) {
      console.error('resaledger: the guard could not be built')
      process.exit(1)
    }
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
  let hooksNote = ''
  const hooksPath = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  if (hooksPath === '') {
    spawnSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: root })
    hooksNote = ' && git config --unset core.hooksPath'
    console.log('\n✔ git hooks turned on: core.hooksPath is .githooks')
  } else if (hooksPath.replace(/^\.\//, '').replace(/\/+$/, '') !== '.githooks')
    console.log(`\n! core.hooksPath is "${hooksPath}", so the hooks in .githooks/ do not run; call the guard from your hooks instead (node ${dir}/scripts/records.mjs pre-commit, commit-msg "$1", pre-push "$@")`)
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
  ${UNDO_COMMAND}${hooksNote}`)
  if (check.status !== 0 && plan.problems.length === 0) process.exit(1)
}

export function main(argv) {
  const [command = 'help'] = argv
  if (command === 'version' || command === '--version') console.log(version)
  else if (command === 'help' || command === '--help') process.stdout.write(HELP)
  else if (command === 'migrate') migrateCommand(argv.slice(1))
  else {
    console.error(`resaledger: unknown command "${command}"; run "resaledger help" for the list`)
    process.exitCode = 1
  }
}

main(process.argv.slice(2))
