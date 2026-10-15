# T2 Performance and Windows

- Status: doing
- Lane: main
- Depends on: W2, H3
- Plan: [T-acceptance.md](../plan/T-acceptance.md#t2-performance-and-windows)
- Evidence: —

## Handoff

The first CI run of the public repository (run 38734088255) passed on Linux and macOS with Node 20, 22 and 24; on Windows 997 tests passed on each Node version and one failed, a test that cleared a hook's executable bit with chmod, which Windows does not keep. The test now sets the mode through git's index (commit `test: set the hook's mode through git's index`). Measured on GitHub's runners: `work --all` with 500 pushed branches in 132–252 ms against the plan's 5-second budget; a commit that adds a task with 51 other branches in 168–367 ms against 3 s. Next: the CI run on the next push; when Windows passes, set T2 to done with these numbers.
