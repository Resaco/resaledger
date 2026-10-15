# L5 The third release candidate

- Status: done
- Lane: main
- Evidence:
  - `node scripts/test.mjs`: 1094 of 1094 on Node 24.18.0, 22.23.3 and 20.20.2, run one after the other on the release commit; `verify` passed both gates on the final code (stamp `1f10905d5e8488d5.json`).
  - `node scripts/release-hashes.mjs --check`: `templates/released.json` holds the hashes of 1.0.0-rc.3, and this repository runs that released guard.
  - `npm publish --dry-run --tag next --access public`: `resaledger@1.0.0-rc.3`, 48 files, 290.2 kB; `npm pack --dry-run` shasum `73568526bb18fac0f5d0f4f66e140e9da7e8dae6`.
  - `node scripts/scan-history.mjs`: clean.
  - [The review](../evidence/p/review-lfs.md): three serious gaps and three small ones, fixed in [P12.1](P12.1-git-lfs-is-found-in-the-pushed-commits.md) and [P13.1](P13.1-a-hook-manager-s-git-lfs-line-ignored.md); the reviewer's scenarios rerun against git-lfs 3.8.0 upload their objects.
  - The tag `v1.0.0-rc.3` is local; the owner's commands to publish it are kept outside the repository.
- Depends on: P12, P13
- Plan: [L-launch.md](../plan/L-launch.md#l5-the-third-release-candidate)

## Notes

Known limit, in the changelog: the Git LFS path is tested on Linux and macOS, not on Windows, because the tests' stand-in for git-lfs is a shell script. A hand-written hook manager `pre-push` that runs `git lfs pre-push` before the guard still blinds the guard; `init` refuses that setup.
