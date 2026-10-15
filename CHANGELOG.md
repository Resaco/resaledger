# Changelog

All notable changes to ResaLedger are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package version follows [semantic versioning](https://semver.org/); [docs/releasing.md](docs/releasing.md) says how the format version relates to it.

## [Unreleased]

## [1.0.0-rc.3] - 2026-10-16

Git LFS support, found when a 0.x workspace in a repository that uses Git LFS was migrated: ResaLedger's managed `pre-push` took the place of the hook Git LFS writes, so a push would have sent LFS pointers without their objects.

### Added

- **The pre-push hook runs Git LFS's pre-push** where Git LFS is in use: `filter=lfs` in a `.gitattributes` file of the index or of a pushed commit, or in git's own attributes (`.git/info/attributes`, `core.attributesFile` or its default). It runs after the guard's own checks pass, with the same remote, URL and refs, so a refused push uploads nothing; without `git-lfs` the push is refused with Git LFS's advice. A repository without Git LFS runs nothing of it.
- **`init` and `migrate` recognise the hooks Git LFS wrote into `.githooks/`.** They replace only Git LFS's `pre-push` and leave its other hooks alone; `migrate` prints `git lfs update --force` to bring Git LFS's hooks back after an undo. The solo and migration guides say what `git lfs install` prints in a clone, and why that is expected.

### Changed

- **`init` refuses a hook manager's `pre-push` that already runs `git lfs pre-push`**, which would read git's input before the guard; the lefthook and pre-commit snippets say the same.
- **`init` and `migrate` refuse while an ignore rule hides a hook they must commit**, naming the rule. A hook folder that git already tracks under an ignored folder is committed with `git add -f`.

### Fixed

- **`migrate` refuses a dangling symlink in place of a Git LFS hook** instead of stopping with an error.

### Known limits

- The Git LFS path is tested on Linux and macOS, not on Windows.

## [1.0.0-rc.2] - 2026-10-16

The second release candidate, with the fixes from the first installations of rc.1 in real repositories and the first migrations of 0.x workspaces.

### Added

- **`agent.pushNeedsHandoff`.** With `true`, the agent hooks refuse an agent's `git push` while `handoff` fails in the worktree the push runs in, with handoff's own message. The check that the lane is pushed is left out, since the push does that. The check runs before the command, so a push after a commit or a switch in the same command is refused with the advice to push on its own; a dry run is not judged. `ci` lists turning the key off as a weakening.
- **`init` tries `package.json`'s `check` script** as a verify gate, as it already did the Makefile's `check`. Scripts named `test:…` or `lint:…` are listed with the command that runs each and never run, since a name does not say whether a script ends or changes files.
- **`migrate` says when agent hooks are missing**, and gives the command that adds them, such as `npx resaledger update --agents claude`.
- **[Work outside the code](docs/guides/outside-the-code.md)**, a guide to content edited in a CMS, server settings and other work the hooks cannot see, with evidence someone else can check.

### Changed

- **The agent hooks read the configuration committed at HEAD**, as the agents guide already said, so an uncommitted edit of `.resaledger.json` no longer lifts a deny rule.
- **`new` writes `- Evidence: —`.** A done task whose evidence is still `—` is refused with a message that says what to write in its place, and CI shows no evidence for it.
- **The typo distance depends on the length of the known name**: two letters for a name of six letters or more, one for a shorter one, and a swap of two neighbouring letters counts as one. A free field such as `Later` is no longer refused as a typo of `Lane`, nor a configuration key `id` as a typo of `dir`.
- **Releases are staged on npm** and published when a maintainer approves them with two-factor authentication ([docs/releasing.md](docs/releasing.md)).

### Fixed

- **`migrate` renames the old configuration file in `.gitattributes`**, so a rule such as `export-ignore` keeps `.resaledger.json` out of `git archive`. A longer pattern that only contains the old name is reported and left alone.
- **`migrate` keeps edited 0.x template sections active.** A section of the workspace `AGENTS.md` or `standards.md` whose template text the project edited stays where the project's own sections go, with a warning, instead of leaving the instructions for the migration's log entry.
- **The CI comment mentions nobody and references no issue.** `@name`, `#12`, `owner/repo#12` and `GH-12` from the records are shown as written but not linked; a URL's `#` fragment and a path such as `gh-2-fix.md` stay as they are.
- **`init` titles the workspace README with a scoped package's own name**: `@scope/web` gives `web`.
- **`claim` no longer speaks of pushing in a repository without a remote.**
- **`npx resaledger` in a repository whose dependencies npm cannot resolve** stops with `EOVERRIDE` before ResaLedger starts. The README and the guides give the way past it: `npx --prefix "$(mktemp -d)" resaledger init` reads no project and still runs in the current folder.

## [1.0.0-rc.1] - 2026-10-15

The release candidate for ResaLedger 1.0.0, the first release under this name. It replaces agent-ledger 0.x with one record format that works the same for one person and for many people and agents working in parallel. 0.x workspaces convert with `npx resaledger migrate`.

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

`npx resaledger migrate` converts an agent-ledger 0.1, 0.2 or 0.3 workspace in place. It refuses a dirty tree, builds everything in memory, checks that no line of the old records is lost, rewrites links into the old files, and never commits; it prints the commit command and the undo command (`git restore -- :/ && git clean -fd -- :/`). Merge or close open lanes first, or rebase them onto the migrated base afterwards: a task in progress takes the one open lane whose commits name it. The full mapping is in [section 14 of the specification](ledger/plan/spec.md#14-migration-from-0x).

[Unreleased]: https://github.com/Resaco/resaledger/compare/v1.0.0-rc.3...HEAD
[1.0.0-rc.3]: https://github.com/Resaco/resaledger/compare/v1.0.0-rc.2...v1.0.0-rc.3
[1.0.0-rc.2]: https://github.com/Resaco/resaledger/compare/v1.0.0-rc.1...v1.0.0-rc.2
[1.0.0-rc.1]: https://github.com/Resaco/resaledger/releases/tag/v1.0.0-rc.1
