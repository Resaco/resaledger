# T2 Performance and Windows

- Status: doing
- Lane: main
- Depends on: W2, H3
- Plan: [T-acceptance.md](../plan/T-acceptance.md#t2-performance-and-windows)
- Evidence: —

## Handoff

Windows: commit 7e9a831 compares paths through `realpathSync.native`, which expands the runner's 8.3 short names; it is not pushed yet, so the next push shows whether Windows passes. The timing budgets now scale with the machine's load per CPU (`budget(ms)` in `test/helpers.mjs`), so parallel lanes no longer fail them; on an idle machine a commit with 51 branches takes about 0.5 s against 3 s. Next: read the next CI run on Windows; then measure `work --all` with 500 pushed branches on CI hardware against its 5-second budget and record the time here.
