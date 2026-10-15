# Guard modules and their contracts

Status: approved · 2026-10-15 · by Niko Alho, as part of the plan; the lead keeps it current

The guard is written as modules in `src/guard/` and bundled into one file ([F1](F-foundation.md#f1-package-source-layout-bundler-and-test-harness)). This page fixes which module owns what and the functions other modules call, so that parallel tasks fit together. A task may add functions to its own module. A change to a contract below goes through the lead.

## Conventions

- **Problems.** Validators never print or exit. They return problems, as `{ file, line, message }` (line is 1-based, or 0 when it does not apply). `message` says what is wrong and what to write instead. Only `main.mjs` and the command functions print and choose exit codes.
- **No file access in validators.** A parser takes text. A validator takes parsed records and a context with an `exists(path)` function. The reader (below) does the reading, so the same validator runs on the working tree, the index or any commit.
- **Paths** inside the guard are POSIX paths relative to the repository root, on every platform.
- **Names** are unique across all modules, because the bundle is one scope. Prefer specific names (`parseTask`, not `parse`).
- **The bundler's rules** are in the header of `scripts/bundle.mjs`, and it refuses anything else:
  - named imports only, from `node:` or from a sibling module;
  - `export function`, `export async function`, `export const` and `export class` only;
  - top-level declarations in column 0;
  - top-level names unique across all modules, including the names imported from `node:`;
  - `main.mjs` last.
- **Field names** are exact in every record type. A near miss, including a difference in case (`Decided By`, `status`), is reported with the canonical spelling.
- **`VERSION`** is defined by the bundler. Use it only inside functions, so that a unit test can import a module on its own.
- **Output** is plain text. A refusal starts with `✖`, a passing check with `✔`, as in 0.x. No colour codes when stdout is not a terminal.

## Modules

| Module | Task | Owns |
| --- | --- | --- |
| `util.mjs` | F1, R1 | `git(...args)`, `fail(message)`, POSIX path helpers, shared constants; `repositoryRoot()`; `editDistance(a, b)` and `likelyTypo(name, known)` (R1) |
| `config.mjs` | R1 | `CONFIG_FILE = '.resaledger.json'`, `CONFIG_VERSION = 2`; `parseConfig(text) → { config, problems }` (`config` is null when there is any problem; defaults from the preset filled in); `loadConfig(read)` (a `read(path)` function or a reader); `effectiveConfigJson(config)` (a JSON string); `isSafeFolderPath(value)` and `SAFE_FOLDER_RULE`, the rule for `dir` and `codePaths`, whose values are pasted into hook scripts, YAML and commands; `DEFAULTS`, `PRESETS` |
| `markdown.mjs` | R2 | `splitLines(text)` (CRLF-safe); `headings(text) → [{ level, text, anchor, line }]`; `findSection(text, anchor) → { heading, lines, line } \| null`; `relativeLinks(text) → [{ target, path, anchor, line }]`; `resolveLinkPath(fromFile, path)`; `parseFields(lines, start) → { fields, end }` where each field is `{ name, value, items, line }`; `isEmptyValue(value)` |
| `tasks.mjs` | R3 | `TASK_ID`; `parseTask(path, text) → task`; `validateTask(task, context) → problems`; `validateTaskSet(tasks, context) → problems` (unique ids, dependencies, WIP per lane); `taskFileName(dir, id, title)`; `slugify(title)`; `TASK_FIELDS` |
| `records.mjs` | R4 | `SETUP_MARKER`; `parseDecision`, `validateDecision`, `parseLogEntry`, `validateLogEntry`, `planStatus(text) → { value, date, by, line } \| null`, `validatePlanStatus(path, status)`, `parseReadme(path, text)` (its `sections` is a Map), `validateReadme` (the shape), `readmeMarkerProblems` (the setup markers, for `handoff`) |
| `workspace.mjs` | R5 | `treeReader(source)` with `source` `{ kind: 'worktree' }`, `{ kind: 'index' }` or `{ kind: 'commit', rev }` and an optional `root`, returning `{ list(prefix), read(path), exists(path) }`; `loadWorkspace(reader, config) → workspace` (parse problems in `workspace.problems`); `checkWorkspace(workspace, reader, config) → problems`; `isCode(path, config)`; `fingerprint(source, config)` (index or commit sources only); `checkCommand(args, rangeCheck)`, which reads the configuration from the source it checks; `main.mjs` passes `checkRange` in, because `range.mjs` imports `isCode` from this module |
| `gates.mjs` | V1 | `runGates(commands, options) → { passed, failure }` (never exits); `stampPath(config, fingerprint)` → `<dir>/verified/<first 16 hex>.json`; `gatesDigest(fingerprint, gates)`; `verifiedStamp(reader, config, fingerprint) → stamp \| null`; `verifyCommand(args)`; `gatesCommand()` |
| `range.mjs` | V2, H2 | `taskTrailers(message) → { ids, maintenance }`; `checkRange(from, to, context) → problems`, with `context = { config, lane, skipGitHubMerges, root }` (`lane` null skips the lane rule); `checkCommit(commit, context) → problems`, the rules for one commit that `checkRange` and commit-msg share, with `context = { config, lane, skipGitHubMerges, task(id), startLane(id) }`; `commitExemption(commit, context) → 'merge' \| 'revert' \| 'release' \| 'github' \| null`; `taskFileFor(names, id)`; `readCommits(root, revListArgs)`; `rangeObjects(root, specs) → Map<spec, { type, data }>`, one `git cat-file --batch` for object names such as `<rev>:<path>` |
| `handoff.mjs` | V3 | `handoffProblems(context) → problems`, with `context = { root, config, lane }`; `handoffCommand(args)` |
| `adoption.mjs` | T3.3 | `adoptionCommit(root, to)`, the commit that added `.resaledger.json`; `adoptionStart(root, from, to)`, which moves a range start older than it up to it, for `handoff` and pre-push |
| `githooks.mjs` | H1, H2, H3 | `HOOKS_PATH = '.githooks'`; `preCommit(hook)`, which serves pre-commit and pre-merge-commit, `commitMsg(file)`, `prePush(input, args)` with `args` the remote's name and URL and its range start taken through `adoptionStart`; every hook takes the rules from a committed configuration (spec 12); `hooksActive()` (also true when a hook manager calls the guard), `activateHooks() → 'activated' \| 'active' \| { foreign }`; `AI_ATTRIBUTION = { names, qualified, domains }`, what `aiAttribution: "forbid"` refuses in trailers: plain names, the names people also have only in the `forms` no person has, and the vendors' e-mail domains |
| `lanes.mjs` | W1, W2 | `currentLane()`; `localBranches() → Map<branch, { author, date }>`; `laneTasks(reader, dir)`; `localLanes(config, branches)`, which reads the other worktrees without git's hook variables; `remoteLanes({ root, config, local }) → { base, remote, lanes, baseTasks, pushed, live, branches }` and `defaultRemote(root, base)` (W2). A lane is `{ branch, path?, source: 'this' \| 'worktree' \| 'remote', tasks, lastCommit? }` |
| `work.mjs` | W1 | `workCommand(args)`; `compareTaskIds(a, b)`, the natural id order |
| `create.mjs` | W3 | `taskCommand(id)`; `newCommand(args)`; `nextTaskId(prefix, known)`; `nextChildId(parent, known)` |
| `claim.mjs` | W4 | `claimCommand(args)`: the lane, the checks against every visible lane, the takeover, the claim and its push |
| `changes.mjs` | W5 | `changesCommand(args)`; `changesData(root, since) → { since, from, to, grouped, tasks, dropped }`; `changesMarkdown(data)`. Reads git only, through `treeReader`, one `git log` on the task files and `rangeObjects` |
| `ownership.mjs` | C1 | `taskRecordsById(reader, dir) → Map<id, { task, text }>`; `ownershipProblems({ before, after, lane, config, kept?, holders?, accepted?, baseName? }) → problems`, the rules of spec 6.2 that pre-commit and `ci` share |
| `ids.mjs` | C1, W3 | `branchFolderNames({ root, folder, exclude? }) → [{ ref, branch, commit, names }]`, the file names in one folder on every local and remote-tracking branch, from one batch; `branchTaskFiles({ root, dir, exclude? }) → [{ ref, branch, commit, files }]`, the task ids built on it; `idCollisions(added, others, config) → problems` |
| `ci.mjs` | C1–C3 | `ciOptions(args, env)`; `ciResult(options)`, the check as data (`checks`, `moved`, `gates`, `rules`, and `enforcement`: the changes from `enforcementCheck` for a pull request, null for a push); `ciCommand(args)`, the text and the exit code |
| `enforcement.mjs` | C2 | `enforcementCheck(root, { from, mergeBase, head, adds, released }) → { check, changes }`: the changes to the configuration, the guard, the git hooks and the workflow from `from` to the head, as `[{ id, kind: 'listed' \| 'weakening', file, what, decidedBy: { file, by } \| null }]`, and the `enforcement` check, which fails on a weakening change that no decision the pull request adds names on its `- Weakens:` line |
| `managed.mjs` | I3, C2 | `compareVersions(a, b)`, `normalizeManaged(text, dir)`, `contentHash(text)`, which `cli/update.mjs` re-exports; `releasedTable()`, the released hashes the bundle embeds as `RELEASED` (earlier releases, and this version's hooks) plus the running guard's own hash. `RELEASED`, like `VERSION`, is defined by the bundler and used only inside functions |
| `agents.mjs` | A1, A2 | `hookCommand(agent, event, text)` and the input adapters (a table, one entry per agent); `AGENT_NAMES`, `AGENT_EVENTS`; `shellCommands(text)`, the shell parser; `patchPaths(patch)`; `agentConfigFile(agent)`, `agentHookEntries(agent, dir)`, `agentConfigSnippet(agent, dir)`, `mergeAgentConfig(agent, text, dir)` (grouped handlers for Claude Code, Codex and Gemini CLI, flat ones with `version: 1` for Cursor and Copilot), `isLedgerHookCommand(command)`, `agentConfigured(root, agent)`, `detectAgents(root)`. Session state is in the common git folder, `resaledger/sessions/<id>.start` holding the session's worktree. The command line in every agent's configuration is `node <dir>/scripts/records.mjs hook <agent> <event>`, with `<agent>` one of `claude`, `codex`, `cursor`, `gemini`, `copilot` and `<event>` one of `session-start`, `pre-tool`, `stop` |
| `cli/hooks.mjs` (package side) | H3 | `HOOK_NAMES`; `renderHook(name, dir)`, which single-quotes `dir` in the script and, like `guardCall` and `integrateHookManager`, throws on a `dir` that is not `isSafeFolderPath`; `detectHookManager(root)`; `integrateHookManager(root, manager, dir) → { changed, instructions }`; `guardCall(name, dir)`, `callMarker(name)` (I3) |
| `cli/legacy.mjs` (package side) | M1, T5.1 | Pure readers of 0.x workspaces; `readLegacyWorkspace(root)`, the `parseLegacy…` parsers and `lostLegacyLines(text, lines)`; `invalidUtf8Line(buffer)`, `readSourceText(path)`, `INVALID_UTF8` |
| `cli/setup.mjs` (package side) | I1 | What `init` and `migrate` share: `PACKAGE_ROOT`, `BUILT_GUARD`, `HOOKS_FOLDER`; `ensureGuard()`; `agentsBlock(dir)`, `removeManagedBlock(text)`, `withAgentsBlock(text, block)`; `realRelative(root, path)`, `sameFile(root, a, b)`; `claudeFile(root, agentsPath)`, `hasAgentsImport(lines)`; `detectBase(root)`; `turnOnHooks(root) → { state, manager, hooksPath }`, `hooksNote(result, dir)`; `MANAGED_START`, `MANAGED_END`; `GITATTRIBUTES_FILE`, `HOOKS_EOL_RULE` (`.githooks/* text eol=lf`), `hasHooksEolRule(text)`, `withHooksEolRule(text)`; `currentBranch(root)`; `SETUP_BRANCH`, `setupCommitSteps(branch, config, commit, what)`, the printed steps that commit the setup, on a new branch when the current one is protected |
| `cli/init.mjs` (package side) | I1 | `planInit(root, options)`, which only reads (its plan carries the planned `config`), and `applyInit(root, plan)`; `parseInitArgs(args)`, `presetFromAnswer(text)`, `initOptions(flags, answers)`; `projectName(root)` with `tomlTableName` and `goModuleName`; `renderReadme(name, goal)`; `commitCommand(files, message)`, which stages the hooks as executable; `parseAgentsValue(value)`, `planAgentConfigs(root, agents, dir, writes)`; `GOAL_MARKER`, `INIT_COMMIT_MESSAGE` |
| `cli/update.mjs` (package side) | I3, A2 | `planUpdate(root, { force, released, agents })`, which only reads and renews only the agent configurations that hold ResaLedger's hook command, adding those that `agents` names (`update --agents`), and `applyUpdate(root, plan)`; `judgeManaged(key, installed, wanted, dir, table)`; `normalizeManaged(text, dir)` and `contentHash(text)` (from `managed.mjs`), `currentHashes()`, `releasedHashes()`, `withVersionHashes(table, version, hashes)`; `guardVersion(text)`, `compareVersions(a, b)` (from `managed.mjs`); `findManagedBlock(text)`, `compactDiff(diff, context)`; `PACKAGE_VERSION`, `RELEASED_FILE`, `UPDATE_COMMIT_MESSAGE`. `templates/released.json` holds `{ key: { version: sha256 } }` for `guard`, `hooks/<name>` and `agents-block` |
| `cli/migrate.mjs` (package side) | M2 | `planMigration(root, options)`, which only reads, and `applyMigration(root, plan)`; `convertConfig(legacy)`, `lineDiff(before, after)`, `localDate(date)`; `COMMIT_COMMAND`, `UNDO_COMMAND` |
| `templates/readme.md` | I1 | The workspace README that `init` writes, with its setup markers |
| `templates/agents-block.md` | M2, then A3 | The managed block in the root `AGENTS.md`, with `{{dir}}` filled in; `init`, `update` and `migrate` write it |
| `main.mjs` | F1, then every command task | Parses arguments and calls the commands. It is the bundle's last module. |

## The workspace object

`loadWorkspace` returns:

```js
{
  dir,            // the workspace folder, e.g. 'ledger'
  tasks,          // parsed tasks, each with .file and its parse problems
  decisions,      // parsed decisions
  logs,           // parsed log entries
  plans,          // Map of plan file path → planStatus() object or null
  readme,         // parsed README, or null when missing
  problems        // parse problems found while loading
}
```

`checkWorkspace` adds every validation problem. The context it passes to validators is:

```js
{
  exists(path),       // true when the repository-relative path exists in the source being checked
  read(path),         // the text of a file in that source, or null
  planStatus(path),   // { value, date, by, line } from the plan file's status line, or null
  taskIds,            // Set of every task id in the workspace
  config              // the effective configuration
}
```

Shape checks and session checks are separate. `validateTask` checks the shape of one task file: what any commit may contain. Whether a `doing` task has a current Handoff is a question for the end of a session, so `handoffProblems` (V3) asks it, not `validateTask`; otherwise a claim could never be committed before its first handoff note. The README's setup markers are the same kind of question: `validateReadme` checks its sections, and only `handoff` reports the markers (`readmeMarkerProblems`), so the files `init` writes can be committed at once.
