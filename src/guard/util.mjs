// Small helpers that every part of the guard uses.
import { execFileSync } from 'node:child_process'

/** Runs git and returns its trimmed output; throws when git fails. */
export function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** A count and its noun: "1 task", "2 tasks"; many is the plural when it is not word + "s". */
export function plural(count, word, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`
}

/** The records counted, as "1 task, 2 decisions, 0 log entries". */
export function recordCounts(tasks, decisions, logs) {
  return `${plural(tasks, 'task')}, ${plural(decisions, 'decision')}, ${plural(logs, 'log entry', 'log entries')}`
}

/** Prints the message to stderr and stops with exit code 1. */
export function fail(message) {
  console.error(`resaledger: ${message}`)
  process.exit(1)
}

/** The top level of the repository the current folder is in, as a POSIX path. */
export function repositoryRoot() {
  return git('rev-parse', '--show-toplevel').replace(/\\/g, '/')
}

/**
 * The edit distance between two strings: insertions, deletions, substitutions and swaps of
 * two neighbouring letters, each counting one (the optimal string alignment distance).
 */
export function editDistance(a, b) {
  const rows = [Array.from({ length: b.length + 1 }, (_, index) => index)]
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(rows[i - 1][j] + 1, current[j - 1] + 1, rows[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) current[j] = Math.min(current[j], rows[i - 2][j - 2] + 1)
    }
    rows.push(current)
  }
  return rows[a.length][b.length]
}

/** How far a name may be from a known one and still be its typo: 2 for six letters or more, else 1 (spec 5.2, 5.3). */
function typoLimit(known) {
  return known.length >= 6 ? 2 : 1
}

/** The known name closest to name within its typo limit, ignoring case, or null. Ties go to the first. */
export function likelyTypo(name, known) {
  let best = null
  let bestDistance = Infinity
  for (const candidate of known) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase())
    if (distance <= typoLimit(candidate) && distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}
