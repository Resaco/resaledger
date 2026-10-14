# F — Foundation

Status: proposal · 2026-10-15 · part of the plan the owner reviews

What every later task stands on: the package, the source layout, the bundler that makes the guard one file, the test harness, CI for this repository and the hygiene checks.

### F1 Package, source layout, bundler and test harness

Goal: an empty but working package. `npm test` builds the guard into one file and runs the tests.

Design:
- **The package.** `package.json`: name `resaledger`, version `1.0.0-dev.0`, `"type": "module"`, a `bin` entry `resaledger`, Node 20 or newer, no dependencies or devDependencies, and a `files` list limited to what is published.
- **Root files.** `LICENSE`: MIT, copyright 2026 Resaco Oy. `.gitignore`: `dist/` and `node_modules/`. `.gitattributes`: `* text=auto eol=lf`, so that hashes and parsing never depend on how a checkout writes line endings.
- **Layout.** `src/guard/` (the guard, as modules), `src/cli/` (the package's own commands), `templates/`, `scripts/`, `test/`.
- **The bundler.** `scripts/bundle.mjs` concatenates `src/guard/*.mjs` into `dist/records.mjs` in import order. It removes the internal imports and the `export` keywords and merges the `node:` imports at the top. It stops on a duplicate top-level name, an aliased import, a default export or an import cycle. The result is readable: one banner per module, no minification, and `// ResaLedger <version>` as the first line. `npm test` and `npm pack` build the bundle, and it is never committed.
- **The test helpers.** `test/helpers.mjs` keeps the 0.x style and extends it: a real git repository in a temporary folder with an isolated git configuration; commits made through the installed hooks; worktrees; a bare remote for pushing and fetching; paths that also work on Windows.

Acceptance:
- `npm test` passes with no tests yet, builds `dist/records.mjs`, and `node dist/records.mjs version` prints the version.
- **Bundler tests:** two modules that import each other produce one working file. A duplicate name, an alias, a default export and a cycle each fail with a message that names the file and the rule.
- **A smoke test:** creates a repository with the helpers, commits, adds a worktree, pushes to the bare remote and fetches back.

Risks: every later task depends on the bundler's convention. Rollback: ship several plain files instead of one; only the packaging changes.

### F2 CI for this repository, and the hygiene checks

Goal: every push runs the tests on Node 20, 22 and 24 on Linux, macOS and Windows, and nothing private gets committed unnoticed.

Design:
- **The workflow.** `.github/workflows/test.yml`: the matrix, `npm test`, `fail-fast: false`, read-only permissions and a time limit.
- **The hygiene test.** `test/hygiene.test.mjs` checks every text file that `git ls-files` lists. Each must be free of:
  - home-directory paths (`/Users/<name>`, `/home/<name>`, `C:\Users\`)
  - paths into an agent's private configuration folder
  - email addresses other than no-reply ones
  - the words in a private deny-list read from `.git/info/hygiene-deny` when it exists: whole words, case-insensitive. The list is never tracked.
- **The history scan.** `scripts/scan-history.mjs` applies the same rules to every commit's content and metadata (author, committer, message). It runs before anything is pushed.
- **This repository's gates.** They go into `.agent-ledger.json`: the commit gate is `node scripts/bundle.mjs --check`, the verify gate is `npm test`.

Acceptance:
- The workflow file parses as YAML.
- The hygiene test fails on a planted path, a planted private word and a planted email address, and passes on the clean tree.
- The history scan finds a planted word in an old commit's message and in its content.
- Both gate commands run and pass.

Risks: the deny-list exists only on the maintainer's machine, so CI checks only the general rules. That is accepted, because CI cannot know private names without publishing them.
