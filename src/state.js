'use strict'

const fs = require('fs')
const pathsModule = require('./paths')
const { nowIso } = require('./util')
const { sortAccounts } = require('./accounts')

const { paths, ensureDirs } = pathsModule

const STATE_VERSION = 1
const LOCK_TIMEOUT_MS = 3000
const LOCK_STALE_MS = 30000

function emptyState () {
  return {
    version: STATE_VERSION,
    createdAt: nowIso(),
    accounts: [],
    sessions: [],
    lastAccountId: null,
    lastAccountByCwd: {}
  }
}

function normalize (raw) {
  const state = emptyState()
  if (!raw || typeof raw !== 'object') return state
  state.version = STATE_VERSION
  state.createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : state.createdAt
  // Every view lists accounts in number order, so a state file that ended up
  // as 1, 2, 4, 3 is read back as 1, 2, 3, 4.
  state.accounts = Array.isArray(raw.accounts)
    ? sortAccounts(raw.accounts.filter(Boolean))
    : []
  state.sessions = Array.isArray(raw.sessions) ? raw.sessions.filter(Boolean) : []
  state.lastAccountId = raw.lastAccountId || null
  state.lastAccountByCwd =
    raw.lastAccountByCwd && typeof raw.lastAccountByCwd === 'object'
      ? raw.lastAccountByCwd
      : {}
  return state
}

function loadState () {
  const statePath = paths().statePath
  try {
    return normalize(JSON.parse(fs.readFileSync(statePath, 'utf8')))
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // Keep the unreadable file for inspection instead of silently dropping it.
      try {
        fs.renameSync(statePath, `${statePath}.corrupt-${Date.now()}`)
      } catch {
        // Ignore.
      }
    }
    return emptyState()
  }
}

function saveState (state) {
  ensureDirs()
  const statePath = paths().statePath
  const tempPath = `${statePath}.tmp-${process.pid}`
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tempPath, statePath)
}

function sleepSync (ms) {
  const shared = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(shared), 0, 0, ms)
}

/**
 * Both the launcher and the detached monitor write state. A tiny lock file
 * keeps their read-modify-write cycles from dropping each other's updates.
 */
function withLock (fn) {
  ensureDirs()
  const lockPath = paths().stateLockPath
  const deadline = Date.now() + LOCK_TIMEOUT_MS

  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      try {
        fs.writeFileSync(fd, String(process.pid))
      } finally {
        fs.closeSync(fd)
      }
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const stats = fs.statSync(lockPath)
        if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath)
          continue
        }
      } catch {
        // The holder may have just released it.
      }
      if (Date.now() > deadline) {
        throw new Error('supervisor state is locked by another sfreebuff process')
      }
      sleepSync(40)
    }
  }

  try {
    return fn()
  } finally {
    try {
      fs.unlinkSync(lockPath)
    } catch {
      // Ignore.
    }
  }
}

/** Run a synchronous read-modify-write against the state file. */
function mutateState (fn) {
  return withLock(() => {
    const state = loadState()
    const result = fn(state)
    saveState(state)
    return result
  })
}

module.exports = {
  STATE_VERSION,
  emptyState,
  loadState,
  saveState,
  withLock,
  mutateState
}
