# C — The CI check

Status: proposal · 2026-10-15 · part of the plan the owner reviews

The same rules as the hooks, where they cannot be bypassed, judged by the rules of the branch a pull request merges into ([spec section 10](spec.md#10-ci)).

### C1 The CI check

Goal: `ci` enforces the rules on a pull request and on a push to the base branch.

Design:
- **Input.** It reads the GitHub event (a pull request or a push), or `--base` and `--head`.
- **The rules** come from the base commit: the workflow runs the base commit's guard with the base commit's configuration.
- **On a pull request** it checks:
  - the records in the head;
  - V2 from the merge base to the head;
  - ownership and deleted tasks, against the base;
  - ids, against the base and the other open branches;
  - evidence on every task that becomes `done`;
  - the gates, run again with the base's commands. With `ci.runGates: false`, the head's stamp is checked instead.
- **On a push** it checks the records and the new commits, with the exemptions.
- **The first pull request** that adds ResaLedger is judged by its own rules, and the output says so.

Acceptance: a simulated event file for each rule, plus pull requests from forks and pushes after a squash merge and after a merge commit.

### C2 Changes to enforcement

Goal: a pull request cannot quietly weaken the rules that judge it.

Design:
- Compare the base and the head: the configuration, the guard, the hooks and the workflow.
- Classify each change.
- A weakening change, from the list in the specification, fails unless the pull request adds a decision file that names it.
- An update of the guard to a released version is listed and does not fail.

Acceptance: one test per kind of weakening, with a decision and without one. An update to a released guard passes.

### C3 Output, workflow and templates

Goal: people see what a pull request moves.

Design:
- **The summary.** The job summary is written every time.
- **The comment.** When the token may write, as it may for pull requests from the same repository, one comment is posted and then updated in place through the REST API. A failure to comment never fails the check.
- **The workflow template** runs on `pull_request` and `push`. It is read-only by default, with `pull-requests: write` for the comment, and has a step that takes the guard from the base.
- **Pull request template.** It has a `Task:` line.
- **CODEOWNERS.** A snippet for the team guide.

Acceptance:
- The summary and the comment are rendered from fixtures.
- The comment call is mocked.
- The workflow template is validated.
