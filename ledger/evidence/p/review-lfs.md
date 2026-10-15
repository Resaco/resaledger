# Independent review of the Git LFS support for 1.0.0-rc.3

A second model reviewed P12 and P13 (`636e8e6..c7d8660`) on 2026-10-16, with experiments against git-lfs 3.8.0 and a bare repository on disk as the remote, so the LFS objects that reached the remote could be counted.

## Findings

| # | Area | Severity | Finding | Outcome |
| --- | --- | --- | --- | --- |
| 1 | pre-push | high | Git LFS is detected from the index, not from the pushed commits. With a branch that adds `filter=lfs` pushed while another branch is checked out, the guard passes, Git LFS never runs, and the remote gets pointers without objects. | [P12.1](../../tasks/P12.1-git-lfs-is-found-in-the-pushed-commits.md) |
| 2 | pre-push | high | `git grep` follows the user's `grep.patternType`; with `fixed`, the pattern never matches and Git LFS never runs. | [P12.1](../../tasks/P12.1-git-lfs-is-found-in-the-pushed-commits.md) |
| 3 | pre-push | medium | A `filter=lfs` rule in `.git/info/attributes` or `core.attributesFile` makes pointers that the detection does not see. | [P12.1](../../tasks/P12.1-git-lfs-is-found-in-the-pushed-commits.md) |
| 4 | hook managers | high | A hook manager's `pre-push` that runs `git lfs pre-push` before the guard's call: Git LFS reads all of git's input, the guard gets none, checks nothing, and runs Git LFS again with no refs. | Init: [P13.1](../../tasks/P13.1-a-hook-manager-s-git-lfs-line-ignored.md). The guard runs Git LFS only for refs it was given: [P12.1](../../tasks/P12.1-git-lfs-is-found-in-the-pushed-commits.md). |
| 5 | init | low | The ignore-rule check uses `git check-ignore --no-index`, so a `.githooks/` that is force-tracked under an ignored folder is refused on every run. | [P13.1](../../tasks/P13.1-a-hook-manager-s-git-lfs-line-ignored.md) |
| 6 | migrate | low | A dangling symlink in place of a Git LFS hook makes `migrate` throw instead of refusing. | [P13.1](../../tasks/P13.1-a-hook-manager-s-git-lfs-line-ignored.md) |
| 7 | init, migrate | low | `isGitLfsHook` accepts a command substitution inside the message of the not-installed branch, so a hook changed only there is replaced. | Accepted: the branch only runs when git-lfs is missing, and its text is Git LFS's. |

Checked and found sound: the cost of the detection (about 13–25 ms per push on an index of 8,000 entries; `git lfs version` about 55 ms, only in repositories that use Git LFS), multi-ref and tag pushes (git's whole input reaches Git LFS, and a tag push uploaded its objects), a staged `.gitattributes`, no Git LFS on a refused push, its exit code and output passed through, the commit commands that keep Git LFS's `post-*` hooks out, the restore command printed after an undo, and the guides' quotation of what `git lfs install` prints.
