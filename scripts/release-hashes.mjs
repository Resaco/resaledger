// Records this version's managed files in templates/released.json, the table that
// `resaledger update` uses to tell a released file from one changed by hand.
//
//   node scripts/release-hashes.mjs [--check]
//
// Run it at every release, after the version in package.json is set and before the release
// commit and `npm publish`: the release-candidate task (L3) runs it when it cuts the
// candidate, and commits the table with the release. It builds the guard afresh, hashes the
// guard, the git hook templates and the AGENTS.md block template exactly as `update` hashes
// installed copies (src/cli/update.mjs), and adds one SHA-256 per file under the version.
// Earlier versions' entries are kept; running it twice for one version changes nothing.
//
// --check writes nothing and exits 1 when the table lacks this version's hashes or has
// different ones.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')

const built = spawnSync(process.execPath, [join(PACKAGE, 'scripts', 'bundle.mjs')], { stdio: 'inherit' })
if (built.status !== 0) process.exit(built.status ?? 1)

// Imported after the build, because it reads the built guard.
const { currentHashes, PACKAGE_VERSION, RELEASED_FILE, withVersionHashes } = await import('../src/cli/update.mjs')
const before = readFileSync(RELEASED_FILE, 'utf8')
const after = `${JSON.stringify(withVersionHashes(JSON.parse(before), PACKAGE_VERSION, currentHashes()), null, 2)}\n`

if (check) {
  if (before === after) console.log(`✔ templates/released.json holds the hashes of ${PACKAGE_VERSION}`)
  else {
    console.error(`✖ templates/released.json lacks the hashes of ${PACKAGE_VERSION}; run "node scripts/release-hashes.mjs"`)
    process.exit(1)
  }
} else if (before === after) console.log(`templates/released.json already holds the hashes of ${PACKAGE_VERSION}`)
else {
  writeFileSync(RELEASED_FILE, after)
  console.log(`templates/released.json: added the hashes of ${PACKAGE_VERSION}`)
}
