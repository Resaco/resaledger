# L5 The third release candidate

- Status: doing
- Lane: main
- Evidence: —
- Depends on: P12, P13
- Plan: [L-launch.md](../plan/L-launch.md#l5-the-third-release-candidate)

## Handoff

P12 and P13 are merged and this repository runs the guard with them. The review ([evidence/p/review-lfs.md](../evidence/p/review-lfs.md)) found three serious gaps; P12.1 (lane lfs-guard-2) and P13.1 (lane lfs-setup-2) fix them. Next: merge both lanes, renew the guard, a short second look at the fixes, the changelog's rc.3 section and `docs/releases/v1.0.0-rc.3.md` with the known limit that the Git LFS path is not tested on Windows, then the version, the hashes, the tests on Node 20, 22 and 24, the history scan, `npm publish --dry-run`, the stamp and the tag.
