'use strict'

/**
 * What a session is working on right now, and whether it is working at all.
 *
 * The voice line has to answer two different questions from the same data:
 * "what are you doing?" (the work in words) and "is it actually doing
 * anything?" (a live session sitting at its input box is not work). freebuff
 * records both itself, below its config dir:
 *
 *   <config>/projects/<basename(cwd)>/chats/<chatId>/
 *     log.jsonl, chat-messages.json, run-state.json, chat-meta.json
 *
 * A running turn appends to those files continuously; an idle one writes
 * nothing. So the newest chat of the session's project gives the last thing
 * the agent said, and the time since anything was written gives the phase:
 *
 *   working     something was written in the last couple of minutes
 *   interrupted the turn was stopped, whatever the chat files say
 *   waiting     the session is alive but has been quiet: it wants a message
 *   stalled     quiet for as long as the supervisor's own stall watch allows
 *   ended       the session finished or crashed, recently enough to matter
 *   lost        the session's process is gone and nothing recorded the end
 *   unknown     no readable records (no pty, or a brand new session)
 *
 * Nothing here invents a task: with no written message the text is empty and
 * the caller says only what it knows.
 *
 * Reading files is only half of it. Every session also runs a side monitor
 * (monitor.js) that publishes what it sees in its heartbeat every few seconds,
 * so `sessions()` can answer for a session without waiting for it to write and
 * a killed child is noticed at the next beat rather than at the next question.
 */

const fs = require('fs')
const path = require('path')

const accounts = require('./accounts')
const { paths } = require('./paths')
const { isPidAlive } = require('./util')

/**
 * A turn that has written nothing for this long is not working any more. Two
 * minutes is the whole point: long enough that a slow tool call is not called
 * idle, short enough that "it stopped" is heard while it still matters.
 */
const WORKING_WINDOW_MS = 2 * 60 * 1000
/** The same threshold, under the name the voice line talks about. */
const NOT_WORKING_AFTER_MS = WORKING_WINDOW_MS
/** Quiet for this long is the supervisor's own "stuck" threshold. */
const STALLED_AFTER_MS = 20 * 60 * 1000
/** A session that ended this recently is still part of "what is going on". */
const RECENT_ENDED_MS = 15 * 60 * 1000
/** How many sessions one answer covers. */
const MAX_SESSIONS = 8
/** Longest piece of the last message kept for a phone screen. */
const MAX_TEXT = 300
/** Files a running chat writes; the newest one is the phase clock. */
const CHAT_FILES = ['log.jsonl', 'chat-messages.json', 'run-state.json', 'chat-meta.json']
/**
 * What freebuff writes into a turn it did not finish. An interrupted turn still
 * touches its chat files as it stops, so the file time alone made the session
 * look like it was working for the next couple of minutes. The marker says the
 * turn is over, and the session is waiting for a message again.
 */
const INTERRUPTED_MARK = /\[response interrupted\]/i
/** A chat written this soon before the session started still belongs to it. */
const SESSION_START_SLACK_MS = 5 * 60 * 1000

function readJson (file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readEntries (dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function isDirectory (target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

function fileMtime (file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** The project directory freebuff uses for a working folder. */
function projectDirFor (configDir, cwd) {
  return path.join(configDir, 'projects', path.basename(cwd || ''))
}

/** Newest chat in one project dir, judged by the files the chat writes. */
function newestChatIn (chatsDir) {
  let best = null
  for (const id of readEntries(chatsDir)) {
    const dir = path.join(chatsDir, id)
    if (!isDirectory(dir)) continue
    let updatedAt = 0
    let readable = false
    for (const name of CHAT_FILES) {
      try {
        updatedAt = Math.max(updatedAt, fs.statSync(path.join(dir, name)).mtimeMs)
        readable = true
      } catch {
        // A chat that has not written this file yet.
      }
    }
    if (!readable) continue
    if (!best || updatedAt > best.updatedAt) best = { id, dir, updatedAt }
  }
  return best
}

/** Does this chat's own record name the folder, whatever freebuff called it? */
function chatNamesCwd (chatDir, cwd) {
  if (!cwd) return false
  const wanted = String(cwd)
  const escaped = JSON.stringify(wanted).slice(1, -1)
  for (const name of ['chat-meta.json', 'run-state.json']) {
    try {
      const raw = fs.readFileSync(path.join(chatDir, name), 'utf8')
      if (raw.includes(wanted) || (escaped !== wanted && raw.includes(escaped))) return true
    } catch {
      // Missing or unreadable, so it cannot name anything.
    }
  }
  return false
}

/**
 * The chat this session is running: its own project's newest one. When
 * freebuff named the project directory differently (or keyed it by the whole
 * path), the chat that names this folder is used instead, and failing that one
 * written since the session started. A chat older than the session is another
 * conversation and its last message is not what this session is doing.
 */
function newestChat (configDir, cwd, options = {}) {
  if (!configDir) return null
  const own = newestChatIn(path.join(projectDirFor(configDir, cwd), 'chats'))
  if (own) return own

  const projectsDir = path.join(configDir, 'projects')
  let named = null
  let newest = null
  for (const project of readEntries(projectsDir)) {
    const chat = newestChatIn(path.join(projectsDir, project, 'chats'))
    if (!chat) continue
    if (!named && chatNamesCwd(chat.dir, cwd)) named = chat
    if (!newest || chat.updatedAt > newest.updatedAt) newest = chat
  }
  if (named) return named
  if (!newest) return null
  if (!options.startedAt) return newest
  return newest.updatedAt + SESSION_START_SLACK_MS >= options.startedAt ? newest : null
}

/** Flatten message content, whatever shape freebuff stored it in. */
function textFrom (value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((part) => textFrom(part)).filter(Boolean).join(' ')
  if (!value || typeof value !== 'object') return ''
  if (typeof value.text === 'string') return value.text
  if (typeof value.content === 'string') return value.content
  if (Array.isArray(value.content)) return textFrom(value.content)
  if (typeof value.command === 'string') return value.command
  return ''
}

/** One short line, without control characters, for a phone screen. */
function oneLine (text, max = MAX_TEXT) {
  const flat = String(text || '')
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/**
 * Is this transcript entry something the person said, rather than the agent?
 *
 * freebuff spells the speaker `role` in some chats and `variant` in others, so
 * both are read: without that a person's own prompt was reported back as the
 * agent's latest work, and "what are you doing" answered with the task the
 * person had just typed instead of what the session was actually doing.
 */
function isPersonEntry (entry) {
  const looksPerson = (value) => {
    if (!value || typeof value !== 'object') return false
    const role = String(
      value.role || value.type || value.author || value.variant || value.sender || ''
    ).toLowerCase()
    return /user|human|person/.test(role)
  }
  // A logged event usually wraps the message, so the speaker can be one level
  // down from the entry itself.
  return looksPerson(entry) ||
    looksPerson(entry.message) ||
    looksPerson(entry.payload) ||
    looksPerson(entry.data)
}

/** The last thing the agent said, skipping the person's own messages. */
function lastMessageEntry (chatDir) {
  const stored = readJson(path.join(chatDir, 'chat-messages.json'))
  const list = Array.isArray(stored)
    ? stored
    : (stored && Array.isArray(stored.messages) ? stored.messages : [])

  for (let index = list.length - 1; index >= 0; index -= 1) {
    const entry = list[index]
    if (!entry || typeof entry !== 'object') continue
    if (isPersonEntry(entry)) continue
    const text = oneLine(textFrom(entry) || textFrom(entry.message) || textFrom(entry.data))
    if (text) return { text, interrupted: INTERRUPTED_MARK.test(text) }
  }
  return null
}

/**
 * The last few things the agent said, newest first: what it has been doing,
 * in order. A person asks "what is done so far" halfway through a long task,
 * and the answer is these steps plus whatever is running now.
 */
function recentMessages (chatDir, limit = 6) {
  const stored = readJson(path.join(chatDir, 'chat-messages.json'))
  const list = Array.isArray(stored)
    ? stored
    : (stored && Array.isArray(stored.messages) ? stored.messages : [])
  const out = []
  for (let index = list.length - 1; index >= 0 && out.length < limit; index -= 1) {
    const entry = list[index]
    if (!entry || typeof entry !== 'object') continue
    if (isPersonEntry(entry)) continue
    const text = oneLine(textFrom(entry) || textFrom(entry.message) || textFrom(entry.data), 400)
    if (text) out.push(text)
  }
  return out
}

function lastMessage (chatDir) {
  const entry = lastMessageEntry(chatDir)
  return entry ? entry.text : ''
}

/** Last readable event in the running chat's log, for when messages lag. */
function lastLoggedEntry (chatDir) {
  let raw = ''
  try {
    const file = path.join(chatDir, 'log.jsonl')
    const stats = fs.statSync(file)
    const length = Math.min(stats.size, 64 * 1024)
    const handle = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(length)
      fs.readSync(handle, buffer, 0, length, Math.max(0, stats.size - length))
      raw = buffer.toString('utf8')
    } finally {
      fs.closeSync(handle)
    }
  } catch {
    return ''
  }

  const lines = raw.split('\n').filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry
    try {
      entry = JSON.parse(lines[index])
    } catch {
      continue
    }
    // The log carries both speakers, so the person's prompt must not be read
    // back as the agent's last work.
    if (entry && typeof entry === 'object' && isPersonEntry(entry)) continue
    const text = oneLine(
      textFrom(entry) ||
      textFrom(entry.message) ||
      textFrom(entry.data) ||
      textFrom(entry.payload)
    )
    if (text) return { text, interrupted: INTERRUPTED_MARK.test(text) }
  }
  return null
}

function lastLoggedWork (chatDir) {
  const entry = lastLoggedEntry(chatDir)
  return entry ? entry.text : ''
}

/**
 * The last turn, from whichever file freebuff wrote most recently. The log is
 * the event stream and the messages are the transcript, so the newer one is
 * the turn that just happened rather than the remains of an older one.
 */
function lastTurn (chatDir) {
  const logged = lastLoggedEntry(chatDir)
  const message = lastMessageEntry(chatDir)
  if (!logged) return message
  if (!message) return logged
  const loggedAt = fileMtime(path.join(chatDir, 'log.jsonl'))
  const messageAt = fileMtime(path.join(chatDir, 'chat-messages.json'))
  return messageAt > loggedAt ? message : logged
}

/** The account's config dir, from an id or a state record. */
function configDirFor (accountId) {
  if (!accountId) return null
  try {
    const { loadState } = require('./state')
    const account = loadState().accounts.find((item) => item.id === accountId)
    return account ? accounts.accountConfigDir(account) : null
  } catch {
    return null
  }
}

/**
 * The work and the phase for one session. `configDir` can be passed when the
 * caller already has it; otherwise it is looked up from the account id.
 */
function forSession ({ accountId, cwd, configDir, startedAt } = {}, options = {}) {
  const now = options.now ?? Date.now()
  const dir = configDir || configDirFor(accountId)
  const empty = {
    phase: 'unknown',
    quietMs: null,
    interrupted: false,
    text: '',
    recent: [],
    chatId: null,
    updatedAt: null,
    cwd: cwd || null
  }
  if (!dir || !cwd) return empty

  const chat = newestChat(dir, cwd, { startedAt: Number(startedAt) || 0 })
  if (!chat) return empty

  const quietMs = Math.max(0, Math.round(now - chat.updatedAt))
  const turn = lastTurn(chat.dir)
  return {
    ...phaseOf({ quietMs, interrupted: Boolean(turn && turn.interrupted) }, options),
    text: turn ? turn.text : '',
    // The steps behind the current one, newest first, for "what is done".
    recent: Array.isArray(options.recent) ? options.recent : recentMessages(chat.dir),
    chatId: chat.id,
    updatedAt: new Date(chat.updatedAt).toISOString(),
    cwd
  }
}

/**
 * The phase from how long a session has been quiet, and whether its last turn
 * was stopped. An interrupted turn is over even though stopping it wrote to the
 * chat a moment ago, so the marker wins over the file time: saying "I am
 * working on it" there is the one answer that is plainly false.
 */
function phaseOf ({ quietMs = 0, interrupted = false } = {}, options = {}) {
  if (interrupted) return { phase: 'interrupted', quietMs, interrupted: true }
  const phase = quietMs <= (options.workingWindowMs ?? WORKING_WINDOW_MS)
    ? 'working'
    : quietMs >= (options.stalledAfterMs ?? STALLED_AFTER_MS)
      ? 'stalled'
      : 'waiting'
  return { phase, quietMs, interrupted: false }
}

/**
 * Every live session's monitor heartbeat, keyed by session id. A heartbeat
 * whose monitor process is gone is not live: the work in it is the last thing
 * it saw, not what is happening now.
 */
function readHeartbeats (options = {}) {
  const dir = options.runDir || paths().runDir
  const beats = new Map()
  for (const name of readEntries(dir)) {
    if (!/^monitor-.*\.json$/.test(name)) continue
    const beat = readJson(path.join(dir, name))
    if (!beat || !beat.sessionId) continue
    if (!isPidAlive(beat.monitorPid)) continue
    beats.set(beat.sessionId, beat)
  }
  return beats
}

/**
 * What a heartbeat says right now: its quiet time is aged by how long ago it
 * was written, so a session that went quiet after the last beat is still
 * reported as going quiet.
 */
function fromHeartbeat (beat, now, options = {}) {
  if (!beat || !beat.work) return null
  const work = beat.work
  const seenAt = Date.parse(beat.updatedAt)
  const age = Number.isFinite(seenAt) ? Math.max(0, now - seenAt) : 0
  const quietMs = work.quietMs === null || work.quietMs === undefined
    ? null
    : Math.max(0, Number(work.quietMs) + age)
  if (quietMs === null) return null
  return {
    ...phaseOf({ quietMs, interrupted: Boolean(work.interrupted) }, options),
    text: typeof work.text === 'string' ? work.text : '',
    chatId: work.chatId || null,
    updatedAt: beat.updatedAt || null,
    observedAt: beat.updatedAt || null
  }
}

/**
 * Every session worth talking about: the live ones, and the ones that ended or
 * were lost recently enough that "what is going on" should mention them. Each
 * entry is answered from that session's own monitor heartbeat when it has one,
 * and from freebuff's chat files otherwise.
 */
function sessions (options = {}) {
  const now = options.now ?? Date.now()
  let state = { sessions: [] }
  try {
    state = require('./state').loadState()
  } catch {
    // No state is the same as no sessions.
  }
  const beats = options.beats || readHeartbeats(options)
  // What the pty itself sees: the question on screen with its options, the
  // rows, and whether a typed prompt is still unsent. This is live data, not a
  // guess from file times, and it answers for the session even while it is
  // sitting in a dialog that writes nothing.
  let lives = options.liveStates || new Map()
  if (!options.liveStates) {
    try {
      lives = require('./live').readAll({ now })
    } catch {
      lives = new Map()
    }
  }
  const recentEndedMs = options.recentEndedMs ?? RECENT_ENDED_MS
  const rows = []

  for (const session of state.sessions || []) {
    const endedMs = session.endedAt ? Date.parse(session.endedAt) : 0
    if (endedMs && now - endedMs > recentEndedMs) continue
    const beat = beats.get(session.id) || null
    // A beating monitor proves the session is still there, even in the short
    // window where the launcher has not recorded the freebuff pid yet.
    const live = !session.endedAt && (isPidAlive(session.pid) || Boolean(beat))
    let work = beat ? fromHeartbeat(beat, now, options) : null
    // Only a session that is still there can be working on something. The 24/7
    // loop leaves a record behind for every restart, and a record with no
    // process and no monitor is a session that is gone: reading its chat files
    // described work that is not happening, and with the loop's history that
    // was dozens of records each parsing a large transcript on every request
    // (twelve seconds of the voice line's own event loop, per turn). A lost
    // session is reported as lost, which is what it is.
    if (!work && live) {
      work = forSession({
        accountId: session.accountId,
        cwd: session.cwd,
        startedAt: Date.parse(session.startedAt) || 0
      }, { now, ...options })
    }
    if (!work) {
      work = { phase: 'unknown', quietMs: null, interrupted: false, text: '', chatId: null, updatedAt: null }
    }
    const screenState = lives.get(session.id) || null
    const waitingOnDialog = Boolean(screenState && screenState.dialog && screenState.dialog.kind !== 'none')
    // A session with no process and no recorded end is not working on anything;
    // saying what it last did would present finished work as current work. A
    // question on screen is its own phase: the session is alive, but it will
    // never work again until somebody answers.
    const phase = session.endedAt
      ? 'ended'
      : !live
        ? 'lost'
        : waitingOnDialog ? 'dialog' : work.phase
    rows.push({
      sessionId: session.id,
      account: session.accountId,
      cwd: session.cwd,
      startedAt: session.startedAt || null,
      endedAt: session.endedAt || null,
      exitCode: session.exitCode === undefined ? null : session.exitCode,
      live,
      monitored: Boolean(beat),
      phase,
      quietMs: session.endedAt ? null : work.quietMs,
      interrupted: Boolean(work.interrupted),
      text: work.text || '',
      updatedAt: work.updatedAt || null,
      // Live from the pty: the question, its choices, the rows on screen and
      // whether a typed prompt is still sitting in the input box.
      dialog: screenState && screenState.dialog && screenState.dialog.kind !== 'none'
        ? screenState.dialog
        : null,
      screen: screenState && Array.isArray(screenState.screen) ? screenState.screen : [],
      recent: Array.isArray(work.recent) ? work.recent : [],
      busy: screenState ? Boolean(screenState.busy) : null,
      unsent: screenState && screenState.unsent ? String(screenState.unsent) : '',
      limit: screenState ? screenState.limit || null : null,
      box: screenState && screenState.box ? screenState.box : null
    })
  }

  return rows
    .sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1
      return (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0)
    })
    .slice(0, options.limit ?? MAX_SESSIONS)
}

module.exports = {
  WORKING_WINDOW_MS,
  NOT_WORKING_AFTER_MS,
  STALLED_AFTER_MS,
  RECENT_ENDED_MS,
  MAX_SESSIONS,
  MAX_TEXT,
  CHAT_FILES,
  INTERRUPTED_MARK,
  projectDirFor,
  newestChat,
  lastMessage,
  recentMessages,
  lastLoggedWork,
  lastTurn,
  phaseOf,
  readHeartbeats,
  fromHeartbeat,
  sessions,
  forSession
}
