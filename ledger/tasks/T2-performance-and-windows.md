# T2 Performance and Windows

- Status: doing
- Lane: main
- Depends on: W2, H3
- Plan: [T-acceptance.md](../plan/T-acceptance.md#t2-performance-and-windows)
- Evidence: —

## Handoff

Windows: CI on 2026-10-15 failed every agent-hook test that compares a path, because the runner's temporary folder has an 8.3 short name (`C:\Users\RUNNER~1\…`) and git gives the long one. Commit 7e9a831 compares paths through `realpathSync.native`, which expands short names; it is not pushed yet, so the next push shows whether Windows passes. Next: read that run; then measure `work --all` with 500 pushed branches against its 5-second budget on CI hardware, and record the time next to the budget. Locally the timing tests in `ids.test.mjs` and `work.test.mjs` pass alone (a commit with 51 branches: about 0.5 s against 3 s) and fail only when three full suites run at once.
