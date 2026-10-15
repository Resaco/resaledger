# R2 Markdown primitives

- Status: done
- Depends on: F1
- Plan: [R-records.md](../plan/R-records.md#r2-markdown-primitives)
- Evidence: `node scripts/test.mjs`: 47 of 47 on Node 24.18.0, 22.23.3 and 20.20.2, run by the lead on the worker's branch and on `main` after the merge; the 29 new tests are in [markdown.test.mjs](../../test/markdown.test.mjs). Not verified: GitHub's anchors for headings that use emphasis or HTML, which are slugged from the rendered text; records do not use them.

## Notes

Merged in the commit after 9258eb4 and d4eadd8. Anchors follow github-slugger's numbering of duplicates. `parseFields` skips blank lines before the list, so callers can pass the line after a heading.
