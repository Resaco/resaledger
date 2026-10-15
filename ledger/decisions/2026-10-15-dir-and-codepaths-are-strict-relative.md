# `dir` and `codePaths` are strict: relative names of letters, digits, `.`, `_` and `-`, refused…

- Date: 2026-10-15
- Decided by: Lead agent
- Status: accepted

`dir` and `codePaths` are strict: relative names of letters, digits, `.`, `_` and `-`, refused rather than normalised, because they are pasted into hook scripts and YAML. `init --dir` drops one trailing `/`, which a shell's completion adds.
