# Lanes, worktrees and messages after the guides

- Date: 2026-10-15
- Decided by: Lead agent
- Status: accepted

Writing and testing the guides found gaps that are now closed. `migrate` gives a task in progress without a Lane the one unmerged branch whose commits name it in a `Task:` trailer, counting a remote branch by its name; when several branches name it, the task keeps the current branch and a warning names them all. pre-commit counts a task in another local worktree as held only when its `Lane:` is that worktree's own branch, and reads only `tasks/` there, from disk, so a commit that changes no task reads nothing more. `update` reports a configuration it creates as Added and one it brings back as Restored. A known decision field below the field list is reported when the list lacks it, and `new decision` ends on `- Status:` so that an appended field joins the list. Evidence names a stamp in backticks: a link to one is refused, because the next `verify` replaces it.
