// Test helpers: real git repositories in temporary folders, with a git configuration
// isolated from the machine's, commits through whatever hooks the repository has
// installed, worktrees, and a bare remote to push to and fetch from.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after } from 'node:test'
import { fileURLToPath } from 'node:url'

export const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const created = []
after(() => created.forEach((folder) => rmSync(folder, { recursive: true, force: true })))

/** A new temporary folder, removed after the tests in this file. */
export function temporary(prefix = 'resaledger-') {
  const folder = mkdtempSync(join(tmpdir(), prefix))
  created.push(folder)
  return folder
}

// An empty global configuration file: /dev/null does not exist on Windows.
const GLOBAL_CONFIG = join(temporary('resaledger-config-'), 'gitconfig')
writeFileSync(GLOBAL_CONFIG, '')

// Variables such as GIT_DIR or GIT_INDEX_FILE leak in when the tests run inside a git hook.
const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))
export const ENV = {
  ...inherited,
  GIT_CONFIG_GLOBAL: GLOBAL_CONFIG,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com'
}

/** Runs a command without a shell and returns its exit status and combined output. */
export function run(cwd, command, args = [], input) {
  const result = spawnSync(command, args, { cwd, env: ENV, encoding: 'utf8', input })
  if (result.error) throw result.error
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

/** Helpers bound to one working folder: a repository or one of its worktrees. */
function bind(base, root) {
  const r = {
    base,
    root,
    run: (command, args, input) => run(root, command, args, input),
    git: (...args) => run(root, 'git', args),
    node: (...args) => run(root, process.execPath, args),
    read: (path) => readFileSync(join(root, path), 'utf8'),
    write: (path, text) => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    },
    append: (path, text) => r.write(path, `${r.read(path)}${text}`),
    commit: (...messages) => {
      r.git('add', '-A')
      return r.git('commit', '-q', ...messages.flatMap((message) => ['-m', message]))
    },
    push: (...args) => r.git('push', '-q', 'origin', ...args),
    fetch: (...args) => r.git('fetch', '-q', 'origin', ...args),
    /** A new worktree next to the repository, on a new branch, with the same helpers. */
    worktree: (name, branch = name) => {
      const path = join(base, name)
      const added = r.git('worktree', 'add', '-q', '-b', branch, path)
      if (added.status !== 0) throw new Error(`git worktree add failed: ${added.out}`)
      return bind(base, path)
    },
    /** A bare repository next to this one, added as origin. */
    remote: () => {
      const path = join(base, 'remote.git')
      const made = run(base, 'git', ['init', '-q', '--bare', '-b', 'main', path])
      if (made.status !== 0) throw new Error(`git init --bare failed: ${made.out}`)
      r.git('remote', 'add', 'origin', path)
      return path
    }
  }
  return r
}

/** An empty git repository on main, in its own temporary folder. */
export function repository() {
  const base = temporary()
  const root = join(base, 'repo')
  mkdirSync(root)
  const made = run(root, 'git', ['init', '-q', '-b', 'main'])
  if (made.status !== 0) throw new Error(`git init failed: ${made.out}`)
  return bind(base, root)
}
