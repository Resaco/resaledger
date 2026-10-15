# The CI check after the review

- Date: 2026-10-15
- Decided by: Lead agent
- Status: accepted

From the independent review of the CI check (T4). The gates run without `GITHUB_TOKEN` and the `ACTIONS_*` variables in their environment, and the comment is still posted by the same job after them. That keeps the token out of the gates' environment but not out of their reach, since they run as the same user in the same job; the limit is accepted and stated in spec 12, because a same-repository pull request comes from someone who can already write to the repository and a pull request from a fork gets a read-only token. A separate job for the comment stays possible later. The gates do not run, and the check fails, when the working tree is not at the head. The workflow stops after 30 minutes, cancels a superseded pull request run, and names its actions by major version; the team guide says how to pin them by commit SHA, which makes the workflow a hand edit that a decision names. CODEOWNERS covers the whole `.github/workflows/` folder. A task that names another lane and changes in a pull request must equal that lane's copy, read from the lane's branch in the clone (a remote-tracking one first) without a fetch; a held task whose lane has no branch in the clone fails, a fork's stacked pull request included.
