# `update` renews only the agent configurations that already hold ResaLedger's hook command; it adds…

- Date: 2026-10-15
- Decided by: Lead agent
- Status: accepted

`update` renews only the agent configurations that already hold ResaLedger's hook command; it adds none for an agent found later and never brings back one a project deleted. `update --agents <names>` adds one, since `init` refuses a repository that is set up.
