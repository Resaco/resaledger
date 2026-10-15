# W5 `changes`

- Status: done
- Lane: main
- Depends on: V2
- Plan: [W-work.md](../plan/W-work.md#w5-changes)
- Evidence:
  - `node scripts/test.mjs` on the branch: 780 of 780 on Node 24.18.0, 22.23.3 and 20.20.2; [changes.test.mjs](../../test/changes.test.mjs) covers two tags with the default and `--since`, Conventional and free-form commits, a task finished, reopened and finished again, no tag, `--json` and a bad ref, and checks that nothing is written.
  - `node ledger/scripts/records.mjs changes --since 853e7c1` on this repository lists the finished tasks with their evidence, links resolved from the repository root.

## Notes

Worked on branch `w5-changes`, which was open while this repository moved to 1.0. Merged as it was, its 0.x commit failed the 1.0 range check, which finds no task file in that commit's tree, so it was replayed onto the migrated base instead ([M4.1](M4.1-a-lane-open-during-the-migration.md)). Choices: a dropped task is not listed, but one line names it; the grouping looks only at the commits that name a listed task, and a `chore: claim <id>` commit does not count towards a task's type; the configuration is read from HEAD's commit, since the command reports committed history.
