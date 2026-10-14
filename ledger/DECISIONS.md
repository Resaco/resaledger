# Decisions

Decisions the owner made, and significant technical decisions made inside an approved plan. Add new rows at the end, on the day the decision is made. A row says what was decided and why in one or two sentences, and who decided.

| Date | Decision | Decided by |
| --- | --- | --- |
| 2026-10-14 | One format replaces 0.x entirely: one file per record instead of a few shared files. Existing workspaces move over with `migrate`, and there is no separate team mode. | Niko Alho |
| 2026-10-14 | In normal work, no two lanes edit the same file. That principle drives the layout. | Niko Alho |
| 2026-10-14 | The lane, a person or an agent working on one branch or worktree, is the concept that unifies one developer with three agents and three colleagues. | Niko Alho |
| 2026-10-14 | No cherry-pick integration and no long-lived personal branches: short-lived branches, ordinary merges, and pull requests where the organisation uses them. | Niko Alho |
| 2026-10-14 | Branch policy is configuration with two presets, solo and team. Agents never commit to a protected branch, and a claim becomes visible by pushing its branch early, never by a commit to the base. | Niko Alho |
| 2026-10-14 | The solo path must not get heavier than 0.3. Any feature that costs a solo developer a step is opt-in. | Niko Alho |
| 2026-10-14 | Nothing copied into a repository has a runtime dependency, so everything works from a fresh clone and in cloud agents. | Niko Alho |
| 2026-10-14 | 1.0 keeps what makes 0.3 worth having: done needs evidence someone else can open, the gate result is bound to the code it verified, and unrecorded work is refused. | Niko Alho |
| 2026-10-14 | English throughout, in a new public repository with a clean history. The history of the 0.x repository is not rewritten. | Niko Alho |
| 2026-10-14 | The repository is built with agent-ledger from its first commit: a 0.3 workspace at first, moved to the 1.0 format with its own `migrate` once that works. | Niko Alho |
| 2026-10-15 | Licence: MIT, copyright Resaco Oy. | Niko Alho |
| 2026-10-15 | Commits are authored as Niko Alho with the GitHub no-reply address, set in this repository's own git configuration, and carry no co-author line naming an AI. | Niko Alho |
| 2026-10-15 | Nothing derived from private projects goes into this repository, not even anonymised numbers. The specification's evidence appendix was removed for this reason. | Niko Alho |
| 2026-10-15 | The plan is reviewed separately from the specification, before the build starts. | Niko Alho |
| 2026-10-15 | The product is named ResaLedger: the npm package and command `resaledger`, the repository `Resaco/resaledger`, the configuration file `.resaledger.json`. The workspace folder stays `ledger/`. Its visual identity follows the Resa product family, in a dark graffiti style with a refined grain, designed in Affinity. | Niko Alho |
