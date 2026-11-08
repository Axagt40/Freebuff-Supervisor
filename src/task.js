'use strict'

/**
 * What to type at an automatically started session so it carries on with the
 * task instead of waiting at an empty prompt.
 *
 * freebuff takes no prompt as an argument — its only positional is `login`, and
 * `--continue` would read a trailing word as a conversation id — so the text is
 * typed into the session (which needs `--pty`). The text matters: a session that
 * opens on a different account has none of the previous conversation, and even
 * the same account does not always come back to the old chat, so "continue"
 * alone leaves the new session guessing what the task was. freebuff records
 * every prompt the user typed in that account's `message-history.json`, so the
 * last real one is the best one-line statement of what to continue.
 */

const fs = require('fs')
const path = require('path')

/** Longest task text typed back into a session, in characters. */
const MAX_TASK_CHARS = 1500

/** Every prompt this module builds starts this way, so it can spot its own. */
const CONTINUE_PREFIX =
  'Continue the unfinished task from the previous session; do not start over.'

/** Matches this module's text and the earlier wording of it, so neither is
 * ever picked up as the task on the next restart. */
const OWN_PROMPT = /^Continue the unfinished task from the previous session\b/i

/**
 * A bare "carry on"-style prompt says nothing about the work itself; it is not
 * worth typing back at a fresh session.
 */
const CONTINUATION_PROMPT = /^(continue|carry on|keep going|go on|resume|proceed)\b[^\n]{0,40}$/i

/** Collapse whitespace: the TUI submits on a newline, so the text is one line. */
function oneLine (text, max = MAX_TASK_CHARS) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/** The prompts this account's user typed, oldest first. */
function readHistory (configDir) {
  if (!configDir) return []
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(configDir, 'message-history.json'), 'utf8')
    )
    return Array.isArray(raw) ? raw.filter((entry) => typeof entry === 'string') : []
  } catch {
    return []
  }
}

/**
 * The last real task typed in an account, or null when nothing usable is there.
 *
 * The supervisor's own continue prompts are skipped, as are bare "keep going"
 * nudges: otherwise every restart would feed its own text back in and the task
 * would grow on each attempt.
 */
function lastTask (configDir, options = {}) {
  const ignore = new Set((options.ignore || []).map((text) => oneLine(text)))
  const history = readHistory(configDir)

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const text = oneLine(history[index], options.max)
    if (!text) continue
    if (OWN_PROMPT.test(text)) continue
    if (ignore.has(text)) continue
    if (CONTINUATION_PROMPT.test(text)) continue
    return text
  }
  return null
}

/**
 * The continue prompt: the configured fallback plus the task itself when it is
 * known. Without a task this is exactly the fallback, so the old behaviour is
 * preserved on a machine where nothing was ever typed.
 */
function continuePrompt (fallback, task, options = {}) {
  const text = oneLine(task, options.max)
  if (!text) return fallback
  return `${CONTINUE_PREFIX} The last thing the user asked for was: "${text}". ` +
    'Check the repository and any notes from earlier sessions for what is ' +
    'already done, then finish the remaining work.'
}

module.exports = {
  MAX_TASK_CHARS,
  CONTINUE_PREFIX,
  oneLine,
  readHistory,
  lastTask,
  continuePrompt
}
