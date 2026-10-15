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

### L4 The second release candidate

Goal: `v1.0.0-rc.2` tagged locally with the fixes of [phase P](P-adoption-feedback.md), and the commands the owner runs.

Design:
- Merge the lanes of phase P, rebuild the guard and renew this repository's own copy with it.
- The changelog's rc.2 section, drafted with `changes` and edited down, and `docs/releases/v1.0.0-rc.2.md`.
- The managed files' hashes for rc.2 in `templates/released.json`.
- Every test on Node 20, 22 and 24, the hygiene test, the history scan, `npm publish --dry-run`, the stamp and `handoff`.
- Tag `v1.0.0-rc.2`, and write down the owner's commands: push, the tag that publishes to `next` through trusted publishing, the GitHub release and, when the owner decides, moving `latest`.

Acceptance:
- Every task of phase P is done, with evidence.
- The owner has the commands.

### L5 The third release candidate

Goal: `v1.0.0-rc.3` tagged locally with the Git LFS support of [P12](P-adoption-feedback.md#p12-the-pre-push-runs-git-lfss-pre-push) and [P13](P-adoption-feedback.md#p13-init-and-migrate-replace-git-lfss-own-pre-push), reviewed by a second model, and the owner's commands.

Design: as [L4](#l4-the-second-release-candidate): merge the lanes, renew the guard, the changelog and release notes, the hashes, the tests on Node 20, 22 and 24, the history scan, `npm publish --dry-run`, the stamp, `handoff` and the tag. The release is staged on npm and the owner approves it.

Acceptance: P12 and P13 are done with evidence, the review's findings are fixed or recorded, and the owner has the commands.
