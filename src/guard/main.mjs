// The command line of the guard. This module runs last in the bundle.
// VERSION is defined by scripts/bundle.mjs from package.json.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { effectiveConfigJson, loadConfig } from './config.mjs'
import { fail, repositoryRoot } from './util.mjs'

const HELP = `ResaLedger ${VERSION}

Usage: node ledger/scripts/records.mjs <command>

Commands:
  config    print the effective configuration
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

export function main(argv) {
  const [command = 'help'] = argv
  if (command === 'version' || command === '--version') console.log(VERSION)
  else if (command === 'help' || command === '--help') process.stdout.write(HELP)
  else if (command === 'config') configCommand()
  else fail(`unknown command "${command}"; run "help" for the list`)
}

main(process.argv.slice(2))
