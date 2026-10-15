// The output of the CI check (spec 10): plain text for the log, Markdown for the job summary and
// the pull request comment, and the comment itself, posted once and then updated in place.
import { appendFileSync } from 'node:fs'

// The hidden first line of ResaLedger's pull request comment, which finds it again on later runs.
export const CI_COMMENT_MARKER = '<!-- resaledger:ci -->'
const CI_COMMENT_PAGES = 10
const CI_COMMENT_TIMEOUT = 10000

/** The first 7 characters of a commit id, for messages. */
export function ciShort(commit) {
  return commit ? commit.slice(0, 7) : 'none'
}

/** A count and its noun: "1 task", "2 tasks". */
function ciPlural(count, word, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`
}

/** The one-line summary of a check, after its ✔ or ✖. */
export function ciCheckLine(check, result) {
  const problems = check.problems.length > 0 ? `${ciPlural(check.problems.length, 'problem')}; ` : ''
  const note = check.note ? ` (${check.note})` : ''
  const { counts } = check
  switch (check.name) {
    case 'records':
      return `records: ${problems}${ciPlural(counts.tasks, 'task')}, ${ciPlural(counts.decisions, 'decision')}, ${ciPlural(counts.logs, 'log entry', 'log entries')}${note}`
    case 'commits':
      if (check.skipped) return `commits: not checked${note}`
      return `commits: ${problems}${ciPlural(counts.commits, 'commit')} ${result.event === 'push' ? 'pushed' : 'from the merge base to the head'}${note}`
    case 'ownership':
      return `ownership: ${problems}${ciPlural(counts.changed, 'task')} changed${note}`
    case 'ids':
      return `ids: ${problems}${ciPlural(counts.added, 'new id')}, against ${ciPlural(counts.branches, 'branch', 'branches')}${note}`
    case 'moved':
      return `tasks moved: ${counts.moved}`
    case 'enforcement': {
      if (check.skipped) return `enforcement: not compared (${check.note})`
      if (counts.changes === 0) return 'enforcement: unchanged'
      const undecided = check.problems.length > 0 ? `${ciPlural(check.problems.length, 'weakening change')} no decision names; ` : ''
      return `enforcement: ${undecided}${ciPlural(counts.changes, 'change')}, ${counts.weakening} weakening`
    }
    case 'gates': {
      if (check.skipped) return `gates: none${note}`
      const gates = result.gates
      if (gates.mode === 'stamp') return `gates: ${problems}${gates.stamp ? `the head carries its stamp ${gates.stamp}` : 'no stamp for the head'} (ci.runGates is false)`
      const timings = gates.passed.map(({ command, seconds }) => `${command} ✔ ${seconds} s`)
      if (gates.failure) timings.push(`${gates.failure.command} ✖`)
      return `gates on ${ciShort(gates.ranOn)}: ${timings.join(' · ')}${note}`
    }
    default:
      return `${check.name}: ${problems}`.replace(/; $/, '')
  }
}

/** A change's text led by its id, which a configuration change's text already starts with. */
function ciChangeText(change, text) {
  return text.startsWith(`${change.id} `) || text.startsWith(`${change.id}:`) ? text : `${change.id}: ${text}`
}

/** The line of one change to enforcement: its id, what changed, and why it passes or fails. */
export function ciChangeLine(change, check) {
  if (change.kind === 'listed') return ciChangeText(change, change.what)
  if (change.decidedBy) return `${ciChangeText(change, change.what)} · weakening, decided in ${change.decidedBy.file}${change.decidedBy.by ? ` by ${change.decidedBy.by}` : ''}`
  const problem = check.problems.find(({ id }) => id === change.id)
  return `✖ ${ciChangeText(change, problem ? problem.message : change.what)}`
}

/** A problem as one line: "file:line: message". */
function ciProblemLine({ file, line, message }) {
  return `${file ? `${file}${line ? `:${line}` : ''}: ` : ''}${message}`
}

/** Where the rules came from, as a sentence. */
function ciRulesLine(result) {
  const { rules, release } = result
  const from = rules.adds
    ? `This change adds ResaLedger, so it is judged by its own rules, from the ${rules.from} ${ciShort(rules.commit)}.`
    : `Rules from the ${rules.from} ${ciShort(rules.commit)}.`
  return release ? `${from} ResaLedger ${release.version} counts as released (--release).` : from
}

/** The status change of a moved task: "doing → done", or "new, todo" for a new task. */
function ciMove(task) {
  return task.from === null ? `new, ${task.to ?? 'no status'}` : `${task.from} → ${task.to ?? 'no status'}`
}

/** The CI result as plain text, for the log. */
export function ciText(result) {
  const out = []
  if (result.event === 'push') {
    out.push(`ResaLedger ci: push${result.ref ? ` to ${result.ref}` : ''}, ${result.from ? `${ciShort(result.from)}..` : ''}${ciShort(result.head)}`)
  } else {
    out.push(
      `ResaLedger ci: pull request from "${result.lane}"${result.fork ? ' (a fork)' : ''}, head ${ciShort(result.head)}, base ${ciShort(result.base)}, merge base ${ciShort(result.mergeBase)}`
    )
  }
  if (result.skipped) {
    out.push(`Not checked: ${result.skipped}.`)
    return out.join('\n')
  }
  out.push(ciRulesLine(result))
  for (const check of result.checks) {
    out.push(`${check.ok ? '✔' : '✖'} ${ciCheckLine(check, result)}`)
    if (check.name === 'enforcement') {
      for (const change of result.enforcement) out.push(`  ${ciChangeLine(change, check)}`)
      continue
    }
    for (const problem of check.problems) out.push(`  ${ciProblemLine(problem)}`)
    if (check.name === 'moved') {
      for (const task of result.moved) out.push(`  ${task.id} ${task.title}: ${ciMove(task)}${task.evidence ? ` · Evidence: ${task.evidence}` : ''}`)
    }
  }
  return out.join('\n')
}

/** Text from the records, made safe for Markdown: one line, and no HTML tags or hidden comments. */
function ciMarkdownText(text) {
  return String(text).replace(/\s+/g, ' ').replace(/</g, '&lt;').trim()
}

/** A command as a Markdown code span, on one line. */
function ciMarkdownCode(text) {
  const plain = String(text).replace(/\s+/g, ' ').trim()
  return plain.includes('`') ? `\`\` ${plain} \`\`` : `\`${plain}\``
}

/** The title of the Markdown output: what was checked, and the verdict. */
function ciMarkdownTitle(result) {
  const what = result.event === 'push' ? `push${result.ref ? ` to ${result.ref.replace(/^refs\/heads\//, '')}` : ''}` : 'this pull request'
  const failed = result.checks.filter((check) => !check.ok).length
  const verdict = result.skipped ? 'not checked' : failed === 0 ? '✔ passed' : `✖ ${ciPlural(failed, 'check')} failed`
  return `### ResaLedger · ${ciMarkdownText(what)} · ${verdict}`
}

/** The commits line: how many were checked and whether they pass. */
function ciCommitsSummary(result) {
  const check = result.checks.find(({ name }) => name === 'commits')
  if (!check) return null
  if (check.skipped) return `**Commits:** not checked${check.note ? ` (${ciMarkdownText(check.note)})` : ''}`
  const verdict = check.ok ? 'all pass' : ciPlural(check.problems.length, 'problem')
  return `**Commits:** ${check.counts.commits} checked, ${verdict}`
}

/** The gates line: each command with its time, where it ran, and where the rules came from. */
function ciGatesSummary(result) {
  const { gates } = result
  if (!gates) return null
  const from = `(rules from the ${result.rules.from} \`${ciShort(result.rules.commit)}\`)`
  if (gates.mode === 'none') return `**Gates:** none configured ${from}`
  if (gates.mode === 'stamp') return `**Gates:** ${gates.stamp ? `the head carries its stamp ${ciMarkdownCode(gates.stamp)}` : '✖ no stamp for the head'}, as ci.runGates is false ${from}`
  const timings = gates.passed.map(({ command, seconds }) => `${ciMarkdownCode(command)} ✔ ${seconds} s`)
  if (gates.failure) timings.push(`${ciMarkdownCode(gates.failure.command)} ✖ (exit ${gates.failure.status})`)
  return `**Gates** on \`${ciShort(gates.ranOn)}\`: ${timings.join(' · ')} ${from}`
}

/** The enforcement lines: "unchanged", or each change with its id. */
function ciEnforcementSummary(result) {
  if (result.enforcement === null) return []
  const check = result.checks.find(({ name }) => name === 'enforcement')
  if (check?.skipped) return [`**Enforcement:** not compared (${ciMarkdownText(check.note)})`]
  if (result.enforcement.length === 0) return ['**Enforcement:** unchanged']
  return ['**Enforcement:**', ...result.enforcement.map((change) => `- ${ciMarkdownText(ciChangeLine(change, check))}`)]
}

/**
 * The CI result as Markdown, for the job summary and the pull request comment: the tasks the
 * change moves with their evidence, the commits, the gates with their times and where the
 * rules came from, the changes to enforcement, then the problems and every check.
 */
export function ciMarkdown(result) {
  const lines = [ciMarkdownTitle(result), '']
  if (result.skipped) return [...lines, `Not checked: ${ciMarkdownText(result.skipped)}.`, ''].join('\n')
  if (result.moved.length === 0) lines.push('No task changes its status.')
  for (const task of result.moved) {
    lines.push(`- **${ciMarkdownText(task.id)}** ${ciMarkdownText(task.title)} · ${ciMove(task)}`)
    if (task.evidence) lines.push(`  Evidence: ${ciMarkdownText(task.evidence)}`)
  }
  lines.push('')
  for (const line of [ciCommitsSummary(result), ciGatesSummary(result)]) if (line) lines.push(line, '')
  const enforcement = ciEnforcementSummary(result)
  if (enforcement.length > 0) lines.push(...enforcement, '')
  if (result.rules.adds || result.release) lines.push(ciMarkdownText(ciRulesLine(result)), '')

  const failed = result.checks.filter((check) => !check.ok && check.name !== 'enforcement')
  if (failed.length > 0) {
    lines.push('**Problems:**')
    for (const check of failed) {
      lines.push(`- ✖ ${ciMarkdownText(ciCheckLine(check, result))}`)
      for (const problem of check.problems) lines.push(`  - ${ciMarkdownText(ciProblemLine(problem))}`)
    }
    lines.push('')
  }
  lines.push('<details><summary>Every check</summary>', '')
  for (const check of result.checks) lines.push(`- ${check.ok ? '✔' : '✖'} ${ciMarkdownText(ciCheckLine(check, result))}`)
  lines.push('', '</details>', '')
  return lines.join('\n')
}

/** The Markdown of a check that could not run, such as in a shallow clone. */
export function ciErrorMarkdown(message) {
  return ['### ResaLedger · ✖ the check could not run', '', ciMarkdownText(message), ''].join('\n')
}

/** Appends Markdown to the job summary when GITHUB_STEP_SUMMARY names a file; a failure prints one warning. */
export function writeSummary(env, markdown) {
  const file = env.GITHUB_STEP_SUMMARY
  if (!file) return false
  try {
    appendFileSync(file, `${markdown}\n`)
    return true
  } catch (error) {
    console.error(`warning: ResaLedger could not write the job summary: ${error.message}`)
    return false
  }
}

/** One request to the GitHub REST API; throws with the method, the path and the status when it fails. */
async function ciRequest(url, method, token, body) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'resaledger',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(CI_COMMENT_TIMEOUT)
  })
  if (!response.ok) throw new Error(`${method} ${new URL(url).pathname} answered ${response.status}`)
  return response.status === 204 ? null : response.json()
}

/**
 * Posts ResaLedger's comment on a pull request, or updates it in place: lists the comments,
 * finds the one that starts with the marker, and PATCHes it, else POSTs a new one. Returns
 * 'created' or 'updated'; throws when the API fails.
 */
export async function postComment({ api, repository, number, token, markdown }) {
  const root = `${api.replace(/\/+$/, '')}/repos/${repository}`
  const body = `${CI_COMMENT_MARKER}\n${markdown}`
  let existing = null
  for (let page = 1; page <= CI_COMMENT_PAGES && existing === null; page++) {
    const comments = await ciRequest(`${root}/issues/${number}/comments?per_page=100&page=${page}`, 'GET', token)
    if (!Array.isArray(comments)) throw new Error('the list of comments is not a list')
    existing = comments.find((comment) => typeof comment.body === 'string' && comment.body.startsWith(CI_COMMENT_MARKER)) ?? null
    if (comments.length < 100) break
  }
  if (existing) {
    await ciRequest(`${root}/issues/comments/${existing.id}`, 'PATCH', token, { body })
    return 'updated'
  }
  await ciRequest(`${root}/issues/${number}/comments`, 'POST', token, { body })
  return 'created'
}

/**
 * The comment of a CI run: on a pull request from this repository's event, with a token, posts
 * or updates it. Never throws: a failure prints one warning line, and the check is unchanged.
 */
export async function ciComment(env, options, markdown) {
  if (options.event !== 'pull_request' || options.source !== 'github' || !options.number) return null
  if (options.fork) {
    console.log('No pull request comment: the pull request comes from a fork, whose token cannot write.')
    return null
  }
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) return null
  try {
    const api = env.GITHUB_API_URL || 'https://api.github.com'
    const done = await postComment({ api, repository: env.GITHUB_REPOSITORY, number: options.number, token: env.GITHUB_TOKEN, markdown })
    console.log(`Pull request comment ${done}.`)
    return done
  } catch (error) {
    console.error(`warning: ResaLedger could not comment on the pull request: ${error.message}`)
    return null
  }
}
