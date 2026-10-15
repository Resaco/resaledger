# C2 Changes to enforcement

- Status: done
- Depends on: C1
- Plan: [C-ci.md](../plan/C-ci.md#c2-changes-to-enforcement)
- Evidence: 778 tests on the branch on Node 24.18.0, 22.23.3 and 20.20.2 (the timing test in `ids.test.mjs` rerun alone on 24 and 22); [ci.test.mjs](../../test/ci.test.mjs) fails each of 16 kinds of weakening without a decision and passes it with one that names it, refuses a decision that names another change or is already on the base, passes an update to a released guard or hook and a pull request that only tightens, and refuses a guard moved back to an older release and a removed or broken configuration; [records.test.mjs](../../test/records.test.mjs) reports a misspelt `Weakens` field.

## Notes

Worked on branch `c2-enforcement`. The rules and the table of ids are in [spec section 10](../plan/spec.md#10-ci). Limit for C3: the base's guard cannot know the hashes of a newer release, so a pull request that updates the guard needs a decision until the workflow supplies the release it moves to.
