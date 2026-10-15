# L — The demo, the launch drafts and the release candidate

Status: approved · 2026-10-15 · by Niko Alho

Everything the owner needs to publish, prepared and checked. Nothing is pushed, published or posted by an agent.

### L1 The terminal demo

Goal: a short demo, recorded for real.

Design:
- A VHS tape that runs `init`, a refused commit, a task, `verify`, `handoff`, and three lanes merging.
- The output goes into the repository as a GIF or an SVG.
- VHS must be installed, which needs the owner's permission.

Acceptance: manual check 2 in [standards.md](../README.md#manual-checks): the recording matches a rerun.

### L2 Release notes and launch drafts

Goal: release notes for 1.0.0 in the repository, and drafts for Show HN, Reddit and X in the owner's voice, kept outside it.

Acceptance: the owner reads the drafts, and nothing is posted.

### L3 The release candidate

Goal: `v1.0.0-rc.1` tagged locally, with every check green, and the commands the owner runs.

Design:
- Run every test across the local matrix.
- Run the hygiene test, the history scan and the manual checks.
- Tag `v1.0.0-rc.1`.
- Write down the exact commands for the owner: create the repository, push, publish to npm with provenance and add the plugin marketplace.

Acceptance:
- Every task in the ledger is done, with evidence.
- The owner has the commands.
