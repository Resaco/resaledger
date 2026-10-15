# Setting up agents

Every agent works with ResaLedger through three layers. This guide shows what `init` writes for Claude Code, Codex, Cursor, Gemini CLI and GitHub Copilot, what each agent asks you to trust, what the hooks refuse, and how to install the skill.

1. **`AGENTS.md`**, for every agent: a block that teaches the protocol.
2. **Git hooks and CI**, for every agent and every person. They are the enforcement, so an agent without hooks is still covered.
3. **Agent hooks**, for the five agents that have them: they stop a command before it runs, and remind the agent to hand off before it stops.

## What `init` writes

`init` writes hook configurations for the agents it finds in the repository, by their folder or instruction file:

| Agent | Found by | Configuration it writes |
| --- | --- | --- |
| Claude Code | `.claude/` or `CLAUDE.md` | `.claude/settings.json` |
| Codex | `.codex/` | `.codex/hooks.json` |
| Cursor | `.cursor/` or `.cursorrules` | `.cursor/hooks.json` |
| Gemini CLI | `.gemini/` or `GEMINI.md` | `.gemini/settings.json` |
| GitHub Copilot, cloud agent and CLI | `.github/copilot-instructions.md`, `.github/instructions/`, `.github/copilot/` or `.github/hooks/` | `.github/hooks/resaledger.json` |

`--agents` names them instead, as a comma-separated list, or `none`. This repository has a `CLAUDE.md`, and the team uses all five agents:

```bash
npx resaledger init --agents claude,codex,cursor,gemini,copilot
```

```text
Created (14):
.claude/settings.json
.codex/hooks.json
.cursor/hooks.json
.gemini/settings.json
.github/hooks/resaledger.json
Changed (1):
CLAUDE.md
Agent hooks for: claude, codex, cursor, gemini, copilot.
Claude Code asks you to trust the project's hooks; its /hooks command shows them.
Codex asks you to trust each hook entry, and asks again when an entry's command changes.
Cursor's cloud agents run the committed hooks without asking.
Gemini CLI asks you to trust the project's hooks.
The Copilot CLI asks you to trust the project's hooks; the Copilot cloud agent runs them without asking.
```

Each file is merged into what is there: the project's own settings and hooks stay. Two more changes help the agents find `AGENTS.md`:

- Claude Code reads `AGENTS.md` only when there is no `CLAUDE.md`, so `init` adds an `@AGENTS.md` import to an existing `CLAUDE.md`.
- Gemini CLI reads `GEMINI.md` by default, so `.gemini/settings.json` sets `context.fileName` to `["AGENTS.md", "GEMINI.md"]`.

```bash
cat CLAUDE.md
```

```text
# Bakery shop
Run npm test before you push.
@AGENTS.md
```

Commit the setup as `init` printed it. To add an agent later, `update --agents` writes its configuration; `update` on its own renews only the configurations that already hold ResaLedger's hook command, so one you deleted stays deleted:

```bash
git add -A
git add --chmod=+x .githooks/commit-msg .githooks/pre-commit .githooks/pre-merge-commit .githooks/pre-push
git commit -m "chore: set up ResaLedger" -m "Task: maintenance"
```

## What each agent runs, and what it asks you to trust

All five call the same command, `node ledger/scripts/records.mjs hook <agent> <event>`, at three points:

| Agent | Session start | Before a tool | End of turn |
| --- | --- | --- | --- |
| Claude Code | `SessionStart` | `PreToolUse` on Bash, Edit, Write, MultiEdit and NotebookEdit | `Stop` |
| Codex | `SessionStart` | `PreToolUse` on Bash and apply_patch | `Stop` |
| Cursor | `sessionStart` | `beforeShellExecution` and `preToolUse`, with `failClosed` | `stop`, with `loop_limit: 1` |
| Gemini CLI | `SessionStart` | `BeforeTool` on run_shell_command, write_file and replace | `AfterAgent` |
| GitHub Copilot | `sessionStart` | `preToolUse` | `agentStop` |

A project's hooks are commands that run on your machine, so most agents ask you to trust them first:

- **Claude Code** asks you to trust the project's hooks. Its `/hooks` command shows them.
- **Codex** asks you to trust each hook entry, and asks again when an entry's command changes. ResaLedger's command lines never change between versions, so an update does not ask again; new behaviour arrives in the guard.
- **Gemini CLI** asks you to trust the project's hooks.
- **The Copilot CLI** asks you to trust the project's hooks. **The Copilot cloud agent** runs the committed hooks without asking.
- **Cursor's cloud agents** run the committed hooks without asking. Whether the Cursor editor asks is not confirmed.

Read the configuration before you trust it. Every entry calls the guard in `ledger/scripts/records.mjs`, which is in the repository and has no dependencies.

The GitHub Copilot cloud agent does not run git through a shell itself, and whether its commits run the git hooks is not confirmed. CI is its gate: see [CI](ci.md).

## What the hooks do

**At session start**, the hook turns the git hooks on in the clone and gives the agent the output of `work`: what is in progress, its handoff note, what is ready. Here is Claude Code's input, as the agent would send it:

```bash
echo '{"hook_event_name": "SessionStart", "source": "startup"}' | node ledger/scripts/records.mjs hook claude session-start
```

```text
ResaLedger · lane main · solo · hooks on · not verified
In progress in this lane
none
```

**Before a tool runs**, the hook refuses, with exit code 2 and the reason on stderr:

- `--no-verify`, which skips the git hooks;
- a change to `core.hooksPath`;
- a forced push;
- a push to a protected branch, and file edits on a protected branch;
- commands that throw work away (`git reset --hard`, `git clean -f`, `git checkout` of paths, `git restore`, `git switch -f`) in a protected branch's checkout, or in a worktree other than the one the session started in;
- the project's own `agent.deny` commands;
- with `agent.pushNeedsHandoff`, a `git push` while `handoff` fails ([below](#push-only-what-is-handed-over)).

<!-- exits 2 -->

```bash
echo '{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git commit --no-verify -m wip"}}' | node ledger/scripts/records.mjs hook claude pre-tool
```

```text
✖ ResaLedger: "git commit" with --no-verify skips the git hooks. Never bypass them: fix what the hook reports, or tell the user what blocks you
```

<!-- exits 2 -->

```bash
echo '{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git push --force"}}' | node ledger/scripts/records.mjs hook claude pre-tool
```

```text
✖ ResaLedger: a forced push rewrites history that others may have. Push normally; if the push is rejected, fetch, merge or rebase your own unpushed commits, and push again
```

Cursor, Gemini CLI and Copilot read JSON on stdout, so for them a refusal also prints the agent's own deny JSON:

<!-- exits 2 -->

```bash
echo '{"hook_event_name": "BeforeTool", "tool_name": "run_shell_command", "tool_input": {"command": "git config core.hooksPath /dev/null"}}' | node ledger/scripts/records.mjs hook gemini pre-tool
```

```text
{"decision":"deny","reason":"ResaLedger: changing core.hooksPath turns the ResaLedger git hooks off. They stay on; fix what they report instead"}
```

Ordinary commands pass, and so does input the hook does not recognise. The git hooks and CI still hold.

```bash
echo '{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "npm test"}}' | node ledger/scripts/records.mjs hook claude pre-tool
```

### The project's own rules

`agent.deny` in `.resaledger.json` adds commands for the hooks to refuse. Each rule is a regular expression and the reason the agent sees:

```bash
node -e '
  const fs = require("fs")
  const config = JSON.parse(fs.readFileSync(".resaledger.json", "utf8"))
  config.agent = { deny: [{ pattern: "npm\\s+publish", reason: "Only the owner publishes the shop." }] }
  fs.writeFileSync(".resaledger.json", JSON.stringify(config, null, 2) + "\n")
'
git commit -am "chore: only the owner publishes" -m "Task: maintenance"
```

<!-- exits 2 -->

```bash
echo '{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "npm publish"}}' | node ledger/scripts/records.mjs hook claude pre-tool
```

```text
✖ ResaLedger: this command matches the project's agent.deny rule "npm\s+publish": Only the owner publishes the shop.
```

The rules come from the committed configuration, so an agent cannot lift one by editing the file without committing it.

### Push only what is handed over

With `"agent": { "pushNeedsHandoff": true }` in `.resaledger.json`, the hook also refuses an agent's `git push` while `handoff` fails in the worktree the push runs in, such as after `cd` or with `git -C`. It leaves out handoff's check that the lane is pushed, which the push itself does, and runs no gates. The refusal is handoff's own message, so the agent sees what to finish first: commit the tree, write the handoff note, commit the stamp. The other push rules come first. Turning the key off again is a weakening change in CI.

Only an agent's push is checked, because only the agent hook knows its caller is an agent; your own pushes, and an agent without hooks, go through the git hooks and CI as before.

**At the end of a turn**, the hook runs `handoff` when the session changed the repository. If it fails, the agent is reminded once per session to finish the work or tell you exactly what is left.

## Install the skill

The ResaLedger repository ships one skill. It helps an agent set up a workspace from a real repository (the README from what is true, the gates from the commands that exist, work already done recorded with its evidence) and keep records the next agent can use. The repository is a plugin marketplace that Claude Code, Codex and the Copilot CLI install from:

<!-- not run: needs GitHub -->

```bash
claude plugin marketplace add Resaco/resaledger && claude plugin install resaledger@resaledger
codex plugin marketplace add Resaco/resaledger && codex plugin add resaledger@resaledger
copilot plugin marketplace add Resaco/resaledger && copilot plugin install resaledger@resaledger
```

An agent without plugins reads the skill from `.agents/skills/` in the project. Copy the folder `plugins/resaledger/skills/resaledger/` of the ResaLedger repository there:

<!-- not run: needs GitHub -->

```bash
git clone --depth 1 https://github.com/Resaco/resaledger ../resaledger
mkdir -p .agents/skills
cp -R ../resaledger/plugins/resaledger/skills/resaledger .agents/skills/
```

## What can go wrong

- **The agent does not commit.** Some agents' default instructions say not to commit unless asked. The `AGENTS.md` block tells them to commit each working step; if an agent still waits, tell it to follow `AGENTS.md`.
- **The hooks do not run.** The agent has not been asked to trust them yet, or you declined. Open the agent's hook settings and trust them, or rely on the git hooks and CI, which hold either way.
- **A hook times out.** The Copilot hook lets a tool run when the hook times out, and a Cursor hook lets it run when it crashes unless `failClosed` is set. The hooks are fast; the git hooks and CI catch what slips through.
- **An agent tries to get around a refusal.** A determined workaround is possible on any machine. The git hooks, `handoff` and CI with the base's rules still judge the result ([concepts](concepts.md#the-layers-and-what-each-stops)).
