# The guard runs Git LFS's pre-push, and init and migrate replace LFS's own pre-push

- Date: 2026-10-16
- Decided by: Niko Alho
- Status: accepted

A migration of a 0.x workspace in a repository that uses Git LFS stopped before any change: with `core.hooksPath` set to `.githooks`, Git LFS had written its own hooks there, and ResaLedger's managed `pre-push`, which ends by handing over to the guard, would replace LFS's. A push would then send LFS pointers without their objects. In a fresh clone the same collision stops `git lfs install`: it finds a `pre-push` that is not its own, exits with code 2 and writes none of its hooks, although it sets its filters.

Decided, for 1.0.0-rc.3:

1. **The guard's `pre-push` runs Git LFS's `pre-push`** in a repository that uses Git LFS, that is, when a tracked `.gitattributes` file names `filter=lfs`. It runs after the guard's own checks pass, with the same arguments and the same refs on its input, so a refused push uploads no LFS objects. When `git-lfs` is not installed, the push is refused with Git LFS's own advice. The hook files do not change; the guard does this, so `update` has nothing to renew in the hooks.
2. **`init` and `migrate` recognise Git LFS's own hooks** in `.githooks/` by their content. They replace Git LFS's `pre-push`, since the guard now runs it, and leave its other hooks alone. `migrate` says that `git lfs update --force` brings Git LFS's hook back after an undo. Both refuse while `.git/info/exclude` hides a hook they must commit, and name the line.
3. **The guides say** that `git lfs install` in a clone reports that a `pre-push` exists and stops; that its filters are set all the same; and that Git LFS's other hooks, which only file locking needs, come from `git lfs update --manual`.

Not chosen: a general extension point, such as a `.githooks/pre-push.local` that the managed hook calls. Every project with Git LFS would wire it by hand, Git LFS's installer would still collide with the managed hook, and CI would have to audit project-written hook code as enforcement. It can come in 1.x if another tool needs it.
