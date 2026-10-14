// Small helpers that every part of the guard uses.
import { execFileSync } from 'node:child_process'

/** Runs git and returns its trimmed output; throws when git fails. */
export function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** Prints the message to stderr and stops with exit code 1. */
export function fail(message) {
  console.error(`resaledger: ${message}`)
  process.exit(1)
}
