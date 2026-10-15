# H1 pre-commit

- Status: done
- Depends on: R5
- Plan: [H-hooks.md](../plan/H-hooks.md#h1-pre-commit)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 359 of 359 on Node 24.18.0, 22.23.3 and 20.20.2; the 17 tests in [precommit.test.mjs](../../test/precommit.test.mjs) commit through git with the bundled guard, one per refusal, and prove that a partial commit is judged on git's temporary index, not on the working tree. Not verified: Windows (CI).

## Notes

During a merge, a held task staged exactly as the merged commit has it passes, because it is that lane's own change. The check that ids are unique across locally visible branches (spec section 9) moved to C1, which builds it for CI and adds it to pre-commit.
