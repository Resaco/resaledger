# F2 CI for this repository, and the hygiene checks

- Status: done
- Depends on: F1
- Plan: [F-foundation.md](../plan/F-foundation.md#f2-ci-for-this-repository-and-the-hygiene-checks)
- Evidence: [test.yml](../../.github/workflows/test.yml) parses as YAML (checked with Ruby's parser); the [hygiene tests](../../test/hygiene.test.mjs) plant each kind of leak in temporary repositories and catch it, and pass on this repository; `node scripts/scan-history.mjs` on the real history: clean, after the commit identity's public handle was taken off the private deny-list. Not verified: the workflow on GitHub's runners (it runs once the repository is pushed).

## Notes

The scan rules live in [hygiene.mjs](../../scripts/hygiene.mjs), shared by the test and the history scan.
