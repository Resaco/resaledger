# T2 Performance and Windows

- Status: doing
- Lane: main
- Depends on: W2, H3
- Plan: [T-acceptance.md](../plan/T-acceptance.md#t2-performance-and-windows)
- Evidence: —

## Handoff

Measured on GitHub's runners in run 38709241529: `work --all` with 500 pushed branches took 132–167 ms on Linux and 215–252 ms on macOS, including Node's start-up, against the plan's 5-second budget (the test's own budget is 2 s); a commit that adds a task with 51 other branches took 168–367 ms against 3 s. Windows: the short-name fix took Node 24 from 11 failures to 2, both test bugs now fixed (7ff892c), and the job timeout is 30 minutes, since the suite takes about 14 minutes there. Next: the next push's CI on Windows; when all three Windows jobs pass, record T2 as done with these numbers.
