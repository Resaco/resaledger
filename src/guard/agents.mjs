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
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { DEFAULTS, loadConfig } from './config.mjs'
import { handoffProblems } from './handoff.mjs'
import { currentLane } from './lanes.mjs'

export const AGENT_NAMES = Object.freeze(['claude', 'codex'])
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

const AGENT_ADAPTERS = {
  claude: {
    tool(input) {
      const args = input.tool_input
      if (!agentsIsObject(args)) return null
      if (input.tool_name === 'Bash') return typeof args.command === 'string' ? { kind: 'shell', command: args.command } : null
      if (['Edit', 'Write', 'MultiEdit'].includes(input.tool_name)) return typeof args.file_path === 'string' ? { kind: 'edit', paths: [args.file_path] } : null
      if (input.tool_name === 'NotebookEdit') return typeof args.notebook_path === 'string' ? { kind: 'edit', paths: [args.notebook_path] } : null
      return null
    }
  },
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

/** The refusal for a git command, or null. context holds the configuration and the folder it runs in. */
function agentsGitRefusal(args, context, cwd) {
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
  if (settings.some((setting) => AGENTS_HOOKS_PATH.test(setting.split('=')[0]))) {
    return 'this git command changes core.hooksPath for its run, which turns the git hooks off. The hooks stay on; fix what they report instead'
  }
  const sub = args[index]
  if (sub === undefined) return null
  const { options, positionals } = agentsGitArguments(sub, args.slice(index + 1))

  if (options.some((option) => AGENTS_NO_VERIFY.test(option)) || (sub === 'commit' && agentsCommitSkipsHooks(options))) {
    return `"git ${sub}" with --no-verify skips the git hooks. Never bypass them: fix what the hook reports, or tell the user what blocks you`
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
  }
  return null
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
    return resolve(realpathSync(existing), ...rest)
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

function agentsBranchAt(context, folder) {
  return agentsWorktreeOf(context, folder)?.branch ?? null
}

/** The refusal for file edits at the given absolute paths, or null. */
function agentsEditRefusal(paths, context) {
  for (const path of paths) {
    if (path.startsWith('/dev/')) continue
    const real = agentsRealPath(path)
    const worktree = agentsWorktreeOf(context, resolve(real, '..'))
    if (!worktree || !worktree.branch || !context.config.protected.includes(worktree.branch)) continue
    const inside = relative(worktree.top, real).replace(/\\/g, '/')
    if (inside === '' || inside.startsWith('../') || inside === '..' || inside === '.git' || inside.startsWith('.git/')) continue
    const ignored = spawnSync('git', ['-C', worktree.top, 'check-ignore', '-q', '--', inside], { stdio: 'ignore' })
    if (ignored.status === 0) continue
    return `"${worktree.branch}" is a protected branch, so files are not edited on it (${inside}). Work in a lane branch: "${context.guard} claim <id>" creates one, or "git switch -c <branch>"`
  }
  return null
}

/** The refusal for a shell command, or null. */
function agentsShellRefusal(text, context) {
  const commands = shellCommands(text)
  let cwd = context.cwd
  const edits = []
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
    for (const path of agentsWrittenPaths(command)) edits.push(resolve(cwd, agentsExpandHome(path)))
    if (program === 'cd' && command.depth === 0 && command.words[1] && !command.words[1].dynamic) cwd = resolve(cwd, agentsExpandHome(command.args[1]))
  }
  if (context.config.agent.deny.length > 0) {
    const top = commands.filter((command) => command.depth === 0)
    const texts = [top.map((command) => `${agentsRenderCommand(command)}${command.separator && command.separator !== ';' ? ` ${command.separator}` : command.separator}`).join(' ').trim(), ...commands.map(agentsRenderCommand)]
    for (const rule of context.config.agent.deny) {
      const regex = rule.regex ?? new RegExp(rule.pattern)
      if (texts.some((candidate) => regex.test(candidate))) {
        return `this command matches the project's agent.deny rule ${JSON.stringify(rule.pattern)}${rule.reason ? `: ${rule.reason}` : ''}`
      }
    }
  }
  return agentsEditRefusal(edits, context)
}

// Session state, under the git folder: one file per session id.

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

/** Records where the session started, unless it is recorded already. */
function agentsRecordStart(context) {
  const file = agentsSessionFile(context, 'start')
  if (!file || existsSync(file)) return
  try {
    mkdirSync(context.stateDir, { recursive: true })
    writeFileSync(file, `${JSON.stringify(agentsSnapshot(context.root))}\n`, { flag: 'wx' })
  } catch {}
}

/** Removes the state of sessions older than AGENTS_SESSION_DAYS. */
function agentsPruneSessions(context) {
  if (!context.stateDir || !existsSync(context.stateDir)) return
  const limit = Date.now() - AGENTS_SESSION_DAYS * 24 * 60 * 60 * 1000
  for (const name of readdirSync(context.stateDir)) {
    const path = resolve(context.stateDir, name)
    try {
      if (statSync(path).mtimeMs < limit) unlinkSync(path)
    } catch {}
  }
}

/** Prints the refusal and stops with exit code 2. */
function agentsRefuse(message) {
  console.error(`✖ ResaLedger: ${message}`)
  process.exit(2)
}

function agentsSessionStart(context) {
  agentsRecordStart(context)
  agentsPruneSessions(context)
  // work turns the git hooks on, and its output becomes the agent's context.
  const result = spawnSync(process.execPath, [process.argv[1], 'work'], { cwd: context.root, encoding: 'utf8', timeout: AGENTS_WORK_TIMEOUT })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stdout.write(result.stderr)
}

function agentsStop(context) {
  const startFile = agentsSessionFile(context, 'start')
  if (!startFile) return
  let start
  try {
    start = JSON.parse(readFileSync(startFile, 'utf8'))
  } catch {
    // No record of the start: the session's changes are unknown, so it starts now.
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
  agentsRefuse(`this session changed the repository, and "${context.guard} handoff" does not pass yet:
${shown.join('\n')}
Finish the work and run handoff, or tell the user exactly what is left. (This reminder comes once per session.)`)
}

/** The repository, its configuration and the session, for one hook call; null outside a repository. */
function agentsContext(session) {
  const cwd = typeof session.cwd === 'string' && session.cwd !== '' && existsSync(session.cwd) ? resolve(session.cwd) : process.cwd()
  const out = agentsGit(cwd, ['rev-parse', '--show-toplevel', '--git-common-dir', '--git-path', 'resaledger/sessions'])
  if (out === null) return null
  const [top, common, state] = out.split('\n')
  const root = resolve(top)
  process.chdir(root)
  const loaded = loadConfig((path) => {
    try {
      return readFileSync(resolve(root, path), 'utf8')
    } catch {
      return null
    }
  })
  const config = loaded.config
  const effective = config ?? { dir: DEFAULTS.dir, protected: [], agent: { deny: [] } }
  const key = typeof session.id === 'string' ? session.id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) : ''
  return {
    root,
    cwd,
    config: effective,
    loadedConfig: config,
    configProblems: loaded.problems,
    guard: `node ${effective.dir}/scripts/records.mjs`,
    commonDir: agentsRealPath(resolve(cwd, common)),
    stateDir: key && !key.startsWith('.') ? resolve(cwd, state) : null,
    sessionKey: key,
    worktrees: new Map()
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
    const context = agentsContext(session)
    if (context === null) return
    if (event === 'session-start') return agentsSessionStart(context)
    if (event === 'stop') {
      context.config = context.loadedConfig
      return agentsStop(context)
    }
    agentsRecordStart(context)
    const action = adapter.tool(input)
    if (action === null) return
    if (action.kind === 'shell') refusal = agentsShellRefusal(action.command, context)
    else if (action.kind === 'edit') refusal = agentsEditRefusal(action.paths.map((path) => resolve(context.cwd, agentsExpandHome(path))), context)
  } catch {
    return
  }
  if (refusal) agentsRefuse(refusal)
}

// The configurations that call the hook. The command lines never change between versions,
// because Codex asks the user to trust a hook again when its command changes.

const AGENT_CONFIGS = {
  claude: {
    file: '.claude/settings.json',
    command: (dir, event) => `node "$CLAUDE_PROJECT_DIR/${dir}/scripts/records.mjs" hook claude ${event}`,
    events: [
      { name: 'SessionStart', event: 'session-start' },
      { name: 'PreToolUse', event: 'pre-tool', matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit' },
      { name: 'Stop', event: 'stop' }
    ]
  },
  codex: {
    file: '.codex/hooks.json',
    // Codex runs hooks in the session's folder, so the command finds the repository's top first.
    command: (dir, event) => `node "$(git rev-parse --show-toplevel)/${dir}/scripts/records.mjs" hook codex ${event}`,
    events: [
      { name: 'SessionStart', event: 'session-start' },
      { name: 'PreToolUse', event: 'pre-tool', matcher: 'Bash|apply_patch' },
      { name: 'Stop', event: 'stop' }
    ]
  }
}
const AGENTS_TIMEOUTS = { 'session-start': 30, 'pre-tool': 20, stop: 60 }

/** The configuration file an agent's hooks live in, relative to the repository root. */
export function agentConfigFile(agent) {
  return AGENT_CONFIGS[agent].file
}

/** True when a hook command is ResaLedger's: it runs records.mjs hook, in 1.0's form or 0.3's. */
export function isLedgerHookCommand(command) {
  return typeof command === 'string' && /scripts\/records\.mjs\\?"?\s+hook\b/.test(command)
}

/** ResaLedger's entries for an agent: { EventName: matcher group }. */
export function agentHookEntries(agent, dir) {
  const { command, events } = AGENT_CONFIGS[agent]
  const entries = {}
  for (const { name, event, matcher } of events) {
    entries[name] = { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: command(dir, event), timeout: AGENTS_TIMEOUTS[event] }] }
  }
  return entries
}

/** The JSON to add by hand under "hooks", for a file the merge cannot read. */
export function agentConfigSnippet(agent, dir) {
  const entries = agentHookEntries(agent, dir)
  return JSON.stringify({ hooks: Object.fromEntries(Object.entries(entries).map(([name, group]) => [name, [group]])) }, null, 2)
}

/**
 * Merges ResaLedger's entries into an agent's configuration text (null when the file is
 * missing). Only handlers whose command is ResaLedger's are added, replaced or removed;
 * everything else keeps its meaning and its order. Returns { text, changed } or { error }.
 */
export function mergeAgentConfig(agent, text, dir) {
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
    for (const group of hooks[name]) {
      const handlers = agentsIsObject(group) && Array.isArray(group.hooks) ? group.hooks : null
      const own = handlers ? handlers.filter((handler) => agentsIsObject(handler) && isLedgerHookCommand(handler.command)) : []
      if (own.length === 0) {
        kept.push(group)
        continue
      }
      removed = true
      positions[name] ??= kept.length
      const others = handlers.filter((handler) => !own.includes(handler))
      if (others.length > 0) kept.push({ ...group, hooks: others })
    }
    if (removed && kept.length === 0 && !(name in entries)) delete hooks[name]
    else hooks[name] = kept
  }
  for (const [name, group] of Object.entries(entries)) {
    const list = hooks[name] ?? []
    list.splice(positions[name] ?? list.length, 0, group)
    hooks[name] = list
  }
  settings.hooks = hooks
  const after = JSON.stringify(settings, null, 2)
  return { text: `${after}\n`, changed: after !== before || text === null || text === undefined }
}

/** The agents in use in a repository: their folder or instruction file exists. */
export function detectAgents(root) {
  const found = []
  if (existsSync(resolve(root, '.claude')) || existsSync(resolve(root, 'CLAUDE.md'))) found.push('claude')
  if (existsSync(resolve(root, '.codex'))) found.push('codex')
  return found
}
