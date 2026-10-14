# I — The installer

Status: approved · 2026-10-15 · by Niko Alho

`npx resaledger init` and go, and a safe way to renew what was installed ([spec section 13](spec.md#13-installation-and-distribution)).

### I1 `init`

Goal: one command sets ResaLedger up in a real repository.

Design:
- **Preconditions.** It requires a git repository. It refuses only when a file it must change has uncommitted changes.
- **Flags:** `--team`, `--dir`, `--yes`, `--agents`, `--no-run` and `--no-ci`.
- **What it writes:**
  - the configuration;
  - the README with its markers;
  - the guard and the git hooks;
  - the `AGENTS.md` block;
  - agent hooks for the agents it finds;
  - the CI workflow, in the team preset.
- **Afterwards** it turns the hooks on, runs `check`, and prints what it did and the first command to run.

Acceptance: tests for solo and team, an existing `ledger/` folder, an existing `AGENTS.md` and `CLAUDE.md`, a repository that uses husky, and non-interactive runs.

### I2 Detecting the gates

Goal: the project's real checks become its gates, without guessing.

Design:
- **Sources:**
  - `package.json` scripts, with the package manager taken from the lockfile;
  - `Makefile` targets;
  - `pyproject.toml` (ruff, mypy, pytest, through `uv run` when there is a `uv.lock`);
  - `Cargo.toml`;
  - `go.mod`.
- **Sorting.** Fast checks become commit gates, slow ones verify gates.
- **Proof.** Each check runs once, with a time limit, and is kept only if it passes.
- **Commit style.** It is read from the history, or from a commitlint configuration.

Acceptance:
- Fixture projects for each ecosystem.
- A failing check is reported and not added.
- Detection runs without network access.

### I3 `update` and the package's command line

Goal: renew the guard safely, and let `npx resaledger <command>` reach the repository's own guard.

Design:
- **Replacing files.** A managed file is replaced only when it matches the content of a released version, using a table of hashes built at each release. Otherwise it is shown and kept, unless `--force` is given.
- **Never touched:** the README, the records and the project's own text in `AGENTS.md`.
- **Guard commands** are passed to the repository's guard.
- **Published files.** The contents of `npm pack` are checked.

Acceptance:
- Tests for:
  - a clean update;
  - a hand-edited hook, refused and then forced;
  - a missing guard;
  - passing a command from a subfolder.
- `npm pack --dry-run` lists only the intended files.
