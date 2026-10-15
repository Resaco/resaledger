# ResaLedger documentation

Start with [Concepts](guides/concepts.md), then follow the guide that fits how you work.

## Guides

- [Concepts](guides/concepts.md): records, lanes, claims, gates and stamps, and the layers of enforcement and what each stops.
- [Working alone](guides/solo.md): one person, with or without agents, up to three agents in three worktrees.
- [Working as a team](guides/team.md): the team preset, the required status check, CODEOWNERS for the enforcement files, squash merges, decisions that loosen a rule, and guard updates.
- [CI](guides/ci.md): GitHub Actions with the shipped workflow, and any other CI system.
- [Setting up agents](guides/agents.md): Claude Code, Codex, Cursor, Gemini CLI and GitHub Copilot, what the hooks refuse, and the skill.
- [Moving from agent-ledger 0.x](guides/migration.md): `migrate`, what changes and what is kept, and how to undo it.
- [Work outside the code](guides/outside-the-code.md): content in a CMS, server settings and other work the hooks cannot see, with evidence someone else can check.

## Reference

- [The format reference](format.md): every file, field and configuration key.
- `npx resaledger help` and `node ledger/scripts/records.mjs help` list every command and flag.

Every command in the guides runs in a test, `test/guides.test.mjs`, against the code in this repository. The few that need GitHub or the network are marked in the guide's source, and the test lists them.
