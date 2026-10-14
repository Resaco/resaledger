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
- Status: blocked
- Depends on: S3
- Plan: [spec.md](../plan/spec.md#21-decisions-for-the-owner)
- Evidence: —
- Notes: Decided on 15 October: the licence, the commit identity, and a separate review of the plan (see DECISIONS.md). Still waiting for the owner: approval of the specification, the name, and the cut of guard-only mode. Phase 2 starts after this.
