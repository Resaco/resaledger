# Session log

What each session did, oldest first. One dated entry per session. Current state is in [STATUS.md](../STATUS.md), not here.

## 2026-10-14 · workspace set up

The workspace folder, the guard and the git hooks were added with agent-ledger. No build work yet.

## 2026-10-15 · Research and the 1.0 specification

Studied thirteen neighbouring projects through their repositories and issues, measured how the 0.x format held up in private use, and wrote [the specification](../plan/spec.md). What changed the design: the enforcement hypothesis holds only as a combination, because done-gates inside an agent session have become common; id collisions across branches are the most frequent multi-person bug in comparable tools, which led to child ids and a duplicate check in CI; a merge driver and an event log merged wrongly without a warning in another tool, which ruled both out; and in use, the hand-written status drifted while the task trailers and evidence stayed clean, which is why live state is now computed and the trailer and evidence rules stay. The specification waits for the owner, and nothing is committed until the commit identity is decided.

## 2026-10-15 · The owner's first decisions, and the brand work starts

The owner decided the licence (MIT, copyright Resaco Oy), the commit identity (the GitHub no-reply address, no AI co-author lines), a separate review of the plan, that nothing derived from private projects enters this repository, and the name: ResaLedger. The specification now uses the new name, and the predecessor keeps its own name, agent-ledger 0.x, where the text is about it. The brand concepts (G1) started, in a dark graffiti style with a refined grain that follows the Resa product family.

## 2026-10-15 · The plan

The owner cut guard-only mode, put a `changes` command into 1.0, accepted that the predecessor's name shows in the history, and approved the specification. The specification became [a plan](../plan/README.md) of 43 tasks in 12 phases, each with a plan section and acceptance checks, and the ledger lists them with their dependencies. The guard will be developed as modules bundled into one file, so that up to three workers can build it in parallel; workers change code and tests only, and the records stay with the lead until this repository moves to the 1.0 format (M4).

## 2026-10-15 · The foundation

The build started. The owner approved the plan, chose the ruled-lanes direction for the mark and asked for animated explanations of how it works (G3). F1 landed: the package with no dependencies, the bundler that turns the guard's modules into one file, the cross-platform test runner and the git helpers; 18 tests pass on Node 20, 22 and 24. The repository's gates now run the bundle check on every code commit and the tests in `verify`.

## 2026-10-15 · The configuration and the Markdown layer

R1 and R2 were built in parallel by two workers in their own worktrees and merged without a conflict: the configuration (`.resaledger.json` with presets, defaults and typo suggestions, and the `config` command) and the Markdown primitives (lines, GitHub's anchors, sections, links and bullet fields). 64 tests pass on Node 20, 22 and 24. The module page now fixes the context that validators receive, and keeps the Handoff check for the end of a session, so that a claim can be committed before its first handoff note.

## 2026-10-15 · The other records, and the brand chosen

R4 merged: decisions, log entries, plan status lines and the workspace README now parse and validate; 95 tests pass on Node 20, 22 and 24. The owner chose the C1 mark, three parallel ruled lanes, and ruled out any spray texture; the grain stays. The designer is finishing the identity (G2) in the private brand files.
