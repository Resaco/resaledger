// Builds the guard and runs every test/**/*.test.mjs with node --test.
// No shell globs: npm runs scripts through cmd.exe on Windows.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function testFiles(folder) {
  return readdirSync(folder, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) return testFiles(path)
      return entry.isFile() && entry.name.endsWith('.test.mjs') ? [path] : []
    })
}

const built = spawnSync(process.execPath, [join(PACKAGE, 'scripts', 'bundle.mjs')], { cwd: PACKAGE, stdio: 'inherit' })
if (built.status !== 0) process.exit(built.status ?? 1)

const files = testFiles(join(PACKAGE, 'test')).map((path) => relative(PACKAGE, path))
if (files.length === 0) {
  console.log('no test files found')
  process.exit(0)
}
const tested = spawnSync(process.execPath, ['--test', ...files], { cwd: PACKAGE, stdio: 'inherit' })
process.exit(tested.status ?? 1)
