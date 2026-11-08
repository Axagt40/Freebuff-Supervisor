'use strict'

/**
 * What a "the session is over" screen means, and what to do about it.
 *
 * A freebuff session can stop making progress for reasons that are not the work
 * being finished, and none of them are a crash:
 *
 *   - the free session expired / was superseded / needs a new waiting-room
 *     slot. freebuff keeps its TUI open and says to send a message to start a
 *     new session.
 *   - the account's free sessions for the day are used up. The TUI stays open
 *     but no message can run until the quota resets.
 *   - the turn hit the model's usage limit, or free mode has no capacity.
 *
 * Before this module the supervisor saw an open, quiet TUI, typed the task at
 * it, pressed Enter when nothing happened, and — after three of those — retired
 * the session and finally stopped with CRITICAL. Restarting could not help: the
 * account had nothing left to run. The loop now recognises the screen, and
 * either sends the message again (freebuff starts a new session) or waits for
 * the reset on another account instead of hammering a dead one.
 *
 * Only the bottom rows of a screen are considered, for the same reason
 * answers.js does it: the agent writes about sessions, limits and credits in
 * ordinary conversation, and a conversation line must never be mistaken for a
 * state.
 */

/** How many bottom rows can hold the state line. */
const TAIL_LINES = 12

/**
 * The meanings, and what the supervisor does with each:
 *
 *   ends      the session cannot run another message; retire it
 *   wait      no retry can help until the quota reset
 *   retype    freebuff says to send the message again; do that
 *   delayMs   how long to let freebuff settle before typing again
 */
const KINDS = {
  'session-limit': { ends: true, wait: true, retype: false, delayMs: 0 },
  'session-ended': { ends: false, wait: false, retype: true, delayMs: 4000 },
  'turn-limit': { ends: false, wait: false, retype: true, delayMs: 5000 },
  capacity: { ends: false, wait: false, retype: true, delayMs: 15000 }
}

/**
 * The wording freebuff 0.2.34 uses (its own bundle, not a guess). Both the
 * user-facing sentences and the API's error codes are matched, because a
 * network-level failure can reach the log without the sentence.
 */
const RULES = [
  // The account has no free sessions left, so no new message can run.
  {
    kind: 'session-limit',
    name: 'session-limit',
    match: /session limit reached|reached your (?:daily|weekly|free) (?:session|usage) limit|(?:out|run out) of free sessions|no free sessions (?:left|remaining)|free sessions? (?:are|have) (?:used up|run out)/i
  },
  {
    kind: 'session-limit',
    name: 'session-limit-code',
    match: /session_limit_reached/
  },
  // This turn used the model's limit, but the session is still usable.
  {
    kind: 'turn-limit',
    name: 'turn-limit',
    match: /this turn reached its model usage limit|turn_spend_limit/i
  },
  // The free session itself is over; a new message starts a new one.
  {
    kind: 'session-ended',
    name: 'free-session-ended',
    match: /your free session ended|this freebuff session has ended|start a new session to (?:try again|continue)/i
  },
  {
    kind: 'session-ended',
    name: 'session-ended-code',
    match: /session_expired|session_superseded|session_model_mismatch|waiting_room_required/
  },
  // Temporary: the message can be sent again shortly.
  {
    kind: 'capacity',
    name: 'busy',
    match: /freebuff is temporarily busy|still being set up|model may be busy or unavailable|model is at capacity|freebuff ran out of provider usage|free_mode_capacity_deferred|free_mode_rate_limited|waiting_room_queued/i
  }
]

function rowsOf (screen) {
  if (Array.isArray(screen)) {
    return screen
      .map((row) => String(row == null ? '' : row).replace(/\s+/g, ' ').trim())
      .filter(Boolean)
  }
  return String(screen == null ? '' : screen)
    .replace(/\r/g, '\n')
    .split('\n')
    .map((row) => row.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/**
 * Read the bottom of a screen (or a log tail) and say what state it shows.
 *
 * @param {string|string[]} screen
 * @returns {{kind:'none'|'session-limit'|'session-ended'|'turn-limit'|'capacity', name?:string, message?:string, ends?:boolean, wait?:boolean, retype?:boolean, delayMs?:number}}
 */
function detect (screen) {
  const rows = rowsOf(screen)
  if (rows.length === 0) return { kind: 'none' }

  const tail = rows.slice(-TAIL_LINES)
  for (const rule of RULES) {
    const line = tail.slice().reverse().find((row) => rule.match.test(row))
    if (!line) continue
    return {
      kind: rule.kind,
      name: rule.name,
      message: line.slice(0, 300),
      ...KINDS[rule.kind]
    }
  }
  return { kind: 'none' }
}

/** True when nothing can run until the account's quota resets. */
function isLimit (verdict) {
  return Boolean(verdict && verdict.kind === 'session-limit')
}

/** True when the session cannot be used again even by typing at it. */
function retires (verdict) {
  return Boolean(verdict && verdict.ends)
}

/** A short phrase for a log line or a spoken reply. */
function describe (verdict) {
  if (!verdict || verdict.kind === 'none') return 'running normally'
  if (verdict.kind === 'session-limit') return 'free sessions used up — waiting for the reset'
  if (verdict.kind === 'session-ended') return 'free session ended — continuing in a new session'
  if (verdict.kind === 'turn-limit') return 'turn usage limit — continuing in a new turn'
  return 'freebuff is busy — retrying shortly'
}

module.exports = {
  TAIL_LINES,
  KINDS,
  RULES,
  detect,
  isLimit,
  retires,
  describe,
  rowsOf
}
