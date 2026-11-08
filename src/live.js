'use strict'

/**
 * The live state of one running session, as its pty sees it.
 *
 * The supervisor's other views are file-time guesses: work.js reads the chat
 * files freebuff writes, the monitor heartbeats once every few seconds. Neither
 * can see the screen, so neither can say which question is on it, which option
 * is highlighted, or whether a typed prompt is still waiting in the input box.
 *
 * The process that owns the pty knows all of that. It publishes it here, once
 * a second and whenever something changes, and everybody else — the dashboard,
 * the voice line, the phone — reads the same file. A state that is not being
 * refreshed (its process is gone, or the file is old) is not live and is not
 * returned, so a killed session cannot keep answering questions.
 */

const fs = require('fs')
const path = require('path')

const { paths } = require('./paths')
const { isPidAlive } = require('./util')

/** How long a state file may go unrefreshed before it is only a memory. */
const LIVE_AGE_MS = 30 * 1000
/** A file this old whose process is gone is stale even for a listing. */
const PRUNE_AGE_MS = 10 * 60 * 1000

function liveDir () {
  return paths().runDir
}

function livePath (sessionId) {
  return path.join(liveDir(), `live-${sessionId}.json`)
}

/**
 * Publish the state of a session. Best effort: a session must never fail
 * because its own status file could not be written.
 */
function write (sessionId, state = {}) {
  if (!sessionId) return false
  try {
    fs.mkdirSync(liveDir(), { recursive: true })
    const target = livePath(sessionId)
    const temp = `${target}.tmp-${process.pid}`
    const payload = {
      sessionId,
      updatedAt: new Date().toISOString(),
      ...state
    }
    fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temp, target)
    return true
  } catch {
    return false
  }
}

function readFile (file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

/** One session's live state, or null when it is not live any more. */
function read (sessionId, options = {}) {
  if (!sessionId) return null
  const state = readFile(livePath(sessionId))
  if (!state) return null
  const now = options.now ?? Date.now()
  const age = now - (Date.parse(state.updatedAt) || 0)
  const alive = state.pid ? isPidAlive(state.pid) : false
  if (age > (options.maxAgeMs ?? LIVE_AGE_MS) && !alive) return null
  return state
}

/**
 * Every live session, keyed by session id. A file whose process is gone and
 * which has not been touched for a while is removed here, so `~/.freebuffs/run`
 * does not fill with the status of dead sessions.
 */
function readAll (options = {}) {
  const now = options.now ?? Date.now()
  const states = new Map()
  let names = []
  try {
    names = fs.readdirSync(liveDir())
  } catch {
    return states
  }

  for (const name of names) {
    if (!/^live-.*\.json$/.test(name)) continue
    const file = path.join(liveDir(), name)
    const state = readFile(file)
    if (!state || !state.sessionId) {
      try {
        fs.unlinkSync(file)
      } catch {
        // Ignore.
      }
      continue
    }
    const age = now - (Date.parse(state.updatedAt) || 0)
    const alive = state.pid ? isPidAlive(state.pid) : false
    if (!alive && age > PRUNE_AGE_MS) {
      try {
        fs.unlinkSync(file)
      } catch {
        // Ignore.
      }
      continue
    }
    if (age <= (options.maxAgeMs ?? LIVE_AGE_MS) || alive) {
      states.set(state.sessionId, state)
    }
  }
  return states
}

/** The session stopped running: its state is a memory, not a live view. */
function clear (sessionId) {
  if (!sessionId) return false
  try {
    fs.unlinkSync(livePath(sessionId))
    return true
  } catch {
    return false
  }
}

module.exports = {
  LIVE_AGE_MS,
  PRUNE_AGE_MS,
  liveDir,
  livePath,
  write,
  read,
  readAll,
  clear
}
