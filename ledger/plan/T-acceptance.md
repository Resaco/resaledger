# T — Acceptance and independent review

Status: proposal · 2026-10-15 · part of the plan the owner reviews

The test that proves the design, the tests that prove it holds at scale and on Windows, and a second model's review where a bug would break other people's repositories.

### T1 The parallel-lanes acceptance test

Goal: the one test that matters most ([spec section 16](spec.md#16-testing)).

Design:
- **Three lanes.** Three worktrees on three branches start from one base. Each lane:
  - claims a task;
  - adds a child task;
  - commits code with trailers;
  - verifies;
  - writes a decision and a log entry;
  - finishes its task with evidence and hands off.
- **Merging.** The branches merge with merge commits in all six orders, and once with squash merges.
- **Results.**
  - No record conflicts at all.
  - Afterwards, `work` on the base shows the right state.
  - A fourth lane that edits another lane's task is refused, both locally and by `ci`.

Acceptance: the test passes on all three operating systems in CI.

### T2 Performance and Windows

Goal: no surprises at scale or on Windows.

Design:
- `work --all` with 500 pushed branches stays within a budget: under 5 seconds on CI hardware.
- CRLF checkouts, paths with spaces and non-ASCII characters, and hooks under Git for Windows.

Acceptance: the tests pass across the matrix, and the measured time is recorded next to the budget.

### T3 Independent review of the guard

Goal: a second model reviews the record checks, the stamps, the range check and the hooks (R, V and H).

Design: a reviewer running Fable 5.1 reads the code and the tests against the specification. Every finding becomes a child task of this one.

Acceptance: the review is recorded, and every finding is fixed or answered.

### T4 Independent review of the CI check

Goal: the same review for C: the base branch's rules, the enforcement diff and the output.

Acceptance: the review is recorded, and every finding is fixed or answered.

### T5 Independent review of `migrate`

Goal: the same review for M1–M3, before this repository migrates (M4).

Acceptance: the review is recorded, and every finding is fixed or answered.
