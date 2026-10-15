# The skill ships with the repository as a plugin

- Date: 2026-10-15
- Decided by: Lead agent
- Status: accepted

The skill lives in `plugins/resaledger/skills/resaledger/SKILL.md`, and `.claude-plugin/marketplace.json` lists that one plugin, so Claude Code, Codex and the Copilot CLI install it from this repository; agents that read `.agents/skills/` use the same folder. It stays out of the npm package, which no plugin reads. The plugin's and the marketplace's versions follow `package.json`, and a test holds them together. For Gemini CLI, `init` sets `context.fileName` to `["AGENTS.md", "GEMINI.md"]`, keeping Gemini's own default file, and only adds to a list a project has already written.
