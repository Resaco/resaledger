# P9 An agent's push can require handoff

- Status: done
- Lane: p-guard
- Plan: [P-adoption-feedback.md](../plan/P-adoption-feedback.md#p9-an-agents-push-can-require-handoff)
- Evidence:
  - [agents.test.mjs](../../test/agents.test.mjs), `agent.pushNeedsHandoff`: a ready lane pushes, and a dirty tree or a doing task without a handoff is refused, for every adapter (Claude Code, Codex, Cursor's two shell inputs, Gemini CLI, Copilot); `cd`, `git -C`, chained and `bash -lc` forms are checked in the worktree they run in; without the key nothing changes. `node --test test/agents.test.mjs`: 189 of 189
  - [ci.test.mjs](../../test/ci.test.mjs): turning the key off is a weakening, on is listed; [config.test.mjs](../../test/config.test.mjs): `config` prints it with `false`. `npm test`: 1038 of 1038

## Notes

The agent hooks read the configuration from the working tree, although the agents guide said they read the committed one. They now read it from HEAD (`git show HEAD:.resaledger.json`), so an uncommitted edit lifts neither `agent.deny` nor this key; a test covers both. `hooksActive` takes the worktree's root, so handoff's check runs in the push's worktree. A `cd` inside `bash -c` is still not followed, as before.
