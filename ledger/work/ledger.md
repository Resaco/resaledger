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
- Evidence: The owner chose C1 (parallel ruled lanes) on 15 October from a comparison sheet of three variants and a six-frame storyboard, as recorded in [DECISIONS.md](../DECISIONS.md). The designer measured the text contrast with no failure and rendered each mark at 64, 32 and 16 px. The sheet and the working files are private brand files outside this repository; the approved exports arrive in G2.
- Notes: No spray texture anywhere, by the owner's decision; the grain stays.

### G2 Final logo and cover
- Status: done
- Depends on: G1
- Plan: [G-brand.md](../plan/G-brand.md#g2-final-logo-and-cover)
- Evidence: `node --test test/brand.test.mjs`: 3 of 3 on [the exported files](../../docs/assets/brand/README.md): every SVG holds only paths, every file is described, and the covers and small marks have their sizes. The designer measured the covers' text contrast at 5.78:1 at worst on dark and 11.28:1 on light, and the owner approved the set on 15 October, its two deviations included.
- Notes: The working files stay in the private brand files. The interim README shows the cover until D4 writes the real one.

### G3 Animated explanations of how it works
- Status: done
- Depends on: G2
- Plan: [G-brand.md](../plan/G-brand.md#g3-animated-explanations-of-how-it-works)
- Evidence: [how-it-works.test.mjs](../../test/how-it-works.test.mjs) passes on [the two files](../../docs/assets/how-it-works/how-it-works-dark.svg): each is under 75 KB, runs no script, loads nothing from outside and has a still frame for reduced motion. The lead stepped through the loop frame by frame in Chromium; the storyboard's six beats are there.
- Notes: The owner chose one loop over three and saw it play in the README on GitHub on 15 October. Not checked: Firefox and Safari. The generator stays with the private brand files, as G2's tools do.

### G4 More README graphics: use cases, and where a bad commit stops
- Status: done
- Depends on: G2
- Plan: [G-brand.md](../plan/G-brand.md#g4-more-readme-graphics)
- Evidence: [how-it-works.test.mjs](../../test/how-it-works.test.mjs) checks [the four files](../../docs/assets/readme/use-cases-dark.svg): each is under 220 KB, has a title, runs no script and loads nothing from outside. The owner approved both images on 15 October, and the README shows them with the same information as text.
- Notes: The generator stays with the private brand files, next to G3's.

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
- Status: done
- Depends on: V1, V2, H3
- Plan: [V-verify.md](../plan/V-verify.md#v3-handoff)
- Evidence: `node scripts/test.mjs` on `main` after the merge and the lead's fix: 359 of 359 on Node 24.18.0, 22.23.3 and 20.20.2; the 19 tests in [handoff.test.mjs](../../test/handoff.test.mjs) cover every failure, a one-commit session, a detached HEAD, the team preset's push checks and a commit made with `--no-verify`. Not verified: Windows (CI).
- Notes: On review the lead made only code commits count as the last commit on a task, so a claim or a stamp that names the task does not make its handoff note stale.

## H: Git hooks

### H1 pre-commit
- Status: done
- Depends on: R5
- Plan: [H-hooks.md](../plan/H-hooks.md#h1-pre-commit)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 359 of 359 on Node 24.18.0, 22.23.3 and 20.20.2; the 17 tests in [precommit.test.mjs](../../test/precommit.test.mjs) commit through git with the bundled guard, one per refusal, and prove that a partial commit is judged on git's temporary index, not on the working tree. Not verified: Windows (CI).
- Notes: During a merge, a held task staged exactly as the merged commit has it passes, because it is that lane's own change. The check that ids are unique across locally visible branches (spec section 9) moved to C1, which builds it for CI and adds it to pre-commit.

### H2 commit-msg and pre-push
- Status: done
- Depends on: V2
- Plan: [H-hooks.md](../plan/H-hooks.md#h2-commit-msg-and-pre-push)
- Evidence: `node scripts/test.mjs` on `main` after the merges: 507 of 507 on Node 24.18.0, 22.23.3 and 20.20.2. [commitmsg.test.mjs](../../test/commitmsg.test.mjs) commits through git for every exemption, style, attribution and trailer rule, including people named Claude, Devin, Jules or Kimi, who pass; [prepush.test.mjs](../../test/prepush.test.mjs) pushes to a bare remote, and a commit made with `--no-verify` and no trailer is refused when it is pushed. Not verified: Windows (CI).
- Notes: Known gaps: with `--amend` the staged diff is taken against HEAD, not the amended commit's parent; and the pre-commit framework runs no hook when a branch is deleted, so deleting a protected branch is not caught under it. On review the lead had the four assistant names that are also first names matched only in forms no person has.

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
- Status: done
- Depends on: W1
- Plan: [W-work.md](../plan/W-work.md#w2-work---all-across-pushed-branches)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 533 of 533 on Node 24.18.0, 22.23.3 and 20.20.2. [work.test.mjs](../../test/work.test.mjs) covers two pushed lanes holding the same task, stale claims from a merged and from a deleted branch, `--fetch` against an unreachable remote, a lane that is both a worktree and pushed, verified and unverified heads, and 500 branches in 0.5 to 1.6 seconds on a loaded machine; [lanes.test.mjs](../../test/lanes.test.mjs) reads another worktree with git's hook variables set. Not verified: git before 2.41 (its fallback was measured by hand), Windows (CI).
- Notes: A worktree lane is never reported stale, because a fresh worktree at the base looks merged. `--fetch` implies `--all`. Reading another worktree now ignores the variables git sets for hooks, in `localLanes` itself.

### W3 `task` and `new`
- Status: done
- Depends on: W1
- Plan: [W-work.md](../plan/W-work.md#w3-task-and-new)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 525 of 525 on Node 24.18.0, 22.23.3 and 20.20.2; the 17 tests in [create.test.mjs](../../test/create.test.mjs) cover a gap in the numbers, a child of a child, ids taken in another worktree, on a local branch and on a remote-tracking branch, non-ASCII, long and duplicate titles for tasks, decisions and log entries, `task` with and without a plan section, and `--issue` with a stand-in for `gh`; every file created passes `check`. Not verified: Windows (CI; the `--issue` tests skip there).
- Notes: A dated decision or log name counts as taken when any branch has it, through the one-batch scan that `ids.mjs` now shares (`branchFolderNames`). `Decided by` falls back to a dash, which `check` refuses on purpose, so nobody commits a decision unsigned.

### W4 `claim`
- Status: done
- Depends on: W2, W3
- Plan: [W-work.md](../plan/W-work.md#w4-claim)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 581 of 581 on Node 24.18.0, 22.23.3 and 20.20.2. The 12 tests in [claim.test.mjs](../../test/claim.test.mjs) cover a double claim between two worktrees and then `--take`, which pre-commit accepts; a double claim between two clones through a bare remote in the team preset; `--worktree`; `--push`; the WIP limit and a missing plan; a fetch that fails; and byte-for-byte editing of the task file. Not verified: Windows (CI).
- Notes: A lane branch is named `<branchPrefix><id in lowercase>-<slug>`, as spec section 6.3 now says. `claim` does not check that a takeover branch starts from the old lane, and a stale claim gets the same refusal as a live one, with the advice to take it over.

### W5 `changes`
- Status: todo
- Depends on: V2
- Plan: [W-work.md](../plan/W-work.md#w5-changes)
- Evidence: —
- Notes: —

## C: The CI check

### C1 The CI check
- Status: done
- Depends on: V1, V2, H1
- Plan: [C-ci.md](../plan/C-ci.md#c1-the-ci-check)
- Evidence: `node scripts/test.mjs` on `main` after merging C1 and H2: 466 of 466 on Node 24.18.0, 22.23.3 and 20.20.2. The 27 tests in [ci.test.mjs](../../test/ci.test.mjs) run simulated GitHub events for each rule, a fork, pushes after a squash merge and after a merge commit, the first pull request that adds ResaLedger, rules taken from the base when the head weakens its own, `ci.runGates: false` with and without a stamp, and a shallow clone; the 6 tests in [ids.test.mjs](../../test/ids.test.mjs) cover the id scan across branches and worktrees, and a commit that adds a task takes about 1 s with 51 branches. Not verified: a real GitHub Actions run (C3 adds the workflow) and Windows.
- Notes: For C3: the workflow must run on `pull_request`, never `pull_request_target`, because the gates run the pull request's code; and gate output appears above the `ci` header today. Pre-commit clears git's location variables while it reads the other worktrees, because git sets `GIT_INDEX_FILE` for hooks; W2 moves that into `localLanes`, so every caller is safe.

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
- Status: done
- Depends on: W1, H1
- Plan: [A-agents.md](../plan/A-agents.md#a1-the-agent-hook-core-claude-code-and-codex)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 679 of 679 on Node 24.18.0, 22.23.3 and 20.20.2. The 59 tests in [agents.test.mjs](../../test/agents.test.mjs) use recorded input for every event of both agents ([fixtures](../../test/fixtures/agents/claude-pre-tool-bash.json)); quoted text never triggers a refusal; the reminder fires once when called twice; every refusal kind, `agent.deny`, an edit on a protected branch, unknown input and merging into an existing `settings.json` are covered. Not verified: a live Claude Code or Codex session, and Windows.
- Notes: The input formats come from the agents' documentation; Codex loads project hooks only for a trusted project. Known gaps, listed in the module header: `cp`, `mv`, `perl -i`, other editor tools and variables that disable other hook managers. Open: `update` adds the configuration back for an agent whose folder exists even when a project removed it on purpose; A2 decides with the other agents.

### A2 Cursor, Gemini CLI and GitHub Copilot
- Status: todo
- Depends on: A1
- Plan: [A-agents.md](../plan/A-agents.md#a2-cursor-gemini-cli-and-github-copilot)
- Evidence: —
- Notes: Also add to the built-in refusals the commands that throw work away (`reset --hard`, `clean -f`, `checkout -- .`, `restore`) when they would hit another lane's worktree or a protected branch: on 15 October an experimenting reviewer's shell ran such a chain in the lead's checkout. Decide too whether `update` adds back an agent configuration a project removed on purpose.

### A3 The `AGENTS.md` block, the skill and the plugin
- Status: todo
- Depends on: I1
- Plan: [A-agents.md](../plan/A-agents.md#a3-the-agentsmd-block-the-skill-and-the-plugin)
- Evidence: —
- Notes: —

## I: The installer

### I1 `init`
- Status: done
- Depends on: R1, R4, H3
- Plan: [I-installer.md](../plan/I-installer.md#i1-init)
- Evidence: `node scripts/test.mjs` on `main` after the merges: 507 of 507 on Node 24.18.0, 22.23.3 and 20.20.2; the 39 tests in [init.test.mjs](../../test/init.test.mjs) set up real repositories in the solo and team presets, with `--yes` and off a terminal, with `--dir`, an existing `ledger/`, `AGENTS.md` and `CLAUDE.md`, husky, a dirty file and a 0.x workspace, and run the printed commit command through the installed hooks. Not verified: Windows (CI); the interactive questions on a real terminal.
- Notes: `init` and `migrate` share the managed block, the guard build and turning the hooks on (`src/cli/setup.mjs`). `init` also refuses to overwrite a `.githooks/` hook that is not ResaLedger's. The `--agents`, `--no-run` and `--no-ci` flags come with A1, I2 and C3, which add their steps.
- Follow-up: in the team preset, pre-commit refuses the printed setup commit on the protected base; `init --team` must set up on a branch and say to open a pull request (found by T3's reviewer).

### I2 Detecting the gates
- Status: todo
- Depends on: F1
- Plan: [I-installer.md](../plan/I-installer.md#i2-detecting-the-gates)
- Evidence: —
- Notes: —

### I3 `update` and the package's command line
- Status: done
- Depends on: I1
- Plan: [I-installer.md](../plan/I-installer.md#i3-update-and-the-packages-command-line)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 558 of 558 on Node 24.18.0, 22.23.3 and 20.20.2. [update.test.mjs](../../test/update.test.mjs) covers a clean update, an upgrade from a released version, a hand-edited hook and block kept and then forced, a missing guard restored, a newer guard refused, and commands passed to the repository's guard from a subfolder with their stdin and exit code; [package.test.mjs](../../test/package.test.mjs) checks the list that `npm pack` publishes. Not verified: Windows (CI).
- Notes: An older package recognises a newer guard by the guard's version line. Spec section 15 now says that releases record hashes of the managed files instead of version lines in the hooks and the block. `scripts/release-hashes.mjs` adds a release's hashes; L3 runs it.

## M: Migration

### M1 Reading 0.x workspaces
- Status: done
- Depends on: F1
- Plan: [M-migration.md](../plan/M-migration.md#m1-reading-0x-workspaces)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 323 of 323 on Node 24.18.0; the 27 tests in [legacy.test.mjs](../../test/legacy.test.mjs) cover every quirk on the list with synthetic fixtures and parse this repository's own 0.x records with no problem and no line lost. A read-only run on two private 0.x workspaces preserved every line; its counts stay outside this repository. Not verified: Node 22 and 20 on the merged tree (next verify), Linux and Windows (CI).
- Notes: The worker found nine things the migration table did not cover; the specification's section 14 now says where each goes. The package now publishes `src/guard`, so the migration can validate with the 1.0 rules.

### M2 Converting, safely
- Status: done
- Depends on: M1, R5
- Plan: [M-migration.md](../plan/M-migration.md#m2-converting-safely)
- Evidence: `node scripts/test.mjs` on `main` after the merge: 397 of 397 on Node 24.18.0 and 22.23.3, 400 of 400 on 20.20.2 with the brand tests; the 36 tests in [migrate.test.mjs](../../test/migrate.test.mjs) migrate real repositories built from synthetic 0.x workspaces, prove that every refusal leaves the tree unchanged byte for byte and that an injected loss stops the plan, and migrate this repository's own workspace in a clone and commit it through the new hooks. In a temporary clone the worker migrated this workspace: 50 tasks, 23 decisions and 12 log entries, no line lost, 12 links rewritten. Not verified: Windows (CI); the private workspaces (M3).
- Notes: On review the lead made the undo command use root pathspecs, so it is whole when run from a subfolder, and made `migrate` count untracked files that `status.showUntrackedFiles` hides, because the undo's `git clean` would delete them. This workspace's own records must stay valid under the 1.0 rules until M4, or the self-migration test fails.

### M3 Verification on real workspaces
- Status: done
- Depends on: M2
- Plan: [M-migration.md](../plan/M-migration.md#m3-verification-on-real-workspaces)
- Evidence: The lead migrated copies of two private 0.x workspaces in a temporary folder outside this repository: both migrated with no line lost and pass `check` with the 1.0 guard, and a sample of tasks, decisions, log entries, the README and the managed `AGENTS.md` block read correctly. The rule for blocked tasks is tested in [migrate.test.mjs](../../test/migrate.test.mjs); the names, paths and counts are in private notes. Not verified: a commit of the result through the hooks, because the copies' commit gates need their projects' dependencies.
- Notes: The run showed that real blocked tasks say what they wait for in their notes, so `migrate` now takes Waiting for from the first "Waits for …" or "Blocked on …" phrase and lists each one; spec section 14 says so. Free-text status lines in plans stay a 1.0 problem for the owner to fix before migrating, because rewriting them would be interpretation.

### M4 This repository moves to 1.0
- Status: todo
- Depends on: M3, T5, I3, H2, V3, A1, T5.1, T5.2, T3.1, T3.2
- Plan: [M-migration.md](../plan/M-migration.md#m4-this-repository-moves-to-10)
- Evidence: —
- Notes: —

## T: Acceptance and independent review

### T1 The parallel-lanes acceptance test
- Status: done
- Depends on: W4, V3, H2, C1
- Plan: [T-acceptance.md](../plan/T-acceptance.md#t1-the-parallel-lanes-acceptance-test)
- Evidence: [acceptance.test.mjs](../../test/acceptance.test.mjs), 10 of 10 on `main` (43 s): `init` sets up a repository; three lanes created with `claim --worktree` work at the same time, each claiming, adding a child task, committing code, verifying, writing a decision and a log entry, finishing with evidence and passing `handoff`; the lanes merge in all six orders and once by squash with no conflict, after which `check` passes and `work` shows every task done and no stale claim; a fourth lane that edits another lane's task is refused by pre-commit and by `ci`. `node scripts/test.mjs` on `main` after T1 and T5.2: 696 of 696 on Node 24.18.0, 22.23.3 and 20.20.2. Not verified: CI on the three systems (the next push).
- Notes: The test found no bug. It found one case for T4: a lane built on top of another lane's claim commit can change that task, and `ci` accepts it, because the base never recorded the claim; pre-commit refuses it locally.

### T2 Performance and Windows
- Status: todo
- Depends on: W2, H3
- Plan: [T-acceptance.md](../plan/T-acceptance.md#t2-performance-and-windows)
- Evidence: —
- Notes: —

### T3 Independent review of the guard
- Status: blocked
- Depends on: V3, H2
- Plan: [T-acceptance.md](../plan/T-acceptance.md#t3-independent-review-of-the-guard)
- Evidence: [The review](../evidence/t3/review.md): 13 findings, one blocker, five major and seven minor, each reproduced with the real product.
- Notes: Waits for its child tasks: T3.1 to T3.4 fix or answer every finding.

### T3.1 A range check that cannot be fooled
- Status: doing
- Depends on: T3
- Plan: [The review](../evidence/t3/review.md#findings), findings 1, 2, 3 and 7
- Evidence: —
- Notes: A worker fixes it on branch `t3-1-range`. Read commit bodies length-prefixed (`git cat-file --batch`), never by splitting formatted output; a merge that adds code neither side changed needs a trailer; a revert must invert the commit it names, and a release subject alone exempts nothing; `--amend` is judged against HEAD's parent.

### T3.2 Hooks judged by the committed rules
- Status: doing
- Depends on: T3
- Plan: [The review](../evidence/t3/review.md#findings), findings 4, 6 and 9
- Evidence: —
- Notes: A worker fixes it on branch `t3-2-rules`. Ship a `pre-merge-commit` hook; take the protected branches, the branch pattern and the gates from the committed configuration, not the staged one; refuse deleting a task another lane holds.

### T3.3 handoff and verify at the edges
- Status: doing
- Depends on: T3
- Plan: [The review](../evidence/t3/review.md#findings), findings 5, 8, 10 and 11
- Evidence: —
- Notes: A worker fixes it on branch `t3-3-edges`. Start `handoff`'s range at the commit that added the configuration, as pre-push does; decide in spec section 5.10 whether code-like files in the workspace count as code; prune only stamp files; refuse `verify` when code is hidden with `skip-worktree` or `assume-unchanged`.

### T3.4 Setup that works everywhere
- Status: todo
- Depends on: T3
- Plan: [The review](../evidence/t3/review.md#findings), findings 12 and 13
- Evidence: —
- Notes: Restrict `dir` and `codePaths` to safe path segments; add `.githooks/* text eol=lf` to `.gitattributes` in `init` and `migrate`; and in the team preset let `init` set up on a branch, because the protected base refuses the setup commit (seen during the review).

### T4 Independent review of the CI check
- Status: todo
- Depends on: C2, C3
- Plan: [T-acceptance.md](../plan/T-acceptance.md#t4-independent-review-of-the-ci-check)
- Evidence: —
- Notes: For the reviewer: T1 found that a lane stacked on another lane's claim commit can change that task and pass `ci`, because the base never recorded the claim; decide whether `ci` should compare such a task with the holding lane's branch.

### T5 Independent review of `migrate`
- Status: done
- Depends on: M3
- Plan: [T-acceptance.md](../plan/T-acceptance.md#t5-independent-review-of-migrate)
- Evidence: [The review](../evidence/t5/review.md): 14 findings, all fixed in T5.1, T5.2 and T5.3, each with its own tests.
- Notes: —

### T5.1 Data safety in migrate
- Status: done
- Depends on: T5
- Plan: [The review](../evidence/t5/review.md#findings), findings 1, 2, 4, 5, 6 and 14
- Evidence: `node scripts/test.mjs` on `main` after the merges: 581 of 581 on Node 24.18.0, 22.23.3 and 20.20.2 before A1, and the full suite again after it. A new suite in [migrate.test.mjs](../../test/migrate.test.mjs), "data safety at the edges of git", refuses a `.gitignore` rule and a global excludes rule, prints and proves the undo after a failure halfway, refuses bytes that are not UTF-8, a symlinked workspace and a symlinked hook, and keeps two ids that differ only in case apart; [tasks.test.mjs](../../test/tasks.test.mjs) covers names Windows reserves.
- Notes: An untracked, ignored stamp file is left in place with a warning, because the undo could not bring it back; a file that is not UTF-8 blocks the run only when `migrate` would write or delete it.

### T5.2 A faithful conversion
- Status: done
- Depends on: T5.1
- Plan: [The review](../evidence/t5/review.md#findings), findings 7 to 13
- Evidence: `node scripts/test.mjs` on `main` after the merge: 696 of 696 on Node 24.18.0, 22.23.3 and 20.20.2. A suite "a faithful conversion" in [migrate.test.mjs](../../test/migrate.test.mjs) covers a duplicated Evidence field, blank lines kept in fences, a `standards.md#commits` link listed as less precise, an HTML link listed, an indented-code link left alone, a CRLF and BOM workspace, a guard without its version line, the Lane line, and the `--accept-problems` advice with the commit refused.
- Notes: For a duplicated field the last one counts, as in 0.x; the earlier one and its lines move to Notes, word for word. The project's own text is no longer tidied; only the joins `migrate` makes are.

### T5.3 The agent hook command that migrate writes
- Status: done
- Depends on: A1
- Plan: [The review](../evidence/t5/review.md#findings), finding 3
- Evidence: [agents.test.mjs](../../test/agents.test.mjs) runs every command line that `migrate` writes into `.claude/settings.json` against the bundled guard with recorded input: each exits 0 or 2, never "unknown command".
- Notes: A1 built the `hook` command and its test.

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
