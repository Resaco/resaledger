# Session log

What each session did, oldest first. One dated entry per session. Current state is in [STATUS.md](../STATUS.md), not here.

## 2026-10-14 · workspace set up

The workspace folder, the guard and the git hooks were added with agent-ledger. No build work yet.

## 2026-10-15 · Research and the 1.0 specification

Studied thirteen neighbouring projects through their repositories and issues, measured how the 0.x format held up in private use, and wrote [the specification](../plan/spec.md). What changed the design: the enforcement hypothesis holds only as a combination, because done-gates inside an agent session have become common; id collisions across branches are the most frequent multi-person bug in comparable tools, which led to child ids and a duplicate check in CI; a merge driver and an event log merged wrongly without a warning in another tool, which ruled both out; and in use, the hand-written status drifted while the task trailers and evidence stayed clean, which is why live state is now computed and the trailer and evidence rules stay. The specification waits for the owner, and nothing is committed until the commit identity is decided.

## 2026-10-15 · The owner's first decisions, and the brand work starts

The owner decided the licence (MIT, copyright Resaco Oy), the commit identity (the GitHub no-reply address, no AI co-author lines), a separate review of the plan, that nothing derived from private projects enters this repository, and the name: ResaLedger. The specification now uses the new name, and the predecessor keeps its own name, agent-ledger 0.x, where the text is about it. The brand concepts (G1) started, in a dark graffiti style with a refined grain that follows the Resa product family.
