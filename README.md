<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/brand/cover-light.png">
  <img alt="ResaLedger. Parallel lanes. One ledger. A task ledger inside your repository that coding agents can't skip, can't fake and can't collide on." src="docs/assets/brand/cover-dark.png">
</picture>

# ResaLedger

A task ledger inside your repository that coding agents can't skip, can't fake and can't collide on.

Every task, decision and log entry is a Markdown file in the repository. Git hooks and CI refuse work that is not recorded, a stamp ties a passing test run to the exact code it ran on, and parallel lanes never edit the same file, so agents and people can work side by side without merge conflicts in the records.

**Status: in development.** ResaLedger 1.0 is being built in this repository and is not ready to install yet. The build is tracked in [`ledger/`](ledger/README.md) with ResaLedger itself: it moved from agent-ledger 0.3, the tool ResaLedger replaces, with its own `migrate`.

## How it works

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/how-it-works/how-it-works-light.svg">
  <img alt="Three lanes, agent-a, agent-b and you, carry commits T14, T15 and T16 towards a gate. A commit with no task hits the gate and is refused. The others pass, turn together into main without crossing, and a stamp lands on the verified code." src="docs/assets/how-it-works/how-it-works-dark.svg">
</picture>

Three lanes work at once. Each commit carries the task it belongs to. A commit with no task stops at the gate. The lanes run together into `main` without crossing, and a stamp lands on the exact code that passed its checks.

## Who it is for

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/readme/use-cases-light.svg">
  <img alt="Three ways to use ResaLedger: one person with three agents in worktrees; a team with pull requests and CI; an operations repository where content, ad data and decisions are records too." src="docs/assets/readme/use-cases-dark.svg">
</picture>

- **One person, three agents.** Each agent works in its own worktree and branch. None can commit without a task, and none edits another's.
- **A team with pull requests.** Claims are pushed, so everyone sees them at once. CI judges every pull request by the rules of main.
- **An operations repository.** Content, ad data and decisions are records too. Data passes its own checks before it lands.

## Where a bad commit stops

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/readme/layers-light.svg">
  <img alt="Four layers: AGENTS.md teaches the protocol; agent hooks stop --no-verify, forced pushes and edits on a protected branch; git hooks refuse a commit with no task; CI judges each pull request by the rules of main." src="docs/assets/readme/layers-dark.svg">
</picture>

1. **`AGENTS.md`** teaches every agent the protocol when its session starts.
2. **Agent hooks** stop `--no-verify`, forced pushes and edits on a protected branch before the command runs.
3. **Git hooks** refuse a commit with no task, invalid records, or a change to another lane's task.
4. **CI** judges each pull request by the rules of main, so whatever got past a hook stops there.

## License

[MIT](LICENSE) © Resaco Oy
