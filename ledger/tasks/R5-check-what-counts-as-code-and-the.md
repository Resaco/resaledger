# R5 `check`, what counts as code, and the fingerprint

- Status: done
- Depends on: R3, R4
- Plan: [R-records.md](../plan/R-records.md#r5-check-what-counts-as-code-and-the-fingerprint)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 213 of 213 on Node 24.18.0, 22.23.3 and 20.20.2; the 51 workspace tests, including the fingerprint's equality between the index and HEAD and across a CRLF checkout, are in [workspace.test.mjs](../../test/workspace.test.mjs). `check` takes 0.4 to 0.6 seconds on a workspace of 300 tasks. Not verified: Linux and Windows (CI).

## Notes

`check` reads the configuration from the source it checks, so `--rev` on an old commit checks that commit's folder. A plan file outside `plan/` still blocks `doing` while it says proposal. Possible speed-up later: remember each plan file's headings within one run.
