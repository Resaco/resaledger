# H — Git hooks

Status: approved · 2026-10-15 · by Niko Alho

The hooks refuse unrecorded work at the moment it is committed or pushed, on every platform.

### H1 pre-commit

Goal: refuse a bad commit before it is made, judged on the staged content.

Design:
- protected branches and the branch pattern;
- the records, validated from the index rather than the working tree. 0.x read the working tree, so a partial commit could pass because of unstaged files;
- task ownership for staged task files: refuse another lane's task and a deleted task, and allow a claim and a takeover;
- the commit gates, when code is staged.

Acceptance:
- One test per refusal.
- A partial commit that would leave the index invalid is refused, even when the working tree is valid.

### H2 commit-msg and pre-push

Goal: the rules for messages and for pushes.

Design:
- **commit-msg:**
  - Conventional Commits, when configured;
  - AI attribution, when it is forbidden;
  - the trailers, checked against the staged tree with V2's rules for one commit.
- **pre-push:** no push to a protected branch, and the pushed range passes V2.

Acceptance:
- One test per rule.
- A commit made with `--no-verify` and no trailer is refused when it is pushed.

### H3 Hook scripts and activation

Goal: the hooks run on every platform, and a fresh clone turns them on.

Design:
- **Hook scripts.** POSIX sh scripts that find Node or Bun; Git for Windows runs them through its own sh.
- **Activation.** `work` sets `core.hooksPath` when it is unset, and advises when another value is set.
- **Hook managers.** Helpers add the guard's calls to husky, lefthook, pre-commit and simple-git-hooks configurations; `init` uses them.

Acceptance:
- The hooks run in tests on all three operating systems in CI.
- `work` turns the hooks on in a fresh clone.
- Each hook manager integration is tested on a sample configuration.
