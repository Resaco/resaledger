# Contributing to ResaLedger

This repository is worked the way ResaLedger's users work: every change belongs to a task in the ledger, git hooks refuse a commit that names no task, and CI checks the same rules on every pull request. This file explains how. The protocol itself is the managed block in [AGENTS.md](AGENTS.md); read it first, whether you are a person or an agent.

## Before you start

- You need git and Node 20 or newer. There is nothing to install: the package has no dependencies.
- Run `node ledger/scripts/records.mjs work` at the start of every session. It turns on the git hooks in your clone and shows what is in progress, what waits for the owner and what is ready.
- Read the project rules at the top of [AGENTS.md](AGENTS.md). The most important one: this repository is public, so nothing private goes into it (see [Hygiene](#hygiene)).
- Behaviour in this project is covered by the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems are reported privately, as [SECURITY.md](SECURITY.md) says, never in a public issue.

## The ledger

The records live in [`ledger/`](ledger/README.md):

- `ledger/tasks/`, one file per task, with its status, the lane that holds it, its plan, evidence and handoff note;
- `ledger/decisions/`, one file per decision, written on the day it is made;
- `ledger/log/`, one file per log entry;
- `ledger/plan/`, the specification and the plan the tasks come from;
- `ledger/verified/`, the stamps that `verify` writes.

`node ledger/scripts/records.mjs task <id>` prints one task with its plan section. New work found on the way becomes its own task: `node ledger/scripts/records.mjs new --under <id> "<title>"`. A decision: `node ledger/scripts/records.mjs new decision "<title>"`.

## Lanes and claims

A lane is a branch with someone working on it. Each lane edits only its own task files; another lane's task is refused by the hooks and by CI.

- Take a task on your current branch with `node ledger/scripts/records.mjs claim <id>`.
- To work on a task next to others, give it its own branch and worktree: `node ledger/scripts/records.mjs claim <id> --worktree <path>`. Work only in that worktree.
- The claim edits the task file. Commit it first, as `chore: claim <id>` with the `Task:` trailer.

## Commits

- Commit each working step yourself. Use a [Conventional Commit](https://www.conventionalcommits.org/) subject, such as `feat(init): …`, `fix(guard): …` or `docs: …`.
- End every message with a `Task: <id>` line naming the task the commit works on. The hooks refuse a commit that changes code and names no task.
- Do not add trailers that name an AI model, assistant or vendor, such as a `Co-Authored-By:` line for an agent. This repository sets `"aiAttribution": "forbid"` in [.resaledger.json](.resaledger.json), and the commit-msg hook refuses them. A person who happens to share a name with an assistant is not refused.
- Never use `--no-verify`. If a hook refuses something that looks wrong, stop and report it with the exact output, in an issue or in your task's handoff. A bypassed commit is caught again by `handoff` before it is pushed, and by CI after.
- Agents do not push, publish or post. Those are the owner's steps.

## Tests

`npm test` builds the guard and runs every test in `test/`. It needs no network.

CI runs the suite on Node 20, 22 and 24, on Linux, macOS and Windows. Before you hand off a change to the guard, the hooks or the command line, run it on all three Node versions locally, one after the other:

```sh
npm test            # with each of Node 20, 22 and 24 in turn
```

With a version manager, switch versions between the runs; do not run the three at the same time, since some tests measure time.

## Verify and stamps

When the code is committed, run:

```sh
node ledger/scripts/records.mjs verify
```

It runs this repository's gates (`npm test`, see [.resaledger.json](.resaledger.json)) on exactly the committed code and, when they pass, writes a stamp in `ledger/verified/` named after a hash of that code. Commit the stamp. A stamp says the gates passed on this code; CI runs the gates again, so a stamp written by hand gets nothing past it.

## Finishing a task

1. Keep the task file's `## Handoff` current while you work, so the next session can continue.
2. When the task is done, set `- Status: done` and write `- Evidence:`: a command and its result, or a link someone else can open. Move what you built and the choices you made under `## Notes`, and remove the Handoff.
3. Run `node ledger/scripts/records.mjs verify` and commit the stamp.
4. Run `node ledger/scripts/records.mjs handoff`. It must pass before you stop.

## Issues and pull requests

Issues use the forms for a [bug report](.github/ISSUE_TEMPLATE/bug-report.yml) and a [feature request](.github/ISSUE_TEMPLATE/feature-request.yml). Blank issues are turned off, and [the issue chooser](.github/ISSUE_TEMPLATE/config.yml) sends security reports to private reporting.

A pull request keeps the `Task:` line of the [template](.github/pull_request_template.md), so that a squash merge names the task. CI judges the pull request by the rules of the branch it merges into.

## Changing the guard

This repository runs the guard it builds. A development build is never a released version, so `update` does not replace it on its own. After a change to `src/guard/`, renew this repository's copy and commit it with the change's task:

```sh
node bin/resaledger.mjs update --force
```

## Hygiene

This repository is public, and history is hard to clean after publishing. Nothing private goes in, in files, images or commit messages:

- no home-directory paths or other local paths;
- no names of real people, clients or products other than the copyright holder in [LICENSE](LICENSE);
- no internal addresses or URLs, and no e-mail addresses;
- nothing derived from private projects, not even anonymised numbers.

`test/hygiene.test.mjs` scans every tracked text file as part of `npm test`. A private deny-list of words can be kept in `.git/info/hygiene-deny`, one entry per line; it is never tracked. Before anything is pushed, scan the whole history the same way:

```sh
node scripts/scan-history.mjs
```

## Releases and versions

How versions are numbered and how a release is published: [docs/releasing.md](docs/releasing.md).
