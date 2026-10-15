# Good first issues (drafts)

Drafts for the public repository, written for [spec section 18](../../plan/spec.md#18-launch): an agent adapter, a gate detector and documentation gaps. They stay drafts until the repository exists; the owner opens them with the label `good first issue`. Each one is small, has its place in the code, and has a test pattern to copy.

## 1. Detect `deno task` gates

`init` finds gates from `package.json`, `Makefile`, `pyproject.toml`, `Cargo.toml` and `go.mod` ([spec 13](../../plan/spec.md#13-installation-and-distribution)). A Deno project with a `deno.json` or `deno.jsonc` gets none.

- Add `deno.json` and `deno.jsonc` as a source: `deno lint` and `deno fmt --check` for `commit`, `deno test` for `verify`, plus `deno task <name>` for tasks named `lint`, `test` or `build`.
- Keep the rule that every candidate runs once, offline, and is kept only when it passes.
- Where: `src/cli/detect.mjs`. Tests: copy a case from `test/detect.test.mjs` that stubs the tool on `PATH`.
- The list in section 13 is part of the specification, so the owner records a decision before the code changes ([AGENTS.md](../../../AGENTS.md), rule 5).
- Done when: `npx resaledger init --yes` in a Deno project writes the gates that pass, and section 13 names Deno.

## 2. An agent adapter for one more agent

`hook <agent> <event>` serves five agents through one shared core ([spec 11](../../plan/spec.md#11-agent-integrations)). Each adapter only reads that agent's hook input and maps its exit code.

- Pick an agent with documented command hooks that is not supported yet. Link its hook documentation in the issue.
- Add the adapter, its committed configuration, and recorded input for each event from the agent's documentation under `test/fixtures/agents/<agent>/`.
- Tests: copy one agent's block in `test/agents.test.mjs`. Unknown input must be allowed, quoted text must never trigger a refusal, and the end-of-turn reminder must fire once.
- Done when: `init` writes the configuration when the agent is in use, and `update` renews it.

## 3. A "Troubleshooting" page for the first run

The most common complaint in comparable projects is a broken first run ([spec 18](../../plan/spec.md#18-launch)). Collect the refusals a new user meets and what to do about each:

- the hooks are off in a fresh clone (run `work`);
- a commit refused for a missing `Task:` line;
- a commit refused because a gate failed, and how to see its output;
- `handoff` failing on a missing stamp or an old handoff note;
- Git for Windows checking the hooks out with CRLF.
- Done when: each entry quotes the real message the guard prints, and the README links the page.

## 4. Show an example for every refusal message

Every refusal of the guard should say what to do next. Some say only what is wrong.

- List the refusal messages in `src/guard/` (search for the strings returned as problems).
- For each one that does not name the fix, add the command or the edit that resolves it, in one plain sentence.
- Tests: the existing tests match parts of these messages; update the expected text and keep each test's meaning.
- Done when: every refusal names its fix, and `npm test` passes on Node 20, 22 and 24.

## 5. `work --json` documented with an example

`work --json` prints the state for scripts, such as a view across several repositories ([spec 17](../../plan/spec.md#17-not-in-10)). Its fields are not described in one place.

- Add a short reference of the output's fields, with a real example from a small repository made with `init`.
- Add a test that the example's keys match what `work --json` prints, so the documentation cannot drift.
- Done when: the reference is linked from the README and the test passes.
