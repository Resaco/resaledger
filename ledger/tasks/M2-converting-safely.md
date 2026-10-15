# M2 Converting, safely

- Status: done
- Depends on: M1, R5
- Plan: [M-migration.md](../plan/M-migration.md#m2-converting-safely)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 397 of 397 on Node 24.18.0 and 22.23.3, 400 of 400 on 20.20.2 with the brand tests; the 36 tests in [migrate.test.mjs](../../test/migrate.test.mjs) migrate real repositories built from synthetic 0.x workspaces, prove that every refusal leaves the tree unchanged byte for byte and that an injected loss stops the plan, and migrate this repository's own workspace in a clone and commit it through the new hooks. In a temporary clone the worker migrated this workspace: 50 tasks, 23 decisions and 12 log entries, no line lost, 12 links rewritten. Not verified: Windows (CI); the private workspaces (M3).

## Notes

On review the lead made the undo command use root pathspecs, so it is whole when run from a subfolder, and made `migrate` count untracked files that `status.showUntrackedFiles` hides, because the undo's `git clean` would delete them. This workspace's own records must stay valid under the 1.0 rules until M4, or the self-migration test fails.
