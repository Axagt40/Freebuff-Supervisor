'use strict'

/**
 * Automatic error debugging for a supervised session.
 *
 * When freebuff exits badly, stalls or never sends a typed prompt, the first
 * question is always the same: why? The supervisor already holds the evidence —
 * the exit status, the last screen text and a few local checks — so this module
 * turns it into a cause, an action and one report per failed session, written
 * next to the supervisor log. It never throws: a failed diagnosis must not take
 * the supervisor down with it.
 */

const fs = require('fs')
const path = require('path')
const { paths } = require('./paths')
const { logLine, logEvent } = require('./log')
const { shortHome, formatDuration } = require('./util')
const ptyrun = require('./ptyrun')
const accounts = require('./accounts')

/** How much of the last screen is kept in a report. */
const TAIL_CHARS = 4000

/** Trim a matched line down to something readable in the log. */
function snippet (line) {
  return String(line || '').replace(/\s+/g, ' ').trim().slice(0, 200)
}

/** The line of output that matched, or the last non-empty one. */
function lineWith (tail, pattern) {
  const lines = String(tail || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const hit = lines.find((line) => pattern.test(line))
  return hit || lines[lines.length - 1] || ''
}

/**
 * The failures a supervised session actually has, most actionable first. Each
 * rule names what happened and what a person (or the next attempt) should do,
 * so the log says more than "exit code 1".
 */
const RULES = [
  {
    cause: 'authentication failed',
    match: (evidence) =>
      /\b401\b|unauthori[sz]ed|authentication (?:failed|error|required)|invalid (?:auth )?token|token (?:has )?expired/i
        .test(evidence.tail),
    detail: (evidence) =>
      snippet(lineWith(evidence.tail, /401|unauthori|authentication|token/i)),
    action: (evidence) =>
      `run \`sfreebuff login --account ${evidence.accountId || '<id>'}\`, then start it again`
  },
  {
    cause: 'free sessions used up',
    match: (evidence) => Boolean(evidence.limit && evidence.limit.kind === 'session-limit'),
    detail: (evidence) =>
      evidence.limit.message || 'the account has no free sessions left',
    action: () =>
      'the supervisor switches to another account, or waits for the free-session reset and continues the task'
  },
  {
    cause: 'free session ended',
    match: (evidence) => Boolean(evidence.limit && evidence.limit.kind === 'session-ended'),
    detail: (evidence) => evidence.limit.message || 'freebuff ended the free session',
    action: () => 'the task is typed into the new session and the work continues'
  },
  {
    cause: 'usage limit for this turn',
    match: (evidence) => Boolean(evidence.limit && evidence.limit.kind === 'turn-limit'),
    detail: (evidence) => evidence.limit.message || 'the turn reached its model usage limit',
    action: () => 'the task is sent again as a new message, which continues from the same session'
  },
  {
    cause: 'freebuff is busy',
    match: (evidence) => Boolean(evidence.limit && evidence.limit.kind === 'capacity'),
    detail: (evidence) => evidence.limit.message || 'free mode has no capacity right now',
    action: () => 'the message is retried shortly, without restarts counting as failures'
  },
  {
    cause: 'typed prompt was never sent',
    match: (evidence) => Boolean(evidence.stuck),
    detail: () => 'the prompt stayed in the input box after repeated Enter presses',
    action: () =>
      'the session was retired and the conversation relaunched with the task; ' +
      'if it keeps happening, check that the freebuff TUI accepts typed text'
  },
  {
    cause: 'no progress',
    match: (evidence) => Boolean(evidence.stalled),
    detail: (evidence) =>
      `nothing was recorded in freebuff's config dir for ${formatDuration(evidence.quietMs || 0)}`,
    action: () => 'the session was restarted with the unfinished task'
  },
  {
    cause: 'out of disk space',
    match: (evidence) => /ENOSPC|no space left on device/i.test(evidence.tail),
    detail: (evidence) => snippet(lineWith(evidence.tail, /ENOSPC|no space/i)),
    action: (evidence) => `free space on the disk holding ${shortHome(evidence.cwd || '')}`
  },
  {
    cause: 'port already in use',
    match: (evidence) => /EADDRINUSE|address already in use/i.test(evidence.tail),
    detail: (evidence) => snippet(lineWith(evidence.tail, /EADDRINUSE|address already in use/i)),
    action: () => 'stop the process holding the port, then start it again'
  },
  {
    cause: 'missing command',
    match: (evidence) => /command not found|ENOENT|not recognized as an internal/i.test(evidence.tail),
    detail: (evidence) =>
      snippet(lineWith(evidence.tail, /command not found|ENOENT|not recognized/i)),
    action: () => 'install the missing program, or fix the PATH the session runs with'
  },
  {
    cause: 'terminal problem',
    match: (evidence) =>
      /node-pty|not a tty|ENOTTY|could not set raw mode/i.test(evidence.tail),
    detail: (evidence) => snippet(lineWith(evidence.tail, /node-pty|tty|raw mode/i)),
    action: () => 'run `sfreebuff doctor` and reinstall with node-pty available'
  }
]

/**
 * Name the failure from the evidence at hand.
 *
 * @param {object} evidence
 * @param {number|null} evidence.code
 * @param {string|null} evidence.signal
 * @param {boolean} [evidence.stalled]
 * @param {boolean} [evidence.stuck]
 * @param {string} [evidence.tail]
 * @param {number} [evidence.quietMs]
 * @param {string} [evidence.cwd]
 * @param {string} [evidence.accountId]
 * @returns {{cause:string, detail:string, action:string}}
 */
function classify (evidence = {}) {
  const input = {
    code: null,
    signal: null,
    stalled: false,
    stuck: false,
    tail: '',
    quietMs: 0,
    cwd: '',
    accountId: '',
    ...evidence
  }

  for (const rule of RULES) {
    if (!rule.match(input)) continue
    return {
      cause: rule.cause,
      detail: rule.detail(input),
      action: rule.action(input)
    }
  }

  if (input.signal) {
    return {
      cause: `terminated by ${input.signal}`,
      detail: snippet(lineWith(input.tail, /.*/)),
      action: 'the session was restarted; run `sfreebuff logs` if it keeps happening'
    }
  }

  if (input.code !== null && input.code !== 0) {
    return {
      cause: `freebuff exited with code ${input.code}`,
      detail: snippet(lineWith(input.tail, /error|failed|fatal/i)),
      action: 'the session was restarted; run `sfreebuff doctor` if it keeps happening'
    }
  }

  return {
    cause: 'session ended',
    detail: '',
    action: 'nothing to fix'
  }
}

/**
 * Local facts worth having in the report. Every check is optional: a probe that
 * cannot answer reports its error instead of failing the diagnosis.
 */
function checks (evidence = {}) {
  const results = []

  const binary = process.env.FREEBUFFS_BINARY || ''
  results.push(
    binary
      ? `${fs.existsSync(binary) ? 'ok' : 'missing'}     freebuff binary ${shortHome(binary)}`
      : 'unknown  freebuff binary (not overridden by FREEBUFFS_BINARY)'
  )

  results.push(
    `${ptyrun.available() ? 'ok' : 'missing'}     node-pty ${ptyrun.available() ? 'available' : 'not installed — no pty, so nothing can be typed at the TUI'}`
  )

  try {
    const facts = fs.statfsSync(evidence.cwd || process.cwd())
    const freeGb = (facts.bavail * facts.bsize) / (1024 ** 3)
    results.push(`${freeGb > 0.2 ? 'ok' : 'low'}     disk free ${freeGb.toFixed(1)} GB`)
  } catch (error) {
    results.push(`unknown  disk free (${error.message})`)
  }

  results.push(`ok     node ${process.version}`)

  if (evidence.account) {
    const signedIn = accounts.isSignedIn(evidence.account)
    results.push(
      `${signedIn ? 'ok' : 'missing'}     credentials for ${evidence.account.id} (${shortHome(accounts.credentialsPath(evidence.account))})`
    )
  }

  return results
}

/**
 * Turn evidence into a diagnosis, write it next to the supervisor log and
 * record the event. Called when a session ends badly, so a person can read what
 * happened later without replaying the terminal.
 */
function record (label, evidence = {}) {
  const diagnosis = classify(evidence)
  let file = null

  try {
    const logsDir = paths().logsDir
    fs.mkdirSync(logsDir, { recursive: true })
    file = path.join(logsDir, `diagnose-${label}.log`)
    const body = [
      `# sfreebuff session diagnosis`,
      ``,
      `when        ${new Date().toISOString()}`,
      `session     ${label}`,
      `account     ${evidence.accountId || 'unknown'}`,
      `folder      ${shortHome(evidence.cwd || '')}`,
      `exit        ${evidence.code == null ? 'none' : evidence.code}${evidence.signal ? ` (signal ${evidence.signal})` : ''}`,
      `duration    ${formatDuration(evidence.elapsedMs || 0)}`,
      `stalled     ${Boolean(evidence.stalled)}`,
      `stuck       ${Boolean(evidence.stuck)}`,
      `limit       ${evidence.limit ? `${evidence.limit.kind} — ${evidence.limit.message || ''}` : 'none'}`,
      ``,
      `cause       ${diagnosis.cause}`,
      `detail      ${diagnosis.detail || '—'}`,
      `action      ${diagnosis.action}`,
      ``,
      `## checks`,
      ...checks(evidence).map((line) => `  ${line}`),
      ``,
      `## last screen`,
      evidence.tail ? evidence.tail.slice(-TAIL_CHARS) : '  (nothing captured)',
      ``
    ].join('\n')
    fs.writeFileSync(file, body)
  } catch (error) {
    file = null
    logLine('warn', 'diagnosis report could not be written', { error: error.message })
  }

  logLine('warn', 'session diagnosed', {
    session: label,
    cause: diagnosis.cause,
    action: diagnosis.action
  })
  logEvent('session.diagnose', {
    session: label,
    account: evidence.accountId || null,
    cause: diagnosis.cause,
    detail: diagnosis.detail || null,
    action: diagnosis.action,
    report: file
  })

  return { ...diagnosis, file }
}

module.exports = {
  RULES,
  classify,
  checks,
  record
}
