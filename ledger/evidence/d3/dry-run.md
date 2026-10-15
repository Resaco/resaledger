# Release dry run (D3)

Run on the `d3-repo-files` branch, package version `1.0.0-dev.0`, on 15 October 2026. Nothing was published.

## `npm pack --dry-run`

The `prepack` script built the guard, and the tarball holds 48 files, 256.0 kB packed and 886.6 kB unpacked: `CHANGELOG.md`, `LICENSE`, `README.md`, `package.json`, `bin/resaledger.mjs`, `dist/records.mjs`, the 8 files of `src/cli/`, the 23 files of `src/guard/` and the 10 files of `templates/`. These are exactly the entries of `files` in `package.json`; `test/package.test.mjs` checks the same list.

## `npm publish --dry-run`

- With npm 10.8.2 (Node 20.20.2): `+ resaledger@1.0.0-dev.0`, "Publishing to https://registry.npmjs.org/ with tag latest and default access (dry-run)". npm warned that it normalised `repository` from the string `github:Resaco/resaledger` to an object with the URL `git+https://github.com/Resaco/resaledger.git`.
- With npm 11.16.0 (Node 24.18.0), as the release workflow runs it, `npm publish --dry-run --access public --tag next`: `+ resaledger@1.0.0-dev.0`, "with tag next and public access (dry-run)". Both runs warn that publishing needs a login, which the workflow gets from trusted publishing or the `NPM_TOKEN` secret.

## The workflow's own checks

- `node scripts/release-hashes.mjs --check` exits 1 on this branch: "templates/released.json lacks the hashes of 1.0.0-dev.0". That is the intended refusal: the release commit must run `node scripts/release-hashes.mjs` first ([docs/releasing.md](../../../docs/releasing.md), step 2).
- The tag check and the dist-tag choice, run with bash: the tag `v1.0.0-dev.0` matches and goes to `next`; the tag `v1.0.0` does not match the version `1.0.0-dev.0` and stops the job.
- `test/repository-files.test.mjs` parses the workflow with its own reader and with Ruby's YAML parser, and checks the trigger, the permissions and the order of the steps.
