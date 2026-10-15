# R3 Task files

- Status: done
- Depends on: R1, R2
- Plan: [R-records.md](../plan/R-records.md#r3-task-files)
- Evidence: `node scripts/test.mjs` on `main` after merging R3 and F2 and the lead's follow-up fixes: 162 of 162 on Node 24.18.0 (159 of 159 before the fixes on 22.23.3 and 20.20.2 too); the 53 task tests are in [tasks.test.mjs](../../test/tasks.test.mjs). Not verified: Linux and Windows (CI).

## Notes

The lead added two things on review: an anchor in any link into a Markdown file must be a heading there, and slugs transliterate letters such as ß and ø. Field names are exact, and a near miss names the right spelling; decisions and log entries now follow the same rule.
