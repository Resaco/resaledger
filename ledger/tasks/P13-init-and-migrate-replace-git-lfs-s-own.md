# P13 init and migrate replace Git LFS's own pre-push

- Status: done
- Lane: lfs-setup
- Evidence: `npm test`: 1074 of 1074 on Node 20.20.2. [init.test.mjs](../../test/init.test.mjs) ("Git LFS's own hooks in .githooks/") and [migrate.test.mjs](../../test/migrate.test.mjs) (the same describe) use the hook texts Git LFS 3.8.0 writes: `init` with all four hooks, tracked or not, replaces `pre-push` only; `migrate --dry-run` with an untracked Git LFS `pre-push` plans its replacement and prints `git lfs update --force`; a `.git/info/exclude` line hiding `.githooks/pre-push` is refused with its line; a foreign `pre-push` is still refused. `node --test test/guides.test.mjs`: 13 of 13, the `git lfs install` block marked not run (needs Git LFS).
- Plan: [P-adoption-feedback.md](../plan/P-adoption-feedback.md#p13-init-and-migrate-replace-git-lfss-own-pre-push)
