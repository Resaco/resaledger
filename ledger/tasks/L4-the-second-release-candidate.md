# L4 The second release candidate

- Status: doing
- Lane: main
- Depends on: P1, P2, P3, P4, P5, P6, P7, P8, P9, P10, P11
- Plan: [L-launch.md](../plan/L-launch.md#l4-the-second-release-candidate)

## Handoff

Phase P's lanes are merged, this repository's guard is renewed with them, and the changelog's rc.2 section and `docs/releases/v1.0.0-rc.2.md` are written. The review ([evidence/p/review.md](../evidence/p/review.md)) found nothing blocking; P9.1 and P5.1 fix four of its findings in the lane p-review. Next: merge p-review, add P9.1's push rule to the changelog, renew the guard again, then `npm version 1.0.0-rc.2 --no-git-tag-version`, `node scripts/release-hashes.mjs`, the tests on Node 20, 22 and 24, the history scan, `npm publish --dry-run`, verify, and the local tag. The owner's commands are drafted outside the repository.
