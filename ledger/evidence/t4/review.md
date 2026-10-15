# ResaLedger 1.0 · CI check review (T4)

Independent review by a second model, 2026-10-15, of commit `9f66e1f`. Scope: the CI check and what it leans on: `src/guard/ci.mjs`, `src/guard/enforcement.mjs`, `src/guard/managed.mjs`, `src/guard/report.mjs`, `templates/workflow.yml`, and the parts of `range.mjs`, `ownership.mjs`, `ids.mjs` and `adoption.mjs` that `ci` calls, judged against spec sections 5.9, 5.10, 6, 10 and 12. The approach was adversarial: every finding below was reproduced with the bundled guard (`node scripts/bundle.mjs --out …`) in real git repositories with simulated GitHub event files, the way `test/ci.test.mjs` does; the reproductions are at the end. The existing suites (`test/ci.test.mjs`, `test/ci-output.test.mjs`, 81 tests) pass on this commit.

## Findings

| # | Severity | Finding | Suggested fix |
| --- | --- | --- | --- |
| 1 | blocker | A pull request (or a direct push to the base) that deletes `.resaledger.json` in one commit and re-adds it in a later one moves the range start past all of its own commits: `adoptionStart` takes the newest commit reachable from the head that *added* the file, so `ci` reports "0 commits from the merge base to the head" and an unrecorded code commit passes every check. The net diff of the pull request shows no change to the configuration, so the files view hides it. `handoff` and pre-push share the function. | In `adoptionStart`, move the start only when `from` has no `.resaledger.json` (or `from` is null), and then to the *oldest* adding commit inside `from..to`, never past a `from` that already has the configuration. Add a test with a delete-and-re-add branch. |
| 2 | major | The gates run the pull request's code with `GITHUB_TOKEN` in their environment: the workflow passes the token to the step for the comment, and `runGates` inherits `process.env`. On a same-repository pull request that token has `pull-requests: write`, and any test, build script or dependency the gates execute can read it (spec 12 says the gates run "with no secrets"). | Run the gates with an environment that omits `GITHUB_TOKEN` (and ideally every `GITHUB_*`/`ACTIONS_*` variable): `runGates(commands, { root, env })` in `ciGatesCheck`. Alternatively post the comment from a separate step that alone receives the token. |
| 3 | major | An old decision lets a new weakening change through, against spec 10 ("an old decision never lets a new change through"): `addedDecisions` only asks whether the merge base has a file at the same *path*, so a decision already on the base, renamed with `git mv` or copied to a new name, counts as added, and the comment prints the original author as having decided the new change. Deleting a decision from the base is not detected either (spec 6.2: decisions are only ever added). | Treat a decision as added only when its *content* is not at the merge base under any path in `<dir>/decisions/` (compare blob ids or hashes). Separately, fail when the head lacks a decision or log file the merge base has (never deleted, as for tasks). |
| 4 | major | Ownership (the lead's finding, confirmed and extended): a lane stacked on another lane's claim commit can change that task (even finish it) and pass, and a lane branched from the base can claim a task with `Lane:` set to *another* lane's name and then commit code naming it. `ci` compares holders with the merge base and the base tip only, and the lane rule accepts any Lane set inside the range. Spec 6.2 requires that only the holding lane changes the file. | Yes, compare with the holding lane's branch. For every task in the head that is `doing`/`blocked` with a Lane that is not this lane and whose text differs from both the merge base's and the base's: resolve `refs/remotes/*/<Lane>` and `refs/heads/<Lane>` in the clone (the workflow fetches every branch), read that branch's copy of the file in one `cat-file --batch`, and require it to be byte-identical (a stacked, unchanged copy); when it differs or the branch is not in the clone, report "task X is held by lane Y and this branch's copy differs from Y's". Also require a task that *becomes* held in the pull request to name this lane unless it records a takeover. Cost: one ref lookup and one batched object read per foreign held task; no extra fetch. A lane that carries a stale copy of the holder's task then fails until it rebases on the holder, which is the right outcome. |
| 5 | major | A `dir` change can never pass, although spec 10 lists it as a weakening change a decision lets through: the records, ownership, ids and moved-tasks checks read the *head* with the *base's* `dir`, so the old folder is "missing its README" and every base task is "deleted". A project with one task cannot move its workspace. | Read each tree with its own valid configuration's `dir` (merge base, base, head) and compare tasks by id; keep every rule (gates, wip, protected, patterns) from the base. The enforcement check already flags the move and finds the decision in the new folder. |
| 6 | minor | A decision in a subfolder, such as `<dir>/decisions/archive/x.md`, counts for enforcement (`headReader.list` lists every depth) but the records check validates only the files directly in `decisions/`, so a "decision" with no Date and no Decided by lets a weakening change through, and the comment prints no name. | In `addedDecisions`, consider only Markdown files directly in `<dir>/decisions/`, as `loadWorkspace` does. |
| 7 | minor | When the working tree is not at the head, the gates run on whatever is checked out and the check still passes, with only a note. The shipped workflow checks out the head, but spec 10 invites other CI systems to call `ci --base --head`, and a checkout at the base or at a merge ref then passes a head that breaks a gate. | Fail the gates check when `gates.ranOn !== head` (keep the note as the reason). |
| 8 | minor | On a push to the base, every commit whose committer address is GitHub's is exempt, not only merge or squash commits. A commit made in GitHub's web editor on an unprotected base, or any commit made with `GIT_COMMITTER_EMAIL` set to that address, lands unrecorded code on the base and passes. Spec 12 leaves direct pushes to branch protection, so this is a weakness of the last line, not of the main one. | The committer address cannot be verified, so narrow what it buys: exempt a GitHub-committed commit only when it is a merge commit or its subject has GitHub's squash form (`… (#N)`), print in the output how many commits were exempt by committer, and say in the docs that the push check trusts the committer address and that the base must be protected. |
| 9 | minor | The enforcement comparison reads text only. A pull request that clears the executable bit of a hook (`git update-index --chmod=-x .githooks/pre-commit`) or removes `.gitattributes` (the line that keeps the hooks LF on Windows) reports "enforcement: unchanged", although the hook then no longer runs for anyone who clones. | Include the mode of each `.githooks/*` entry in the comparison (weakening when `100755` becomes `100644` or a symlink), and list a change to `.gitattributes`. |
| 10 | minor | Task titles and evidence are inserted into the comment with only `<` escaped, so Markdown renders: an image (`![](https://…/pixel.png)`, a tracking pixel), a link with misleading text, or bold "✔ passed" inside a task line. The hidden marker and HTML cannot be forged, and `<details>` cannot be closed. | Escape Markdown punctuation (`[ ] ( ) ! * _ \``) in `ciMarkdownText`, or render record text in code spans. |
| 11 | minor | A commit object the range reader refuses (for example two `committer` lines, which `git hash-object --literally` accepts) makes `ci` crash with a stack trace: exit 1, but no job summary and no comment, so the failure shows only in the log. | In `ciCommand`, treat any error from `ciResult` as "the check could not run": write `ciErrorMarkdown` and `fail`. |
| 12 | minor | The workflow's `dir` filter is stricter than the guard's `isSafeFolderPath`: a base configuration with `"dir": ".ledger"` (valid for the guard) makes the extraction `process.exit(1)` silently and the step fails with no message. | Use the same rule as the guard (allow a leading dot, forbid a leading dash), and print a message before exiting. |
| 13 | minor | `ci` accepts `pull_request_target` as an event name (`CI_PULL_REQUEST_EVENTS`). The template never uses it, but a team that edits its workflow to that event would then run the pull request's gates with a write token and secrets, and `ci` would not object. | Refuse `pull_request_target` with a message that points at spec 10. |
| 14 | minor | A decision that raises `wip` cannot be used in the same pull request that claims the extra task: the records check applies the base's `wip`, so the pull request fails on records while enforcement passes. Every weakening change that the records check also enforces needs two pull requests. | Either document the two-step path in the enforcement message, or apply the head's `wip` to the records check when the head's configuration is valid and the change is decided. |
| 15 | minor | Workflow hardening gaps: `actions/checkout@v4` and `actions/setup-node@v4` are pinned by mutable tag; the job has no `timeout-minutes` and no `concurrency`, so a pull request whose gates hang holds a runner for the 6-hour default on every push; and the CODEOWNERS lines cover `.github/workflows/resaledger.yml` only, so a second workflow file whose job is also named `resaledger` is not owner-protected (GitHub matches a required check by name). | Pin both actions by commit SHA, add `timeout-minutes` and a `concurrency` group with `cancel-in-progress`, and cover `/.github/workflows/` in the CODEOWNERS template. |

## Checked and found sound

- The rules come from the base: the workflow takes `dir` and the guard from the base commit (or the commit before a push), event values reach the shell only through environment variables, `dir` is validated before use, the head guard's version is restricted to `[0-9][0-9A-Za-z.+-]*` and quoted, `npm pack` runs with `--ignore-scripts`, and the checkout keeps no credentials. A head that swaps its guard for one that passes everything is judged by the base's guard and fails (the suite covers this).
- Enforcement ids match the spec table: all thirteen configuration ids with the right direction, plus `guard`, `hooks/<name>` and `workflow` by normalised hash, a removed file and a move back to an older release weakening, an unknown direction weakening. A misspelt `- weakens:` fails the records check *and* leaves the change undecided; a decision added and then removed inside the pull request does not count; a decision that names another id does not help.
- `--release`: a folder that is not a `resaledger` package stops the check. A crafted folder is trusted as given (its `released.json` can declare any hash as released), which is by design: the workflow only ever passes a folder that came from npm, and other CI systems own what they pass.
- `--only-base-pushes`: a push to a tag or a lane is skipped with a note; a push to the base or a protected branch is checked; the branch list comes from the before-commit's configuration.
- Missing history fails closed: a shallow clone, a missing `before` after a forced push (the runner's clone lacks the old tip), a missing commit, and unrelated histories all stop with a message, and the summary is written. A forced push to the base is judged from the merge base of before and after.
- Invalid or incomplete events stop with a message; unknown event names are refused.
- The comment: the marker cannot be forged from records (`<` is escaped), the comment is found by its first line and updated in place, a failing or unreachable API prints one warning and never changes the result, forks and pushes get no comment, and the pagination is bounded.
- Commit parsing: commits come from `rev-list` and `cat-file --batch`, never from formatted output; a message that cannot be parsed is an error, not a pass; CRLF and odd bytes in messages do not forge a trailer; a forged `This reverts commit` line without the inverse patch id exempts nothing; a forged GitHub committer exempts nothing in the pull request path.
- Ids: a new id that another branch or the base has in another file fails, the pull request's own branch (local and remote-tracking) is excluded, a fork's branch name does not exclude anything, and 551 branches cost about 11 s.
- Scale: a pull request of 1101 commits with 50 merges takes about 8 s on this machine.
- Spec-accepted gaps, confirmed as the spec describes them and not counted as findings: a merge that resolves a conflict may carry any content on the conflicted path without a task (5.9); a `git revert` of a base commit needs no task (5.9); `Task: maintenance` is accepted on any code change; with `ci.runGates: false` a hand-written stamp passes (12).

## Reproductions

Every script below assumes a bundled guard in `$GUARD`, an isolated git configuration (as `test/helpers.mjs` sets it), and these helpers. `mkrepo` makes a repository on `main` whose first commit holds the configuration given as its argument and a valid `ledger/README.md`.

```sh
GUARD=/path/to/records.mjs   # node scripts/bundle.mjs --out /path/to/records.mjs
T=${TMPDIR:-/tmp}            # scratch files of the reproductions
mkrepo() { rm -rf "$1"; mkdir "$1"; cd "$1"; git init -q -b main
  printf '%s\n' "${2:-{ \"version\": 2 }}" > .resaledger.json; mkdir -p ledger/tasks
  printf '# Shop\n\n## Goal\n\nA shop.\n\n## Environments\n\nLocal only.\n\n## Manual checks\n\nNone.\n' > ledger/README.md
  git add -A && git commit -q -m 'chore: set up' -m 'Task: maintenance'; }
task() { { printf '# %s %s\n\n- Status: %s\n' "$1" "$2" "$3"; [ -n "$4" ] && printf -- '- Lane: %s\n' "$4"
  [ "$3" = done ] && printf -- '- Evidence: `npm test`: 3 of 3\n'; [ "$3" = doing ] && printf '\n## Plan\n\nDo it.\n'; true; } > "ledger/tasks/$1.md"; }
ci_pr() { base=$(git rev-parse "$1"); head=$(git rev-parse "$2"); lane=$3; shift 3
  printf '{"number":7,"pull_request":{"number":7,"base":{"sha":"%s","ref":"main","repo":{"full_name":"t/s"}},"head":{"sha":"%s","ref":"%s","repo":{"full_name":"t/s"}}}}' "$base" "$head" "$lane" > "$T/ev.json"
  GITHUB_EVENT_NAME=pull_request GITHUB_EVENT_PATH="$T/ev.json" node "$GUARD" ci "$@"; }
ci_push() { printf '{"before":"%s","after":"%s","ref":"%s"}' "$(git rev-parse "$1")" "$(git rev-parse "$2")" "$3" > "$T/ev.json"; shift 3
  GITHUB_EVENT_NAME=push GITHUB_EVENT_PATH="$T/ev.json" node "$GUARD" ci "$@"; }
```

### 1 · Adoption start moved past the pull request's commits

```sh
mkrepo a; git checkout -q -b lane-a
printf 'evil\n' > src.js; git add -A; git commit -q -m 'feat: sneak code without a task'
git rm -q .resaledger.json; git commit -q -m 'chore: drop config'
git checkout -q main -- .resaledger.json; git commit -q -m 'chore: config again'
ci_pr main lane-a lane-a          # ✔ commits: 0 commits from the merge base to the head — exit 0
git checkout -q main; b=$(git rev-parse main); git merge -q --ff-only lane-a
ci_push "$b" main refs/heads/main --only-base-pushes   # ✔ commits: 0 commits pushed — exit 0
```

Expected: "feat: sneak code without a task" fails the commits check on both paths. Observed: both pass with 0 commits checked; `git log --diff-filter=A -- .resaledger.json` names the re-adding commit as the adoption start.

### 2 · The gates see `GITHUB_TOKEN`

```sh
mkrepo c '{ "version": 2, "gates": { "verify": ["node test.js"] } }'
printf 'console.log("ok")\n' > test.js; git add -A; git commit -q -m 'chore: test' -m 'Task: maintenance'
git checkout -q -b lane-c; task S1 Bread doing lane-c; git add -A; git commit -q -m 'chore: claim S1' -m 'Task: S1'
printf 'require("fs").writeFileSync("'"$T"'/leak.txt", String(process.env.GITHUB_TOKEN))\n' > test.js
git add -A; git commit -q -m 'test: read the token' -m 'Task: S1'
GITHUB_TOKEN=ghs_SECRET GITHUB_REPOSITORY=t/s ci_pr main lane-c lane-c >/dev/null 2>&1; cat "$T/leak.txt"   # ghs_SECRET
```

The gate command is the base's (`node test.js`); the head decides what `test.js` does. In the workflow the step's `env` carries `${{ github.token }}` with `pull-requests: write`.

### 3 · An old decision, renamed or copied, decides a new change

```sh
mkrepo b '{ "version": 2, "gates": { "verify": ["node -e \"process.exit(0)\""] } }'
mkdir -p ledger/decisions
printf '# Raise wip once\n\n- Date: 2026-01-05\n- Decided by: owner\n- Weakens: wip, gates.verify\n\nLong ago.\n' > ledger/decisions/2026-01-05-raise-wip.md
git add -A; git commit -q -m 'docs: an old decision'
git checkout -q -b lane-b; printf '{ "version": 2 }\n' > .resaledger.json
git mv ledger/decisions/2026-01-05-raise-wip.md ledger/decisions/2026-01-05-raise-wip-again.md
git add -A; git commit -q -m 'chore: drop the gate' -m 'Task: maintenance'
ci_pr main lane-b lane-b   # ✔ enforcement: 1 change, 1 weakening · gates.verify removed … decided in …raise-wip-again.md by owner
```

`cp` instead of `git mv` gives the same result. Deleting an old decision (`git rm` on a lane) passes every check.

### 4 · Ownership across lanes

```sh
mkrepo h; task S1 Bread todo; task S2 Flour todo; git add -A; git commit -q -m 'docs: tasks'
git checkout -q -b lane-a; task S1 Bread doing lane-a; git add -A; git commit -q -m 'chore: claim S1' -m 'Task: S1'
# H1: lane-b stacked on lane-a finishes lane-a's task
git checkout -q -b lane-b; printf 'bread\n' > bread.js; git add -A; git commit -q -m 'feat: bread' -m 'Task: S1'
task S1 Bread done lane-a; git add -A; git commit -q -m 'docs: finish S1 as lane-a'
ci_pr main lane-b lane-b   # ✔ ownership: 1 task changed · S1: todo → done — exit 0
# H2: lane-c from main claims S2 under another lane's name and codes for it
git checkout -q -b lane-c main; task S2 Flour doing lane-a; git add -A; git commit -q -m 'chore: claim' -m 'Task: S2'
printf 'flour\n' > flour.js; git add -A; git commit -q -m 'feat: flour' -m 'Task: S2'
ci_pr main lane-c lane-c   # ✔ ownership, ✔ commits — exit 0
```

Control: a lane stacked on `lane-a` that only claims its own `S2` passes, as it should, and must keep passing after the fix.

### 5 · A `dir` move with a decision never passes

```sh
mkrepo f; git checkout -q -b lane-f; mkdir -p records/decisions; git mv ledger/README.md records/README.md
printf '{ "version": 2, "dir": "records" }\n' > .resaledger.json
printf '# Move\n\n- Date: 2026-10-15\n- Decided by: owner\n- Weakens: dir\n\nMoved.\n' > records/decisions/2026-10-15-move.md
git add -A; git commit -q -m 'chore: move the ledger' -m 'Task: maintenance'
ci_pr main lane-f lane-f   # ✖ records: ledger/README.md: the workspace README is missing; ✔ enforcement: … decided in records/decisions/… — exit 1
```

With any task on the base, ownership adds "task … is deleted" for each.

### 6 · A nested, unvalidated decision

```sh
mkrepo b2 '{ "version": 2, "gates": { "verify": ["node -e \"process.exit(0)\""] } }'
git checkout -q -b lane-b2; printf '{ "version": 2 }\n' > .resaledger.json
mkdir -p ledger/decisions/archive; printf '# whatever\n\n- Weakens: gates.verify\n' > ledger/decisions/archive/x.md
git add -A; git commit -q -m 'chore: drop the gate' -m 'Task: maintenance'
ci_pr main lane-b2 lane-b2   # ✔ records: 0 decisions; ✔ enforcement … decided in ledger/decisions/archive/x.md — exit 0
```

The same file directly in `decisions/` fails the records check with three problems.

### 7 · Gates off the head only add a note

```sh
mkrepo g '{ "version": 2, "gates": { "verify": ["node -e \"process.exit(Number(require(\\\"fs\\\").existsSync(\\\"broken\\\")))\""] } }'
git checkout -q -b lane-g; task S1 Bread doing lane-g; printf 'yes\n' > broken
git add -A; git commit -q -m 'feat: break it' -m 'Task: S1'; git checkout -q main
ci_pr main lane-g lane-g   # ✔ gates on <base>: … ✔ (the working tree is at <base>, not at the head <head>) — exit 0
```

### 8 · A GitHub-committed code commit on a push to the base

```sh
mkrepo d; b=$(git rev-parse main); printf 'evil\n' > src.js; git add -A
GIT_COMMITTER_NAME=GitHub GIT_COMMITTER_EMAIL=noreply@github.com git commit -q -m 'Update src.js'
ci_push "$b" main refs/heads/main --only-base-pushes   # ✔ commits: 1 commit pushed — exit 0
```

### 9 · Hook mode and `.gitattributes`

```sh
mkrepo e; mkdir -p .githooks; for h in pre-commit pre-merge-commit commit-msg pre-push; do
  sed 's|{{dir}}|ledger|g' templates/hooks/$h > .githooks/$h; chmod +x .githooks/$h; done
printf '.githooks/* text eol=lf\n' > .gitattributes; git add -A; git commit -q -m 'chore: hooks' -m 'Task: maintenance'
git checkout -q -b lane-e; git update-index --chmod=-x .githooks/pre-commit; git commit -q -m 'chore: mode' -m 'Task: maintenance'
ci_pr main lane-e lane-e | grep enforcement   # ✔ enforcement: unchanged
git checkout -q -f -b lane-e2 main; git rm -q .gitattributes; git commit -q -m 'chore: attrs' -m 'Task: maintenance'
ci_pr main lane-e2 lane-e2 | grep enforcement   # ✔ enforcement: unchanged
```

### 10 · Markdown in the comment

```sh
mkrepo i; git checkout -q -b lane-i
printf '# S1 Bake ![](https://example.invalid/pixel.png) [approved](https://example.invalid/x) **✔ passed**\n\n- Status: done\n- Evidence: [all 200 tests](https://example.invalid/fake)\n' > ledger/tasks/S1.md
git add -A; git commit -q -m 'docs: S1'
GITHUB_STEP_SUMMARY="$T/summary.md" ci_pr main lane-i lane-i >/dev/null; cat "$T/summary.md"
# - **S1** Bake ![](https://example.invalid/pixel.png) [approved](https://example.invalid/x) **✔ passed** · new, done
```

### 11 · An unreadable commit crashes without a summary

```sh
mkrepo j; git checkout -q -b lane-j; printf 'x\n' > x.js; git add -A; git commit -q -m 'feat: x' -m 'Task: maintenance'
t=$(git rev-parse HEAD^{tree}); p=$(git rev-parse HEAD^)
bad=$(printf 'tree %s\nparent %s\nauthor T <t@x> 1700000000 +0000\ncommitter T <t@x> 1700000000 +0000\ncommitter T <t@x> 1700000000 +0000\n\nfeat: odd\n\nTask: maintenance\n' "$t" "$p" | git hash-object -t commit -w --stdin --literally)
git update-ref refs/heads/lane-j "$bad"
GITHUB_STEP_SUMMARY="$T/summary-j.md" ci_pr main lane-j lane-j; echo "exit=$?"; ls "$T/summary-j.md"
# Error: cannot read the commit … (stack trace), exit=1, no summary file
```

### 12 · The workflow step and a dotted `dir`

Extract the `run:` block of `templates/workflow.yml` to `step.sh` (as `test/ci-output.test.mjs` does) and run it with `bash -e -o pipefail` in a repository whose base configuration is `{ "version": 2, "dir": ".ledger" }` with the guard at `.ledger/scripts/records.mjs`, `EVENT=pull_request`, `BASE_SHA`/`HEAD_SHA` set, and `RUNNER_TEMP` pointing at an empty folder. `node … check` passes in that repository; the step exits 1 after `dir=` with no message (`bash -x` shows the `process.exit(1)` branch).

### 13 · `pull_request_target`

Run `GITHUB_EVENT_NAME=pull_request_target GITHUB_EVENT_PATH=<a pull_request event file> node "$GUARD" ci` in any repository of the reproductions: the check runs as a normal pull request.

### 14 · A decided `wip` raise still fails records

```sh
mkrepo v; for i in 1 2 3; do task S$i "T$i" doing lane-v; done; git add -A; git commit -q -m 'chore: three' -m 'Task: S1, S2, S3'
git checkout -q -b lane-v; mkdir -p ledger/decisions; printf '{ "version": 2, "wip": 4 }\n' > .resaledger.json
printf '# Four\n\n- Date: 2026-10-15\n- Decided by: owner\n- Weakens: wip\n\nFine.\n' > ledger/decisions/2026-10-15-four.md
task S4 T4 doing lane-v; git add -A; git commit -q -m 'chore: raise wip, claim S4' -m 'Task: S4'
ci_pr main lane-v lane-v   # ✖ records: … 4 tasks doing, more than the limit of 3; ✔ enforcement: wip raised … decided — exit 1
```

### 15 · Workflow hardening

Read `templates/workflow.yml`: `uses: actions/checkout@v4` and `uses: actions/setup-node@v4` (tags), no `timeout-minutes`, no `concurrency`; `templates/codeowners` lists `/.github/workflows/resaledger.yml` only. Not reproducible locally beyond inspection; the required-check-by-name behaviour is GitHub's.

### Scale and fail-closed checks (sound)

- 1101 commits with 50 merge commits in one pull request: about 8 s; 551 branches each with a task file, a new id in the pull request: about 11 s.
- A clone made with `git clone --no-local` after a forced push on the origin lacks the old tip; the workflow step then reports "commit … is not in this clone" and fails. A `before` of forty `a`s fails the same way. A `--depth 1` clone fails with the fetch hint (suite).
