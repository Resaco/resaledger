# Moving from agent-ledger 0.x

`npx resaledger migrate` converts an agent-ledger 0.1, 0.2 or 0.3 workspace to ResaLedger 1.0 in place. It builds the new files in memory, checks that no line of the old records is lost, writes them, and never commits. You review the change, commit it, and can undo all of it with one command until then.

The examples start in a repository with a 0.3 workspace in `build/` and a lane, `a2-prices`, that is not merged yet.

## What changes, and what is kept

The records become one file per record. The text of each record is kept word for word.

| 0.x | 1.0 |
| --- | --- |
| `work/ledger.md`, one `### <id> <title>` per task | `tasks/<id>-<slug>.md`, with the same fields. A `doing` task gets a `Lane:`: an existing one wins, else the one unmerged branch whose commits name the task in a `Task:` trailer, else the current branch. Its Notes become its `## Handoff`. Lines under a task that are not its fields go into its `## Notes`. |
| `work/log.md` | `log/<date>-<slug>.md`, one file per entry. |
| `DECISIONS.md`, one table row per decision | `decisions/<date>-<slug>.md`, with Decided by from the third column. |
| `STATUS.md` | Its Phase and Waiting for the owner go to the README under `## At migration`. |
| The workspace `README.md` | Stays. What is being built becomes Goal. |
| `standards.md` | Its manual gates go to the README's Manual checks, and any section the 0.x template did not have, or whose template text the project edited, goes to the README under its own heading. |
| The workspace `AGENTS.md` | Its Project rules, and any section the 0.x template did not have or whose template text the project edited, go into the root `AGENTS.md`, above the managed block. |
| `work/verified.json` | Removed. Run `verify` for a new stamp. |
| `plan/`, `progress/` and every other file in the folder | Unchanged, where they are. |
| `.agent-ledger.json` | `.resaledger.json`, format version 2, with the solo preset. Gates, code paths, commit style, AI attribution, deny rules, protected branches and `requirePushed` are kept. |
| The guard, the git hooks, the `AGENTS.md` pointer block, the Claude Code hook entries | Replaced by 1.0's. |
| The `.gitattributes` union rules | Removed. The file gets `.githooks/* text eol=lf`. |
| A `.gitattributes` rule for `.agent-ledger.json`, such as `export-ignore` | Names `.resaledger.json`, with its attributes kept, and the report lists it. A longer pattern that only contains the old name is listed as a warning and left for you to change. |

Whatever has no place in 1.0 is kept word for word in one log entry, `log/<today>-migrated-to-resaledger-1-0.md`: the ledger's preamble and phase headings, the whole `STATUS.md`, the template sections of `standards.md` and the workspace `AGENTS.md` that are as a 0.x release wrote them, and configuration keys with no 1.0 meaning.

A template section is compared with the text that agent-ledger 0.1, 0.2 and 0.3 wrote, with this workspace's folder and settings filled in; whitespace and line endings do not count, and neither do the manual gates you listed under Quality gates. A section with any other edit stays active where the project's own sections go, and `migrate` warns about each one. Review those sections after the migration: they may describe 0.x files and commands, such as `STATUS.md` or `work/verified.json`, that 1.0 does not have.

Links into the ledger, the log and `DECISIONS.md` are rewritten to the new files. Anything it cannot rewrite is listed. [The format reference](../format.md) describes the 1.0 files.

## Merge or close open lanes first

Look for branches that are not merged:

```bash
git branch --no-merged
```

```text
a2-prices
```

A lane's commits stay in the 0.x format. The 1.0 check judges each commit by its own tree, and those trees have no task files, so a lane merged after the migration fails `handoff` and CI. `migrate` warns about each one, and gives a task in progress to the lane whose commits name it:

```bash
npx resaledger migrate --dry-run
```

```text
resaledger migrate: agent-ledger 0.x to ResaLedger 1.0 (2 tasks, 1 decision, 1 log entry)
Create (7):
build/tasks/A1-show-the-opening-hours.md
build/tasks/A2-add-a-price-list.md
Delete (6):
build/work/ledger.md
Lanes taken from the one unmerged branch whose commits name the task (1):
A2: Lane: a2-prices
Warnings (2):
! build/standards.md: the section "Commits" came from the 0.x template and has project edits, so it moves to build/README.md; review it, since it may describe 0.x commands
! the branch a2-prices is not merged. Its commit stays in the 0.x format, and the 1.0 range check judges each commit by its own tree, where no task file is, so merged as it is it fails handoff and CI. Merge or close it before migrating, or rebase it onto this branch afterwards and make again, in the 1.0 files, any change it made in build/
--dry-run: nothing was written.
```

`--dry-run` shows the whole plan and writes nothing. This project rewrote the template's Commits section in `standards.md`, so it stays active in the README. Merge the lane, or close it, before you migrate:

```bash
git merge --no-edit a2-prices
```

If a lane has to stay open, migrate anyway. A `doing` task without a `Lane:` goes to the lane whose commits name it, here `a2-prices`, so the lane keeps its task. After the migration, rebase the lane onto the migrated base, make again, in the 1.0 files, any change the lane made in the workspace, and rewrite the task's `## Handoff`:

<!-- not run: the alternative to merging the lane first -->

```bash
git switch a2-prices
git rebase main
```

When the commits of more than one unmerged branch name the same task, the task gets the branch you migrate on, and a warning names the branches. To give it to one of them, add `- Lane: <branch>` under the task's `- Status: doing` in the 0.x ledger, commit, and migrate again. `claim --take` after the migration does not help the lane's rebased commits, because the check judges each commit against the lanes before it.

## Migrate

Start from a clean tree, on the branch the work continues on. Look at the plan once more, then run it:

```bash
npx resaledger migrate --dry-run
npx resaledger migrate
```

```text
✔ records valid: 2 tasks, 1 decision, 2 log entries
Review the change, then:
1. Commit the migration:
git add -A && git add --chmod=+x .githooks/pre-commit .githooks/pre-merge-commit .githooks/commit-msg .githooks/pre-push && git commit -m "chore: migrate to ResaLedger 1.0" -m "Task: maintenance"
Then run "node build/scripts/records.mjs verify" to write the first stamp.
To undo everything instead:
git restore -- :/ && git clean -fd -- :/
```

The new guard checks the result before `migrate` ends. On a protected branch, the commit it prints goes to a new branch, `resaledger-setup`, as with `init`.

## Review the change

```bash
git status --short
cat build/tasks/A2-add-a-price-list.md
```

```text
# A2 Add a price list
- Status: doing
- Lane: main
- Plan: [A-shop.md](../plan/A-shop.md#a2-add-a-price-list)
## Handoff
Next: the rye bread price.
```

Links keep working, but their text stays as it was. A link whose text named an old file now points at the new one under the old name:

```bash
cat README.md
```

```text
The tasks are in [work/ledger.md](build/tasks/).
```

Search for the old names and reword such links when you like:

```bash
git grep -n -e 'work/ledger.md' -e 'work/log.md' -e 'DECISIONS.md' -e 'STATUS.md' -- ':!build/log/'
```

The migration's log entry is left out of the search, because it keeps the old text on purpose.

## Undo

Until you commit, one command undoes everything. `migrate` printed it:

```bash
git restore -- :/ && git clean -fd -- :/
git status --short
```

It restores every changed file and removes every file `migrate` created. `migrate` refuses a tree with uncommitted changes, so nothing of yours is in the way. When `migrate` turned the git hooks on in a clone where they were off, the printed command ends with `&& git config --unset core.hooksPath` as well.

Run it again when you are ready:

```bash
npx resaledger migrate
```

## Commit and verify

Commit with the command `migrate` printed, then write the first stamp:

```bash
git add -A && git add --chmod=+x .githooks/pre-commit .githooks/pre-merge-commit .githooks/commit-msg .githooks/pre-push && git commit -m "chore: migrate to ResaLedger 1.0" -m "Task: maintenance"
node build/scripts/records.mjs verify
git add build
git commit -m "chore: the first stamp"
node build/scripts/records.mjs work
```

```text
In progress in this lane
A2  Add a price list
Next: the rye bread price.
```

`migrate` renews the Claude Code hook entries that 0.x wrote, and no others. When an agent that `init` would detect, from its folder or instruction file, has no hook configuration afterwards, or when no agent has one, the report ends with the command that adds them, such as `npx resaledger update --agents claude`. Without agent hooks, `agent.deny` and the refusal of `--no-verify` before the command runs are not in use; the git hooks and CI still hold.

The README now has `## Manual checks` with a `TODO(resaledger)` marker when `standards.md` listed none. Write the project's own text there; `handoff` asks for it. The 1.0 protocol is in the root `AGENTS.md`, and [the solo guide](solo.md) walks through it.

## Git LFS

When Git LFS wrote its hooks into `.githooks/`, `migrate` replaces its `pre-push`, tracked or not, because the 1.0 guard runs Git LFS's `pre-push` after its own checks in a repository whose tracked `.gitattributes` names `filter=lfs`. It leaves Git LFS's other hooks alone: when they are not tracked, they do not count as uncommitted changes, and the printed commit command leaves them out. The report names the replaced hook and says that after the undo command, `git lfs update --force` brings Git LFS's hooks back.

A rule that hides a hook `migrate` must commit, such as a `.githooks/pre-push` line in `.git/info/exclude`, is refused with its file and line. Remove the line, then run `migrate` again.

In every other clone, `git lfs install` then reports that a `pre-push` exists and stops. That is expected: it has set its filters all the same, and its other hooks, which only file locking needs, come from `git lfs update --manual`. [The solo guide](solo.md#git-lfs) shows what it prints.

## What can go wrong

`migrate` refuses, and changes nothing, when:

- **The tree has uncommitted changes.** Commit or stash them, so the migration is one reviewable change.
- **The repository is already migrated**, because `.resaledger.json` exists. Running it again after the commit above shows this:

  <!-- exits 1 -->

  ```bash
  npx resaledger migrate
  ```

  ```text
  ✖ resaledger migrate changed nothing:
  ✖ .resaledger.json exists: this repository is already migrated to ResaLedger 1.0
  ```

- **A file every 0.x workspace has is missing**, such as `work/ledger.md`.
- **A git hook was changed by hand.** It shows the difference. Move the change elsewhere, or run `migrate --force` to replace the hook.
- **The 0.x configuration uses `mode: guard`.** Guard-only mode is not part of 1.0; such repositories stay on 0.x.
- **The workspace folder's name breaks the 1.0 rule for `dir`**: letters, digits, `.`, `_` and `-`, in `/`-separated names. Rename the folder and `dir` in a commit of their own, then migrate.

It also stops when the result would break a 1.0 rule, such as a `doing` task without a plan, and lists each problem. Fix them in the 0.x records and commit, or run `migrate --accept-problems` to write anyway; the commit of the migration is then refused until they are fixed.

A `blocked` task gets its `Waiting for:` from the first "Waits for …" or "Blocked on …" phrase in its Notes, and `migrate` lists each one. Without such a phrase, it is a problem to fix.
