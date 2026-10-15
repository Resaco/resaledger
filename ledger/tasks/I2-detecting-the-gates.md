# I2 Detecting the gates

- Status: doing
- Lane: i2-gates
- Depends on: F1
- Plan: [I-installer.md](../plan/I-installer.md#i2-detecting-the-gates)
- Evidence: —

## Handoff

- Done: `src/cli/detect.mjs` finds the candidates, proves them offline with time limits and reads the commit style; `init` uses it, with `--no-gates`; tests in `test/detect.test.mjs`; spec 13 and modules.md updated.
- Next: run the whole suite on Node 24, 22 and 20, verify, and close the task.
