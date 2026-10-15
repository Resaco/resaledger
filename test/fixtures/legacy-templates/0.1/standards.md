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

At most 80 lines, with a line `Updated: YYYY-MM-DD · by <agent or person>` and exactly these sections: Phase, Active work, Last verified, Next step, Waiting for the owner. History goes to `work/log.md`. `{{guard}} check` enforces the shape.

## The task ledger

`work/ledger.md` lists every task in the order it should be done. The guard, the commit hook and `{{guard}} work` parse this format:

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
- A commit that changes anything other than Markdown and the records under `{{dir}}/` carries `Task: <id>`. The id is a ledger task that is `doing`, or that this commit sets to `done`. `Task: maintenance` is only for changes with no behaviour change, such as formatting or a tooling fix.
- Records travel with the work: the ledger, status and log updates are in the same commit as the work they describe, or the next one.
- Never commit a broken state.
- Nothing is pushed or deployed without the owner's permission.

The hooks in `.githooks/` enforce the header, the trailer, the task's status and the shape of the records. Turn them on once per clone: `git config core.hooksPath .githooks`. `{{guard}} handoff` fails in a clone where they are off.

## Quality gates

Before a task is `done`:

TODO(agent-ledger): the project's own gates as a numbered list. Each gate is a command and the result that counts as passing: the build, the tests against a recorded baseline, the browser check at stated widths, the data that must come out unchanged. A gate another agent cannot run is not a gate.

The last gate is always the same: `{{guard}} handoff` passes.
