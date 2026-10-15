// The package's own command line: `npx resaledger <command>`. init, update, migrate, version
// and help run here; every other command goes to the repository's own guard, so the committed
// version always decides.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { CONFIG_FILE, DEFAULTS, isSafeFolderPath, parseConfig } from '../guard/config.mjs'
import { hooksActive } from '../guard/githooks.mjs'
import { SETUP_MARKER } from '../guard/records.mjs'
import { recordCounts } from '../guard/util.mjs'
import { detectCommitStyle, detectGates } from './detect.mjs'
import { agentTrustLines, applyInit, commitCommand, initOptions, parseAgentsValue, parseInitArgs, planInit, presetFromAnswer } from './init.mjs'
import { LEGACY_CONFIG_FILE } from './legacy.mjs'
import { applyMigration, COMMIT_COMMAND, planMigration, UNDO_COMMAND } from './migrate.mjs'
import { currentBranch, ensureGuard, hooksNote, setupCommitSteps, turnOnHooks } from './setup.mjs'
import { applyUpdate, planUpdate, UPDATE_COMMIT_MESSAGE } from './update.mjs'

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

const HELP = `ResaLedger ${version}

Usage: npx resaledger <command>

Commands:
  init [--team] [--dir <name>] [--agents <names>] [--no-gates] [--yes]
            set ResaLedger up in this repository: the configuration, the
            workspace README, the guard, the git hooks, the AGENTS.md block,
            in the team preset the CI workflow and the pull request template,
            and the hook configurations of the agents in use (found by their
            folder or instruction file, such as .claude/, CLAUDE.md, .codex/,
            .cursor/, .gemini/, GEMINI.md or .github/copilot-instructions.md);
            the gates are the project's own checks (package.json scripts,
            Makefile targets, ruff, mypy, pytest, cargo, go), each run once
            offline and kept only when it passes, and the commit style comes
            from the history or a commitlint configuration.
            --team chooses the team preset, --dir names the workspace folder
            (default ledger), --agents claude,codex,cursor,gemini,copilot
            names the agents instead (none for no agent), --no-gates runs no
            check and leaves the gates for you to write, --yes asks nothing
            and takes the defaults and the gates that passed
  migrate [--dry-run] [--force] [--accept-problems]
            convert an agent-ledger 0.x workspace to ResaLedger 1.0 in place;
            --dry-run only shows the plan, --force replaces 0.x git hooks that
            were changed by hand, --accept-problems writes even when the result
            breaks a 1.0 rule and lists those problems as work to do
  update [--force] [--workflow] [--agents <names>]
            renew the guard, the git hooks, the CI workflow and the AGENTS.md
            block when they are a released version, and ResaLedger's entries
            in the agents' hook configurations that hold them; a file changed
            by hand is shown and kept, unless --force replaces it. --workflow
            adds the CI workflow, which the team preset has already; --agents
            adds the named agents' configurations. The README, the records,
            the configuration and your own text in AGENTS.md are never touched
  version   print the version
  help      print this help

Every other command, such as work, claim, verify or handoff, runs the
repository's own guard: npx resaledger work is node <dir>/scripts/records.mjs work.
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
  console.log(`resaledger migrate: agent-ledger 0.x to ResaLedger 1.0 (${recordCounts(report.counts.tasks, report.counts.decisions, report.counts.logEntries)})`)
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
  list(
    'Lanes taken from the one unmerged branch whose commits name the task',
    report.laneFromBranch.map(({ id, lane }) => `${id}: Lane: ${lane}`)
  )
  if (report.laneGiven.length > 0)
    console.log(`\ndoing tasks without a Lane get Lane: ${report.lane}; run migrate on the branch the work continues on, or take them over with claim --take afterwards.`)
  list('Warnings', report.warnings.map((warning) => `! ${warning}`))
  if (plan.problems.length > 0) {
    console.error(`\nProblems with the 1.0 rules in the result (${plan.problems.length}):`)
    plan.problems.forEach(printProblem)
  }

  if (plan.problems.length > 0 && !options.acceptProblems) {
    console.error(
      '\n✖ Nothing was written. Fix these in the 0.x records and commit, or run again with --accept-problems to write anyway; the commit of the migration is then refused until they are fixed.'
    )
    process.exit(1)
  }
  if (options.dryRun) {
    console.log('\n--dry-run: nothing was written.')
    return
  }

  try {
    applyMigration(root, plan)
  } catch (error) {
    // The hooks are turned on only after the files, so the undo has no hooks part here.
    console.error(`\n✖ writing the migration failed: ${error.message}`)
    console.error(`Some files were already written. Fix the cause, then undo everything and run migrate again:\n  ${UNDO_COMMAND}`)
    console.error('core.hooksPath was not changed.')
    process.exit(1)
  }
  const dir = JSON.parse(plan.writes.get(CONFIG_FILE)).dir
  const hooks = turnOnHooks(root)
  const undoHooks = hooks.state === 'activated' ? ' && git config --unset core.hooksPath' : ''
  if (hooks.state !== 'active') console.log(`\n${hooksNote(hooks, dir)}`)
  console.log(`\nWritten. Checking with the new guard: node ${dir}/scripts/records.mjs check`)
  const check = spawnSync(process.execPath, [join(root, dir, 'scripts', 'records.mjs'), 'check'], { cwd: root, encoding: 'utf8' })
  if (check.error) throw check.error
  process.stdout.write(check.stdout)
  process.stderr.write(check.stderr)
  // The counts check prints must be the plan's: a file git does not see passes in memory but is never committed.
  const counted = check.stdout.match(/records valid: (\d+) tasks?, (\d+) decisions?, (\d+) log entr(?:y|ies)/)
  const expected = report.expected
  const countsDiffer =
    check.status === 0 &&
    expected !== undefined &&
    (!counted || Number(counted[1]) !== expected.tasks || Number(counted[2]) !== expected.decisions || Number(counted[3]) !== expected.logEntries)
  const failed = (check.status !== 0 && plan.problems.length === 0) || countsDiffer
  if (countsDiffer) {
    console.error(
      `✖ check counts other records than the plan (${recordCounts(expected.tasks, expected.decisions, expected.logEntries)}), so some files are not where git sees them; this passed in memory, not on disk, and is a bug in resaledger. Undo with the command below.`
    )
  } else if (failed) {
    console.error('✖ the migrated workspace does not pass check although it passed in memory; this is a bug in resaledger. Undo with the command below.')
  }
  if (plan.problems.length > 0)
    console.log(
      `\nBefore you commit, fix the ${plan.problems.length} problems listed above: the pre-commit hook refuses the commit until they are fixed. See them again with: node ${dir}/scripts/records.mjs check`
    )
  const migrated = parseConfig(plan.writes.get(CONFIG_FILE)).config
  const steps = migrated ? setupCommitSteps(currentBranch(root), migrated, COMMIT_COMMAND, 'the migration') : [`Commit the migration:\n       ${COMMIT_COMMAND}`]
  console.log(`
Review the change, then:
${steps.map((step, index) => `  ${index + 1}. ${step}`).join('\n')}
Then run "node ${dir}/scripts/records.mjs verify" to write the first stamp.
To undo everything instead:
  ${UNDO_COMMAND}${undoHooks}`)
  if (failed) process.exit(1)
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

/** Shows the gates that passed and asks whether to write them, on a terminal; an empty answer is yes. */
async function askGates(gates) {
  console.log('\nThe gates that passed:')
  for (const kind of ['commit', 'verify']) for (const command of gates[kind]) console.log(`  ${kind}: ${command}`)
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      const answer = (await prompt.question('Write these gates into .resaledger.json? [Y/n] ')).trim().toLowerCase()
      if (answer === '' || answer === 'y' || answer === 'yes') return gates
      if (answer === 'n' || answer === 'no') return { commit: [], verify: [] }
      console.log('  Answer "y" or "n".')
    }
  } finally {
    prompt.close()
  }
}

/** The gates for init: none with --no-gates, else the detected ones that passed, confirmed on a terminal. */
async function initGates(root, flags, interactive) {
  if (!flags.gates) return { commit: [], verify: [] }
  const { gates } = await detectGates(root)
  if (gates.commit.length + gates.verify.length === 0) return gates
  return interactive ? askGates(gates) : gates
}

function refuseInit(messages) {
  console.error('✖ resaledger init changed nothing:')
  for (const message of messages) console.error(`  ✖ ${message}`)
  process.exit(1)
}

/** init [--team] [--dir <name>] [--agents <names>] [--no-gates] [--yes], in the repository of the current folder. */
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

  // The refusals do not depend on the answers or the gates, so they come before the questions and the runs.
  let plan = planInit(root, initOptions(flags))
  if (plan.refusals.length > 0) refuseInit(plan.refusals)
  const interactive = !flags.yes && process.stdin.isTTY && process.stdout.isTTY
  const answers = interactive ? await askInit(flags) : {}
  const found = { gates: await initGates(root, flags, interactive), commitStyle: detectCommitStyle(root) }
  plan = planInit(root, { ...initOptions(flags, answers), ...found })
  if (plan.refusals.length > 0) refuseInit(plan.refusals)

  const result = applyInit(root, plan)
  const { dir } = plan
  console.log(`\nresaledger init: ResaLedger is set up in ${dir}/, with the ${plan.preset} preset`)
  const gateCount = plan.config.gates.commit.length + plan.config.gates.verify.length
  console.log(gateCount > 0 ? `Gates: ${plan.config.gates.commit.length} commit, ${plan.config.gates.verify.length} verify; "node ${dir}/scripts/records.mjs gates" lists them.` : `Gates: none. Add your checks to "gates" in ${CONFIG_FILE}.`)
  if (plan.config.commitStyle === 'conventional') console.log('Commit style: conventional, as the history or the commitlint configuration uses it.')
  list('Created', result.created)
  list('Changed', result.changed)
  list('Warnings', plan.warnings.map((warning) => `! ${warning}`))
  if (plan.agents.length > 0) console.log(`\nAgent hooks for: ${plan.agents.join(', ')}.\n${agentTrustLines(plan.agents).join('\n')}`)
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
  steps.push(...setupCommitSteps(currentBranch(root), plan.config, commitCommand(files)))
  steps.push(`Start working: node ${dir}/scripts/records.mjs work`)
  if (plan.codeowners) {
    const lines = plan.codeowners.trimEnd().split('\n').map((line) => `       ${line}`).join('\n')
    steps.push(`Protect the enforcement files: add these lines to .github/CODEOWNERS, with your own owners, and make "resaledger" a required status check:\n${lines}`)
  } else steps.push('Optional: check pull requests in CI as well with "npx resaledger update --workflow", and commit the workflow it writes.')
  console.log(`\nNext steps:\n${steps.map((step, index) => `  ${index + 1}. ${step}`).join('\n')}`)
  if (check.status !== 0) process.exit(1)
}

/** The repository's root from git, or an error message and exit 1. */
function gitRoot() {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  if (top.status !== 0) {
    console.error('resaledger: not inside a git repository')
    process.exit(1)
  }
  return top.stdout.trim()
}

/** update [--force] [--agents <names>], in the repository of the current folder. */
export function updateCommand(args) {
  let force = false
  let workflow = false
  let agents = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--force') force = true
    else if (arg === '--workflow') workflow = true
    else if (arg === '--agents' || arg.startsWith('--agents=')) {
      const parsed = parseAgentsValue(arg === '--agents' ? args[++index] : arg.slice('--agents='.length))
      if (parsed.error) {
        console.error(`resaledger: ${parsed.error}`)
        process.exit(1)
      }
      agents = parsed.agents
    } else {
      console.error(`resaledger: unknown option "${arg}" for update; use --force, --workflow or --agents <names>`)
      process.exit(1)
    }
  }
  const root = gitRoot()
  if (!ensureGuard()) {
    console.error('resaledger: the guard could not be built')
    process.exit(1)
  }
  const plan = planUpdate(root, { force, agents, workflow })
  if (plan.refusals.length > 0) {
    console.error('✖ resaledger update changed nothing:')
    for (const message of plan.refusals) console.error(`  ✖ ${message}`)
    process.exit(1)
  }
  const changed = applyUpdate(root, plan)
  console.log(`resaledger update: ResaLedger ${version} in ${plan.dir}/`)
  const show = (state, title, describe) => {
    const files = plan.files.filter((file) => file.state === state)
    if (files.length === 0) return
    console.log(`\n${title} (${files.length}):`)
    for (const file of files) {
      console.log(`  ${file.path}${describe(file)}`)
      if (file.diff && state === 'kept') console.log(`    --force would change it so ("-" lines are removed, "+" lines added):\n${file.diff.replace(/^/gm, '      ')}`)
    }
  }
  const note = (file) => (file.note ? `: ${file.note}` : '')
  show('replaced', 'Replaced', (file) => (file.from ? ` (was ${file.from})` : note(file)))
  show('added', 'Added', note)
  show('restored', 'Restored', note)
  show('kept', 'Kept', note)
  show('manual', 'To do by hand', note)
  show('unchanged', 'Unchanged', () => '')
  if (plan.instructions) console.log(`\n${plan.instructions}`)
  if (changed.length > 0) console.log(`\nReview the change, then commit it:\n  ${commitCommand(changed, UPDATE_COMMIT_MESSAGE)}`)
  else console.log('\nNothing to change.')
  const kept = plan.files.filter((file) => file.state === 'kept').length
  if (kept > 0) {
    console.error(`\n✖ ${kept} managed ${kept === 1 ? 'file was' : 'files were'} changed by hand and kept. Move the change elsewhere, or run "npx resaledger update --force" to replace ${kept === 1 ? 'it' : 'them'}.`)
    process.exit(1)
  }
}

/**
 * Any other command: runs node <root>/<dir>/scripts/records.mjs with the same arguments,
 * stdin, output and exit code, from the current folder.
 */
export function guardCommand(argv) {
  const root = gitRoot()
  const configPath = join(root, CONFIG_FILE)
  if (!existsSync(configPath)) {
    if (existsSync(join(root, LEGACY_CONFIG_FILE))) console.error(`resaledger: ${LEGACY_CONFIG_FILE} exists, so this is an agent-ledger 0.x workspace; run "npx resaledger migrate" to convert it to ResaLedger 1.0`)
    else console.error(`resaledger: ResaLedger is not set up in this repository (${CONFIG_FILE} is missing); run "npx resaledger init"`)
    process.exit(1)
  }
  // The guard reports a broken configuration itself; here only the folder matters.
  let dir = DEFAULTS.dir
  const text = readFileSync(configPath, 'utf8')
  const parsed = parseConfig(text).config
  if (parsed) dir = parsed.dir
  else {
    try {
      const raw = JSON.parse(text)
      if (isSafeFolderPath(raw?.dir)) dir = raw.dir
    } catch {}
  }
  const guard = join(root, dir, 'scripts', 'records.mjs')
  if (!existsSync(guard)) {
    console.error(`resaledger: the guard ${dir}/scripts/records.mjs is missing; run "npx resaledger update" to restore it`)
    process.exit(1)
  }
  const result = spawnSync(process.execPath, [guard, ...argv], { stdio: 'inherit' })
  if (result.error) {
    console.error(`resaledger: could not run the guard: ${result.error.message}`)
    process.exit(1)
  }
  if (result.signal) process.kill(process.pid, result.signal)
  process.exit(result.status ?? 1)
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
  else if (command === 'update') updateCommand(argv.slice(1))
  else guardCommand(argv)
}

main(process.argv.slice(2))
