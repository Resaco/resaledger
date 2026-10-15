# P2 migrate keeps edited 0.x template sections active

- Status: done
- Lane: p-migrate
- Plan: [P-adoption-feedback.md](../plan/P-adoption-feedback.md#p2-migrate-keeps-edited-0x-template-sections-active)
- Evidence:
  - [legacy.test.mjs](../../test/legacy.test.mjs): every section of the released 0.1 and 0.3 templates, filled in for three folders, both attribution settings, CRLF and extra blank lines, is recognised as untouched; one edited sentence is not; filled-in manual gates do not count. `node --test test/legacy.test.mjs`: 30 of 30.
  - [migrate.test.mjs](../../test/migrate.test.mjs), "0.x template sections the project edited": untouched sections go to the log entry; an edited Session protocol stays in the root `AGENTS.md`, an edited Commits section in the README, each named in a warning. `node --test test/migrate.test.mjs`: 68 of 68.
  - Byte for byte: the plan's writes for the untouched fixture, with each of the three CLAUDE.md shapes, were identical before and after the change (compared once, outside the suite).
  - `npm test`: 1035 of 1035.

## Notes

- `legacy.mjs` stores a SHA-256 per released section, not the text: the sections of the workspace `AGENTS.md` and `standards.md` from agent-ledger 0.1.0 and 0.2.0 (0.3.0 has the same templates as 0.2.0), with `node <dir>/scripts/records.mjs`, `` `<dir>/` `` and the two attribution sentences turned back into `{{guard}}`, `{{dir}}` and `{{attribution}}`, whitespace collapsed. Project rules has no hash; it stays as before.
- In Quality gates, the manual gates (after the "Gates that need eyes or judgement" line, or the first line in 0.1, up to "The last gate …") count as one placeholder, since they move to Manual checks anyway.
- The released templates are test fixtures in `test/fixtures/legacy-templates/` (committed with P1), so the tests use the real text; the end-to-end fixture in `migrate.test.mjs` is now built from them. This repository's own 0.x history already holds the same text.
- The migration guide's example shows the new warning: its fixture's shortened Commits section counts as edited.
- Spec 14 still says "the template's own sections are kept in the migration's log entry"; an edited section is read here as no longer the template's own. The lead may want that sentence to say so.
