# Versions and releases

## Version policy

ResaLedger has two version numbers.

- **The package version**, in `package.json`, follows [semantic versioning](https://semver.org/). A patch release fixes bugs. A minor release adds something: a command, an option, an optional field. A major release breaks something that worked before.
- **The format version** is the `version` in a project's `.resaledger.json`: 1 for agent-ledger 0.x, 2 for ResaLedger 1.x. It covers the layout and fields of the records, the configuration and the trailers.

The rules that join them, from [section 15 of the specification](../ledger/plan/spec.md#15-format-stability-and-updates):

- Within 1.x, the format only grows: new optional fields and new commands. A 1.x guard reads the records of any 1.y workspace and keeps fields it does not know.
- The format version changes only in a major release, and only with a `migrate` step that converts existing workspaces. A guard refuses a newer format version and prints the command that updates it.
- New guards, hooks, the `AGENTS.md` block and the agent hook configurations reach a project through `npx resaledger update`. It replaces a managed file only when the file matches a released version, so hand edits are kept unless `--force` is given. Each release records the hashes of its managed files in `templates/released.json`.
- A prerelease, such as `1.0.0-rc.1`, is published under the npm dist-tag `next`, never `latest`.

## What the owner sets up once

The release workflow is [.github/workflows/release.yml](../.github/workflows/release.yml). It runs when a tag that starts with `v` is pushed. It checks that the tag matches `package.json`, runs `npm test`, builds the guard with `node scripts/bundle.mjs`, runs `node scripts/release-hashes.mjs --check`, and stages the release with `npm stage publish --provenance`. Its token may only read the repository and request an OIDC token for npm (`contents: read`, `id-token: write`).

A staged version waits on npm, not installable, until the owner approves it with two-factor authentication ([staged publishing](https://docs.npmjs.com/staged-publishing/)). So no release reaches users without a person at the keyboard, even if the workflow or a tag is misused. The version number is taken as soon as it is staged.

npm needs one of two ways to accept the staged release.

**Trusted publishing (recommended).** No secret is stored.

1. A trusted publisher can only be added to a package that exists on npm. Publish the first version with an access token (below), then switch: remove the `NPM_TOKEN` secret once trusted publishing works.
2. On npmjs.com, open the package's **Settings**, then **Trusted publishing**, and add a GitHub Actions publisher: organisation or user `Resaco`, repository `resaledger`, workflow file `release.yml`, no environment. Under **Allowed actions**, leave **npm publish** and **npm dist-tag** off: `npm stage publish` is always allowed, and it is all the workflow needs. On a publisher added earlier, turn **npm publish** off.
3. Under **Settings**, **Publishing access**, choose **Require two-factor authentication and disallow tokens**, so that nothing but the workflow can stage and nothing but the owner can approve.

Staged publishing needs npm 11.15.0 or newer and Node 22.14.0 or newer; the workflow uses Node 24 and checks its npm before it stages. Trusted publishing adds provenance on its own; the workflow also passes `--provenance`.

**An access token, if trusted publishing is not used.**

1. On npmjs.com, create a granular access token with read and write permission for the package `resaledger` only, and a short expiry. Staging never asks for two-factor authentication, so the token does not need to bypass it.
2. In the GitHub repository, open **Settings**, **Secrets and variables**, **Actions**, and add it as the repository secret `NPM_TOKEN`.

Also in the GitHub repository:

- Under **Settings**, **Code security**, turn on **Private vulnerability reporting**, which [SECURITY.md](../SECURITY.md) points to.
- Protect `v*` tags under **Settings**, **Rules**, **Rulesets**, so that only the owner can create them.

## Releasing a version

The release-candidate task prepares the release commit; the owner tags and pushes it. In a clean clone of `main`:

1. Set the version, without a tag or a commit:

   <!-- not run: the owner's release steps, which change the version, tag and publish -->
   ```bash
   npm version 1.0.0 --no-git-tag-version
   ```

2. Record the managed files' hashes for that version, and check that the table holds them:

   <!-- not run: the owner's release steps, which change the version, tag and publish -->
   ```bash
   node scripts/release-hashes.mjs
   node scripts/release-hashes.mjs --check
   ```

3. Move the entries under `## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md) to a new `## [1.0.0] - <date>` section. Draft them with `node ledger/scripts/records.mjs changes`, which lists the tasks finished since the last tag, and edit that draft down to what a user needs.
4. Run the tests on Node 20, 22 and 24, and look at what would be published:

   <!-- not run: the owner's release steps, which change the version, tag and publish -->
   ```bash
   npm test
   npm publish --dry-run
   ```

5. Commit the release with the release task's trailer, run `node ledger/scripts/records.mjs verify`, commit the stamp, and run `node ledger/scripts/records.mjs handoff`.
6. Tag the commit and push the branch and the tag:

   <!-- not run: the owner's release steps, which change the version, tag and publish -->
   ```bash
   git tag -a v1.0.0 -m "ResaLedger 1.0.0"
   git push origin main
   git push origin v1.0.0
   ```

7. Watch the **release** workflow in the **Actions** tab. When it passes, the version is staged. Look at it, then approve it with two-factor authentication:

   <!-- not run: the owner's release steps, which need npm's two-factor authentication -->
   ```bash
   npm stage list resaledger
   npm stage view <stage-id>
   npm stage approve <stage-id>
   ```

   `npm stage download <stage-id>` fetches the staged tarball, to compare with what `npm publish --dry-run` listed in step 4. The **Staged Packages** tab on npmjs.com shows the same, with an **Approve** button.

8. Check the package page on npmjs.com for the version and its provenance, and publish the release notes, `docs/releases/v<version>.md`, as a GitHub release for the tag.

If the workflow fails before `npm stage publish`, nothing was staged: fix the cause on `main`, delete the tag (`git tag -d v1.0.0` and `git push origin :refs/tags/v1.0.0`), and tag again. If a staged version is wrong, reject it with `npm stage reject <stage-id>` and fix forward with the next version. A version that reached npm is never published twice.
