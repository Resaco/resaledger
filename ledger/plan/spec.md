# ResaLedger 1.0 specification

Status: approved · 2026-10-15 · by Niko Alho, with the decisions in section 21

This is the design of ResaLedger 1.0, the successor of agent-ledger 0.x. Every decision carries its reason. Open questions are marked as open, and the owner's decisions are collected in [section 21](#21-the-owners-decisions). The plan and its tasks are written from this document once it is approved.

Contents: [1 Problem](#1-the-problem) · [2 Positioning](#2-positioning) · [3 Principles](#3-principles) · [4 Model](#4-the-model-on-one-page) · [5 Format](#5-format-reference) · [6 Lanes](#6-lanes) · [7 Presets](#7-branch-presets) · [8 CLI](#8-command-line) · [9 What runs where](#9-what-runs-where) · [10 CI](#10-ci) · [11 Agents](#11-agent-integrations) · [12 Trust](#12-trust-model) · [13 Install](#13-installation-and-distribution) · [14 Migration](#14-migration-from-0x) · [15 Stability](#15-format-stability-and-updates) · [16 Testing](#16-testing) · [17 Not in 1.0](#17-not-in-10) · [18 Launch](#18-launch) · [19 Risks](#19-risks) · [20 Open questions](#20-open-questions) · [21 Owner decisions](#21-the-owners-decisions) · [Sources](#appendix-landscape-sources)

## 1. The problem

Coding agents now make a large share of the commits in many repositories, and they work in parallel: one developer runs three agents in three worktrees, a team runs a dozen across branches and cloud sandboxes. Four things go wrong every day.

1. **"Done" cannot be checked.** The agent reports that the tests pass. Which tests, on which code? The claim lives in a chat that the next session never sees and nobody can rerun.
2. **The next session starts from nothing.** What is finished, what is half done and what comes next is lost unless someone wrote it down in the repository.
3. **Parallel work collides in the records.** Two agents take the same task. A shared status file or task list conflicts in every pull request. Two branches give two different tasks the same id.
4. **Rules are suggestions.** An instruction file asks the agent to run the tests and to stay off `main`. Nothing checks that it did, and `--no-verify` is one flag away.

agent-ledger 0.3 solved the first two for one developer. The task ledger, status file and session log live in the repository; git hooks refuse a code commit that names no task; a finished task needs evidence; a gate stamp binds the test pass to a hash of the code. It breaks as soon as work runs in parallel, because every record lives in a few shared files:

- `STATUS.md` is rewritten every session, so every parallel pull request conflicts there.
- The session log and the decision log grow at the end, so two branches append at the same spot.
- The gate stamp is one committed file. It always conflicts and describes only one branch.
- The ledger conflicts when two branches add tasks to the same section or pick the same id.
- The limit of three tasks in progress is per repository, so three developers share three slots.

0.3 also costs a single developer more than it should. A status file rewritten by hand every session drifts away from the truth. Recording the status, the ledger and the log after every code commit roughly doubles the number of commits. Refreshing the stamp reruns the whole suite even when the code has not changed. And nothing stops an id from being renamed, reused or deleted while commits still name it.

1.0 keeps what made 0.3 worth having and makes it hold for any number of people and agents in one repository, in one format that does not change as a project grows from one person to many.

## 2. Positioning

**One sentence.** ResaLedger is a task ledger inside your repository that coding agents can't skip, can't fake and can't collide on.

- **Can't skip.** Git hooks refuse a code commit that names no task, and the same check runs as a required status in CI, where hooks cannot be bypassed.
- **Can't fake.** A finished task needs evidence someone else can open. The tool runs the quality gates itself and binds the pass to a hash of the exact code they saw; CI runs them again.
- **Can't collide.** One file per record, one owner per task and ids that do not clash. Three agents on three branches merge with zero conflicts in the records.

**The gap.** Each piece exists somewhere. Nobody combines them.

- *Task trackers for agents* keep records and enforce nothing. beads, Backlog.md, Task Master and ccpm accept "done" from a chat and never refuse a commit. Their answers to parallel work each cost something: beads moved the records out of git branches into a database, so they are not reviewed in the pull request; Backlog.md's sequential ids collide across branches, and its maintainers declined to prevent that; Task Master keeps every task in one JSON file.
- *Done-gates for agents* enforce inside one agent session and keep no shared record. Canny, DoneGate and a fast-growing set of small projects stop an agent from finishing without a passing check, through that agent's own hooks. The record stays on one machine, and an agent without hooks is not covered.
- *spec-gates*, a spec-kit extension, has the same architecture as ours (one policy run by agent hooks, git hooks and CI) but no task per commit and no binding of a result to the code. *spec-kitty* refuses "done" without an evidence record, but the verification is self-reported text that nothing reruns.

ResaLedger is the system of record for agent work, and it enforces itself at the boundary every agent passes through: git and CI. It works the same for an agent with rich hooks, an agent with none, and a person.

**Comparison.** Facts as of 14 October 2026; sources in the [appendix](#appendix-landscape-sources).

| | ResaLedger 1.0 | beads | Backlog.md | Task Master | spec-kit | spec-kitty |
| --- | --- | --- | --- | --- | --- | --- |
| Where records live | Markdown files in the repository, reviewed in the pull request | A Dolt database synced through git refs | One Markdown file per task in the repository | One `tasks.json` | Spec, plan and task files per feature | Markdown plus a JSONL event log |
| Parallel branches | No record conflicts: one file per record, one owner per task | No conflicts, because records are outside the branches | File per task, but ids collide | One file conflicts | Feature numbers collide | Custom merge drivers, configured per clone |
| Ids | Plan ids; ids inside a task cannot clash; CI rejects duplicates | Hash ids | Sequential, collisions not prevented | Integers | Dense numbers that shift on insert | ULIDs |
| Claiming a task | Branch-based, visible when pushed; double claims reported | Atomic, in the database | An assignee field | None | None | CLI state machine |
| A code commit without a task | Refused, by hook and by CI | Allowed | Allowed | Allowed | Allowed | Allowed |
| "Done" needs evidence | Yes, checked | A free-text reason | A checklist, not enforced | No | No | Yes, self-reported |
| Tests run by the tool and bound to the code | Yes: stamp keyed by a hash of the code; CI reruns | Can wait for a CI run | No | The agent types in the results | No | No |
| Same rules locally and in CI | Yes | No | No | No | No | Partly |
| In a fresh clone or cloud agent | One dependency-free file; needs Node | Needs the `bd` binary and a pull | Plain Markdown; the CLI for the board | npx, and an LLM key for core features | Committed prompt files work alone | A Python CLI |
| Writes tasks from a spec | No | No | No | Yes | Yes | Yes |
| Board or web UI | No | No | Yes | No | No | A dashboard |

**Where others are better, honestly.**

- beads claims a task atomically, keeps a dependency graph across projects and onboards about ten agents automatically.
- Backlog.md has a terminal and web board, the largest user base of the file-based trackers, and almost no install.
- Task Master turns a requirements document into a task graph.
- spec-kit owns the spec-driven workflow, supports about forty agents and has a large extension catalogue.
- spec-kitty has a richer state machine with a separate reviewer on "done", and it groups work by file ownership so that code, not only records, avoids conflicts.
- Canny watches every tool call inside a session: secrets about to be written, tests about to be deleted.

**How it fits with them.** `AGENTS.md` says how to work in a repository; ResaLedger holds what is being done, who holds it and the proof. spec-kit writes specs and plans; a ledger task can link to a spec section and enforce the work that follows. 1.0 builds no integration, and nothing in the format prevents one.

## 3. Principles

1. **Records are files in the repository, reviewed with the code.** No database, service or daemon. A fresh clone has everything.
2. **No two lanes edit the same file in normal work.** A mutable record has one owner; every other record is added and never edited. No merge drivers: they are per-clone configuration and do nothing in a fresh clone or a cloud agent.
3. **Computed views are never committed.** In progress, blocked, ready and waiting-for-the-owner are computed from the task files when asked.
4. **The tool runs the checks; it does not take reports.** Gates are commands the tool runs, and a pass is bound to the code it saw.
5. **One implementation at every boundary.** The same code checks a commit, a push, a handoff and a pull request.
6. **The rules that judge a pull request come from the branch it merges into.**
7. **The solo path stays light.** `init` and go. Lanes, claims across machines and CI cost a solo developer nothing until used.
8. **Nothing to install in the repository's runtime.** The guard is one file with no dependencies. Node is the only requirement.

## 4. The model on one page

- A **task** is a file with a status, the lane that holds it, its dependencies, a plan, evidence and a handoff note.
- A **lane** is a branch with someone working on it: a person, an agent, a cloud sandbox. The branch name is the lane. A solo developer on `main` is one lane, three worktrees are three lanes, twelve colleagues' branches are twelve lanes, and nothing is set up for any of them.
- A **commit** that changes code names its task in a `Task:` trailer.
- A **gate** is a command the project already has: lint, tests, build. `verify` runs the gates on the committed code and writes a **stamp** named after a hash of that code.
- **Evidence** is something another person can rerun or open: a command and its result, a file, a link.
- A **decision** is a file written on the day it is made, naming who decided.
- **`work`** computes the state: what each lane holds, what waits for the owner, what is blocked, what is ready.
- **`handoff`** is the end-of-session check: the tree is clean, the gates passed on this code, and every task in progress has a current handoff note.

## 5. Format reference

### 5.1 Layout

```
.resaledger.json                         configuration
ledger/                                  the workspace ("dir"; default "ledger")
  README.md                              the project's slow facts: goal, environments, manual checks
  tasks/S4-store-documents.md            one file per task
  decisions/2026-10-14-bullet-fields.md  one file per decision
  log/2026-10-14-storage-routes.md       one file per log entry (optional)
  plan/                                  plans that tasks link to (optional)
  evidence/                              files that evidence links to (convention)
  verified/3f2a9c1e5b7d4a60.json         gate stamps, named by a hash of the code
  scripts/records.mjs                    the guard: one file, no dependencies
.githooks/                               pre-commit, pre-merge-commit, commit-msg, pre-push
.gitattributes                           one line that keeps the hooks LF on Windows
AGENTS.md                                a managed block with the protocol
.github/workflows/resaledger.yml         the CI check (team preset; offered in solo)
.claude/settings.json and others         agent hooks, for the agents that are present
```

Folders are created with their first file. A new workspace holds two files: `README.md` and `scripts/records.mjs`.

The folder is visible and named `ledger/` because the records are meant to be read in pull requests and on GitHub. `init` refuses an existing `ledger/` that it did not create and asks for `--dir`.

What 0.3 had and 1.0 drops, and why:

| 0.3 file | Why it goes |
| --- | --- |
| `STATUS.md` | Live state is computed. The slow facts move to `README.md`. |
| `work/ledger.md` | One file per task. |
| `work/log.md`, `DECISIONS.md` | One file per entry. |
| `work/verified.json` | Stamps are content-addressed ([5.7](#57-stamps)). |
| `standards.md` | The format reference ships with the package, and the guard prints templates. Manual checks move to `README.md`. |
| The workspace `AGENTS.md` | The protocol goes into the root `AGENTS.md` as a managed block, so every agent loads it at session start without following a pointer. Project rules belong in the root `AGENTS.md` anyway. |

### 5.2 Configuration

A complete solo configuration:

```json
{
  "version": 2,
  "dir": "ledger",
  "gates": {
    "commit": ["npm run lint"],
    "verify": ["npm test", "npm run build"]
  }
}
```

Every other key has a default. Keys marked † take their default from the preset ([section 7](#7-branch-presets)).

| Key | Default | Meaning |
| --- | --- | --- |
| `version` | required | The format version: 2 is 1.0. The guard refuses a version it does not know. |
| `dir` | `"ledger"` | The workspace folder: a relative path of `/`-separated names made of letters, digits, `.`, `_` and `-`, with no empty, `.` or `..` name and none that starts with `-`. The hooks and commands paste it in, so nothing in it may need quoting. |
| `preset` | `"solo"` | `solo` or `team`. |
| `base` | `"main"` | The branch work merges into. |
| `protected` † | solo `[]`, team `[base]` | Branches nobody commits or pushes to directly. |
| `requirePushed` † | solo `false`, team `true` | `handoff` wants the lane pushed. |
| `claimPush` † | solo `false`, team `true` | `claim` commits and pushes the claim. |
| `branchPattern` | `""` | An optional regular expression for lane branch names. |
| `branchPrefix` | `""` | A prefix for branches that `claim` creates, such as `feat/`. |
| `wip` | `3` | Tasks in progress per lane. |
| `commitStyle` | `"free"` | `conventional` requires Conventional Commits headers. |
| `aiAttribution` | `"allow"` | `forbid` rejects co-author and similar trailers that name a model or a vendor. |
| `codePaths` | `[]` | Folders inside the workspace whose files count as code, written by the same rule as `dir`. |
| `gates.commit` | `[]` | Fast checks. pre-commit runs them on every code commit. |
| `gates.verify` | `[]` | Slow checks. `verify` runs them after the commit gates, and so does CI. |
| `ci.runGates` | `true` | CI runs the gates. With `false`, CI only checks that the head carries a stamp for its own code. |
| `phases` | `[]` | An optional order of id prefixes, for "Ready next". |
| `agent.deny` | `[]` | Extra commands that agent hooks refuse, as `{ "pattern": "…", "reason": "…" }`. |

`records.mjs config` prints the effective configuration with every default filled in.

### 5.3 Task files

A task in progress:

```markdown
# S4 Store projects and documents on the server

- Status: doing
- Lane: s4-store-documents
- Depends on: S1, S3
- Plan: [S-server.md](../plan/S-server.md#s4-store-projects-and-documents-on-the-server)
- Evidence: —

## Handoff

Routes and storage are done and tested. Next: the list view in the app
(`app/src/projects/List.tsx`). The tree is clean. Open question: the page size.
```

The same task when it is finished:

```markdown
# S4 Store projects and documents on the server

- Status: done
- Lane: s4-store-documents
- Depends on: S1, S3
- Plan: [S-server.md](../plan/S-server.md#s4-store-projects-and-documents-on-the-server)
- Evidence:
  - `npm test -- server/storage`: 14 of 14
  - Checked by hand at 1440 and 390 px: [storage.md](../evidence/2026-10-07/storage.md)
  - Not verified: Safari

## Notes

As built: one row per revision instead of a JSON column, because revisions are listed and diffed.
```

**File name.** `tasks/<id>-<slug>.md` or `tasks/<id>.md`. The id in the file name and the id in the heading must agree. The slug only helps people browsing the folder; it may go stale after a title change and nothing breaks.

**Id.** One to four capital letters, a number, and optional `.number` parts: `S4`, `S4.1`, `API12`. An id is a name, not a position. Once it reaches the base branch it is never renumbered, renamed or reused.

**Fields** are a bullet list straight after the heading. A value is the rest of the line; `—` or nothing means empty. A field may hold a nested list instead, as Evidence usually does.

| Field | Required | Rules |
| --- | --- | --- |
| Status | always | `todo`, `doing`, `blocked`, `done` or `dropped` |
| Lane | while `doing` | The branch that holds the task. Kept after `done` as history. |
| Depends on | no | Ids that exist, comma-separated. Shown, not enforced as an order. |
| Plan | while `doing`, unless the file has a `## Plan` section with content | A link to a plan section that has content. A task cannot be `doing` while the linked plan file's status line says `proposal`. |
| Evidence | when `done` | At least one command in backticks, a link or a URL. Every link resolves. |
| Waiting for | when `blocked` | Who or what unblocks it: `owner`, a person, a task id, an outside party. |
| Reason | when `dropped` | Why: split into other tasks, superseded, not needed. |
| Issue | no | The issue the task came from, as a link or `#123`. |
| Taken over from | no | Written by `claim --take`: the previous lane and commit. |

Other fields are allowed and kept. A field name within two letters of a known one, such as `Staus`, is reported as a likely typo.

**Sections.** `## Plan` is optional: the goal and acceptance checks for a task with no separate plan. `## Handoff` is required while `doing`: the present state, rewritten each time rather than appended, at most 1,500 characters. `## Notes` holds anything else: findings, what was tried, how the result differs from the plan.

Why bullet fields and not YAML front matter: GitHub renders bullet fields as a list with working links, while it renders front matter as a table of raw text; a colon in a title breaks YAML and not a bullet; and agents write a list of `Field: value` lines reliably, which is what 0.3 already used.

Why Handoff is capped and kept apart from Notes: notes that collect dated events grow into a diary, and the diary soon contradicts itself. The handoff is the state now. The story goes to Notes or to a log entry.

Why tasks are never deleted: a deleted task leaves commits whose `Task:` trailer names nothing. To split a task, add children (`S7.1`, `S7.2`) and either keep the parent as their umbrella or set it to `dropped` with `Reason: split into S7.1–S7.5`.

### 5.4 Decisions

```markdown
# Task fields are bullets, not YAML front matter

- Date: 2026-10-14
- Decided by: Niko Alho
- Status: accepted

GitHub renders bullets with working links and front matter as a table of raw text.
A colon in a value breaks YAML. Agents already write `Field: value` lines reliably.
```

`decisions/<date>-<slug>.md`. Date and Decided by are required. Status is `accepted` (also when it is missing) or `superseded by <link>`. Weakens is optional: the changes to enforcement this decision lets through in the pull request that adds it ([section 10](#10-ci)). A decision file is added once; marking it superseded is its only later edit.

### 5.5 Log entries

```markdown
# 2026-10-14 · Storage routes, and why paging waits

- Lane: s4-store-documents
- Tasks: S4

What the task files do not say: what was tried and failed, and what was learned.
```

`log/<date>-<slug>.md`. A log entry is optional. Write one when a session has a story worth keeping that belongs neither in a task's Notes nor in a decision; `handoff` does not ask for one. 0.3 required a log entry after every code commit, which turns the log into a diary of steps that repeats the task notes.

### 5.6 Plans

Plans are free Markdown in `plan/`, written before the work they describe and edited by whoever plans. A plan file may start with a status line:

```
Status: proposal | approved | in progress | implemented · <date> · <who decided>
```

A task cannot become `doing` while the plan file it links to says `proposal`. This is new in 1.0: without the check, work starts and even finishes while its plan still says it is a proposal. Differences between the plan and the result go into the task's Notes, not back into the plan file, so lanes do not edit shared plan files.

### 5.7 Stamps

`verify` runs every gate, commit gates first, on the committed code. When all pass, it writes `verified/<first 16 hex digits of the fingerprint>.json`:

```json
{ "version": 1, "fingerprint": "3f2a9c1e5b7d4a60…", "gates": "9b1d…" }
```

- The **fingerprint** is a SHA-1 over the `git ls-files -s` entries (mode, blob id and path) of every tracked code file ([5.10](#510-what-counts-as-code)). It changes when code, the configuration, the guard or a hook changes, and not when a record changes.
- `gates` is a SHA-256 over the fingerprint and the gate commands, so `verify` can tell whether the same gates passed. `records.mjs gates` lists the commands themselves.
- The content is **deterministic**. Two lanes that verify the same code write identical files, which git merges without a conflict. Who verified and when is in git's history of the file.
- Almost every byte depends on the fingerprint. Git's rename detection pairs a deleted file with an added one when more than half of their content is the same. If two stamps shared their gate list, two lanes that each replace the same old stamp would look to git like two renames of one file, and their merge would conflict.
- `verify` is **idempotent**. If a stamp for the current fingerprint exists, it says so and runs nothing; `--force` reruns. In 0.3, refreshing the stamp reran the whole suite even when only the time changed.
- `verify` **prunes**: it deletes every other stamp, because none of them describes this code. Stamps are only ever added and deleted, and git never conflicts on adding a uniquely named file or deleting one. A branch carries a stamp or two; the base branch carries at most one per lane merged since the last prune.
- `handoff` requires a stamp for the current fingerprint whenever verify gates exist.

This resolves the tension between solo and team. A solo developer without CI gets a stamp that travels with the code, so the next session, on any machine or in a cloud sandbox, can trust that the gates passed on exactly this code. A team gets the same stamp on every lane as fast feedback, and CI reruns the gates as the shared proof. Nothing conflicts, and no stamp ever describes code it did not see.

### 5.8 The workspace README

The project's own text, which `update` never touches. Sections: `## Goal` (what is being built, for whom, what counts as finished), `## Environments` (one line each, or "Local only"), `## Manual checks` (checks that need eyes or judgement: what is compared and what passes; "None" is a valid answer) and, optionally, `## Risks`. `init` leaves `TODO(resaledger)` markers, and `handoff` fails while any remain. `work` prints the first sentence of the goal.

### 5.9 Commit messages

A commit that changes code carries a task trailer:

```
feat(server): store documents

Task: S4
```

- `Task: S4, S5`, or several `Task:` lines, name several tasks. `Task: maintenance` is for a change with no behaviour change: formatting, a dependency bump, a tooling fix.
- Each named task must be `doing` or `done` in the commit's own tree, and held by this lane or claimed in the same commit.
- A merge commit is exempt when every code path it changes against a parent was also changed on another side, between the merge base and that other parent: a clean merge or a conflict resolution. Code changed only in the merge needs its own `Task:` line.
- A commit made by `git revert` is exempt when its `This reverts commit <hash>.` line names an ancestor and its change is exactly the inverse of that commit's change, compared by patch id.
- A release commit is not exempt: one that changes code carries a `Task:` line, for example `Task: maintenance`. The message alone never exempts a commit.
- With `commitStyle: conventional` the header follows Conventional Commits. With `aiAttribution: forbid`, trailers that name a model or a vendor are rejected.

### 5.10 What counts as code

Code is every tracked file outside the workspace that is not Markdown, plus `.resaledger.json` and the git hooks (`.githooks/`). Inside the workspace, code is everything under `scripts/`; everything under a `codePaths` folder except images; and every other file with a code extension (`.js .mjs .cjs .ts .tsx .jsx .json .yml .yaml .sh .py .rb .go .rs .toml`, in any case), except a stamp (`verified/<16 hex digits>.json`) and anything under `tasks/`, `decisions/`, `log/` and `plan/`. Everything else in the workspace is a record, and Markdown elsewhere is documentation. A commit that changes only records or Markdown needs no task, and neither changes the fingerprint. Evidence is best kept as `.txt`, `.log` or Markdown: an evidence file with a code extension counts as code, so it needs a task and makes the stamp stale.

## 6. Lanes

### 6.1 A lane is a branch

A lane is a branch with someone working on it, and its identity is the branch name. There is nothing to register. Every way people and agents work in parallel already makes a distinct branch: a worktree, a colleague's clone, a cloud agent's `claude/…`, `codex/…` or `copilot/…` branch. A registry would need its own conflict-free allocation and would be one more thing to forget. A detached HEAD is not a lane, and `claim` refuses there.

### 6.2 One owner per task

A task that is `doing`, or `blocked` with a Lane, belongs to that lane, and only that lane changes its file. pre-commit refuses a change to another lane's task, and so does CI in a pull request. A held task is never deleted, not even in a merge that brings in the lane that holds it. The two exceptions are claiming a task nobody holds and taking one over with `claim --take`, which records where it came from. Tasks that are `todo` without a lane, `done` or `dropped` can be edited by anyone; such edits are rare, such as planning or fixing a link.

Every other record is added and never edited: decisions (apart from marking one superseded), log entries and stamps. Plans and the workspace README are shared, and they change outside normal work.

This is what makes the parallel-lanes acceptance test ([section 16](#16-testing)) pass by construction rather than by luck.

### 6.3 Claiming

`claim <id>`:

1. Refuses if another lane holds the task anywhere it can see: this worktree, other local worktrees, and pushed branches as last fetched. The team preset fetches first. `--take` takes the task over.
2. On a protected branch (team), it first creates the lane: a branch named `<branchPrefix><id>-<slug>` with the id in lowercase (`s4-store-documents`), or `--branch <name>`. `--worktree <path>` creates the branch in a new worktree, which is how a solo developer starts a parallel agent.
3. Sets Status to `doing` and Lane to the branch, and checks the WIP limit and that a plan exists.
4. With `claimPush` (the team default) or `--push`, commits the claim on its own (`chore: claim S4` with `Task: S4`) and pushes the branch, so others see it at once. Opening a draft pull request is the team's choice.

Without a push, the claim is visible to local worktrees at once and to everyone else when the branch is pushed. A claim is never a commit to the base branch: that would need an unprotected base and would cause constant rebases.

Detection, not locks: an atomic lock needs a shared server (beads uses a database; a proposal for Backlog.md uses custom git refs updated with compare-and-swap pushes). Either is one more moving part, and cloud agents may not be allowed to use it. Double claims are rare when the claim is pushed at once, they are visible after one fetch, and CI reports a task held in two open branches. If that proves too weak in practice, ref-based locks can come later without a format change ([section 17](#17-not-in-10)).

### 6.4 Seeing other lanes

`work` shows this lane and the other local worktrees, read from disk, so an uncommitted claim shows too. `work --all` adds pushed branches that are not merged into the base, newest first, as last fetched; `--fetch` fetches first. Only task files that differ from the base are read, in one batched git call, so hundreds of branches stay fast. Backlog.md users report 15–60 seconds at 500 branches; 1.0 has a performance test at 500.

For each lane, `work --all` shows the tasks it holds, the commits ahead of the base, whether it is pushed, the last commit's author and date, and whether its head is verified. It warns about a task held by two lanes, and about a task held by a lane whose branch is merged or gone: a stale claim, to be taken over.

### 6.5 Handing over

- **On the same branch.** The next person or agent checks out the branch, reads the Handoff and continues. The lane stays the same, so no file changes owner. This is the normal case, also when a cloud agent continues a local session.
- **On a new branch.** `claim <id> --take` on a branch that starts from the old one records `Taken over from: <old lane> at <commit>`. The old lane must not change that task again, and CI refuses it if it does. A handed-over commit is frozen: follow-ups are plain commits on top, never a rebase.

### 6.6 Work in progress

At most `wip` tasks (default 3) are `doing` per lane, not per repository. Three developers get three lanes of three.

### 6.7 Ids

- **Planned tasks** get their ids when the plan is written: `S1` to `S9`.
- **Work found inside a task** gets a child id: `new --under S4 "Fix the flaky upload test"` creates `S4.1`. Only the lane that holds S4 creates its children, so these ids cannot collide.
- **Other new tasks** (`new S "…"`) take the next number after the highest visible in this worktree, the other local worktrees and the fetched branches.
- **CI rejects an id that also exists, as a different task, on the base branch or in another open branch.** Such an id is new in the pull request, so renaming it there is safe: earlier commits on the branch are checked against their own tree, where the old id was valid.
- A team that wants issue numbers in ids can use them (`I123`); the format allows any prefix.

Why not random ids, as beads and spec-kitty use: they never collide, but people say "S4" in conversation and in commit messages. The rules above remove the collisions that actually happen, concurrent ad hoc tasks, without giving that up. Why not Backlog.md's rule alone: it takes the highest visible id plus one and has had collisions in production. 1.0 adds child ids and a check before merge.

### 6.8 When a lane ends

When the branch merges, its tasks are `done`, or still `doing` if the lane delivered part of the work; `work` then reports a stale claim for someone to take over. When the branch is deleted unmerged, its claims disappear with it and the tasks are free again.

### 6.9 A coordinator, if you want one

A person or agent who plans (writes plans and task files in planning pull requests), watches `work --all --fetch`, reviews pull requests with the CI comment that lists what each one moves, and merges. A coordinator needs no special files or permissions in ResaLedger. A team that wants one role to own merges and deploys sets that up in its host, with branch protection and CODEOWNERS.

### 6.10 Why lanes have no status files

The starting hypothesis gave each lane its own status file. Measured against the evidence, it would hold nothing that the task files and git do not already hold. What a lane holds and its next step are its task files' Status and Handoff; ahead, behind, pushed and verified are computed from git. A file per branch would also pile up on the base branch after every merge. Per-entry log files cover a lane's own notes without a mutable file per lane.

## 7. Branch presets

| | solo | team |
| --- | --- | --- |
| Commits on the base branch | allowed | refused by pre-commit, pre-merge-commit and agent hooks |
| Pushes to the base branch | allowed | refused by pre-push and agent hooks |
| `claim` on the base branch | claims in place | creates a lane branch first |
| `claim` pushes | no | yes |
| `handoff` wants the lane pushed | no | yes |
| CI workflow | offered | installed |
| How lanes merge | ordinary merges, locally or by pull request | pull requests |

A fast-forward merge makes no commit, so no commit hook sees it; pre-push and the agent hooks refuse it when it reaches the remote base.

Switching is one line in the configuration, and the format does not change. A solo developer who starts parallel agents does not need to switch: lanes are branches in both presets.

Neither preset uses cherry-picks or long-lived personal branches. Lanes are short-lived and merge normally. Copying the same change into two long-lived branches, by cherry-pick or by a second pull request from the feature branch, makes twin commits, and the two branches never converge again.

A team that promotes an integration branch to production as a whole sets `base` to that branch (for example `staging`) and protects both.

## 8. Command line

The guard in the repository runs as `node ledger/scripts/records.mjs <command>`; `npx resaledger <command>` runs the same file.

| Command | What it does |
| --- | --- |
| `work [--all] [--fetch] [--json]` | The state ([6.4](#64-seeing-other-lanes)). Turns on the git hooks in a clone where they are off. |
| `task <id>` | One task with its plan section, so nobody reads every task file. |
| `new [<prefix>] "<title>" [--under <id>] [--issue <n>]` | A task file with a safe id ([6.7](#67-ids)). |
| `new decision "<title>"` | A decision file with today's date. |
| `new log "<title>"` | A log entry. |
| `claim <id> [--take] [--branch <name>] [--worktree <path>] [--push]` | Take a task ([6.3](#63-claiming)). |
| `verify [--force]` | Run the gates on the committed code and write the stamp. |
| `handoff` | The end-of-session check. |
| `check [--range <from>..<to>]` | Validate the records, and the commits in a range. |
| `ci [--base <ref> --head <ref>]` | The CI check ([section 10](#10-ci)). |
| `changes [--since <ref>] [--json]` | The tasks finished since a tag, as a draft for the changelog and the release notes. Read-only. |
| `gates`, `config`, `version` | The gates, the effective configuration, the version. |
| `pre-commit`, `pre-merge-commit`, `commit-msg <file>`, `pre-push`, `hook <agent> <event>` | Called by git and by agent hooks. |

The package adds `init`, `update` and `migrate` ([sections 13–15](#13-installation-and-distribution)) and passes every other command to the repository's own guard, so the committed version always decides.

`handoff` checks that the records are valid, the workspace README is written, the hooks are active and the tree is clean; that a stamp exists for the current code when verify gates exist; that every `doing` task in this lane has a Handoff changed in or after the last commit that names the task; that the lane's unpushed commits pass the trailer check, which catches a commit made with `--no-verify`; and, with `requirePushed`, that the lane is pushed. It no longer asks for a status file, a log entry and a ledger edit after every code commit. One record checkpoint per task replaces three per commit.

`changes` lists the tasks that became `done` between a reference (by default the newest tag) and now, with their evidence. When the commits that name a task follow Conventional Commits, it groups the tasks as Keep a Changelog does: Added for `feat`, Fixed for `fix`, Changed for the rest. It never writes a file. A changelog is edited text, and the command gives its editor a complete, linked draft.

## 9. What runs where

| Check | pre-commit, pre-merge-commit | commit-msg | pre-push | handoff | CI, pull request | CI, push to base |
| --- | --- | --- | --- | --- | --- | --- |
| Records are valid | ✓ | | | ✓ | ✓ | ✓ |
| No change to another lane's task, no held task deleted | ✓ | | | | ✓ | |
| No commit or push on a protected branch; branch name | ✓ | | ✓ | | | |
| A code commit names a task held by its lane | | ✓ | ✓ range | ✓ range | ✓ range | ✓ new commits |
| Commit gates pass | ✓ on code commits | | | | ✓ | |
| Verify gates passed on this exact code | | | | ✓ stamp | ✓ rerun, or stamp | ✓ rerun, optional |
| A finished task has evidence | ✓ | | | ✓ | ✓ | ✓ |
| Ids are unique across the base and open branches | ✓ locally visible | | | | ✓ | |
| Enforcement is not weakened | | | | | ✓ | |
| Tree clean, handoff notes current, lane pushed (team) | | | | ✓ | | |

One implementation serves every column. A hook calls the same functions as `ci`.

## 10. CI

- One workflow, `.github/workflows/resaledger.yml`, runs `ci` on pull requests and on pushes to the base branch. `ci` reads the event to find the base and the head. Other CI systems call `ci --base <ref> --head <ref>`.
- **The rules come from the base.** The workflow takes the guard and the configuration from the base commit and judges the head with them, so a pull request cannot weaken the check that judges it. The first pull request that adds ResaLedger is judged by its own rules, and the comment says so.
- **On a pull request**, `ci` checks the records in the head; every commit from the merge base to the head, each against its own tree; task ownership and deleted tasks against the base; ids against the base and the other open branches; evidence on every task that becomes `done`; the gates, run on the head with the base's commands (with `ci.runGates: false`, the head must carry a stamp for its own code instead); and changes to enforcement.
- **Changes to enforcement** are any diff to the configuration, the guard, the hooks or the workflow, and they are listed. A weakening change fails the check unless the pull request adds a decision file that names it, so reviewers see who decided: a gate removed or changed, a protected branch removed, `wip` raised, `aiAttribution` loosened, a deny rule removed. Updating the guard to a released version is listed and does not fail. The rules:
  - **What is compared.** The configuration, `<dir>/scripts/records.mjs`, every file in `.githooks/` and `.github/workflows/resaledger.yml`, from the merge base to the head: the pull request's own changes, not the base's later ones. When the merge base has no configuration, the base stands in for it. When the base has none, the pull request adds ResaLedger, there is nothing to compare against, and the output says so. The agents' hook configurations are not compared: they share files with the project's own settings, and what they block, CI checks again.
  - **Each change has an id**, printed in the output, and is listed or weakening by the table below. A direction that is unclear counts as weakening; a decision lets it through.
  - **A decision names a change** with a `Weakens:` field that lists ids, separated by commas: `- Weakens: wip, gates.verify`. Only a decision the pull request adds counts (a file in `<dir>/decisions/` that the merge base does not have), so an old decision never lets a new change through. Its `Decided by` is printed next to the change.
  - **The released versions** are the hashes of `templates/released.json`, which the bundle embeds, plus the running guard's own. A guard or hook whose new text is a released version is listed; any other new text, and a removed file, weakens. A guard newer than the one that runs is not in its table, so that update needs a decision unless the workflow runs a guard at least as new.

  | Id | Weakening | Listed |
  | --- | --- | --- |
  | `config` | `.resaledger.json` removed, or invalid in the head | |
  | `dir` | any change | |
  | `base` | any change | |
  | `preset` | | any change; what it sets is compared key by key |
  | `protected` | a branch removed | a branch added |
  | `requirePushed`, `claimPush`, `ci.runGates` | turned off | turned on |
  | `branchPattern` | removed or changed | added where there was none |
  | `branchPrefix` | | any change |
  | `wip` | raised | lowered |
  | `commitStyle` | `conventional` to `free` | `free` to `conventional` |
  | `aiAttribution` | `forbid` to `allow` | `allow` to `forbid` |
  | `codePaths` | a folder removed | a folder added |
  | `gates.commit`, `gates.verify` | a command removed or changed | a command added; a new order |
  | `phases` | | any change |
  | `agent.deny` | a pattern removed or changed | a pattern added; a reason changed |
  | `guard` | removed, or new text that is no released version | new text that is a released version |
  | `hooks/<name>`, such as `hooks/pre-commit` | removed, or new text that is no released version | new text that is a released version |
  | `workflow` | removed, or new text that is no released version | new text that is a released version |
- **On a push to the base**, `ci` checks the records and the new commits, except merge commits and commits that GitHub made when merging a pull request, which were checked in the pull request. Squash merges therefore work: enforcement checks the pull request and its commits, not the base branch's history after a squash. A team that wants `Task:` lines on the base can set GitHub's squash message to the pull request description; the pull request template has a `Task:` line.
- **Output.** A job summary always. With write permission, which pull requests from the same repository have, one comment on the pull request, updated in place:

  ```
  ResaLedger · this pull request
  S4  Store projects and documents   doing → done
      Evidence: `npm test -- server/storage`: 14 of 14 · storage.md
  S4.1 Fix the flaky upload test     new, todo
  Commits: 6 checked, all name a task
  Gates: npm run lint ✓ 4 s · npm test ✓ 41 s · npm run build ✓ 18 s (rules from main)
  Enforcement: unchanged
  ```

- The team guide shows how to make `resaledger` a required status check and how to protect the enforcement files with CODEOWNERS.

## 11. Agent integrations

Three layers, from what every agent has to what only some have.

**1. `AGENTS.md`, for every agent.** `init` adds a managed block to the root `AGENTS.md`, creating the file if needed. The block holds the protocol in a few lines: run `work` first; claim a task; commit each working step with its `Task:` trailer, and do commit, because some agents' default prompts say not to unless asked; never use `--no-verify`; run `verify`; write Status, Evidence or Handoff; run `handoff` before stopping. If `CLAUDE.md` exists, `init` adds an `@AGENTS.md` import to it, because Claude Code reads `AGENTS.md` only when there is no `CLAUDE.md`. When Gemini CLI is present, `.gemini/settings.json` points `context.fileName` at `AGENTS.md`.

**2. Git hooks and CI, for every agent and person.** These are the enforcement, so an agent without hooks is still covered. In a fresh clone, `work`, the first step in `AGENTS.md`, turns the git hooks on. The GitHub Copilot cloud agent does not run git through the shell itself, and whether its commits run git hooks is not confirmed ([open question 1](#20-open-questions)), so CI is its gate.

**3. Agent hooks, for agents that have them.** One command, `records.mjs hook <agent> <event>`, serves five agents through thin committed configurations. Every one of them blocks a tool call when the hook exits with code 2 and gives the reason on stderr (Copilot blocks on any non-zero exit), so the logic is shared and each adapter only reads that agent's input.

| Agent | Configuration | Session start | Before a tool | End of turn |
| --- | --- | --- | --- | --- |
| Claude Code | `.claude/settings.json` | `SessionStart` | `PreToolUse` (Bash, Edit, Write, MultiEdit, NotebookEdit) | `Stop` |
| Codex | `.codex/hooks.json` | `SessionStart` | `PreToolUse` (Bash, apply_patch) | `Stop` |
| Cursor | `.cursor/hooks.json` | `sessionStart`; in cloud agents the first `beforeShellExecution` | `beforeShellExecution`, `preToolUse` | `stop` with `loop_limit: 1` |
| Gemini CLI | `.gemini/settings.json` | `SessionStart` | `BeforeTool` (shell, write, replace) | `AfterAgent` |
| GitHub Copilot, cloud agent and CLI | `.github/hooks/resaledger.json` | `sessionStart` | `preToolUse` | `agentStop` |

- **Session start** turns on the git hooks in the clone and gives the agent the output of `work`.
- **Before a tool** refuses `--no-verify`, a change to `core.hooksPath`, a forced push, a push to a protected branch, the project's `agent.deny` commands, and file edits on a protected branch. Cursor has no hook before a file edit, so there the shell check catches the redirections it can see.
- **End of turn** reminds once per session, and only if the session changed the repository and `handoff` fails: finish the work, or tell the user exactly what is left.

Rules taken from how the five agents behave today. Hooks stay fast, because the Copilot hook lets a tool run when it times out and a Cursor hook lets it run when it crashes unless `failClosed` is set. The command line in each configuration never changes between versions, because Codex asks the user to trust each hook entry again when its command changes; new behaviour arrives in the script. The guard finds the repository root itself, because Codex runs hooks in the session's directory. A reminder fires at most once even when two configurations call it, because the Copilot CLI also reads `.claude/settings.json`, and Gemini's `AfterAgent` runs after every turn. Input an adapter does not recognise is allowed, never blocked; git hooks and CI still hold.

`init` writes hook configurations only for the agents it finds (their folder or instruction file exists) or that `--agents` names. Claude Code, Codex, Gemini CLI and the Copilot CLI ask the user to trust a project's hooks; the Copilot cloud agent and Cursor's cloud agents run committed hooks without asking.

**Skill and plugin.** The package ships one skill: setting up a workspace from a real repository (the README from what is true, the gates from the commands that exist, work already done recorded with its evidence) and keeping records the next agent can use. The repository doubles as a plugin marketplace in the Claude Code format (`.claude-plugin/marketplace.json`), which Claude Code, Codex and the Copilot CLI install from. The same `SKILL.md` works for agents that read `.agents/skills/`.

## 12. Trust model

| Layer | Stops | Does not stop |
| --- | --- | --- |
| Git hooks | forgetting, habit, an agent that does not know the rules | `--no-verify`, a changed hooks path, a clone where they are off |
| Agent hooks | an agent reaching for `--no-verify`, a forced push or a push to the base | agents without hooks; a determined workaround |
| `handoff` | bypassed commits that are not pushed yet | anything already pushed |
| CI with the base's rules | everything above, for everything that reaches a pull request | an administrator; a workflow file changed in the same pull request, unless CODEOWNERS protects it |
| The host: branch protection, the required check, CODEOWNERS on enforcement files | merging without the check, or enforcement changes without review | nothing in this list |

- **A stamp is a claim.** Anyone can write one by hand. CI reruns the gates by default, so a forged stamp never gets through CI. For a solo developer without CI, the stamp guards against forgetting, not against the developer.
- **A pull request can change the gates, the guard or the workflow.** CI judges it with the base's rules, lists every enforcement change and fails a weakening one unless a decision file names it ([section 10](#10-ci)). The workflow file itself is beyond any check's reach, because a pull request's own workflow is the one that runs: a change to it that is no released template needs a decision, which makes an honest change visible, but a pull request that removes the check never runs it. The team guide protects the file with CODEOWNERS.
- **Gates run the pull request's code.** They run under `pull_request`, with no secrets and a read-only token for forks, never under `pull_request_target`.
- **The guard runs only commands from a configuration it trusts.** The rules (the base, the protected branches, the branch pattern and the gates) come from a committed configuration the change cannot alter: HEAD's in pre-commit, pre-merge-commit and commit-msg, the remote base's as last fetched (else HEAD's) in pre-push, and the base branch's in CI. Staging `"protected": []` does not unprotect the commit that stages it.

## 13. Installation and distribution

`npx resaledger init` in a repository:

1. Requires a git repository. It refuses only when a file it must change, such as `AGENTS.md`, has uncommitted changes, so nothing it writes mixes with work in progress.
2. **Finds the gates.** `package.json` scripts (lint, typecheck, test, build, with the package manager taken from the lockfile), `Makefile` targets, `pyproject.toml` (ruff, mypy, pytest, under `uv run` when there is a `uv.lock`), `Cargo.toml` (fmt, clippy, test) and `go.mod` (vet, test). Fast checks go to `commit` and slow ones to `verify`. It runs each one and keeps only those that pass; a failing check is reported, never added in a weaker form. `--no-run` skips the runs.
3. **Finds the rest.** The agents in use, the commit style (Conventional Commits when most of the last 50 commits follow it or a commitlint configuration exists) and hook managers (husky, lefthook, pre-commit, simple-git-hooks). With a hook manager present, it adds the guard's calls there instead of setting `core.hooksPath`.
4. **Asks only what it cannot infer**: solo or team (default solo, `--team`) and the goal in one sentence, or it leaves a marker. `--yes` takes the defaults, for agents running `init`.
5. Writes the files ([5.1](#51-layout)), runs `check`, and prints what it did and the first command to run. With the hooks in `.githooks/`, the root `.gitattributes` gets `.githooks/* text eol=lf`, so that Git for Windows does not check the hooks out with CRLF; the file's other lines stay, and an equivalent rule (such as `* text=auto eol=lf`) is enough. `update` adds the line to an install that lacks it.
6. Prints the commit of the setup as commands to copy. When the current branch is protected, as the base is in the team preset, the hooks it has just installed refuse that commit, so the commands first create the branch `resaledger-setup`, commit there and push it, and the next step is a pull request into the protected branch. That first pull request is judged by its own rules ([section 10](#10-ci)).

`--dir` is refused before anything is written unless it follows the rule for `dir` ([5.2](#52-configuration)).

Distribution:

- The npm package `resaledger`, with no dependencies, for Node 20 or newer; Bun works too. Node 20 reached end of life in April 2026; it stays supported because it costs nothing and many environments lag.
- The plugin marketplace in the repository (section 11).
- Nothing else in 1.0.

## 14. Migration from 0.x

`npx resaledger migrate` converts an agent-ledger 0.1, 0.2 or 0.3 workspace in place.

| 0.x | 1.0 |
| --- | --- |
| `work/ledger.md`, one `### <id> <title>` per task | `tasks/<id>-<slug>.md` with the same fields. A `doing` task gets Lane (an existing `Lane:` field wins, else the current branch), and its Notes become its Handoff. Other fields are kept as they are. A `blocked` task gets Waiting for from the first "Waits for …" or "Blocked on …" phrase in its Notes, and `migrate` lists each one; with no such phrase, it is a 1.0 problem to fix. Lines under a task that are not its fields go, word for word, into its `## Notes`. |
| The ledger's preamble and its `## <phase>` headings | Their text is kept word for word in the migration's log entry. |
| `work/log.md`, one `## <date> · <title>` per entry | `log/<date>-<slug>.md` |
| `DECISIONS.md`, one table row per decision | `decisions/<date>-<slug>.md`, with Decided by from the third column. Text before or after the table goes to the migration's log entry. |
| `STATUS.md` | Phase and Waiting for the owner go to the README under `## At migration`. The whole file is kept word for word in the migration's log entry. |
| Workspace `README.md` | Stays; What is being built becomes Goal. Its other sections stay as they are. |
| `standards.md` | Its manual gates move to the README's Manual checks, and any section that the 0.x template did not have moves to the README under its own heading. The template's own sections are kept in the migration's log entry; the file is removed. |
| Workspace `AGENTS.md` | Its Project rules, and any section the 0.x template did not have, move into the root `AGENTS.md`, above the managed block. The template's own sections are kept in the migration's log entry; the file is removed. |
| `work/verified.json` | Removed. Run `verify`. |
| `progress/` | Stays where it is, so links keep working. |
| `plan/` | Unchanged. |
| The `.gitattributes` union rules | Removed. The file gets `.githooks/* text eol=lf`, as `init` writes it. |
| `.agent-ledger.json` version 1 | `.resaledger.json` version 2. Gates, codePaths, aiAttribution, commitStyle and deny rules are kept; `branches.protected` becomes `protected`, `branches.pattern` becomes `branchPattern`, and `requirePushed` stays; the preset is solo. A key with no 1.0 meaning (such as `gates.skipPaths`) is reported and written into the migration's log entry. |
| Guard, hooks, pointer blocks, Claude Code hook entries | Replaced by 1.0's. |
| `mode: guard` | Refused, with an explanation: guard-only mode is not in 1.0 ([section 17](#17-not-in-10)). |

**Links.** `work/ledger.md` and `tasks/` are both one folder deep, so plan and evidence links keep their paths. Links into the ledger (`work/ledger.md#s4-…`), into the log (`work/log.md#2026-…`) and into `DECISIONS.md` are rewritten to the new files. Anything it cannot rewrite is listed.

**Everything else in the workspace folder**, such as other Markdown files, design folders and images, stays where it is, untouched.

**Safety on a repository it has never seen.**

1. Refuses a dirty tree, an unknown version, a missing file, or a managed file changed by hand, and shows the difference.
2. Parses everything and builds the new files in memory first.
3. Validates the result with the 1.0 rules, and checks that every non-empty line of the old records appears in the new files, allowing for the known reshaping. Any loss stops it.
4. Shows what it will do (`--dry-run` stops here), writes the files and runs `check`.
5. Never commits. It prints the commit to make, on the branch `resaledger-setup` when the current branch is protected, as `init` does; `git restore .` undoes everything.
6. Warns when it sees branches with record changes that are not merged: migrate when no lane is open.

A 0.x `dir` that breaks the 1.0 rule for `dir` ([5.2](#52-configuration)) is refused: rename the folder first.

It is to be tested on synthetic workspaces that cover every quirk of the real ones, and on copies of real 0.3 workspaces made in a temporary directory and never committed.

## 15. Format stability and updates

- The configuration's `version` is the format version: 1 for 0.x, 2 for 1.0. The guard refuses a newer version and prints the command that updates it.
- Within 1.x, changes are additive only: new optional fields, new commands. A 1.x guard reads the records of any 1.y workspace and keeps fields it does not know.
- Managed files are the guard, the git hooks, the `AGENTS.md` block and the agent hook configurations. Each release records a hash of every managed file it ships (`templates/released.json`), with the workspace folder written as a placeholder so that one hash serves every `dir`. `update` replaces a managed file only when its content matches a released version; a file changed by hand is shown and left alone unless `--force` is given. The guard also carries its version line, so an older package refuses to replace a newer guard. Hooks and the block carry no version line, so a release rewrites only the files that changed. 0.3's `update` overwrites a hand-edited hook without a word as long as the hook still carries its marker.
- `update` also adds the `.githooks/* text eol=lf` line to `.gitattributes` when it is missing and no hook manager is in use, and keeps every other line.
- `update` never touches the README, the records or the project's own part of `AGENTS.md`.
- A breaking change needs a new format version, a `migrate` step and a major release.

## 16. Testing

- **The style of 0.3 stays:** every test builds a real git repository with `init` and commits through the installed hooks.
- **The acceptance test.** Three lanes on three branches in three worktrees, from one base. Each claims a task, adds a child task, commits code with trailers, verifies, writes a decision and a log entry, finishes its task with evidence and hands off. All three merge into the base, with merge commits in every order and once with squash merges, with zero conflicts in any record. Afterwards, `work` on the base shows all three tasks done and no stale claims, and `check` passes. A fourth lane that edits another lane's task is refused, locally and by `ci`.
- **CI tests** simulate a pull request event for each rule, including a weakening change with and without a decision, a squash merge, and a pull request that updates the guard.
- **Agent hook tests** use recorded input for each of the five agents and each event, from their documentation. Unknown input is allowed.
- **Migration tests** run on synthetic 0.x workspaces that cover every quirk seen in real ones, and on copies of real workspaces in a temporary directory; those tests are skipped where the copies are absent and never committed.
- **Performance:** `work --all` with 500 pushed branches, within a time budget.
- **`changes`** on a history with tags, Conventional and free-form commits, and a task that was finished, reopened and finished again.
- **Windows:** CRLF checkouts, paths and hooks under Git for Windows.
- **Matrix:** Node 20, 22 and 24 on Linux, macOS and Windows.
- **Hygiene:** a test scans every tracked text file for home-directory paths and for the names in a private deny-list read from a file that is never tracked. The history is scanned the same way before anything is pushed.
- **A second, independent reviewer model** reviews the guard, the CI check and `migrate`, where a bug would break other people's repositories.

## 17. Not in 1.0

Cut from 1.0 does not mean never. The last column says which cuts are worth building after 1.0, once real use shows the need.

| Cut | Why | After 1.0 |
| --- | --- | --- |
| Guard-only mode, 0.3's `mode: guard` | A policy guard without records is a crowded category ([section 2](#2-positioning)) and not what this tool is for. Everything it did (protected branches, gates on commit, agent deny rules) stays available inside the ledger, and a switch can return in 1.x without a format change. | Only if users ask for it. |
| A view across repositories | It needs a machine-local list of repositories. `work --json` in each lets a short script aggregate them; build it when someone asks. | Yes, a strong candidate: small, built on `work --json`. |
| Syncing GitHub issues and Projects | That would be a worse issue tracker. Tasks link to their issue, and the CI comment links back. People bring work in through issues; the ledger holds the agents' state. | Partly: importing an issue as a task is worth it; two-way sync is not. |
| Atomic claim locks | They need a shared server or custom refs that cloud agents may not be allowed to push. Detection and CI are enough until shown otherwise. | Yes, if double claims show up in real teams. |
| A board or a web UI | The audience lives in terminals and pull requests. `work` and the CI comment are the views. | Maybe a read-only page generated from the records. |
| An MCP server | Agents run shell commands. A CLI needs no extra process and no extra trust step. | Maybe, if agents without a shell matter. |
| Writing tasks from a requirements document | The agent already does this well. The format and the enforcement are what this tool owns. | No: the agent does it, and the skill can guide it. |
| Merge drivers and union merges | They are per-clone configuration, and they merged wrongly without a warning in another tool. | No. |
| Status files per lane, a required session log, a review status | Computed, or covered by git and by pull request reviews ([6.10](#610-why-lanes-have-no-status-files), [5.5](#55-log-entries)). | No. |
| Validating project-defined fields, priorities, estimates | Unknown fields are kept. Validate them when a real need appears. | Field validation, if projects ask. |
| Installers other than npm and the plugin marketplace | Node is required anyway. | If a real platform needs one. |
| Personal settings | Each person's agent instructions already set how their agent talks and works; the repository's configuration holds the shared rules, and enforcement must not differ between clones. A few behaviours of ResaLedger itself, such as the end-of-turn reminder, could be personal, in `git config resaledger.<key>`, which is never committed. Which ones needs thought. | Yes, in 1.1, once it is clear what they adjust. |

## 18. Launch

1. Tag `1.0.0-rc.1` locally when every acceptance check passes.
2. The owner creates the public repository `Resaco/resaledger`, pushes, publishes to npm with provenance and announces the marketplace. Agents prepare these steps and never run them.
3. The README's first screen states the pain and the fix in plain words, then comes a 30-second quickstart, a terminal demo recorded for real, the comparison table and an FAQ: why not issues, Task Master, beads or a done-gate.
4. Launch drafts in the owner's voice: Show HN, two subreddits and a thread on X, each built on one concrete failure from real use.
5. A few good first issues are ready at launch: an agent adapter, a gate detector, a documentation gap.
6. For the first two weeks, issues get an answer within a day, and first-run problems are fixed first. A broken first run is the most common complaint in every comparable project.

## 19. Risks

| Risk | Answer |
| --- | --- |
| A big tracker adds a task trailer rule and a code-bound stamp | Ship soon. The conflict-free lane format and the base-rules CI check are the parts that take real thought to copy. |
| Agent hook formats change month to month | Agent hooks are the optional layer, and the core is `AGENTS.md`, git and CI. Adapters are small, tested against recorded input, and allow what they do not recognise. |
| Enforcement feels heavy and people turn it off | The solo preset asks for nothing that 0.3 did not; errors say exactly what to write; `Task: maintenance` exists for the honest exceptions. |
| Windows breaks hooks, paths or line endings | The full matrix runs from the first build task. |
| `migrate` damages a repository it has never seen | It validates in memory, refuses on any loss, never commits, and is reviewed by a second model. |
| A determined person bypasses everything | Stated plainly in the trust model; host settings are the only answer, and the team guide sets them up. |
| The name gets lost among other "ledger" projects | The word is common, but `resaledger` is free on npm and unused on GitHub, and the identity follows the Resa product family. |

## 20. Open questions

These are open, and the build goes ahead without waiting for them:

1. Do the GitHub Copilot cloud agent's commits run git hooks at all, and does a `git config` in its setup steps reach the agent's clone? CI is its gate either way.
2. Does Codex cloud run a project's hooks? Does Cursor ask the user to trust project hooks?
3. Is detection enough for double claims, or do busy teams need ref-based locks? This needs real use to answer.
4. How does `work --all` behave beyond 1,000 branches? The performance test covers 500.
5. Will teams accept a weakening change only through a decision file, or do they want a label or an approval instead? Start with the decision file, which keeps the record in the repository.

## 21. The owner's decisions

1. **The name.** Decided on 15 October 2026: ResaLedger. The npm package and the command are `resaledger`, the repository is `Resaco/resaledger` and the configuration file is `.resaledger.json`; the workspace folder stays `ledger/`. The visual identity follows the Resa product family.
2. **The licence.** Decided on 15 October 2026: MIT, copyright Resaco Oy.
3. **The commit identity.** Decided on 15 October 2026: `Niko Alho` with the work account's GitHub no-reply address, set in the repository's own git configuration, and no co-author line naming an AI.
4. **Guard-only mode is cut** ([section 17](#17-not-in-10)). Decided on 15 October 2026. Repositories that use it stay on 0.x.
5. **`changes` is in 1.0** ([section 8](#8-command-line)). Decided on 15 October 2026.
6. **The predecessor's name may show.** This repository's history starts as an agent-ledger 0.3 workspace, and `migrate` reads 0.x files by their names. Accepted on 15 October 2026.


## Appendix: Landscape sources

Read on 14 October 2026 from each project's README, documentation, source and issues.

- **beads** (gastownhall/beads, about 28k stars, created October 2025). Records in Dolt under `refs/dolt/data`, hash ids, atomic `--claim` with leases. Git hooks never block. Closing an issue takes a free-text reason. Complaints centre on the move to Dolt (lost or broken sync, #2573, #4259) and installation; agents ignoring it for their own to-do lists (#429).
- **Backlog.md** (MrLesk/Backlog.md, about 7k stars, June 2025). One Markdown file per task, sequential ids from the highest visible across branches. Collisions reported in production (#711, closed as not planned), ids reused after archiving (#997), slow branch scans (#183), a proposal for claims through custom refs (#937, #1063). Definition of done is an unenforced checklist (#914).
- **Task Master** (eyaltoledano/claude-task-master, about 28k stars, March 2025). All tasks in one `tasks.json`; its documentation resolves merge conflicts by renumbering; completion proof through tests requested since early 2025 (#188); team use pointed at a commercial product (#91, #756); file corruption (#1708, #1683).
- **spec-kit** (github/spec-kit, about 141k stars, August 2025). Advisory slash commands and templates; feature numbers collide across branches (#1066, #4418); dense task ids renumber on insert (#4065); keeping specs current after implementation is the top request (#1191).
- **spec-kitty** (spec-kitty/spec-kitty, about 1.7k stars, October 2025). A state machine that refuses `done` without an evidence payload, self-reported and never rerun; an event log with custom merge drivers that merged wrongly (#4880, #4990) and status files leaking onto lane branches (#5151, #2017).
- **ccpm** (automazeio/ccpm, about 8k stars, August 2025). GitHub Issues as the store; no enforcement; an installer incident (#1016).
- **agents.md** (agentsmd/agents.md, about 25k stars, August 2025). A free-form instruction file, now under a foundation; nearest file wins; proposals for structure and enforcement remain open (#9, #91, #105, #228).
- **Continuous-Claude-v3** (parcadei/Continuous-Claude-v3, about 4k stars, December 2025). Session continuity for Claude Code through hooks, handoff snapshots and a local database; its "ledger" is a within-session checklist.
- **spec-gates** (schwichtgit/spec-gates, created July 2026). One policy run by Claude Code hooks, git hooks and CI, with parity tests; no task per commit, no binding of a result to the code.
- **Canny** (qkal/Canny, about 120 stars, September 2026). Session supervision through Claude Code and Codex hooks; refuses "done" when no check passed after the last edit; its record lives on the user's machine.
- **git-test** (mhagger/git-test). Test results keyed by tree and stored in git notes: prior art for binding a result to the code.
