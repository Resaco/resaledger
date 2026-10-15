# I1 `init`

- Status: done
- Depends on: R1, R4, H3
- Plan: [I-installer.md](../plan/I-installer.md#i1-init)
- Evidence: `node scripts/test.mjs` on `main` after the merges: 507 of 507 on Node 24.18.0, 22.23.3 and 20.20.2; the 39 tests in [init.test.mjs](../../test/init.test.mjs) set up real repositories in the solo and team presets, with `--yes` and off a terminal, with `--dir`, an existing `ledger/`, `AGENTS.md` and `CLAUDE.md`, husky, a dirty file and a 0.x workspace, and run the printed commit command through the installed hooks. Not verified: Windows (CI); the interactive questions on a real terminal.

## Notes

`init` and `migrate` share the managed block, the guard build and turning the hooks on (`src/cli/setup.mjs`). `init` also refuses to overwrite a `.githooks/` hook that is not ResaLedger's. The `--agents`, `--no-run` and `--no-ci` flags come with A1, I2 and C3, which add their steps.

- Follow-up: in the team preset, pre-commit refuses the printed setup commit on the protected base; `init --team` must set up on a branch and say to open a pull request (found by T3's reviewer).
