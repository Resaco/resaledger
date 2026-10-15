# A3 The `AGENTS.md` block, the skill and the plugin

- Status: done
- Lane: a3-skill
- Depends on: I1
- Plan: [A-agents.md](../plan/A-agents.md#a3-the-agentsmd-block-the-skill-and-the-plugin)
- Evidence:
  - `node scripts/test.mjs` on Node 24.18.0, 22.23.3 and 20.20.2: 895 of 895 on each
  - The block, created, added and updated with the foreign text kept: [init.test.mjs](../../test/init.test.mjs), "the block is created, added and updated in place" and "the block holds the protocol of spec 11"; the existing init and update tests cover the same through the command line
  - The `@AGENTS.md` import in an existing `CLAUDE.md`: [init.test.mjs](../../test/init.test.mjs), "an existing CLAUDE.md imports AGENTS.md once"
  - Gemini CLI's `context.fileName`, set and merged: [agents.test.mjs](../../test/agents.test.mjs), "gemini: context.fileName gets AGENTS.md" and "update adds AGENTS.md to the context"
  - The skill's format check and the marketplace's shape: [plugin.test.mjs](../../test/plugin.test.mjs)

## Notes

As built:

- **The block** was already true to spec 11, so the template is unchanged. A new test checks that it holds each step of the protocol in order.
- **Gemini CLI.** `mergeAgentConfig` adds `AGENTS.md` to `context.fileName`. A new file gets `["AGENTS.md", "GEMINI.md"]`, because naming a list replaces Gemini's default `GEMINI.md`. A list keeps its names and gets `AGENTS.md` at the end; a single name becomes a list of it and `AGENTS.md`. A `context` that is not an object, or a `fileName` that is neither a name nor a list of names, is reported like the other unreadable values and the file is left alone. `update` renews it with the hooks.
- **Layout.** `.claude-plugin/marketplace.json` lists one plugin, `resaledger`, at `./plugins/resaledger`, with its manifest in `plugins/resaledger/.claude-plugin/plugin.json` and the skill in `plugins/resaledger/skills/resaledger/SKILL.md`. Agents that read `.agents/skills/` take that folder as `.agents/skills/resaledger/`; the repository keeps no copy.
- **Versions.** The marketplace's `metadata.version` and the manifest's `version` equal package.json's; the test fails when a version bump misses them. The marketplace entry has no version of its own, so the manifest decides.
- **Not in the npm package.** Marketplaces install from the git repository, and no package code reads these files, so `files` is unchanged.
- **Format check.** The skill's `name` matches its folder and is at most 64 lowercase letters, digits and hyphens; its `description` is at most 1,024 characters; it passes the hygiene rules.
