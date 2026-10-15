# P8 npx resaledger in a repository that npm cannot resolve

- Status: done
- Lane: p-installer
- Plan: [P-adoption-feedback.md](../plan/P-adoption-feedback.md#p8-npx-resaledger-in-a-repository-that-npm-cannot-resolve)
- Evidence:
  - [package.test.mjs](../../test/package.test.mjs), the test "npx in a repository whose package.json npm cannot resolve": offline, with `npm pack`'s tarball, a fresh npm cache and a `file:` dependency, plain `npm exec --package=<tarball> -- resaledger --version` fails with `EOVERRIDE`; `npm exec --prefix <empty folder> --package=<tarball> -- resaledger init --yes --no-gates` from a subfolder sets up the repository and writes nothing in the prefix
  - `node --test test/package.test.mjs`: 6 of 6

## Notes

Manual check with npm 10.8.2 and Node 20.20.2, offline, a packed tarball, a fresh cache and a repository whose `overrides` conflicts with a `file:` dependency:

- `npx --package=<tarball> resaledger --version` and `npm exec --package=<tarball> -- resaledger --version`: `EOVERRIDE`, exit 1, before the package runs.
- `npm_config_prefix=<empty folder> npx …`: `EOVERRIDE` too; the variable does not change where npx reads the project.
- `npx --prefix <empty folder> --package=<tarball> …` and the `npm exec` form: run, in the current folder (`-c pwd` printed the repository), also from a subfolder; nothing is written in the prefix.
- `--prefix` with a folder that does not exist: `ENOENT`, exit 254. Hence `"$(mktemp -d)"` in the documentation.

Running from another folder was not used: ResaLedger finds the repository from the current folder. The README's questions, the solo guide and the skill give `npx --prefix "$(mktemp -d)" resaledger init`. The registry form (`resaledger@next`) was not tried, to stay off the network; npx resolves it the same way.
