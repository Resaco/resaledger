# Working as a team

This guide sets ResaLedger up for a team that merges through pull requests on GitHub. You get a protected base branch that nobody commits to directly, claims that are pushed so everyone sees them at once, and a CI check that judges every pull request with the rules of the base branch.

You need what [the solo guide](solo.md) needs, and a clone of a GitHub repository with `origin` set. Some steps happen on GitHub; they are marked, and the [`gh` command line](https://cli.github.com/) does them from the terminal.

## Set it up with the team preset

```bash
npx resaledger init --team
```

The team preset writes what the solo preset writes, and also the CI workflow and a pull request template. It protects `main`, so the setup itself goes through a pull request:

```text
resaledger init: ResaLedger is set up in ledger/, with the team preset
.github/pull_request_template.md
.github/workflows/resaledger.yml
2. "main" is protected, so commit the setup on a new branch:
3. Push it and open a pull request into main; the first pull request that adds ResaLedger is judged by its own rules:
git push -u origin resaledger-setup
5. Protect the enforcement files: add these lines to .github/CODEOWNERS, with your own owners, and make "resaledger" a required status check:
/.resaledger.json @your-org/maintainers
/ledger/scripts/records.mjs @your-org/maintainers
/.githooks/ @your-org/maintainers
/.github/workflows/resaledger.yml @your-org/maintainers
/.github/CODEOWNERS @your-org/maintainers
```

What the preset sets, in `.resaledger.json` and its defaults:

- `protected` is `["main"]`: the git hooks and the agent hooks refuse commits and pushes on `main`.
- `claimPush` is on: `claim` commits the claim on a new lane branch and pushes it.
- `requirePushed` is on: `handoff` wants the lane pushed.

`node ledger/scripts/records.mjs config` prints every setting with its default filled in.

Fill in the README, then commit the setup on the branch `init` named, and push it:

```bash
cat > ledger/README.md <<'EOF'
# bakery-shop

## Goal

An online shop for a small bakery.

## Environments

Local only.

## Manual checks

None.
EOF
git switch -c resaledger-setup && git add .gitattributes .github/pull_request_template.md .github/workflows/resaledger.yml .resaledger.json AGENTS.md ledger/README.md ledger/scripts/records.mjs && git add --chmod=+x .githooks/commit-msg .githooks/pre-commit .githooks/pre-merge-commit .githooks/pre-push && git commit -m "chore: set up ResaLedger" -m "Task: maintenance"
git push -u origin resaledger-setup
```

Open the pull request and merge it. The first pull request that adds ResaLedger has no rules before it, so CI judges it by its own and says so:

<!-- not run: needs GitHub; stand-in: git -C ../origin.git update-ref refs/heads/main refs/heads/resaledger-setup -->

```bash
gh pr create --fill
gh pr merge --merge
```

Then bring `main` up to date:

```bash
git switch main
git pull --ff-only
```

## Make `resaledger` a required status check

The workflow's job is called `resaledger`, and so is its status check. Make it required, so a pull request cannot merge while the check fails.

On GitHub: **Settings → Branches**, add a branch protection rule for `main` (or a ruleset that targets it), turn on **Require status checks to pass before merging** and add `resaledger`. While you are there, turn on **Require a pull request before merging** and **Require review from Code Owners**.

The same with `gh`:

<!-- not run: needs GitHub -->

```bash
gh api -X PUT "repos/{owner}/{repo}/branches/main/protection" --input - <<'EOF'
{
  "required_status_checks": { "strict": false, "checks": [{ "context": "resaledger" }] },
  "enforce_admins": true,
  "required_pull_request_reviews": { "require_code_owner_reviews": true, "required_approving_review_count": 1 },
  "restrictions": null
}
EOF
```

The check appears in the list only after the workflow has run once, on the setup pull request.

## Protect the enforcement files with CODEOWNERS

CI judges each pull request with the base branch's rules, so a pull request cannot loosen the check that judges it. One file is beyond its reach: the workflow that runs the check, because GitHub runs a pull request's own copy of it. CODEOWNERS makes a change to that file, and to the other enforcement files, wait for a review from the people who own the rules.

Write the lines `init` printed into `.github/CODEOWNERS`, with your own team or people in place of `@your-org/maintainers`. `main` is protected, so this goes through a pull request too:

```bash
git switch -c codeowners
cat > .github/CODEOWNERS <<'EOF'
# ResaLedger's enforcement files: a change to them needs a review from these owners.
/.resaledger.json @bakery/maintainers
/ledger/scripts/records.mjs @bakery/maintainers
/.githooks/ @bakery/maintainers
/.github/workflows/resaledger.yml @bakery/maintainers
/.github/CODEOWNERS @bakery/maintainers
EOF
git add .github/CODEOWNERS
git commit -m "chore: protect the enforcement files" -m "Task: maintenance"
git push -u origin codeowners
```

<!-- not run: needs GitHub; stand-in: git -C ../origin.git update-ref refs/heads/main refs/heads/codeowners -->

```bash
gh pr create --fill
gh pr merge --merge
```

```bash
git switch main
git pull --ff-only
```

## Keep the `Task:` line in squash merges

A squash merge makes one new commit on `main` from the pull request. CI checks the pull request's own commits, so enforcement holds either way. To keep the `Task:` line in `main`'s history as well, have GitHub take the squash commit's message from the pull request:

On GitHub: **Settings → General → Pull Requests**, under **Allow squash merging**, set the default commit message to **Pull request title and description**.

The same with `gh`:

<!-- not run: needs GitHub -->

```bash
gh api -X PATCH "repos/{owner}/{repo}" -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY
```

The pull request template that `init` wrote ends with a `Task:` line. Fill in the task's id there, and the squash commit names it.

## A day's work

Everyone starts with `work`. The team preset fetches before it claims, so it sees claims that others pushed:

```bash
node ledger/scripts/records.mjs work
```

```text
ResaLedger · lane main · team · hooks on · not verified
```

Plan a task on `main` and claim it. On a protected base, `claim` creates the lane branch, commits the claim on it and pushes it:

```bash
node ledger/scripts/records.mjs new "Add a price list"
cat >> ledger/tasks/T1-add-a-price-list.md <<'EOF'

## Plan

A page with every bread and its price. Done when `npm test` passes.
EOF
node ledger/scripts/records.mjs claim T1
```

```text
✔ created ledger/tasks/T1-add-a-price-list.md
✔ T1 claimed on the new branch t1-add-a-price-list from main, committed and pushed to origin/t1-add-a-price-list
```

Work on the lane as in the solo guide: commit with `Task: T1`, verify, finish the task with evidence:

```bash
echo "export const prices = { rye: 4 }" > prices.js
git add prices.js
git commit -m "feat: add a price list" -m "Task: T1"
node ledger/scripts/records.mjs verify
cat > ledger/tasks/T1-add-a-price-list.md <<'EOF'
# T1 Add a price list

- Status: done
- Lane: t1-add-a-price-list
- Evidence: `npm test`: passes

## Plan

A page with every bread and its price. Done when `npm test` passes.
EOF
git add ledger
git commit -m "docs: finish T1" -m "Task: T1"
```

In the team preset, `handoff` also wants the lane pushed:

<!-- exits 1 -->

```bash
node ledger/scripts/records.mjs handoff
```

```text
✖ Not ready to hand off
the lane "t1-add-a-price-list" has 2 unpushed commits: run git push
```

```bash
git push
node ledger/scripts/records.mjs handoff
```

```text
✔ handed off: records valid, the gates passed on this code, every task in progress has a current handoff note, the lane is pushed
```

Before you open the pull request, you can run the check CI will run. [CI](ci.md) explains the command:

```bash
node ledger/scripts/records.mjs ci --base origin/main --head HEAD --lane t1-add-a-price-list
```

```text
Rules from the base ….
✔ tasks moved: 1
T1 Add a price list: new, done · Evidence: `npm test`: passes
✔ enforcement: unchanged
```

Open the pull request. Write `Task: T1` on the template's last line:

<!-- not run: needs GitHub; stand-in: git -C ../origin.git update-ref refs/heads/main refs/heads/t1-add-a-price-list -->

```bash
gh pr create --title "feat: add a price list" --body "A price list page.

Task: T1"
gh pr merge --squash
```

CI comments on the pull request with what it moves: T1 from new to done, with its evidence.

## A deliberate loosening needs a decision

CI lists every change to the enforcement files: the configuration, the guard, the git hooks and the workflow. A change that weakens enforcement fails the check unless the pull request adds a decision that names it, so reviewers see who decided.

Here a lane raises the limit of tasks in progress per lane from 3 to 5:

```bash
git switch main
git pull --ff-only
node ledger/scripts/records.mjs new "Allow five tasks at once"
cat >> ledger/tasks/T2-allow-five-tasks-at-once.md <<'EOF'

## Plan

Raise the limit of tasks in progress per lane to 5.
EOF
node ledger/scripts/records.mjs claim T2
node -e '
  const fs = require("fs")
  const config = JSON.parse(fs.readFileSync(".resaledger.json", "utf8"))
  config.wip = 5
  fs.writeFileSync(".resaledger.json", JSON.stringify(config, null, 2) + "\n")
'
git commit -am "chore: allow five tasks at once" -m "Task: T2"
```

<!-- exits 1 -->

```bash
node ledger/scripts/records.mjs ci --base origin/main --head HEAD --lane t2-allow-five-tasks-at-once
```

```text
✖ enforcement: 1 weakening change no decision names; 1 change, 1 weakening
✖ wip raised from 3 to 5: this weakens enforcement, and no decision this pull request adds names it. Add one in ledger/decisions/ with the line "- Weakens: wip"
```

Write the decision, with a `Weakens:` line that names the change by the id CI printed. Several ids are separated by commas: `- Weakens: wip, gates.verify`.

```bash
node ledger/scripts/records.mjs new decision "Allow five tasks at once per lane"
decision=$(ls ledger/decisions/*-allow-five-tasks-at-once-per-lane.md)
awk '{ print } /^- Status:/ { print "- Weakens: wip" }' "$decision" > decision.md
mv decision.md "$decision"
cat >> "$decision" <<'EOF'
Five people share the shop now, and each runs agents on more than three tasks.
EOF
cat "$decision"
```

```text
# Allow five tasks at once per lane
- Date: 2026-10-15
- Decided by: alice
- Status: accepted
- Weakens: wip
```

The `Weakens:` line belongs in the list of fields, right under `Status:`. Below a blank line it is text, and CI does not read it.

```bash
git add ledger
git commit -m "docs: decide to allow five tasks at once" -m "Task: T2"
node ledger/scripts/records.mjs ci --base origin/main --head HEAD --lane t2-allow-five-tasks-at-once
```

```text
✔ enforcement: 1 change, 1 weakening
```

Only a decision that the pull request adds counts, so an old decision never lets a new change through. The ids, and which changes weaken, are listed in [the format reference](../format.md).

## Updating the guard

`npx resaledger update` renews the guard, the git hooks, the workflow and the `AGENTS.md` block when they are a released version. A file changed by hand is shown and kept. On a protected `main`, run it on a lane branch:

```bash
git switch -c update-resaledger
npx resaledger update
```

```text
Nothing to change.
```

When it changes something, it prints the commit to make; push it and open a pull request.

The base's guard cannot know a release newer than itself, so it would count the new guard as a change by hand. The workflow handles this: when the head's guard names another version on its second line, it fetches that version from npm and runs the check with `--release`, which counts the release's files as released. An update to a real release passes without a decision. The step is in the workflow; for other CI systems, see [CI](ci.md#updates-to-the-guard).

If the CI runner cannot reach npm, the workflow prints a warning and the update needs a decision that names `guard`, the hooks and the workflow it changes.

## What can go wrong

Nobody commits on the protected base, not even a merge:

<!-- exits 1 -->

```bash
git switch main
git commit --allow-empty -m "chore: try main" -m "Task: maintenance"
```

```text
✖ This commit is refused
```

- **A task claimed twice.** Two people claim the same task before either has fetched. `claim` fetches first in the team preset, so this is rare; when it happens, CI reports the task held in two open branches. One of them gives it up, or takes it over with `claim <id> --take`.
- **A stale claim.** A lane's branch is merged or deleted while its task is still `doing`. `work --all --fetch` shows it; take it over with `claim <id> --take`.
- **Someone changes the workflow in a pull request.** GitHub runs that pull request's copy of the workflow. CI lists the change and fails it without a decision, but a pull request that removes the check never runs it. CODEOWNERS and the required check close that gap.
