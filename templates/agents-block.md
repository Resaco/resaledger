<!-- resaledger:start · managed by ResaLedger; `npx resaledger update` rewrites this block -->
## How work is recorded here

This repository keeps its task ledger in `{{dir}}/`. Git hooks and a CI check refuse work that is not recorded.

1. Start every session with `node {{dir}}/scripts/records.mjs work`. It turns on the git hooks in this clone and shows what is in progress (read its Handoff), what waits for the owner and what is ready.
2. Take a task with `node {{dir}}/scripts/records.mjs claim <id>`. Work you find on the way becomes its own task: `node {{dir}}/scripts/records.mjs new --under <id> "<title>"`.
3. Commit each working step yourself, with `Task: <id>` as the last line of the message. Do not wait to be asked to commit, and never use `--no-verify`.
4. When the code is committed, run `node {{dir}}/scripts/records.mjs verify`. It runs the project's checks and records that they passed on exactly this code. Commit the stamp it writes.
5. Before you stop, update the task file: its Status, its Evidence when it is done (a command and its result, or a link someone else can open), and its Handoff when it is not. Then run `node {{dir}}/scripts/records.mjs handoff`.

Decisions go into `{{dir}}/decisions/` on the day they are made: `node {{dir}}/scripts/records.mjs new decision "<title>"`.
<!-- resaledger:end -->
