---
name: resaledger
description: Set up ResaLedger in an existing git repository and keep its task records useful to the next agent. Use when a repository has no ledger yet and should get one, or when you write plans, evidence, handoffs and decisions in a repository that has a .resaledger.json file.
---

# ResaLedger: setting up and keeping records

ResaLedger keeps a task ledger inside the repository: one Markdown file per task, decision and log entry, checked by git hooks, agent hooks and a CI check. This skill covers two jobs. The first is setting it up in a real repository so that what it records is true from the start. The second is writing records that the next agent, or a person, can act on without asking you.

The protocol itself (run `work`, claim, commit with a `Task:` trailer, `verify`, `handoff`) is in the managed block of the root `AGENTS.md`. Follow it. This skill does not repeat it.

## Part 1: setting up in a real repository

### 1. Look before you run anything

Read what the repository already says about itself: the README, `package.json` scripts or the equivalent (`Makefile`, `pyproject.toml`, `Cargo.toml`, `go.mod`), the CI workflows, `AGENTS.md`, `CLAUDE.md` and any other agent instructions. Note:

- what the project is for, and for whom;
- the commands that lint, type-check, test and build, and which of them actually pass today;
- where it runs: local only, staging, production;
- work that is already done, and work that is half done on branches.

Run the checks you found. A gate that fails on the first day trains everyone to ignore it.

### 2. Run init

```sh
npx resaledger init
```

Useful options:

- `--team` for the team preset: the base branch is protected, `claim` pushes, `handoff` wants the lane pushed. Solo is the default.
- `--dir <name>` when `ledger/` is taken.
- `--agents claude,codex,cursor,gemini,copilot` to choose the agent hook configurations instead of detecting them; `none` for none.
- `--yes` to accept the defaults without questions.

If `npx` fails with `EOVERRIDE` or another npm error about the project's dependencies before init starts, run `npx --prefix "$(mktemp -d)" resaledger init`: npm then reads an empty folder instead of the project, and init still runs in the repository.

init lists the `package.json` scripts named `test:…` or `lint:…` that it did not run. Add the ones that end and change no files to `gates` in `.resaledger.json` by hand.

init writes `.resaledger.json`, the workspace README, the guard in `<dir>/scripts/records.mjs`, the git hooks, the managed block in `AGENTS.md` and the hook configurations of the agents it finds. It refuses to change a file that has uncommitted changes. It prints a commit command at the end; run it after the next two steps.

For an agent-ledger 0.x workspace, run `npx resaledger migrate --dry-run` first, then `npx resaledger migrate`.

### 3. Write the README from what is true

init leaves `TODO(resaledger)` markers in `<dir>/README.md`, and `handoff` fails while any remain. Fill each section with facts you checked, not hopes:

- **Goal**: what is being built, for whom, and what counts as finished. One short paragraph. `work` prints its first sentence, so make that sentence carry the point.
- **Environments**: one line each, with what it is used for. "Local only" is a valid answer.
- **Manual checks**: checks that need eyes or judgement, each with what is compared and what passes. "None" is a valid answer; an invented check is worse.
- **Risks**, optional: what could sink the work, in a line each.

If you could not confirm something, say so in the text instead of guessing.

### 4. Set the gates from the commands that exist

Gates live in `.resaledger.json`:

```json
{
  "version": 2,
  "gates": {
    "commit": ["npm run lint"],
    "verify": ["npm test", "npm run build"]
  }
}
```

- `commit` gates run on every code commit, so keep them fast: lint, format check, type check.
- `verify` gates run in `verify` and in CI: tests and builds.
- Use only commands that exist in the repository and pass now. Do not add a gate for a script you have not run.
- If a check fails today for reasons outside your task, leave it out and record a task to fix it.

`node <dir>/scripts/records.mjs gates` lists them, and `config` prints the full configuration with defaults.

### 5. Record the work that is already done

A new ledger with no history hides what the project already has. Record the main finished pieces as `done` tasks, each with evidence someone can check:

```sh
node ledger/scripts/records.mjs new "Checkout with card payments"
```

Then edit the file: `- Status: done`, and an Evidence list with a command and its result, or a link to the code, the merged pull request or the page. Keep it to the pieces that matter for what comes next; this is a map, not an archive.

Work in progress becomes `todo` or `doing` tasks with a Handoff that says where it stands and on which branch. Known bugs and next steps become `todo` tasks with a `## Plan` section.

### 6. Commit and check

Run the commit command init printed. Then run `node <dir>/scripts/records.mjs verify` if there are verify gates, commit the stamp, and run `node <dir>/scripts/records.mjs handoff`. It passes when the setup is complete.

## Part 2: records the next agent can use

Write every record for a reader who has the repository and nothing else: no chat history, no memory of your session.

### Plans

A plan says what done looks like before the work starts. Put it in `<dir>/plan/` and link it from the task's `Plan:` field, or give a small task its own `## Plan` section. Each plan has:

- **Goal**: one or two sentences on the outcome, not the steps.
- **Design**: the choices that matter, and why, where they are not obvious.
- **Acceptance**: checks that can be run or seen, such as "`npm test -- cart` passes" or "the order page shows the total with tax at 390 px". Avoid checks like "works well".

A plan file can start with a status line (`Status: proposal | approved | in progress | implemented · <date> · <who>`). A task cannot start while its plan says `proposal`. When the result differs from the plan, write the difference in the task's Notes; do not rewrite the plan to match.

### Evidence

Evidence is what lets someone else believe the task is done without redoing it. Each item is one of:

- a command in backticks with its result: `` `npm test -- cart`: 42 of 42 ``;
- a link to a file in the repository, such as a screenshot or a saved report under `<dir>/evidence/`;
- a URL someone else can open.

Say what was not verified, too: `Not verified: Safari`. Keep evidence files as `.md`, `.txt`, `.log` or images; a file with a code extension counts as code and makes the stamp stale.

Work outside the code, such as content edited in a CMS or a setting changed on a server, is a task like any other, claimed before the change. The hooks do not see it, so the record is all there is: give a small screenshot under `<dir>/evidence/` cropped to the change and free of personal data, the page's address, a revision id, or the command and what it printed. A document outside the repository is named by its URL or in a code span, since links must resolve inside the repository. The guide: https://github.com/Resaco/resaledger/blob/main/docs/guides/outside-the-code.md

### Handoff

`## Handoff` is required while a task is `doing`. It is the state now, rewritten each time and never appended to, at most 1,500 characters:

- what is done and committed;
- what is next, naming files or commands;
- anything that is uncommitted, failing or blocked, and why;
- open questions, and who can answer them.

Write it so the next session can start with the first command. The story of how you got there goes to `## Notes` or a log entry, not the Handoff. When the task is done, remove the Handoff and write the Evidence.

### Notes

`## Notes` holds what the next reader would otherwise rediscover: how the result differs from the plan, what was tried and failed, and limits you found. Keep it about the task, not about your session.

### Decisions

Record a decision on the day it is made, while the reasons are fresh:

```sh
node ledger/scripts/records.mjs new decision "Prices are stored in cents"
```

Fill in Date and Decided by, then two to five sentences: what was decided, the reason, and what it rules out. A decision is written once; a later one supersedes it, and the old file only gets `Status: superseded by <link>`.

### Splitting and dropping

Work you find on the way becomes its own task with `new --under <id>`, not a paragraph in someone's Notes. Tasks are never deleted: a task that is no longer needed is `dropped`, with a `Reason:`. A task split into parts keeps its file as their umbrella, or is dropped with `Reason: split into ...`.

## Using this skill with other agents

The same `SKILL.md` serves every agent that reads Agent Skills:

- Claude Code, Codex and the Copilot CLI install it as a plugin from the ResaLedger repository's marketplace (`.claude-plugin/marketplace.json`).
- Agents that read `.agents/skills/` (Codex, Gemini CLI, Cursor, the Copilot CLI, OpenCode) use the folder `plugins/resaledger/skills/resaledger/` of that repository as `.agents/skills/resaledger/` in a project. No other file is needed.
