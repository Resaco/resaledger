# D4 The README

- Status: done
- Lane: main
- Depends on: D2, G2, G3, L1
- Plan: [D-docs.md](../plan/D-docs.md#d4-the-readme)
- Evidence:
  - The quickstart ran as written in a new repository through an `npx` shim to the local package: `init`, its printed commit command, `new`, the plan, `claim`, the commit, `verify` and `handoff` behaved as the page says (manual check 1).
  - [repository-files.test.mjs](../../test/repository-files.test.mjs) checks that the README reaches every repository file; the owner read the page on 15 October and asked that it say plainly that agents run the daily loop, which it now does.

## Notes

The README leads with the pain and the fix, then the quickstart, the demo, how it works, who it is for, where a bad commit stops, the comparison table, the commands, an FAQ and the links.
