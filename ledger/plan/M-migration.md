# M — Migration

Status: approved · 2026-10-15 · by Niko Alho

`resaledger migrate` moves a 0.x workspace to 1.0 without losing a line, and this repository is the first to move ([spec section 14](spec.md#14-migration-from-0x)).

### M1 Reading 0.x workspaces

Goal: every 0.x record is read exactly as it is.

Design: parsers for:
- the ledger: tasks, phase headings and any text under them;
- the log;
- the decision table, including escaped pipes and long cells;
- the status file;
- the workspace README;
- the standards file;
- the workspace `AGENTS.md`;
- the version-1 configuration. Guard mode is recognised and refused.

Acceptance: synthetic fixtures for every quirk seen in real workspaces:
- sub-ids such as `F1.2`;
- rules written in another language than English;
- phase headings with text under them;
- 25 log entries on one day;
- `commitStyle` and deny rules in the configuration.

### M2 Converting, safely

Goal: `resaledger migrate`, as the specification describes.

Design:
- the mapping table, and links rewritten;
- the new files are built and validated in memory before anything is written;
- the content check: every non-empty old line must appear in the new files, allowing for the known reshaping;
- the refusal rules and `--dry-run`;
- it writes the files, renames the configuration file and runs `check`. It never commits.

Acceptance:
- Fixture migrations from end to end.
- A test for each refusal.
- An injected loss stops it.
- `--dry-run` writes nothing.

### M3 Verification on real workspaces

Goal: proof on repositories the tool has never seen.

Design:
- Copies of real 0.x workspaces are made in a temporary folder outside this repository. Their source paths live in private notes, never here.
- On each copy: `migrate`, then `check`, the content report, and a manual reading of a sample of tasks, decisions and log entries.

Acceptance:
- Both copies migrate with no loss and pass `check`.
- The evidence states only that the checks passed. It contains no names and no numbers from the private workspaces.

### M4 This repository moves to 1.0

Goal: dogfooding. The rest of the build runs on the 1.0 format.

Design:
- Run the built `resaledger migrate` on this repository's 0.x workspace.
- Review the result and commit it with `Task: M4`.
- From then on the repository uses its own 1.0 guard, renewed with `update`.

Acceptance:
- `check` and `handoff` pass with the 1.0 guard.
- The history keeps the 0.x records.
- The move is recorded in the ledger.
