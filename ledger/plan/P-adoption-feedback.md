# P — Feedback from the first adoptions

Status: approved · 2026-10-15 · by Niko Alho

The faults and gaps found when rc.1 was installed in real repositories and 0.x workspaces were migrated, fixed as general faults before 1.0.0-rc.2. Three of them change the specification: [the decision](../decisions/2026-10-15-an-agent-s-push-can-require-handoff.md).

Every fix starts with a failing test that builds a real repository, as the other tests do. Workers do not edit `CHANGELOG.md`, `templates/released.json` or this repository's own guard in `ledger/scripts/`; the lead writes those for [L4](L-launch.md#l4-the-second-release-candidate). A worker that changes what a user sees also changes the documentation that describes it: [docs/format.md](../../docs/format.md), the guides in [docs/guides/](../../docs/guides/) and the skill.

## Lanes

| Lane | Tasks | Area |
| --- | --- | --- |
| migrate | P1, P2, P3 | `src/cli/migrate.mjs`, `src/cli/legacy.mjs` |
| guard | P4, P5, P9 | `src/guard/util.mjs`, `config.mjs`, `tasks.mjs`, `report.mjs`, `agents.mjs`, `handoff.mjs` |
| installer | P6, P7, P8 | `src/cli/init.mjs`, `detect.mjs`, `bin/`, `src/guard/create.mjs`, `claim.mjs` |
| main | P10, P11, L4 | documentation and the release |

### P1 migrate renames the old configuration file in .gitattributes

Goal: after `migrate`, `.gitattributes` names `.resaledger.json` wherever it named `.agent-ledger.json`.

Design:
- Today `migrate` renames the configuration file but leaves `.agent-ledger.json export-ignore` in `.gitattributes`, so the new configuration is no longer excluded and leaks into `git archive`.
- Rewrite every `.gitattributes` line whose path is exactly the old file name, keeping the line's attributes and every other line, and its line endings.
- The report lists the rewritten lines. `--dry-run` shows them.

Acceptance:
- A 0.x workspace with `.agent-ledger.json export-ignore` migrates to `.resaledger.json export-ignore`, and `git archive HEAD` leaves the configuration out.
- A line that only mentions the old name inside a longer pattern is reported, not rewritten.

### P2 migrate keeps edited 0.x template sections active

Goal: a section of the 0.x workspace `AGENTS.md` or `standards.md` that the project edited stays in the active instructions.

Design:
- Today `migrate` recognises 0.x template sections by their heading alone (`AGENTS_TEMPLATE_SECTIONS`, `STANDARDS_TEMPLATE_SECTIONS`) and moves all of them to the migration's log entry, so a project's own rules written into such a section leave the instructions every agent reads.
- Compare each such section with the text that the released 0.x templates wrote, with their placeholders filled in for this workspace. Take the template texts from the 0.x releases' templates. Whitespace and line endings do not count.
- A section equal to a released template goes to the log entry, as now. An edited section is appended to the project's part of the root `AGENTS.md` (from `standards.md`, to the workspace README, where its other own sections already go), under its own heading, and the report warns that it was a template section with project edits that the reader should review, since it may describe 0.x commands.

Acceptance:
- A workspace whose template sections are untouched migrates as before, byte for byte.
- A workspace with one edited sentence in a template section keeps that section in the root `AGENTS.md`, and the report names it.

### P3 migrate's report says when agent hooks are missing

Goal: after `migrate`, nobody is left without agent hooks without knowing it.

Design:
- `migrate` renews the agent hook configurations that 0.x had. When it finishes with none, or with fewer than the agents that `init` would detect (`detectAgents`), the report ends with the command to add them: `npx resaledger update --agents <names>`, naming the detected agents, or `--agents claude` as an example when none is detected.
- Say why in one line: without them, `agent.deny` and the refusal of `--no-verify` before the command runs are not in use; git hooks and CI still hold.

Acceptance: a 0.x workspace with `CLAUDE.md` and no hook configuration gets the line naming `claude`; one whose hooks were renewed does not.

### P4 A shorter typo distance for short names

Goal: a field or configuration key is a likely typo only when it is close to a known name for that name's length ([decision](../decisions/2026-10-15-an-agent-s-push-can-require-handoff.md), item 2).

Design: in `likelyTypo`, the largest distance is 2 when the known name has six letters or more, else 1. Tasks and the configuration share the function.

Acceptance:
- `Later` is a free field, not a typo of `Lane`; a configuration key `id` is kept with a notice, not refused as `dir`.
- `Staus`, `Lnae`, `Pln` and `wipp` are still reported.
- [docs/format.md](../../docs/format.md) says what the specification now says.

### P5 The CI comment neutralises mentions and issue references

Goal: text from the records does not notify people or cross-reference issues when it appears in the pull request comment.

Design:
- Titles and evidence reach the comment through `ciMarkdownText`. Outside code spans, `@name` mentions, `#123` and `owner/repo#123` references and `GH-123` would ping people and leave a reference in other issues' timelines.
- Neutralise them in `ciMarkdownText`'s escaping, so they show as written but GitHub does not link them. Code spans are left alone, as now. The job summary needs nothing, since it notifies nobody, but may share the code.
- Links that the comment itself builds stay links.

Acceptance: a task titled ``Fix @alice's #12 and `@bob` `` gives a comment line where neither `@alice` nor `#12` is a mention or reference, and the code span is unchanged.

### P6 First-run wording: the Evidence line, the README title and the claim message

Goal: three small things that misled people on the first run.

Design:
- `new` writes `- Evidence: —` after the status line, as the format reference's examples do, so that finishing a task shows where its evidence goes. Check that the guard accepts `—` for a task that is not `done`, and that the message for a `done` task with `—` says what to write.
- `init` titles the workspace README with the part of a scoped package name after `/` (`@scope/web` gives `web`).
- `claim` says "visible to others once the branch is pushed" only when the repository has a remote.

Acceptance: a test for each, and the format reference's examples still match what `new` writes.

### P7 Gate detection finds the check script and lists other test and lint scripts

Goal: `init` finds the gates that real projects name `check`, and points at the ones it does not run ([decision](../decisions/2026-10-15-an-agent-s-push-can-require-handoff.md), item 3).

Design:
- `package.json`'s `check` script is a `verify` candidate. The Makefile's `check` is then skipped when the package has the script, by the existing rule.
- Scripts whose names start with `test:` or `lint:` are listed after the gates as candidates to add by hand, with the commands to run them, and never run.

Acceptance: a repository with `check` and `test:unit` scripts gets `check` as a verify gate when it passes, and a line naming `test:unit` that was not run.

### P8 npx resaledger in a repository that npm cannot resolve

Goal: `npx resaledger` works, or fails with a way out, in a repository whose own `package.json` npm cannot resolve.

Design:
- Reproduce: a repository whose `package.json` has an `overrides` entry that conflicts with a direct dependency makes `npx resaledger` fail with `EOVERRIDE` before the package runs, because `npx` reads the project's dependency tree first.
- Find a form of the command that does not read the project, for example `npm exec` with a neutral `--prefix`, and check that the command still runs in the repository. Test it with a packed tarball, not the registry.
- If a form works, use it in the documentation's commands for this case and in the troubleshooting section; if none does, document the fallback of running the package's `bin/resaledger.mjs` with `node`.

Acceptance: the reproduction is a test or, if it needs npm and the network, a documented manual check with its result in the task's evidence.

### P9 An agent's push can require handoff

Goal: with `agent.pushNeedsHandoff: true`, an agent cannot push while `handoff` fails ([decision](../decisions/2026-10-15-an-agent-s-push-can-require-handoff.md), item 1).

Design:
- A new configuration key, boolean, `false` by default, read from the same committed configuration the agent hooks already trust.
- In the before-a-tool check, a command that the parser recognises as `git push`, in any of the forms it already understands (`cd`, `git -C`, chained commands), runs the handoff checks for the worktree the push runs in, leaving out the check that the lane is pushed. A failure refuses the tool call with exit code 2 and handoff's own message.
- The check stays fast: no gates run, as in handoff. The existing push rules run first.
- `ci` treats a change of the key from `true` to `false` as a weakening, like the other enforcement keys; `config` prints it.

Acceptance:
- With the key, an agent's push from a dirty tree, or with a `doing` task without a current Handoff, is refused for every agent adapter; a ready lane pushes.
- Without the key nothing changes.
- The agents guide and the format reference describe the key.

### P10 A guide to work the hooks cannot see

Goal: a project records work that happens outside its code, such as content edited in a CMS over SSH or a command-line tool, or a server setting, and knows what the ledger does and does not enforce there.

Design:
- A guide in `docs/guides/`: such work is a task like any other. Its evidence is what someone else can check: a small screenshot in `ledger/evidence/`, without personal data; the address of the changed page; a revision id; or the command and its output.
- Say plainly that the hooks see commits, not a database, so for this work the ledger keeps the record and the hand-off, but nothing refuses work that was never recorded.
- Plans and documents outside the repository: links must resolve inside it, so name an outside document in a code span or a URL.
- The skill gets the same guidance in a few lines.

Acceptance: the guide's commands pass the documentation test, and the skill links to the guide.

### P11 Staged publishing in the release guide

Goal: [releasing.md](../../docs/releasing.md) describes publishing that waits for the owner's approval.

Design: check npm's current documentation for staged publishing and how a publish from trusted publishing is approved; describe the setting the owner changes and how a release is approved. The owner changes the setting.

Acceptance: the release guide's steps match npm's documentation, with the date it was read.
