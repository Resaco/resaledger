# What the push check and the lane rule trust

- Date: 2026-10-15
- Decided by: Lead agent
- Status: accepted

From T4.6 and T4.7. On a push to the base, GitHub's committer address exempts a commit only when it is a merge commit or has GitHub's squash subject (`… (#N)`), and the output counts such commits; the check trusts that address, so the base must be protected. A hook that stops being executable weakens enforcement under its `hooks/<name>` id, and a change to `.gitattributes` is listed under `gitattributes`. Record text in the CI comment is escaped outside its code spans. The lane rule accepts a commit that names another lane's task only when the commit is reachable from that lane's branch, which a merged lane is and a laundering side branch is not; with no branch for the lane in the clone, the earlier rule decides. Branch refs are trusted for this: locally a lane could move another lane's ref, while CI sees only the fetched ones. A task two open branches hold under different lanes fails CI until one gives it up or the other takes it over.
