# CI

The git hooks run on each person's machine, and anyone can turn them off there. CI is the layer nobody skips: it checks every pull request and every push to the base branch with the rules of the base branch, so a pull request cannot weaken the check that judges it.

This guide covers GitHub Actions with the shipped workflow, and any other CI system with `ci --base <ref> --head <ref>`.

## What the check does

On a pull request, `ci`:

- validates the records in the head;
- checks every commit from the merge base to the head, each against its own tree: a commit that changes code names a task its lane holds;
- refuses a change to a task another lane holds, and a deleted task that someone holds;
- refuses a task id that also exists, as a different task, on the base or in another open branch;
- wants evidence on every task that becomes `done`;
- runs the gates on the head, with the base's commands, or with `ci.runGates: false` in the configuration, wants a stamp for the head's code instead;
- lists every change to the enforcement files and fails a weakening one unless the pull request adds a decision that names it ([the team guide](team.md#a-deliberate-loosening-needs-a-decision)).

On a push to the base, it validates the records and checks the new commits. It leaves out merge commits and the commits GitHub makes when it merges a pull request, which were checked in the pull request, so squash merges work.

It exits with 0 when every check passes and with 1 when one fails or the check cannot run.

## GitHub Actions

The team preset writes the workflow, `.github/workflows/resaledger.yml`. A solo project adds it with:

```bash
npx resaledger update --workflow
```

Commit it with `Task: maintenance`. Nothing else is needed: no secrets, and no setting in the workflow names your branches or your workspace folder.

What the workflow does:

1. **It runs on every pull request and every push.** A workflow file cannot name the base branch that only `.resaledger.json` knows, so it passes `--only-base-pushes`: a push to a lane branch is noted and not checked, because its commits are checked in their pull request.
2. **It checks out the head with its whole history** (`fetch-depth: 0`), without keeping the token in the clone.
3. **It takes the rules from the base.** It reads `dir` from the base commit's `.resaledger.json`, takes that commit's guard, `<dir>/scripts/records.mjs`, and runs it in the head's checkout. For a push, the commit before the push stands in for the base. The first pull request that adds ResaLedger has no base rules, so it is judged by its own, and the output says so.
4. **It handles guard updates.** When the head's guard names another version, it fetches that release from npm and passes it with `--release` ([below](#updates-to-the-guard)).

Its permissions are read-only, apart from `pull-requests: write` for its one job, so it can comment. It runs on `pull_request`, never on `pull_request_target`, so a pull request from a fork runs its gates without secrets and with a read-only token.

### What you see

The check writes the same Markdown to the job summary and, on a pull request from the same repository, to one comment that it updates on each run. It lists each task the pull request moves, with its evidence, and the result of each check. A pull request from a fork gets no comment, because its token cannot write; the job summary still has everything. A failure to comment prints a warning and never changes the result.

Make the check required, and protect the workflow with CODEOWNERS: [the team guide](team.md#make-resaledger-a-required-status-check) shows both.

## Other CI systems

Run the same steps from your CI system's script. The examples start in a clone of a lane, `t1-add-a-price-list`, that has a pull request into `main`.

**1. Fetch the whole history.** The check reads every commit between the base and the head, and the other open branches for the id check. A shallow clone is not enough.

```bash
git fetch --quiet origin
```

**2. Take the guard from the base.** Read `dir` from the base's configuration, and write the base's guard outside the checkout:

```bash
dir=$(git show origin/main:.resaledger.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).dir ?? "ledger"')
git show "origin/main:${dir}/scripts/records.mjs" > ../records.mjs
```

**3. Check a pull request** with `--base`, `--head` and `--lane`, the pull request's source branch:

```bash
node ../records.mjs ci --base origin/main --head HEAD --lane t1-add-a-price-list
```

```text
ResaLedger ci: pull request from "t1-add-a-price-list", head …
Rules from the base ….
✔ records: 1 task, 0 decisions, 0 log entries
✔ commits: 2 commits from the merge base to the head
✔ ownership: 1 task changed
✔ tasks moved: 1
T1 Add a price list: new, doing
✔ enforcement: unchanged
```

**4. Check a push to the base** without `--lane`. `--base` is the commit before the push and `--head` the commit after it. Run it only for pushes to the base branch; outside GitHub Actions, `--only-base-pushes` cannot tell which branch was pushed.

```bash
before=$(git rev-parse HEAD~1)
after=$(git rev-parse HEAD)
node ../records.mjs ci --base "$before" --head "$after"
```

```text
ResaLedger ci: push, …
✔ commits: 1 commit pushed
```

Outside GitHub Actions there is no job summary and no comment; the output above is the report.

### Updates to the guard

The base's guard cannot know a release newer than itself. When a pull request updates the guard, fetch the release that the head's guard names on its second line, and pass the unpacked package with `--release`. `ci` then counts that release's guard, hooks and workflow as released, and the update passes without a decision.

<!-- not run: needs the npm registry -->

```bash
version=$(git show "HEAD:${dir}/scripts/records.mjs" | sed -n '2s|^// ResaLedger ||p')
mkdir -p ../release
(cd ../release && npm pack --silent --ignore-scripts "resaledger@${version}" && tar -xzf resaledger-*.tgz)
node ../records.mjs ci --base origin/main --head HEAD --lane t1-add-a-price-list --release ../release/package
```

`--ignore-scripts` keeps the package's scripts from running. A folder that is not a built `resaledger` package stops the check. Without registry access, run the check without `--release`; the update then needs a decision that names it.

## What can go wrong

- **No event and no flags.** Outside GitHub Actions, `ci` needs `--base` and `--head`:

  <!-- exits 1 -->

  ```bash
  node ../records.mjs ci
  ```

  ```text
  resaledger: no CI event found: run ci in GitHub Actions, or pass --base <rev> --head <rev> [--lane <branch>]
  ```

- **The head's guard instead of the base's.** Running the head's own `records.mjs` works, and it still takes the configuration from the base, but the code that judges the pull request is then the pull request's. Take the guard from the base, as in step 2.
- **A shallow clone.** The commits between the merge base and the head are missing, and the check cannot run. Fetch the whole history.
- **Gates that need a service.** CI runs the gates on the head. If a verify gate needs a database or a browser, set it up in the CI job before the check, or set `ci.runGates` to `false` and commit a stamp from `verify` with each pull request. Turning `runGates` off is a weakening change, so it needs a decision.
