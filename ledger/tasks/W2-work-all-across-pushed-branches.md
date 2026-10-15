# W2 `work --all` across pushed branches

- Status: done
- Depends on: W1
- Plan: [W-work.md](../plan/W-work.md#w2-work---all-across-pushed-branches)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 533 of 533 on Node 24.18.0, 22.23.3 and 20.20.2. [work.test.mjs](../../test/work.test.mjs) covers two pushed lanes holding the same task, stale claims from a merged and from a deleted branch, `--fetch` against an unreachable remote, a lane that is both a worktree and pushed, verified and unverified heads, and 500 branches in 0.5 to 1.6 seconds on a loaded machine; [lanes.test.mjs](../../test/lanes.test.mjs) reads another worktree with git's hook variables set. Not verified: git before 2.41 (its fallback was measured by hand), Windows (CI).

## Notes

A worktree lane is never reported stale, because a fresh worktree at the base looks merged. `--fetch` implies `--all`. Reading another worktree now ignores the variables git sets for hooks, in `localLanes` itself.
