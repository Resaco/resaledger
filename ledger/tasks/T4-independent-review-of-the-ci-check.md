# T4 Independent review of the CI check

- Status: doing
- Lane: main
- Depends on: C2, C3
- Plan: [T-acceptance.md](../plan/T-acceptance.md#t4-independent-review-of-the-ci-check)
- Evidence: —

## Notes

For the reviewer: T1 found that a lane stacked on another lane's claim commit can change that task and pass `ci`, because the base never recorded the claim; decide whether `ci` should compare such a task with the holding lane's branch.
