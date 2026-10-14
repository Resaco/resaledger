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
- Status: blocked
- Lane: main
- Depends on: —
- Plan: [G-brand.md](../plan/G-brand.md#g1-brand-concepts)
- Evidence: —
- Notes: Waiting for the owner: three variants of the ruled-lanes mark (C1 parallel, C2 converging, C3 merging) and a six-frame storyboard of the animated explanation are ready for review, with the designer recommending C1. The owner picks the variant, decides whether the spray treatment belongs on the mark or only on covers, and approves the typeface. The working files stay outside this repository.

### G2 Final logo and cover
- Status: todo
- Depends on: G1
- Plan: [G-brand.md](../plan/G-brand.md#g2-final-logo-and-cover)
- Evidence: —
- Notes: —

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
- Status: doing
- Depends on: F1
- Plan: [F-foundation.md](../plan/F-foundation.md#f2-ci-for-this-repository-and-the-hygiene-checks)
- Evidence: —
- Notes: A worker builds it on branch `f2-ci-hygiene` in its own worktree. Next: review the worker's report against the acceptance checks, merge, record the evidence.

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
- Status: doing
- Depends on: R1, R2
- Plan: [R-records.md](../plan/R-records.md#r3-task-files)
- Evidence: —
- Notes: A worker builds it on branch `r3-tasks` in its own worktree. Next: review the worker's report against the acceptance checks, merge, record the evidence.

### R4 Decisions, log entries, plans and the workspace README
- Status: doing
- Depends on: R2
- Plan: [R-records.md](../plan/R-records.md#r4-decisions-log-entries-plans-and-the-workspace-readme)
- Evidence: —
- Notes: A worker builds it on branch `r4-records` in its own worktree. Next: review the worker's report against the acceptance checks, merge, record the evidence.

### R5 `check`, what counts as code, and the fingerprint
- Status: todo
- Depends on: R3, R4
- Plan: [R-records.md](../plan/R-records.md#r5-check-what-counts-as-code-and-the-fingerprint)
- Evidence: —
- Notes: —

## V: Gates, stamps, the range check and handoff

### V1 Gates and stamps
- Status: todo
- Depends on: R5
- Plan: [V-verify.md](../plan/V-verify.md#v1-gates-and-stamps)
- Evidence: —
- Notes: —

### V2 The commit range check
- Status: todo
- Depends on: R5
- Plan: [V-verify.md](../plan/V-verify.md#v2-the-commit-range-check)
- Evidence: —
- Notes: —

### V3 `handoff`
- Status: todo
- Depends on: V1, V2, H3
- Plan: [V-verify.md](../plan/V-verify.md#v3-handoff)
- Evidence: —
- Notes: —

## H: Git hooks

### H1 pre-commit
- Status: todo
- Depends on: R5
- Plan: [H-hooks.md](../plan/H-hooks.md#h1-pre-commit)
- Evidence: —
- Notes: —

### H2 commit-msg and pre-push
- Status: todo
- Depends on: V2
- Plan: [H-hooks.md](../plan/H-hooks.md#h2-commit-msg-and-pre-push)
- Evidence: —
- Notes: —

### H3 Hook scripts and activation
- Status: todo
- Depends on: F1
- Plan: [H-hooks.md](../plan/H-hooks.md#h3-hook-scripts-and-activation)
- Evidence: —
- Notes: —

## W: The daily commands

### W1 `work` on this machine
- Status: todo
- Depends on: R5, H3
- Plan: [W-work.md](../plan/W-work.md#w1-work-on-this-machine)
- Evidence: —
- Notes: —

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
- Status: todo
- Depends on: F1
- Plan: [M-migration.md](../plan/M-migration.md#m1-reading-0x-workspaces)
- Evidence: —
- Notes: —

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
