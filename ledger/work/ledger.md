# Task ledger

Every task, in the order it should be done. Format and rules: [standards.md](../standards.md#the-task-ledger). A task's commits carry `Task: <id>`.

## S: Research and the specification

### S1 Study the projects that solve neighbouring problems
- Status: done
- Depends on: —
- Plan: [spec.md](../plan/spec.md#2-positioning)
- Evidence: The findings and their sources are in the [appendix](../plan/spec.md#appendix-landscape-sources) and the positioning in [section 2](../plan/spec.md#2-positioning): the eight projects named in the brief plus five enforcement tools, read through `gh` (README, documentation, source, and at least 40 issue titles per project with the most discussed read in full). Not verified: how fast each project gained its stars, because the stargazer timeline was not available.
- Notes: The hypothesis that nobody else enforces holds only as a combination. Done-gates inside one agent session are now common; nobody combines records in the repository, enforcement at git and CI, code-bound results and conflict-free parallel lanes.

### S2 Measure how the 0.x format held up in use
- Status: done
- Depends on: —
- Plan: [spec.md](../plan/spec.md#1-the-problem)
- Evidence: The design lessons are written into the [specification](../plan/spec.md) where they apply. The measurements come from private projects, so they are kept outside this repository and cannot be rerun from here.
- Notes: —

### S3 Write the 1.0 specification
- Status: done
- Depends on: S1, S2
- Plan: [spec.md](../plan/spec.md)
- Evidence: [spec.md](../plan/spec.md) covers every topic the brief asks for: problem, positioning, principles, format reference, lane model, branch presets, command line, CI enforcement, agent integrations, trust model, distribution, migration, format stability, testing, what is not in 1.0, launch, risks and open questions, plus an appendix of sources. Every decision states its reason. Not verified: nobody but its author has reviewed it yet; that is [S4](#s4-the-owners-decisions-on-the-specification).
- Notes: —

### S4 The owner's decisions on the specification
- Status: done
- Depends on: S3
- Plan: [spec.md](../plan/spec.md#21-the-owners-decisions)
- Evidence: The decisions of 15 October are in [DECISIONS.md](../DECISIONS.md) and in [section 21](../plan/spec.md#21-the-owners-decisions) of the specification: the name, the licence, the commit identity, the cut of guard-only mode, the `changes` command, the predecessor's name in the history, and a separate review of the plan. The owner answered every open question and asked for no change to the specification.
- Notes: —

## G: Brand and graphics

### G1 Brand concepts
- Status: done
- Lane: main
- Depends on: —
- Plan: [G-brand.md](../plan/G-brand.md#g1-brand-concepts)
- Evidence: The owner chose C1 (parallel ruled lanes) on 15 October from a comparison sheet of three variants and a six-frame storyboard. The designer measured the text contrast with no failure and rendered each mark at 64, 32 and 16 px. The sheet and the working files are private brand files outside this repository, so this evidence cannot be opened from here; the approved exports arrive in G2.
- Notes: No spray texture anywhere, by the owner's decision; the grain stays.

### G2 Final logo and cover
- Status: blocked
- Depends on: G1
- Plan: [G-brand.md](../plan/G-brand.md#g2-final-logo-and-cover)
- Evidence: —
- Notes: Waiting for the owner: the finished C1 set is ready for approval in the private brand files, with two deliberate deviations to accept: at 16 px the inner corners are square so the three lanes stay crisp, and the light cover's small text uses the wall colour for contrast. After approval, the exports come into `docs/assets/brand/`.

### G3 Animated explanations of how it works
- Status: todo
- Depends on: G2
- Plan: [G-brand.md](../plan/G-brand.md#g3-animated-explanations-of-how-it-works)
- Evidence: —
- Notes: —

## F: Foundation

### F1 Package, source layout, bundler and test harness
- Status: done
- Depends on: —
- Plan: [F-foundation.md](../plan/F-foundation.md#f1-package-source-layout-bundler-and-test-harness)
- Evidence: `node scripts/test.mjs`: 18 of 18 on Node 24.18.0, 22.23.3 and 20.20.2, run by the lead on the worker's branch before the merge and again on `main` after it; `node scripts/bundle.mjs --check` passes and leaves no `dist/` folder; the bundler's rules are tested in [bundle.test.mjs](../../test/bundle.test.mjs) and the helpers live in [helpers.mjs](../../test/helpers.mjs). Not verified: Linux and Windows, which run in CI once the repository is pushed.
- Notes: Merged in 003227c. The bundler's conventions are summarised in [modules.md](../plan/modules.md#conventions). The repository's gates now run the bundle check on every code commit and `npm test` in `verify`.

### F2 CI for this repository, and the hygiene checks
- Status: done
- Depends on: F1
- Plan: [F-foundation.md](../plan/F-foundation.md#f2-ci-for-this-repository-and-the-hygiene-checks)
- Evidence: [test.yml](../../.github/workflows/test.yml) parses as YAML (checked with Ruby's parser); the [hygiene tests](../../test/hygiene.test.mjs) plant each kind of leak in temporary repositories and catch it, and pass on this repository; `node scripts/scan-history.mjs` on the real history: clean, after the commit identity's public handle was taken off the private deny-list. Not verified: the workflow on GitHub's runners (it runs once the repository is pushed).
- Notes: The scan rules live in [hygiene.mjs](../../scripts/hygiene.mjs), shared by the test and the history scan.

## R: The record format

### R1 Configuration
- Status: done
- Depends on: F1
- Plan: [R-records.md](../plan/R-records.md#r1-configuration)
- Evidence: `node scripts/test.mjs` on `main` after merging R1 and R2: 64 of 64 on Node 24.18.0, 22.23.3 and 20.20.2; the configuration's 17 tests, one of them end to end through the bundle, are in [config.test.mjs](../../test/config.test.mjs); `node dist/records.mjs config` prints the effective configuration. Not verified: Linux and Windows (CI).
- Notes: `config` is null when the file has any problem. A missing or unknown version is reported alone, so a newer format's keys make no noise. A deny rule needs a pattern; its reason is optional.

### R2 Markdown primitives
- Status: done
- Depends on: F1
- Plan: [R-records.md](../plan/R-records.md#r2-markdown-primitives)
- Evidence: `node scripts/test.mjs`: 47 of 47 on Node 24.18.0, 22.23.3 and 20.20.2, run by the lead on the worker's branch and on `main` after the merge; the 29 new tests are in [markdown.test.mjs](../../test/markdown.test.mjs). Not verified: GitHub's anchors for headings that use emphasis or HTML, which are slugged from the rendered text; records do not use them.
- Notes: Merged in the commit after 9258eb4 and d4eadd8. Anchors follow github-slugger's numbering of duplicates. `parseFields` skips blank lines before the list, so callers can pass the line after a heading.

### R3 Task files
- Status: done
- Depends on: R1, R2
- Plan: [R-records.md](../plan/R-records.md#r3-task-files)
- Evidence: `node scripts/test.mjs` on `main` after merging R3 and F2 and the lead's follow-up fixes: 162 of 162 on Node 24.18.0 (159 of 159 before the fixes on 22.23.3 and 20.20.2 too); the 53 task tests are in [tasks.test.mjs](../../test/tasks.test.mjs). Not verified: Linux and Windows (CI).
- Notes: The lead added two things on review: an anchor in any link into a Markdown file must be a heading there, and slugs transliterate letters such as ß and ø. Field names are exact, and a near miss names the right spelling; decisions and log entries now follow the same rule.

### R4 Decisions, log entries, plans and the workspace README
- Status: done
- Depends on: R2
- Plan: [R-records.md](../plan/R-records.md#r4-decisions-log-entries-plans-and-the-workspace-readme)
- Evidence: `node scripts/test.mjs` on `main` after merging R4: 95 of 95 on Node 24.18.0, 22.23.3 and 20.20.2; the 31 new tests, with CRLF input for every record type, are in [records.test.mjs](../../test/records.test.mjs). Not verified: Linux and Windows (CI).
- Notes: A README with a marker fails and passes once the text is written. Field names are compared case-insensitively; a repeated field is a problem.

### R5 `check`, what counts as code, and the fingerprint
- Status: done
- Depends on: R3, R4
- Plan: [R-records.md](../plan/R-records.md#r5-check-what-counts-as-code-and-the-fingerprint)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 213 of 213 on Node 24.18.0, 22.23.3 and 20.20.2; the 51 workspace tests, including the fingerprint's equality between the index and HEAD and across a CRLF checkout, are in [workspace.test.mjs](../../test/workspace.test.mjs). `check` takes 0.4 to 0.6 seconds on a workspace of 300 tasks. Not verified: Linux and Windows (CI).
- Notes: `check` reads the configuration from the source it checks, so `--rev` on an old commit checks that commit's folder. A plan file outside `plan/` still blocks `doing` while it says proposal. Possible speed-up later: remember each plan file's headings within one run.

## V: Gates, stamps, the range check and handoff

### V1 Gates and stamps
- Status: done
- Depends on: R5
- Plan: [V-verify.md](../plan/V-verify.md#v1-gates-and-stamps)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 268 of 268 on Node 24.18.0, 22.23.3 and 20.20.2 (with W1's verification state); the 23 tests in [gates.test.mjs](../../test/gates.test.mjs) include two branches verifying the same code and a new stamp against a pruned one, merged in both orders with ten long gates. Not verified: Windows shells (CI).
- Notes: The stamp's gate list is a digest bound to the fingerprint, so no two stamps look like a rename to git. `work` now says whether the gates passed on the code at HEAD.

### V2 The commit range check
- Status: done
- Depends on: R5
- Plan: [V-verify.md](../plan/V-verify.md#v2-the-commit-range-check)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 296 of 296 on Node 24.18.0 (22.23.3 and 20.20.2 recorded in the next log entry); the 29 tests in [range.test.mjs](../../test/range.test.mjs) cover every exemption, a claim in a records-only commit, a branch renamed after its claim, and 200 commits in under 0.4 seconds against a 3-second budget. Not verified: Windows (CI).
- Notes: On review the lane rule became range-wide: a Lane set inside the checked range is accepted, so the rule only refuses tasks another lane held before the range. Taking a held task is caught by the ownership checks in H1 and C1.

### V3 `handoff`
- Status: doing
- Depends on: V1, V2, H3
- Plan: [V-verify.md](../plan/V-verify.md#v3-handoff)
- Evidence: —
- Notes: A worker builds it on branch `v3-handoff` in its own worktree. Next: review the worker's report against the acceptance checks, merge, record the evidence.

## H: Git hooks

### H1 pre-commit
- Status: doing
- Depends on: R5
- Plan: [H-hooks.md](../plan/H-hooks.md#h1-pre-commit)
- Evidence: —
- Notes: A worker builds it on branch `h1-pre-commit` in its own worktree. Next: review the worker's report against the acceptance checks, merge, record the evidence.

### H2 commit-msg and pre-push
- Status: todo
- Depends on: V2
- Plan: [H-hooks.md](../plan/H-hooks.md#h2-commit-msg-and-pre-push)
- Evidence: —
- Notes: —

### H3 Hook scripts and activation
- Status: done
- Depends on: F1
- Plan: [H-hooks.md](../plan/H-hooks.md#h3-hook-scripts-and-activation)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 230 of 230 on Node 24.18.0, 22.23.3 and 20.20.2; the 17 hook tests in [githooks.test.mjs](../../test/githooks.test.mjs) run the hooks through real git commits and pushes, find Node with a limited PATH, and integrate husky and simple-git-hooks idempotently. Not verified: Windows and Linux (CI); lefthook and the pre-commit framework against real installations.
- Notes: For lefthook and the pre-commit framework the guard prints a snippet instead of editing YAML. The pre-commit framework passes no stdin to pre-push hooks, so H2 needs its environment variables instead.

## W: The daily commands

### W1 `work` on this machine
- Status: done
- Depends on: R5, H3
- Plan: [W-work.md](../plan/W-work.md#w1-work-on-this-machine)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 243 of 243 on Node 24.18.0, 22.23.3 and 20.20.2; the 13 tests in [work.test.mjs](../../test/work.test.mjs) cover a solo workspace, three worktrees with an uncommitted claim, a double and a stale claim, `--json`, hooks turned on in a fresh clone, and 300 tasks in about half a second. Not verified: Linux and Windows (CI).
- Notes: The verification state is not shown yet; the lead adds it once V1's stamps merge. A lane that exists only as a remote-tracking branch shows as a stale claim until W2 adds remote lanes.

### W2 `work --all` across pushed branches
- Status: todo
- Depends on: W1
- Plan: [W-work.md](../plan/W-work.md#w2-work---all-across-pushed-branches)
- Evidence: —
- Notes: —

### W3 `task` and `new`
- Status: todo
- Depends on: W1
- Plan: [W-work.md](../plan/W-work.md#w3-task-and-new)
- Evidence: —
- Notes: —

### W4 `claim`
- Status: todo
- Depends on: W2, W3
- Plan: [W-work.md](../plan/W-work.md#w4-claim)
- Evidence: —
- Notes: —

### W5 `changes`
- Status: todo
- Depends on: V2
- Plan: [W-work.md](../plan/W-work.md#w5-changes)
- Evidence: —
- Notes: —

## C: The CI check

### C1 The CI check
- Status: todo
- Depends on: V1, V2, H1
- Plan: [C-ci.md](../plan/C-ci.md#c1-the-ci-check)
- Evidence: —
- Notes: —

### C2 Changes to enforcement
- Status: todo
- Depends on: C1
- Plan: [C-ci.md](../plan/C-ci.md#c2-changes-to-enforcement)
- Evidence: —
- Notes: —

### C3 Output, workflow and templates
- Status: todo
- Depends on: C1
- Plan: [C-ci.md](../plan/C-ci.md#c3-output-workflow-and-templates)
- Evidence: —
- Notes: —

## A: Agent integrations

### A1 The agent hook core, Claude Code and Codex
- Status: todo
- Depends on: W1, H1
- Plan: [A-agents.md](../plan/A-agents.md#a1-the-agent-hook-core-claude-code-and-codex)
- Evidence: —
- Notes: —

### A2 Cursor, Gemini CLI and GitHub Copilot
- Status: todo
- Depends on: A1
- Plan: [A-agents.md](../plan/A-agents.md#a2-cursor-gemini-cli-and-github-copilot)
- Evidence: —
- Notes: —

### A3 The `AGENTS.md` block, the skill and the plugin
- Status: todo
- Depends on: I1
- Plan: [A-agents.md](../plan/A-agents.md#a3-the-agentsmd-block-the-skill-and-the-plugin)
- Evidence: —
- Notes: —

## I: The installer

### I1 `init`
- Status: todo
- Depends on: R1, R4, H3
- Plan: [I-installer.md](../plan/I-installer.md#i1-init)
- Evidence: —
- Notes: —

### I2 Detecting the gates
- Status: todo
- Depends on: F1
- Plan: [I-installer.md](../plan/I-installer.md#i2-detecting-the-gates)
- Evidence: —
- Notes: —

### I3 `update` and the package's command line
- Status: todo
- Depends on: I1
- Plan: [I-installer.md](../plan/I-installer.md#i3-update-and-the-packages-command-line)
- Evidence: —
- Notes: —

## M: Migration

### M1 Reading 0.x workspaces
- Status: doing
- Depends on: F1
- Plan: [M-migration.md](../plan/M-migration.md#m1-reading-0x-workspaces)
- Evidence: —
- Notes: A worker builds it on branch `m1-legacy-read` in its own worktree. Next: review the worker's report against the acceptance checks, merge, record the evidence.

### M2 Converting, safely
- Status: todo
- Depends on: M1, R5
- Plan: [M-migration.md](../plan/M-migration.md#m2-converting-safely)
- Evidence: —
- Notes: —

### M3 Verification on real workspaces
- Status: todo
- Depends on: M2
- Plan: [M-migration.md](../plan/M-migration.md#m3-verification-on-real-workspaces)
- Evidence: —
- Notes: —

### M4 This repository moves to 1.0
- Status: todo
- Depends on: M3, T5, I3, H2, V3
- Plan: [M-migration.md](../plan/M-migration.md#m4-this-repository-moves-to-10)
- Evidence: —
- Notes: —

## T: Acceptance and independent review

### T1 The parallel-lanes acceptance test
- Status: todo
- Depends on: W4, V3, H2, C1
- Plan: [T-acceptance.md](../plan/T-acceptance.md#t1-the-parallel-lanes-acceptance-test)
- Evidence: —
- Notes: —

### T2 Performance and Windows
- Status: todo
- Depends on: W2, H3
- Plan: [T-acceptance.md](../plan/T-acceptance.md#t2-performance-and-windows)
- Evidence: —
- Notes: —

### T3 Independent review of the guard
- Status: todo
- Depends on: V3, H2
- Plan: [T-acceptance.md](../plan/T-acceptance.md#t3-independent-review-of-the-guard)
- Evidence: —
- Notes: —

### T4 Independent review of the CI check
- Status: todo
- Depends on: C2, C3
- Plan: [T-acceptance.md](../plan/T-acceptance.md#t4-independent-review-of-the-ci-check)
- Evidence: —
- Notes: —

### T5 Independent review of `migrate`
- Status: todo
- Depends on: M3
- Plan: [T-acceptance.md](../plan/T-acceptance.md#t5-independent-review-of-migrate)
- Evidence: —
- Notes: —

## D: Documentation and repository files

### D1 The format reference
- Status: todo
- Depends on: R5
- Plan: [D-docs.md](../plan/D-docs.md#d1-the-format-reference)
- Evidence: —
- Notes: —

### D2 Guides
- Status: todo
- Depends on: W4, C3, A3, I3
- Plan: [D-docs.md](../plan/D-docs.md#d2-guides)
- Evidence: —
- Notes: —

### D3 Repository files and releases
- Status: todo
- Depends on: W5
- Plan: [D-docs.md](../plan/D-docs.md#d3-repository-files-and-releases)
- Evidence: —
- Notes: —

### D4 The README
- Status: todo
- Depends on: D2, G2, G3, L1
- Plan: [D-docs.md](../plan/D-docs.md#d4-the-readme)
- Evidence: —
- Notes: —

## L: The demo, the launch drafts and the release candidate

### L1 The terminal demo
- Status: todo
- Depends on: I1, W4, T1
- Plan: [L-launch.md](../plan/L-launch.md#l1-the-terminal-demo)
- Evidence: —
- Notes: —

### L2 Release notes and launch drafts
- Status: todo
- Depends on: D4
- Plan: [L-launch.md](../plan/L-launch.md#l2-release-notes-and-launch-drafts)
- Evidence: —
- Notes: —

### L3 The release candidate
- Status: todo
- Depends on: D4, L2, T1, T2, T3, T4, M4, D1, D3, A2
- Plan: [L-launch.md](../plan/L-launch.md#l3-the-release-candidate)
- Evidence: —
- Notes: —
