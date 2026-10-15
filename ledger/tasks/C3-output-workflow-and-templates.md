# C3 Output, workflow and templates

- Status: doing
- Lane: c3-ci-output
- Depends on: C1
- Plan: [C-ci.md](../plan/C-ci.md#c3-output-workflow-and-templates)
- Evidence: —

## Notes

From C2: let the workflow fetch the package version the head's guard names (`npm pack resaledger@<version>`) and give `ci` that guard, whose released table (its own hash and every earlier release) then counts as known, so an update to a real release passes without a decision. The workflow is the trust anchor already, protected by CODEOWNERS, and npm provenance ties the package to the release; a CI system without registry access falls back to a decision. Add the shipped workflow template to `released.json`.
