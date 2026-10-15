# R4 Decisions, log entries, plans and the workspace README

- Status: done
- Depends on: R2
- Plan: [R-records.md](../plan/R-records.md#r4-decisions-log-entries-plans-and-the-workspace-readme)
- Evidence: `node scripts/test.mjs` on `main` after merging R4: 95 of 95 on Node 24.18.0, 22.23.3 and 20.20.2; the 31 new tests, with CRLF input for every record type, are in [records.test.mjs](../../test/records.test.mjs). Not verified: Linux and Windows (CI).

## Notes

A README with a marker fails and passes once the text is written. Field names are compared case-insensitively; a repeated field is a problem.
