# 2026-10-15 · A lane left open during the move

- Lane: main
- Tasks: W5, M4.1

Correction to the previous entry: W5's lane did not merge cleanly into the 1.0 workspace. It had stayed open during the move, against migrate's warning, and merged as it was its 0.x commit failed `handoff`, because the 1.0 range check judges each commit by its own tree and that tree had no task file; the next push would have failed CI the same way. Nothing was pushed, so the commit was replayed onto the migrated base, with the same final tree and so the same stamp. M4.1 makes migrate's warning give the real reason and the fix.
