# The CI workflow runs on every push and judges base pushes only

- Date: 2026-10-15
- Decided by: Lead agent
- Status: accepted

A workflow file cannot filter on a base branch that only `.resaledger.json` names, so the shipped workflow runs on every push and passes `--only-base-pushes`; a push to a branch that is neither the base nor protected is noted and not checked. The workflow takes the guard from the base commit and, when the head's guard names another version, fetches that release from npm and passes it with `--release`, so an update to a real release needs no decision. It is hashed without a workspace folder, so that a folder name can never alter `actions/checkout` in the hash. The team preset writes it and a pull request template ending in `Task:`, and prints CODEOWNERS lines rather than writing a file, since the owners' handles belong to the project; a solo project adds the workflow with `update --workflow`. Task titles and evidence are escaped in the comment, so a record cannot forge its marker.
