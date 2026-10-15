# 2026-10-15 · The configuration and the Markdown layer

R1 and R2 were built in parallel by two workers in their own worktrees and merged without a conflict: the configuration (`.resaledger.json` with presets, defaults and typo suggestions, and the `config` command) and the Markdown primitives (lines, GitHub's anchors, sections, links and bullet fields). 64 tests pass on Node 20, 22 and 24. The module page now fixes the context that validators receive, and keeps the Handoff check for the end of a session, so that a claim can be committed before its first handoff note.
