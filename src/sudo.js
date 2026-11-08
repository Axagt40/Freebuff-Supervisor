'use strict'

/**
 * Sudo credentials for an unattended supervisor.
 *
 * A 24/7 session may need root (package installs, systemd units, docker), and
 * there is nobody at the keyboard to answer a password prompt. The supervisor
 * therefore asks once, when it starts, keeps the answer in a `0600` file for as
 * long as it is running, and deletes it when it closes.
 *
 * Two things make the stored password usable by a session:
 *
 *   SUDO_ASKPASS   points at a helper that prints the password, which is how
 *                  `sudo -A` obtains it. The launcher only exports it into
 *                  sessions the supervisor started.
 *   a `sudo` shim  on the session's PATH. freebuff runs commands with piped
 *                  stdio, so a plain `sudo` there can neither prompt nor ask.
 *                  The shim uses `-A` when there is no terminal to prompt on,
 *                  and the real interactively-prompting `sudo` when there is.
 *
 * The file lives in ~/.freebuffs/secrets with mode 0600, which means anything
 * running as this user can read it while the supervisor runs. That is the
 * trade-off the plaintext mode was chosen with; `sfreebuff sudo off` (or
 * FREEBUFFS_SUDO=0) turns the whole thing off, and closing the supervisor
 * removes the file, the helper and the shim, and drops the cached credential
 * with `sudo -k`.
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { paths, ensureDirs } = require('./paths')
const { logLine, logEvent } = require('./log')
const { readConfig, updateConfig } = require('./config')
const { safeUnlink } = require('./util')

const SECRET_NAME = 'sudo.pass'
const ASKPASS_NAME = 'sudo-askpass.sh'
const SHIM_NAME = 'sudo'
const VALIDATE_TIMEOUT_MS = 20000

function secretsDir () {
  return path.join(paths().home, 'secrets')
}

function secretPath () {
  return path.join(secretsDir(), SECRET_NAME)
}

function askpassPath () {
  return path.join(secretsDir(), ASKPASS_NAME)
}

function shimDir () {
  return path.join(secretsDir(), 'shim')
}

function shimPath () {
  return path.join(shimDir(), SHIM_NAME)
}

/**
 * Default on. The environment wins for a single run (`FREEBUFFS_SUDO=0`), then
 * the stored preference written by `sfreebuff sudo off`, then the default.
 */
function enabled (env = process.env) {
  const raw = String((env && env.FREEBUFFS_SUDO) || '').trim().toLowerCase()
  if (raw !== '') return !['0', 'false', 'no', 'off'].includes(raw)
  return readConfig().sudoUnlock !== false
}

/** Store the preference for future runs. */
function setEnabled (value) {
  updateConfig('sudoUnlock', value ? undefined : false)
  return Boolean(value)
}

const realSudo = () => process.env.FREEBUFFS_SUDO_BIN || '/usr/bin/sudo'

/** Is sudo present, and would it ask for a password right now? */
function status () {
  const result = spawnSync(realSudo(), ['-n', '-v'], { stdio: 'ignore' })
  if (result.error) return { available: false, required: false, cached: false }
  return {
    available: true,
    required: result.status !== 0,
    cached: result.status === 0
  }
}

function isActive () {
  try {
    return fs.statSync(secretPath()).isFile()
  } catch {
    return false
  }
}

/** The stored password, or null. Never logged, never printed. */
function read () {
  try {
    return fs.readFileSync(secretPath(), 'utf8').replace(/\r?\n$/, '')
  } catch {
    return null
  }
}

const ESCAPE_SEQUENCE = /\u001b\[[0-9;?]*[A-Za-z~]/g

/**
 * Apply terminal keystrokes to the hidden buffer.
 *
 * The original password is the value after the last submit; nothing here
 * echoes it. `echo` is what may be drawn instead: one `*` per accepted
 * character, and a backspace-space-backspace for each one removed.
 */
function applyKeys (value, chunk) {
  let next = String(value || '')
  let echo = ''
  let submitted = false
  let cancelled = false

  for (const char of String(chunk || '').replace(ESCAPE_SEQUENCE, '')) {
    if (char === '\r' || char === '\n') {
      submitted = true
      break
    }
    if (char === '\u0003' || char === '\u0004') {
      cancelled = true
      break
    }
    if (char === '\u007f' || char === '\b') {
      if (next.length > 0) {
        next = next.slice(0, -1)
        echo += '\b \b'
      }
      continue
    }
    // Other control keys (tab, arrow tails, ...) carry no password text.
    if (char < ' ') continue
    next += char
    echo += '*'
  }

  return { value: next, echo, submitted, cancelled }
}

/**
 * Read one line from the terminal without echoing it.
 *
 * readline cannot be used here: it echoes the line to its output stream, and
 * closing it emits `close` synchronously, which would settle the promise
 * before the typed answer is delivered. Raw mode keeps the terminal itself
 * from echoing, and one `*` per character confirms that typing is happening
 * without putting the password on screen or in the scrollback.
 */
function askHidden (question) {
  const stdin = process.stdin
  const stdout = process.stdout
  if (!stdin || !stdout || !stdin.isTTY || !stdout.isTTY) return Promise.resolve(null)

  return new Promise((resolve) => {
    let value = ''
    let settled = false
    const wasRaw = Boolean(stdin.isRaw)

    const finish = (answer) => {
      if (settled) return
      settled = true
      stdin.removeListener('data', onData)
      try {
        stdin.setRawMode(wasRaw)
      } catch {
        // The terminal may be gone; nothing else can be done about it.
      }
      try {
        stdin.pause()
      } catch {
        // Ignore.
      }
      stdout.write('\n')
      resolve(answer)
    }

    const onData = (chunk) => {
      const state = applyKeys(value, chunk)
      value = state.value
      if (state.echo) stdout.write(state.echo)
      if (state.cancelled) return finish(null)
      if (state.submitted) finish(value)
    }

    try {
      stdin.setRawMode(true)
    } catch {
      return resolve(null)
    }
    stdin.resume()
    stdin.on('data', onData)
    stdout.write(question)
  })
}

/** Does sudo accept this password? Validates without leaving it anywhere. */
function validate (password) {
  try {
    const result = spawnSync(realSudo(), ['-S', '-v'], {
      input: `${password}\n`,
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: VALIDATE_TIMEOUT_MS
    })
    return result.status === 0
  } catch {
    return false
  }
}

function writeFileSecure (target, contents, mode) {
  fs.writeFileSync(target, contents, { mode })
  fs.chmodSync(target, mode)
}

/** A helper that prints the stored password for `sudo -A`. */
function installAskpass () {
  const script = [
    '#!/bin/sh',
    '# Written by the freebuff supervisor; removed when it closes.',
    `exec cat ${JSON.stringify(secretPath())}`
  ].join('\n') + '\n'
  writeFileSecure(askpassPath(), script, 0o700)
  return askpassPath()
}

/**
 * A `sudo` on PATH that can answer for itself. With a terminal it defers to the
 * real sudo (so a person still sees and answers the prompt); without one it
 * asks the helper.
 */
function installShim (askpass) {
  fs.mkdirSync(shimDir(), { recursive: true, mode: 0o700 })
  const script = [
    '#!/bin/sh',
    '# Written by the freebuff supervisor; removed when it closes.',
    `SUDO_ASKPASS=${JSON.stringify(askpass)}`,
    'export SUDO_ASKPASS',
    'if [ -t 0 ] || [ -t 1 ]; then',
    `  exec ${JSON.stringify(realSudo())} "$@"`,
    'fi',
    `exec ${JSON.stringify(realSudo())} -A "$@"`
  ].join('\n') + '\n'
  writeFileSecure(shimPath(), script, 0o755)
  return shimDir()
}

function store (password) {
  ensureDirs()
  fs.mkdirSync(secretsDir(), { recursive: true, mode: 0o700 })
  fs.chmodSync(secretsDir(), 0o700)
  writeFileSecure(secretPath(), password, 0o600)
  return { askpass: installAskpass(), shim: installShim(askpassPath()) }
}

/**
 * Remove everything, and drop the sudo timestamp we refreshed. Idempotent, so
 * it is safe from an exit handler and from a signal handler at the same time.
 */
function clear () {
  const removed = []
  for (const target of [secretPath(), askpassPath(), shimPath()]) {
    if (safeUnlink(target)) removed.push(target)
  }
  try {
    fs.rmdirSync(shimDir())
  } catch {
    // Not empty, or already gone.
  }
  try {
    fs.rmdirSync(secretsDir())
  } catch {
    // Not empty, or already gone.
  }
  if (removed.length > 0) {
    // Forget the cached credential too, so a closed supervisor leaves no way in.
    try {
      spawnSync(realSudo(), ['-k'], { stdio: 'ignore', timeout: 5000 })
    } catch {
      // Ignore.
    }
    logEvent('sudo.cleared', { files: removed.length })
  }
  return removed
}

/**
 * Ask for the password when the supervisor starts. Returns a small handle the
 * launcher uses to hand the credentials to sessions and to clean up.
 */
async function start ({ enabled: optedIn = enabled(), interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) } = {}) {
  if (!optedIn) return { active: false, reason: 'disabled' }

  const state = status()
  if (!state.available) return { active: false, reason: 'sudo not found' }
  if (state.cached) {
    // Already unlocked; still install the helpers so sessions can use them.
    const password = isActive() ? read() : null
    if (!password) return { active: false, reason: 'already unlocked' }
    const files = store(password)
    return { active: true, env: envFor(files), reason: 'already unlocked' }
  }

  if (!interactive) {
    return { active: false, reason: 'no terminal to ask for a sudo password' }
  }

  const password = await askHidden('sudo password (kept until the supervisor closes, then deleted): ')
  if (!password) {
    console.log('sfreebuff: no sudo password given — sessions will not be able to use sudo.')
    logLine('warn', 'sudo.skipped', { reason: 'no password given' })
    return { active: false, reason: 'no password given' }
  }

  if (!validate(password)) {
    console.log('sfreebuff: sudo rejected that password — sessions will not be able to use sudo.')
    logLine('warn', 'sudo.invalid', {})
    logEvent('sudo.invalid', {})
    return { active: false, reason: 'password rejected by sudo' }
  }

  const files = store(password)
  logLine('info', 'sudo.ready', {})
  logEvent('sudo.ready', {})
  return { active: true, env: envFor(files), reason: 'unlocked' }
}

/** Environment a session needs in order for `sudo` to work unattended. */
function envFor ({ askpass, shim }) {
  return { SUDO_ASKPASS: askpass, FREEBUFFS_SUDO_SHIM: shim }
}

module.exports = {
  applyKeys,
  secretPath,
  askpassPath,
  shimDir,
  shimPath,
  enabled,
  setEnabled,
  status,
  isActive,
  read,
  askHidden,
  validate,
  store,
  clear,
  start,
  envFor
}
