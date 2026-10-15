# W1 `work` on this machine

- Status: done
- Depends on: R5, H3
- Plan: [W-work.md](../plan/W-work.md#w1-work-on-this-machine)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 243 of 243 on Node 24.18.0, 22.23.3 and 20.20.2; the 13 tests in [work.test.mjs](../../test/work.test.mjs) cover a solo workspace, three worktrees with an uncommitted claim, a double and a stale claim, `--json`, hooks turned on in a fresh clone, and 300 tasks in about half a second. Not verified: Linux and Windows (CI).

## Notes

The verification state is not shown yet; the lead adds it once V1's stamps merge. A lane that exists only as a remote-tracking branch shows as a stale claim until W2 adds remote lanes.
