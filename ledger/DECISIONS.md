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
| 2026-10-15 | Guard-only mode (0.x `mode: guard`) is not part of 1.0; repositories that use it stay on 0.x. | Niko Alho |
| 2026-10-15 | A read-only `changes` command is part of 1.0: the tasks finished since a tag, as a draft for the changelog and the release notes. | Niko Alho |
| 2026-10-15 | The predecessor's name, agent-ledger 0.x, may appear in this repository's history and in `migrate`, which reads 0.x files by their names. | Niko Alho |
| 2026-10-15 | The specification is approved with these decisions; phase 2 turns it into a plan, which the owner reviews before the build starts. | Niko Alho |
| 2026-10-15 | The build plan is approved as written. Node 20 and 22 and VHS may be installed on the build machine, so that the tests run across the Node range and the demo can be recorded. | Niko Alho |
| 2026-10-15 | The mark follows the ruled-lanes direction (C). The README's "how it works" sections are animated motion graphics in the style of modern product sites, built as animated SVG. | Niko Alho |
| 2026-10-15 | The ResaLedger mark is C1, three parallel ruled lanes, with grain only and no spray texture anywhere. The palette is monochrome (asphalt, wall, bone concrete, concrete). | Niko Alho |
| 2026-10-15 | The brand typeface is Host Grotesk (SIL OFL), and the cover is made on the dark wall first, with a light variant. These stand until the owner says otherwise. | Lead agent, as defaults |
| 2026-10-15 | The final identity (G2) is approved as delivered, with its two deliberate deviations: square inner corners on the 16 px mark, and the wall colour for the light cover's small text. | Niko Alho |
| 2026-10-15 | Personal settings wait for 1.1. The shared rules stay in the repository's configuration and each person's agent instructions set how their agent communicates; what ResaLedger's own personal settings, in `git config`, would adjust needs more thought first. | Niko Alho |
| 2026-10-15 | How it works stays one 11-second loop, not three. The README also gets more graphics in the same style: use cases, and where a bad commit stops (G4). | Niko Alho |
| 2026-10-15 | `dir` and `codePaths` are strict: relative names of letters, digits, `.`, `_` and `-`, refused rather than normalised, because they are pasted into hook scripts and YAML. `init --dir` drops one trailing `/`, which a shell's completion adds. | Lead agent |
| 2026-10-15 | A pull request's changes to enforcement are compared from the merge base, not the base's tip. A change whose direction is unclear counts as weakening, a workflow that is not a released template weakens, a guard moved back to an older release weakens, and the agents' hook configurations are not compared, because they share files with the project's own settings. A decision lets a weakening change through with a `Weakens:` line that names it. | Lead agent |
| 2026-10-15 | `update` renews only the agent configurations that already hold ResaLedger's hook command; it adds none for an agent found later and never brings back one a project deleted. `update --agents <names>` adds one, since `init` refuses a repository that is set up. | Lead agent |
| 2026-10-15 | Agent hooks refuse commands that throw work away (`reset --hard`, `clean -f`, `checkout` of paths, `restore`, a forced `switch`) in a protected branch's checkout and in another lane's worktree, judged by the worktree the session started in, which the session record now keeps in the common git folder. | Lead agent |
