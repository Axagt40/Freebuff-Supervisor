'use strict'

/**
 * Running freebuff on a pseudo-terminal so the supervisor can answer the
 * dialogs freebuff shows itself.
 *
 * Without this the launcher hands freebuff the real terminal and only watches
 * from the outside, where its dialogs are invisible. On a PTY the supervisor
 * sits between the two: bytes freebuff writes are forwarded to the terminal
 * unchanged, keystrokes are forwarded in, and the same byte stream is scanned
 * for prompts worth answering.
 *
 * node-pty is the only way to do this properly, since a TUI needs a real
 * terminal for size, raw mode and resizes. It is an optional dependency, used
 * by default when installed (`--no-pty` turns the mode off). Without it a
 * session is a plain launch, and an explicit `--pty` fails with an explanation
 * instead of quietly behaving like one.
 */

const { decide } = require('./answers')
const dialog = require('./dialog')
const live = require('./live')
const limits = require('./limits')
const { logLine, logEvent } = require('./log')

const SCAN_WINDOW = 4000
const ANSWER_COOLDOWN_MS = 1500
const DIALOG_TTL_MS = 5 * 60 * 1000
/**
 * How long a reported question has to be off screen before seeing it again is
 * a new dialog rather than the same one still waiting. A question that is on
 * screen keeps refreshing its sighting (see `noteEscalated`), so it is reported
 * once no matter how long it is left waiting; only something that disappeared
 * for this long and then came back rings again.
 */
const DIALOG_GONE_MS = 10 * 60 * 1000
/** A repeated answer (a retry screen) may be pressed again this often. */
const REPEAT_ANSWER_MS = 4000
/** How long after starting a resumed session to type the continue prompt. */
const DEFAULT_RESUME_MS = 8 * 1000
/** How quiet the TUI must be before that prompt is typed. */
const DEFAULT_RESUME_IDLE_MS = 2000
/** Never hold the prompt back longer than this, even while output streams. */
const RESUME_DEADLINE_MS = 30 * 1000
/**
 * How long to wait between typing the text and pressing Enter. A TUI reads a
 * chunk holding both as pasted text, so the message lands in the prompt and is
 * never sent; Enter has to arrive as its own key press.
 */
const SUBMIT_DELAY_MS = 150
/**
 * How long to wait after clicking the input box before typing into it.
 *
 * freebuff only takes typed text while its input box has focus, and in a
 * terminal that focus is what a mouse click gives it. Clicking and pasting in
 * the same chunk loses the click (the TUI redraws on it), so the paste follows
 * a moment later.
 */
const CLICK_SETTLE_MS = 140
/**
 * How long a typed prompt may go without any work happening before the
 * watchdog presses Enter again. A prompt left sitting in the TUI's input box is
 * invisible from the outside, so this is the only way to notice it.
 */
const SUBMIT_VERIFY_MS = 6000
/** How many extra Enter presses before the prompt is typed in again. */
const MAX_ENTER_RETRIES = 3
/**
 * How many times a prompt that never reached the input box is typed in again.
 * A paste the TUI does not understand is lost entirely, and pressing Enter at
 * an empty input box can never send it; typing the text as plain keystrokes is
 * the last resort before the session is reported rather than killed.
 */
const MAX_RESENDS = 2
/**
 * How many times freebuff's own "send a message again" state may be answered.
 * A free session that ended starts a new one when a message arrives, and a
 * turn that hit its usage limit continues from the next message, so typing the
 * task again is exactly what freebuff asks for. A session that keeps asking
 * after a couple of tries is retired so the 24/7 loop can relaunch it cleanly
 * instead of pressing Enter at a screen that will never take the message.
 */
const MAX_LIMIT_RETYPES = 2
/** Do not report the same session state more than this often. */
const LIMIT_REPORT_MS = 60 * 1000
/**
 * After a decision arrives from the phone, the dialog it answered may still be
 * in the scroll buffer for a moment. Do not report that same question again
 * during this window; freebuff redraws, so a dialog that really survived will
 * be reported again after it.
 */
const REMOTE_ANSWER_GRACE_MS = 20 * 1000
/** A screen that keeps drawing for this long is treated as working. */
const SUBMIT_GIVE_UP_MS = 60 * 1000
/** How often the watchdog samples progress and the pending prompt. */
const WATCHDOG_MS = 1000
/**
 * How much recent screen text is searched for an unsent prompt. freebuff
 * repaints the whole screen, so this has to hold a frame rather than a line of
 * it.
 */
const SCREEN_TAIL = 16000
/** The input box is drawn at the bottom; only the last rows describe it. */
const INPUT_ROWS = 8
/**
 * The longest wait between two nudges. A session that ignores a nudge is pushed
 * again farther apart, never left alone: a task abandoned at an idle prompt is
 * the failure the supervisor exists to prevent.
 */
const MAX_NUDGE_GAP_MS = 30 * 60 * 1000
/**
 * How recently the screen must have changed for its turn status row to mean a
 * turn that is running now.
 *
 * freebuff keeps the last status row on screen after a turn ends: the row that
 * read `⎘ • 3s • △▽` while it ran stays there, frozen, once the reply is in.
 * Its elapsed time is what ticks while the turn is live, so a row that has
 * stopped moving is the remains of a turn, not a turn. Without this an idle
 * session looked busy forever and nothing — no nudge, no retry, no restart —
 * was ever allowed to touch it.
 */
const BUSY_FRESH_MS = 4000
/**
 * How long a session may be quiet before a "Session limit reached" line is
 * believed.
 *
 * That sentence is freebuff's own notice, and it is also a sentence an agent
 * writes while it works — this repository's README quotes it word for word.
 * Taking the account out of rotation, retiring the session and ringing the
 * phone over a line in the transcript is a fault that does not exist. A real
 * limit means nothing can run, so the session records no work either.
 */
const LIMIT_QUIET_MS = 20 * 1000
/**
 * How long an interrupted turn may sit on an idle session before the task is
 * typed again.
 *
 * freebuff writes `[response interrupted]` into the conversation when a turn is
 * stopped — a 503, a killed tool, a stray Esc. The session stays alive and waits
 * for a message, and nothing else ever starts it again, so waiting for the
 * five-minute idle nudge left the work looking abandoned. This is the same
 * marker work.js reads to say "interrupted" instead of "working".
 */
const INTERRUPTED_MARK = /\[response interrupted\]/i
/** Let the TUI settle after the interruption before typing at it. */
const INTERRUPTED_SETTLE_MS = 3 * 1000

/**
 * Bracketed paste, the way a terminal hands pasted text to an application. A
 * TUI inserts a paste literally, so no character in it can be read as one of
 * its own keys — without this, a mangled write can leave a lone "?" in the
 * input box, which opens freebuff's help screen (and Esc there stops the turn).
 */
const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'
/** How long before the same help screen may be closed again. */
const HELP_COOLDOWN_MS = 10 * 1000

/**
 * How much of the stream is kept for spotting freebuff's help screen. It has to
 * outlast the animations the TUI draws over it, which put a few kilobytes
 * between the shortcut rows and the newest byte.
 */
const HELP_WINDOW = 16000

const SCREEN_ANSI = /\u001b\[[0-9;:?<>=]*[ -/]*[@-~]/g

/** Wrap text in bracketed-paste markers, minus any of its own. */
function pasteText (text) {
  return `${PASTE_START}${String(text).replace(/\u001b\[20[01]~/g, '')}${PASTE_END}`
}

/** The TUI's drawing, without the escape sequences that position it. */
function plainScreen (text) {
  return String(text)
    .replace(SCREEN_ANSI, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

/**
 * Is the typed prompt still waiting in the TUI's input box?
 *
 * A submitted prompt moves up into the conversation, so the difference is not
 * "the text is on screen" — after sending it is the last thing on screen. What
 * separates the two is where it sits relative to the empty input box: when the
 * input box is empty the TUI draws its placeholder, and a message in the
 * conversation is drawn above that. Text below the placeholder (or text on a
 * screen without one) is still in the box, waiting to be sent.
 */
function promptOnScreen (buffer, text) {
  const probe = probeFor(text)
  if (!probe) return false
  const rows = screenRows(buffer)

  const textAt = rows.reduce(
    (found, row, index) => (row.includes(probe) ? index : found),
    -1
  )
  if (textAt < 0) return false

  // A message the TUI has not sent is still inside its input box, and that box
  // draws a vertical border either side of the text. A message that was sent
  // moves into the conversation without one. This is what tells the two apart
  // while a turn runs: freebuff does not draw the empty box's placeholder then,
  // so a sent message used to look unsent and was pressed at again.
  const row = rows[textAt]
  if (/^[│|]/.test(row)) return true

  // The placeholder row is the empty input box; anything above it is history.
  const boxAt = rows.reduce(
    (found, row, index) => (isBoxRow(row) ? index : found),
    -1
  )
  return boxAt === -1 || textAt > boxAt
}

/** Is the prompt written anywhere on the recent screen, sent or not? */
function textOnScreen (buffer, text) {
  const probe = probeFor(text)
  if (!probe) return false
  return screenRows(buffer).some((row) => row.includes(probe))
}

/**
 * Is freebuff drawing a turn status row at all?
 *
 * The row is a spinner and, while the turn runs, its elapsed time. It is left
 * on screen when the turn ends, so on its own it does not mean "busy" — the
 * watchdog pairs it with a screen that is still moving (see BUSY_FRESH_MS).
 */
function busyOnScreen (buffer) {
  return screenRows(buffer).some(isBusyRow)
}

/**
 * Is a turn running, rather than only the status row it left behind?
 *
 * A running turn keeps ticking the elapsed time in its status row, so that row
 * keeps changing; the row of a turn that ended — finished or interrupted —
 * sits there frozen. `lastStatusAt` is when the row last changed, so anything
 * else on screen redrawing (an Enter of ours, a sidebar blink) cannot pass for
 * a turn that is working.
 */
function turnRunning (buffer, lastStatusAt, now = Date.now()) {
  if (!busyOnScreen(buffer)) return false
  return now - lastStatusAt <= BUSY_FRESH_MS
}

/**
 * One row of a turn status, as freebuff draws it above its input box.
 *
 * Two shapes exist: the older `• Thinking` line, and the current row of status
 * glyphs with the turn's elapsed time (`⎘ • 3s • △▽`). Both are the whole row.
 * The transcript also contains `• Thinking` once a turn is over — followed by
 * the agent's words, and occasionally `[response interrupted]` — which is a
 * record of a turn, never a running one. Matching that row was what made an
 * idle session look permanently busy.
 */
function isBusyRow (row) {
  const text = String(row).trim()
  if (!text) return false
  if (/^[•·*]\s*(thinking|working)[\s.:…]*$/i.test(text)) return true
  const elapsed = /\b\d+(?:\.\d+)?\s*(?:s|sec|m|min|h)\b/i
  if (!elapsed.test(text)) return false
  return /^[⎘•·△▽▲▼▄▀▌▐█░▒▓*|\s]+$/.test(text.replace(elapsed, ''))
}


/**
 * Is the TUI showing an empty input box it can take a message in?
 *
 * freebuff draws its placeholder only in an empty, ready box. While a turn is
 * running the box is not drawn that way, and Enter there queues the text behind
 * the running turn instead of sending it — which is why a second copy of the
 * same prompt ends up on screen when the text is typed at it again.
 */
function inputBoxIdle (buffer) {
  return boxIdleRows(screenRows(buffer))
}

/** An empty input box among the bottom rows of a screen. */
function boxIdleRows (rows) {
  return rows.slice(-INPUT_ROWS).some(isBoxRow)
}

/** The bit of the prompt that identifies it, squashed onto one line. */
function probeFor (text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60)
}

/**
 * The words a TUI wrote, with the cursor moves put back.
 *
 * A TUI such as freebuff's repaints by jumping to a position and writing there,
 * not by printing one line after another. Read as plain text, a whole frame is
 * a single line and nothing on it can be located: the input box, its
 * placeholder and the conversation all collapse together. This walks the same
 * stream and rebuilds the rows a person actually sees.
 *
 * Only the moves that position text are tracked; colours and modes do not move
 * it. Absolute positions carry the rows, so starting halfway through a frame is
 * harmless: everything after it lands where it belongs.
 */
function screenGrid (text) {
  const rows = []
  const source = String(text)
  let row = 0
  let col = 0

  const line = () => {
    if (!rows[row]) rows[row] = []
    return rows[row]
  }
  const put = (char) => {
    const cells = line()
    while (cells.length < col) cells.push(' ')
    cells[col] = char
    col += 1
  }
  const moveTo = (nextRow, nextCol) => {
    if (nextRow !== null) row = Math.max(0, nextRow)
    if (nextCol !== null) col = Math.max(0, nextCol)
  }

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]

    if (char === '\u001b') {
      const next = source[index + 1]
      if (next === '[') {
        const match = /^\[([0-9;:?<>=]*)([ -/]*)([@-~])/.exec(source.slice(index + 1, index + 40))
        if (!match) {
          index += 1
          continue
        }
        index += match[0].length
        const params = match[1]
        const final = match[3]
        const first = Number(params.split(';')[0]) || 0
        const second = Number(params.split(';')[1]) || 0
        if (final === 'H' || final === 'f') moveTo((first || 1) - 1, (second || 1) - 1)
        else if (final === 'A') moveTo(row - Math.max(1, first), null)
        else if (final === 'B') moveTo(row + Math.max(1, first), null)
        else if (final === 'C') moveTo(null, col + Math.max(1, first))
        else if (final === 'D') moveTo(null, col - Math.max(1, first))
        else if (final === 'G') moveTo(null, Math.max(1, first) - 1)
        else if (final === 'd') moveTo(Math.max(1, first) - 1, null)
        else if (final === 'J') {
          // A full clear starts a new frame; anything below the cursor only
          // clears what this frame has not drawn yet.
          if (!first || first === 2 || first === 3) {
            rows.length = 0
            row = 0
            col = 0
          }
        } else if (final === 'K') {
          if (rows[row]) rows[row].length = col
        }
        continue
      }
      if (next === ']') {
        // An operating-system command runs until BEL or ST; it draws nothing.
        let end = index + 2
        while (end < source.length && source[end] !== '\u0007' && source[end] !== '\u001b') end += 1
        index = source[end] === '\u0007' ? end : end + 1
        continue
      }
      // A two-character escape that moves nothing (or moves to the origin).
      index += 1
      if (next === 'c' || next === '7') { rows.length = 0; row = 0; col = 0 }
      continue
    }

    if (char === '\n') moveTo(row + 1, 0)
    else if (char === '\r') moveTo(null, 0)
    else if (char === '\b') moveTo(null, col - 1)
    else if (char < ' ') {
      // Other control bytes draw nothing.
    } else put(char)
  }

  return rows.map((cells) => (cells || []).join(''))
}

/** The recent screen as clean, trimmed rows. */
function screenRows (buffer) {
  return screenGrid(String(buffer).slice(-SCREEN_TAIL))
    .map((row) => row.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function loadPty () {
  try {
    return require('node-pty')
  } catch {
    return null
  }
}

function available () {
  return Boolean(loadPty())
}

/**
 * Run freebuff on a PTY.
 *
 * @param {object} options
 * @param {string} options.binary
 * @param {string[]} options.args
 * @param {string} options.cwd
 * @param {object} options.env
 * @param {(prompt: string, decision: object) => void} [options.onEscalate]
 * @param {(decision: object) => void} [options.onAnswer]
 * @param {(chunk: Buffer|string) => void} [options.onOutput]
 *   Everything freebuff writes, before it is forwarded. On a pty stdout and
 *   stderr are one stream, so this is where CLI-level errors (an auth failure)
 *   can still be recognised.
 * @param {(handle: {pid:number|null, kill:(signal:string)=>void}) => void} [options.onSpawn]
 *   The running process, so the caller can record its pid, start the side
 *   monitor and kill it when the session stalls.
 * @param {{text:string, idleMs:number, max?:number}} [options.nudge]
 *   Type this into the session when it has been quiet for `idleMs`, to push an
 *   agent that is waiting rather than working. Repeat nudges are spaced out
 *   (doubling up to {@link MAX_NUDGE_GAP_MS}) and by default never stop; `max`
 *   caps them. freebuff takes no prompt as an argument, so typing is the only
 *   way to do this.
 * @param {{text:string, delayMs?:number, idleMs?:number}} [options.resume]
 *   A session that was restarted (a crash, a stall, a different account) gets
 *   this typed in once, shortly after it starts, so the new session picks the
 *   unfinished task back up instead of waiting at an empty prompt.
 * @param {() => number} [options.progress]
 *   Timestamp of the last real work freebuff recorded (its config dir mtime).
 *   With it the watchdog verifies that a typed prompt was actually sent, and
 *   reports a session that draws output without making progress.
 * @param {(text:string) => void} [options.onStuck]
 *   A typed prompt could not be sent, even after pressing Enter again. Nothing
 *   that is typed at such a session reaches it any more, so the caller should
 *   report it and retire the session rather than leave it sitting there.
 * @param {number} [options.verifyMs]  shorten the prompt verification window
 * @param {number} [options.maxRetries]  cap the extra Enter presses
 * @returns {Promise<{code:number|null, signal:string|null, answered:number, escalated:number, nudges:number, resumed:boolean, enterRetries:number, resends:number, stuck:number, tail:string}>}
 */
function runOnPty (options) {
  const pty = loadPty()
  if (!pty) {
    return Promise.reject(
      new Error(
        'auto-answer needs the optional node-pty dependency. ' +
        'Install it with `npm install node-pty` (or run without --pty).'
      )
    )
  }

  // A session started from the dashboard or the phone on a machine with no
  // window runs detached with its stdio ignored, so there may be no streams at
  // all. The pty still gives freebuff the terminal it needs; only forwarding
  // keys and bytes to a person is skipped.
  const stdin = process.stdin || null
  const stdout = process.stdout || null
  const interactive = Boolean(stdin && stdout && stdin.isTTY && stdout.isTTY)
  // The id this state is published under, so every other process (dashboard,
  // phone) can attach the live screen to the session it belongs to.
  const sessionId = typeof options.sessionId === 'string' && options.sessionId
    ? options.sessionId
    : null

  const child = pty.spawn(options.binary, options.args, {
    name: 'xterm-256color',
    cols: (stdout && stdout.columns) || 80,
    rows: (stdout && stdout.rows) || 24,
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env
  })

  // A pty child that has been reaped leaves its pid number free to be handed
  // to another process, while node-pty's kill() passes that number straight to
  // process.kill(). The launcher schedules SIGTERM and, seconds later, SIGKILL
  // for a session it is retiring; if the session already exited by then, that
  // delayed SIGKILL hit whatever had inherited the pid — on a long-running
  // machine the desktop shell or another supervisor. From then on, a handle for
  // a session that is over refuses to signal anything at all.
  let exited = false

  if (options.onSpawn) {
    try {
      options.onSpawn({
        pid: child.pid || null,
        kill: (signal) => {
          if (exited) return false
          if (!Number.isInteger(child.pid) || child.pid <= 1) return false
          try {
            child.kill(signal)
            return true
          } catch {
            // The session may already have ended.
            return false
          }
        }
      })
    } catch {
      // A failing hook must not take the session down.
    }
  }

  let buffer = ''
  // A longer copy of the same stream, only for recognising the help screen.
  let screen = ''
  let answered = 0
  let escalated = 0
  let nudges = 0
  let lastAnswerAt = 0
  let lastOutputAt = Date.now()
  const startedAt = Date.now()
  let resumed = false
  let lastNudgeAt = 0
  // Pending Enter presses, cleared when the session ends.
  const submitTimers = new Set()
  // Real work, as freebuff records it in its own config dir. Output alone is
  // not progress: a TUI redraws its spinner forever while an agent sits idle.
  const progressStamp = typeof options.progress === 'function' ? options.progress : null
  let lastProgressAt = Date.now()
  // A prompt that was typed but may never have been sent.
  let pendingSubmit = null
  let enterRetries = 0
  let resends = 0
  let stuck = 0
  // Decisions spoken on the phone and typed in here while a dialog is open.
  let remoteAnswers = 0
  let remoteAnswerAt = 0
  // The last "this session cannot run" state seen, and how many times its own
  // "send that again" instruction has been honoured.
  let limitVerdict = null
  let limitRetypes = 0
  let lastLimitReportAt = 0
  // The state the session really is in: a limit line the session was still
  // working through is not one, and is remembered separately so the caller does
  // not act on it from the final screen instead.
  let acceptedLimit = null
  let limitIgnoredFor = null
  // When the state line on screen was first seen, and the line that has already
  // been answered by typing the task in, so one notice is not answered twice.
  let limitSeenAt = 0
  let limitConsumedFor = null
  // When the last turn was recorded as interrupted, and when that interruption
  // was answered by typing the task in again.
  let interruptedAt = 0
  let interruptedHandledAt = 0
  // Whether the TUI draws an input box at all: a freebuff session does, and
  // then the box's placeholder is the signal that it can take a message.
  let boxSeen = false
  // The turn status row as last seen, and when it last changed: a row that
  // stops changing is a turn that is no longer running.
  let lastStatusRow = ''
  let lastStatusAt = Date.now()
  let lastTypedText = null
  let lastIdleReportAt = 0
  let helpClosedAt = 0
  // Does the TUI take mouse input right now? Only then may the supervisor
  // click the input box: a click sequence sent to a TUI without mouse tracking
  // would be read as ordinary input instead.
  let mouseReporting = false
  // The question on screen at the last sample, so a choice can be resolved
  // against what the person is actually looking at.
  let dialogNow = null
  // When a turn last looked like it was running, and when a question was last
  // on screen. A TUI that goes away right after either of those ended the
  // conversation mid-work rather than finishing the task, and the caller needs
  // to know that so it can pick the work back up.
  let lastBusyAt = 0
  let lastDialogAt = 0
  // The question last reported as needing a person, so the two detectors (the
  // answer rules and the screen-row parser) do not ring the phone twice for the
  // same dialog.
  let lastEscalatedQuestion = ''
  let lastEscalatedAt = 0
  // When that question was last on screen. Every sighting refreshes it, which
  // is what makes an open dialog report once rather than once per cooldown.
  let lastEscalatedSeenAt = 0
  // The last published live state, so an unchanged screen is not rewritten
  // every second for nothing.
  let lastPublishedAt = 0
  // Exposed so tests do not have to wait out the real verification window.
  const verifyMs = Math.max(500, options.verifyMs || SUBMIT_VERIFY_MS)
  const maxRetries = options.maxRetries === undefined
    ? MAX_ENTER_RETRIES
    : Math.max(0, options.maxRetries)
  // Exposed like verifyMs: a test must not have to wait out the window a limit
  // line has to outlive before it is believed.
  const limitQuietMs = options.limitQuietMs === undefined
    ? LIMIT_QUIET_MS
    : Math.max(0, options.limitQuietMs)

  /**
   * Click the input box so the TUI gives it focus.
   *
   * Typing at freebuff without this leaves the text nowhere: its input box is
   * only focused by a click, which is why a person has to aim at the box with
   * the mouse before a message is accepted. The click is sent as the same SGR
   * mouse report the terminal would send, at the row the box is drawn on.
   */
  const clickInputBox = () => {
    if (!mouseReporting) return false
    let grid
    try {
      grid = screenGrid(String(buffer).slice(-SCREEN_TAIL))
    } catch {
      return false
    }

    let index = -1
    for (let row = grid.length - 1; row >= 0; row -= 1) {
      if (isBoxRow(grid[row])) {
        index = row
        break
      }
    }
    // A box that already holds text draws no placeholder; its caret row is the
    // one to click, in the last few rows of the screen.
    if (index < 0) {
      for (let row = grid.length - 1; row >= Math.max(0, grid.length - 5); row -= 1) {
        const line = grid[row] || ''
        if (/[│|▏▍]/.test(line) && line.trim()) {
          index = row
          break
        }
      }
    }
    if (index < 1) return false

    const line = grid[index] || ''
    const start = line.search(/\S/)
    const x = Math.max(2, (start >= 0 ? start : 1) + 2)
    const y = index + 1
    try {
      child.write(`\u001b[<0;${x};${y}M\u001b[<0;${x};${y}m`)
      return true
    } catch {
      return false
    }
  }

  /** Run this after focusing the input box, when the TUI takes mouse input. */
  const withFocus = (fn) => {
    if (!clickInputBox()) {
      fn()
      return
    }
    const timer = setTimeout(() => {
      submitTimers.delete(timer)
      fn()
    }, CLICK_SETTLE_MS)
    submitTimers.add(timer)
  }

  /** Press Enter as its own key press, after the text has been inserted. */
  const pressEnter = () => {
    const timer = setTimeout(() => {
      submitTimers.delete(timer)
      try {
        child.write('\r')
      } catch {
        // The session may have just ended.
      }
    }, SUBMIT_DELAY_MS)
    submitTimers.add(timer)
  }

  /** Write a prompt into the TUI, as a paste or as plain keystrokes. */
  const writePrompt = (text, mode) => {
    try {
      child.write(mode === 'keys' ? String(text) : pasteText(text))
      return true
    } catch {
      // The session may have just ended.
      return false
    }
  }

  /**
   * Type text, then press Enter separately so the TUI submits it. The box is
   * clicked first: without focus the paste goes nowhere, which is exactly the
   * "nothing happens until I click the text box" failure.
   */
  const typeThenEnter = (text) => {
    // Marked before the click delay so the watchdog cannot decide the box is
    // idle in between and type a second message on top of this one.
    if (progressStamp) pendingSubmit = { text, at: Date.now(), retries: 0, resends: 0 }
    withFocus(() => {
      if (!writePrompt(text, 'paste')) {
        if (progressStamp) pendingSubmit = null
        return
      }
      lastTypedText = text
      if (progressStamp) pendingSubmit = { text, at: Date.now(), retries: 0, resends: 0 }
      pressEnter()
    })
  }

  /**
   * Type a prompt in again that never made it into the input box.
   *
   * Pressing Enter at an empty input box sends nothing, so a prompt the TUI
   * dropped has to be written a second time. The first retry repeats the
   * paste; after that the text goes in as ordinary keystrokes, which every TUI
   * understands whether or not it supports bracketed paste.
   */
  const resendPrompt = () => {
    const mode = pendingSubmit.resends === 0 ? 'paste' : 'keys'
    const text = pendingSubmit.text
    pendingSubmit.resends += 1
    pendingSubmit.retries = 0
    pendingSubmit.at = Date.now()
    resends += 1
    logLine('warn', 'prompt still not sent — typing it in again', {
      attempt: pendingSubmit.resends,
      mode
    })
    logEvent('session.prompt_resend', {
      attempt: pendingSubmit.resends,
      mode,
      prompt: String(pendingSubmit.text).slice(0, 300)
    })
    // The first attempt may have failed because the box was never focused, so
    // focus it again before the text goes in a second time.
    withFocus(() => {
      if (!writePrompt(text, mode)) {
        pendingSubmit = null
        return
      }
      pressEnter()
    })
  }

  /**
   * Report a prompt that could not be sent, without typing a second copy of it.
   * The caller retires the session: a TUI that will not take a typed message
   * cannot be recovered by typing at it again, and relaunching the same
   * conversation puts the task into a clean input box.
   */
  const reportStuck = () => {
    stuck += 1
    const text = pendingSubmit.text
    pendingSubmit = null
    logLine('warn', 'prompt was typed but never sent', {
      retries: enterRetries,
      resends
    })
    logEvent('session.prompt_stuck', {
      retries: enterRetries,
      resends,
      prompt: String(text).slice(0, 300)
    })
    if (options.onStuck) {
      try {
        options.onStuck(text)
      } catch {
        // A failing hook must not take the session down.
      }
    }
  }

  // Set while a dialog is on screen that the supervisor refused to answer; the
  // nudge must never type into an open dialog. It carries the question and its
  // options when the screen offers choices, so the phone can pick one.
  let pendingDialog = null
  // A dialog stays "seen" so the same question is not answered or reported on
  // every chunk that happens to still show it.
  const seen = new Map()

  const nudge = options.nudge && options.nudge.text
    ? {
        text: options.nudge.text,
        idleMs: Math.max(1000, options.nudge.idleMs || 5 * 60 * 1000),
        // Unlimited by default: an idle task is pushed again and again, at a
        // growing interval, instead of being dropped after a few tries.
        max: options.nudge.max === undefined
          ? Infinity
          : Math.max(0, options.nudge.max)
      }
    : null

  const resume = options.resume && options.resume.text
    ? {
        text: options.resume.text,
        delayMs: Math.max(0, options.resume.delayMs ?? DEFAULT_RESUME_MS),
        idleMs: Math.max(0, options.resume.idleMs ?? DEFAULT_RESUME_IDLE_MS)
      }
    : null

  /**
   * Publish what this pty sees: the phase, the question on screen with its
   * options, the rows themselves, and whether a typed prompt is still waiting
   * to be sent. Other processes read this instead of guessing from chat files,
   * so the phone can show the real screen and answer the real dialog.
   */
  /**
   * Is this question worth reporting, or is it one that is already waiting?
   *
   * A question is reported once for as long as it stays on screen, however long
   * it takes somebody to answer it: the stream and the watchdog keep handing it
   * back, and every sighting refreshes the memory. The old five-minute cooldown
   * re-reported it forever, so a dialog nobody had answered pinged Discord and
   * rang the phone again and again.
   *
   * A question that has been gone for DIALOG_GONE_MS and then shows up again is
   * a new dialog — answered, dismissed, or asked a second time — so that one is
   * reported.
   */
  const noteEscalated = (question, now = Date.now()) => {
    const key = String(question || '')
    if (key && key === lastEscalatedQuestion && now - lastEscalatedSeenAt < DIALOG_GONE_MS) {
      lastEscalatedSeenAt = now
      return false
    }
    lastEscalatedQuestion = key
    lastEscalatedAt = now
    lastEscalatedSeenAt = now
    return true
  }

  const publishLive = (extra = {}) => {
    if (!sessionId) return
    try {
      const rows = screenRows(buffer)
      const now = Date.now()
      live.write(sessionId, {
        // A reaped child's pid is not a live session, and must not be published
        // as one for anything else to signal.
        pid: Number.isInteger(child.pid) && child.pid > 1 ? child.pid : null,
        startedAt: new Date(startedAt).toISOString(),
        phase: dialogNow
          ? 'dialog'
          : limitVerdict && limitVerdict.kind === 'session-limit'
            ? 'limited'
            : extra.busy
              ? 'working'
              : now - lastProgressAt <= 2 * 60 * 1000 ? 'working' : 'waiting',
        busy: Boolean(extra.busy),
        dialog: dialogNow && dialogNow.kind !== 'none' ? dialogNow : null,
        screen: rows.slice(-16),
        box: {
          visible: boxSeen,
          empty: extra.boxIdle === undefined ? boxIdleRows(rows) : Boolean(extra.boxIdle)
        },
        unsent: pendingSubmit ? String(pendingSubmit.text) : '',
        limit: limitVerdict ? limitVerdict.kind : null,
        lastOutputAgoMs: now - lastOutputAt,
        lastProgressAgoMs: now - lastProgressAt,
        counters: { answered, escalated, nudges, resumed, remoteAnswers, enterRetries, resends, stuck }
      })
    } catch {
      // Live data is best effort: a session never fails for its status file.
    }
  }

  /** Keys are unreadable in a log line; keep only what is printable. */
  const describeKeys = (keys) => String(keys).replace(/[\u0000-\u001f\u007f]/g, (char) => {
    const names = { '\r': '\\r', '\n': '\\n', '\t': '\\t', '\u001b': '\\e' }
    return names[char] || `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`
  })

  const onResize = () => {
    try {
      child.resize((stdout && stdout.columns) || 80, (stdout && stdout.rows) || 24)
    } catch {
      // The child may already be gone.
    }
  }

  const onStdin = (chunk) => {
    try {
      child.write(chunk.toString('utf8'))
    } catch {
      // Ignore writes to a closed pty.
    }
  }

  /** Is a turn running now, rather than its status row left on screen? */
  const liveTurn = () => turnRunning(buffer, lastStatusAt)

  /**
   * Does the input box still hold a message that must be left alone?
   *
   * A box that draws its placeholder is empty. One drawn without it is only
   * known to be occupied when no turn is running: freebuff draws no
   * placeholder at all while a turn runs, so the last turn's status row on a
   * still screen is not a reason to treat the box as full.
   */
  const boxHoldsMessage = () => {
    if (!boxSeen || inputBoxIdle(buffer)) return false
    return !busyOnScreen(buffer)
  }

  const nudgeTimer = nudge && nudge.max > 0
    ? setInterval(() => {
        if (nudges >= nudge.max) return
        if (pendingDialog) return
        // A prompt still waiting to be sent owns the input box; typing more at
        // it would only append text to the message that is already there.
        if (pendingSubmit) return
        // A used-up free session cannot run anything until its quota resets;
        // typing at it only fills a box that can never send.
        if (limitVerdict && limitVerdict.kind === 'session-limit') return
        // A turn that is still moving will not take a message: the text would
        // wait in its box, or be appended to the message already there.
        if (liveTurn()) return
        if (boxHoldsMessage()) return
        if (Date.now() - lastOutputAt < nudge.idleMs) return
        // Every ignored nudge doubles the wait, up to the cap. The session is
        // never abandoned; it is just not typed at every few seconds.
        const gap = Math.min(
          MAX_NUDGE_GAP_MS,
          nudge.idleMs * 2 ** Math.max(0, nudges - 1)
        )
        if (lastNudgeAt && Date.now() - lastNudgeAt < gap) return
        nudges += 1
        lastNudgeAt = Date.now()
        lastOutputAt = Date.now()
        logLine('info', 'session nudged', { nudge: nudges })
        logEvent('session.nudge', { nudge: nudges, after: nudge.idleMs })
        typeThenEnter(nudge.text)
      }, Math.max(2000, Math.min(30000, Math.floor(nudge.idleMs / 4))))
    : null
  if (nudgeTimer && nudgeTimer.unref) nudgeTimer.unref()

  // Sample the settle window more than once a second: a one-second tick can
  // land just short of the quiet time and then type the task a full second
  // later — after a short-lived TUI has already gone.
  const resumeTickMs = resume
    ? Math.max(250, Math.min(1000, Math.floor(resume.idleMs / 4)))
    : 1000
  const resumeTimer = resume      ? setInterval(() => {
        if (resumed || pendingDialog) return
        // No message starts a new session when the account has no sessions
        // left; the caller is waiting for the reset instead.
        if (limitVerdict && limitVerdict.kind === 'session-limit') return
        const uptime = Date.now() - startedAt
        if (uptime < resume.delayMs) return
        const quiet = Date.now() - lastOutputAt
        // Wait for the TUI to settle so the prompt is not typed into a redraw,
        // but do not wait forever: a session that keeps emitting output is not
        // coming back to the task by itself.
        const deadline = resume.delayMs + RESUME_DEADLINE_MS
        if (quiet < resume.idleMs && uptime < deadline) return
        // A TUI that draws its input box is ready for a message. Typing before
        // that lands in the splash and is lost, and typing while a turn is
        // really running puts the text in a box that will not submit it. A
        // status row that has stopped moving is neither: waiting for it held
        // every resumed session at the deadline and then typed into whatever
        // was on screen.
        if (!boxSeen && uptime < deadline) return
        if (boxHoldsMessage() && uptime < deadline) return
        if (liveTurn() && uptime < deadline) return
        resumed = true
        logLine('info', 'session resumed', { after: uptime })
        logEvent('session.resume', { afterMs: uptime, quietMs: quiet })
        typeThenEnter(resume.text)
      }, resumeTickMs)
    : null
  if (resumeTimer && resumeTimer.unref) resumeTimer.unref()

  /**
   * The work watchdog. It does two things the output stream cannot: it reads
   * freebuff's own records to see whether work is happening at all, and it
   * makes sure a prompt typed into the TUI was actually sent instead of
   * sitting in the input box while the session looks alive.
   */
  const watchdogTimer = setInterval(() => {
    const now = Date.now()
    const rows = screenRows(buffer)
    // A TUI that draws an input box tells us when it can take a message. Its
    // placeholder is only drawn in an empty box, so seeing it once is enough to
    // know this TUI has one.
    const boxIdle = boxIdleRows(rows)
    if (!boxSeen && boxIdle) boxSeen = true
    // The turn's status row only means a turn is running while it keeps
    // changing. Its elapsed time ticks once a second while the turn works, so
    // an idle session's last row (frozen at its final duration) never does.
    const statusRow = rows.find(isBusyRow) || ''
    if (statusRow && statusRow !== lastStatusRow) {
      lastStatusRow = statusRow
      lastStatusAt = now
    }
    const busy = Boolean(statusRow) && now - lastStatusAt <= BUSY_FRESH_MS
    if (busy) lastBusyAt = now

    // The question on screen, if there is one. A TUI that asks something draws
    // its choices just above where the input box would be, so the rows are the
    // only reliable place to read them — and a row of choices is what a person
    // selects with the arrow keys, not with a `y`.
    const parsed = dialog.parse(rows, { boxIdle })
    if (parsed.kind === 'none') {
      dialogNow = null
    } else {
      dialogNow = parsed
      lastDialogAt = now
      const question = parsed.question || 'freebuff is asking a question'
      if (!pendingDialog || pendingDialog.question !== question) {
        pendingDialog = { prompt: question, question, dialog: parsed, at: now }
        logLine('warn', 'freebuff is waiting on a question', {
          options: parsed.options.length,
          multi: parsed.multi
        })
        logEvent('session.dialog', {
          question: parsed.question,
          multi: parsed.multi,
          options: parsed.options.map((option) => option.text)
        })
        publishLive({ boxIdle, busy })
      }
      if (parsed.strong) {
        // Reported once while it stays on screen: a dialog that is still
        // waiting has already pinged Discord and rung the phone.
        if (noteEscalated(question)) {
          escalated += 1
          logLine('warn', 'choice dialog left for a person', {
            options: parsed.options.length
          })
          logEvent('dialog.escalate', {
            rule: 'choice-dialog',
            question: parsed.question,
            multi: parsed.multi,
            options: parsed.options
          })
          if (options.onEscalate) {
            try {
              options.onEscalate(question, {
                action: 'escalate',
                name: 'choice-dialog',
                prompt: parsed.question,
                question: parsed.question,
                options: parsed.options,
                multi: parsed.multi
              })
            } catch {
              // A failing hook must not take the session down.
            }
          }
        }
      }
    }

    if (progressStamp) {
      try {
        const stamp = progressStamp()
        if (Number.isFinite(stamp) && stamp > lastProgressAt) lastProgressAt = stamp
      } catch {
        // A probe must never break the session.
      }
    }

    // A turn freebuff itself recorded as interrupted is over: the session is
    // alive and doing nothing until a message arrives. That is a real stop, so
    // the task is typed in as soon as the TUI is ready instead of leaving it
    // for the idle nudge minutes later. Nothing is typed while a turn is still
    // running, while a dialog is open or while a prompt of ours is waiting, and
    // the marker is answered once — only work recorded after it, or the marker
    // scrolling away, makes another interruption new.
    const interruptedOnScreen = rows.some((row) => INTERRUPTED_MARK.test(row))
    if (interruptedOnScreen) {
      if (!interruptedAt) interruptedAt = now
    } else if (interruptedAt) {
      interruptedAt = 0
      interruptedHandledAt = 0
    }
    if (
      interruptedAt &&
      !interruptedHandledAt &&
      lastProgressAt <= interruptedAt &&
      !pendingSubmit &&
      !pendingDialog &&
      !busy &&
      (!boxSeen || boxIdle) &&
      !(limitVerdict && limitVerdict.kind !== 'none') &&
      now - interruptedAt >= INTERRUPTED_SETTLE_MS
    ) {
      const text = resume && !resumed
        ? null
        : (resume ? resume.text : (nudge ? nudge.text : null))
      if (text) {
        interruptedHandledAt = now
        logLine('warn', 'the turn was interrupted — continuing the task', {})
        logEvent('session.interrupted_continue', { at: new Date(now).toISOString() })
        typeThenEnter(text)
      }
    }

    // freebuff's own "this session cannot run" screens. Read before the prompt
    // verification below: pressing Enter at a used-up account, or retiring a
    // session that only needs its message typed into a new one, is what made an
    // automatic restart look stuck.
    const limit = limits.detect(rows)
    if (limit.kind !== 'none') {
      if (!limitVerdict || limitVerdict.kind !== limit.kind) {
        limitVerdict = limit
        limitRetypes = 0
        limitSeenAt = now
        limitConsumedFor = null
        logLine('warn', `session state: ${limits.describe(limit)}`, {})
        logEvent('session.limit', {
          kind: limit.kind,
          name: limit.name,
          message: limit.message,
          wait: Boolean(limit.wait)
        })
      }
      // "Session limit reached" is freebuff's own notice, and it is also what
      // an agent writes about while it works on this very repository. Retiring
      // the account, killing the session and ringing the phone over a line in
      // the transcript is a fault that does not exist, so the report waits
      // until the session is genuinely not working: a real limit means nothing
      // can run.
      const believable = limit.kind !== 'session-limit' ||
        !progressStamp ||
        now - lastProgressAt >= limitQuietMs
      if (believable) {
        acceptedLimit = limit
        limitIgnoredFor = null
      } else if (limit.kind === 'session-limit') {
        limitIgnoredFor = limit.message || ''
      }
      if (believable && options.onLimit && now - lastLimitReportAt >= LIMIT_REPORT_MS) {
        lastLimitReportAt = now
        try {
          options.onLimit(limit)
        } catch {
          // A failing hook must not take the session down.
        }
      }

      // freebuff ended the free session (or a turn hit its usage limit, or free
      // mode is busy) and asked for the message again. Typing it is what
      // continues the work; waiting for the idle nudge left the task sitting on
      // a screen that had said exactly what to do.
      //
      // Only an empty input box with nothing else going on is typed into, and
      // the same notice is answered once: freebuff keeps it in the transcript
      // after the new session starts, and answering that copy again would send
      // the task twice.
      const retypeText = resume && !resumed
        // The resume prompt has its own timer; a second copy here would append
        // the task to the prompt that is already on its way.
        ? null
        : (resume ? resume.text : (nudge ? nudge.text : null))
      if (
        limit.retype &&
        retypeText &&
        limitRetypes < MAX_LIMIT_RETYPES &&
        limitConsumedFor !== limit.message &&
        !pendingSubmit &&
        !pendingDialog &&
        !busy &&
        now - limitSeenAt >= Math.max(0, limit.delayMs || 0)
      ) {
        limitConsumedFor = limit.message
        limitRetypes += 1
        limitSeenAt = now
        logLine('info', 'freebuff asked for the message again — typing it', {
          state: limit.kind,
          attempt: limitRetypes
        })
        logEvent('session.limit_retype_screen', {
          state: limit.kind,
          attempt: limitRetypes
        })
        typeThenEnter(retypeText)
      }
    } else if (limitVerdict && limitVerdict.kind !== 'session-limit') {
      // The screen moved on: a new session started or the turn resumed.
      limitVerdict = null
      limitRetypes = 0
      limitConsumedFor = null
      acceptedLimit = null
    }

    // Work spoken on the phone: a task queued by the voice line is typed into
    // the session like any other prompt, but only into an empty input box with
    // nothing else going on, so it can never land in the middle of a running
    // turn, inside an open dialog (where it would be read as the answer), on
    // top of a prompt still waiting to be sent, or in an account that has no
    // free sessions left to run it.
    const boxFree = boxSeen && boxIdle && !pendingDialog && !pendingSubmit && !busy &&
      !(limitVerdict && limitVerdict.kind === 'session-limit')
    if (typeof options.takeTask === 'function' && boxFree) {
      let task = null
      try {
        task = options.takeTask()
      } catch {
        // A queue that cannot be read must not break the session.
      }
      if (task && task.text) {
        logLine('info', 'task from the phone typed into the session', {})
        logEvent('session.voice_task', { chars: task.text.length })
        typeThenEnter(task.text)
      }
    }

    // A decision spoken on the phone arrives as a queued choice, key press or
    // answer text. Only a dialog that is actually on screen is answered here,
    // so a late or stray answer can never be typed into the conversation.
    if (pendingDialog && typeof options.takeAnswer === 'function') {
      let answer = null
      try {
        answer = options.takeAnswer()
      } catch {
        // A queue that cannot be read must not break the session.
      }
      if (answer) {
        if (typeof answer.text === 'string' && answer.text.trim()) {
          // A question that wants words rather than a choice.
          remoteAnswers += 1
          logLine('info', 'an answer from the phone typed into the dialog', { chars: answer.text.length })
          logEvent('session.remote_answer', { kind: 'text', chars: answer.text.length })
          typeThenEnter(answer.text.trim())
          pendingDialog = null
          remoteAnswerAt = now
          seen.clear()
        } else {
          const keys = dialog.answerKeys(dialogNow, answer) ||
            // A yes/no screen has no rows to choose from: 1 is yes, 2 is no.
            (!dialogNow && dialog.normaliseChoices(answer.choice).length > 0
              ? (dialog.normaliseChoices(answer.choice)[0] === 2 ? 'n\r' : 'y\r')
              : null)
          const described = answer.choice !== undefined
            ? `choice ${dialog.normaliseChoices(answer.choice).join(',')}`
            : `keys ${describeKeys(answer.keys || '')}`
          if (keys) {
            remoteAnswers += 1
            logLine('info', 'a decision arrived from the phone', { answer: described })
            logEvent('session.remote_answer', { answer: described, keys: describeKeys(keys) })
            try {
              child.write(keys)
            } catch {
              // The session may have just ended.
            }
            pendingDialog = null
            remoteAnswerAt = now
            // If the dialog survives the answer, it has to be reportable again
            // rather than sitting silently for the whole dialog lifetime. The
            // grace window keeps the question that is still in the scroll buffer
            // from ringing a second time straight away.
            seen.clear()
          } else {
            logLine('warn', 'a decision from the phone did not fit the dialog', { answer: described })
            logEvent('session.remote_answer_ignored', { answer: described })
          }
        }
      }
    }

    // freebuff's help screen is a dead end for an unattended session: it does
    // nothing by itself and the agent never starts working again. Close it and
    // put the task back — but only once no work has been recorded for a whole
    // verification window, because Esc also stops a running turn.
    if (helpOnScreen(screen) && (!helpClosedAt || now - helpClosedAt > HELP_COOLDOWN_MS)) {
      const idle = now - Math.max(lastProgressAt, startedAt)
      if (idle >= verifyMs) {
        helpClosedAt = now
        logLine('warn', 'freebuff help screen on screen — closing it')
        logEvent('session.help_closed', {})
        try {
          child.write('\u001b')
        } catch {
          // The session may have just ended.
        }
        const text = resume ? resume.text : (nudge ? nudge.text : null)
        if (text) {
          const timer = setTimeout(() => {
            submitTimers.delete(timer)
            logLine('info', 'task typed again after the help screen')
            logEvent('session.help_retype', {})
            typeThenEnter(text)
          }, 400)
          submitTimers.add(timer)
        }
      }
    }

    if (pendingSubmit && limit.kind !== 'none' && now - pendingSubmit.at >= verifyMs) {
      const worked = lastProgressAt > pendingSubmit.at
      if (worked) {
        // The message was accepted after all.
        pendingSubmit = null
      } else if (limit.kind === 'session-limit') {
        // Nothing can run on this account until the quota resets. Enter would
        // send nothing and the session is not stuck, so the pending copy is
        // dropped here; the caller takes the account out of rotation.
        pendingSubmit = null
      } else if (limit.kind === 'capacity') {
        // A busy service is not a broken session. Drop the pending copy and
        // let the ordinary nudge/continue try again when capacity returns;
        // retiring the session here would count a temporary queue as a fault.
        pendingSubmit = null
      } else if (limitRetypes < MAX_LIMIT_RETYPES) {
        // freebuff itself asks for the message again (a new session, or a new
        // turn after the usage limit). Type it again once the screen settles,
        // exactly as the message says, instead of pressing Enter at it.
        const text = pendingSubmit.text
        pendingSubmit = null
        limitRetypes += 1
        logLine('info', 'session asked for the message again — typing it again', {
          state: limit.kind,
          attempt: limitRetypes
        })
        logEvent('session.limit_retype', {
          state: limit.kind,
          attempt: limitRetypes
        })
        const timer = setTimeout(() => {
          submitTimers.delete(timer)
          typeThenEnter(text)
        }, Math.max(500, limit.delayMs || 0))
        submitTimers.add(timer)
      } else {
        // Even its own instruction did not take: retire the session, and the
        // 24/7 loop relaunches it with the task.
        reportStuck()
      }
    } else if (pendingSubmit && now - pendingSubmit.at >= verifyMs) {
      const worked = lastProgressAt > pendingSubmit.at
      // Only a screen that has stopped moving can be a prompt waiting to be
      // sent. A TUI that is still drawing is working: pressing Enter into it
      // would type into the middle of a running turn.
      const quiet = now - lastOutputAt >= verifyMs
      const inBox = promptOnScreen(buffer, pendingSubmit.text)
      // A prompt that was sent has moved up into the conversation, so it is
      // still drawn but no longer inside the input box. One that never arrived
      // is not drawn anywhere, and pressing Enter at an empty box cannot send
      // it — only typing it in again can.
      const drawn = textOnScreen(buffer, pendingSubmit.text)

      if (worked) {
        // freebuff recorded work, so the prompt was accepted.
        pendingSubmit = null
      } else if (drawn && !inBox) {
        // It is in the conversation, above the empty input box: it was sent.
        pendingSubmit = null
      } else if (!drawn) {
        // Nothing of the prompt is on screen, so the write itself was lost.
        // Typing it in again is the only safe case: there is no earlier copy
        // of it on screen to duplicate.
        if (pendingSubmit.resends < MAX_RESENDS) resendPrompt()
        else reportStuck()
      } else if (!quiet) {
        // Still drawing, so give it time — but not forever.
        if (now - pendingSubmit.at > SUBMIT_GIVE_UP_MS) pendingSubmit = null
      } else if (busy) {
        // freebuff is working on a turn and is not taking a message: the text
        // waits in the input box. Enter does nothing there, and typing the
        // prompt again would put a second copy of it in the box, so it is left
        // exactly where it is until the turn ends. A box that merely has no
        // placeholder is not a reason to hold back: that is also what the box
        // looks like with our message in it, which is what needs the Enter.
        if (!pendingSubmit.waiting) {
          pendingSubmit.waiting = true
          logLine('info', 'freebuff is mid-turn — the typed prompt waits in its box')
          logEvent('session.prompt_waiting', {})
        }
      } else if (pendingSubmit.retries < maxRetries) {
        pendingSubmit.retries += 1
        pendingSubmit.at = now
        enterRetries += 1
        logLine('warn', 'prompt still in the input box — pressing Enter again', {
          retry: pendingSubmit.retries
        })
        logEvent('session.enter_retry', { retry: pendingSubmit.retries })
        // Focus the box again first: a click that landed elsewhere (the agent's
        // own redraw, a dialog that just closed) is exactly what leaves a
        // prompt typed but never sent.
        withFocus(() => {
          try {
            child.write('\r')
          } catch {
            // The session may have just ended.
          }
        })
      } else {
        // Enter alone cannot send a prompt the TUI is refusing, and typing it
        // in again would put a second copy of it on screen, so it is reported.
        reportStuck()
      }
    }

    // Nothing typed, no dialog, and no recorded work for a whole nudge gap: the
    // session may be spinning its wheels. Say so now, long before the stall
    // watch gives up on it (FREEBUFFS_STALL_MS, 20 minutes by default).
    if (nudge && !pendingDialog && !pendingSubmit) {
      const idle = now - Math.max(lastProgressAt, startedAt)
      if (idle >= nudge.idleMs && now - lastIdleReportAt >= nudge.idleMs) {
        lastIdleReportAt = now
        logLine('warn', 'session has made no progress', { idleMs: idle })
        logEvent('session.no_progress', {
          idleMs: idle,
          quietMs: now - lastOutputAt
        })
      }
    }

    // Publish the screen, the question and the counters for the dashboard and
    // the phone. Once a second is enough to be live and cheap.
    publishLive({ boxIdle, busy })
  }, WATCHDOG_MS)
  if (watchdogTimer.unref) watchdogTimer.unref()

  const cleanup = () => {
    if (nudgeTimer) clearInterval(nudgeTimer)
    if (resumeTimer) clearInterval(resumeTimer)
    if (watchdogTimer) clearInterval(watchdogTimer)
    // The session is over: its screen is a memory, not a live view.
    if (sessionId) live.clear(sessionId)
    for (const timer of submitTimers) clearTimeout(timer)
    submitTimers.clear()
    if (interactive) {
      try {
        stdin.setRawMode(false)
      } catch {
        // Ignore.
      }
      stdin.pause()
    }
    if (stdin) stdin.removeListener('data', onStdin)
    if (stdout) stdout.removeListener('resize', onResize)
  }

  if (interactive) {
    try {
      stdin.setRawMode(true)
    } catch {
      // Not all terminals allow it; forwarding still works without raw mode.
    }
    stdin.resume()
    stdin.on('data', onStdin)
    stdout.on('resize', onResize)
  }

  const dataDisposable = child.onData((chunk) => {
    if (options.onOutput) {
      try {
        options.onOutput(chunk)
      } catch {
        // Diagnostics must never break the session.
      }
    }
    if (stdout) {
      try {
        stdout.write(chunk)
      } catch {
        // The terminal went away.
      }
    }

    lastOutputAt = Date.now()
    buffer = (buffer + chunk).slice(-SCAN_WINDOW)
    screen = (screen + chunk).slice(-HELP_WINDOW)

    // Does the TUI take mouse input? Clicking the input box is only safe when
    // it has asked the terminal for mouse reports.
    const chunkText = String(chunk)
    if (/\u001b\[\?(?:1000|1002|1003|1006)h/.test(chunkText)) mouseReporting = true
    else if (/\u001b\[\?(?:1000|1002|1003|1006)l/.test(chunkText)) mouseReporting = false

    const verdict = decide(buffer)
    // Nothing dialog-shaped on screen any more, so an open one was answered by
    // somebody else and the session may be nudged again. A question parsed
    // from the screen rows is still open until its rows go away.
    if (verdict.action === 'none' && !dialogNow) pendingDialog = null
    if (verdict.action === 'none') return

    const now = Date.now()
    // Keyed by rule, not by the prompt text: the text grows as more of the
    // same dialog arrives, and answering it twice would be noise.
    const key = verdict.name
    const last = seen.get(key) || 0

    if (verdict.action === 'answer') {
      // A retry screen is meant to be pressed again each time it appears, so
      // it only waits out the short cooldown instead of the dialog lifetime.
      const ttl = verdict.repeat ? REPEAT_ANSWER_MS : DIALOG_TTL_MS
      if (now - last < ttl) return
      if (now - lastAnswerAt < ANSWER_COOLDOWN_MS) return
      lastAnswerAt = now
      seen.set(key, now)
      pendingDialog = null
      answered += 1
      logLine('info', 'dialog answered', { rule: verdict.name })
      logEvent('dialog.answer', {
        rule: verdict.name,
        prompt: verdict.prompt
      })
      try {
        child.write(verdict.keys)
      } catch {
        // Ignore.
      }
      if (options.onAnswer) options.onAnswer(verdict)
      return
    }

    if (now - remoteAnswerAt < REMOTE_ANSWER_GRACE_MS) return

    seen.set(key, now)
    // The screen parser may already have reported this same question, and one
    // that is still on screen has already been reported once.
    if (!noteEscalated(verdict.question || verdict.prompt || verdict.name)) return
    pendingDialog = {
      prompt: verdict.prompt || verdict.name,
      rule: verdict.name,
      at: now
    }
    escalated += 1
    logLine('warn', 'dialog left for a person', {
      rule: verdict.name,
      reason: verdict.reason
    })
    logEvent('dialog.escalate', {
      rule: verdict.name,
      reason: verdict.reason,
      prompt: verdict.prompt
    })
    if (options.onEscalate) options.onEscalate(verdict.prompt, verdict)
  })

  return new Promise((resolve, reject) => {
    child.onExit(({ exitCode, signal }) => {
      exited = true
      cleanup()
      try {
        dataDisposable.dispose()
      } catch {
        // Ignore.
      }
      resolve({
        code: exitCode,
        signal: signal ? signalName(signal) : null,
        answered,
        escalated,
        nudges,
        resumed,
        enterRetries,
        resends,
        stuck,
        // Why the session stopped being able to run, when freebuff said so. A
        // line the watchdog refused to act on — an agent writing about session
        // limits — is not a state, and is named separately so the caller does
        // not read it from the final screen and act on it after all.
        limit: acceptedLimit,
        limitIgnored: limitIgnoredFor,
        // A turn was running, or a question was on screen, when the TUI went
        // away. A clean exit code then means "the conversation ended", not
        // "the work is finished": the supervisor resumes instead of stopping.
        busyAtExit: lastBusyAt > 0 && Date.now() - lastBusyAt <= BUSY_FRESH_MS * 4,
        dialogAtExit: lastDialogAt > 0 && Date.now() - lastDialogAt <= BUSY_FRESH_MS * 4,
        // How many dialogs were answered by a decision from the phone.
        remoteAnswers,
        // The screen as rows, the way it looked, so a diagnosis can be read.
        tail: screenRows(buffer).join('\n').slice(-4000)
      })
    })
    // node-pty reports reading from a pty whose child has exited as EIO. That
    // is an ordinary end of stream — onExit follows — not a failure, so only a
    // real error should abort the session.
    const failed = (error) => {
      const message = error && error.message ? error.message : 'unknown'
      if (/\bEIO\b/.test(message)) return
      cleanup()
      reject(new Error(`pty failed: ${message}`))
    }

    if (typeof child.onError === 'function') child.onError(failed)
    if (typeof child.on === 'function') child.on('error', failed)
  })
}

/**
 * freebuff's own help screen (what `?` opens). It is the one screen where a
 * session sits still with nothing typed and nothing working, so the supervisor
 * closes it and puts the task back in front of the agent.
 *
 * The markers are the shortcut rows of that overlay, not the words "help" or
 * "keyboard shortcuts": the agent and the person write about those in ordinary
 * conversation, and matching prose would press Esc into a running turn.
 */
/**
 * Rows only freebuff's help screen draws. Not the words "help" or "keyboard
 * shortcuts": the agent and the person write about those in ordinary
 * conversation, and matching prose would press Esc into a running turn.
 */
const HELP_ROWS = ['close help / stop', 'expand / collapse agents']
/**
 * freebuff's input box placeholders, drawn only in an empty box. It uses more
 * than one — "Enter a coding task or / for commands" at rest and "Add to the
 * current task" once a chat is under way — so a single string missed the box
 * in the state most sessions are actually in.
 */
const PROMPT_BOXES = ['enter a coding task', 'add to the current task']

/** Is this row the empty input box's placeholder? */
function isBoxRow (row) {
  const text = String(row).toLowerCase()
  return PROMPT_BOXES.some((placeholder) => text.includes(placeholder))
}

/**
 * Is freebuff's help screen what is on screen right now?
 *
 * Its shortcut rows are the last thing drawn, and it replaces the prompt box —
 * an agent writing about shortcuts leaves them above the input box that
 * follows the conversation, which is how the two are told apart.
 */
function helpOnScreen (buffer) {
  const text = plainScreen(String(buffer)).toLowerCase()
  const rowsAt = HELP_ROWS.reduce(
    (found, row) => Math.max(found, text.lastIndexOf(row)),
    -1
  )
  if (rowsAt < 0) return false
  const boxAt = PROMPT_BOXES.reduce(
    (found, placeholder) => Math.max(found, text.lastIndexOf(placeholder)),
    -1
  )
  return boxAt < rowsAt
}

/** node-pty reports a numeric signal; the rest of the supervisor uses names. */
function signalName (signal) {
  if (typeof signal === 'string') return signal
  const names = { 2: 'SIGINT', 9: 'SIGKILL', 15: 'SIGTERM', 1: 'SIGHUP', 3: 'SIGQUIT' }
  return names[signal] || `signal ${signal}`
}

module.exports = {
  runOnPty,
  available,
  loadPty,
  signalName,
  DEFAULT_RESUME_MS,
  SUBMIT_DELAY_MS,
  helpOnScreen,
  SUBMIT_VERIFY_MS,
  MAX_ENTER_RETRIES,
  MAX_RESENDS,
  MAX_LIMIT_RETYPES,
  LIMIT_REPORT_MS,
  BUSY_FRESH_MS,
  promptOnScreen,
  inputBoxIdle,
  busyOnScreen,
  turnRunning,
  REPEAT_ANSWER_MS,
  MAX_NUDGE_GAP_MS
}
