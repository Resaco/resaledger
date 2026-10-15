# D3 Repository files and releases

- Status: done
- Lane: d3-repo-files
- Depends on: W5
- Plan: [D-docs.md](../plan/D-docs.md#d3-repository-files-and-releases)
- Evidence: `node scripts/test.mjs` on the lane: 964 of 964 on Node 24.18.0 and 22.23.3; on Node 20.20.2, 963 of 964 under a load average near 55, the one failure the timing test in [ids.test.mjs](../../test/ids.test.mjs) ("50 branches ... within the time budget"), which passed when rerun alone. The 17 tests in [repository-files.test.mjs](../../test/repository-files.test.mjs) check that every file exists and is reached from the README, that their relative links resolve, the issue forms' and the issue chooser's structure, the four YAML files against Ruby's YAML parser, and the [release workflow](../../.github/workflows/release.yml): only a pushed `v*` tag, `contents: read` and `id-token: write`, no `pull_request_target`, and tests, bundle and `release-hashes.mjs --check` before `npm publish --provenance`; they also list the owner markers, now none. `npm pack --dry-run` and `npm publish --dry-run` with npm 10 and 11: 48 files, exactly the `files` of `package.json`, summary in [dry-run.md](../evidence/d3/dry-run.md). Not verified: a real run of the workflow on GitHub and a real publish, which are the owner's.

## Notes

Built:
- [CONTRIBUTING.md](../../CONTRIBUTING.md): the ledger, lanes and `claim --worktree`, trailers and the rule against AI attribution, never `--no-verify`, `npm test` on three Node versions, `verify` and stamps, renewing the guard with `update --force`, the hygiene rule and `scan-history.mjs`.
- [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md): the Contributor Covenant 2.1 adopted by reference, with its scope; reports go through GitHub's private reporting form, since the owner has no address for them (it was an owner marker until then).
- [SECURITY.md](../../SECURITY.md): private vulnerability reporting, the latest 1.x supported, and what counts, measured against the trust model of spec 12.
- Issue forms for a bug report and a feature request, a `config.yml` that turns off blank issues and points security reports to private reporting, and this repository's pull request template, which ends with `Task:`.
- [CHANGELOG.md](../../CHANGELOG.md) with `## [Unreleased]` for 1.0.0, and [docs/releasing.md](../../docs/releasing.md) with the version policy, the owner's one-time setup and the release steps.
- The release workflow and the README section "Contributing" before "License".
- Drafts of five good first issues in [good-first-issues.md](../evidence/d3/good-first-issues.md).

Choices:
- The README's "release notes" link points to the repository's GitHub releases page; L2 writes the 1.0.0 notes and can point it at a file in the repository instead.
- The workflow publishes a prerelease tag such as `v1.0.0-rc.1` under the dist-tag `next`, and refuses a tag that does not match `package.json`. It sets `NODE_AUTH_TOKEN` from the `NPM_TOKEN` secret, which stays empty with trusted publishing.
- `release-hashes.mjs --check` fails on a development version on purpose; the release commit runs it without `--check` first.
- The YAML reader in the new test extends the one in `ci-output.test.mjs` with flow sequences and lists of scalars; it is a copy, so C3's test stays as it is.
- The changelog was drafted with `node ledger/scripts/records.mjs changes --since a9f61f3` (the first commit) and rewritten: the draft lists 46 tasks by id with their test evidence, which suits release notes for maintainers, not users. The groups follow commit types, so research and planning tasks (S1 to S4) and a review (T3) land in "Changed", and fixes to unreleased code land in "Fixed". The user-facing entries came from the specification, not the draft.
- `npm publish` with npm 10 warns that `repository` in `package.json` is a shorthand string and normalises it. Running `npm pkg fix` before the release would silence it; `package.json` belongs to another lane, so it is left for L3.
