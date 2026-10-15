# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| The latest 1.x release | Yes |
| Older 1.x releases | No: update to the latest 1.x |
| agent-ledger 0.x | No: migrate with `npx resaledger migrate` |

A fix is released as a new 1.x version. `npx resaledger update` brings the guard and the hooks in a repository up to it.

## Reporting a vulnerability

Report it privately, through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue, pull request or discussion for it.

Include the version (`npx resaledger version`), what you did, what you expected and what happened, and a script or the commands that reproduce it in a fresh repository if you can.

You get an answer within a few days. A confirmed problem is fixed in a new release, and the advisory credits you unless you ask otherwise.

## What counts

ResaLedger's trust model is in [section 12 of the specification](ledger/plan/spec.md#12-trust-model). It says which layer stops what. A vulnerability is a way past a layer that the trust model says should hold, for example:

- a commit, push or pull request that gets through the git hooks or the CI check although its rules refuse it, without `--no-verify`, a changed hooks path or a change to the workflow file;
- a pull request whose own changes weaken the rules it is judged by, such as its gates, its protected branches or its guard, without a decision naming the change;
- a stamp that CI accepts for code the gates did not pass on, when `ci.runGates` is on;
- the guard, a hook or the CI check running a command that the trusted configuration does not name;
- `init`, `update` or `migrate` writing outside the repository, losing records, or running something from the repository they are given.

What the trust model already lists as not stopped is not a vulnerability: `--no-verify` in a local clone, a clone with the hooks off, an administrator, or a pull request that removes the CI workflow itself. Problems in the projects ResaLedger runs as gates belong to those projects.

## Scope

In scope: the npm package `resaledger`, the guard it installs (`ledger/scripts/records.mjs` or the folder a project chose), the git hooks, the agent hook configurations, the CI workflow template and the plugin in this repository.

Out of scope: projects that use ResaLedger, and the GitHub, npm and agent platforms themselves.
