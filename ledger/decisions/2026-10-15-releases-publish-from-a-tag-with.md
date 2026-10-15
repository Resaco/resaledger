# Releases publish from a tag with provenance, prereleases to next

- Date: 2026-10-15
- Decided by: Lead agent
- Status: accepted

A pushed `v*` tag runs `.github/workflows/release.yml`, which stops unless the tag matches `package.json`, runs the tests, rebuilds the guard, checks the released hashes and publishes with `npm publish --provenance --access public`. A prerelease such as `1.0.0-rc.1` goes to the dist-tag `next`, never `latest`. The first publish needs an npm token, because trusted publishing can only be set up for a package that exists; after it the owner switches to trusted publishing and removes the token ([releasing.md](../../docs/releasing.md)). The code of conduct is adopted by reference to the Contributor Covenant 2.1 rather than copied, and its reporting address is the owner's to give.
