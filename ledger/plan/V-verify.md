# V — Gates, stamps, the commit range check and handoff

Status: approved · 2026-10-15 · by Niko Alho

The guarantees: the gates run on the committed code, the pass is bound to that code, and every commit is recorded.

### V1 Gates and stamps

Goal: `verify` runs the gates on the committed code and writes a content-addressed stamp ([spec 5.7](spec.md#57-stamps)).

Design:
- **Running the gates.** The gates run from the repository root through the shell, in order, and stop at the first failure. A failing gate shows the last 80 lines of its output. `verify` refuses while code is uncommitted.
- **The stamp.** `verified/<16 hex digits>.json` with deterministic content. It is idempotent: if a stamp for this fingerprint exists, nothing runs, and `--force` reruns. It prunes every other stamp.
- `gates` lists the commands.

Acceptance:
- A failing gate stops `verify` and shows its output.
- Two runs on the same code leave one identical file.
- A code change writes a new stamp and removes the old one.
- Two branches that verify the same code merge without a conflict.
- A branch that verifies and a branch that prunes merge cleanly, in both orders.

### V2 The commit range check

Goal: one function decides whether every commit in a range is recorded ([spec 5.9](spec.md#59-commit-messages)). Pre-push, `handoff` and `ci` all use it.

Design: for each commit in `<from>..<to>`:
- Merges, commits made by `git revert`, release commits and the commits GitHub makes when it merges a pull request are skipped.
- A commit that changes code needs `Task:` trailers.
- Each named task is `doing` or `done` in that commit's own tree, and is held by the lane or claimed in that commit.
- `maintenance` is allowed.

One batched `git log` reads the range, and trees are read only where needed.

Acceptance:
- Tests in real repositories for each rule and each exemption, including a task renamed later in the range.
- A range of 200 commits is checked within a time budget.

### V3 `handoff`

Goal: the end-of-session check ([spec section 8](spec.md#8-command-line)).

Design:
- the records are valid, the README is written, the hooks are active and the tree is clean;
- a stamp exists for the current code when verify gates exist;
- every `doing` task in this lane has a Handoff that changed in or after the last commit naming the task;
- the lane's unpushed commits pass V2. The range is the upstream range; without one, the range from the base branch; without that, the commits since the last stamp;
- with `requirePushed` (team preset), the lane is pushed.

Acceptance:
- One test per failure, each checking the exact message.
- A session that commits the code and the task file together passes without a separate record commit.
