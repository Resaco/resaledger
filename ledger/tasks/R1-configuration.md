# R1 Configuration

- Status: done
- Depends on: F1
- Plan: [R-records.md](../plan/R-records.md#r1-configuration)
- Evidence: `node scripts/test.mjs` on `main` after merging R1 and R2: 64 of 64 on Node 24.18.0, 22.23.3 and 20.20.2; the configuration's 17 tests, one of them end to end through the bundle, are in [config.test.mjs](../../test/config.test.mjs); `node dist/records.mjs config` prints the effective configuration. Not verified: Linux and Windows (CI).

## Notes

`config` is null when the file has any problem. A missing or unknown version is reported alone, so a newer format's keys make no noise. A deny rule needs a pattern; its reason is optional.
