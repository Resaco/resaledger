# P11 Staged publishing in the release guide

- Status: done
- Lane: main
- Plan: [P-adoption-feedback.md](../plan/P-adoption-feedback.md#p11-staged-publishing-in-the-release-guide)
- Evidence:
  - [releasing.md](../../docs/releasing.md) and [release.yml](../../.github/workflows/release.yml) follow https://docs.npmjs.com/staged-publishing/, https://docs.npmjs.com/trusted-publishers/ and https://docs.npmjs.com/cli/v11/commands/npm-stage/, read on 2026-10-15.
  - `node --test test/repository-files.test.mjs`: 18 of 18; the release workflow only stages, with provenance, after the tests, the bundle and the hash check, and checks that its npm can stage.
  - The first real staged release, 1.0.0-rc.2 on 2026-10-16: the workflow staged it through trusted publishing, the owner approved it with two-factor authentication, and https://registry.npmjs.org/-/npm/v1/attestations/resaledger@1.0.0-rc.2 holds SLSA provenance for `release.yml` at the tag.

## Notes

The plan asked for the guide only, but with npm publish no longer allowed for the workflow, its `npm publish` would fail, so the workflow now runs `npm stage publish`. Staging is always allowed for a trusted publisher, so rc.2 stages whether or not the owner has turned npm publish off yet. Whether provenance survives the approval is not stated in npm's documentation; rc.2 showed that it does.
