# P4 A shorter typo distance for short names

- Status: done
- Lane: p-guard
- Plan: [P-adoption-feedback.md](../plan/P-adoption-feedback.md#p4-a-shorter-typo-distance-for-short-names)
- Evidence:
  - [config.test.mjs](../../test/config.test.mjs) and [tasks.test.mjs](../../test/tasks.test.mjs): `Later` is a free field, `id` is kept with a notice; `Staus`, `Lnae`, `Pln` and `wipp` are reported. `node --test test/config.test.mjs test/tasks.test.mjs`: 78 of 78
  - [docs/format.md](../../docs/format.md) states the rule of spec 5.2 and 5.3; `npm test`: 1038 of 1038

## Notes

`Lnae` is two Levenshtein edits from `Lane`, so the acceptance check needed more than the limit: `editDistance` now counts a swap of two neighbouring letters as one edit (the optimal string alignment distance). The specification says "within one letter" and does not define a swap; the format reference says it counts as one.
