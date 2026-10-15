# W3 `task` and `new`

- Status: done
- Depends on: W1
- Plan: [W-work.md](../plan/W-work.md#w3-task-and-new)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 525 of 525 on Node 24.18.0, 22.23.3 and 20.20.2; the 17 tests in [create.test.mjs](../../test/create.test.mjs) cover a gap in the numbers, a child of a child, ids taken in another worktree, on a local branch and on a remote-tracking branch, non-ASCII, long and duplicate titles for tasks, decisions and log entries, `task` with and without a plan section, and `--issue` with a stand-in for `gh`; every file created passes `check`. Not verified: Windows (CI; the `--issue` tests skip there).

## Notes

A dated decision or log name counts as taken when any branch has it, through the one-batch scan that `ids.mjs` now shares (`branchFolderNames`). `Decided by` falls back to a dash, which `check` refuses on purpose, so nobody commits a decision unsigned.
