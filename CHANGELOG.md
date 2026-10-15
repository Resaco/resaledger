# Changelog

All notable changes to ResaLedger are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package version follows [semantic versioning](https://semver.org/); [docs/releasing.md](docs/releasing.md) says how the format version relates to it.

## [Unreleased]

The first release of ResaLedger, 1.0.0. It replaces agent-ledger 0.x with one record format that works the same for one person and for many people and agents working in parallel. 0.x workspaces convert with `npx resaledger migrate`.

### Added

- **One file per record.** Tasks in `ledger/tasks/`, decisions in `ledger/decisions/` and log entries in `ledger/log/`, each its own Markdown file. Parallel branches no longer edit the same file, so the records merge without conflicts.
- **Lanes and claims.** A lane is a branch with someone working on it. `claim <id>` takes a task for the lane, `--worktree <path>` gives it its own branch and worktree, and `--push` makes the claim visible to others at once. A lane that edits another lane's task is refused by the hooks and by CI.
- **Ids that do not clash.** `new` picks a free id across branches and worktrees; `new --under <id>` adds a child task, and `new decision` and `new log` add records with today's date.
- **`work`** shows what each lane holds, what waits for the owner, what is blocked and what is ready; `--all` reads pushed branches too, and `--json` prints the same data. It also turns on the git hooks in a fresh clone.
- **`task <id>`** prints one task with its plan section.
- **`verify` and stamps.** `verify` runs the project's gates on the committed code and writes a stamp named after a hash of that code, so two branches with the same code share one stamp and different code never does.
- **`handoff`**, the end-of-session check: valid records, a clean tree, a stamp for the current code, a current handoff note on every task in progress, and no unpushed commit that skipped the hooks.
- **A CI check**, `ci`, and a GitHub Actions workflow for it. It judges each pull request by the rules of the branch it merges into, reruns the gates, writes a job summary and one pull request comment, and lists every change to enforcement. A change that weakens enforcement fails unless the pull request adds a decision that names it.
- **Agent hooks** for Claude Code, Codex, Cursor, Gemini CLI and GitHub Copilot. They stop `--no-verify`, forced pushes, pushes to a protected branch and commands that throw work away, and remind the agent once at the end of a turn.
- **`init` finds the gates.** It runs the project's own checks (package scripts, Makefile targets, Python, Rust and Go tools) once, offline and with a time limit, and keeps only those that pass. It writes a solo or a team preset; the team preset adds the CI workflow, a pull request template and the CODEOWNERS lines for the enforcement files.
- **`update`** renews the guard, the hooks, the `AGENTS.md` block, the agent hook configurations and the workflow when they match a released version, and leaves hand-edited files alone unless `--force` is given.
- **`changes`** lists the tasks finished since a tag, grouped as Keep a Changelog does, as a draft for the changelog and the release notes.
- **An `AGENTS.md` block, a skill and a plugin marketplace**, so that agents learn the protocol when a session starts.

### Changed from agent-ledger 0.x

- **The name and the files.** The package and command are `resaledger`, and the configuration is `.resaledger.json` with format version 2. The workspace folder stays `ledger/` by default.
- **No status file.** `STATUS.md` is gone. In progress, blocked, ready and waiting for the owner are computed by `work` from the task files.
- **No shared ledger, log or decision table.** `work/ledger.md`, `work/log.md` and `DECISIONS.md` become one file per task, entry and decision.
- **One record checkpoint per task.** `handoff` no longer asks for a status edit, a log entry and a ledger edit after every code commit; a task's handoff note and, when it is done, its evidence are enough.
- **Stamps per code.** `work/verified.json`, one committed file that conflicted on every branch, is replaced by stamps named after a hash of the code. `verify` reruns nothing when a stamp for the same code exists.
- **The work-in-progress limit** counts per lane, not per repository.
- **`update` keeps hand edits.** 0.3 overwrote a hand-edited hook as long as it still carried its marker.

### Removed

- **Guard-only mode** (`mode: guard`). `migrate` refuses such a workspace and explains why; the protections it gave remain available inside the ledger.
- **The `.gitattributes` union merge rules** of 0.x. One file per record makes them unnecessary.

### Migration

`npx resaledger migrate` converts an agent-ledger 0.1, 0.2 or 0.3 workspace in place. It refuses a dirty tree, builds everything in memory, checks that no line of the old records is lost, rewrites links into the old files, and never commits; `git restore .` undoes it. Migrate when no lane is open. The full mapping is in [section 14 of the specification](ledger/plan/spec.md#14-migration-from-0x).
