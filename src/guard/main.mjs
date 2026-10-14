// The command line of the guard. This module runs last in the bundle.
// VERSION is defined by scripts/bundle.mjs from package.json.
import { fail } from './util.mjs'

const HELP = `ResaLedger ${VERSION}

Usage: node ledger/scripts/records.mjs <command>

Commands:
  version   print the version
  help      print this help
`

export function main(argv) {
  const [command = 'help'] = argv
  if (command === 'version' || command === '--version') console.log(VERSION)
  else if (command === 'help' || command === '--help') process.stdout.write(HELP)
  else fail(`unknown command "${command}"; run "help" for the list`)
}

main(process.argv.slice(2))
