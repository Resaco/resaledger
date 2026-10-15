# 2026-10-15 · The release candidate

- Lane: main
- Tasks: L3, D4, T2, L2

`v1.0.0-rc.1` is tagged locally: the version is set in the package, the plugin and the marketplace, the release hashes are recorded and this repository runs the released guard, the changelog has its section, and 1023 tests pass on Node 24, 22 and 20. The owner read the README and asked that it say plainly that agents run the daily loop, which it now does. Two things stay open for him: one CI run on Windows, which GitHub would not start in the private repository because of billing, and his reading of the launch drafts. The npm name is free, and the dry runs of `npm pack` and `npm publish` show 48 files.
