# 2026-10-15 · Gates, stamps and the range check

V1 and V2 merged. `verify` runs the project's gates on the committed code and writes a stamp named by the code's fingerprint, never rerunning on the same code and pruning stamps that no longer apply; two lanes' stamps merge without a conflict. The range check decides in one pass whether every commit in a range names a task its lane held, in under half a second for 200 commits. `work` now says whether the gates passed on the code at HEAD. 296 tests pass on Node 24, 22 and 20. H1 (pre-commit) and V3 (handoff) started.
