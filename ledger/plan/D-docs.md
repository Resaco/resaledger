# D — Documentation and the repository's own files

Status: proposal · 2026-10-15 · part of the plan the owner reviews

The documentation describes what was built, so it comes after the features and is checked against them.

### D1 The format reference

Goal: `docs/format.md`, the public contract as it was built.

Design: written from [spec section 5](spec.md#5-format-reference) and corrected to the built behaviour. A test parses every example in the document.

Acceptance: every example parses and every link resolves.

### D2 Guides

Goal: concepts, a solo guide, a team guide, CI setup, setup for each agent, and migration from 0.x.

Design:
- **The team guide** covers the presets, the required check, CODEOWNERS for the enforcement files, and GitHub's squash-merge message setting.
- **CI setup** covers GitHub and other CI systems.

Acceptance: every command in the guides runs, either in a test or in a recorded session. The hygiene test passes.

### D3 Repository files and releases

Goal: the open-source files a mature project has.

Design:
- `CONTRIBUTING` (how this repository is worked: the ledger and the rules for workers);
- `CODE_OF_CONDUCT` (Contributor Covenant 2.1);
- `SECURITY` (private reporting);
- issue and pull request templates;
- `CHANGELOG` in the Keep a Changelog style, drafted with `changes`;
- the semver policy;
- a release workflow: a tag publishes to npm with provenance, run by the owner;
- drafts of a few good first issues, kept as drafts until the public repository exists.

Acceptance: every file exists and is linked from the README. The release workflow parses and passes a dry run.

### D4 The README

Goal: the first screen states the pain and the fix in plain words. After it come a 30-second quickstart, the demo, the comparison table and an FAQ.

Design:
- the cover from G2 and the demo from L1;
- plain words, no hype and no walls of emoji;
- light and dark images through `<picture>`.

Acceptance:
- The quickstart runs exactly as written in a new temporary repository (manual check 1 in [standards.md](../standards.md#quality-gates)).
- The owner reads it.
