# A — Agent integrations

Status: approved · 2026-10-15 · by Niko Alho

Every agent learns the protocol from `AGENTS.md`, and the agents that have hooks are stopped before they break a rule ([spec section 11](spec.md#11-agent-integrations)).

### A1 The agent hook core, Claude Code and Codex

Goal: one entry point, `hook <agent> <event>`, that blocks tool calls that break the rules.

Design:
- **Session start.** It turns on the git hooks and prints `work`.
- **Before a tool**, it refuses:
  - the built-in cases: `--no-verify` in any spelling, changes to `core.hooksPath`, forced pushes and pushes to protected branches;
  - the project's `agent.deny` rules;
  - file edits on a protected branch, both through edit tools and through the shell redirections it can see.
- **End of turn.** One reminder per session, sent only when the session changed the repository and `handoff` fails.
- **Contract.** The hook exits with code 2 and gives the reason on stderr. Input it does not recognise is allowed.
- **Configurations.** Claude Code and Codex get configurations whose command lines never change between versions.

Acceptance:
- Recorded input for every event of both agents.
- Text inside quotes never triggers a refusal.
- The reminder fires once, even when it is called twice.

### A2 Cursor, Gemini CLI and GitHub Copilot

Goal: the same rules through each agent's own hooks.

Design: an input adapter and a configuration for each agent, as in the specification:
- **Cursor:** `failClosed` and `loop_limit: 1`. Cloud agents turn on the git hooks at their first shell call.
- **Gemini CLI:** `AfterAgent` runs after every turn.
- **Copilot:** reads Copilot's own input shape.

Acceptance:
- Recorded input for every agent and event.
- Every configuration file is validated.

### A3 The `AGENTS.md` block, the skill and the plugin

Goal: every agent learns the protocol when its session starts, and Claude Code, Codex and the Copilot CLI can install the skill.

Design:
- **The managed block** is short. It tells agents to commit their work and never to bypass a hook.
- **Other agents' instruction files.** The `@AGENTS.md` import is added to an existing `CLAUDE.md`, and `context.fileName` is set for Gemini CLI.
- **The skill** covers setting up from a real repository and writing good records.
- **The plugin marketplace files** come with it.

Acceptance:
- Tests for the block: created, extended and updated, with foreign text kept each time.
- The skill passes a format check.
- The marketplace JSON matches the documented shape.
