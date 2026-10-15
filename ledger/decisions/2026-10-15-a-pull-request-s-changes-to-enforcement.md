# A pull request's changes to enforcement are compared from the merge base, not the base's tip

- Date: 2026-10-15
- Decided by: Lead agent
- Status: accepted

A pull request's changes to enforcement are compared from the merge base, not the base's tip. A change whose direction is unclear counts as weakening, a workflow that is not a released template weakens, a guard moved back to an older release weakens, and the agents' hook configurations are not compared, because they share files with the project's own settings. A decision lets a weakening change through with a `Weakens:` line that names it.
