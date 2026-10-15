# A2 Cursor, Gemini CLI and GitHub Copilot

- Status: done
- Depends on: A1
- Plan: [A-agents.md](../plan/A-agents.md#a2-cursor-gemini-cli-and-github-copilot)
- Evidence: 832 of 832 on the branch on Node 22.23.3 and 20.20.2, and on 24.18.0 with the timing test in `ids.test.mjs` rerun alone; [agents.test.mjs](../../test/agents.test.mjs), 179 tests, runs recorded input for every event of Cursor, Gemini CLI and Copilot ([fixtures](../../test/fixtures/agents/cursor/session-start.json)), validates each configuration's documented shape and its merge into an existing file, refuses 20 commands that throw work away on a protected branch or in another lane's worktree (with quoted-text negatives and the incident's own chain), and fires the end-of-turn reminder once for Gemini's `AfterAgent` and for Copilot together with Claude Code.

## Notes

Worked on branch `a2-agents`. Assumptions about input shapes are tolerant: input an adapter does not recognise is allowed. Cursor and Copilot get the reminder as their documented JSON with exit 0. Left: when a session's folder moves to another worktree, the end-of-turn reminder still runs `handoff` where the session is now.
