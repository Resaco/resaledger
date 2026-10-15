# T5: independent review of `migrate`

Reviewer: Fable 5.1, a second model, on 2026-10-15, at commit 130a2b9. Scope: `src/cli/legacy.mjs`, `src/cli/migrate.mjs`, `src/cli/setup.mjs`, `migrateCommand` in `src/cli/main.mjs`, the guard modules `migrate` calls, spec section 14, plan M1–M3 and their tests. Every finding was reproduced with a script on synthetic 0.x repositories.

The reviewer's summary: with a normal, fully tracked, UTF-8 workspace, `migrate` does not lose a line; the content check, the refusals and the undo held up. The problems are at the edges of git: ignored files, a crash halfway, symlinks, bytes that are not UTF-8, and a hook command the installed guard does not have yet. A dry run of this repository's own migration (M4) was clean.

## Findings

| # | Severity | Finding | Task |
| --- | --- | --- | --- |
| 1 | blocker | New record files that `.gitignore` matches (a `log/` rule is common) are written and pass `check`, but are never committed, so a clone loses the 0.x log and the migration's own log entry. | [T5.1](../../work/ledger.md#t51-data-safety-in-migrate) |
| 2 | major | When writing fails halfway, the undo command is not printed. | T5.1 |
| 3 | major | `.claude/settings.json` is rewritten to `records.mjs hook claude <event>`, which the guard does not have until A1. | [T5.3](../../work/ledger.md#t53-the-agent-hook-command-that-migrate-writes) |
| 4 | minor | Bytes that are not UTF-8 are replaced with U+FFFD without a refusal. | T5.1 |
| 5 | minor | Writes and deletes follow symlinks, so they can land outside git's reach. | T5.1 |
| 6 | minor | On a case-insensitive file system, two planned task files that differ only in case overwrite each other. | T5.1 |
| 7 | minor | A duplicated known field scatters its continuation lines; the content check cannot see placement. | [T5.2](../../work/ledger.md#t52-a-faithful-conversion) |
| 8 | minor | Blank-line runs inside fenced code in the README, the root `AGENTS.md` and `CLAUDE.md` are collapsed. | T5.2 |
| 9 | minor | Links into `standards.md` lose their anchor without a note; HTML links are neither rewritten nor listed; links in indented code are rewritten. | T5.2 |
| 10 | minor | The `--accept-problems` advice says to commit and fix later, but pre-commit refuses that commit. | T5.2 |
| 11 | minor | Every `doing` task without a Lane gets the branch `migrate` runs on, without a note. | T5.2 |
| 12 | minor | Rebuilt files lose their BOM and CRLF line endings. | T5.2 |
| 13 | minor | A hand-edited 0.x guard is replaced without a word. | T5.2 |
| 14 | minor | A task-like id such as `COM1` with a slug-less title gives a name Windows cannot create. | T5.1 |

## Checked and found sound

- The content check: every non-empty 0.x line, as a multiset over the new Markdown files, built before links are rewritten; injected losses are caught. Its only blind spot is placement (finding 7).
- The refusals: planning only reads, and each refusal leaves the tree unchanged byte for byte.
- The undo: it restores content and modes and removes the new files, also from a subfolder; it cannot delete a file `migrate` did not create, because `migrate` refuses when any untracked file exists, also with `status.showUntrackedFiles=no`.
- Paths: ids, slugs and dates cannot form `/` or `..`; `AGENTS.md` and `CLAUDE.md` links are handled.
- Links: inline, image and reference links, titles, angle brackets, encoded paths and anchors; code spans and fences are left alone; the check that only link targets changed is sound.
- Spec section 14: every row is implemented as written, apart from findings 3 and 13.
- Platforms: CRLF and BOM input parse identically; executable bits are set.
