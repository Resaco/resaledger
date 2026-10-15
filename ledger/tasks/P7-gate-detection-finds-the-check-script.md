# P7 Gate detection finds the check script and lists other test and lint scripts

- Status: done
- Lane: p-installer
- Plan: [P-adoption-feedback.md](../plan/P-adoption-feedback.md#p7-gate-detection-finds-the-check-script-and-lists-other-test-and-lint-scripts)
- Evidence:
  - [detect.test.mjs](../../test/detect.test.mjs): `check` is a verify candidate and the Makefile's `check` is skipped then; `test:…` and `lint:…` scripts are listed with the lockfile's package manager; `init --yes` on a repository with `check` and `test:unit` writes `npm run check` as a verify gate, names `npm run test:unit` and never runs it
  - `node --test test/detect.test.mjs`: 26 of 26
  - `npm test`: 1030 of 1030

## Notes

The listed scripts are printed after the gates in every case, also when no gate candidate exists; `--no-gates` detects nothing and lists nothing. `detectGates` returns them as `listed`. The solo guide and the README's checks answer name the candidates and the listing.
