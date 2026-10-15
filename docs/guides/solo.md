# Working alone

This guide sets ResaLedger up for one person, with or without coding agents. You get a task ledger in `ledger/`, git hooks that refuse a commit with no task, and a stamp that ties a passing test run to the exact code it ran on. Later in the guide, three agents work at once, each in its own worktree.

You need git, Node 20 or newer, and a repository with at least one commit. The examples use a small shop for a bakery, with a `lint` and a `test` script in `package.json`.

[Concepts](concepts.md) explains the words used here. [The format reference](../format.md) describes every file.

## Set it up

Run `init` in the repository root:

```bash
npx resaledger init
```

It tries the project's own checks once, keeps the ones that pass as gates, and writes the files:

```text
Gates: trying 2 checks once each, offline; only those that pass are kept.
✔ npm run lint passed in 0.1 s
✔ npm test passed in 0.2 s
resaledger init: ResaLedger is set up in ledger/, with the solo preset
Gates: 1 commit, 1 verify; "node ledger/scripts/records.mjs gates" lists them.
Created (9):
.githooks/pre-commit
.resaledger.json
AGENTS.md
ledger/README.md
ledger/scripts/records.mjs
✔ git hooks turned on: core.hooksPath is .githooks
✔ records valid: 0 tasks, 0 decisions, 0 log entries
```

The checks it tries are `package.json`'s `lint`, `typecheck`, `check-types` and `format:check` scripts as commit gates and `check`, `test` and `build` as verify gates, a `Makefile`'s `lint`, `check`, `test` and `build` targets, and the usual tools of `pyproject.toml`, `Cargo.toml` and `go.mod`. Scripts whose names start with `test:` or `lint:` are listed after the gates, with the command that runs each, and never run: a name does not say whether a script ends or changes files (`test:watch`, `lint:fix`). Add the ones that should be gates to `gates` in `.resaledger.json` by hand.

If `npx` stops with `EOVERRIDE` or another npm error about the project's own dependencies, it failed before ResaLedger started: `npx` reads the project's `package.json` first. Run it with an empty folder as its prefix, which npm reads instead, and it still works in the current folder:

<!-- not run: the same init as above, for a project whose dependencies npm cannot resolve -->

```bash
npx --prefix "$(mktemp -d)" resaledger init
```

On a terminal, `init` shows the gates that passed and asks before it writes them. Without a terminal, as when an agent runs it, it takes the defaults; `--yes` does the same on a terminal.

What it wrote:

- `.resaledger.json`, the configuration, with the gates it found. A commit gate (`npm run lint`) runs on every commit that changes code. A verify gate (`npm test`) runs when you run `verify`.
- `ledger/README.md`, the project's slow facts, with `TODO(resaledger)` markers to fill in.
- `ledger/scripts/records.mjs`, the guard. It is one file with no dependencies, and every command below runs it.
- `.githooks/`, the git hooks, turned on for this clone.
- A block in `AGENTS.md` that teaches every agent the protocol.

Fill in the README. The guard's `handoff` refuses until the markers are gone:

```bash
cat > ledger/README.md <<'EOF'
# bakery-shop

## Goal

An online shop for a small bakery: customers order bread for pickup the next morning.

## Environments

Local only.

## Manual checks

None.
EOF
```

Then commit the setup. `init` printed this command:

```bash
git add .gitattributes .resaledger.json AGENTS.md ledger/README.md ledger/scripts/records.mjs && git add --chmod=+x .githooks/commit-msg .githooks/pre-commit .githooks/pre-merge-commit .githooks/pre-push && git commit -m "chore: set up ResaLedger" -m "Task: maintenance"
```

The hooks already run on this commit: the commit gate passes, and `Task: maintenance` names it as a change with no behaviour change.

```text
✔ npm run lint (0.4 s)
```

## Start each session with `work`

```bash
node ledger/scripts/records.mjs work
```

```text
ResaLedger · lane main · solo · hooks on · not verified
Goal: An online shop for a small bakery: customers order bread for pickup the next morning.
In progress in this lane
none
```

`work` turns the git hooks on in a clone where they are off, and shows what is in progress, what waits for you and what is ready. In the solo preset, `main` is your lane.

## Plan a task and claim it

`new` creates a task file with the next free id:

```bash
node ledger/scripts/records.mjs new "Show the opening hours"
```

```text
✔ created ledger/tasks/T1-show-the-opening-hours.md
```

A task needs a plan before you can claim it. Write the goal and how you will know it is done:

```bash
cat >> ledger/tasks/T1-show-the-opening-hours.md <<'EOF'

## Plan

Show the opening hours on the front page. Done when `npm test` passes.
EOF
```

Then claim it:

```bash
node ledger/scripts/records.mjs claim T1
```

```text
✔ T1 claimed in lane main
```

The task file now says `- Status: doing` and `- Lane: main`.

## Commit with the task's id

Every commit that changes code names its task in a `Task:` line at the end of the message. Without one, the commit is refused:

<!-- exits 1 -->

```bash
echo "export const hours = '7-15'" > hours.js
git add -A
git commit -m "feat: show the opening hours"
```

```text
✖ This commit is refused
"feat: show the opening hours" changes code but names no task. Add a trailer line "Task: <id>" to the message body for the task it belongs to, or "Task: maintenance" for a change with no behaviour change
```

With the line, it goes through. The task file and the code go in together:

```bash
git commit -m "feat: show the opening hours" -m "Task: T1"
```

A commit that changes only records or Markdown needs no task.

## Verify, finish and hand off

`verify` runs every gate on the committed code and writes a stamp named after a hash of that code:

```bash
node ledger/scripts/records.mjs verify
```

```text
✔ npm run lint (0.5 s)
✔ npm test (0.3 s)
✔ all 2 gates passed: wrote ledger/verified/7e156adbc0cfba72.json. Commit it with the records.
```

Mark the task done, with evidence that someone else can rerun or open:

```bash
cat > ledger/tasks/T1-show-the-opening-hours.md <<'EOF'
# T1 Show the opening hours

- Status: done
- Lane: main
- Evidence: `npm test`: passes

## Plan

Show the opening hours on the front page. Done when `npm test` passes.
EOF
git add ledger
git commit -m "docs: finish T1" -m "Task: T1"
```

Before you stop, run `handoff`. It checks that the records are valid, the tree is clean, the gates passed on this code, and every task still in progress has a current handoff note:

```bash
node ledger/scripts/records.mjs handoff
```

```text
✔ handed off: records valid, the gates passed on this code, every task in progress has a current handoff note
```

The stamp stays valid when you commit only records, because records are not code.

## Three agents in three worktrees

Each agent gets its own lane: a branch in its own worktree. Lanes never edit the same task file, so their records merge without conflicts. The pre-commit hook refuses a commit that changes a task another worktree has claimed, even before that claim is committed. You do not switch presets for this.

Plan three tasks and commit the plans:

```bash
node ledger/scripts/records.mjs new "Add a price list"
node ledger/scripts/records.mjs new "Send an order confirmation"
node ledger/scripts/records.mjs new "Take orders for pickup"
for task in ledger/tasks/T2-*.md ledger/tasks/T3-*.md ledger/tasks/T4-*.md; do
  printf '\n## Plan\n\nDone when `npm test` passes.\n' >> "$task"
done
git add ledger
git commit -m "docs: plan T2, T3 and T4"
```

`claim --worktree` creates a branch for the task in a new worktree and claims the task there:

```bash
node ledger/scripts/records.mjs claim T2 --worktree ../bakery-shop-t2
node ledger/scripts/records.mjs claim T3 --worktree ../bakery-shop-t3
node ledger/scripts/records.mjs claim T4 --worktree ../bakery-shop-t4
```

```text
✔ T2 claimed on the new branch t2-add-a-price-list in the worktree ../bakery-shop-t2
✔ T3 claimed on the new branch t3-send-an-order-confirmation in the worktree ../bakery-shop-t3
✔ T4 claimed on the new branch t4-take-orders-for-pickup in the worktree ../bakery-shop-t4
```

`work` in the main checkout sees all three, uncommitted claims included:

```bash
node ledger/scripts/records.mjs work
```

```text
Other lanes
t2-add-a-price-list: T2
t3-send-an-order-confirmation: T3
t4-take-orders-for-pickup: T4
```

Start one agent in each worktree. Its session starts with `work`, as the block in `AGENTS.md` tells it, and it sees its own task:

<!-- not run: starts an agent -->

```bash
cd ../bakery-shop-t2 && claude
```

Each agent then works as you did above: it commits the claim and its code with `Task: T2`, verifies, finishes the task with evidence and runs `handoff`. Here is the agent in the first worktree:

```bash
cd ../bakery-shop-t2
git add ledger
git commit -m "chore: claim T2" -m "Task: T2"
echo "export const prices = { rye: 4 }" > prices.js
git add prices.js
git commit -m "feat: add a price list" -m "Task: T2"
node ledger/scripts/records.mjs verify
cat > ledger/tasks/T2-add-a-price-list.md <<'EOF'
# T2 Add a price list

- Status: done
- Lane: t2-add-a-price-list
- Evidence: `npm test`: passes

## Plan

Done when `npm test` passes.
EOF
git add ledger
git commit -m "docs: finish T2" -m "Task: T2"
node ledger/scripts/records.mjs handoff
```

```text
✔ handed off: records valid, the gates passed on this code, every task in progress has a current handoff note
```

And the agent in the second worktree:

```bash
cd ../bakery-shop-t3
git add ledger
git commit -m "chore: claim T3" -m "Task: T3"
echo "export const confirm = (order) => order.id" > confirm.js
git add confirm.js
git commit -m "feat: send an order confirmation" -m "Task: T3"
node ledger/scripts/records.mjs verify
cat > ledger/tasks/T3-send-an-order-confirmation.md <<'EOF'
# T3 Send an order confirmation

- Status: done
- Lane: t3-send-an-order-confirmation
- Evidence: `npm test`: passes

## Plan

Done when `npm test` passes.
EOF
git add ledger
git commit -m "docs: finish T3" -m "Task: T3"
node ledger/scripts/records.mjs handoff
```

Merge the finished lanes into `main` with ordinary merges. The records do not conflict, because each lane changed only its own task file and its own stamp:

```bash
cd ../bakery-shop
git merge --no-edit t2-add-a-price-list
git merge --no-edit t3-send-an-order-confirmation
node ledger/scripts/records.mjs verify
git add ledger
git commit -m "chore: stamp the merged lanes"
```

The merge changed the code, so `main` needs a new stamp. Then remove the finished worktrees and their branches:

```bash
git worktree remove ../bakery-shop-t2
git worktree remove ../bakery-shop-t3
git branch -d t2-add-a-price-list t3-send-an-order-confirmation
node ledger/scripts/records.mjs work
```

```text
Other lanes
t4-take-orders-for-pickup: T4
```

T4's lane is still open, and its agent goes on working.

## What can go wrong

A task without a plan cannot be claimed:

<!-- exits 1 -->

```bash
node ledger/scripts/records.mjs new "Bake a test loaf"
node ledger/scripts/records.mjs claim T5
```

```text
✖ T5 cannot be claimed yet: it has no plan. Nothing was changed.
```

A task another lane holds cannot be claimed. If that lane has stopped, `claim <id> --take` takes it over and records where it came from:

<!-- exits 1 -->

```bash
node ledger/scripts/records.mjs claim T4
```

```text
✖ T4 is held by another lane:
lane "t4-take-orders-for-pickup", in the worktree at …
```

`handoff` lists what is missing. Here the file of the new task T5 is not committed:

<!-- exits 1 -->

```bash
node ledger/scripts/records.mjs handoff
```

```text
✖ Not ready to hand off
the tree has 1 uncommitted path (ledger/tasks/T5-bake-a-test-loaf.md): commit them or remove them; uncommitted work is not a handoff
```

Each line it prints says what to do. Other lines you may see ask you to write the exact next step under `## Handoff` in a task file, or to run `verify` and commit the stamp.

Some refusals come from your own setup:

- `--no-verify` skips the git hooks. Do not use it. `handoff` catches unpushed commits made with it, and the agent hooks refuse it for agents ([agents](agents.md)).
- A fresh clone has the hooks off until `work` turns them on. Run `work` first.

## Git LFS

In a repository that uses Git LFS, where a tracked `.gitattributes` names `filter=lfs`, the guard's `pre-push` runs Git LFS's `pre-push` after its own checks pass, so a push uploads the LFS objects and a refused push uploads none. When Git LFS had written its hooks into `.githooks/`, `init` replaced its `pre-push` and left its other hooks alone.

In a fresh clone, `git lfs install` finds the guard's `pre-push` and stops:

<!-- not run: needs Git LFS -->

```bash
git lfs install
```

```text
Hook already exists: pre-push
…
To resolve this, either:
  1: run `git lfs update --manual` for instructions on how to merge hooks.
  2: run `git lfs update --force` to overwrite your hook.
```

This is expected, and Git LFS has set its filters all the same, so LFS files check out and commit as they should. Do not run `git lfs update --force`: it would replace the guard's hook. Git LFS's other hooks, `post-checkout`, `post-commit` and `post-merge`, are needed only for file locking. `git lfs update --manual` prints them; put those three into their files in `.githooks/` and make them executable, and leave `pre-push` as it is.

## Add CI later

A solo project can check every pull request and every push to `main` in GitHub Actions:

```bash
npx resaledger update --workflow
```

This writes `.github/workflows/resaledger.yml`. Commit it with `Task: maintenance`. [CI](ci.md) explains what it checks.
