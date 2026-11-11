'use strict'

/**
 * Overnight mode: keeping a very big task moving, and switching the machine off
 * when it is really finished.
 *
 * freebuff itself splits a large task into phases and then stops at its input
 * box when a phase is done, even when the person asked it to finish everything.
 * Nothing in the supervisor can make freebuff clear its own to-do list, but it
 * can send it a message at the moment it stops and tell it to carry on. That is
 * the **Force continue** switch: after a finished turn, the pty types a strong
 * "continue with every remaining part" prompt into the same conversation. The
 * prompt is a setting too (`forceContinuePrompt`), because every project words
 * "keep going" a little differently.
 *
 * The agent is asked to end its final message with {@link COMPLETE_MARK} when,
 * and only when, everything is genuinely done. Seeing that line is the one
 * unambiguous "finished" signal available: it is the agent's own statement, not
 * a guess from quiet files. It stops the pushes, and with the **Shutdown timer**
 * switch on it also marks the work done for `wait-and-poweroff.sh`, which
 * powers the machine off once the session is over (or at its backup deadline).
 * A new session cancels a pending poweroff, because starting work is the
 * clearest possible sign that the machine should stay on.
 *
 * Both switches are off by default, stored in ~/.freebuffs/config.json:
 *
 *   forceContinue: true
 *   forceContinuePrompt: "..."   (absent = the built-in default)
 *   shutdownTimer: true
 */

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const { readConfig, updateConfig } = require('./config')
const { paths, ensureDirs } = require('./paths')
const { logLine, logEvent } = require('./log')

/**
 * The line the agent is told to write when everything is finished. It is not
 * ordinary prose: no agent writes it by accident, and nothing else in the
 * supervisor uses it.
 */
const COMPLETE_MARK = 'FREEBUFFS ALL TASKS COMPLETE'

/**
 * How long a session has to be quiet before the continue prompt is typed.
 * Short enough to pick a stopped phase back up while it still matters, long
 * enough not to interrupt a slow tool call or a redraw.
 */
const FORCE_IDLE_MS = 60 * 1000

/** The backup deadline given to the poweroff watcher. */
const SHUTDOWN_BACKUP_MINUTES = 15

const DEFAULT_PROMPT =
  'You stopped before the whole task was finished. Re-read the original ' +
  'request from the beginning of this conversation and continue with every ' +
  'remaining part of it, phase by phase, until all of it is done. Do not stop ' +
  'after one phase, and do not ask me to confirm anything. If one part is ' +
  'blocked, say exactly what blocks it and carry on with everything else.'

const COMPLETE_INSTRUCTION =
  ' Only when every part is genuinely complete and verified, end your final ' +
  `message with this line on its own: ${COMPLETE_MARK}`

/** The automatic prompt, with the completion line added to a custom one too. */
function forceContinuePrompt (custom) {
  const chosen = String(custom || '').trim()
  const text = chosen || DEFAULT_PROMPT
  if (text.toUpperCase().includes(COMPLETE_MARK)) return text
  return `${text}${COMPLETE_INSTRUCTION}`
}

/** Is the agent's completion line present in this text? */
function markerShown (text) {
  const pattern = COMPLETE_MARK.split(/\s+/).join('\\s+')
  return new RegExp(pattern, 'i').test(String(text || ''))
}

function forceContinue () {
  const config = readConfig()
  const custom = typeof config.forceContinuePrompt === 'string'
    ? config.forceContinuePrompt
    : ''
  return {
    enabled: config.forceContinue === true,
    custom,
    prompt: forceContinuePrompt(custom)
  }
}

/** Store the switch. Returns its new value. */
function setForceContinue (value) {
  const on = Boolean(value)
  updateConfig('forceContinue', on ? true : undefined)
  logLine('info', on ? 'forceContinue.on' : 'forceContinue.off')
  logEvent('forceContinue.switch', { enabled: on })
  return on
}

/**
 * Store the automatic prompt. An empty value restores the built-in text, so
 * the key is removed rather than written as an empty string.
 */
function setForceContinuePrompt (text) {
  const value = String(text || '').trim()
  updateConfig('forceContinuePrompt', value || undefined)
  logLine('info', value ? 'forceContinue.prompt' : 'forceContinue.prompt_default', {
    prompt: value.slice(0, 300)
  })
  logEvent('forceContinue.prompt', { custom: Boolean(value) })
  return value
}

function shutdownTimer () {
  return readConfig().shutdownTimer === true
}

function setShutdownTimer (value) {
  const on = Boolean(value)
  updateConfig('shutdownTimer', on ? true : undefined)
  logLine('info', on ? 'shutdownTimer.on' : 'shutdownTimer.off')
  logEvent('shutdownTimer.switch', { enabled: on })
  return on
}

/** Everything the dashboard needs, in one read of the config file. */
function summary () {
  return {
    forceContinue: forceContinue(),
    shutdownTimer: { enabled: shutdownTimer() }
  }
}

function flagPath (name, home) {
  return path.join(home || paths().home, name)
}

function poweroffScript () {
  return path.join(__dirname, '..', 'wait-and-poweroff.sh')
}

/**
 * Mark the work done and start the detached poweroff watcher.
 *
 * The watcher (`wait-and-poweroff.sh`) waits for the given pids to be gone and
 * for the marker, with a backup deadline, so a session that hangs cannot leave
 * the machine on all day. Powering off goes through logind, which a local
 * session may call without a password; no sudo is involved.
 */
function armShutdown ({
  pids = [],
  home,
  platform = process.platform,
  spawnFn = spawn,
  env = process.env
} = {}) {
  if (platform === 'win32') {
    logLine('warn', 'shutdown timer is not available on Windows')
    logEvent('shutdown.unsupported', { platform })
    return false
  }
  const script = poweroffScript()
  if (!fs.existsSync(script)) {
    logLine('warn', 'shutdown timer: wait-and-poweroff.sh is missing')
    logEvent('shutdown.missing_script', { script })
    return false
  }

  const alive = pids
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 1)

  try {
    ensureDirs()
    fs.writeFileSync(flagPath('agent-done', home), new Date().toISOString(), { mode: 0o600 })
    // A cancel file left by an earlier poweroff would disarm this one.
    try {
      fs.unlinkSync(flagPath('shutdown-cancel', home))
    } catch {
      // Nothing was pending.
    }
  } catch (error) {
    logLine('error', 'shutdown timer: could not write the done marker', { error: error.message })
    logEvent('shutdown.failed', { error: error.message })
    return false
  }

  try {
    const child = spawnFn('/bin/sh', [script, ...alive.map(String)], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...env,
        FREEBUFFS_HOME: home || paths().home,
        FREEBUFFS_POWEROFF_AFTER_MINUTES: String(SHUTDOWN_BACKUP_MINUTES)
      }
    })
    if (child && typeof child.on === 'function') child.on('error', () => {})
    if (child && typeof child.unref === 'function') child.unref()
  } catch (error) {
    logLine('error', 'shutdown timer: could not start the watcher', { error: error.message })
    logEvent('shutdown.failed', { error: error.message })
    return false
  }

  logLine('info', 'shutdown timer armed', {
    pids: alive.join(','),
    backup: `${SHUTDOWN_BACKUP_MINUTES}m`
  })
  logEvent('shutdown.armed', {
    pids: alive,
    backupMinutes: SHUTDOWN_BACKUP_MINUTES
  })
  return true
}

/**
 * Cancel a pending poweroff. The watcher polls for the cancel file, so this
 * works even when the supervisor that armed it is already gone.
 */
function cancelShutdown ({ home, spawnFn = spawn } = {}) {
  const marker = flagPath('agent-done', home)
  if (!fs.existsSync(marker)) return false
  try {
    fs.unlinkSync(marker)
  } catch {
    // The watcher may have just consumed it.
  }
  try {
    fs.writeFileSync(flagPath('shutdown-cancel', home), new Date().toISOString(), { mode: 0o600 })
  } catch {
    logLine('warn', 'shutdown timer: could not write the cancel file')
  }
  // The watcher removes the cancel file itself; nothing spurious is spawned.
  void spawnFn
  logLine('info', 'shutdown timer cancelled')
  logEvent('shutdown.cancelled', {})
  return true
}

module.exports = {
  COMPLETE_MARK,
  FORCE_IDLE_MS,
  SHUTDOWN_BACKUP_MINUTES,
  DEFAULT_PROMPT,
  forceContinuePrompt,
  markerShown,
  forceContinue,
  setForceContinue,
  setForceContinuePrompt,
  shutdownTimer,
  setShutdownTimer,
  summary,
  armShutdown,
  cancelShutdown
}
