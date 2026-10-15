# A moved workspace is read in its own folder

- Date: 2026-10-15
- Decided by: Lead agent
- Status: accepted

From T4.5. During `ci`, each tree's records are read in the folder its own valid configuration names, falling back to the base's, and every other rule comes from the base; the merge base's decisions are read in the merge base's folder, so an old decision that moves along with the folder is not new. A move of the workspace goes in a pull request of its own, with `Task: maintenance` commits and a decision that names `dir`, because the commits check still reads the base's folder until the move is on the base.
