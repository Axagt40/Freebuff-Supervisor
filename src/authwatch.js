'use strict'

/**
 * Recognise auth failures in freebuff's output. Without a pty only stderr is
 * scanned: stdout stays the TUI's own TTY stream, while stderr carries
 * CLI-level errors. On a pty the two are one stream, so the session output is
 * scanned there instead.
 */
/**
 * Signatures used for freebuff's own stderr, where anything written is a
 * CLI-level error rather than agent output.
 */
const PATTERNS = [
  /unauthori[sz]ed/i,
  /\b401\b[^\n]{0,60}(?:unauthori[sz]ed|forbidden|authentication|credentials?|token|sign[ -]?in|log[ -]?in)/i,
  /(?:unauthori[sz]ed|authentication|credentials?|token|sign[ -]?in|log[ -]?in)[^\n]{0,60}\b401\b/i,
  /authentication (?:failed|error|required)/i,
  /auth(?:entication)? (?:token|credential)s? (?:is |has )?(?:invalid|expired)/i,
  /invalid (?:auth )?token/i,
  /token (?:has )?expired/i,
  /session (?:has )?expired/i,
  /not (?:signed|logged) in/i,
  /please (?:sign|log) in/i,
  /login required/i
]

/**
 * Signatures safe on a merged stream (a pty): the TUI's chrome, the agent's own
 * prose and every command it runs arrive there. A bare "401" or a line such as
 * "not signed in" is ordinary text in a coding session, so only messages that
 * are unmistakably an auth error may mark an account.
 */
const MERGED_PATTERNS = [
  /\b401\b[^\n]{0,60}unauthori[sz]ed/i,
  /unauthori[sz]ed[^\n]{0,60}\b401\b/i,
  /error[^\n]{0,80}\b401\b[^\n]{0,60}(?:authentication|credentials?|token|sign[ -]?in|log[ -]?in)/i,
  /authentication (?:failed|error|required)/i,
  /invalid (?:auth )?token/i,
  /auth(?:entication)? (?:token|credential)s? (?:is |has )?(?:invalid|expired)/i,
  /error[^\n]{0,80}(?:not (?:signed|logged) in|please (?:sign|log) in|login required)/i
]

const TAIL_BYTES = 4000
const SNIPPET_LENGTH = 200

function stripAnsi (text) {
  return String(text)
    .replace(/\x1b\[[0-9;:?<>=]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

function lineAt (text, index) {
  const start = text.lastIndexOf('\n', index) + 1
  let end = text.indexOf('\n', index)
  if (end === -1) end = text.length
  return stripAnsi(text.slice(start, end)).trim().slice(0, SNIPPET_LENGTH)
}

/**
 * Feed stderr chunks as they arrive. Fires at most once per session, so a
 * repeated message cannot mark the account twice.
 */
function createAuthWatcher (onFailure, options = {}) {
  const patterns = options.merged ? MERGED_PATTERNS : PATTERNS
  let tail = ''
  let fired = false

  return function feed (chunk) {
    if (fired) return
    const text = tail + chunk.toString('utf8')
    tail = text.slice(-TAIL_BYTES)

    for (const pattern of patterns) {
      const match = pattern.exec(text)
      if (!match) continue
      fired = true
      const snippet = lineAt(text, match.index)
      onFailure(snippet || 'authentication failure reported by freebuff')
      return
    }
  }
}

module.exports = { createAuthWatcher, PATTERNS, MERGED_PATTERNS }
