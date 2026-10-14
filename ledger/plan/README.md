# Plan

Status: approved · 2026-10-15 · by Niko Alho

## Phases

| Phase | What | File |
| --- | --- | --- |
| S | Research and the 1.0 specification (done) | [spec.md](spec.md) |
| G | Brand and graphics | [G-brand.md](G-brand.md) |
| F | Foundation: the package, the bundler, the test harness, CI and hygiene | [F-foundation.md](F-foundation.md) |
| R | The record format: configuration, Markdown, tasks, other records, `check` | [R-records.md](R-records.md) |
| V | Gates and stamps, the commit range check, `handoff` | [V-verify.md](V-verify.md) |
| H | Git hooks | [H-hooks.md](H-hooks.md) |
| W | `work`, `task`, `new`, `claim` and `changes` | [W-work.md](W-work.md) |
| C | The CI check | [C-ci.md](C-ci.md) |
| A | Agent integrations | [A-agents.md](A-agents.md) |
| I | The installer: `init`, gate detection, `update` | [I-installer.md](I-installer.md) |
| M | Migration from 0.x, and this repository's own move to 1.0 | [M-migration.md](M-migration.md) |
| T | The acceptance tests and the independent reviews | [T-acceptance.md](T-acceptance.md) |
| D | Documentation and the repository's own files | [D-docs.md](D-docs.md) |
| L | The demo, the launch drafts and the release candidate | [L-launch.md](L-launch.md) |

## The order, and why

1. **F, the foundation.** Nothing can be verified without a harness that builds real repositories, and the guard is developed as modules that are bundled into one file, so the bundler comes first.
2. **R, the record format.** The format is the public contract, and every command reads it. It is built and tested as plain functions before any command depends on it.
3. **V and H, the guarantees.** Stamps, the commit range check and the hooks are the product's core value and its riskiest logic. They come right after the format, so that everything else is built on a working guard.
4. **W, the daily commands.** They rest on the records, the lanes and the checks.
5. **C, the CI check.** It reuses R, V and H and adds the base branch's rules and the enforcement diff.
6. **A and I, integration and installation.** These are thin layers over the guard.
7. **M, migration.** It needs the whole format to validate its output. When it is reviewed, this repository moves to 1.0 (M4), and the rest of the build runs on the new format.
8. **T, acceptance and review.** The acceptance test needs everything. The independent reviews run as soon as each risky area is done, not all at the end.
9. **D and L, documentation and launch.** They describe what was built, so they come last. G runs alongside the rest and feeds the README.

## How the work is split

- **The lead agent** owns the records and the commits. For each task it claims the task in the ledger, writes the worker's instruction from the task's plan section, reviews the result against the acceptance checks (reading the diff and running the tests), merges, and records the evidence.
- **Workers** are Opus 5.5 at medium effort. Each task goes to one worker, in its own git worktree on its own branch, and at most three work at the same time. Workers change code, tests and documentation, never the records: in the 0.x format that this build starts on, parallel record edits would conflict. After M4, the 1.0 format lets lanes own their task files.
- **Independent reviews** by Fable 5.1 cover only the areas where a bug would break other people's repositories: the guard (T3), the CI check (T4) and `migrate` (T5).
- **Merges** are ordinary merges into `main`. Nothing is pushed.
- The 0.x guard allows three tasks in progress at once. That is the limit until M4.

## Architecture in brief

- `src/guard/*.mjs`: the guard as modules: configuration, Markdown, records, checks, lanes, gates and stamps, the range check, hooks, `ci`, agent hooks. `scripts/bundle.mjs` concatenates them into one readable file, `dist/records.mjs`, which `init` and `update` copy into a repository as `ledger/scripts/records.mjs`. The bundle is never committed.
- `src/cli/*.mjs`: the package's own commands: `init`, gate detection, `update`, `migrate`, and passing every other command to the repository's guard.
- `templates/`: the git hooks, the workspace README, the `AGENTS.md` block, the CI workflow, the agent hook configurations and the skill.
- `test/`: unit tests for pure functions; end-to-end tests that build real repositories and commit through the installed hooks.

The guard's modules and the contracts between them are in [modules.md](modules.md).

## Waiting for the owner

- The choice of a brand concept ([G1](../work/ledger.md#g1-brand-concepts)).
