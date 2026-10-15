# T1 The parallel-lanes acceptance test

- Status: done
- Depends on: W4, V3, H2, C1
- Plan: [T-acceptance.md](../plan/T-acceptance.md#t1-the-parallel-lanes-acceptance-test)
- Evidence: [acceptance.test.mjs](../../test/acceptance.test.mjs), 10 of 10 on `main` (43 s): `init` sets up a repository; three lanes created with `claim --worktree` work at the same time, each claiming, adding a child task, committing code, verifying, writing a decision and a log entry, finishing with evidence and passing `handoff`; the lanes merge in all six orders and once by squash with no conflict, after which `check` passes and `work` shows every task done and no stale claim; a fourth lane that edits another lane's task is refused by pre-commit and by `ci`. `node scripts/test.mjs` on `main` after T1 and T5.2: 696 of 696 on Node 24.18.0, 22.23.3 and 20.20.2. Not verified: CI on the three systems (the next push).

## Notes

The test found no bug. It found one case for T4: a lane built on top of another lane's claim commit can change that task, and `ci` accepts it, because the base never recorded the claim; pre-commit refuses it locally.
