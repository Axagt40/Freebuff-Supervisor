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
const OWN_PROMPT =
  /^(Continue the unfinished task from the previous session|Continue working on the task)\b/i

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

/** Extract the readable text of a chat block or content field. */
function textFrom (value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((item) => textFrom(item)).filter(Boolean).join(' ')
  }
  if (!value || typeof value !== 'object') return ''
  if (typeof value.text === 'string') return value.text
  if (typeof value.content === 'string') return value.content
  if (Array.isArray(value.content)) return textFrom(value.content)
  return ''
}

/** True when this chat record is something the person typed. */
function isUserMessage (message) {
  const role = String(
    message.variant || message.role || message.type || message.author || message.sender || ''
  )
  return /^(user|human|person)$/i.test(role)
}

/**
 * The newest user message in one conversation, oldest file entries last.
 *
 * The account-wide history can be written slightly behind the conversation, so
 * after a restart it may still end with a prompt from several turns ago. The
 * resumed chat's own transcript is the exact conversation being continued.
 */
function lastChatTask (chatDir, options) {
  if (!chatDir) return null
  let raw
  try {
    raw = JSON.parse(
      fs.readFileSync(path.join(chatDir, 'chat-messages.json'), 'utf8')
    )
  } catch {
    return null
  }
  const messages = Array.isArray(raw)
    ? raw
    : (raw && Array.isArray(raw.messages) ? raw.messages : [])

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || typeof message !== 'object' || !isUserMessage(message)) continue
    const text = textFrom(message.content) || textFrom(message.blocks)
    if (!text) continue
    const usable = usableTask(text, options)
    if (usable) return usable
  }
  return null
}

/** The one-line form of a prompt, or null when it is not a real task. */
function usableTask (text, options) {
  const flat = oneLine(text, options.max)
  if (!flat) return null
  if (OWN_PROMPT.test(flat)) return null
  if (options.ignore.has(flat)) return null
  if (CONTINUATION_PROMPT.test(flat)) return null
  return flat
}

/**
 * The last real task typed in an account, or null when nothing usable is there.
 *
 * The supervisor's own continue prompts are skipped, as are bare "keep going"
 * nudges: otherwise every restart would feed its own text back in and the task
 * would grow on each attempt. When the conversation being resumed is known, its
 * own newest user message wins over the account-wide history, which can lag.
 */
function lastTask (configDir, options = {}) {
  const ignore = new Set((options.ignore || []).map((text) => oneLine(text)))
  const settings = { ...options, ignore }

  const fromChat = lastChatTask(options.chatDir, settings)
  if (fromChat) return fromChat

  const history = readHistory(configDir)
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const text = usableTask(history[index], settings)
    if (text) return text
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
  lastChatTask,
  lastTask,
  continuePrompt
}
