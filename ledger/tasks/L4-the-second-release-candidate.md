# L4 The second release candidate

- Status: done
- Lane: main
- Depends on: P1, P2, P3, P4, P5, P6, P7, P8, P9, P10, P11
- Plan: [L-launch.md](../plan/L-launch.md#l4-the-second-release-candidate)
- Evidence:
  - `node scripts/test.mjs`: 1063 of 1063 on Node 24.18.0, 22.23.3 and 20.20.2, run one after the other on the release commit; `verify` passed both gates on the final code (stamp `9cb8e33b73a9ee18.json`).
  - `node scripts/release-hashes.mjs --check`: `templates/released.json` holds the hashes of 1.0.0-rc.2, and this repository runs that released guard.
  - `npm publish --dry-run --tag next --access public`: `resaledger@1.0.0-rc.2`, 48 files, 284.5 kB.
  - `node scripts/scan-history.mjs`: clean, after [L4.1](L4.1-the-hygiene-scan-accepts-the-reserved.md).
  - [The review](../evidence/p/review.md): nothing blocking; four findings fixed in [P9.1](P9.1-the-push-check-and-what-runs-before-it.md) and [P5.1](P5.1-urls-and-paths-keep-their-and-gh-in-the.md).
  - Published by the owner on 2026-10-16: the tag's workflow staged the version and the owner approved it. `npm view resaledger@1.0.0-rc.2 dist.shasum`: `98381e56a73a4d5bda52614c149e87a518e6e6d3`, the same as `npm pack` of the tag here; dist-tag `next` is 1.0.0-rc.2; GitHub release https://github.com/Resaco/resaledger/releases/tag/v1.0.0-rc.2.

## Notes

The release workflow now stages the version with `npm stage publish`, so it reaches users only after the owner approves it with two-factor authentication ([P11](P11-staged-publishing-in-the-release-guide.md)). Provenance survives the approval: the SLSA attestation of 1.0.0-rc.2 names `.github/workflows/release.yml` at `refs/tags/v1.0.0-rc.2` and the tag's commit.
