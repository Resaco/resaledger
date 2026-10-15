// Agent hooks (spec 11): one entry point, hook <agent> <event>, for the agents that have hooks,
// and the configurations that call it. Each agent has an input adapter that turns its JSON into
// an action; the rules are shared. The contract every adapter keeps:
// - a refusal is exit code 2 with the reason on stderr;
// - input the adapter does not recognise is allowed, never blocked: git hooks and CI still hold;
// - the guard finds the repository root itself, from the input's cwd or the current folder;
// - it stays fast: git is asked only what the action needs.
//
// The shell parser reads commands well enough that text inside quotes is never taken for an
// option, a command or a redirection. What it does not parse, and therefore does not see:
// - a `cd` only moves the folder for the commands after it in the same script, subshells too;
// - aliases, functions, `source`d scripts, scripts run from files, and variables: a word with
//   an unexpanded $VAR or a glob is never a path the guard checks;
// - `case` patterns, whose ")" ends a command early (the commands still parse, a bit split);
// - `find -exec`, `git` aliases and `env -S`;
// - file edits through tools other than redirections, tee and sed -i (cp, mv, perl -i …).
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { CONFIG_FILE, DEFAULTS, loadConfig } from './config.mjs'
import { handoffProblems, handoffReport } from './handoff.mjs'
import { activateHooks } from './githooks.mjs'
import { currentLane } from './lanes.mjs'

export const AGENT_NAMES = Object.freeze(['claude', 'codex', 'cursor', 'gemini', 'copilot'])
export const AGENT_EVENTS = Object.freeze(['session-start', 'pre-tool', 'stop'])

// How long a session's state is kept under .git, in days.
const AGENTS_SESSION_DAYS = 14
const AGENTS_REMINDER_PROBLEMS = 5
const AGENTS_WORK_TIMEOUT = 15 * 1000

// The input adapters. tool(input) turns a tool call into an action, or null when the tool is
// none of the guard's business or its input is not recognised:
//   { kind: 'shell', command }   a shell command, as text
//   { kind: 'edit', paths }      file edits, paths absolute or relative to the session's folder
// session(input), when an adapter has one, returns { id, cwd }; the default reads session_id
// and cwd, which Claude Code and Codex both send with every event.

function agentsIsObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The paths an apply_patch envelope adds, updates, deletes or moves to. */
export function patchPaths(patch) {
  const paths = []
  for (const line of String(patch).split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/)
    if (match) paths.push(match[1].trim())
  }
  return paths
}

/** A command given as an argument list: the script of "bash -lc <script>", or the words quoted. */
function agentsArgvCommand(argv) {
  if (!argv.every((word) => typeof word === 'string') || argv.length === 0) return null
  if (argv.length === 3 && /(?:^|\/)(?:ba|z|da|k)?sh$/.test(argv[0]) && /^-\w*c$/.test(argv[1])) return argv[2]
  return argv.map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)).join(' ')
}

/** A tool's arguments as an object: the object itself, or a JSON text of one; null otherwise. */
function agentsToolArgs(args) {
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return null
    }
  }
  return agentsIsObject(args) ? args : null
}

/** The first of the named fields of args that holds a non-empty string, or null. */
function agentsStringField(args, names) {
  const name = names.find((key) => typeof args[key] === 'string' && args[key] !== '')
  return name === undefined ? null : args[name]
}

const AGENTS_PATH_FIELDS = ['file_path', 'path', 'target_file', 'filePath']

/**
 * Claude Code's tool input, which the Copilot CLI also sends when it runs the hooks of
 * .claude/settings.json: tool_name and tool_input, with Claude's tool names.
 */
function agentsClaudeTool(input) {
  const args = input.tool_input
  if (!agentsIsObject(args)) return null
  if (input.tool_name === 'Bash') return typeof args.command === 'string' ? { kind: 'shell', command: args.command } : null
  if (['Edit', 'Write', 'MultiEdit'].includes(input.tool_name)) return typeof args.file_path === 'string' ? { kind: 'edit', paths: [args.file_path] } : null
  if (input.tool_name === 'NotebookEdit') return typeof args.notebook_path === 'string' ? { kind: 'edit', paths: [args.notebook_path] } : null
  return null
}

// Each adapter may also have:
//   session(input)       { id, cwd } from the agent's own field names;
//   startOutput(text)    what session start prints, for an agent whose stdout must be JSON;
//   deny(message)        the agent's JSON for a refused tool, printed besides exit code 2;
//   remind(message)      the agent's JSON for the end-of-turn reminder, when exit code 2 is
//                        not how that agent's end-of-turn hook continues the agent;
//   turnsOnHooks(input)  true for a call that turns on the git hooks when it is the session's first.
const AGENT_ADAPTERS = {
  claude: { tool: agentsClaudeTool },
  codex: {
    tool(input) {
      const args = input.tool_input
      if (!agentsIsObject(args)) return null
      const command = Array.isArray(args.command) ? agentsArgvCommand(args.command) : args.command
      if (typeof command !== 'string') return null
      if (input.tool_name === 'apply_patch') return { kind: 'edit', paths: patchPaths(command) }
      if (['Bash', 'shell', 'local_shell', 'exec_command'].includes(input.tool_name)) return { kind: 'shell', command }
      return null
    }
  },
  cursor: {
    // Every Cursor hook sends conversation_id; sessionStart also sends session_id.
    session: (input) => ({
      id: input.conversation_id ?? input.session_id,
      cwd: typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : undefined
    }),
    tool(input) {
      // beforeShellExecution sends the command and its folder at the top level.
      if (typeof input.command === 'string' && input.tool_name === undefined) return { kind: 'shell', command: input.command }
      const args = agentsToolArgs(input.tool_input)
      if (args === null || typeof input.tool_name !== 'string') return null
      if (/^(?:shell|terminal|run_terminal_cmd|run_terminal_command)$/i.test(input.tool_name)) {
        return typeof args.command === 'string' ? { kind: 'shell', command: args.command, cwd: agentsStringField(args, ['cwd', 'working_directory']) } : null
      }
      if (/^(?:write|edit|strreplace|str_replace|multiedit|search_replace|edit_file|delete|delete_file)$/i.test(input.tool_name)) {
        const path = agentsStringField(args, AGENTS_PATH_FIELDS)
        return path === null ? null : { kind: 'edit', paths: [path] }
      }
      return null
    },
    turnsOnHooks: (input) => typeof input.command === 'string' && input.tool_name === undefined,
    startOutput: (text) => JSON.stringify({ additional_context: text }),
    deny: (message) => ({ permission: 'deny', user_message: message, agent_message: message }),
    remind: (message) => ({ followup_message: message })
  },
  gemini: {
    tool(input) {
      const args = agentsToolArgs(input.tool_input)
      if (args === null) return null
      if (input.tool_name === 'run_shell_command') {
        return typeof args.command === 'string' ? { kind: 'shell', command: args.command, cwd: agentsStringField(args, ['dir_path', 'directory']) } : null
      }
      if (['write_file', 'replace'].includes(input.tool_name)) {
        const path = agentsStringField(args, AGENTS_PATH_FIELDS)
        return path === null ? null : { kind: 'edit', paths: [path] }
      }
      return null
    },
    startOutput: (text) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }),
    deny: (message) => ({ decision: 'deny', reason: message })
  },
  copilot: {
    session: (input) => ({ id: input.sessionId ?? input.session_id, cwd: input.cwd }),
    tool(input) {
      // Claude Code's shape, which Copilot sends to hooks under Claude's event names.
      if (input.tool_name !== undefined) return agentsClaudeTool(input)
      if (typeof input.toolName !== 'string') return null
      const name = input.toolName.toLowerCase()
      if (name === 'apply_patch') {
        const patch = typeof input.toolArgs === 'string' && input.toolArgs.includes('*** Begin Patch') ? input.toolArgs : agentsStringField(agentsToolArgs(input.toolArgs) ?? {}, ['input', 'patch'])
        return patch === null ? null : { kind: 'edit', paths: patchPaths(patch) }
      }
      const args = agentsToolArgs(input.toolArgs)
      if (args === null) return null
      if (name === 'bash' || name === 'shell') return typeof args.command === 'string' ? { kind: 'shell', command: args.command } : null
      if (['edit', 'create', 'write', 'str_replace', 'str_replace_editor'].includes(name)) {
        const path = agentsStringField(args, AGENTS_PATH_FIELDS)
        return path === null ? null : { kind: 'edit', paths: [path] }
      }
      return null
    },
    startOutput: (text) => JSON.stringify({ additionalContext: text }),
    deny: (message) => ({ permissionDecision: 'deny', permissionDecisionReason: message }),
    remind: (message) => ({ decision: 'block', reason: message })
  }
}

// The shell parser.

/** The index of the ")" that closes a "(" just before start, skipping quotes; text.length when none. */
function agentsClosingParen(text, start) {
  let depth = 1
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (char === '\\') index++
    else if (char === "'") {
      const end = text.indexOf("'", index + 1)
      index = end === -1 ? text.length : end
    } else if (char === '"') {
      index++
      while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1
    } else if (char === '(') depth++
    else if (char === ')' && --depth === 0) return index
  }
  return text.length
}

/**
 * The expansion that starts at text[index] ("$" or a backtick): { end, script, literal }.
 * script is the text of a command substitution, to be parsed too; literal is true for a lone "$".
 */
function agentsExpansion(text, index) {
  if (text[index] === '`') {
    let end = index + 1
    while (end < text.length && text[end] !== '`') end += text[end] === '\\' ? 2 : 1
    return { end: Math.min(end + 1, text.length), script: text.slice(index + 1, end) }
  }
  const next = text[index + 1]
  if (next === '(') {
    const close = agentsClosingParen(text, index + 2)
    if (text[index + 2] === '(') return { end: close + 1 } // arithmetic
    return { end: close + 1, script: text.slice(index + 2, close) }
  }
  if (next === '{') {
    const close = text.indexOf('}', index + 2)
    return { end: close === -1 ? text.length : close + 1 }
  }
  const name = text.slice(index + 1).match(/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/)
  if (name) return { end: index + 1 + name[0].length }
  return { end: index + 1, literal: true }
}

const AGENTS_REDIRECT = /^(?:<<<|<<-|<<|<>|<&|>>|>&|>\||<|>)/
const AGENTS_KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'esac', 'time'])

/**
 * Splits a script into simple commands without running anything. Each command is { words,
 * redirects, heredocs, nested, separator } with words { value, quoted, dynamic }, redirects
 * { op, target }, the bodies of its here-documents, and the scripts of the command and process
 * substitutions in its words, which run before it.
 */
function agentsTokenize(text) {
  const commands = []
  const pending = [] // here-documents whose bodies start after the next newline
  let command = { words: [], redirects: [], heredocs: [], nested: [], separator: '' }
  let word = null
  let redirect = null
  const startWord = () => {
    if (word === null) word = { value: '', quoted: false, dynamic: false }
    return word
  }
  const endWord = () => {
    if (word === null) return
    if (redirect) command.redirects.push({ op: redirect, target: word })
    else command.words.push(word)
    word = null
    redirect = null
  }
  const endCommand = (separator) => {
    endWord()
    redirect = null
    if (command.words.length > 0 || command.redirects.length > 0) {
      command.separator = separator
      commands.push(command)
    }
    command = { words: [], redirects: [], heredocs: [], nested: [], separator: '' }
  }
  const expand = (index) => {
    const expansion = agentsExpansion(text, index)
    if (expansion.script !== undefined) command.nested.push(expansion.script)
    const current = startWord()
    current.value += text.slice(index, expansion.end)
    if (!expansion.literal) current.dynamic = true
    return expansion.end
  }

  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === ' ' || char === '\t' || char === '\r') {
      endWord()
      index++
    } else if (char === '\n') {
      endCommand(';')
      index++
      while (pending.length > 0) {
        const doc = pending.shift()
        const body = []
        while (index < text.length) {
          let end = text.indexOf('\n', index)
          if (end === -1) end = text.length
          const line = text.slice(index, end).replace(/\r$/, '')
          index = end + 1
          if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delimiter) break
          body.push(line)
        }
        doc.command.heredocs.push(body.join('\n'))
      }
    } else if (char === '#' && word === null) {
      const end = text.indexOf('\n', index)
      index = end === -1 ? text.length : end
    } else if (char === '\\') {
      if (text[index + 1] !== '\n') startWord().value += text[index + 1] ?? ''
      index += 2
    } else if (char === "'") {
      const end = text.indexOf("'", index + 1)
      const stop = end === -1 ? text.length : end
      const current = startWord()
      current.value += text.slice(index + 1, stop)
      current.quoted = true
      index = stop + 1
    } else if (char === '$' && text[index + 1] === "'") {
      // ANSI-C quoting: a literal string with backslash escapes.
      let end = index + 2
      while (end < text.length && text[end] !== "'") end += text[end] === '\\' ? 2 : 1
      const current = startWord()
      current.value += text.slice(index + 2, end).replace(/\\(.)/g, '$1')
      current.quoted = true
      index = end + 1
    } else if (char === '"') {
      const current = startWord()
      current.quoted = true
      index++
      while (index < text.length && text[index] !== '"') {
        const inner = text[index]
        if (inner === '\\' && index + 1 < text.length && '$`"\\\n'.includes(text[index + 1])) {
          if (text[index + 1] !== '\n') current.value += text[index + 1]
          index += 2
        } else if (inner === '$' || inner === '`') index = expand(index)
        else {
          current.value += inner
          index++
        }
      }
      index++
    } else if (char === '$' || char === '`') {
      index = expand(index)
    } else if ((char === '<' || char === '>') && text[index + 1] === '(') {
      const close = agentsClosingParen(text, index + 2)
      command.nested.push(text.slice(index + 2, close))
      const current = startWord()
      current.value += text.slice(index, close + 1)
      current.dynamic = true
      index = close + 1
    } else if (char === '&' && text[index + 1] === '>') {
      endWord()
      const op = text[index + 2] === '>' ? '&>>' : '&>'
      redirect = op
      index += op.length
    } else if (char === '<' || char === '>') {
      // A number written right before the operator is the file descriptor, not a word.
      if (word !== null && !word.quoted && !word.dynamic && /^\d+$/.test(word.value)) word = null
      else endWord()
      const op = text.slice(index).match(AGENTS_REDIRECT)[0]
      index += op.length
      if (op === '<<' || op === '<<-') {
        while (text[index] === ' ' || text[index] === '\t') index++
        let delimiter = ''
        while (index < text.length && !/[\s;&|()<>]/.test(text[index])) {
          if (text[index] !== '"' && text[index] !== "'" && text[index] !== '\\') delimiter += text[index]
          index++
        }
        pending.push({ delimiter, strip: op === '<<-', command })
      } else redirect = op
    } else if ('|&;()'.includes(char)) {
      let op = char
      if ((char === '&' || char === '|' || char === ';') && text[index + 1] === char) op = char + char
      else if (char === '|' && text[index + 1] === '&') op = '|&'
      endCommand(op)
      index += op.length
    } else {
      startWord().value += char
      if ('*?['.includes(char) && !word.quoted) word.dynamic = true
      index++
    }
  }
  endCommand('')
  return commands
}

const AGENTS_WRAPPERS = {
  command: { args: [] },
  builtin: { args: [] },
  exec: { args: ['-a'] },
  nohup: { args: [] },
  time: { args: [] },
  nice: { args: ['-n'] },
  sudo: { args: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'] },
  doas: { args: ['-u', '-C'] },
  env: { args: ['-u', '-C', '--unset', '--chdir'], assignments: true },
  xargs: { args: ['-I', '-L', '-n', '-P', '-d', '-E', '-s', '-a'] },
  timeout: { args: ['-s', '-k', '--signal', '--kill-after'], positional: 1 },
  stdbuf: { args: ['-i', '-o', '-e'] }
}
const AGENTS_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/

/** The base name of a command word: "/usr/bin/git" → "git". */
function agentsProgram(word) {
  return word.replace(/^.*\//, '')
}

/**
 * A parsed command without what only wraps the real one: keywords such as "if" and "!",
 * variable assignments, and wrappers such as env, sudo or xargs. Returns
 * { args (strings), words, assignments (strings), redirects, heredocs }.
 */
function agentsSimpleCommand(command) {
  let words = command.words
  const assignments = []
  let changed = true
  while (changed && words.length > 0) {
    changed = false
    while (words.length > 0 && !words[0].quoted && AGENTS_KEYWORDS.has(words[0].value)) {
      words = words.slice(1)
      changed = true
    }
    while (words.length > 0 && AGENTS_ASSIGNMENT.test(words[0].value)) {
      assignments.push(words[0].value)
      words = words.slice(1)
      changed = true
    }
    const wrapper = words.length > 0 ? AGENTS_WRAPPERS[agentsProgram(words[0].value)] : undefined
    if (wrapper) {
      let index = 1
      let positional = wrapper.positional ?? 0
      while (index < words.length) {
        const value = words[index].value
        if (value === '--') {
          index++
          break
        }
        if (wrapper.args.includes(value)) index += 2
        else if (value.startsWith('-') && value.length > 1) index++
        else if (wrapper.assignments && AGENTS_ASSIGNMENT.test(value)) {
          assignments.push(value)
          index++
        } else if (positional > 0) {
          positional--
          index++
        } else break
      }
      words = words.slice(index)
      changed = true
    }
  }
  return { args: words.map((item) => item.value), words, assignments, redirects: command.redirects, heredocs: command.heredocs }
}

/** The script a shell runs with -c ("bash -lc 'git push'"), or null. */
function agentsShellScript(args) {
  if (!/^(?:ba|z|da|k|fi)?sh$/.test(agentsProgram(args[0] ?? ''))) return null
  let script = false
  for (let index = 1; index < args.length; index++) {
    const value = args[index]
    if (value === '-o' || value === '+o' || value === '-O' || value === '+O') index++
    else if (/^[-+][A-Za-z]+$/.test(value)) {
      if (value.startsWith('-') && value.includes('c')) script = true
    } else if (value === '--') continue
    else return script ? value : null
  }
  return null
}

/**
 * The simple commands of a shell script, in the order they run as far as the text shows,
 * including those inside command substitutions, "bash -c" scripts and eval. Each is
 * { args, words, assignments, redirects, heredocs, separator, depth }; depth 0 is the
 * script's own level.
 */
export function shellCommands(text, depth = 0) {
  if (depth > 5) return []
  const result = []
  for (const command of agentsTokenize(String(text))) {
    for (const script of command.nested) result.push(...shellCommands(script, depth + 1))
    const simple = { ...agentsSimpleCommand(command), separator: command.separator, depth }
    result.push(simple)
    const script = agentsShellScript(simple.args)
    if (script !== null) result.push(...shellCommands(script, depth + 1))
    if (simple.args[0] === 'eval') result.push(...shellCommands(simple.args.slice(1).join(' '), depth + 1))
  }
  return result
}

/** A command as text for agent.deny: its words, with any word that holds whitespace shown as "…". */
function agentsRenderCommand(command) {
  const words = [...command.assignments, ...command.args].map((value) => (/\s/.test(value) ? '"…"' : value))
  return words.join(' ')
}

// The rules.

const AGENTS_NO_VERIFY = /^--no-veri(?:fy?)?$/
const AGENTS_HOOKS_PATH = /^core\.hookspath$/i

// Options of git subcommands that take the next word as their value, so it is never read as an option.
const AGENTS_GIT_VALUE_OPTIONS = {
  commit: ['-m', '-F', '-c', '-C', '-t', '--message', '--file', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--author', '--date', '--template', '--cleanup', '--trailer', '--pathspec-from-file'],
  push: ['-o', '--push-option', '--repo', '--receive-pack', '--exec'],
  merge: ['-m', '-F', '-s', '-X', '--message', '--file', '--strategy', '--strategy-option', '--into-name'],
  rebase: ['-s', '-X', '-x', '--onto', '--strategy', '--strategy-option', '--exec'],
  checkout: ['-b', '-B', '--orphan', '--conflict', '--pathspec-from-file'],
  switch: ['-c', '-C', '--create', '--force-create', '--orphan', '--conflict'],
  restore: ['-s', '--source', '--conflict', '--pathspec-from-file'],
  reset: ['--pathspec-from-file'],
  clean: ['-e', '--exclude'],
  default: ['-m', '-F', '--message', '--file']
}
const AGENTS_COMMIT_SHORT_VALUES = 'mFcCt'
const AGENTS_COMMIT_SHORT_ATTACHED = 'Su'

/** Splits a git subcommand's arguments into { options, positionals }, skipping option values. */
function agentsGitArguments(sub, args) {
  const takesValue = AGENTS_GIT_VALUE_OPTIONS[sub] ?? AGENTS_GIT_VALUE_OPTIONS.default
  const options = []
  const positionals = []
  for (let index = 0; index < args.length; index++) {
    const value = args[index]
    if (value === '--') {
      positionals.push(...args.slice(index + 1).map((path) => ({ value: path, afterDashes: true })))
      break
    }
    if (value.startsWith('-') && value !== '-') {
      options.push(value)
      if (takesValue.includes(value)) index++
      else if (sub === 'commit' && /^-[A-Za-z]{2,}$/.test(value)) {
        // A cluster such as -am: a letter that takes a value ends it, and the value may follow.
        const letters = value.slice(1)
        const at = [...letters].findIndex((letter) => AGENTS_COMMIT_SHORT_VALUES.includes(letter) || AGENTS_COMMIT_SHORT_ATTACHED.includes(letter))
        if (at === letters.length - 1 && AGENTS_COMMIT_SHORT_VALUES.includes(letters[at])) index++
      }
    } else positionals.push({ value, afterDashes: false })
  }
  return { options, positionals }
}

/** True when a commit's options say --no-verify: the long option or -n, alone or in a cluster. */
function agentsCommitSkipsHooks(options) {
  for (const option of options) {
    if (AGENTS_NO_VERIFY.test(option) || option === '-n') return true
    if (/^-[A-Za-z]{2,}$/.test(option)) {
      for (const letter of option.slice(1)) {
        if (letter === 'n') return true
        if (AGENTS_COMMIT_SHORT_VALUES.includes(letter) || AGENTS_COMMIT_SHORT_ATTACHED.includes(letter)) break
      }
    }
  }
  return false
}

/** The branch a push destination names, or null for a tag or another kind of ref. */
function agentsPushBranch(destination, current) {
  if (destination === 'HEAD' || destination === '@') return current
  if (destination.startsWith('refs/heads/')) return destination.slice('refs/heads/'.length)
  if (destination.startsWith('refs/')) return null
  return destination
}

/**
 * A git command line read up to its subcommand: { folder, settings, sub, rest }. folder is
 * where it runs after any -C, settings the -c and --config-env values, rest the words after sub.
 */
function agentsGitInvocation(args, cwd) {
  let index = 1
  let folder = cwd
  const settings = []
  while (index < args.length) {
    const value = args[index]
    if (value === '-C') {
      folder = resolve(folder, agentsExpandHome(args[index + 1] ?? '.'))
      index += 2
    } else if (value === '-c' || value === '--config-env') {
      settings.push(args[index + 1] ?? '')
      index += 2
    } else if (value.startsWith('-c') && value.length > 2) {
      settings.push(value.slice(2))
      index++
    } else if (value.startsWith('--config-env=')) {
      settings.push(value.slice('--config-env='.length))
      index++
    } else if (['--git-dir', '--work-tree', '--namespace', '--super-prefix', '--attr-source'].includes(value)) index += 2
    else if (value.startsWith('-')) index++
    else break
  }
  return { folder, settings, sub: args[index], rest: args.slice(index + 1) }
}

/** True when a short-option word (such as -fd, not --force) holds the letter. */
function agentsShortHas(option, letter) {
  return /^-[A-Za-z]+$/.test(option) && option.slice(1).includes(letter)
}

/** True when a local branch of that name exists, seen from folder. */
function agentsLocalBranch(folder, name) {
  return agentsGit(folder, ['rev-parse', '--verify', '-q', `refs/heads/${name}`]) !== null
}

/**
 * What a git command throws away, as words for the refusal, or null when it keeps the work:
 * reset --hard, clean -f, checkout of paths or forced, restore of the worktree, switch -f.
 */
function agentsDiscards(sub, options, positionals, folder) {
  const has = (...names) => options.some((option) => names.includes(option))
  if (sub === 'reset') return has('--hard') ? 'throws away uncommitted changes' : null
  if (sub === 'clean') {
    const force = options.some((option) => option === '--force' || agentsShortHas(option, 'f'))
    const dryRun = options.some((option) => option === '--dry-run' || agentsShortHas(option, 'n'))
    return force && !dryRun ? 'deletes untracked files' : null
  }
  if (sub === 'switch') return options.some((option) => ['--force', '--discard-changes'].includes(option) || agentsShortHas(option, 'f')) ? 'throws away uncommitted changes' : null
  if (sub === 'restore') {
    const worktree = options.some((option) => option === '--worktree' || agentsShortHas(option, 'W'))
    const staged = options.some((option) => option === '--staged' || agentsShortHas(option, 'S'))
    return worktree || !staged ? 'throws away uncommitted changes to files' : null
  }
  if (sub === 'checkout') {
    if (options.some((option) => option === '--force' || agentsShortHas(option, 'f'))) return 'throws away uncommitted changes'
    if (agentsCheckoutPaths(options, positionals, folder)) return 'throws away uncommitted changes to files'
  }
  return null
}

/**
 * True when a checkout restores paths rather than switching branches: paths after "--", a ".",
 * a tree-ish and paths, or one word that names an existing path and no local branch.
 */
function agentsCheckoutPaths(options, positionals, folder) {
  if (options.some((option) => ['-b', '-B', '--orphan', '-p', '--patch'].includes(option))) return positionals.some((item) => item.afterDashes)
  if (positionals.some((item) => item.afterDashes || item.value === '.' || item.value === './')) return true
  if (positionals.length > 1) return true
  const [only] = positionals
  return only !== undefined && only.value !== '-' && existsSync(resolve(folder, only.value)) && !agentsLocalBranch(folder, only.value)
}

/**
 * The branch a checkout or switch moves its worktree to: a name, null for a detached HEAD, or
 * undefined when it does not move it or the guard cannot tell.
 */
function agentsSwitchTarget(sub, rest, options, positionals, folder) {
  const created = rest.findIndex((word) => (sub === 'switch' ? ['-c', '-C', '--create', '--force-create', '--orphan'] : ['-b', '-B', '--orphan']).includes(word))
  if (created !== -1) return rest[created + 1]
  if (options.includes('--detach') || (sub === 'switch' && options.includes('-d'))) return null
  if (sub === 'checkout' && agentsCheckoutPaths(options, positionals, folder)) return undefined
  const target = positionals[0]?.value
  if (target === undefined || target === '-' || target.startsWith('@{')) return undefined
  if (agentsLocalBranch(folder, target)) return target
  // A commit checks out a detached HEAD; any other name makes a branch from a remote one.
  if (sub === 'checkout' && agentsGit(folder, ['rev-parse', '--verify', '-q', `${target}^{commit}`]) !== null) return null
  return target
}

/** The refusal for a git command, or null. context holds the configuration and the folder it runs in. */
function agentsGitRefusal(args, context, cwd) {
  const { folder, settings, sub, rest } = agentsGitInvocation(args, cwd)
  if (settings.some((setting) => AGENTS_HOOKS_PATH.test(setting.split('=')[0]))) {
    return 'this git command changes core.hooksPath for its run, which turns the git hooks off. The hooks stay on; fix what they report instead'
  }
  if (sub === undefined) return null
  const { options, positionals } = agentsGitArguments(sub, rest)

  if (options.some((option) => AGENTS_NO_VERIFY.test(option)) || (sub === 'commit' && agentsCommitSkipsHooks(options))) {
    return `"git ${sub}" with --no-verify skips the git hooks. Never bypass them: fix what the hook reports, or tell the user what blocks you`
  }

  const discards = agentsDiscards(sub, options, positionals, folder)
  if (discards) {
    const worktree = agentsWorktreeOf(context, folder)
    const branch = worktree ? agentsBranchOf(context, worktree) : null
    if (branch && context.config.protected.includes(branch)) {
      return `"git ${sub}" here ${discards} in the checkout of the protected branch "${branch}". Run it only in your own lane's worktree, on your lane's branch`
    }
    if (worktree && worktree.top !== agentsOwnTop(context)) {
      return `"git ${sub}" here ${discards} in another worktree (${worktree.top}${branch ? `, branch "${branch}"` : ''}), not this session's own. Leave other lanes' work to their owners; run it only in your own worktree`
    }
  }

  if (sub === 'config') {
    const words = positionals.map((item) => item.value)
    const key = words.findIndex((word) => AGENTS_HOOKS_PATH.test(word))
    if (key === -1) return null
    const reading = options.some((option) => /^--(?:get|get-all|get-regexp|get-urlmatch|list)$|^-l$/.test(option)) || ['get', 'list'].includes(words[0])
    const writing = options.some((option) => /^--(?:unset|unset-all|replace-all|add|remove-section|rename-section)$/.test(option)) || ['set', 'unset'].includes(words[0])
    if (!writing && (reading || key === words.length - 1)) return null
    return 'changing core.hooksPath turns the ResaLedger git hooks off. They stay on; fix what they report instead'
  }

  if (sub === 'commit') {
    const branch = agentsBranchAt(context, folder)
    if (branch && context.config.protected.includes(branch)) {
      return `"${branch}" is a protected branch, so nothing is committed on it. Work in a lane branch: "${context.guard} claim <id>" creates one`
    }
    return null
  }

  if (sub === 'push') {
    const force = options.some((option) => option === '-f' || option === '--mirror' || (option.startsWith('--force') && !option.startsWith('--force-if-includes')) || /^-[A-Za-z]*f[A-Za-z]*$/.test(option) && !option.startsWith('--'))
    const refspecs = positionals.slice(1).map((item) => item.value)
    if (force || refspecs.some((refspec) => refspec.startsWith('+'))) {
      return 'a forced push rewrites history that others may have. Push normally; if the push is rejected, fetch, merge or rebase your own unpushed commits, and push again'
    }
    const protectedRefusal = agentsProtectedPushRefusal(options, refspecs, context, folder)
    if (protectedRefusal) return protectedRefusal
    if (context.config.agent.pushNeedsHandoff) {
      // A dry run pushes nothing.
      if (options.some((option) => option === '--dry-run' || agentsShortHas(option, 'n'))) return null
      if (context.changedBy) {
        return `"git push" follows "git ${context.changedBy}" in the same command, and agent.pushNeedsHandoff judges a push before the command runs, so it cannot see what "git ${context.changedBy}" changes. Run "git push" as a command of its own, after the rest has run`
      }
      return agentsPushHandoffRefusal(context, folder)
    }
  }
  return null
}

// The git commands that change the commits, the index or the checkout, for a push after them.
const AGENTS_CHANGING = ['add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'commit', 'merge', 'mv', 'pull', 'rebase', 'reset', 'restore', 'revert', 'rm', 'stash', 'switch']

/** Notes the last git command so far in a command line that changes the commits, the index or the checkout. */
function agentsTrackChange(args, context, cwd) {
  const { sub, rest } = agentsGitInvocation(args, cwd)
  if (!AGENTS_CHANGING.includes(sub)) return
  if (sub === 'stash' && ['list', 'show'].includes(rest[0])) return
  context.changedBy = sub
}

/** The refusal for a push that would reach a protected branch, or null. */
function agentsProtectedPushRefusal(options, refspecs, context, folder) {
  const protectedBranches = context.config.protected
  if (protectedBranches.length === 0) return null
  if (options.includes('--all') || options.includes('--branches')) {
    return `"git push --all" pushes every branch, including the protected ${protectedBranches.map((branch) => `"${branch}"`).join(', ')}. Push your lane branch by name`
  }
  const current = agentsBranchAt(context, folder)
  const deleting = options.includes('-d') || options.includes('--delete')
  const targets = []
  if (refspecs.length === 0) {
    if (current) targets.push(current)
  }
  for (const refspec of refspecs) {
    const colon = refspec.indexOf(':')
    const destination = colon === -1 ? refspec : refspec.slice(colon + 1) || refspec.slice(0, colon)
    if (destination.includes('*')) {
      targets.push(...protectedBranches)
      continue
    }
    const branch = agentsPushBranch(destination, current)
    if (branch) targets.push(branch)
  }
  const hit = targets.find((branch) => protectedBranches.includes(branch))
  if (hit) {
    return `"${hit}" is a protected branch, so nothing is ${deleting ? 'deleted from' : 'pushed to'} it. Push your lane branch and open a pull request`
  }
  return null
}

/**
 * With agent.pushNeedsHandoff (spec 11): the refusal for a push while handoff fails in the
 * worktree the push runs in, or null. The check that the lane is pushed is left out, since the
 * push does that; like handoff, it runs no gates. A folder outside this repository is not judged.
 */
function agentsPushHandoffRefusal(context, folder) {
  const worktree = agentsWorktreeOf(context, folder)
  if (!worktree) return null
  const root = worktree.top
  const { config, problems: configProblems } =
    root === agentsRealPath(context.root) && context.loadedConfig ? { config: context.loadedConfig, problems: [] } : loadConfig(agentsCommittedFile(root))
  if (!config && agentsCommittedFile(root)(CONFIG_FILE) === null && worktree.branch) {
    return `the lane "${worktree.branch}" has no ${CONFIG_FILE} at its last commit: the lane branched before ResaLedger was set up. Merge the base branch into it, which brings the configuration, and push again`
  }
  const problems = config ? handoffProblems({ root, config: { ...config, requirePushed: false }, lane: worktree.branch }) : configProblems
  if (problems.length === 0) return null
  return `agent.pushNeedsHandoff is on, so an agent pushes only work that is handed over, and "${context.guard} handoff" does not pass here:
${handoffReport(problems)}
Fix these, run handoff, and push again`
}

/** The paths a command writes that the guard can see: redirections, tee and sed -i. */
function agentsWrittenPaths(command) {
  const paths = []
  for (const { op, target } of command.redirects) {
    if (!['>', '>>', '>|', '&>', '&>>', '<>', '>&'].includes(op)) continue
    if (op === '>&' && /^(?:\d+|-)$/.test(target.value)) continue
    if (!target.dynamic) paths.push(target.value)
  }
  const program = agentsProgram(command.args[0] ?? '')
  const words = command.words.slice(1)
  if (program === 'tee') {
    let dashes = false
    for (const word of words) {
      if (!dashes && word.value === '--') dashes = true
      else if (dashes || !word.value.startsWith('-')) {
        if (!word.dynamic) paths.push(word.value)
      }
    }
  }
  if (program === 'sed') {
    let inPlace = false
    let script = false
    const files = []
    for (let index = 0; index < words.length; index++) {
      const { value, dynamic } = words[index]
      if (value === '-e' || value === '-f' || value === '--expression' || value === '--file') {
        script = true
        index++
      } else if (value.startsWith('--expression=') || value.startsWith('--file=')) script = true
      else if (value === '--in-place' || value.startsWith('--in-place=')) inPlace = true
      else if (/^-[A-Za-z]/.test(value)) {
        for (let at = 1; at < value.length; at++) {
          const letter = value[at]
          if (letter === 'i') {
            inPlace = true
            // BSD sed takes the backup suffix as the next word: sed -i '' 's/a/b/' file.
            if (at === value.length - 1 && words[index + 1]?.value === '') index++
            break
          }
          if (letter === 'e' || letter === 'f') {
            script = true
            if (at === value.length - 1) index++
            break
          }
        }
      } else if (!script) script = true
      else if (!dynamic) files.push(value)
    }
    if (inPlace) paths.push(...files)
  }
  if (program === 'apply_patch') for (const body of command.heredocs) paths.push(...patchPaths(body))
  return paths
}

/** A path with a leading ~ expanded. */
function agentsExpandHome(path) {
  return path === '~' || path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path
}

/** A path with its existing part resolved through links, so it compares with git's paths. */
function agentsRealPath(path) {
  let existing = path
  const rest = []
  while (!existsSync(existing)) {
    const parent = resolve(existing, '..')
    if (parent === existing) return path
    rest.unshift(existing.slice(parent.length).replace(/^[\\/]/, ''))
    existing = parent
  }
  try {
    return resolve(realpathSync.native(existing), ...rest)
  } catch {
    return path
  }
}

function agentsGit(folder, args) {
  const result = spawnSync('git', ['-C', folder, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  return result.status === 0 ? result.stdout.replace(/\r?\n$/, '') : null
}

/**
 * The worktree a folder is in, as { top, branch }, or null when it is outside this repository
 * (another repository counts as outside). Cached per folder.
 */
function agentsWorktreeOf(context, folder) {
  if (context.worktrees.has(folder)) return context.worktrees.get(folder)
  let found = null
  let existing = folder
  while (!existsSync(existing) && resolve(existing, '..') !== existing) existing = resolve(existing, '..')
  try {
    if (!statSync(existing).isDirectory()) existing = resolve(existing, '..')
  } catch {}
  const out = agentsGit(existing, ['rev-parse', '--show-toplevel', '--git-common-dir'])
  if (out !== null) {
    const [top, common] = out.split('\n')
    if (agentsRealPath(resolve(existing, common)) === context.commonDir) {
      const branch = agentsGit(top, ['symbolic-ref', '--short', '-q', 'HEAD']) || null
      found = { top: agentsRealPath(top), branch }
    }
  }
  context.worktrees.set(folder, found)
  return found
}

/** A worktree's branch, after any checkout or switch the script ran in it before this command. */
function agentsBranchOf(context, worktree) {
  return context.switched.has(worktree.top) ? context.switched.get(worktree.top) : worktree.branch
}

function agentsBranchAt(context, folder) {
  const worktree = agentsWorktreeOf(context, folder)
  return worktree ? agentsBranchOf(context, worktree) : null
}

/**
 * The top of the session's own worktree: where its start was recorded, so that a session whose
 * folder moved since is still judged by where it started; else the worktree of its folder.
 */
function agentsOwnTop(context) {
  if (context.ownTop !== undefined) return context.ownTop
  let top = null
  const file = agentsSessionFile(context, 'start')
  try {
    const recorded = JSON.parse(readFileSync(file, 'utf8')).top
    if (typeof recorded === 'string') top = recorded
  } catch {}
  context.ownTop = top ?? agentsWorktreeOf(context, context.cwd)?.top ?? null
  return context.ownTop
}

/** Notes the branch a checkout or switch leaves its worktree on, for the commands after it. */
function agentsTrackSwitch(args, context, cwd) {
  const { folder, sub, rest } = agentsGitInvocation(args, cwd)
  if (sub !== 'checkout' && sub !== 'switch') return
  const worktree = agentsWorktreeOf(context, folder)
  if (!worktree) return
  const { options, positionals } = agentsGitArguments(sub, rest)
  const target = agentsSwitchTarget(sub, rest, options, positionals, folder)
  if (target !== undefined) context.switched.set(worktree.top, target)
}

/** The refusal for file edits at the given absolute paths, or null. */
function agentsEditRefusal(paths, context) {
  for (const path of paths) {
    if (path.startsWith('/dev/')) continue
    const real = agentsRealPath(path)
    const worktree = agentsWorktreeOf(context, resolve(real, '..'))
    const branch = worktree ? agentsBranchOf(context, worktree) : null
    if (!branch || !context.config.protected.includes(branch)) continue
    const inside = relative(worktree.top, real).replace(/\\/g, '/')
    if (inside === '' || inside.startsWith('../') || inside === '..' || inside === '.git' || inside.startsWith('.git/')) continue
    const ignored = spawnSync('git', ['-C', worktree.top, 'check-ignore', '-q', '--', inside], { stdio: 'ignore' })
    if (ignored.status === 0) continue
    return `"${branch}" is a protected branch, so files are not edited on it (${inside}). Work in a lane branch: "${context.guard} claim <id>" creates one, or "git switch -c <branch>"`
  }
  return null
}

/** The refusal for a shell command run in folder (default the session's), or null. */
function agentsShellRefusal(text, context, folder = context.cwd) {
  const commands = shellCommands(text)
  let cwd = folder
  // An edit is judged by the branch at its point in the script; its refusal comes after agent.deny's.
  let editRefusal = null
  for (const command of commands) {
    const program = agentsProgram(command.args[0] ?? '')
    for (const assignment of command.assignments) {
      if (/^GIT_CONFIG_(?:PARAMETERS|KEY_\d+|COUNT)=/.test(assignment) && /hookspath/i.test(assignment)) {
        return 'this command changes core.hooksPath through the environment, which turns the git hooks off. The hooks stay on; fix what they report instead'
      }
    }
    if (program === 'export' && command.args.some((word) => /^GIT_CONFIG_/.test(word) && /hookspath/i.test(word))) {
      return 'this command changes core.hooksPath through the environment, which turns the git hooks off. The hooks stay on; fix what they report instead'
    }
    if (program === 'git') {
      const reason = agentsGitRefusal(command.args, context, cwd)
      if (reason) return reason
    }
    editRefusal ??= agentsEditRefusal(agentsWrittenPaths(command).map((path) => resolve(cwd, agentsExpandHome(path))), context)
    if (program === 'git') {
      agentsTrackSwitch(command.args, context, cwd)
      agentsTrackChange(command.args, context, cwd)
    }
    if (program === 'cd' && command.depth === 0 && command.words[1] && !command.words[1].dynamic) cwd = resolve(cwd, agentsExpandHome(command.args[1]))
  }
  if (context.config.agent.deny.length > 0) {
    const top = commands.filter((command) => command.depth === 0)
    const texts = [top.map((command) => `${agentsRenderCommand(command)}${command.separator && command.separator !== ';' ? ` ${command.separator}` : command.separator}`).join(' ').trim(), ...commands.map(agentsRenderCommand)]
    for (const rule of context.config.agent.deny) {
      const regex = rule.regex ?? new RegExp(rule.pattern)
      if (texts.some((candidate) => regex.test(candidate))) {
        return `this command matches the project's agent.deny rule "${rule.pattern}"${rule.reason ? `: ${rule.reason}` : ''}`
      }
    }
  }
  return editRefusal
}

// Session state, under the common git folder: one file per session id.

function agentsSessionFile(context, suffix) {
  return context.stateDir ? resolve(context.stateDir, `${context.sessionKey}.${suffix}`) : null
}

/** What the session can have changed: HEAD, the status and the diff against HEAD. */
function agentsSnapshot(root) {
  const head = agentsGit(root, ['rev-parse', '-q', '--verify', 'HEAD']) ?? ''
  const status = agentsGit(root, ['status', '--porcelain']) ?? ''
  const diff = spawnSync('git', ['-C', root, 'diff', 'HEAD', '--no-ext-diff', '--binary'], { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  const hash = createHash('sha256').update(status).update('\0').update(diff.stdout ?? Buffer.alloc(0)).digest('hex')
  return { head, state: hash }
}

/**
 * Records where the session started, unless it is recorded already. The record is written to a
 * temporary file and then linked into place, so a concurrent reader sees either no record or a
 * whole one, and a record once in place is never replaced: concurrent calls never reset it.
 */
function agentsRecordStart(context) {
  const file = agentsSessionFile(context, 'start')
  if (!file || existsSync(file)) return
  const temporary = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(context.stateDir, { recursive: true })
    writeFileSync(temporary, `${JSON.stringify({ ...agentsSnapshot(context.root), top: agentsRealPath(context.root) })}\n`)
    try {
      linkSync(temporary, file)
    } catch (error) {
      // A file system without hard links: a rename is atomic too, but replaces, so only when still absent.
      if (error.code !== 'EEXIST' && !existsSync(file)) renameSync(temporary, file)
    }
  } catch {
  } finally {
    try {
      unlinkSync(temporary)
    } catch {}
  }
}

/** Removes the state of other sessions older than AGENTS_SESSION_DAYS; the current one's stays. */
function agentsPruneSessions(context) {
  if (!context.stateDir || !existsSync(context.stateDir)) return
  const limit = Date.now() - AGENTS_SESSION_DAYS * 24 * 60 * 60 * 1000
  for (const name of readdirSync(context.stateDir)) {
    if (name.startsWith(`${context.sessionKey}.`)) continue
    const path = resolve(context.stateDir, name)
    try {
      if (statSync(path).mtimeMs < limit) unlinkSync(path)
    } catch {}
  }
}

/** Prints the refusal and stops with exit code 2; json, when given, is the agent's own form of it on stdout. */
function agentsRefuse(message, json = null) {
  if (json) process.stdout.write(`${JSON.stringify(json)}\n`)
  console.error(`✖ ResaLedger: ${message}`)
  process.exit(2)
}

function agentsSessionStart(context) {
  agentsRecordStart(context)
  agentsPruneSessions(context)
  // work turns the git hooks on, and its output becomes the agent's context.
  const result = spawnSync(process.execPath, [process.argv[1], 'work'], { cwd: context.root, encoding: 'utf8', timeout: AGENTS_WORK_TIMEOUT })
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const { startOutput } = context.adapter
  if (startOutput) process.stdout.write(`${startOutput(text)}\n`)
  else if (text) process.stdout.write(text)
}

function agentsStop(context) {
  const startFile = agentsSessionFile(context, 'start')
  if (!startFile) return
  let start
  try {
    start = JSON.parse(readFileSync(startFile, 'utf8'))
  } catch {
    // No record of the start: the session's changes are unknown, so it starts now. Records are
    // whole or absent, and agentsRecordStart never replaces one, so this cannot reset a start.
    agentsRecordStart(context)
    return
  }
  const remindedFile = agentsSessionFile(context, 'reminded')
  if (existsSync(remindedFile)) return
  const now = agentsSnapshot(context.root)
  if (now.head === start.head && now.state === start.state) return
  let problems
  try {
    problems = context.config ? handoffProblems({ root: context.root, config: context.config, lane: currentLane() }) : context.configProblems
  } catch {
    return
  }
  if (problems.length === 0) return
  // Created exclusively: when two configurations call this for one session, one of them reminds.
  try {
    writeFileSync(remindedFile, `${new Date().toISOString()}\n`, { flag: 'wx' })
  } catch {
    return
  }
  const shown = problems.slice(0, AGENTS_REMINDER_PROBLEMS).map(({ file, line, message }) => `  - ${file ? `${file}${line ? `:${line}` : ''}: ` : ''}${message}`)
  if (problems.length > AGENTS_REMINDER_PROBLEMS) shown.push(`  - and ${problems.length - AGENTS_REMINDER_PROBLEMS} more`)
  const message = `this session changed the repository, and "${context.guard} handoff" does not pass yet:
${shown.join('\n')}
Finish the work and run handoff, or tell the user exactly what is left. (This reminder comes once per session.)`
  const { remind } = context.adapter
  if (!remind) return agentsRefuse(message)
  // This agent continues on its own JSON with exit code 0; the message on stderr is for its log.
  process.stdout.write(`${JSON.stringify(remind(`ResaLedger: ${message}`))}\n`)
  console.error(`✖ ResaLedger: ${message}`)
}

/**
 * A reader of the files committed at HEAD in a worktree: the rules come from there, so an agent
 * cannot lift one by editing the configuration without committing it.
 */
function agentsCommittedFile(root) {
  return (path) => agentsGit(root, ['show', `HEAD:${path}`])
}

/** The repository, its configuration and the session, for one hook call; null outside a repository. */
function agentsContext(session, adapter) {
  const cwd = typeof session.cwd === 'string' && session.cwd !== '' && existsSync(session.cwd) ? resolve(session.cwd) : process.cwd()
  const out = agentsGit(cwd, ['rev-parse', '--show-toplevel', '--git-common-dir'])
  if (out === null) return null
  const [top, common] = out.split('\n')
  const root = resolve(top)
  process.chdir(root)
  const loaded = loadConfig(agentsCommittedFile(root))
  const config = loaded.config
  const effective = config ?? { dir: DEFAULTS.dir, protected: [], agent: { deny: [], pushNeedsHandoff: false } }
  const key = typeof session.id === 'string' ? session.id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) : ''
  return {
    root,
    cwd,
    config: effective,
    loadedConfig: config,
    configProblems: loaded.problems,
    guard: `node ${effective.dir}/scripts/records.mjs`,
    commonDir: agentsRealPath(resolve(cwd, common)),
    // In the common git folder, shared by every worktree: a session that moves to another
    // worktree keeps its start, and so the worktree it started in.
    stateDir: key && !key.startsWith('.') ? resolve(cwd, common, 'resaledger', 'sessions') : null,
    sessionKey: key,
    adapter,
    worktrees: new Map(),
    switched: new Map(),
    // The last git command so far in this command line that changes the commits, the index or the checkout.
    changedBy: null
  }
}

/**
 * hook <agent> <event>: reads the agent's JSON (text) and applies the rules. Exits 2 with the
 * reason on stderr to refuse; returns, so exiting 0, to allow. Input it does not recognise,
 * an unknown agent or event, and a folder outside a repository are allowed.
 */
export function hookCommand(agent, event, text = '') {
  const adapter = Object.hasOwn(AGENT_ADAPTERS, agent ?? '') ? AGENT_ADAPTERS[agent] : null
  if (!adapter || !AGENT_EVENTS.includes(event)) {
    console.error(`resaledger: hook: unknown agent or event "${agent ?? ''} ${event ?? ''}"; use hook <${AGENT_NAMES.join('|')}> <${AGENT_EVENTS.join('|')}>. Allowed.`)
    return
  }
  let input
  try {
    input = JSON.parse(text)
  } catch {
    return
  }
  if (!agentsIsObject(input)) return
  let refusal = null
  try {
    const session = adapter.session ? adapter.session(input) : { id: input.session_id, cwd: input.cwd }
    const context = agentsContext(session, adapter)
    if (context === null) return
    if (event === 'session-start') return agentsSessionStart(context)
    if (event === 'stop') {
      context.config = context.loadedConfig
      return agentsStop(context)
    }
    // Cursor's cloud agents run no sessionStart hook, so their first shell call turns the git hooks on.
    if (adapter.turnsOnHooks?.(input) && !existsSync(agentsSessionFile(context, 'start') ?? '')) activateHooks()
    agentsRecordStart(context)
    const action = adapter.tool(input)
    if (action === null) return
    if (action.kind === 'shell') refusal = agentsShellRefusal(action.command, context, action.cwd ? resolve(context.cwd, agentsExpandHome(action.cwd)) : context.cwd)
    else if (action.kind === 'edit') refusal = agentsEditRefusal(action.paths.map((path) => resolve(context.cwd, agentsExpandHome(path))), context)
  } catch {
    return
  }
  if (refusal) agentsRefuse(refusal, adapter.deny ? adapter.deny(`ResaLedger: ${refusal}`) : null)
}

// The configurations that call the hook. The command lines never change between versions,
// because Codex asks the user to trust a hook again when its command changes. Claude Code,
// Codex and Gemini CLI group handlers under a matcher; Cursor and Copilot list the handlers
// themselves (flat) and take a "version" next to "hooks".

const AGENTS_TIMEOUTS = { 'session-start': 30, 'pre-tool': 20, stop: 60 }

const AGENT_CONFIGS = {
  claude: {
    file: '.claude/settings.json',
    handler: (dir, event) => ({ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/${dir}/scripts/records.mjs" hook claude ${event}`, timeout: AGENTS_TIMEOUTS[event] }),
    events: [
      { name: 'SessionStart', event: 'session-start' },
      { name: 'PreToolUse', event: 'pre-tool', matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit' },
      { name: 'Stop', event: 'stop' }
    ]
  },
  codex: {
    file: '.codex/hooks.json',
    // Codex runs hooks in the session's folder, so the command finds the repository's top first.
    handler: (dir, event) => ({ type: 'command', command: `node "$(git rev-parse --show-toplevel)/${dir}/scripts/records.mjs" hook codex ${event}`, timeout: AGENTS_TIMEOUTS[event] }),
    events: [
      { name: 'SessionStart', event: 'session-start' },
      { name: 'PreToolUse', event: 'pre-tool', matcher: 'Bash|apply_patch' },
      { name: 'Stop', event: 'stop' }
    ]
  },
  cursor: {
    file: '.cursor/hooks.json',
    flat: true,
    version: 1,
    // Cursor runs project hooks from the project's root. A hook that crashes or times out lets
    // the tool run unless failClosed is set; loop_limit 1 lets the reminder continue the agent once.
    handler: (dir, event) => ({ command: `node ${dir}/scripts/records.mjs hook cursor ${event}` }),
    events: [
      { name: 'sessionStart', event: 'session-start' },
      { name: 'beforeShellExecution', event: 'pre-tool', extra: { failClosed: true } },
      { name: 'preToolUse', event: 'pre-tool', extra: { failClosed: true } },
      { name: 'stop', event: 'stop', extra: { loop_limit: 1 } }
    ]
  },
  gemini: {
    file: '.gemini/settings.json',
    // Gemini CLI's timeouts are in milliseconds.
    handler: (dir, event) => ({ name: `resaledger-${event}`, type: 'command', command: `node "$GEMINI_PROJECT_DIR/${dir}/scripts/records.mjs" hook gemini ${event}`, timeout: AGENTS_TIMEOUTS[event] * 1000 }),
    events: [
      { name: 'SessionStart', event: 'session-start' },
      { name: 'BeforeTool', event: 'pre-tool', matcher: 'run_shell_command|write_file|replace' },
      { name: 'AfterAgent', event: 'stop' }
    ]
  },
  copilot: {
    file: '.github/hooks/resaledger.json',
    flat: true,
    version: 1,
    // The cloud agent runs only "bash"; the CLI may run hooks in a subfolder.
    handler: (dir, event) => ({ type: 'command', bash: `node "$(git rev-parse --show-toplevel)/${dir}/scripts/records.mjs" hook copilot ${event}`, timeoutSec: AGENTS_TIMEOUTS[event] }),
    events: [
      { name: 'sessionStart', event: 'session-start' },
      { name: 'preToolUse', event: 'pre-tool' },
      { name: 'agentStop', event: 'stop' }
    ]
  }
}

/** The configuration file an agent's hooks live in, relative to the repository root. */
export function agentConfigFile(agent) {
  return AGENT_CONFIGS[agent].file
}

/** True when a hook command is ResaLedger's: it runs records.mjs hook, in 1.0's form or 0.3's. */
export function isLedgerHookCommand(command) {
  return typeof command === 'string' && /scripts\/records\.mjs\\?"?\s+hook\b/.test(command)
}

/** True when a handler, grouped or flat, runs ResaLedger's hook command. */
function agentsOwnHandler(handler) {
  return agentsIsObject(handler) && (isLedgerHookCommand(handler.command) || isLedgerHookCommand(handler.bash))
}

/** ResaLedger's entries for an agent: { EventName: matcher group }, or { EventName: handler } for a flat one. */
export function agentHookEntries(agent, dir) {
  const { handler, events, flat } = AGENT_CONFIGS[agent]
  const entries = {}
  for (const { name, event, matcher, extra } of events) {
    entries[name] = flat ? { ...handler(dir, event), ...extra } : { ...(matcher ? { matcher } : {}), hooks: [handler(dir, event)] }
  }
  return entries
}

// Gemini CLI reads GEMINI.md unless context.fileName names other files, so the list keeps
// GEMINI.md and adds AGENTS.md.
const GEMINI_CONTEXT_FILES = ['AGENTS.md', 'GEMINI.md']

/** The JSON to add by hand, for a file the merge cannot read. */
export function agentConfigSnippet(agent, dir) {
  const { version } = AGENT_CONFIGS[agent]
  const entries = agentHookEntries(agent, dir)
  const context = agent === 'gemini' ? { context: { fileName: GEMINI_CONTEXT_FILES } } : {}
  return JSON.stringify({ ...(version ? { version } : {}), ...context, hooks: Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, [entry]])) }, null, 2)
}

/**
 * Makes Gemini CLI's context.fileName include AGENTS.md, keeping the other keys and the file
 * names already listed. Changes settings in place; returns an error text, or null.
 */
function geminiWithAgentsFile(settings) {
  if ('context' in settings && !agentsIsObject(settings.context)) return 'has a "context" value that is not an object'
  const context = settings.context ?? {}
  const names = context.fileName
  if (names === undefined) context.fileName = [...GEMINI_CONTEXT_FILES]
  else if (typeof names === 'string') context.fileName = names === 'AGENTS.md' ? names : [names, 'AGENTS.md']
  else if (Array.isArray(names) && names.every((name) => typeof name === 'string')) {
    if (!names.includes('AGENTS.md')) names.push('AGENTS.md')
  } else return 'has a "context.fileName" value that is neither a file name nor a list of them'
  settings.context = context
  return null
}

/** An entry under an event without ResaLedger's handlers: { own, rest }, rest null when nothing is left. */
function agentsWithoutOwn(entry, flat) {
  if (flat) return agentsOwnHandler(entry) ? { own: true, rest: null } : { own: false, rest: entry }
  const handlers = agentsIsObject(entry) && Array.isArray(entry.hooks) ? entry.hooks : []
  const others = handlers.filter((handler) => !agentsOwnHandler(handler))
  if (others.length === handlers.length) return { own: false, rest: entry }
  return { own: true, rest: others.length > 0 ? { ...entry, hooks: others } : null }
}

/**
 * Merges ResaLedger's entries into an agent's configuration text (null when the file is
 * missing). Only handlers whose command is ResaLedger's are added, replaced or removed;
 * everything else keeps its meaning and its order. Gemini CLI's context.fileName also gets
 * AGENTS.md. Returns { text, changed } or { error }.
 */
export function mergeAgentConfig(agent, text, dir) {
  const { flat, version } = AGENT_CONFIGS[agent]
  let settings = {}
  if (text !== null && text !== undefined && text.trim() !== '') {
    try {
      settings = JSON.parse(text)
    } catch (error) {
      return { error: `is not valid JSON (${error.message})` }
    }
  }
  if (!agentsIsObject(settings)) return { error: 'is not a JSON object' }
  const before = JSON.stringify(settings, null, 2)
  if ('hooks' in settings && !agentsIsObject(settings.hooks)) return { error: 'has a "hooks" value that is not an object' }
  if (agent === 'gemini') {
    const problem = geminiWithAgentsFile(settings)
    if (problem) return { error: problem }
  }
  const hooks = settings.hooks ?? {}
  const entries = agentHookEntries(agent, dir)
  for (const name of Object.keys(entries)) {
    if (name in hooks && !Array.isArray(hooks[name])) return { error: `has a "hooks.${name}" value that is not an array` }
  }
  const positions = {}
  for (const name of Object.keys(hooks)) {
    if (!Array.isArray(hooks[name])) continue
    const kept = []
    let removed = false
    for (const entry of hooks[name]) {
      const { own, rest } = agentsWithoutOwn(entry, flat)
      if (!own) {
        kept.push(entry)
        continue
      }
      removed = true
      positions[name] ??= kept.length
      if (rest !== null) kept.push(rest)
    }
    if (removed && kept.length === 0 && !(name in entries)) delete hooks[name]
    else hooks[name] = kept
  }
  for (const [name, entry] of Object.entries(entries)) {
    const list = hooks[name] ?? []
    list.splice(positions[name] ?? list.length, 0, entry)
    hooks[name] = list
  }
  // A new file starts with the format's version; an existing one keeps its own.
  if (version && !('version' in settings)) settings = { version, ...settings }
  settings.hooks = hooks
  const after = JSON.stringify(settings, null, 2)
  return { text: `${after}\n`, changed: after !== before || text === null || text === undefined }
}

/** True when an agent's configuration file holds ResaLedger's hook command, even as invalid JSON. */
export function agentConfigured(root, agent) {
  try {
    return isLedgerHookCommand(readFileSync(resolve(root, agentConfigFile(agent)), 'utf8'))
  } catch {
    return false
  }
}

/** The agents in use in a repository: their folder or instruction file exists. */
export function detectAgents(root) {
  const found = []
  if (existsSync(resolve(root, '.claude')) || existsSync(resolve(root, 'CLAUDE.md'))) found.push('claude')
  if (existsSync(resolve(root, '.codex'))) found.push('codex')
  if (existsSync(resolve(root, '.cursor')) || existsSync(resolve(root, '.cursorrules'))) found.push('cursor')
  if (existsSync(resolve(root, '.gemini')) || existsSync(resolve(root, 'GEMINI.md'))) found.push('gemini')
  const copilot = ['.github/copilot-instructions.md', '.github/instructions', '.github/copilot', '.github/hooks']
  if (copilot.some((path) => existsSync(resolve(root, path)))) found.push('copilot')
  return found
}
