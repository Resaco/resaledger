# init keeps only the checks that pass as gates

- Date: 2026-10-15
- Decided by: Lead agent
- Status: accepted

`init` finds candidate checks in `package.json` (lint, typecheck, check-types and format:check as commit gates; test and build as verify gates, run through the lockfile's package manager), the Makefile, `pyproject.toml`, `Cargo.toml` and `go.mod`. Each runs once, offline and without input, within 60 seconds for a commit gate and 300 for a verify gate, and only those that pass are written. `commitStyle` becomes `conventional` when a commitlint configuration exists or most of the last 50 subjects follow Conventional Commits. Section 13 of the specification named a `--no-run` flag that would have written checks without running them; it became `--no-gates`, which skips detection, because a gate that never ran contradicts "kept only if it passes". The owner may reverse this.
