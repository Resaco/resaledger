<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/brand/cover-light.png">
  <img alt="ResaLedger. Parallel lanes. One ledger. A task ledger inside your repository that coding agents can't skip, can't fake and can't collide on." src="docs/assets/brand/cover-dark.png">
</picture>

# ResaLedger

A task ledger inside your repository that coding agents can't skip, can't fake and can't collide on.

Every task, decision and log entry is a Markdown file in the repository. Git hooks and CI refuse work that is not recorded, a stamp ties a passing test run to the exact code it ran on, and parallel lanes never edit the same file, so agents and people can work side by side without merge conflicts in the records.

**Status: in development.** ResaLedger 1.0 is being built in this repository and is not ready to install yet. The build is tracked in [`ledger/`](ledger/README.md) with agent-ledger 0.3, the tool ResaLedger replaces; the repository moves to its own 1.0 format before the release.

## How it works

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/how-it-works/how-it-works-light.svg">
  <img alt="Three lanes, agent-a, agent-b and you, carry commits T14, T15 and T16 towards a gate. A commit with no task hits the gate and is refused. The others pass, turn together into main without crossing, and a stamp lands on the verified code." src="docs/assets/how-it-works/how-it-works-dark.svg">
</picture>

Three lanes work at once. Each commit carries the task it belongs to. A commit with no task stops at the gate. The lanes run together into `main` without crossing, and a stamp lands on the exact code that passed its checks.

## License

[MIT](LICENSE) © Resaco Oy
