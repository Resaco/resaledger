# The ResaLedger format

This is the public contract of the ResaLedger 1.0 format, format version 2. It says what each file is called, what it holds and what the guard accepts, so that a person or an agent can write every record by hand. Where this document and the guard disagree, the guard is right and this document is a bug.

Every example in a block whose info string names a kind, such as `markdown task ledger/tasks/S4-store-documents.md`, is a file of one example workspace. A test parses the whole workspace with the guard's own parsers and requires that it has no problem.

Contents:

1. [Layout](#1-layout)
2. [Configuration](#2-configuration)
3. [Task files](#3-task-files)
4. [Decisions](#4-decisions)
5. [Log entries](#5-log-entries)
6. [Plans](#6-plans)
7. [Evidence](#7-evidence)
8. [Stamps](#8-stamps)
9. [The workspace README](#9-the-workspace-readme)
10. [Commit messages](#10-commit-messages)
11. [What counts as code](#11-what-counts-as-code)
12. [Ids](#12-ids)
13. [Stability](#13-stability)

## 1. Layout

```text
.resaledger.json                         configuration
ledger/                                  the workspace ("dir"; default "ledger")
  README.md                              the project's slow facts: goal, environments, manual checks
  tasks/S4-store-documents.md            one file per task
  decisions/2026-10-14-bullet-fields.md  one file per decision
  log/2026-10-14-storage-routes.md       one file per log entry (optional)
  plan/                                  plans that tasks link to (optional)
  evidence/                              files that evidence links to (a convention)
  verified/3f2a9c1e5b7d4a60.json         gate stamps, named by a hash of the code
  scripts/records.mjs                    the guard: one file, no dependencies
.githooks/                               pre-commit, pre-merge-commit, commit-msg, pre-push
.gitattributes                           a line that keeps the hooks LF: .githooks/* text eol=lf
AGENTS.md                                a managed block with the protocol
.github/workflows/resaledger.yml         the CI check (installed in the team preset, offered in solo)
.claude/settings.json and others         agent hook configurations, for the agents that are present
```

- Folders are created with their first file. A new workspace holds `README.md` and `scripts/records.mjs`.
- The guard reads the Markdown files directly in `tasks/`, `decisions/` and `log/`. A Markdown file in a subfolder of these is reported as a problem, since it would never be read.
- Every Markdown file under `plan/`, at any depth, is a plan.

## 2. Configuration

`.resaledger.json` at the root of the repository. A complete solo configuration:

```json config
{
  "version": 2,
  "dir": "ledger",
  "gates": {
    "commit": ["npm run lint"],
    "verify": ["npm test", "npm run build"]
  }
}
```

A team configuration that also asks for Conventional Commits and refuses AI attribution trailers:

```json config
{
  "version": 2,
  "preset": "team",
  "commitStyle": "conventional",
  "aiAttribution": "forbid",
  "gates": {
    "commit": ["npm run lint"],
    "verify": ["npm test"]
  },
  "agent": {
    "deny": [{ "pattern": "\\bnpm publish\\b", "reason": "the owner publishes" }]
  }
}
```

Every key except `version` has a default. Keys marked † take their default from the preset.

| Key | Default | Rules |
| --- | --- | --- |
| `version` | required | The number `2`. Any other value is refused: `1` with a pointer to `npx resaledger migrate`, a newer one with a pointer to `npx resaledger update`. |
| `dir` | `"ledger"` | The workspace folder. See [folder names](#folder-names). |
| `preset` | `"solo"` | `"solo"` or `"team"`. |
| `base` | `"main"` | The branch work merges into. A non-empty string. |
| `protected` † | solo `[]`, team `[base]` | Branches nobody commits or pushes to directly. An array of non-empty strings. |
| `requirePushed` † | solo `false`, team `true` | `handoff` wants the lane pushed. `true` or `false`. |
| `claimPush` † | solo `false`, team `true` | `claim` commits and pushes the claim. `true` or `false`. |
| `branchPattern` | `""` | A regular expression that lane branch names must match; `""` means none. It must compile. |
| `branchPrefix` | `""` | A prefix for the branches that `claim` creates, such as `"feat/"`. |
| `wip` | `3` | Tasks `doing` per lane. A positive integer. |
| `commitStyle` | `"free"` | `"free"` or `"conventional"`. See [commit messages](#10-commit-messages). |
| `aiAttribution` | `"allow"` | `"allow"` or `"forbid"`. See [commit messages](#10-commit-messages). |
| `codePaths` | `[]` | Folders inside the workspace whose files count as code. Each is written by the [folder-name rule](#folder-names), relative to the workspace. |
| `gates.commit` | `[]` | Fast checks: shell commands that pre-commit runs on every commit that changes code. Non-empty strings. |
| `gates.verify` | `[]` | Slow checks. `verify` runs them after the commit gates, and so does CI. Non-empty strings. |
| `ci.runGates` | `true` | CI runs the gates. With `false`, CI only checks that the head carries a stamp for its own code. |
| `phases` | `[]` | An order of id prefixes for "Ready next", such as `["F", "S"]`. Each is one to four capital letters. |
| `agent.deny` | `[]` | Extra commands that agent hooks refuse: `{ "pattern": "…", "reason": "…" }`. `pattern` is a non-empty regular expression that must compile; `reason` is an optional string. |
| `agent.pushNeedsHandoff` | `false` | With `true`, agent hooks refuse an agent's `git push` while `handoff` fails in the worktree the push runs in, leaving out its check that the lane is pushed; a push after a change of the commits or the checkout in the same command, and a push from a lane without `.resaledger.json`, are refused too, and a dry run is not judged. `true` or `false`. See the [agents guide](guides/agents.md#push-only-what-is-handed-over). |

Further rules:

- A key close to a known key, within two letters of a known key of six letters or more or within one letter of a shorter one, at the top level, in `gates`, `ci` and `agent`, or in a deny rule, is refused as a typo, and the message names the known key. Any other unknown key is kept, with a notice from `check`, because a later 1.x release may have added it; `ci` lists a change to it without judging it.
- `gates`, `ci` and `agent` must be objects. A key left out takes its default.
- A preset only sets the defaults of `protected`, `requirePushed` and `claimPush`. A key written in the file wins over the preset.

### Folder names

`dir` and each `codePaths` entry are relative paths of `/`-separated names. Each name is made of letters, digits, `.`, `_` and `-`, is not `.` or `..`, and does not start with `-`. No name may be empty, so there is no leading, trailing or double `/`. The hooks and commands paste these paths into shell commands and YAML, so nothing in them may need quoting.

### The effective configuration

`node ledger/scripts/records.mjs config` prints the configuration with every default filled in. For `{ "version": 2 }` it prints:

```json effective
{
  "version": 2,
  "dir": "ledger",
  "preset": "solo",
  "base": "main",
  "protected": [],
  "requirePushed": false,
  "claimPush": false,
  "branchPattern": "",
  "branchPrefix": "",
  "wip": 3,
  "commitStyle": "free",
  "aiAttribution": "allow",
  "codePaths": [],
  "gates": {
    "commit": [],
    "verify": []
  },
  "ci": {
    "runGates": true
  },
  "phases": [],
  "agent": {
    "deny": [],
    "pushNeedsHandoff": false
  }
}
```

## 3. Task files

A task in progress:

```markdown task ledger/tasks/S4-store-documents.md
# S4 Store projects and documents on the server

- Status: doing
- Lane: s4-store-documents
- Depends on: S3
- Plan: [S-server.md](../plan/S-server.md#s4-store-projects-and-documents-on-the-server)
- Evidence: —

## Handoff

Routes and storage are done and tested. Next: the list view in the app
(`app/src/projects/List.tsx`). The tree is clean. Open question: the page size.
```

A finished task:

```markdown task ledger/tasks/S3-storage-routes.md
# S3 Storage routes

- Status: done
- Lane: s3-storage-routes
- Plan: [S-server.md](../plan/S-server.md#s3-storage-routes)
- Evidence:
  - `npm test -- server/routes`: 14 of 14
  - Checked by hand: [the run](../evidence/2026-10-07-storage.txt)
  - Not verified: the slow network case

## Notes

As built: one row per revision instead of a JSON column, because revisions are listed and diffed.
```

A task with its own plan instead of a plan file:

```markdown task ledger/tasks/S4.1-fix-the-flaky-upload-test.md
# S4.1 Fix the flaky upload test

- Status: todo
- Evidence: —

## Plan

The upload test fails about one run in twenty. Done when it passes 200 runs in a row.
```

A blocked task and a dropped one:

```markdown task ledger/tasks/S5-delivery-slots.md
# S5 Delivery slots

- Status: blocked
- Waiting for: owner, who picks the slot length
- Issue: #12
```

```markdown task ledger/tasks/S6-order-history.md
# S6 Order history

- Status: dropped
- Reason: split into S6.1 and S6.2
```

### File name and heading

- The file is `<dir>/tasks/<id>-<slug>.md` or `<dir>/tasks/<id>.md`, directly in `tasks/`.
- The file starts with a level-1 heading: `# <id> <title>`. The id is the first word.
- The id in the file name and the id in the heading must agree. The slug only helps people browsing the folder; it may go stale after a title change.
- The title is required and at most 100 characters.
- An id is unique among the tasks of the workspace. See [ids](#12-ids) for its form.

### Fields

Fields are a bullet list of `- Name: value` lines straight after the heading. Blank lines may separate the heading from the list; a blank line inside the list ends it. A name is letters and spaces. A value is the rest of the line. Nothing, `—`, `–` or `-` means empty. A field may hold a nested list instead of a value, indented by two spaces or a tab, as Evidence usually does. An indented line that is not a list item continues the value or the last item.

| Field | Required | Rules |
| --- | --- | --- |
| `Status` | always | `todo`, `doing`, `blocked`, `done` or `dropped`, in lowercase. |
| `Lane` | while `doing` | The branch that holds the task. Kept after `done` as history. |
| `Depends on` | no | Ids of tasks that exist, comma-separated or as nested items. Shown, not enforced as an order. |
| `Plan` | while `doing`, unless the file has a `## Plan` section with content | A Markdown link to a plan file or a section of one. The file or section must have content: a line that is neither blank nor a heading. A task cannot be `doing` while the linked file's [status line](#6-plans) says `proposal`. |
| `Evidence` | when `done` | When not empty, at least one command in backticks, a Markdown link or an `http(s)` URL. Words alone are refused, also before `done`. |
| `Waiting for` | when `blocked` | Who or what unblocks it: `owner`, a person, a task id, an outside party. |
| `Reason` | when `dropped` | Why: split into other tasks, superseded, not needed. |
| `Issue` | no | The issue the task came from, as a link or `#123`. |
| `Taken over from` | no | Written by `claim --take`: the previous lane and commit. |

- A known field may appear only once.
- Other fields are allowed and kept. A field name close to a known one, ignoring case, is refused as a likely typo: within two letters of a known name of six letters or more, such as `Staus` for `Status`, or within one letter of a shorter one, such as `Lanes` or `Lnae` for `Lane`. A swap of two neighbouring letters counts as one. A free field such as `Later` is not taken for `Lane`. Pick names for your own fields that are not that close.
- Every relative link in the file must resolve inside the repository, and an anchor into a Markdown file must name one of its headings.

### Sections

| Section | Required | Rules |
| --- | --- | --- |
| `## Plan` | no | The goal and acceptance checks for a task with no separate plan. |
| `## Handoff` | while `doing`, at `handoff` | The present state, rewritten each time rather than appended. At most 1,500 characters. `handoff` also wants it rewritten after the last commit that changes code and names the task. |
| `## Notes` | no | Anything else: findings, what was tried, how the result differs from the plan. |

A section runs to the next heading of level 1 or 2. Why Handoff is capped and kept apart from Notes: notes that collect dated events grow into a diary that soon contradicts itself, and the handoff is the state now.

Tasks are never deleted, because a deleted task leaves commits whose `Task:` trailer names nothing. To split a task, add children (`S6.1`, `S6.2`) and either keep the parent as their umbrella or drop it with a Reason.

## 4. Decisions

```markdown decision ledger/decisions/2026-10-14-bullet-fields.md
# Task fields are bullets, not YAML front matter

- Date: 2026-10-14
- Decided by: alice
- Status: accepted

GitHub renders bullets with working links and front matter as a table of raw text.
A colon in a value breaks YAML. Agents already write `Field: value` lines reliably.
```

A decision that lets a weakening change to enforcement through, and the one it replaced:

```markdown decision ledger/decisions/2026-10-15-four-tasks-per-lane.md
# Four tasks per lane

- Date: 2026-10-15
- Decided by: alice
- Weakens: wip

Reviews wait a day, so each lane holds more open work.
```

```markdown decision ledger/decisions/2026-10-01-two-tasks-per-lane.md
# Two tasks per lane

- Date: 2026-10-01
- Decided by: bob
- Status: superseded by [four tasks per lane](2026-10-15-four-tasks-per-lane.md)

Small lanes merge sooner.
```

| Field | Required | Rules |
| --- | --- | --- |
| `Date` | yes | `YYYY-MM-DD`, a day that exists. The file name starts with the same date. |
| `Decided by` | yes | Who decided. |
| `Status` | no | `accepted`, which is also the meaning when it is missing or empty, or `superseded by <link>`, where the link resolves. |
| `Weakens` | no | Ids of changes to enforcement, separated by commas or spaces: `- Weakens: wip, gates.verify`. |

- The file is `<dir>/decisions/<date>-<slug>.md` and starts with a level-1 heading that says what was decided.
- A field may appear only once, and a field name within two letters of a known one is refused.
- A known field below the field list, such as a `- Weakens:` line after a blank line, is refused: there it would be text, not a field.
- A decision file is added once; marking it superseded is its only later edit.
- `Weakens` counts only in the pull request that adds the decision. CI lists every change to the configuration, the guard, the hooks, the workflow and `.gitattributes`, each with an id such as `wip`, `gates.verify`, `protected`, `guard`, `hooks/pre-commit` or `gitattributes`, and fails a weakening change that no added decision names. A hook that stops being executable weakens like a hook whose text changed.

## 5. Log entries

```markdown log ledger/log/2026-10-14-storage-routes.md
# 2026-10-14 · Storage routes, and why paging waits

- Lane: s4-store-documents
- Tasks: S4

What the task files do not say: what was tried and failed, and what was learned.
```

- The file is `<dir>/log/<date>-<slug>.md`. The heading is `# <date> · <title>`, with a middle dot (`·`) between single spaces, and the date in the heading equals the date in the file name.
- `Lane` and `Tasks` are optional. `Tasks` lists ids of tasks that exist, comma-separated.
- A log entry is optional. Write one when a session has a story worth keeping that belongs neither in a task's Notes nor in a decision; `handoff` does not ask for one.

## 6. Plans

Plans are free Markdown in `<dir>/plan/`, written before the work they describe. A plan may have a status line before its first `##` heading:

```markdown plan ledger/plan/S-server.md
# S The server

Status: approved · 2026-10-02 · alice

### S3 Storage routes

Routes to create, read and list documents, with tests for each.

### S4 Store projects and documents on the server

One table for projects, one for document revisions. Done when the app lists, opens and saves a project.
```

- The status line starts with `Status:` at the start of a line. Its parts are separated by `·`: the status, then optionally the date and who decided.
- The status is `proposal`, `approved`, `in progress` or `implemented`, in lowercase.
- A task cannot be `doing` while the plan file it links to says `proposal`.
- A task may also link to a Markdown file outside `plan/`; its status line counts in the same way.
- Differences between the plan and the result go into the task's Notes, not back into the plan, so lanes do not edit shared plan files.

## 7. Evidence

`<dir>/evidence/` holds the files that evidence links to. Its form is free. Keep evidence as `.txt`, `.log`, Markdown or images, such as a screenshot of work outside the code ([the guide](guides/outside-the-code.md)): a file with a [code extension](#11-what-counts-as-code) counts as code, so it needs a task and makes the stamp stale.

```text evidence ledger/evidence/2026-10-07-storage.txt
Opened, saved and reopened a project with three documents. The list shows all three.
```

## 8. Stamps

`verify` runs the commit gates, then the verify gates, on the committed code. When all pass, it writes `<dir>/verified/<first 16 hex digits of the fingerprint>.json`. For the solo configuration in [section 2](#2-configuration):

```json stamp ledger/verified/3f2a9c1e5b7d4a60.json
{
  "version": 1,
  "fingerprint": "3f2a9c1e5b7d4a60c8e1f0b2a4d6c8e0f1a3b5c7",
  "gates": "49aacf58187d8e03410d7fdbd424db75f5b6b87fb99f87c6f9143846ac004b29"
}
```

- `fingerprint` is a SHA-1, in hex, over the sorted lines `<mode> <blob id> <path>` (each ending in a newline) of every tracked [code](#11-what-counts-as-code) file. It changes when code, the configuration, the guard or a hook changes, and not when a record changes.
- `gates` is a SHA-256, in hex, over the fingerprint and the gate commands, commit gates first, joined by newlines. A stamp counts only for the gates configured now.
- The text is JSON with two-space indentation and a final newline. It holds no time and no name, so two lanes that verify the same code write identical files.
- `verify` writes nothing when the stamp for the current fingerprint exists; `--force` reruns. It deletes every other file in `verified/` whose name is 16 hex digits and `.json`. So a stamp lives only until the code changes: name it in Evidence in backticks rather than linking it, or the link breaks at the next `verify`.
- `handoff` requires a stamp for the current fingerprint whenever `gates.verify` is not empty. A stamp is a claim, not a proof; CI reruns the gates unless `ci.runGates` is `false`.

## 9. The workspace README

`<dir>/README.md` is the project's own text, which `update` never touches.

```markdown readme ledger/README.md
# The bakery shop

## Goal

An online shop where customers order bread for a delivery slot. It is finished when an order can be placed, paid and delivered.

## Environments

- Local only.

## Manual checks

1. **The order page reads well on a phone.** Compared at 390 px wide; passing: nothing overlaps and every button is reachable.
```

- `## Goal`, `## Environments` and `## Manual checks` are required, matched without regard to case. `## Risks` is optional, and so is any other section.
- No `##` section may be empty. "None" and "Local only" are valid answers.
- `init` writes `TODO(resaledger)` markers in the sections it cannot fill. Commits and `check` accept them; `handoff` fails while any line holds one.
- `work` prints the first sentence of the goal.

## 10. Commit messages

A commit that changes [code](#11-what-counts-as-code) names its task:

```text commit
feat(server): store documents

Task: S4
```

```text commit
fix(server): close the upload stream on error

Task: S3, S4
```

```text commit
chore(deps): bump the test runner

Task: maintenance
```

- Every line of the body that starts with `Task:` counts; the subject line never does. Its value is a comma-separated list. Several `Task:` lines add up.
- `Task: maintenance`, in lowercase, is for a change with no behaviour change: formatting, a dependency bump, a tooling fix.
- Any other value must be a task id. Each named task must exist and be `doing` or `done` in the commit's own tree.
- The lane rule: the task's `Lane` must be the current branch, or have been set after the start of the range being checked. For commit-msg the start is `HEAD`, so a claim in the same commit counts; for pre-push, `handoff` and CI it is where the range starts. A detached `HEAD` skips this rule.
- A commit that changes only records or documentation needs no task.

Exemptions:

| Commit | Exempt when |
| --- | --- |
| A merge | Every code path it changes against a parent was also changed on another side, between the merge base and that other parent: a clean merge or a conflict resolution. Code changed only in the merge needs its own `Task:` line. |
| A revert | Its `This reverts commit <hash>.` line names an ancestor, and its change is exactly the inverse of that commit's change, compared by patch id. |
| A commit GitHub made merging a pull request | Only in CI's check of a push to the base, because the pull request was checked: GitHub's committer address on a merge commit or on a squash commit, whose subject ends in ` (#12)`. The address is trusted, not verified, so the output counts these commits and the base must be protected. |

A release commit is not exempt: one that changes code carries a `Task:` line, for example `Task: maintenance`. The message alone never exempts a commit.

With `commitStyle: "conventional"`, the subject is `type(scope)!: description`: a lowercase type, an optional scope and `!`, then `: ` and the description. git's `fixup! `, `squash! ` and `amend! ` prefixes are allowed. Merges and reverts are not checked.

With `aiAttribution: "forbid"`, a body line whose trailer key ends in `-by` or `-with`, such as `Co-authored-by:` or `Generated-with:`, is refused when it names an AI model, an assistant or its vendor, by name or by e-mail domain. The list is in the guard.

## 11. What counts as code

Code needs a task to commit and changes the fingerprint. Everything else does not.

| Where | Code |
| --- | --- |
| Outside the workspace | every tracked file that is not Markdown (`.md`, `.markdown`) |
| `.resaledger.json` and `.githooks/` | always |
| `<dir>/scripts/` | everything |
| A `codePaths` folder | everything except images (`.avif .gif .jpg .jpeg .png .svg .webp`) |
| `<dir>/tasks/`, `decisions/`, `log/`, `plan/` | nothing |
| A stamp, `<dir>/verified/<16 hex digits>.json` | no |
| Anywhere else in the workspace | files with a code extension: `.js .mjs .cjs .ts .tsx .jsx .json .yml .yaml .sh .py .rb .go .rs .toml`, in any case |

Examples, with `"codePaths": ["fixtures"]`:

```text code
yes  src/server/storage.js
yes  .resaledger.json
yes  .githooks/pre-commit
no   README.md
no   docs/format.md
yes  ledger/scripts/records.mjs
yes  ledger/fixtures/orders.csv
no   ledger/fixtures/oven.png
yes  ledger/evidence/run.json
no   ledger/evidence/run.txt
no   ledger/plan/data.json
no   ledger/tasks/S4-store-documents.md
no   ledger/verified/3f2a9c1e5b7d4a60.json
no   ledger/README.md
```

## 12. Ids

An id is one to four capital letters, a number, and optional `.number` parts: `S4`, `S4.1`, `API12`. An id is a name, not a position. Once it reaches the base branch it is never renumbered, renamed or reused.

- Planned tasks get their ids when the plan is written: `S1` to `S9`.
- Work found inside a task gets a child id: `new --under S4 "…"` creates `S4.1`. Only the lane that holds S4 creates its children, so these ids cannot collide.
- Other new tasks (`new S "…"`) take the next number after the highest one visible in this worktree, the other local worktrees and the fetched branches.
- The hooks and CI refuse a new id that another branch already has as a different task file. Renaming it is safe, because the id is new in this branch.
- Issue numbers work as ids too: `I123`.

## 13. Stability

- `version` in the configuration is the format version: 1 for agent-ledger 0.x, 2 for ResaLedger 1.x. A guard refuses a version it does not read and prints the command that fixes it.
- Within 1.x, changes are additive only: new optional fields and new commands. A 1.x guard reads the records of any 1.y workspace and keeps task and decision fields it does not know.
- A new configuration key is the exception: a guard refuses a key it does not know, so a workspace that uses a newer key needs a guard at least as new.
- The managed files are the guard, the git hooks, the `AGENTS.md` block and the agent hook configurations. `update` replaces one only when its content matches a released version, and never touches the README, the records or the project's own part of `AGENTS.md`. The guard's second line names its version: `// ResaLedger <version>`.
- A breaking change needs a new format version, a `migrate` step and a major release.
