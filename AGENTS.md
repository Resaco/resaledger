# ResaLedger

## Project rules

1. **This repository will be public.** No local paths, no names of private projects, clients or people other than the maintainer, no internal addresses, and nothing derived from private projects, not even anonymised numbers, in files, images or commit messages. A hygiene test will scan every tracked text file, and the history is scanned before anything is pushed. Reason: the repository is its own showcase, and history is hard to clean after publishing.
2. **Agents never push, publish or post.** Creating the public repository, pushing, publishing to npm and announcing are the owner's steps; agents prepare them and write down the exact commands. Reason: these are the owner's and the organisation's decisions.
3. **Nothing copied into a user's repository has a runtime dependency.** Reason: it must work in a fresh clone and in a cloud agent that has nothing installed.
4. **Other repositories on the maintainer's machine are read-only references.** Evidence taken from them is summarised here without names. Reason: they belong to other projects and other people.
5. **The specification is the contract.** A change to a decision in [plan/spec.md](ledger/plan/spec.md) needs the owner's approval, recorded in [a decision](ledger/decisions/), before the code follows it. Reason: the format is a public interface that other people's repositories will depend on.

<!-- resaledger:start · managed by ResaLedger; `npx resaledger update` rewrites this block -->
## How work is recorded here

This repository keeps its task ledger in `ledger/`. Git hooks and a CI check refuse work that is not recorded.

1. Start every session with `node ledger/scripts/records.mjs work`. It turns on the git hooks in this clone and shows what is in progress (read its Handoff), what waits for the owner and what is ready.
2. Take a task with `node ledger/scripts/records.mjs claim <id>`. Work you find on the way becomes its own task: `node ledger/scripts/records.mjs new --under <id> "<title>"`.
3. Commit each working step yourself, with `Task: <id>` as the last line of the message. Do not wait to be asked to commit, and never use `--no-verify`.
4. When the code is committed, run `node ledger/scripts/records.mjs verify`. It runs the project's checks and records that they passed on exactly this code. Commit the stamp it writes.
5. Before you stop, update the task file: its Status, its Evidence when it is done (a command and its result, or a link someone else can open), and its Handoff when it is not. Then run `node ledger/scripts/records.mjs handoff`.

Decisions go into `ledger/decisions/` on the day they are made: `node ledger/scripts/records.mjs new decision "<title>"`.
<!-- resaledger:end -->
