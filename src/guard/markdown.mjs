// Markdown primitives that every record parser uses: lines, headings and their anchors,
// sections, relative links and bullet fields. Pure functions over text; no file access.
import { posix } from 'node:path'

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/
const LINK_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const INLINE_LINK =
  /!?\[((?:[^[\]\\]|\\.|\[[^\]]*\])*)\]\(\s*(<[^<>\n]*>|[^\s()<>]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/g
const FIELD = /^- ([\p{L} ]*\p{L}):(?:[ \t]+(.*))?$/u
const NESTED_ITEM = /^(?:\t| {2,})[ \t]*- (.*)$/
const EMPTY_VALUES = new Set(['', '—', '–', '-'])

/** The lines of a text, with CRLF and lone CR treated as LF; a trailing newline adds no line. */
export function splitLines(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** For each line, whether it belongs to a fenced code block (the fence lines included). */
function fencedLines(lines) {
  const fenced = []
  let open = null
  for (const line of lines) {
    if (open) {
      fenced.push(true)
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
      if (close && close[1][0] === open[0] && close[1].length >= open.length) open = null
      continue
    }
    const fence = line.match(FENCE_OPEN)
    // A backtick fence's info string may not contain a backtick.
    if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      open = fence[1]
      fenced.push(true)
    } else fenced.push(false)
  }
  return fenced
}

/** The anchor GitHub makes from a heading's text, before duplicates are numbered. */
function headingSlug(text) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc}\- ]/gu, '')
    .replaceAll(' ', '-')
}

/** ATX headings outside fenced code, as { level, text, anchor, line } with 1-based lines. */
export function headings(text) {
  const lines = splitLines(text)
  const fenced = fencedLines(lines)
  const taken = new Map()
  const found = []
  lines.forEach((line, index) => {
    if (fenced[index]) return
    const match = line.match(ATX_HEADING)
    if (!match) return
    const title = (match[2] ?? '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim()
    const base = headingSlug(title)
    // Numbered like github-slugger: a number already taken moves on to the next one.
    let anchor = base
    while (taken.has(anchor)) {
      const next = taken.get(base) + 1
      taken.set(base, next)
      anchor = `${base}-${next}`
    }
    taken.set(anchor, 0)
    found.push({ level: match[1].length, text: title, anchor, line: index + 1 })
  })
  return found
}

/** The section an anchor names: its heading, the lines up to the next heading of the same or a higher level, and the heading's line. */
export function findSection(text, anchor) {
  const wanted = anchor.replace(/^#/, '').toLowerCase()
  const all = headings(text)
  const position = all.findIndex((heading) => heading.anchor.toLowerCase() === wanted)
  if (position === -1) return null
  const heading = all[position]
  const next = all.slice(position + 1).find((other) => other.level <= heading.level)
  const lines = splitLines(text)
  return { heading, lines: lines.slice(heading.line, next ? next.line - 1 : lines.length), line: heading.line }
}

/** A line with its inline code spans blanked out, so that links inside them are not seen. */
function withoutCodeSpans(line) {
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

function decodePercent(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Inline links and images that point into the repository, as { target, path, anchor, line }. */
export function relativeLinks(text) {
  const lines = splitLines(text)
  const fenced = fencedLines(lines)
  const links = []
  lines.forEach((line, index) => {
    if (fenced[index]) return
    for (const match of withoutCodeSpans(line).matchAll(INLINE_LINK)) {
      const raw = match[2]
      const target = raw.startsWith('<') ? raw.slice(1, -1) : raw
      if (!target || target.startsWith('#') || target.startsWith('//') || LINK_SCHEME.test(target)) continue
      const hash = target.indexOf('#')
      const path = hash === -1 ? target : target.slice(0, hash)
      const anchor = hash === -1 ? '' : target.slice(hash + 1)
      links.push({ target, path: decodePercent(path), anchor: decodePercent(anchor), line: index + 1 })
    }
  })
  return links
}

/** The repository-relative path a link in fromFile points to, or null when it climbs out of the repository. */
export function resolveLinkPath(fromFile, path) {
  const joined = path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(fromFile), path)
  const resolved = posix.normalize(joined || '.').replace(/(.)\/+$/, '$1')
  if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) return null
  return resolved
}

/**
 * A bullet list of `- Name: value` fields starting at lines[start], after any blank lines.
 * Nested `  - item` lines go to the field's items; other indented lines continue the last
 * item, or the value. Returns { fields, end } with end the index of the first line after the list.
 */
export function parseFields(lines, start) {
  const fields = []
  let index = start
  while (index < lines.length && lines[index].trim() === '') index += 1
  if (index >= lines.length || !FIELD.test(lines[index])) return { fields, end: start }
  for (; index < lines.length; index += 1) {
    const line = lines[index]
    const field = line.match(FIELD)
    if (field) {
      fields.push({ name: field[1].trim(), value: (field[2] ?? '').trim(), items: [], line: index + 1 })
      continue
    }
    const current = fields[fields.length - 1]
    const item = line.match(NESTED_ITEM)
    if (item) {
      current.items.push(item[1].trim())
      continue
    }
    if (/^[ \t]+\S/.test(line)) {
      const more = line.trim()
      if (current.items.length > 0) {
        const last = current.items.length - 1
        current.items[last] = current.items[last] ? `${current.items[last]} ${more}` : more
      } else current.value = current.value ? `${current.value} ${more}` : more
      continue
    }
    break
  }
  return { fields, end: index }
}

/** Whether a field value means "empty": nothing, or a dash. */
export function isEmptyValue(value) {
  return EMPTY_VALUES.has(value.trim())
}
