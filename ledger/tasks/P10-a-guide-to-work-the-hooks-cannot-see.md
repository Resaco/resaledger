# P10 A guide to work the hooks cannot see

- Status: done
- Lane: main
- Plan: [P-adoption-feedback.md](../plan/P-adoption-feedback.md#p10-a-guide-to-work-the-hooks-cannot-see)
- Evidence:
  - [Work outside the code](../../docs/guides/outside-the-code.md), linked from the [docs index](../../docs/README.md), the [format reference](../../docs/format.md#7-evidence) and the skill.
  - `node --test test/guides.test.mjs`: 13 of 13; the new guide runs as written in a verified solo repository (fixture `ledger`), with the server step and the screenshot marked as not run.

## Notes

No change to the format was needed: `evidence/` was already a convention, images in it are records rather than code, and a URL or a command counts as evidence. The guide says plainly that nothing refuses work that was never recorded.
