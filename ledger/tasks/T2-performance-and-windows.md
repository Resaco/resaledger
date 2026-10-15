# T2 Performance and Windows

- Status: done
- Lane: main
- Depends on: W2, H3
- Plan: [T-acceptance.md](../plan/T-acceptance.md#t2-performance-and-windows)
- Evidence:
  - GitHub Actions run 38742862926 on `0b30e98`: all nine jobs pass, Linux, macOS and Windows with Node 20, 22 and 24; Windows takes 9–11 minutes.
  - Measured on GitHub's runners: `work --all` with 500 pushed branches in 132–252 ms against the plan's 5-second budget (the test's own budget is 2 s); a commit that adds a task with 51 other branches in 168–367 ms against 3 s.

## Notes

Windows needed two fixes: paths are compared through `realpathSync.native`, because the runner's temporary folder has an 8.3 short name that git spells out in full; and two tests assumed POSIX behaviour (a chmod git cannot see on Windows, and GNU tar reading `C:` as a host). The timing budgets scale with the machine's load per CPU, so tests stay meaningful while several lanes run at once.
