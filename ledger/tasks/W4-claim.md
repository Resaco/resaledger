# W4 `claim`

- Status: done
- Depends on: W2, W3
- Plan: [W-work.md](../plan/W-work.md#w4-claim)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 581 of 581 on Node 24.18.0, 22.23.3 and 20.20.2. The 12 tests in [claim.test.mjs](../../test/claim.test.mjs) cover a double claim between two worktrees and then `--take`, which pre-commit accepts; a double claim between two clones through a bare remote in the team preset; `--worktree`; `--push`; the WIP limit and a missing plan; a fetch that fails; and byte-for-byte editing of the task file. Not verified: Windows (CI).

## Notes

A lane branch is named `<branchPrefix><id in lowercase>-<slug>`, as spec section 6.3 now says. `claim` does not check that a takeover branch starts from the old lane, and a stale claim gets the same refusal as a live one, with the advice to take it over.
