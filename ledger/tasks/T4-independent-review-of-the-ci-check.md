# T4 Independent review of the CI check

- Status: done
- Lane: main
- Depends on: C2, C3
- Plan: [T-acceptance.md](../plan/T-acceptance.md#t4-independent-review-of-the-ci-check)
- Evidence: [The review](../evidence/t4/review.md): 15 findings, one blocker, four major and ten minor, each reproduced with the bundled guard in real repositories; all fifteen fixed or answered in T4.1 to T4.7, each fix with a test that fails without it.

## Notes

For the reviewer: T1 found that a lane stacked on another lane's claim commit can change that task and pass `ci`, because the base never recorded the claim; decide whether `ci` should compare such a task with the holding lane's branch.

Known limits after the fixes, for 1.x: during a pull request that moves the workspace, the commits check still reads the base's folder, so the move goes in a pull request of its own with `Task: maintenance` commits, and `update` keeps hooks written for the old folder unless `--force` is given. The lane rule trusts branch refs: locally a lane could move another lane's ref, while CI sees only the fetched ones; and once a holding lane's branch is merged and deleted everywhere, the earlier start-of-range rule decides.
