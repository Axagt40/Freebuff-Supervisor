'use strict'

const fs = require('fs')
const os = require('os')
const { spawnSync } = require('child_process')

function nowIso () {
  return new Date().toISOString()
}

function isPidAlive (pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * The command line of a running process, or null when it cannot be read.
 *
 * Linux answers from /proc; the other Unixes are asked through ps. Windows has
 * no cheap equivalent here, so it answers null — and a pid that cannot be
 * identified is never signalled.
 */
function processCommand (pid) {
  if (!isPidAlive(pid)) return null
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    const text = raw.split('\0').filter(Boolean).join(' ').trim()
    if (text) return text
  } catch {
    // Not Linux, or the process exited between the checks.
  }
  if (process.platform === 'win32') {
    // Windows has no /proc; the process's CIM record carries the command line.
    try {
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`
        ],
        { encoding: 'utf8', timeout: 3000, windowsHide: true }
      )
      const text = String(result.stdout || '').trim()
      return text || null
    } catch {
      return null
    }
  }
  try {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 2000
    })
    const text = String(result.stdout || '').trim()
    return text || null
  } catch {
    return null
  }
}

/**
 * Is this pid still running the program it was recorded for?
 *
 * A pid written to a state or heartbeat file is only true at the moment it is
 * written. On a machine that runs for days the number is later handed out to an
 * unrelated process, and the desktop shell or another supervisor is as likely
 * to hold it as the program that was meant. Signalling such a pid is how a
 * supervisor retired somebody else's process mid-task — the desktop included.
 *
 * `expected` is a string (a substring of the command line) or a RegExp; an
 * array requires all of them to match.
 */
function processMatches (pid, expected) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  const command = processCommand(pid)
  if (!command) return false
  const patterns = Array.isArray(expected) ? expected : [expected]
  return patterns.every((pattern) =>
    typeof pattern === 'string' ? command.includes(pattern) : pattern.test(command)
  )
}

/**
 * Command lines a recorded session's pids still have to look like.
 *
 * The freebuff binary is matched as a whole path component, so a project folder
 * such as `~/Downloads/freebuff-desktop` — or anything else whose name merely
 * contains the word — does not pass. The supervisor is the node launcher.
 */
const FREEBUFF_COMMAND = /(?:^|[\\/])freebuff(?:\.exe)?(?:\s|$)/
const SUPERVISOR_COMMAND = /sfreebuff(?:\.js)?(?:\s|$)/

/**
 * Is this recorded session still running?
 *
 * A session's pid is written once and trusted afterwards, but a number that
 * used to be freebuff is not freebuff forever: an exited session hands its pid
 * back to the kernel, and a dead-but-unreaped one (a zombie) still answers
 * `kill(pid, 0)` while having no command line at all. Reading liveness from the
 * number alone made the dashboard list such a record as LIVE while `x` refused
 * to touch it — the pid was alive, but it was not that session, and the row
 * could never be stopped or cleared.
 *
 * Both the view and the stop now ask this one question, so a row that says live
 * is a row `x` can act on.
 *
 * @param {object} session  a session record from state.json
 * @param {{alive?: (pid: number) => boolean, verify?: (pid: number, pattern: RegExp) => boolean}} [options]
 */
function sessionAlive (session, options = {}) {
  if (!session || session.endedAt) return false
  const alive = options.alive || isPidAlive
  const verify = options.verify || processMatches
  // The freebuff TUI itself.
  if (alive(session.pid) && verify(session.pid, FREEBUFF_COMMAND)) return true
  // Its supervisor: still alive between attempts, and before the first pid of
  // a session is known.
  return alive(session.launcherPid) && verify(session.launcherPid, SUPERVISOR_COMMAND)
}

/**
 * Signal a pid only while it still matches `expected`. Returns whether the
 * signal was sent. PID 1 and the non-positive pids are refused: on POSIX a
 * negative pid is a process group and -1 is every process the user may signal,
 * so a stale number must never reach that call.
 */
function killIfMatches (pid, expected, signal = 'SIGTERM', options = {}) {
  if (!processMatches(pid, expected)) return false
  const kill = options.kill || process.kill
  try {
    kill(pid, signal)
    return true
  } catch {
    return false
  }
}

function readJson (file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function safeUnlink (file) {
  try {
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}

/** `~`-shortened path for human-facing output. */
function shortHome (target) {
  const home = os.homedir()
  return target && target.startsWith(home) ? `~${target.slice(home.length)}` : target
}

function formatDuration (ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, '0')}h`
}

module.exports = {
  nowIso,
  isPidAlive,
  processCommand,
  processMatches,
  sessionAlive,
  FREEBUFF_COMMAND,
  SUPERVISOR_COMMAND,
  killIfMatches,
  readJson,
  safeUnlink,
  formatDuration,
  shortHome
}
