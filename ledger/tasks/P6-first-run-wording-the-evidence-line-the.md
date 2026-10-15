# P6 First-run wording: the Evidence line, the README title and the claim message

- Status: done
- Lane: p-installer
- Plan: [P-adoption-feedback.md](../plan/P-adoption-feedback.md#p6-first-run-wording-the-evidence-line-the-readme-title-and-the-claim-message)
- Evidence:
  - [create.test.mjs](../../test/create.test.mjs) (new writes `- Evidence: —`; the format reference's todo example has the same fields), [tasks.test.mjs](../../test/tasks.test.mjs) (`—` passes before done; done with `—` says to replace it), [init.test.mjs](../../test/init.test.mjs) (`@scope/web` gives `web`), [claim.test.mjs](../../test/claim.test.mjs) (no remote, no push wording)
  - `node --test test/create.test.mjs test/tasks.test.mjs test/init.test.mjs test/claim.test.mjs`: 140 of 140
  - `npm test`: 1030 of 1030

## Notes

Beyond the plan: CI's list of moved tasks printed `· Evidence: —` for a new task, so `ciEvidence` in `src/guard/ci.mjs` now treats an empty value as none (the CI guide's shown output caught it). The acceptance test finished tasks by inserting an Evidence line; it now replaces the `—` line, as a person would.
