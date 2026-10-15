# L3 The release candidate

- Status: done
- Lane: main
- Depends on: D4, L2, T1, T2, T3, T4, M4, D1, D3, A2
- Plan: [L-launch.md](../plan/L-launch.md#l3-the-release-candidate)
- Evidence:
  - `node scripts/test.mjs`: 1023 of 1023 on Node 24.18.0, 22.23.3 and 20.20.2, run one after the other on the release commit; `verify` passed both gates (stamp `b75d2ec296d03b51.json`).
  - `node scripts/release-hashes.mjs --check`: `templates/released.json` holds the hashes of 1.0.0-rc.1, and this repository runs that released guard.
  - `npm pack --dry-run` and `npm publish --dry-run --tag next --access public`: `resaledger@1.0.0-rc.1`, 48 files, 275.8 kB; the name is free on npm.
  - Manual checks: 1, the quickstart, in [D4](D4-the-readme.md); 2, the demo, in [L1](L1-the-terminal-demo.md); 3, `node scripts/scan-history.mjs`: clean.
  - The tag `v1.0.0-rc.1` is local; the owner's commands to publish it are kept outside the repository.

## Notes

Tagged on the owner's word on 15 October with two tasks still open, both waiting for him: T2 needs one CI run on Windows, which GitHub refused to start in the private repository because of billing and which is free once the repository is public; L2 waits for him to read the launch drafts. The order of his commands: make the repository public, turn on private vulnerability reporting, push `main` and read the CI run, add an npm token as `NPM_TOKEN`, push the tag so the release workflow publishes to `next` with provenance, create the GitHub release from `docs/releases/v1.0.0-rc.1.md`, then switch npm to trusted publishing and remove the token. A branded terminal banner for `init` was tried and left out.
