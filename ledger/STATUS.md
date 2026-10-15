# Status

Updated: 2026-10-15 · by the lead agent

## Phase

Building. Done: the foundation (F), the record format (R), the git hooks (H), the end-of-session check (V3), the daily commands `work`, `work --all`, `task`, `new` and `claim` (W1–W4), the CI check (C1), the agent hooks for Claude Code and Codex (A1), `init` and `update` (I1, I3), `migrate` with its verification on real workspaces and the data-safety fixes from its review (M2, M3, T5.1, T5.3), and the brand identity (G2).

## Active work

[T3.1](work/ledger.md#t31-a-range-check-that-cannot-be-fooled), [T3.2](work/ledger.md#t32-hooks-judged-by-the-committed-rules) and [T3.3](work/ledger.md#t33-handoff-and-verify-at-the-edges), with workers: the fixes from the review of the guard.

## Last verified

- `verify` passed on the current code (2026-10-15): the bundle check, and `npm test` with 696 of 696 tests on Node 24, 22 and 20. The history scan is clean.
- CI on GitHub passes on Linux and macOS with Node 20, 22 and 24. Windows failed on two test problems, both fixed since the last push.

## Next step

Fix the review's findings, the blocker first: [T3.1](work/ledger.md#t31-a-range-check-that-cannot-be-fooled), then T3.2 to T3.4. Then C2, A2 and M4, which now also waits for T3.1 and T3.2.

## Waiting for the owner

- Approval of the use-case cards and the "where a bad commit stops" diagram ([G4](work/ledger.md#g4-more-readme-graphics-use-cases-and-where-a-bad-commit-stops)), shown as previews.
