# L1 The terminal demo

- Status: done
- Lane: main
- Depends on: I1, W4, T1
- Plan: [L-launch.md](../plan/L-launch.md#l1-the-terminal-demo)
- Evidence:
  - `vhs docs/assets/demo/demo.tape` writes [demo.gif](../../docs/assets/demo/demo.gif) (72 s, 1.2 MB) from a real run of the local package, through [the tape](../../docs/assets/demo/demo.tape) and its hidden setup in `setup.sh` and `steps.sh`. Manual check 2: four reruns printed the same output, the same stamp (`12c9df53905667a1.json`) included, with only the timings different.
  - [how-it-works.test.mjs](../../test/how-it-works.test.mjs) keeps the demo under 3 MB and its tape and scripts free of local paths.

## Notes

VHS was already installed, so no permission was needed. The tape waits for each prompt (`Wait`) instead of sleeping a fixed time, so a busy machine records the same film. Recording it found one product behaviour worth knowing: on a terminal, `init` asks its questions, and anything typed meanwhile becomes an answer.
