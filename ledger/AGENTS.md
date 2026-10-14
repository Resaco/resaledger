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

## Project rules

1. **This repository will be public.** No local paths, no names of private projects, clients or people other than the maintainer, no internal addresses, and nothing derived from private projects, not even anonymised numbers, in files, images or commit messages. A hygiene test will scan every tracked text file, and the history is scanned before anything is pushed. Reason: the repository is its own showcase, and history is hard to clean after publishing.
2. **Agents never push, publish or post.** Creating the public repository, pushing, publishing to npm and announcing are the owner's steps; agents prepare them and write down the exact commands. Reason: these are the owner's and the organisation's decisions.
3. **Nothing copied into a user's repository has a runtime dependency.** Reason: it must work in a fresh clone and in a cloud agent that has nothing installed.
4. **Other repositories on the maintainer's machine are read-only references.** Evidence taken from them is summarised here without names. Reason: they belong to other projects and other people.
5. **The specification is the contract.** A change to a decision in [plan/spec.md](plan/spec.md) needs the owner's approval, recorded in [DECISIONS.md](DECISIONS.md), before the code follows it. Reason: the format is a public interface that other people's repositories will depend on.

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
