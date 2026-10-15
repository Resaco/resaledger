# The ResaLedger build workspace

Everything that belongs to the build rather than to the product: the plan, the tasks, the decisions, the log and the evidence. The build moved to ResaLedger's own 1.0 format on 2026-10-15, so live state is computed: run `node ledger/scripts/records.mjs work`.

Read in this order:

- [AGENTS.md](../AGENTS.md): the project's rules and the protocol.
- [plan/README.md](plan/README.md): the phases and the reasoning behind their order, and [plan/spec.md](plan/spec.md), the specification.
- [tasks/](tasks/): one file per task, with status, evidence and handoff.
- [decisions/](decisions/): what was decided, when and by whom.
- [log/](log/): what each session did.

## Goal

ResaLedger 1.0, the successor of agent-ledger 0.x: an open-source task ledger that lives in a git repository and enforces itself, for one developer with one agent or for many people and agents working in parallel branches. It replaces the 0.x format, in which every record lived in a few shared files that conflict as soon as work runs in parallel. The design is in [plan/spec.md](plan/spec.md). This build is finished when `1.0.0-rc.1` is tagged locally with every acceptance check in the plan passing, and the owner has the commands to publish it.

## Where the code is

`src/guard/` is the guard, bundled into one file by `scripts/bundle.mjs`; `src/cli/` and `bin/` are the package's command line (`init`, `update`, `migrate`); `templates/` holds what `init` writes; `test/` holds the tests, run with `npm test`; `docs/` holds the documentation and the brand assets.

This workspace runs the build's own guard. A development build is never a released version, so after a change to `src/guard/` is merged, rebuild and renew it with `node scripts/bundle.mjs && node bin/resaledger.mjs update --force` and commit it with that change's task.

## Environments

Local only. Publishing to npm, creating the public repository and pushing to it are the owner's steps.

## Manual checks

1. **The quickstart works as written.** Before a release candidate, the README's quickstart is run by hand in a new temporary repository, command by command. Passing: every command succeeds and prints what the README shows.
2. **The demo is real.** The terminal demo is recorded from an actual run, not edited. Passing: the recording's commands and output match a rerun.
3. **Nothing private leaves the machine.** Before anything is pushed, the history scan for local paths and private names finds nothing. Passing: the scan's command and its empty result are recorded as evidence.

## At migration

The state on 2026-10-15, when this workspace moved from agent-ledger 0.x to ResaLedger 1.0, from its status file.

### Phase

Building. Done: the foundation (F), the record format (R), the git hooks (H), the end-of-session check (V3), the daily commands `work`, `work --all`, `task`, `new` and `claim` (W1–W4), the CI check (C1), the agent hooks for Claude Code and Codex (A1), `init` and `update` (I1, I3), `migrate` with its verification on real workspaces and the fixes from its review (M2, M3, T5), the parallel-lanes acceptance test (T1), the brand identity and the README graphics (G2–G4), and the fixes from the review of the guard (T3.1–T3.3, A1.1).

### Waiting for the owner

- Nothing. The owner pushes when a batch is ready.
