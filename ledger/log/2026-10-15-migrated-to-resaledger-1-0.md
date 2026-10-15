# 2026-10-15 · Migrated to ResaLedger 1.0

This workspace moved from agent-ledger 0.x to ResaLedger 1.0 with `npx resaledger migrate`: one file per task, decision and log entry, the status file's lasting facts in the README, and the protocol in the root `AGENTS.md`. The 0.x files are in git history before this change. Below, word for word, is the 0.x text that has no other place in 1.0.

## The ledger's preamble and phases

From `ledger/work/ledger.md`:

```
# Task ledger

Every task, in the order it should be done. Format and rules: [standards.md](../standards.md#the-task-ledger). A task's commits carry `Task: <id>`.

## S: Research and the specification

## G: Brand and graphics

## F: Foundation

## R: The record format

## V: Gates, stamps, the range check and handoff

## H: Git hooks

## W: The daily commands

## C: The CI check

## A: Agent integrations

## I: The installer

## M: Migration

## T: Acceptance and independent review

## D: Documentation and repository files

## L: The demo, the launch drafts and the release candidate
```

## The log's preamble

From `ledger/work/log.md`:

```
# Session log

What each session did, oldest first. One dated entry per session. Current state is in [STATUS.md](../STATUS.md), not here.
```

## The decision table's surrounding text

From `ledger/DECISIONS.md`, before and after the table:

```
# Decisions

Decisions the owner made, and significant technical decisions made inside an approved plan. Add new rows at the end, on the day the decision is made. A row says what was decided and why in one or two sentences, and who decided.
```

## The 0.x status file

`ledger/STATUS.md` as it was:

```
# Status

Updated: 2026-10-15 · by the lead agent

## Phase

Building. Done: the foundation (F), the record format (R), the git hooks (H), the end-of-session check (V3), the daily commands `work`, `work --all`, `task`, `new` and `claim` (W1–W4), the CI check (C1), the agent hooks for Claude Code and Codex (A1), `init` and `update` (I1, I3), `migrate` with its verification on real workspaces and the fixes from its review (M2, M3, T5), the parallel-lanes acceptance test (T1), the brand identity and the README graphics (G2–G4), and the fixes from the review of the guard (T3.1–T3.3, A1.1).

## Active work

[M4](work/ledger.md#m4-this-repository-moves-to-10), by the lead, and [W5](work/ledger.md#w5-changes), with a worker.

## Last verified

- `npm test` passes with 878 of 878 tests on Node 24, 22 and 20 (2026-10-15). The history scan is clean.
- CI on GitHub passes on Linux and macOS with Node 20, 22 and 24. Windows has not been rechecked since its fixes; the next push shows it.

## Next step

Merge T3.4, C2 and A2 as their workers finish. Then C3, T4 (the review of CI, by a second model), M4 (this repository moves to the 1.0 format), W5, I2, A3, T2, the docs (D1–D4) and the launch kit (L1–L3).

## Waiting for the owner

- Nothing. The owner pushes when a batch is ready.
```

## The 0.x template sections

The sections that agent-ledger's templates wrote, which ResaLedger replaces: the format reference ships with the package, and the protocol is the managed block in the root `AGENTS.md`.

### `ledger/standards.md`

````
# Working standards

The session protocol and the non-negotiables are in [AGENTS.md](AGENTS.md). This file holds the formats, the gates and the ownership of facts.

## Who owns what

Any agent or person must be able to pick the work up at any point and continue it correctly. That works only when every fact has one owner file.

| File | Owns | Update when |
| --- | --- | --- |
| [AGENTS.md](AGENTS.md) | The rules and the start-here path | A rule changes. Agents may tighten rules; loosening needs the owner's approval |
| [STATUS.md](STATUS.md) | Live state: phase, active work, last verified state, next step, what waits for the owner | At the end of every session and every task |
| [work/ledger.md](work/ledger.md) | Every task: status, dependencies, plan link, evidence, handoff notes | When you claim, block, hand off or finish a task |
| [work/log.md](work/log.md) | What each session did, oldest first | At the end of every session |
| [DECISIONS.md](DECISIONS.md) | Decisions the owner made, and significant technical decisions | On the day the decision is made |
| [plan/](plan/README.md) | Phases, their order and reasons, how each task is built, and "As built" differences | Before implementing; again when the design changes during work |
| [progress/](progress/) | Dated evidence: reports, comparisons and screenshots that a ledger entry points to, in a folder per day | A task needs evidence that is not a test |
| This file | Formats and quality gates | Agents may tighten; relaxing needs the owner's approval |

When two files disagree, the code and git history are the truth. Fix the documents in their own commit before continuing.

## STATUS.md

At most 80 lines, with a line `Updated: YYYY-MM-DD · by <agent or person>` and exactly these sections: Phase, Active work, Last verified, Next step, Waiting for the owner. History goes to `work/log.md`. `node ledger/scripts/records.mjs check` enforces the shape.

## The task ledger

`work/ledger.md` lists every task in the order it should be done. The guard, the commit hook and `node ledger/scripts/records.mjs work` parse this format:

```md
### S1 Storage interface
- Status: todo | doing | blocked | done
- Depends on: S0, F15 (or —)
- Plan: [S-server.md](../plan/S-server.md#s1-storage-interface) (or — for a defect that is not planned yet)
- Evidence: — (required when done)
- Notes: — (required when blocked; the handoff note while doing)
```

- Ids are a letter and a number. Never renumber; a new task takes the next free number of its phase.
- At most three tasks are `doing`, and one per agent.
- Claim before you work: set `doing`, with a plan link, in your first commit on the task. The linked plan section must have content, not only a heading.
- `done` needs Evidence that names something another person can run or open: a test file, a command and its result, an exported image.
- `blocked` needs Notes: what unblocks it and who decides.
- Hand off by writing the Notes: what is done, the exact next step, the state of the tree, and open questions. Leave the status `doing`.
- New work found along the way becomes a new task. It is not folded silently into the current one.
- Links in Plan, Evidence and Notes must point to files that exist.

## Plans

A plan file starts with `Status: proposal | approved | in progress | implemented`, an absolute date and who decided. Each task section has this shape:

```md
### <id> <title>

Goal: the outcome, in one or two sentences.
Current state: what exists, with file references.
Design: data, interfaces, the options considered and the choice.
Steps: small, separately committable steps.
Tests: what proves it.
Acceptance: observable criteria a reviewer can check.
Risks and rollback: what can break, and how to undo it.
```

Differences between the plan and what was built go in the plan file under "As built".

## Commits

- Conventional Commits: `type(scope): summary` with type `feat fix refactor perf docs test build ci chore`.
- A commit that changes anything other than Markdown and the records under `ledger/` carries `Task: <id>`. The id is a ledger task that is `doing`, or that this commit sets to `done`. `Task: maintenance` is only for changes with no behaviour change, such as formatting or a tooling fix.
- Records travel with the work: the ledger, status and log updates are in the same commit as the work they describe, or the next one.
- Never commit a broken state.
- Nothing is pushed or deployed without the owner's permission.

The hooks in `.githooks/` enforce the header, the trailer, the task's status and the shape of the records. Turn them on once per clone: `git config core.hooksPath .githooks`. `node ledger/scripts/records.mjs handoff` fails in a clone where they are off.

## Quality gates

Before a task is `done`, two kinds of gates pass.

**Gates that are commands** live in `.agent-ledger.json`, not here, so that they are run and not only described. `node ledger/scripts/records.mjs gates` lists them.

- `gates.commit`: fast checks, such as lint, types and syntax. The pre-commit hook runs them on every commit that changes code.
- `gates.verify`: slow checks, such as the full test suite and the build. `node ledger/scripts/records.mjs verify` runs both lists on the committed code and records the result in `work/verified.json`. `handoff` fails when that record is missing or the code has changed since.

Removing or loosening a command needs the owner's approval, recorded in DECISIONS.md.

**Gates that need eyes or judgement** are listed here:

1. **The quickstart works as written.** Before a release candidate, the README's quickstart is run by hand in a new temporary repository, command by command. Passing: every command succeeds and prints what the README shows.
2. **The demo is real.** The terminal demo is recorded from an actual run, not edited. Passing: the recording's commands and output match a rerun.
3. **Nothing private leaves the machine.** Before anything is pushed, the history scan for local paths and private names finds nothing. Passing: the scan's command and its empty result are recorded as evidence.

The gate commands go into `.agent-ledger.json` when the first code and tests exist.

The last gate is always the same: `node ledger/scripts/records.mjs handoff` passes.
````

### `ledger/AGENTS.md`

```
# agent-ledger workspace: agent rules

These rules bind every agent and person working in this repository: an orchestrator, its workers, a coding agent in a terminal, and humans. The git hooks and `node ledger/scripts/records.mjs handoff` enforce most of them. The rest you follow because the next agent depends on it.

## Start here, every session

1. Read [STATUS.md](STATUS.md): the phase, active work, the last verified state, the next step, and what waits for the owner.
2. Run `node ledger/scripts/records.mjs work`: tasks in progress with their handoff notes, blocked tasks, and the next ready tasks from the [ledger](work/ledger.md). `node ledger/scripts/records.mjs task <id>` prints one task with its plan section, so you do not need to read the whole ledger.
3. Read [standards.md](standards.md): the quality gates and which file owns which fact.
4. For how the project got here, read [DECISIONS.md](DECISIONS.md) and the last entries of [work/log.md](work/log.md). They are history, not current state.

If STATUS.md, the ledger and the code disagree, the code and git history are the truth. Fix the documents first, in their own commit.

## Session protocol

1. **Claim.** Set your task to `doing` in the ledger, in your first commit on it. The commit hook rejects a code commit whose task is not `doing` or `done`. Work that is not in the ledger gets a plan section and a ledger task first.
2. **Build in small, working steps.** One task per commit where practical. Never commit a broken state.
3. **Verify.** Run the plan's acceptance checks and the manual [quality gates](standards.md#quality-gates). With the code committed, run `node ledger/scripts/records.mjs verify`: it runs the project's gate commands and records in `work/verified.json` that they passed on exactly this code.
4. **Record**, in the same commit as the work or the one after it:
   - the ledger: Status, Evidence, Notes
   - STATUS.md: Last verified and Next step
   - DECISIONS.md: every decision, on the day it is made
   - the plan: differences between plan and result, under "As built"
   - work/log.md: one dated entry per session
   - work/verified.json: written by `verify`, committed with the records
5. **Commit.** A Conventional Commits header and a `Task: <id>` trailer. Never push.
6. **Hand off.** Run `node ledger/scripts/records.mjs handoff` before you stop. It fails when the tree is dirty, when the gate commands have not passed on the current code, when the ledger, STATUS.md or the log is older than the last code commit, or when a `doing` task has no notes. If you stop mid-task, leave it `doing` and write the exact next step in its Notes. Uncommitted work is not a handoff.

## Non-negotiables

- **Never weaken a gate to make it pass.** No `--no-verify`, no edited hook, no removed gate command, no skipped or deleted test, no relaxed comparison. A failing gate is fixed in the code or in the records.
- **Write it down or it did not happen.** A finding, a measurement, a decision, a failed attempt, a thing the owner said: each goes into the file that owns it before the session ends. Chat is not a record.
- **Evidence or it is not done.** Evidence names a command and its result, a test file, or an image that someone else can rerun or open. Say what was automated, what was checked by hand, and what was not verified.
- **Facts and proposals stay apart.** Never write a proposal as implemented, or a number you did not measure. A plan starts with its status.
- **One fact, one file.** The table in [standards.md](standards.md#who-owns-what) says which file owns what. Link instead of repeating.
- **Plan before large changes.** A new phase, a new dependency, a stored-data format, an interface others will call, or anything hard to undo needs a plan section and the owner's approval, recorded in DECISIONS.md.
- **No secrets in the repository.** No keys, passwords or tokens in code, records, images or commit messages.

## Orchestrated work

When an orchestrator gives tasks to a worker:

- The orchestrator owns the records. It claims the task, writes the worker's instruction from the plan section, reviews the result against the acceptance checks, and makes sure the records in step 4 exist before the task is closed.
- A worker instruction names the ledger id, the plan section, the files to read first, the acceptance checks, and what the worker must not touch.
- Research the worker cannot do is done by the orchestrator, and its result is written into the plan section before the worker starts.
- A review finding is a ledger note or a new task, not a chat message.

## Working agreements

- Records are written in English.
- Nothing is pushed, deployed, or sent to anyone outside without the owner's explicit approval for that step.
- Do not edit files outside the task. Leave the owner's and other agents' changes alone.
- Commits carry no AI attribution: no co-author, sign-off or assisted-by trailer naming a model or a vendor.
```
