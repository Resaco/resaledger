# P12 The pre-push runs Git LFS's pre-push

- Status: done
- Lane: lfs-guard
- Evidence: `node --test --test-name-pattern="Git LFS" test/prepush.test.mjs`: 6 of 6 pass in [prepush.test.mjs](../../test/prepush.test.mjs), with a stand-in `git-lfs` first on PATH: one call with the remote, the URL and the refs (root and folder `.gitattributes`), none for a refused push or a repository without `filter=lfs`, a failing stand-in fails the push, and without `git-lfs` the push is refused with the advice. `npm test`: 1069 of 1069 on Node 20.20.2 (macOS). Not verified: Windows, where these tests are skipped because the stand-in is a shell script.
- Plan: [P-adoption-feedback.md](../plan/P-adoption-feedback.md#p12-the-pre-push-runs-git-lfss-pre-push)
