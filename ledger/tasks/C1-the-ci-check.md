# C1 The CI check

- Status: done
- Depends on: V1, V2, H1
- Plan: [C-ci.md](../plan/C-ci.md#c1-the-ci-check)
- Evidence: `node scripts/test.mjs` on `main` after merging C1 and H2: 466 of 466 on Node 24.18.0, 22.23.3 and 20.20.2. The 27 tests in [ci.test.mjs](../../test/ci.test.mjs) run simulated GitHub events for each rule, a fork, pushes after a squash merge and after a merge commit, the first pull request that adds ResaLedger, rules taken from the base when the head weakens its own, `ci.runGates: false` with and without a stamp, and a shallow clone; the 6 tests in [ids.test.mjs](../../test/ids.test.mjs) cover the id scan across branches and worktrees, and a commit that adds a task takes about 1 s with 51 branches. Not verified: a real GitHub Actions run (C3 adds the workflow) and Windows.

## Notes

For C3: the workflow must run on `pull_request`, never `pull_request_target`, because the gates run the pull request's code; and gate output appears above the `ci` header today. Pre-commit clears git's location variables while it reads the other worktrees, because git sets `GIT_INDEX_FILE` for hooks; W2 moves that into `localLanes`, so every caller is safe.
