# V3 `handoff`

- Status: done
- Depends on: V1, V2, H3
- Plan: [V-verify.md](../plan/V-verify.md#v3-handoff)
- Evidence: `node scripts/test.mjs` on `main` after the merge and the lead's fix: 359 of 359 on Node 24.18.0, 22.23.3 and 20.20.2; the 19 tests in [handoff.test.mjs](../../test/handoff.test.mjs) cover every failure, a one-commit session, a detached HEAD, the team preset's push checks and a commit made with `--no-verify`. Not verified: Windows (CI).

## Notes

On review the lead made only code commits count as the last commit on a task, so a claim or a stamp that names the task does not make its handoff note stale.
