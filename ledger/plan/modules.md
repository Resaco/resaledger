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
| `config.mjs` | R1 | `CONFIG_FILE = '.resaledger.json'`, `CONFIG_VERSION = 2`; `parseConfig(text) → { config, problems }` (`config` is null when there is any problem; defaults from the preset filled in); `loadConfig(read)` (a `read(path)` function or a reader); `effectiveConfigJson(config)` (a JSON string); `DEFAULTS`, `PRESETS` |
| `markdown.mjs` | R2 | `splitLines(text)` (CRLF-safe); `headings(text) → [{ level, text, anchor, line }]`; `findSection(text, anchor) → { heading, lines, line } \| null`; `relativeLinks(text) → [{ target, path, anchor, line }]`; `resolveLinkPath(fromFile, path)`; `parseFields(lines, start) → { fields, end }` where each field is `{ name, value, items, line }`; `isEmptyValue(value)` |
| `tasks.mjs` | R3 | `TASK_ID`; `parseTask(path, text) → task`; `validateTask(task, context) → problems`; `validateTaskSet(tasks, context) → problems` (unique ids, dependencies, WIP per lane); `taskFileName(dir, id, title)`; `slugify(title)`; `TASK_FIELDS` |
| `records.mjs` | R4 | `SETUP_MARKER`; `parseDecision`, `validateDecision`, `parseLogEntry`, `validateLogEntry`, `planStatus(text) → { value, date, by, line } \| null`, `validatePlanStatus(path, status)`, `parseReadme(path, text)` (its `sections` is a Map), `validateReadme` |
| `workspace.mjs` | R5 | `treeReader(source)` with `source` `{ kind: 'worktree' }`, `{ kind: 'index' }` or `{ kind: 'commit', rev }`, returning `{ list(prefix), read(path), exists(path) }`; `loadWorkspace(reader, config) → workspace` (parse problems in `workspace.problems`); `checkWorkspace(workspace, reader, config) → problems`; `isCode(path, config)`; `fingerprint(source, config)` |
| `gates.mjs` | V1 | `runGates(commands) → { passed, failure }`; `stampPath(fingerprint)`; `verifyCommand(options)`; `gatesCommand()` |
| `range.mjs` | V2 | `taskTrailers(message) → ids`; `checkRange(from, to, context) → problems` |
| `handoff.mjs` | V3 | `handoffProblems(context) → problems`; `handoffCommand()` |
| `githooks.mjs` | H1, H2, H3 | `preCommit()`, `commitMsg(file)`, `prePush(stdin)`, `hooksActive()`, `activateHooks()` |
| `lanes.mjs` | W1, W2 | `currentLane()`; `localLanes()`; `remoteLanes(options)` |
| `work.mjs` | W1 | `workCommand(options)` |
| `create.mjs` | W3 | `taskCommand(id)`; `newCommand(args)`; `nextTaskId(prefix, known)`; `nextChildId(parent, known)` |
| `claim.mjs` | W4 | `claimCommand(args)` |
| `changes.mjs` | W5 | `changesCommand(args)` |
| `ci.mjs` | C1–C3 | `ciCommand(args)` and its helpers |
| `agents.mjs` | A1, A2 | `hookCommand(agent, event)` and the input adapters |
| `main.mjs` | F1, then every command task | Parses arguments and calls the commands. It is the bundle's last module. |

## The workspace object

`loadWorkspace` returns:

```js
{
  dir,            // the workspace folder, e.g. 'ledger'
  tasks,          // parsed tasks, each with .file and its parse problems
  decisions,      // parsed decisions
  logs,           // parsed log entries
  plans,          // Map of plan file path → status line value or null
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

Shape checks and session checks are separate. `validateTask` checks the shape of one task file: what any commit may contain. Whether a `doing` task has a current Handoff is a question for the end of a session, so `handoffProblems` (V3) asks it, not `validateTask`; otherwise a claim could never be committed before its first handoff note.
