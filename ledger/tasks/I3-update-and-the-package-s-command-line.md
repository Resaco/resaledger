# I3 `update` and the package's command line

- Status: done
- Depends on: I1
- Plan: [I-installer.md](../plan/I-installer.md#i3-update-and-the-packages-command-line)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 558 of 558 on Node 24.18.0, 22.23.3 and 20.20.2. [update.test.mjs](../../test/update.test.mjs) covers a clean update, an upgrade from a released version, a hand-edited hook and block kept and then forced, a missing guard restored, a newer guard refused, and commands passed to the repository's guard from a subfolder with their stdin and exit code; [package.test.mjs](../../test/package.test.mjs) checks the list that `npm pack` publishes. Not verified: Windows (CI).

## Notes

An older package recognises a newer guard by the guard's version line. Spec section 15 now says that releases record hashes of the managed files instead of version lines in the hooks and the block. `scripts/release-hashes.mjs` adds a release's hashes; L3 runs it.
