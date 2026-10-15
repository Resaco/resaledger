# P1 migrate renames the old configuration file in .gitattributes

- Status: done
- Lane: p-migrate
- Plan: [P-adoption-feedback.md](../plan/P-adoption-feedback.md#p1-migrate-renames-the-old-configuration-file-in-gitattributes)
- Evidence:
  - [migrate.test.mjs](../../test/migrate.test.mjs), "a rule for the old configuration file names the new one, and git archive leaves the configuration out" and "a CRLF .gitattributes keeps its line endings when the old name is rewritten": `node --test test/migrate.test.mjs`: 68 of 68.
  - `npm test`: 1035 of 1035.

## Notes

A pattern with a leading slash (`/.agent-ledger.json`) counts as the exact path and keeps its slash. The rewritten lines are listed under "Lines rewritten in .gitattributes" in `src/cli/main.mjs`, outside this lane's two files: one `list` call and an import.
