# I2 Detecting the gates

- Status: done
- Lane: i2-gates
- Depends on: F1
- Plan: [I-installer.md](../plan/I-installer.md#i2-detecting-the-gates)
- Evidence:
  - `node scripts/test.mjs` on Node 24.18.0: 908 of 908 pass; on Node 22.23.3: 907 of 908, the one failure the known timing test in `test/ids.test.mjs` ("50 branches are scanned within the time budget"), which passes when rerun alone; on Node 20.20.2: 908 of 908.
  - [test/detect.test.mjs](../../test/detect.test.mjs): the sources for each ecosystem, the proof with stub pnpm, make, uv, cargo and go, a failing check reported and not added, a hanging check stopped at its limit with everything it started, the offline run, the commit style, and `init --yes` end to end through the installed hooks.


## Notes

- `src/cli/detect.mjs` finds the candidates in `package.json` (the package manager from the lockfile), the `Makefile`, `pyproject.toml`, `Cargo.toml` and `go.mod`, as spec 13 lists them. It reads the files as text; TOML is read only for table names and requirement names.
- Each candidate runs once, through the shell, from the root, with no input and with variables that keep npm, pnpm, yarn, uv, pip, cargo and go offline (`OFFLINE_ENV`). The limit is 60 s for a commit gate and 300 s for a verify gate. A candidate runs in its own process group, so the limit stops everything it started. Only the passing ones are kept; the others are reported with their reason and last five lines.
- Names that count: scripts `lint`, `typecheck`, `check-types`, `format:check` (commit), `test`, `build` (verify); Makefile `lint` (commit), `check`, `test`, `build` (verify), skipped when a `package.json` script of the same name exists; `ruff check`, `mypy .` (commit), `pytest` (verify); `cargo fmt --check` (commit), `cargo clippy -- -D warnings` and `cargo test` (verify, since both compile); `go vet ./...` (commit), `go test ./...` (verify).
- The commit style is `conventional` when a commitlint configuration exists or more than half of the last 50 non-merge subjects match the commit-msg pattern, which `githooks.mjs` now exports as `GITHOOKS_CONVENTIONAL` (the bundle is unchanged).
- `init` asks the preset and the goal first, then runs the candidates, then on a terminal shows the passing gates and asks before writing them. `--yes` writes them; `--no-gates` runs nothing. Spec 13 named `--no-run`; it now names `--no-gates`, since adding checks without running them would contradict the proof.
- The interactive confirmation has no automated test, because the tests run without a terminal.
