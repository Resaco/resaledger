# M1 Reading 0.x workspaces

- Status: done
- Depends on: F1
- Plan: [M-migration.md](../plan/M-migration.md#m1-reading-0x-workspaces)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 323 of 323 on Node 24.18.0; the 27 tests in [legacy.test.mjs](../../test/legacy.test.mjs) cover every quirk on the list with synthetic fixtures and parse this repository's own 0.x records with no problem and no line lost. A read-only run on two private 0.x workspaces preserved every line; its counts stay outside this repository. Not verified: Node 22 and 20 on the merged tree (next verify), Linux and Windows (CI).

## Notes

The worker found nine things the migration table did not cover; the specification's section 14 now says where each goes. The package now publishes `src/guard`, so the migration can validate with the 1.0 rules.
