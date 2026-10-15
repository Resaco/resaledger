# Concepts

ResaLedger keeps a task ledger inside a git repository and enforces it. This page explains the words the other guides use, and what each layer of enforcement stops. [The format reference](../format.md) describes every file and field.

## Records

Every record is a Markdown file in the workspace folder, `ledger/` by default.

- **A task** is a file in `ledger/tasks/`, such as `T4-take-orders-for-pickup.md`. It has a status (`todo`, `doing`, `blocked`, `done` or `dropped`), the lane that holds it, what it depends on, a plan, evidence and a handoff note.
- **A decision** is a file in `ledger/decisions/`, written on the day it is made and naming who decided. Decisions are added and never edited, apart from marking one superseded.
- **A log entry** is a file in `ledger/log/`, for notes that belong to no task. It is optional.
- **The README**, `ledger/README.md`, holds the project's slow facts: its goal, its environments and the checks that need a person.

One file per record means two people never edit the same file by accident, so records merge without conflicts.

**Evidence** is something another person can rerun or open: a command and its result, a file, a link. A task cannot become `done` without it.

**The handoff note** is a task's `## Handoff` section: the exact next step, written for whoever continues. A task in progress needs a current one before a session ends.

## Lanes

A lane is a branch with someone working on it: you, an agent, a colleague, a cloud sandbox. The branch name is the lane, and there is nothing to register.

- One person on `main` is one lane.
- Three agents in three worktrees are three lanes.
- Twelve colleagues' branches are twelve lanes.

A task that is `doing` belongs to the lane in its `Lane:` field, and only that lane changes its file. The pre-commit hook refuses a change to it from any other lane, and sees a claim in another local worktree before that claim is committed. CI refuses it in a pull request. A branch stacked on another lane carries that lane's tasks unchanged: CI compares them with the holding lane's branch, so a stale copy fails until the stacked branch rebases on the holder. That rule is what keeps parallel work free of conflicts in the records. A lane holds at most three tasks in progress at once by default (`wip` in the configuration).

## Claims

`claim <id>` takes a task: it sets `Status: doing` and `Lane:` to the current branch. It refuses a task that another lane holds, in this worktree, in another local worktree, or on a pushed branch as last fetched.

- `claim <id> --worktree <path>` creates a branch and a worktree for the task first. A person starts a parallel agent this way.
- In the team preset, `claim` on the protected base creates the lane branch, commits the claim and pushes it, so everyone sees it at once.
- `claim <id> --take` takes over a task whose lane has stopped, and records where it came from.

Claims are detected, not locked: there is no server. A double claim is visible after one fetch, and CI reports a task held in two open branches: the pull request fails until one lane gives the task up or the other takes it over.

## Commits name their task

Every commit that changes code ends with a `Task:` line naming the task it belongs to:

```text
feat: take orders for pickup

Task: T4
```

`Task: maintenance` is for a change with no behaviour change, such as formatting or a dependency bump. A commit that changes only records or Markdown needs no task.

## Gates and stamps

**A gate** is a command the project already has: lint, tests, a build. `init` finds them and keeps only those that pass.

- **Commit gates** are fast. The pre-commit hook runs them on every commit that changes code.
- **Verify gates** are slow. `verify` runs them, after the commit gates, on the committed code.

**A stamp** is the file `verify` writes when every gate passes, such as `ledger/verified/7e156adbc0cfba72.json`. Its name comes from a hash of the code, so a stamp belongs to exactly one state of the code. Committing records does not change that hash; changing code does, and the stamp goes stale.

A stamp is a claim, and anyone can write one by hand. CI reruns the gates by default, so a forged stamp does not get through CI. Without CI, the stamp guards against forgetting, not against the person.

## `work` and `handoff`

- **`work`** starts every session. It turns the git hooks on in a clone where they are off, and shows what each lane holds, what waits for the owner, what is blocked and what is ready.
- **`handoff`** ends every session. It checks that the records are valid, the tree is clean, the gates passed on this code, every task in progress has a current handoff note and, in the team preset, that the lane is pushed.

## Presets

| | solo | team |
| --- | --- | --- |
| Commits and pushes on the base branch | allowed | refused |
| `claim` on the base branch | claims in place | creates a lane branch first |
| `claim` commits and pushes the claim | no | yes |
| `handoff` wants the lane pushed | no | yes |
| CI workflow | offered | installed |
| How lanes merge | ordinary merges, locally or by pull request | pull requests |

Switching is one line in `.resaledger.json`, and the records do not change. A person who starts parallel agents does not need the team preset: lanes are branches in both.

## The layers, and what each stops

Four layers enforce the ledger, from the one every agent reads to the one nobody can skip.

1. **`AGENTS.md`** holds a block that teaches the protocol: run `work`, claim a task, commit each step with its `Task:` line, never use `--no-verify`, run `verify`, update the task, run `handoff`. Every agent reads it at the start of a session. It stops nothing by itself.
2. **Agent hooks** run inside agents that have them: Claude Code, Codex, Cursor, Gemini CLI and GitHub Copilot. Before a tool runs, they refuse `--no-verify`, a change to `core.hooksPath`, a forced push, a push to a protected branch, an edit on a protected branch, and commands that throw work away in another lane's worktree. [Agents](agents.md) has the details.
3. **Git hooks** run for every person and every agent. They refuse a commit with no task, invalid records, a change to another lane's task, a commit on a protected branch and, before a push, unrecorded commits.
4. **CI** checks every pull request with the rules of the base branch, so a pull request cannot weaken the check that judges it. It reruns the gates and lists every change to the enforcement files. [CI](ci.md) has the details.

In a repository that uses Git LFS, the pre-push hook takes the place of the one Git LFS would write. Git LFS counts as in use when `filter=lfs` appears outside a comment in a `.gitattributes` file of the index or of a pushed commit, so a branch that adds Git LFS counts even while another branch is checked out, or in the repository's own attributes, `.git/info/attributes` and the file `core.attributesFile` names, or, when that is unset, git's default `$XDG_CONFIG_HOME/git/attributes` or `~/.config/git/attributes`. Once its own checks pass, the hook runs `git lfs pre-push` with the same remote, URL and refs, so the LFS objects are uploaded, and the push fails when Git LFS fails. A refused push uploads nothing, and a hook that receives no refs, as when a hook manager has already run `git lfs pre-push`, runs nothing of Git LFS. When `git-lfs` is not installed, the push is refused with Git LFS's advice. A repository without `filter=lfs` runs nothing of Git LFS.

Each layer has a gap that the next one covers:

| Layer | Stops | Does not stop |
| --- | --- | --- |
| Git hooks | forgetting, habit, an agent that does not know the rules | `--no-verify`, a changed hooks path, a clone where they are off |
| Agent hooks | an agent reaching for `--no-verify`, a forced push or a push to the base | agents without hooks; a determined workaround |
| `handoff` | bypassed commits that are not pushed yet | anything already pushed |
| CI with the base's rules | everything above, for everything that reaches a pull request | an administrator; a workflow file changed in the same pull request, unless CODEOWNERS protects it |
| The host: branch protection, the required check, CODEOWNERS | merging without the check, or enforcement changes without review | nothing in this list |

A person who is determined to get around everything can, on their own machine. The host's settings are the only answer to that, and [the team guide](team.md) sets them up.
