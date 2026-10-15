# H3 Hook scripts and activation

- Status: done
- Depends on: F1
- Plan: [H-hooks.md](../plan/H-hooks.md#h3-hook-scripts-and-activation)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 230 of 230 on Node 24.18.0, 22.23.3 and 20.20.2; the 17 hook tests in [githooks.test.mjs](../../test/githooks.test.mjs) run the hooks through real git commits and pushes, find Node with a limited PATH, and integrate husky and simple-git-hooks idempotently. Not verified: Windows and Linux (CI); lefthook and the pre-commit framework against real installations.

## Notes

For lefthook and the pre-commit framework the guard prints a snippet instead of editing YAML. The pre-commit framework passes no stdin to pre-push hooks, so H2 needs its environment variables instead.
