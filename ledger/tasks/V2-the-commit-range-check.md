# V2 The commit range check

- Status: done
- Depends on: R5
- Plan: [V-verify.md](../plan/V-verify.md#v2-the-commit-range-check)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 296 of 296 on Node 24.18.0 (22.23.3 and 20.20.2 recorded in the next log entry); the 29 tests in [range.test.mjs](../../test/range.test.mjs) cover every exemption, a claim in a records-only commit, a branch renamed after its claim, and 200 commits in under 0.4 seconds against a 3-second budget. Not verified: Windows (CI).

## Notes

On review the lane rule became range-wide: a Lane set inside the checked range is accepted, so the rule only refuses tasks another lane held before the range. Taking a held task is caught by the ownership checks in H1 and C1.
