# T4 Independent review of the CI check

- Status: blocked
- Lane: main
- Depends on: C2, C3
- Plan: [T-acceptance.md](../plan/T-acceptance.md#t4-independent-review-of-the-ci-check)
- Evidence: [The review](../evidence/t4/review.md): 15 findings, one blocker, four major and ten minor, each reproduced with the bundled guard in real repositories.
- Waiting for: its child tasks, T4.1 to T4.6, which fix or answer every finding

## Notes

For the reviewer: T1 found that a lane stacked on another lane's claim commit can change that task and pass `ci`, because the base never recorded the claim; decide whether `ci` should compare such a task with the holding lane's branch.
