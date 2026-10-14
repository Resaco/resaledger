# agent-ledger workspace

Everything that belongs to the build rather than to the product: the plan, the task ledger, the rules for working here and the evidence.

Read in this order:

- [STATUS.md](STATUS.md): where the work stands right now. Read this first.
- [AGENTS.md](AGENTS.md): the rules and the session protocol.
- [work/ledger.md](work/ledger.md): every task, in order, with status and evidence.
- [plan/README.md](plan/README.md): the phases and the reasoning behind their order.
- [standards.md](standards.md): formats, quality gates and which file owns which fact.
- [DECISIONS.md](DECISIONS.md): what was decided, when and by whom.

## What is being built

agent-ledger 1.0: an open-source task ledger that lives in a git repository and enforces itself, for one developer with one agent or for many people and agents working in parallel branches. It replaces the 0.x format, in which every record lived in a few shared files that conflict as soon as work runs in parallel. The design is in [plan/spec.md](plan/spec.md). This build is finished when `1.0.0-rc.1` is tagged locally with every acceptance check in the plan passing, and the owner has the commands to publish it.

## Where the code is

None yet. The build creates them from the plan: the command-line package, the guard that is copied into repositories, its templates, the skill, the documentation and the tests.

## Environments

Local only. Publishing to npm, creating the public repository and pushing to it are the owner's steps.
