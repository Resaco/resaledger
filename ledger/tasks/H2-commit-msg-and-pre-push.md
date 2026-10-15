# H2 commit-msg and pre-push

- Status: done
- Depends on: V2
- Plan: [H-hooks.md](../plan/H-hooks.md#h2-commit-msg-and-pre-push)
- Evidence: `node scripts/test.mjs` on `main` after the merges: 507 of 507 on Node 24.18.0, 22.23.3 and 20.20.2. [commitmsg.test.mjs](../../test/commitmsg.test.mjs) commits through git for every exemption, style, attribution and trailer rule, including people named Claude, Devin, Jules or Kimi, who pass; [prepush.test.mjs](../../test/prepush.test.mjs) pushes to a bare remote, and a commit made with `--no-verify` and no trailer is refused when it is pushed. Not verified: Windows (CI).

## Notes

Known gaps: with `--amend` the staged diff is taken against HEAD, not the amended commit's parent; and the pre-commit framework runs no hook when a branch is deleted, so deleting a protected branch is not caught under it. On review the lead had the four assistant names that are also first names matched only in forms no person has.
