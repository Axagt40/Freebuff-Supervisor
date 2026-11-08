'use strict'

/**
 * AnyDesk comes up with the supervisor.
 *
 * The install lives in ~/FREEBUFF/anydesk on this PC (the official tarball plus
 * a start-anydesk.sh launcher), so the supervisor only has to run that script:
 * it starts the binary once and does nothing when it already runs, and it never
 * writes outside its own folder. Keeping the layout in the launcher means a
 * version bump or a move of the install does not need this file edited.
 *
 * FREEBUFFS_ANYDESK=0 turns it off for a run; FREEBUFFS_ANYDESK_LAUNCHER points
 * at a different launcher.
 */

const path = require('path')
const os = require('os')
const { spawn } = require('child_process')
const { logLine } = require('./log')

function launcherPath (env = process.env) {
  if (env.FREEBUFFS_ANYDESK_LAUNCHER) return env.FREEBUFFS_ANYDESK_LAUNCHER
  return path.join(os.homedir(), 'FREEBUFF', 'anydesk', 'start-anydesk.sh')
}

function enabled (env = process.env) {
  const raw = String(env.FREEBUFFS_ANYDESK || '').trim().toLowerCase()
  if (raw === '') return true
  return !['0', 'false', 'no', 'off'].includes(raw)
}

/**
 * Start AnyDesk through the launcher, detached. Never throws and never waits:
 * a machine with no AnyDesk (or a broken one) must not keep a supervisor from
 * running its session.
 */
function ensureAnyDesk (env = process.env) {
  if (!enabled(env)) {
    logLine('info', 'anydesk.skip', { reason: 'disabled' })
    return null
  }
  const launcher = launcherPath(env)
  try {
    const child = spawn('/bin/sh', [launcher], { detached: true, stdio: 'ignore', env })
    child.on('error', (error) => logLine('warn', 'anydesk.failed', { error: error.message }))
    child.unref()
    logLine('info', 'anydesk.start', { launcher })
    return child
  } catch (error) {
    logLine('warn', 'anydesk.failed', { error: error.message })
    return null
  }
}

module.exports = { ensureAnyDesk, enabled, launcherPath }
