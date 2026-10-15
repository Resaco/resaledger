# A1 The agent hook core, Claude Code and Codex

- Status: done
- Depends on: W1, H1
- Plan: [A-agents.md](../plan/A-agents.md#a1-the-agent-hook-core-claude-code-and-codex)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 679 of 679 on Node 24.18.0, 22.23.3 and 20.20.2. The 59 tests in [agents.test.mjs](../../test/agents.test.mjs) use recorded input for every event of both agents ([fixtures](../../test/fixtures/agents/claude/pre-tool-bash.json)); quoted text never triggers a refusal; the reminder fires once when called twice; every refusal kind, `agent.deny`, an edit on a protected branch, unknown input and merging into an existing `settings.json` are covered. Not verified: a live Claude Code or Codex session, and Windows.

## Notes

The input formats come from the agents' documentation; Codex loads project hooks only for a trusted project. Known gaps, listed in the module header: `cp`, `mv`, `perl -i`, other editor tools and variables that disable other hook managers. Open: `update` adds the configuration back for an agent whose folder exists even when a project removed it on purpose; A2 decides with the other agents.
