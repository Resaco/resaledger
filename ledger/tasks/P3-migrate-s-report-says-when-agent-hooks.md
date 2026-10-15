# P3 migrate's report says when agent hooks are missing

- Status: done
- Lane: p-migrate
- Plan: [P-adoption-feedback.md](../plan/P-adoption-feedback.md#p3-migrates-report-says-when-agent-hooks-are-missing)
- Evidence:
  - [migrate.test.mjs](../../test/migrate.test.mjs), "agent hooks after the migration": renewed hooks print nothing; `CLAUDE.md` without hooks ends the report with `npx resaledger update --agents claude`; Cursor and Gemini next to renewed Claude hooks are named alone; no agent gives claude as an example. `node --test test/migrate.test.mjs`: 68 of 68.
  - This repository's own 0.x workspace, planned in a clone: the advice names claude.
  - `npm test`: 1035 of 1035.

## Notes

The advice is printed after the undo command, and before "nothing was written" in a dry run, from `src/cli/main.mjs`; the text is `agentHooksAdvice` in `migrate.mjs`. An agent counts as configured when its configuration file, as the plan leaves it, holds ResaLedger's hook command.
