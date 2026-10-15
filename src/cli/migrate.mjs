// `resaledger migrate`: converts an agent-ledger 0.x workspace to the 1.0 format in place
// (spec section 14). planMigration() only reads: it builds every new file in memory, checks
// that no line of the old records is lost, rewrites links into the removed files and
// validates the result with the guard's own modules. applyMigration() writes the plan.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_FILE, parseConfig } from '../guard/config.mjs'
import { slugify, taskFileName } from '../guard/tasks.mjs'
import { checkWorkspace, loadWorkspace } from '../guard/workspace.mjs'
import { HOOK_NAMES, renderHook } from './hooks.mjs'
import {
  LEGACY_CONFIG_FILE,
  LEGACY_FILES,
  LEGACY_TASK_FIELDS,
  legacyManualGates,
  legacyProjectRules,
  legacyTableCells,
  lostLegacyLines,
  readLegacyWorkspace
} from './legacy.mjs'

export const PACKAGE_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
export const BUILT_GUARD = join(PACKAGE_ROOT, 'dist', 'records.mjs')
const AGENTS_BLOCK = new URL('../../templates/agents-block.md', import.meta.url)

const HOOKS_FOLDER = '.githooks'
const MANAGED_START = '<!-- resaledger:start'
const MANAGED_END = '<!-- resaledger:end -->'
const POINTER_START = '<!-- agent-ledger:start -->'
const POINTER_END = '<!-- agent-ledger:end -->'
const UNION_COMMENT = '# agent-ledger: records that only grow at the end merge without conflicts'
const LEGACY_MARKER = 'TODO(agent-ledger)'
const MARKER = 'TODO(resaledger)'
const EMPTY_VALUES = new Set(['', '—', '–', '-'])
const MARKDOWN = /\.(md|markdown)$/i
const LEGACY_FIELD = /^- ([A-Z][\p{L}]*(?: [\p{L}]+)*):(?:[ \t]+(.*))?$/u
const DATE = /^\d{4}-\d{2}-\d{2}$/

export const COMMIT_COMMAND = 'git add -A && git commit -m "chore: migrate to ResaLedger 1.0" -m "Task: maintenance"'
export const UNDO_COMMAND = 'git restore . && git clean -fd'

// The sections of the 0.x workspace templates (identical in 0.1, 0.2 and 0.3). A section with
// another name is the project's own and moves; the template's own are kept in the log entry.
const STANDARDS_TEMPLATE_SECTIONS = ['Who owns what', 'STATUS.md', 'The task ledger', 'Plans', 'Commits', 'Quality gates']
const AGENTS_TEMPLATE_SECTIONS = ['Start here, every session', 'Session protocol', 'Non-negotiables', 'Project rules', 'Orchestrated work', 'Working agreements']

// The git hooks that agent-ledger 0.1, 0.2 and 0.3 wrote, with {{dir}} for the workspace folder.
function legacyHook(comment, fix, call, what) {
  return `#!/bin/sh
# agent-ledger: ${comment}
# Do not bypass with --no-verify; ${fix}
for runtime in node bun "$HOME/.bun/bin/bun" /opt/homebrew/bin/node /usr/local/bin/node; do
  if command -v "$runtime" >/dev/null 2>&1; then
    exec "$runtime" {{dir}}/scripts/records.mjs ${call}
  fi
done
echo "agent-ledger: neither node nor bun was found, so this ${what} cannot be checked" >&2
exit 1
`
}

const LEGACY_HOOKS = {
  'pre-commit': [
    legacyHook('Shape of the records, and the commit gates when code changes ({{dir}}/standards.md).', 'fix the records or the code instead.', 'pre-commit', 'commit'),
    legacyHook('Shape of the project records on every commit ({{dir}}/standards.md#who-owns-what).', 'fix the records instead.', 'check', 'commit')
  ],
  'commit-msg': [legacyHook('Commit header and task trailer ({{dir}}/standards.md#commits).', 'fix the message or the ledger instead.', 'commit-msg "$1"', 'commit')],
  'pre-push': [legacyHook('No pushes straight to a protected branch (.agent-ledger.json).', 'push your branch and open a pull request.', 'pre-push "$@"', 'push')]
}

// The pointer blocks that 0.x added to the root AGENTS.md and CLAUDE.md.
const LEGACY_POINTERS = [
  `${POINTER_START}
## Build workspace

The build in this repository is run from [\`{{dir}}/\`]({{dir}}/README.md). Before any work, read [\`{{dir}}/AGENTS.md\`]({{dir}}/AGENTS.md) and [\`{{dir}}/STATUS.md\`]({{dir}}/STATUS.md), then run \`{{guard}} work\`. Before you stop, run \`{{guard}} handoff\`.
${POINTER_END}`,
  `${POINTER_START}
## Repository guard

Git hooks check every commit and push in this repository. Turn them on once per clone: \`git config core.hooksPath .githooks\`. \`{{guard}} work\` shows where the clone stands and which rules apply. Before you stop, run \`{{guard}} handoff\`. Never bypass a hook with \`--no-verify\`.
${POINTER_END}`
]

// ── Small helpers ─────────────────────────────────────────────────────────────────────

/** Runs git in the repository; returns { status, stdout, stderr }. */
function runGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) throw result.error
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function gitOut(root, args) {
  const result = runGit(root, args)
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`)
  return result.stdout
}

/** The lines of a text as legacy.mjs reads them: BOM dropped, CRLF as LF, no line after a final newline. */
function sourceLines(text) {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Lines without the blank lines at either end. */
function trimBlankLines(lines) {
  let start = 0
  let end = lines.length
  while (start < end && !lines[start].trim()) start += 1
  while (end > start && !lines[end - 1].trim()) end -= 1
  return lines.slice(start, end)
}

function isEmptyLegacyValue(value) {
  return EMPTY_VALUES.has(String(value ?? '').trim())
}

/** Today's date in the local time zone, as YYYY-MM-DD. */
export function localDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Text in a fenced block that no line of it can close: the fence is longer than any backtick run inside. */
function fenced(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${text}\n${fence}`
}

/** A minimal line diff: unchanged lines with two spaces, removed with "- ", added with "+ ". */
export function lineDiff(before, after) {
  const a = sourceLines(before)
  const b = sourceLines(after)
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
  const out = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`  ${a[i]}`)
      i += 1
      j += 1
    } else if (i < a.length && (j === b.length || table[i + 1][j] >= table[i][j + 1])) {
      out.push(`- ${a[i]}`)
      i += 1
    } else {
      out.push(`+ ${b[j]}`)
      j += 1
    }
  }
  return out.join('\n')
}

/** A path no file has, tracked, planned or on disk: the candidate, or it with -2, -3 … before .md. */
function uniquePath(root, taken, candidate) {
  let path = candidate
  for (let count = 2; taken.has(path) || existsSync(join(root, path)); count += 1) path = candidate.replace(/\.md$/, `-${count}.md`)
  taken.add(path)
  return path
}

/** The first sentence of a decision as its title: at most 100 characters, cut at a word. */
function decisionTitle(text) {
  const sentence = (text.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? text).replace(/[.]$/, '').trim()
  if ([...sentence].length <= 100) return sentence || 'Decision'
  const cut = sentence.slice(0, 99)
  const space = cut.lastIndexOf(' ')
  return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '')}…`
}

// ── Links ─────────────────────────────────────────────────────────────────────────────

const INLINE_LINK =
  /!?\[((?:[^[\]\\]|\\.|\[[^\]]*\])*)\]\(\s*(<[^<>\n]*>|[^\s()<>]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/dg
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:[ \t]*(<[^<>\n]*>|\S+)/d
const LINK_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** For each line, whether it is inside a fenced code block, fence lines included. */
function fencedLines(lines) {
  const result = []
  let open = null
  for (const line of lines) {
    if (open) {
      result.push(true)
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
      if (close && close[1][0] === open[0] && close[1].length >= open.length) open = null
      continue
    }
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      open = fence[1]
      result.push(true)
    } else result.push(false)
  }
  return result
}

/** A line with its inline code spans blanked out, at the same length. */
function maskCodeSpans(line) {
  let result = ''
  let rest = line
  for (;;) {
    const open = rest.match(/`+/)
    if (!open) return result + rest
    const after = rest.slice(open.index + open[0].length)
    const close = after.match(new RegExp(`(?<!\`)${open[0]}(?!\`)`))
    if (!close) return result + rest
    const end = open.index + open[0].length + close.index + open[0].length
    result += rest.slice(0, open.index) + ' '.repeat(end - open.index)
    rest = rest.slice(end)
  }
}

/** The link targets of a text outside code, as { line, start, end, raw } with 0-based lines. */
function linkTargets(text) {
  const lines = text.split('\n')
  const isFenced = fencedLines(lines.map((line) => line.replace(/\r$/, '')))
  const targets = []
  lines.forEach((line, index) => {
    if (isFenced[index]) return
    const masked = maskCodeSpans(line.replace(/\r$/, ''))
    for (const match of masked.matchAll(INLINE_LINK)) {
      const [start, end] = match.indices[2]
      if (end > start) targets.push({ line: index, start, end, raw: line.slice(start, end) })
    }
    const definition = masked.match(REFERENCE_DEFINITION)
    if (definition) {
      const [start, end] = definition.indices[1]
      targets.push({ line: index, start, end, raw: line.slice(start, end) })
    }
  })
  return targets
}

/** The text with every link target replaced by a placeholder: what a link rewrite may not change. */
function maskLinkTargets(text) {
  const lines = text.split('\n')
  for (const target of linkTargets(text).reverse()) {
    const line = lines[target.line]
    lines[target.line] = `${line.slice(0, target.start)}\u0000${line.slice(target.end)}`
  }
  return lines.join('\n')
}

function decodePath(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** The repository path a link in fromFile points to, or null when it leaves the repository. */
function resolveTarget(fromFile, path) {
  const joined = path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(fromFile), path)
  const resolved = posix.normalize(joined || '.').replace(/(.)\/+$/, '$1')
  if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) return null
  return resolved
}

/**
 * Rewrites the links of one piece of text. frame is the file the text was written in (its
 * links are relative to it), dest the file it is written to now. mapTarget(path, anchor)
 * returns null for a target that stays, { path, anchor, folder, note } for a new one, or
 * { unresolved } when there is none. Returns { text, links } with every changed or listed link.
 */
function rewriteLinks(text, frame, dest, mapTarget) {
  const lines = text.split('\n')
  const links = []
  for (const target of linkTargets(text).reverse()) {
    const angle = target.raw.startsWith('<')
    const value = angle ? target.raw.slice(1, -1) : target.raw
    if (!value || value.startsWith('//') || LINK_SCHEME.test(value)) continue
    const hash = value.indexOf('#')
    const rawPath = hash === -1 ? value : value.slice(0, hash)
    const anchor = hash === -1 ? '' : decodePath(value.slice(hash + 1))
    if (rawPath === '' && frame === dest) continue
    const resolved = rawPath === '' ? frame : resolveTarget(frame, decodePath(rawPath))
    if (resolved === null) continue
    const mapped = mapTarget(resolved, anchor)
    if (mapped && mapped.unresolved) {
      links.push({ file: dest, line: target.line + 1, target: value, unresolved: mapped.unresolved })
      continue
    }
    if (!mapped && frame === dest) continue
    const path = mapped ? mapped.path : resolved
    const newAnchor = mapped ? mapped.anchor : anchor
    let relativePath
    if (rawPath.startsWith('/')) relativePath = `/${path}`
    else {
      relativePath = posix.relative(posix.dirname(dest), path) || '.'
      if (mapped?.folder || relativePath === '.' || (!mapped && rawPath.endsWith('/'))) relativePath = `${relativePath.replace(/\/$/, '')}/`
    }
    if (!angle) relativePath = relativePath.replace(/ /g, '%20')
    const rewritten = `${relativePath}${newAnchor ? `#${newAnchor}` : ''}`
    const replacement = angle ? `<${rewritten}>` : rewritten
    if (replacement === target.raw) continue
    const line = lines[target.line]
    lines[target.line] = `${line.slice(0, target.start)}${replacement}${line.slice(target.end)}`
    if (mapped) links.push({ file: dest, line: target.line + 1, target: value, rewritten, note: mapped.note ?? null })
  }
  return { text: lines.join('\n'), links: links.reverse() }
}

// ── The plan ──────────────────────────────────────────────────────────────────────────

/** A reader over the planned tree, in the shape of treeReader(): the files that stay plus the planned ones. */
function plannedReader(root, files, contents) {
  const folders = new Set([''])
  for (const path of files) for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) folders.add(path.slice(0, slash))
  const sorted = [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const key = (path) => String(path).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  return {
    list(prefix = '') {
      const folder = key(prefix)
      const start = folder === '' ? '' : `${folder}/`
      return sorted.filter((path) => path.startsWith(start))
    },
    read(path) {
      const name = key(path)
      if (!files.has(name)) return null
      if (contents.has(name)) return contents.get(name)
      try {
        return readFileSync(join(root, name), 'utf8')
      } catch {
        return null
      }
    },
    exists(path) {
      const name = key(path)
      return files.has(name) || folders.has(name)
    }
  }
}

/** The repository-relative path a file really is, following a link inside the repository; null outside it. */
function realRelative(root, path) {
  const full = join(root, path)
  if (!existsSync(full)) return path
  if (!lstatSync(full).isSymbolicLink()) return path
  const real = realpathSync(full)
  const inside = relative(realpathSync(root), real)
  if (inside.startsWith('..') || resolve(inside) === inside) return null
  return inside.split(/[\\/]/).join('/')
}

function sameFile(root, a, b) {
  try {
    const one = statSync(join(root, a))
    const two = statSync(join(root, b))
    return one.ino === two.ino && one.dev === two.dev
  } catch {
    return false
  }
}

/** Removes every 0.x pointer block; returns the text without them and the blocks removed, with their line. */
function removePointers(text) {
  const lines = sourceLines(text)
  const blocks = []
  for (;;) {
    const start = lines.findIndex((line) => line.trim() === POINTER_START)
    if (start === -1) break
    let end = lines.findIndex((line, index) => index > start && line.trim() === POINTER_END)
    if (end === -1) end = start
    blocks.push({ text: lines.slice(start, end + 1).join('\n'), at: start })
    lines.splice(start, end - start + 1)
  }
  return { lines, blocks }
}

/** Collapses runs of blank lines into one and drops blank lines at the end. */
function tidyLines(lines) {
  const out = []
  for (const line of lines) {
    if (!line.trim() && (out.length === 0 || !out[out.length - 1].trim())) continue
    out.push(line)
  }
  while (out.length > 0 && !out[out.length - 1].trim()) out.pop()
  return out
}

/** The current branch, or null in a detached HEAD. */
function currentBranch(root) {
  const result = runGit(root, ['symbolic-ref', '--short', '-q', 'HEAD'])
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null
}

/** The 1.0 configuration for a 0.x one, and the keys that have no 1.0 meaning. */
export function convertConfig(legacy) {
  const config = { version: 2, dir: legacy.dir }
  const unmapped = {}
  const known = new Set(['version', 'mode', 'dir', 'aiAttribution', 'codePaths', 'gates', 'commitStyle', 'branches', 'requirePushed', 'agent'])
  if ('aiAttribution' in legacy) config.aiAttribution = legacy.aiAttribution
  if ('commitStyle' in legacy) config.commitStyle = legacy.commitStyle
  if ('codePaths' in legacy) config.codePaths = legacy.codePaths
  const section = (name, keys, convert) => {
    if (!(name in legacy)) return
    const value = legacy[name]
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      unmapped[name] = value
      return
    }
    for (const [key, item] of Object.entries(value)) {
      if (keys.includes(key)) convert(key, item)
      else unmapped[`${name}.${key}`] = item
    }
  }
  section('branches', ['protected', 'pattern'], (key, value) => {
    config[key === 'protected' ? 'protected' : 'branchPattern'] = value
  })
  if ('requirePushed' in legacy) config.requirePushed = legacy.requirePushed
  section('gates', ['commit', 'verify'], (key, value) => {
    config.gates ??= {}
    config.gates[key] = value
  })
  section('agent', ['deny'], (key, value) => {
    config.agent = { deny: value }
  })
  for (const [key, value] of Object.entries(legacy)) if (!known.has(key)) unmapped[key] = value
  return { config, unmapped }
}

/**
 * Plans the migration of the 0.x workspace in the repository at root. Reads only.
 * options: { force, today, lane, guardPath, testDropLine } (testDropLine drops one line from
 * the planned files before the content check, for the test that proves a loss is caught).
 * Returns { writes, deletes, renames, executable, logEntry, report, problems, refusals }:
 * writes is a Map of path → text, problems the 1.0 problems of the result, refusals the
 * reasons it cannot run at all. Paths are POSIX and relative to root.
 */
export function planMigration(root, options = {}) {
  const plan = {
    writes: new Map(),
    deletes: [],
    renames: [],
    executable: new Set(),
    logEntry: null,
    report: { created: [], changed: [], deleted: [], renamed: [], warnings: [], links: [], unmappedKeys: [], counts: {} },
    problems: [],
    refusals: []
  }
  const refuse = (message, detail = '') => plan.refusals.push({ message, detail })

  // 1. What stops it before anything is read.
  if (existsSync(join(root, CONFIG_FILE))) {
    refuse(`${CONFIG_FILE} exists: this repository is already migrated to ResaLedger 1.0`)
    return plan
  }
  const status = runGit(root, ['status', '--porcelain'])
  if (status.status !== 0) {
    refuse(`git status failed: ${status.stderr.trim()}`)
    return plan
  }
  if (status.stdout.trim()) {
    const lines = status.stdout.trimEnd().split('\n')
    refuse('the working tree has uncommitted changes; commit or stash them first, so the migration is one reviewable change', lines.slice(0, 20).join('\n') + (lines.length > 20 ? `\n… and ${lines.length - 20} more` : ''))
  }
  const legacy = readLegacyWorkspace(root)
  for (const item of legacy.problems) {
    if (item.file === LEGACY_CONFIG_FILE) refuse(`${item.file}: ${item.message}`)
    else if (/^(is missing|the workspace folder is missing)$/.test(item.message)) refuse(`${item.file}: ${item.message}; every 0.x workspace has it, so migrate cannot convert this one`)
    else plan.report.warnings.push(`${item.file}${item.line ? `:${item.line}` : ''}: ${item.message}`)
  }
  const dir = legacy.dir
  if (dir) {
    for (const name of HOOK_NAMES) {
      const path = `${HOOKS_FOLDER}/${name}`
      if (!existsSync(join(root, path))) continue
      const text = readFileSync(join(root, path), 'utf8').replace(/\r\n?/g, '\n')
      const known = (LEGACY_HOOKS[name] ?? []).map((template) => template.replaceAll('{{dir}}', dir))
      if (known.some((template) => template.trimEnd() === text.trimEnd()) || renderHook(name, dir).trimEnd() === text.trimEnd()) continue
      if (options.force) plan.report.warnings.push(`${path} was changed by hand; --force replaces it with the 1.0 hook`)
      else refuse(`${path} differs from the hook agent-ledger 0.x wrote, so it was changed by hand; move the change elsewhere, or run again with --force to replace it`, lineDiff(known[0], text))
    }
  }
  const guardPath = options.guardPath ?? BUILT_GUARD
  if (!existsSync(guardPath)) refuse(`the built guard ${guardPath} is missing; build it with "node scripts/bundle.mjs"`)
  if (plan.refusals.length > 0) return plan

  // 2. The new files, as pieces of text with the file their links are relative to.
  const today = options.today ?? localDate()
  const lane = options.lane === undefined ? currentBranch(root) : options.lane
  const tracked = new Set(gitOut(root, ['ls-files', '-z']).split('\0').filter(Boolean))
  const sources = legacy.sources
  const files = Object.fromEntries(Object.entries(LEGACY_FILES).map(([name, path]) => [name, `${dir}/${path}`]))
  const planned = new Map() // path → [{ text, frame }]
  const taken = new Set(tracked)
  const put = (path, segments, executable = false) => {
    planned.set(path, segments)
    if (executable) plan.executable.add(path)
  }
  const logLines = [] // the migration log entry's sections

  // Tasks.
  const ledgerLines = sourceLines(sources.get(files.ledger))
  const starts = [...legacy.ledger.tasks.map((task) => task.line), ...legacy.ledger.phases.map((phase) => phase.line)].sort((a, b) => a - b)
  const taskFiles = new Map() // ledger anchor → task file
  for (const task of legacy.ledger.tasks) {
    const next = starts.find((line) => line > task.line)
    const body = ledgerLines.slice(task.line, next ? next - 1 : ledgerLines.length)
    const attached = fieldContinuations(body)
    const extra = [...task.extra]
    for (const item of attached) {
      const at = extra.indexOf(item.line)
      if (at !== -1) extra.splice(at, 1)
    }
    const doing = task.fields.Status === 'doing'
    const out = [`# ${task.id} ${task.title}`.trimEnd(), '']
    for (const [name, value] of Object.entries(task.fields)) {
      if (name === 'Notes') continue
      out.push(value ? `- ${name}: ${value}` : `- ${name}:`)
      for (const item of attached) if (item.name === name) out.push(item.line)
      if (name === 'Status' && doing && !('Lane' in task.fields)) {
        if (lane) out.push(`- Lane: ${lane}`)
        else plan.report.warnings.push(`${task.id} is doing, and HEAD is detached, so it has no lane; add "- Lane: <branch>" to its task file`)
      }
    }
    const notes = [
      ...(isEmptyLegacyValue(task.fields.Notes) ? [] : [task.fields.Notes]),
      ...attached.filter((item) => item.name === 'Notes').map((item) => item.line.trim())
    ]
    const rest = trimBlankLines(extra)
    if (doing) {
      if (notes.length > 0) out.push('', '## Handoff', '', ...notes)
      if (rest.length > 0) out.push('', '## Notes', '', ...rest)
    } else {
      const all = [...notes, ...(notes.length > 0 && rest.length > 0 ? [''] : []), ...rest]
      if (all.length > 0) out.push('', '## Notes', '', ...all)
    }
    const id = /^[A-Za-z0-9._-]+$/.test(task.id) ? task.id : task.id.replace(/[^A-Za-z0-9._-]+/g, '-') || 'task'
    const path = uniquePath(root, taken, taskFileName(dir, id, task.title))
    put(path, [{ text: `${out.join('\n')}\n`, frame: files.ledger }])
    taskFiles.set(task.anchor, path)
  }
  const ledgerKept = [legacy.ledger.preamble]
  for (const phase of legacy.ledger.phases) ledgerKept.push(`${'#'.repeat(phase.level)} ${phase.heading}${phase.text ? `\n\n${phase.text}` : ''}`)
  if (ledgerKept.some(Boolean)) logLines.push(`## The ledger's preamble and phases\n\nFrom \`${files.ledger}\`:\n\n${fenced(ledgerKept.filter(Boolean).join('\n\n'))}`)

  // Log entries.
  const logFiles = new Map() // log anchor → log file
  for (const entry of legacy.log.entries) {
    const slug = slugify(entry.title.replace(/\s*\([^()]*\)\s*$/, '')) || 'entry'
    const path = uniquePath(root, taken, `${dir}/log/${entry.date}-${slug}.md`)
    put(path, [{ text: `# ${entry.heading}\n${entry.body ? `\n${entry.body}\n` : ''}`, frame: files.log }])
    logFiles.set(entry.anchor, path)
  }
  if (legacy.log.preamble) logLines.push(`## The log's preamble\n\nFrom \`${files.log}\`:\n\n${fenced(legacy.log.preamble)}`)

  // Decisions.
  const decisions = legacy.decisions
  const decisionFiles = []
  const columns = decisionColumns(decisions.header?.cells ?? [])
  for (const row of decisions.rows) {
    const text = row.decision
    const date = DATE.test(row.date) ? row.date : 'undated'
    const path = uniquePath(root, taken, `${dir}/decisions/${date}-${slugify(text) || 'decision'}.md`)
    const out = [`# ${decisionTitle(text)}`, '', `- Date: ${row.date || '—'}`, `- Decided by: ${row.decidedBy || '—'}`, '- Status: accepted']
    if (text) out.push('', text)
    const extra = decisionExtraCells(row.cells, decisions.header?.cells ?? [], columns)
    if (extra.length > 0) out.push('', ...extra)
    put(path, [{ text: `${out.join('\n')}\n`, frame: files.decisions }])
    decisionFiles.push({ date: row.date, path })
  }
  const around = [decisions.preamble, decisions.trailing].filter(Boolean)
  if (around.length > 0) logLines.push(`## The decision table's surrounding text\n\nFrom \`${files.decisions}\`, before and after the table:\n\n${fenced(around.join('\n\n'))}`)

  // The status file, word for word.
  logLines.push(`## The 0.x status file\n\n\`${files.status}\` as it was:\n\n${fenced(sourceLines(sources.get(files.status)).join('\n'))}`)

  // standards.md and the workspace AGENTS.md: template sections to the log, the project's own move.
  const templateText = (parsed, templateSections, keep) => {
    const parts = []
    if (parsed.title) parts.push(`# ${parsed.title.text}`)
    if (parsed.preamble) parts.push(parsed.preamble)
    for (const [key, section] of parsed.sections) {
      if (!templateSections.includes(key) || (keep && keep(key))) continue
      parts.push(`${'#'.repeat(section.level)} ${section.heading}${section.text ? `\n\n${section.text}` : ''}`)
    }
    return parts.join('\n\n')
  }
  const ownSections = (parsed, templateSections) =>
    [...parsed.sections].filter(([key]) => !templateSections.includes(key)).map(([, section]) => section)
  const sectionText = (section) => `${'#'.repeat(section.level)} ${section.heading}${section.text ? `\n\n${section.text}` : ''}`

  const projectRules = legacyProjectRules(legacy.agents)
  const rulesArePlaceholder = projectRules === null || projectRules.split('\n').filter((line) => line.trim()).every((line) => line.includes(LEGACY_MARKER))
  const movedAgents = [...(rulesArePlaceholder ? [] : [legacy.agents.sections.get('Project rules')]), ...ownSections(legacy.agents, AGENTS_TEMPLATE_SECTIONS)]
  const standardsKept = templateText(legacy.standards, STANDARDS_TEMPLATE_SECTIONS)
  const agentsKept = templateText(legacy.agents, AGENTS_TEMPLATE_SECTIONS, (key) => key === 'Project rules' && !rulesArePlaceholder)
  const templateLog = []
  if (standardsKept) templateLog.push(`### \`${files.standards}\`\n\n${fenced(standardsKept)}`)
  if (agentsKept) templateLog.push(`### \`${files.agents}\`\n\n${fenced(agentsKept)}`)
  if (templateLog.length > 0)
    logLines.push(`## The 0.x template sections\n\nThe sections that agent-ledger's templates wrote, which ResaLedger replaces: the format reference ships with the package, and the protocol is the managed block in the root \`AGENTS.md\`.\n\n${templateLog.join('\n\n')}`)

  // The README.
  const readmeLines = sourceLines(sources.get(files.readme))
  const goal = legacy.readme.sections.get('What is being built')
  if (goal) readmeLines[goal.line - 1] = `${'#'.repeat(goal.level)} Goal`
  const readmeText = readmeLines.map((line) => line.replaceAll(LEGACY_MARKER, MARKER))
  const readmeSegments = [{ text: tidyLines(readmeText).join('\n'), frame: files.readme }]
  if (!legacy.readme.sections.has('Manual checks')) {
    const gates = legacyManualGates(legacy.standards)
    let manual
    if (gates && gates.items.length > 0) manual = gates.text
    else if (!gates || gates.other.includes(LEGACY_MARKER)) manual = null
    else manual = trimBlankLines(gates.other.split('\n').filter((line) => !/^The last gate is always the same/.test(line))).join('\n') || null
    manual ??= `${MARKER}: the checks that need eyes or judgement, each with what is compared and what passes, or "None".`
    readmeSegments.push({ text: `\n\n## Manual checks\n\n${manual}`, frame: files.standards })
  }
  for (const section of ownSections(legacy.standards, STANDARDS_TEMPLATE_SECTIONS)) readmeSegments.push({ text: `\n\n${sectionText(section)}`, frame: files.standards })
  const atMigration = ['Phase', 'Waiting for the owner']
    .map((name) => ({ name, text: legacy.status.sections.get(name)?.text ?? '' }))
    .filter((part) => part.text)
  if (atMigration.length > 0) {
    const parts = atMigration.map((part) => `### ${part.name}\n\n${part.text}`)
    readmeSegments.push({
      text: `\n\n## At migration\n\nThe state on ${today}, when this workspace moved from agent-ledger 0.x to ResaLedger 1.0, from its status file.\n\n${parts.join('\n\n')}`,
      frame: files.status
    })
  }
  readmeSegments.push({ text: '\n', frame: null })
  put(files.readme, readmeSegments)

  // The root AGENTS.md and CLAUDE.md.
  const pointerTemplates = LEGACY_POINTERS.map((template) => template.replaceAll('{{dir}}', dir).replaceAll('{{guard}}', `node ${dir}/scripts/records.mjs`))
  const editedPointers = []
  const checkPointers = (file, blocks) => {
    for (const block of blocks) if (!pointerTemplates.includes(block.text)) editedPointers.push({ file, text: block.text })
  }
  const block = readFileSync(AGENTS_BLOCK, 'utf8').replaceAll('{{dir}}', dir).trimEnd()
  const agentsPath = realRelative(root, 'AGENTS.md')
  if (agentsPath === null) refuse('AGENTS.md is a link to a file outside the repository; migrate does not write there')
  else {
    const existing = existsSync(join(root, agentsPath)) ? readFileSync(join(root, agentsPath), 'utf8') : ''
    const { lines, blocks } = removePointers(existing)
    checkPointers('AGENTS.md', blocks)
    let kept = tidyLines(lines).join('\n')
    const managed = kept.indexOf(MANAGED_START)
    if (managed !== -1) {
      const end = kept.indexOf(MANAGED_END, managed)
      kept = tidyLines(`${kept.slice(0, managed)}${end === -1 ? '' : kept.slice(end + MANAGED_END.length)}`.split('\n')).join('\n')
    }
    const segments = []
    if (kept) segments.push({ text: kept, frame: agentsPath })
    for (const section of movedAgents) segments.push({ text: `${segments.length > 0 ? '\n\n' : ''}${sectionText(section)}`, frame: files.agents })
    segments.push({ text: `${segments.length > 0 ? '\n\n' : ''}${block}\n`, frame: null })
    put(agentsPath, segments)
  }
  if (lstatSync(join(root, 'CLAUDE.md'), { throwIfNoEntry: false })) {
    const linked = sameFile(root, 'CLAUDE.md', 'AGENTS.md') || (agentsPath !== null && realRelative(root, 'CLAUDE.md') === agentsPath)
    if (!linked) {
      const claudePath = realRelative(root, 'CLAUDE.md')
      if (claudePath === null || !existsSync(join(root, claudePath))) plan.report.warnings.push('CLAUDE.md is a link outside the repository or to nothing; add an "@AGENTS.md" line to the file it points to')
      else {
        const { lines, blocks } = removePointers(readFileSync(join(root, claudePath), 'utf8'))
        checkPointers('CLAUDE.md', blocks)
        if (!lines.some((line) => /^\s*@AGENTS\.md\s*$/.test(line))) {
          const at = blocks.length > 0 ? blocks[0].at : lines.length
          lines.splice(at, 0, '', '@AGENTS.md', '')
        }
        const text = `${tidyLines(lines).join('\n')}\n`
        if (blocks.length > 0 || text !== readFileSync(join(root, claudePath), 'utf8')) put(claudePath, [{ text, frame: claudePath }])
      }
    }
  }
  if (editedPointers.length > 0) {
    plan.report.warnings.push(`the 0.x pointer block in ${[...new Set(editedPointers.map((item) => item.file))].join(' and ')} was changed by hand; it is removed and kept word for word in the migration's log entry`)
    logLines.push(`## Pointer blocks changed by hand\n\n${editedPointers.map((item) => `In \`${item.file}\`:\n\n${fenced(item.text)}`).join('\n\n')}`)
  }

  // .claude/settings.json: the hook commands name the agent in 1.0.
  const settingsPath = '.claude/settings.json'
  if (existsSync(join(root, settingsPath))) {
    const text = readFileSync(join(root, settingsPath), 'utf8')
    let valid = true
    try {
      JSON.parse(text)
    } catch {
      valid = false
      plan.report.warnings.push(`${settingsPath} is not valid JSON, so its hook commands were not changed; change "records.mjs\\" hook <event>" to "records.mjs\\" hook claude <event>" by hand`)
    }
    if (valid) {
      const updated = text.replace(/(records\.mjs(?:\\")?) hook (?!claude\b)(session-start|pre-tool|stop)\b/g, '$1 hook claude $2')
      if (updated !== text) put(settingsPath, [{ text: updated, frame: null }])
    }
  }

  // The git hooks, the guard and .gitattributes.
  for (const name of HOOK_NAMES) put(`${HOOKS_FOLDER}/${name}`, [{ text: renderHook(name, dir), frame: null }], true)
  put(`${dir}/scripts/records.mjs`, [{ text: readFileSync(guardPath, 'utf8'), frame: null }], true)
  if (existsSync(join(root, '.gitattributes'))) {
    const text = readFileSync(join(root, '.gitattributes'), 'utf8')
    const union = new Set([`${dir}/work/log.md merge=union`, `${dir}/DECISIONS.md merge=union`, UNION_COMMENT])
    const lines = sourceLines(text)
    const kept = lines.filter((line) => !union.has(line.trim()))
    if (kept.length !== lines.length) {
      const tidy = tidyLines(kept)
      if (tidy.length === 0) plan.deletes.push('.gitattributes')
      else put('.gitattributes', [{ text: `${tidy.join('\n')}\n`, frame: null }])
    }
  }

  // The configuration.
  const { config: newConfig, unmapped } = convertConfig(legacy.config)
  // 1.0's base defaults to main; a repository without main gets the remote's default branch, or master.
  const hasRef = (ref) => runGit(root, ['rev-parse', '--verify', '-q', ref]).stdout.trim() !== ''
  if (!hasRef('refs/heads/main') && !hasRef('refs/remotes/origin/main')) {
    const remoteHead = runGit(root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']).stdout.trim().replace(/^origin\//, '')
    const base = remoteHead || (hasRef('refs/heads/master') || hasRef('refs/remotes/origin/master') ? 'master' : '')
    if (base) {
      newConfig.base = base
      plan.report.warnings.push(`there is no branch main, so "base" is set to "${base}" in ${CONFIG_FILE}`)
    }
  }
  const configText = `${JSON.stringify(newConfig, null, 2)}\n`
  put(CONFIG_FILE, [{ text: configText, frame: null }])
  plan.renames.push({ from: LEGACY_CONFIG_FILE, to: CONFIG_FILE })
  plan.report.unmappedKeys = Object.keys(unmapped)
  if (plan.report.unmappedKeys.length > 0) {
    plan.report.warnings.push(`${LEGACY_CONFIG_FILE} has keys with no 1.0 meaning, kept in the migration's log entry: ${plan.report.unmappedKeys.join(', ')}`)
    logLines.push(`## Configuration keys with no 1.0 meaning\n\nFrom \`${LEGACY_CONFIG_FILE}\`:\n\n${fenced(JSON.stringify(unmapped, null, 2))}`)
  }

  // The migration's log entry.
  const logPath = uniquePath(root, taken, `${dir}/log/${today}-migrated-to-resaledger-1-0.md`)
  const logText = `# ${today} · Migrated to ResaLedger 1.0

This workspace moved from agent-ledger 0.x to ResaLedger 1.0 with \`npx resaledger migrate\`: one file per task, decision and log entry, the status file's lasting facts in the README, and the protocol in the root \`AGENTS.md\`. The 0.x files are in git history before this change. Below, word for word, is the 0.x text that has no other place in 1.0.

${logLines.join('\n\n')}
`
  put(logPath, [{ text: logText, frame: null }])
  plan.logEntry = { path: logPath, text: logText }

  // What goes.
  for (const name of ['ledger', 'log', 'decisions', 'status', 'standards', 'agents']) plan.deletes.push(files[name])
  if (tracked.has(`${dir}/work/verified.json`) || existsSync(join(root, dir, 'work', 'verified.json'))) plan.deletes.push(`${dir}/work/verified.json`)

  // 3. The content check, before any link changes: every non-empty old line is in a new file.
  if (options.testDropLine !== undefined) dropLine(planned, options.testDropLine)
  // Only the new Markdown files count: a line found in the guard's code would prove nothing.
  const output = [...planned].filter(([path]) => MARKDOWN.test(path)).flatMap(([, segments]) => segments.map((segment) => segment.text))
  const checked = checkedLines(legacy, files)
  const lost = lostLegacyLines(checked.lines.join('\n'), output)
  for (const item of lost) {
    const origin = checked.origins[item.line - 1]
    refuse(`${origin.file}:${origin.line}: this line of the 0.x records is not in any new file: ${origin.text.trim()}`)
  }
  if (plan.refusals.length > 0) return plan

  // 4. Links into the removed files, in every Markdown file that stays or is new.
  const removed = new Set([...plan.deletes, LEGACY_CONFIG_FILE])
  const finalFiles = new Set([...tracked].filter((path) => !removed.has(path)))
  for (const path of planned.keys()) finalFiles.add(path)
  const before = plannedReader(root, tracked, new Map())
  const after = plannedReader(root, finalFiles, new Map())
  const folder = (path) => (after.exists(path) ? { path, anchor: '', folder: true } : null)
  const mapTarget = (path, anchor) => {
    if (path === files.ledger) {
      if (anchor && taskFiles.has(anchor)) return { path: taskFiles.get(anchor), anchor: '' }
      if (!folder(`${dir}/tasks`)) return { unresolved: 'there are no task files' }
      return { ...folder(`${dir}/tasks`), note: anchor ? `#${anchor} is not a task; the link goes to the tasks folder` : null }
    }
    if (path === files.log) {
      if (anchor && logFiles.has(anchor)) return { path: logFiles.get(anchor), anchor: '' }
      return { ...folder(`${dir}/log`), note: anchor ? `#${anchor} is not a log entry; the link goes to the log folder` : null }
    }
    if (path === files.decisions) {
      const match = anchor ? decisionFiles.filter((item) => anchor.startsWith(item.date)) : []
      if (match.length === 1) return { path: match[0].path, anchor: '', note: `#${anchor} matched the decision of ${match[0].date}` }
      if (!folder(`${dir}/decisions`)) return { unresolved: 'there are no decision files' }
      return { ...folder(`${dir}/decisions`), note: anchor ? `#${anchor} names no single decision; the link goes to the decisions folder` : null }
    }
    if (path === files.status) return { path: files.readme, anchor: '', note: anchor ? `#${anchor} is dropped: the status file's facts are in the README` : null }
    if (path === files.standards) return { path: files.readme, anchor: 'manual-checks' }
    if (path === files.agents) {
      const moved = movedAgents.map((section) => headingAnchor(section.heading))
      return { path: agentsPath ?? 'AGENTS.md', anchor: moved.includes(anchor) ? anchor : '', note: anchor && !moved.includes(anchor) ? `#${anchor} is dropped: the workspace rules are in the root AGENTS.md` : null }
    }
    if (path === LEGACY_CONFIG_FILE) return { path: CONFIG_FILE, anchor: '' }
    if (before.exists(path) && !after.exists(path)) return { unresolved: `${path} is removed by the migration` }
    return null
  }
  const final = new Map()
  for (const path of [...finalFiles].sort()) {
    if (!MARKDOWN.test(path)) continue
    if (!planned.has(path)) {
      const full = join(root, path)
      if (!existsSync(full) || lstatSync(full).isSymbolicLink() || !statSync(full).isFile()) continue
    }
    const segments = planned.get(path) ?? [{ text: readFileSync(join(root, path), 'utf8'), frame: path }]
    let changed = false
    const texts = segments.map((segment) => {
      if (segment.frame === null) return segment.text
      const result = rewriteLinks(segment.text, segment.frame, path, mapTarget)
      if (maskLinkTargets(result.text) !== maskLinkTargets(segment.text)) {
        refuse(`rewriting the links of ${path} would change more than link targets; this is a bug in resaledger, please report it`)
        return segment.text
      }
      plan.report.links.push(...result.links)
      if (result.text !== segment.text) changed = true
      return result.text
    })
    if (planned.has(path) || changed) final.set(path, texts.join(''))
  }
  for (const [path, segments] of planned) if (!final.has(path)) final.set(path, segments.map((segment) => segment.text).join(''))
  if (plan.refusals.length > 0) return plan

  // 5. The result.
  for (const [path, text] of [...final].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (existsSync(join(root, path))) {
      if (readFileSync(join(root, path), 'utf8') === text) continue
      plan.report.changed.push(path)
    } else plan.report.created.push(path)
    plan.writes.set(path, text)
  }
  for (const path of plan.executable) if (!plan.writes.has(path)) plan.executable.delete(path)
  plan.deletes = [...new Set(plan.deletes)].filter((path) => existsSync(join(root, path))).sort()
  plan.report.deleted = plan.deletes
  plan.report.renamed = plan.renames.map(({ from, to }) => `${from} → ${to}`)
  plan.report.counts = { tasks: legacy.ledger.tasks.length, logEntries: legacy.log.entries.length, decisions: decisions.rows.length }
  plan.report.warnings.push(...unmergedBranchWarnings(root, dir))

  // 6. Validation with the 1.0 rules, in memory.
  const { config, problems: configProblems } = parseConfig(configText)
  plan.problems.push(...configProblems)
  if (config) {
    const reader = plannedReader(root, finalFiles, final)
    plan.problems.push(...checkWorkspace(loadWorkspace(reader, config), reader, config))
  }
  return plan
}

/** The heading anchor GitHub gives a heading's text. */
function headingAnchor(text) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc}\- ]/gu, '')
    .replaceAll(' ', '-')
}

/**
 * The indented lines right after a task's fields that continue a field, such as a second line
 * of evidence, as { name, line }. They stay with their field instead of going to Notes. A
 * field that appears twice keeps its lines in Notes, because it is unclear which one they continue.
 */
function fieldContinuations(body) {
  const counts = new Map()
  for (const line of body) {
    const match = line.match(LEGACY_FIELD)
    if (match) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1)
  }
  const attached = []
  let last = null
  let afterContinuation = false
  for (const line of body) {
    if (!line.trim()) {
      if (last === null) continue
      break
    }
    const match = line.match(LEGACY_FIELD)
    if (match) {
      if (afterContinuation && !LEGACY_TASK_FIELDS.includes(match[1])) break
      last = match[1]
      continue
    }
    if (last !== null && /^[ \t]+\S/.test(line)) {
      attached.push({ name: last, line })
      afterContinuation = true
      continue
    }
    break
  }
  return attached.filter((item) => counts.get(item.name) === 1)
}

/** The column of each named cell in the decision table's header: by name, else by position. */
function decisionColumns(header) {
  const names = header.map((cell) => cell.toLowerCase())
  const column = (name, fallback) => (names.includes(name) ? names.indexOf(name) : fallback)
  return [column('date', 0), column('decision', 1), column('decided by', 2)]
}

/** The cells of a decision row that are not its date, text or decider, as "<header>: <cell>" lines. */
function decisionExtraCells(cells, header, columns) {
  return cells.flatMap((cell, index) => (columns.includes(index) || cell === '' ? [] : [`${header[index] || `Column ${index + 1}`}: ${cell}`]))
}

/**
 * Every line of the old records in the form the new files hold it, with where it came from.
 * The known reshaping: a task heading becomes "# <id> <title>", a task's Notes field its
 * value, a log heading "# <date> · <title>", a decision row its fields and text, the README's
 * "What is being built" "Goal", and its setup markers ResaLedger's. Every other line is as it was.
 */
function checkedLines(legacy, files) {
  const lines = []
  const origins = []
  const add = (file, line, text, forms) => {
    for (const form of forms) {
      lines.push(form)
      origins.push({ file, line, text })
    }
  }
  const verbatim = (file, transform = () => null) => {
    sourceLines(legacy.sources.get(file)).forEach((text, index) => {
      const forms = transform(index + 1, text)
      add(file, index + 1, text, forms ?? [text])
    })
  }

  const notesLines = new Map()
  const ledgerLines = sourceLines(legacy.sources.get(files.ledger))
  const starts = [...legacy.ledger.tasks.map((task) => task.line), ...legacy.ledger.phases.map((phase) => phase.line)].sort((a, b) => a - b)
  for (const task of legacy.ledger.tasks) {
    const next = starts.find((line) => line > task.line) ?? ledgerLines.length + 1
    for (let line = next - 1; line > task.line; line -= 1) {
      const match = ledgerLines[line - 1].match(/^- Notes:(?:[ \t]+(.*))?$/)
      if (match) {
        notesLines.set(line, isEmptyLegacyValue(match[1]) ? [] : [match[1].trim()])
        break
      }
    }
  }
  const taskHeadings = new Set(legacy.ledger.tasks.map((task) => task.line))
  verbatim(files.ledger, (line, text) => {
    if (taskHeadings.has(line)) return [text.replace(/^ {0,3}###[ \t]+/, '# ')]
    return notesLines.get(line) ?? null
  })

  const logHeadings = new Set(legacy.log.entries.map((entry) => entry.line))
  verbatim(files.log, (line, text) => (logHeadings.has(line) ? [text.replace(/^## /, '# ')] : null))

  const decisions = legacy.decisions
  const header = decisions.header
  const rows = new Set(decisions.rows.map((row) => row.line))
  const columns = decisionColumns(header?.cells ?? [])
  verbatim(files.decisions, (line, text) => {
    if (header && (line === header.line || (header.separator && line === header.line + 1))) return []
    if (!rows.has(line)) return null
    const cells = legacyTableCells(text)
    const [date, decision, decidedBy] = columns.map((index) => cells[index] ?? '')
    return [
      ...(date ? [`- Date: ${date}`] : []),
      ...(decidedBy ? [`- Decided by: ${decidedBy}`] : []),
      ...(decision ? [decision] : []),
      ...decisionExtraCells(cells, header.cells, columns)
    ]
  })

  verbatim(files.status)
  verbatim(files.standards)
  verbatim(files.agents)
  const goal = legacy.readme.sections.get('What is being built')
  verbatim(files.readme, (line, text) => {
    if (goal && line === goal.line) return [`${'#'.repeat(goal.level)} Goal`]
    return text.includes(LEGACY_MARKER) ? [text.replaceAll(LEGACY_MARKER, MARKER)] : null
  })
  return { lines, origins }
}

/** Drops the first occurrence of a line from the planned files: the test that proves a loss is caught. */
function dropLine(planned, wanted) {
  for (const segments of planned.values()) {
    for (const segment of segments) {
      const lines = segment.text.split('\n')
      const at = lines.indexOf(wanted)
      if (at !== -1) {
        lines.splice(at, 1)
        segment.text = lines.join('\n')
        return
      }
    }
  }
}

/** Branches not merged into HEAD that change files in the workspace folder, as warnings. */
function unmergedBranchWarnings(root, dir) {
  const warnings = []
  const refs = gitOut(root, ['for-each-ref', '--format=%(refname)%00%(symref)', 'refs/heads', 'refs/remotes'])
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\0'))
    .filter(([, symref]) => !symref)
    .map(([ref]) => ref)
  for (const ref of refs) {
    if (runGit(root, ['merge-base', '--is-ancestor', ref, 'HEAD']).status === 0) continue
    const changed = runGit(root, ['diff', '--name-only', `HEAD...${ref}`, '--', dir])
    if (changed.status !== 0 || !changed.stdout.trim()) continue
    const count = changed.stdout.trim().split('\n').length
    const name = ref.replace(/^refs\/(heads|remotes)\//, '')
    warnings.push(`the unmerged branch ${name} changes ${count} file${count === 1 ? '' : 's'} in ${dir}/; its 0.x records will not merge into the 1.0 files. Migrate when no lane is open`)
  }
  return warnings
}

/** Writes a plan: the files, their modes, the renames and the deletions. */
export function applyMigration(root, plan) {
  for (const [path, text] of plan.writes) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
    if (plan.executable.has(path)) chmodSync(full, 0o755)
  }
  for (const { from } of plan.renames) rmSync(join(root, from), { force: true })
  for (const path of plan.deletes) {
    rmSync(join(root, path), { force: true })
    // Folders the deletions emptied, up to the root.
    let folder = posix.dirname(path)
    while (folder !== '.' && folder !== '') {
      const full = join(root, folder)
      if (!existsSync(full) || readdirSync(full).length > 0) break
      rmdirSync(full)
      folder = posix.dirname(folder)
    }
  }
}
