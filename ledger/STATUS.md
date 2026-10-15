# Status

Updated: 2026-10-15 · by the lead agent

## Phase

Building. Done: the foundation (F), the record format (R), the git hooks (H), the end-of-session check (V3), the daily commands `work`, `work --all`, `task` and `new` (W1–W3), the CI check (C1), `init` and `update` (I1, I3), `migrate` and its verification on real workspaces (M2, M3), and the brand identity (G2). Fable 5.1 reviewed `migrate` (T5) and found one blocker; its fixes come before this repository moves to 1.0 (M4).

## Active work

[T5.1](work/ledger.md#t51-data-safety-in-migrate) and [A1](work/ledger.md#a1-the-agent-hook-core-claude-code-and-codex), with workers; [G3](work/ledger.md#g3-animated-explanations-of-how-it-works), by the lead.

## Last verified

- `verify` passed on the current code (2026-10-15): the bundle check, and `npm test` with 558 of 558 tests on Node 24 and 20 after the CI fixes, and on Node 22 before them.
- The first CI run on GitHub failed on every platform: a test read GitHub's own event, and on Windows the tests expected an executable bit the file system does not keep. Both are fixed; the next push shows whether Windows passes.

## Next step

Review T5.1 and A1 when their workers report; then T5.2, T5.3, W4 and C2; then M4.

## Waiting for the owner

- Whether the How it works animation stays one 11-second loop or becomes three, one per promise ([G3](work/ledger.md#g3-animated-explanations-of-how-it-works)).
- A push of `main`, so that CI checks the fixes on Windows, Linux and macOS.
