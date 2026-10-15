# D2 Guides

- Status: done
- Lane: d2-guides
- Depends on: W4, C3, A3, I3
- Plan: [D-docs.md](../plan/D-docs.md#d2-guides)
- Evidence: `node scripts/test.mjs` on Node 24.18.0, 22.23.3 and 20.20.2: 959 of 959 each, with `test/guides.test.mjs` running every runnable command of [the guides](../../docs/guides/) in temporary repositories; [docs/README.md](../../docs/README.md) is the index.

## Notes

What was built:

- `docs/guides/`: `concepts.md`, `solo.md`, `team.md`, `ci.md`, `agents.md` and `migration.md`, and `docs/README.md` as the index, linking the guides and `format.md`, which D1 writes.
- `test/guides.test.mjs` runs every `bash` block of every guide, in order, in a temporary repository built for that guide (a bakery shop's project; with a bare `origin` for the team guide; a team setup with a lane for the CI guide; an agent-ledger 0.3 workspace with an unmerged lane for migration). An `npx` shim on PATH runs `bin/resaledger.mjs`. The `cd` of one block carries to the next.
- Directives, as HTML comments before a block: `<!-- not run: <reason> -->` skips it and the test lists it; `; stand-in: <command>` runs a local stand-in, such as moving the bare remote's `main` where a merge on GitHub would; `<!-- exits <n> -->` sets the expected exit code.
- A `text` block after a command is its output: each line must be a whole line of what the command printed, trimmed. A line with `…` is not compared; hashes, dates and durations may differ. So the output in the guides is checked against the build on every run, not only when written.
- The test also checks that every relative link in `docs/` resolves, anchors included (`docs/format.md` may be missing until D1 lands), that every fenced block has a language, and that the index links every guide.

Choices:

- Not run, and listed by the test: `gh` commands (pull requests, branch protection, the squash setting), the plugin marketplace installs and the skill's clone (GitHub), the `npm pack` of a release for `--release` (the registry), starting an agent, and the rebase path of the migration guide (an alternative to the merge the guide runs).
- The guides test is skipped on Windows: the guides are shell sessions, and the test does not set up Git Bash.
- The install commands name the repository as `Resaco/resaledger`, as `package.json` and the plugin manifest do.
- Every guide follows what you get, the steps, what you see, what can go wrong.
