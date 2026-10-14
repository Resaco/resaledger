// Applies the hygiene rules (scripts/hygiene.mjs) to the whole history before anything is
// pushed: every commit's message, author and committer, and every line a commit adds.
// Usage: node scripts/scan-history.mjs [repository]. Exits 1 when anything is found.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkLine, checkText, denyPatterns, git, readDenyList } from './hygiene.mjs'

const SEPARATOR = '\x1e'
const START = '\x1f'

/** Returns [{ commit, where, line, rule, match }] for every hit in the history of `root`. */
export function scanHistory(root, { env = process.env, deny = readDenyList(root, env) } = {}) {
  const patterns = denyPatterns(deny)
  const hits = []

  // Metadata: one record per commit.
  const log = git(root, ['log', '--all', `--format=${START}%H%n%an%n%ae%n%cn%n%ce%n%B${SEPARATOR}`], env)
  for (const record of log.split(SEPARATOR)) {
    const start = record.indexOf(START)
    if (start < 0) continue
    const [commit, authorName, authorEmail, committerName, committerEmail, ...message] = record.slice(start + 1).split('\n')
    const fields = { author: `${authorName} <${authorEmail}>`, committer: `${committerName} <${committerEmail}>` }
    for (const [where, value] of Object.entries(fields)) {
      for (const hit of checkLine(value, patterns)) hits.push({ commit, where, line: 0, ...hit })
    }
    for (const hit of checkText(message.join('\n'), patterns)) hits.push({ commit, where: 'message', ...hit })
  }

  // Content: the lines each commit adds.
  const patch = git(root, ['log', '--all', '-p', '--no-color', '--no-ext-diff', '--no-renames', `--format=${START}%H`], env)
  let commit = ''
  let file = ''
  let inHeader = false
  let line = 0
  for (const text of patch.split('\n')) {
    if (text.startsWith(START)) {
      commit = text.slice(1)
      inHeader = false
    } else if (text.startsWith('diff --git ')) {
      inHeader = true
    } else if (inHeader && text.startsWith('+++ ')) {
      file = text.slice(4).replace(/^b\//, '')
    } else if (text.startsWith('@@')) {
      inHeader = false
      const found = /\+(\d+)/.exec(text)
      line = found ? Number(found[1]) : 0
    } else if (!inHeader && commit) {
      if (text.startsWith('+')) {
        for (const hit of checkLine(text.slice(1), patterns)) hits.push({ commit, where: file, line, ...hit })
        line += 1
      } else if (text.startsWith(' ')) {
        line += 1
      }
    }
  }
  return hits
}

/** One hit as "commit where:line: rule (match)". */
export function formatHit({ commit, where, line, rule, match }) {
  return `${commit.slice(0, 12)} ${where}:${line}: ${rule} (${match})`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? '.')
  const hits = scanHistory(root)
  for (const hit of hits) console.log(formatHit(hit))
  if (hits.length > 0) {
    console.error(`scan-history: ${hits.length} hit(s)`)
    process.exit(1)
  }
  console.log('scan-history: clean')
}
