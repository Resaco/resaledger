# T3: independent review of the guard

Reviewer: Fable 5.1, a second model, on 2026-10-15, at commit 1d80c4e. Scope: the record format (R), gates, stamps, the range check and `handoff` (V), and the git hooks (H): `src/guard/` and the hook scripts. Every finding was reproduced with the real product (`init`, the installed hooks and the guard) in throwaway repositories.

## Findings

| # | Severity | Finding | Task |
| --- | --- | --- | --- |
| 1 | blocker | A commit message ending in the byte 0x01 hides a code commit from the range check, because one `git log` output is split on that byte; `check --range`, pre-push, `handoff` and `ci` all pass it. | [T3.1](../../work/ledger.md#t31-a-range-check-that-cannot-be-fooled) |
| 2 | major | A merge commit is exempt, so code added in the merge itself ("an evil merge") passes every check. | T3.1 |
| 3 | major | The revert and release exemptions are taken from the message text alone: `This reverts commit <hex>.` or a `Release vX.Y.Z` subject exempts any commit. | T3.1 |
| 4 | major | In the team preset, a clean or fast-forward `git merge` onto the protected base passes, because `git merge` runs `pre-merge-commit`, which is not shipped, and never `pre-commit`. | [T3.2](../../work/ledger.md#t32-hooks-judged-by-the-committed-rules) |
| 5 | major | The first `handoff` in an adopted repository without a remote fails on the commits made before ResaLedger, because its range does not start at the commit that added the configuration, as pre-push's does. | [T3.3](../../work/ledger.md#t33-handoff-and-verify-at-the-edges) |
| 6 | major | The hooks judge a commit, and a push, by the configuration inside that commit, so staging `"protected": []` unprotects the base locally. | T3.2 |
| 7 | minor | `commit --amend` is judged against HEAD, so removing the trailer from a code commit passes commit-msg (the range checks catch it later). | T3.1 |
| 8 | minor | A non-Markdown file in the workspace that code reads is a record, so changing it needs no task and leaves the stamp in place. | T3.3 |
| 9 | minor | After merging another lane in, a task that lane holds can be deleted. | T3.2 |
| 10 | minor | `verify` prunes every `.json` in `verified/` and crashes on a folder named like one. | T3.3 |
| 11 | minor | `skip-worktree` and `assume-unchanged` hide a working-tree change from `verify`. | T3.3 |
| 12 | minor | `init --dir` is pasted unquoted into the hook scripts; a `dir` with shell syntax runs it. | [T3.4](../../work/ledger.md#t34-setup-that-works-everywhere) |
| 13 | minor | Hook scripts checked out with CRLF under Git for Windows may fail; `init` adds no `eol=lf` rule. Not reproduced on Windows. | T3.4 |

## Checked and found sound

- Parsing of tasks, decisions and log entries with CRLF, non-ASCII paths and headings, fenced code and links with spaces and anchors.
- Partial commits judged on git's temporary index; ownership, takeovers, the WIP limit, duplicate ids and dependencies; a renamed lane refused until `claim --take`.
- Id collisions against local and remote-tracking branches and other worktrees.
- The fingerprint: stable across line endings, changed by code, configuration, guard and hooks and never by records; stamps are deterministic and bound to the gate list; forged stamps are refused; `verify` refuses uncommitted code.
- The range check apart from findings 1–3; pre-push's protected branches, deletions, range starts and the pre-commit framework's variables.
- POSIX hook scripts that find Node or Bun; hook managers; no shell anywhere except the configured gates.
- Speed: 8,009 tracked files, pre-commit and commit-msg in 160 ms, `check` in 72 ms, `handoff` in 255 ms.
