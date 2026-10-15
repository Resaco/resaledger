# F1 Package, source layout, bundler and test harness

- Status: done
- Depends on: —
- Plan: [F-foundation.md](../plan/F-foundation.md#f1-package-source-layout-bundler-and-test-harness)
- Evidence: `node scripts/test.mjs`: 18 of 18 on Node 24.18.0, 22.23.3 and 20.20.2, run by the lead on the worker's branch before the merge and again on `main` after it; `node scripts/bundle.mjs --check` passes and leaves no `dist/` folder; the bundler's rules are tested in [bundle.test.mjs](../../test/bundle.test.mjs) and the helpers live in [helpers.mjs](../../test/helpers.mjs). Not verified: Linux and Windows, which run in CI once the repository is pushed.

## Notes

Merged in 003227c. The bundler's conventions are summarised in [modules.md](../plan/modules.md#conventions). The repository's gates now run the bundle check on every code commit and `npm test` in `verify`.
