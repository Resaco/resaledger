// The package's own command line: `npx resaledger <command>`.
// init, update and migrate come in later tasks; until then it knows version and help.
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

const HELP = `ResaLedger ${version}

Usage: npx resaledger <command>

Commands:
  version   print the version
  help      print this help
`

export function main(argv) {
  const [command = 'help'] = argv
  if (command === 'version' || command === '--version') console.log(version)
  else if (command === 'help' || command === '--help') process.stdout.write(HELP)
  else {
    console.error(`resaledger: unknown command "${command}"; run "resaledger help" for the list`)
    process.exitCode = 1
  }
}

main(process.argv.slice(2))
