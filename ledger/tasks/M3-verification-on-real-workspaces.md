# M3 Verification on real workspaces

- Status: done
- Depends on: M2
- Plan: [M-migration.md](../plan/M-migration.md#m3-verification-on-real-workspaces)
- Evidence: The lead migrated copies of two private 0.x workspaces in a temporary folder outside this repository: both migrated with no line lost and pass `check` with the 1.0 guard, and a sample of tasks, decisions, log entries, the README and the managed `AGENTS.md` block read correctly. The rule for blocked tasks is tested in [migrate.test.mjs](../../test/migrate.test.mjs); the names, paths and counts are in private notes. Not verified: a commit of the result through the hooks, because the copies' commit gates need their projects' dependencies.

## Notes

The run showed that real blocked tasks say what they wait for in their notes, so `migrate` now takes Waiting for from the first "Waits for …" or "Blocked on …" phrase and lists each one; spec section 14 says so. Free-text status lines in plans stay a 1.0 problem for the owner to fix before migrating, because rewriting them would be interpretation.
