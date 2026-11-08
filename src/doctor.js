'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { defaultConfigDir, paths, ensureDirs } = require('./paths')
const { loadState, mutateState } = require('./state')
const accounts = require('./accounts')
const { activeMonitors } = require('./status')
const { isPidAlive, readJson, shortHome, formatDuration } = require('./util')
const sudo = require('./sudo')
const { available: ptyAvailable } = require('./ptyrun')
const { stopRequested } = require('./supervise')

const SUPPORT_FILES = ['rg', 'tree-sitter.wasm']

function report (status, name, detail) {
  return { status, name, detail }
}

function checkNodeVersion () {
  const major = Number(String(process.versions.node).split('.')[0])
  if (major >= 18) return report('ok', 'node', process.versions.node)
  return report('fail', 'node', `${process.versions.node} — sfreebuff needs >= 18`)
}

function checkHome () {
  try {
    ensureDirs()
    return report('ok', 'supervisor', shortHome(paths().home))
  } catch (error) {
    return report('fail', 'supervisor', `${paths().home} — ${error.message}`)
  }
}

function binaryVersion () {
  const metadata = readJson(path.join(defaultConfigDir(), 'freebuff-metadata.json'))
  if (metadata && metadata.version) return metadata.version
  return null
}

function checkBinary () {
  const binary = process.env.FREEBUFFS_BINARY
    ? path.resolve(process.env.FREEBUFFS_BINARY)
    : path.join(defaultConfigDir(), process.platform === 'win32' ? 'freebuff.exe' : 'freebuff')

  if (!fs.existsSync(binary)) {
    return report(
      'fail',
      'freebuff binary',
      `${shortHome(binary)} missing — install with \`npm install -g freebuff\` and run \`freebuff --version\` once`
    )
  }
  try {
    fs.accessSync(binary, fs.constants.X_OK)
  } catch {
    return report('fail', 'freebuff binary', `${shortHome(binary)} is not executable`)
  }
  const version = binaryVersion()
  return report('ok', 'freebuff binary', `${shortHome(binary)}${version ? ` (${version})` : ''}`)
}

function liveFiles (account) {
  const dir = accounts.accountConfigDir(account)
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return { active: 0, stale: 0, missing: true }
  }
  let active = 0
  let stale = 0
  for (const name of names) {
    if (!/^freebuff-live-\d+\.json$/.test(name)) continue
    const data = readJson(path.join(dir, name))
    if (data && isPidAlive(Number(data.ownerPid))) active += 1
    else stale += 1
  }
  return { active, stale, missing: false }
}

function checkAccounts () {
  mutateState((current) => accounts.ensureDefaultAccount(current))
  const stateAfter = loadState()
  const signedIn = stateAfter.accounts.filter(accounts.isSignedIn)
  const results = []

  if (stateAfter.accounts.length === 0) {
    results.push(report('fail', 'accounts', 'no containers — run `sfreebuff login`'))
    return results
  }
  if (signedIn.length === 0) {
    results.push(report('fail', 'accounts', '0 signed in — run `sfreebuff login`'))
  } else {
    results.push(
      report('ok', 'accounts', `${signedIn.length}/${stateAfter.accounts.length} signed in`)
    )
  }

  for (const account of stateAfter.accounts) {
    const dir = accounts.accountConfigDir(account)
    if (!fs.existsSync(dir)) {
      results.push(
        report('warn', account.id, `${shortHome(dir)} missing — \`sfreebuff login --account ${account.id}\``)
      )
      continue
    }
    if (!accounts.isSignedIn(account)) {
      results.push(
        report('warn', account.id, `not signed in — \`sfreebuff login --account ${account.id}\``)
      )
    } else if (accounts.authFailureActive(account)) {
      results.push(
        report('warn', `${account.id} auth`, `last session reported an auth failure — \`sfreebuff login --account ${account.id}\``)
      )
    } else {
      const { expiresAt } = accounts.credentialExpiry(account)
      if (expiresAt && expiresAt - Date.now() <= accounts.expiryGraceMs()) {
        const when = expiresAt <= Date.now()
          ? 'credentials expired'
          : `credentials expire in ${formatDuration(expiresAt - Date.now())}`
        results.push(
          report('warn', `${account.id} expiry`, `${when} — \`sfreebuff login --account ${account.id}\``)
        )
      }
    }
    const missingSupport = SUPPORT_FILES.filter(
      (name) => !fs.existsSync(path.join(dir, name)) &&
        !fs.existsSync(path.join(defaultConfigDir(), name))
    )
    if (missingSupport.length > 0) {
      results.push(
        report('warn', account.id, `missing ${missingSupport.join(', ')} — freebuff may refetch them`)
      )
    }
    const live = liveFiles(account)
    if (live.stale > 0) {
      results.push(
        report('warn', `${account.id} sessions`, `${live.stale} stale live file(s), removed on the next monitored run`)
      )
    }
  }

  return results
}

function checkMonitors () {
  const state = loadState()
  const monitors = activeMonitors()
  const activeSessions = state.sessions.filter(
    (session) => !session.endedAt && isPidAlive(session.pid)
  )
  if (activeSessions.length > 0 && monitors.length === 0) {
    return report(
      'warn',
      'monitor',
      `${activeSessions.length} live session(s) without a monitor — launched with --no-monitor?`
    )
  }
  if (monitors.length === 0) return report('ok', 'monitor', 'idle')
  return report('ok', 'monitor', `${monitors.length} running`)
}

function checkAutoAnswer () {
  if (ptyAvailable()) {
    return report('ok', 'auto-answer', 'node-pty available — a pty answers dialogs and resumes the task')
  }
  return report(
    'warn',
    'auto-answer',
    'node-pty not installed — no pty, so sessions cannot be answered or nudged (`npm install node-pty`)'
  )
}

function checkSudo () {
  const state = sudo.status()
  if (!state.available) {
    return report('warn', 'sudo', 'not installed — sessions cannot use sudo')
  }
  const vault = sudo.isActive()
  if (vault) {
    return report('ok', 'sudo', `unlocked for the running supervisor (${shortHome(sudo.secretPath())})`)
  }
  if (!sudo.enabled()) return report('ok', 'sudo', 'off — `sfreebuff sudo on` to unlock it')
  if (state.cached) return report('ok', 'sudo', 'already unlocked for this terminal')
  return report('ok', 'sudo', 'password required; the supervisor asks once at startup')
}

function checkStopRequest () {
  if (!stopRequested()) return report('ok', 'stop', 'no stop requested')
  return report('warn', 'stop', 'a stop was requested — the next supervisor will stop')
}

function checkLog () {
  const probe = path.join(paths().logsDir, `.doctor-${process.pid}`)
  try {
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return report('ok', 'log', `${shortHome(paths().supervisorLog)} writable`)
  } catch (error) {
    return report('fail', 'log', error.message)
  }
}

/**
 * Health check for the pieces a session depends on. Read-only apart from
 * creating the supervisor dirs and removing nothing but stale heartbeat files
 * (via activeMonitors). Exit code 1 only for things that block a session.
 */
function doctor () {
  const results = [
    checkNodeVersion(),
    checkHome(),
    checkBinary(),
    ...checkAccounts(),
    checkMonitors(),
    checkAutoAnswer(),
    checkSudo(),
    checkStopRequest(),
    checkLog()
  ]

  console.log('sfreebuff doctor')
  for (const item of results) {
    const tag = item.status === 'ok' ? 'ok  ' : item.status === 'warn' ? 'warn' : 'fail'
    console.log(`  ${tag}  ${item.name.padEnd(16)} ${item.detail}`)
  }

  const failures = results.filter((item) => item.status === 'fail').length
  const warnings = results.filter((item) => item.status === 'warn').length
  console.log(
    failures > 0
      ? `\n${failures} problem(s), ${warnings} warning(s)`
      : warnings > 0
        ? `\nready, ${warnings} warning(s)`
        : '\nready'
  )
  return failures > 0 ? 1 : 0
}

module.exports = { doctor, liveFiles }
