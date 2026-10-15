# D1 The format reference

- Status: done
- Lane: d1-format
- Depends on: R5
- Plan: [D-docs.md](../plan/D-docs.md#d1-the-format-reference)
- Evidence:
  - `node --test test/format-doc.test.mjs`: 8 of 8; each of eight planted errors in docs/format.md (a bad status, an unknown task in a log entry, a wrong code answer, a todo task in a commit, a broken anchor, an undocumented key, a changed gate, a changed default) fails it
  - `node ledger/scripts/records.mjs verify` (Node 20): `npm test` passed, all 955 tests, at a load average of 11; stamp `c63b6ed778f2c2f4.json`, since replaced by a newer one
  - `node scripts/test.mjs` on Node 24, 22 and 20 at a load average of 30 to 75: 954, 954 and 953 of 955; the failures are only the timing budgets in test/ids.test.mjs (a commit with 50 other branches) and, on Node 20, test/work.test.mjs (`work --all` on 500 branches)

## Notes

As built: [docs/format.md](../../docs/format.md), the public contract of format version 2, written from spec sections 5, 6.7 and 15 and checked line by line against `src/guard/`; and `test/format-doc.test.mjs`.

Choices:
- An example is a fenced block whose info string is `<language> <kind> [<path>]`. The kinds are listed in a comment at the top of the test. Record examples (task, decision, log, plan, readme, evidence, stamp) together form one example workspace, and the test runs the guard's own `loadWorkspace` and `checkWorkspace` over it, so links between examples (a task's plan anchor, its evidence file, a superseding decision, log task ids) are checked too.
- Other kinds are checked by the function that decides: `json config` by `parseConfig`, `json effective` against `effectiveConfigJson` of `{ "version": 2 }`, `json stamp` by `verifiedStamp` for the first config example, `text commit` by `checkCommit` and the Conventional Commits pattern against the example tasks, and `text code` (lines of `yes|no <path>`) by `isCode`.
- The key test reads `DEFAULTS` (nested keys as `gates.commit` and so on), the preset keys and `version`, and wants a row in the configuration table for each.
- Names in examples are neutral (a bakery shop, alice, bob). No vendor names: the AI attribution list is described, not copied.

Where the code differs from the spec (the code is documented; the lead decides which changes):
1. Config: an unknown key is refused (with a typo hint). Spec 15 says 1.x is additive and old guards keep unknown fields; for configuration keys an older guard refuses a newer key. The document says so.
2. Task title: at most 100 characters. Not in spec 5.3.
3. Task field typo: a name within two letters of a known one is a refusal, not a warning, so "Other fields are allowed" excludes names like `Lanes` or `Name`.
4. Evidence: the concreteness rule applies whenever Evidence is not empty, at any status, not only when done.
5. Plan: a link without an anchor must point to a file with content; the plan status line may leave out the date and who decided, and its status must be lowercase.
6. Task, decision and log files in a subfolder of their folder are not read at all, so the "belongs directly in tasks/" message never fires for them.
7. Decision fields and log fields also get typo and duplicate checks; a decision's file name date must equal its Date, and a log entry's heading date must equal its file name date.
8. Commit trailers: any body line that starts with `Task:` counts, not only the trailer block. The lane rule accepts a Lane set anywhere after the start of the checked range, not only "claimed in the same commit". A detached HEAD skips it.
9. CI's push check also exempts commits GitHub made merging a pull request (spec 10, missing from 5.9).
10. Conventional Commits: any lowercase type is accepted, with git's fixup!/squash!/amend! prefixes; merges and reverts are not checked. AI attribution is checked only in body lines whose key ends in `-by` or `-with`.
11. Stamp: written with two-space indentation, not on one line as in spec 5.7; it counts only for the gates configured now; `verify` runs when any gate is configured, while `handoff` asks for a stamp only when `gates.verify` is not empty (as in the spec).
12. README: any `##` section, not only the required ones, must not be empty; required section names match without regard to case.
