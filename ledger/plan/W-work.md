# W — The daily commands

Status: proposal · 2026-10-15 · part of the plan the owner reviews

The commands people and agents type every session: see the state, read a task, create records, claim, and list what changed.

### W1 `work` on this machine

Goal: the state on one screen, for this lane and the other local worktrees ([spec 6.4](spec.md#64-seeing-other-lanes) and [section 8](spec.md#8-command-line)).

Design:
- **Lanes.** The current branch is the lane. Task files in the other worktrees are read from disk.
- **Sections:** the goal; in progress, with the Handoff; waiting for the owner; blocked; ready next (dependencies done, held by no lane, ordered by `phases` and then by id); other lanes; progress per phase; the verification state; warnings.
- `--json` gives the same data.
- It is fast and works offline.

Acceptance:
- Output tests for an empty repository, a solo repository and one with three worktrees.
- A schema test for `--json`.
- `work` finishes within one second on a workspace with 300 tasks.

### W2 `work --all` across pushed branches

Goal: see every lane before anything merges.

Design:
- **Branches.** Pushed branches not yet merged into the base, newest first.
- **Reading.** The task files that differ from the base are read in one batched call (`git cat-file --batch`).
- **Warnings.** A task claimed in two lanes, and a claim left behind by a merged branch.
- **`--fetch`** fetches first, and continues offline when the fetch fails.

Acceptance:
- Tests with two remote lanes holding the same task (a warning) and with a merged branch that still holds a task (a stale claim).
- 500 branches within the budget that T2 sets.

### W3 `task` and `new`

Goal: read one task, and create records with safe ids and names.

Design:
- `task <id>` prints the file and its plan section.
- `new [<prefix>] "<title>"` takes the next number across this worktree, the other worktrees and fetched branches.
- `--under <id>` creates the next child id.
- `--issue <n>` records the issue, and takes the title from `gh` when it is installed.
- `new decision` and `new log` create dated files with unique slugs.

Acceptance:
- Id tests, including a gap in the numbers, a child of a child, and an id already taken in another worktree.
- Slug tests: non-ASCII titles, long titles and duplicates.

### W4 `claim`

Goal: take a task safely ([spec 6.3](spec.md#63-claiming)).

Design:
- **Another lane.** It refuses a task that another visible lane holds; in the team preset it fetches first. `--take` takes the task over and records that it did.
- **On a protected base** it creates the lane branch first (`--branch`, `--worktree`).
- **The claim itself** sets Status and Lane, then checks the WIP limit and the plan.
- **Pushing.** With `claimPush` or `--push`, it commits the claim on its own and pushes.

Acceptance: a test for each path, including a double claim between two worktrees, and one between two clones through the bare remote.

### W5 `changes`

Goal: a draft for the changelog and the release notes ([spec section 8](spec.md#8-command-line)).

Design:
- It lists the tasks that became `done` between `--since <ref>` (by default the newest tag) and HEAD, each with its evidence.
- Tasks are grouped as Added, Fixed and Changed from the Conventional Commit types of the commits that name them, or in one list when those types are missing.
- Markdown by default, `--json` on request. It never writes a file.

Acceptance: tests on a history with two tags, with Conventional and free-form commits, with a task that is finished, reopened and finished again, and with no tag at all.
