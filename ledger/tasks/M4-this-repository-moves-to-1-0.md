# M4 This repository moves to 1.0

- Status: done
- Lane: main
- Depends on: M3, T5, I3, H2, V3, A1, T5.1, T5.2, T3.1, T3.2
- Plan: [M-migration.md](../plan/M-migration.md#m4-this-repository-moves-to-10)
- Evidence:
  - `node bin/resaledger.mjs migrate` on this repository, committed as `chore: migrate this repository to ResaLedger 1.0`: 59 tasks, 30 decisions and 25 log entries moved, no line lost, 19 links rewritten; the new guard's `check` passed on the result.
  - `node ledger/scripts/records.mjs verify` with the 1.0 guard: both gates passed and wrote the stamp in [verified/](../verified/); `handoff` passes.
  - The 0.x records stay in history: [legacy.test.mjs](../../test/legacy.test.mjs) and [migrate.test.mjs](../../test/migrate.test.mjs) read them from the last 0.x commit and migrate them again, and CI fetches the whole history for that.

## Notes

What the move showed, for later tasks:

- Migrate keeps the project's own text word for word and rewrites only link targets, so a link whose text named an old file, such as `[STATUS.md](README.md)`, kept its old text. The workspace README and `AGENTS.md` here were reworded by hand. D2's migration guide should say so.
- The warning about an open lane is coarse: it named `w5-changes`, whose only changes in `ledger/` were to `plan/` files that migrate leaves alone, and that lane merged cleanly afterwards.
- A development build of the guard is never a released version, so `update` keeps it; this repository renews it with `update --force`, as its README says.
- `changes` since a commit before the move lists every finished task, because no 1.0 task existed there.
