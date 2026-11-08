#!/usr/bin/env node
'use strict'

/**
 * Side process started by `sfreebuff` next to the freebuff TUI.
 *
 * It never touches the TUI's terminal: it heartbeats into ~/.freebuffs/run,
 * appends structured events to the supervisor log, cleans up live-session
 * files whose owner died, and reconciles the session record when the launcher
 * is gone. The launcher can give it its own window (--window) — a console on
 * Windows, a terminal on macOS and Linux — where it reports what it is doing
 * instead of staying silent.
 */

const fs = require('fs')
const path = require('path')
const pkg = require('../package.json')
const { paths, ensureDirs } = require('./paths')
const { loadState, mutateState } = require('./state')
const { logLine, logEvent } = require('./log')
const { isPidAlive, readJson, safeUnlink, formatDuration, shortHome } = require('./util')
const accounts = require('./accounts')
const work = require('./work')

function parseArgs (argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
    args[key] = value
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const sessionId = args.session
const accountId = args.account
const freebuffPid = Number(args.pid)
// The launcher opens the monitor in its own window next to the TUI (--window);
// there it reports what it is doing instead of staying silent.
const windowMode = args.window === 'true'
const startedAt = Date.now()
const interval = Math.max(
  50,
  Number(args.interval || process.env.FREEBUFFS_MONITOR_INTERVAL_MS || 5000)
)

if (!sessionId || !accountId || !Number.isInteger(freebuffPid)) {
  console.error('sfreebuff monitor: missing --session, --account or --pid')
  process.exit(2)
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A line of text in the supervisor window; silent when detached. */
function say (text = '') {
  if (!windowMode) return
  try {
    process.stdout.write(`${text}\n`)
  } catch {
    // Closing the window must not stop the monitor.
  }
}

/** One updating status line, so the window never scrolls away. */
function status (text) {
  if (!windowMode) return
  try {
    process.stdout.write(`\r${text.padEnd(78)}`)
  } catch {
    // Ignore.
  }
}

function heartbeatPath () {
  return path.join(paths().runDir, `monitor-${sessionId}.json`)
}

/**
 * What the session is doing at this beat, for the voice line and the
 * dashboard: the phase, how long it has been quiet, and whether the last turn
 * was stopped. Published rather than left for a reader to recompute, so a
 * session that stops working is visible while it is happening instead of only
 * when somebody asks.
 */
function liveWork (payload) {
  if (!payload.configDir || !payload.cwd) return null
  try {
    const seen = work.forSession({
      configDir: payload.configDir,
      cwd: payload.cwd,
      startedAt: Date.parse(payload.startedAt) || 0
    })
    return {
      phase: seen.phase,
      quietMs: seen.quietMs,
      interrupted: Boolean(seen.interrupted),
      text: seen.text,
      chatId: seen.chatId
    }
  } catch {
    // An unreadable chat must not stop the monitor from beating.
    return null
  }
}

function writeHeartbeat (state, extra) {
  ensureDirs()
  const session = state.sessions.find((item) => item.id === sessionId)
  const account = state.accounts.find((item) => item.id === accountId)
  const payload = {
    monitorPid: process.pid,
    sessionId,
    accountId,
    freebuffPid,
    launcherPid: session ? session.launcherPid : null,
    cwd: session ? session.cwd : args.cwd || null,
    startedAt: session ? session.startedAt : null,
    updatedAt: new Date().toISOString(),
    configDir: account ? accounts.accountConfigDir(account) : null,
    ...extra
  }
  payload.work = liveWork(payload)
  const tempPath = `${heartbeatPath()}.tmp-${process.pid}`
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`)
  fs.renameSync(tempPath, heartbeatPath())
  return payload
}

/** Track this account's live-session files and drop files of dead owners. */
function scanLiveFiles (state) {
  const account = state.accounts.find((item) => item.id === accountId)
  if (!account) return { active: [], stale: [] }

  const dir = accounts.accountConfigDir(account)
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return { active: [], stale: [] }
  }

  const active = []
  const stale = []
  for (const name of entries) {
    if (!/^freebuff-live-\d+\.json$/.test(name)) continue
    const file = path.join(dir, name)
    const data = readJson(file)
    const ownerPid = data && Number(data.ownerPid)
    if (Number.isInteger(ownerPid) && isPidAlive(ownerPid)) {
      active.push({ pid: ownerPid, file: name, tokenKey: data.tokenKey || null })
        continue
    }
    if (safeUnlink(file)) {
      stale.push(name)
      logEvent('livefile.stale', { account: accountId, file: name, ownerPid })
      logLine('info', 'removed stale session file', { file: name, ownerPid })
    }
  }
  return { active, stale }
}

function removeHeartbeat () {
  safeUnlink(heartbeatPath())
}

async function main () {
  ensureDirs()
  const state = loadState()
  const session = state.sessions.find((item) => item.id === sessionId)
  const account = state.accounts.find((item) => item.id === accountId)

  logEvent('monitor.start', {
    session: sessionId,
    account: accountId,
    freebuffPid,
    cwd: session ? session.cwd : args.cwd || null,
    interval
  })
  logLine('info', 'monitor started', {
    session: sessionId,
    account: accountId,
    freebuffPid
  })

  if (windowMode) {
    try {
      process.title = 'sfreebuff supervisor'
    } catch {
      // Not every platform lets a process rename its console.
    }
    say(`sfreebuff ${pkg.version} — freebuff supervisor`)
    say(`session   ${sessionId} · ${accountId}`)
    say(`freebuff  pid ${freebuffPid}`)
    say(`cwd       ${shortHome((session && session.cwd) || args.cwd || '')}`)
    say(`log       ${shortHome(paths().supervisorLog)}`)
    say('freebuff itself is running in its own window, not this one.')
    say('This window follows the session and closes when freebuff exits.')
    say('')
    status('monitoring…')
  }

  if (!session) {
    logLine('warn', 'monitor: session record not found', { session: sessionId })
  }
  if (account && !accounts.isSignedIn(account)) {
    logLine('warn', 'monitor: account has no credentials', { account: accountId })
    logEvent('account.auth.missing', { account: accountId })
  }
  if (account) {
    const expiry = accounts.isExpiring(account)
    if (expiry.expiring) {
      logLine('warn', 'monitor: account credentials expiring', {
        account: accountId,
        expiresAt: new Date(expiry.expiresAt).toISOString()
      })
      logEvent('account.expiring', {
        account: accountId,
        expiresAt: expiry.expiresAt,
        expired: expiry.expired
      })
    }
  }

  writeHeartbeat(state, { liveFiles: [] })

  // The phase the last beat saw. A session that stops working is recorded once,
  // as it happens, instead of only being visible in a later answer.
  let lastPhase = null
  const notePhase = (beaten) => {
    const phase = beaten && beaten.work ? beaten.work.phase : null
    if (!phase || phase === lastPhase) return
    if (lastPhase === 'working' && phase !== 'working') {
      const quiet = beaten.work.quietMs
      logLine('info', 'session stopped working', {
        session: sessionId,
        account: accountId,
        phase,
        quiet: quiet === null || quiet === undefined ? null : formatDuration(quiet)
      })
      logEvent('session.idle', {
        session: sessionId,
        account: accountId,
        phase,
        quietMs: quiet,
        interrupted: Boolean(beaten.work.interrupted)
      })
    }
    lastPhase = phase
  }

  while (isPidAlive(freebuffPid)) {
    const current = loadState()
    const live = scanLiveFiles(current)
    const beaten = writeHeartbeat(current, {
      liveFiles: live.active.map((item) => item.file),
      livePids: live.active.map((item) => item.pid)
    })
    notePhase(beaten)
    status(
      `monitoring · ${formatDuration(Date.now() - startedAt)} · ` +
      `freebuff pid ${freebuffPid} · ${(beaten.work && beaten.work.phase) || 'unknown'} · ` +
      `live files ${live.active.length}`
    )
    await sleep(interval)
  }

  const live = scanLiveFiles(loadState())
  const before = loadState()
  const record = before.sessions.find((item) => item.id === sessionId)
  const launcherAlive = record ? isPidAlive(record.launcherPid) : false
  const wasEnded = Boolean(record && record.endedAt)

  // Normally the launcher records the real exit status a moment after the TUI
  // exits. Only step in when it is gone.
  const ended = launcherAlive
    ? null
    : mutateState((current) =>
      accounts.finalizeSession(current, sessionId, {
        note: 'reconciled by monitor: launcher exit was not observed'
      })
    )

  logEvent('monitor.stop', {
    session: sessionId,
    account: accountId,
    freebuffPid,
    liveFiles: live.active.length
  })
  logLine('info', 'monitor stopped', {
    session: sessionId,
    account: accountId,
    liveFiles: live.active.length
  })
  if (windowMode) {
    say('')
    say(
      `session ended after ${formatDuration(Date.now() - startedAt)} — ` +
      'supervisor stopping'
    )
  }
  if (ended && !wasEnded) {
    logEvent('session.end.unobserved', { session: sessionId, account: accountId })
  }

  removeHeartbeat()
}

main().catch((error) => {
  logLine('error', 'monitor crashed', { session: sessionId, error: error.message })
  logEvent('monitor.error', { session: sessionId, error: error.message })
  removeHeartbeat()
  process.exit(1)
})
