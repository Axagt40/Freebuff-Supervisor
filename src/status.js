'use strict'

const fs = require('fs')
const path = require('path')
const pkg = require('../package.json')
const { paths } = require('./paths')
const { loadState, mutateState } = require('./state')
const accounts = require('./accounts')
const { isPidAlive, sessionAlive, readJson, safeUnlink, formatDuration, shortHome } = require('./util')
const { webhookUrl } = require('./notify')
const sudo = require('./sudo')
const { stopRequested } = require('./supervise')
const { available: ptyAvailable } = require('./ptyrun')
const credits = require('./credits')

const shortPath = shortHome

/** Heartbeats left by live monitors; stale files are removed. */
function activeMonitors () {
  const dir = paths().runDir
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }

  const active = []
  for (const name of names) {
    if (!/^monitor-.*\.json$/.test(name)) continue
    const file = path.join(dir, name)
    const data = readJson(file)
    if (data && isPidAlive(data.monitorPid)) {
      active.push(data)
    } else if (!data || !isPidAlive(data.monitorPid)) {
      safeUnlink(file)
    }
  }
  return active
}

async function status () {
  // A freshly installed machine still has the default freebuff account even
  // before its first launch, so create the record rather than reporting 0/0.
  mutateState((state) => accounts.ensureDefaultAccount(state))
  const state = loadState()
  const signedIn = state.accounts.filter(accounts.isSignedIn)
  const balances = await credits.getAll(signedIn)
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
  const monitors = activeMonitors()
  // A recorded pid is only this session while it is still freebuff (or its
  // supervisor), not merely some process that inherited the number.
  const liveSessions = state.sessions.filter((session) => sessionAlive(session))
  const recent = state.sessions.find((session) => session.endedAt)

  const lines = []
  lines.push(`sfreebuff ${pkg.version} · freebuff supervisor`)
  lines.push(`accounts   ${signedIn.length}/${state.accounts.length} signed in`)

  // Live balances, green to red as they run out. A free account with no paid
  // credits reads as an empty red balance, which is the truth the API gives.
  for (const account of signedIn) {
    const balance = balances.get(account.id)
    const detail = credits.describe(balance)
    const reset = balance && balance.ok && balance.resetsAt
      ? ` · resets ${String(balance.resetsAt).slice(0, 10)}`
      : ''
    lines.push(
      `credits    ${account.id} ${credits.paint(detail, balance, color)}${reset}`
    )
  }

  for (const account of signedIn.filter(accounts.authFailureActive).slice(0, 3)) {
    lines.push(
      `auth       ${account.id} needs sign-in — sfreebuff login --account ${account.id}`
    )
  }

  const grace = accounts.expiryGraceMs()
  for (const account of signedIn) {
    const { expiresAt } = accounts.credentialExpiry(account)
    if (!expiresAt || expiresAt - Date.now() > grace) continue
    const left = expiresAt - Date.now()
    const when = left <= 0 ? 'expired' : `expires in ${formatDuration(left)}`
    lines.push(
      `expiry     ${account.id} ${when} — sfreebuff login --account ${account.id}`
    )
  }

  if (liveSessions.length > 0) {
    for (const session of liveSessions.slice(0, 3)) {
      const elapsed = formatDuration(Date.now() - Date.parse(session.startedAt))
      lines.push(`session    ${session.accountId} · ${shortPath(session.cwd)} · ${elapsed}`)
    }
  } else {
    lines.push('session    idle')
  }

  lines.push(`monitor    ${monitors.length === 0 ? 'idle' : `${monitors.length} running`}`)

  if (recent) {
    const code = recent.exitCode === null || recent.exitCode === undefined
      ? 'ended'
      : `exited ${recent.exitCode}`
    const ago = formatDuration(Date.now() - Date.parse(recent.endedAt))
    lines.push(`recent     ${recent.accountId} · ${code} · ${ago} ago`)
  } else {
    lines.push('recent     no sessions yet')
  }

  const vault = sudo.isActive()
  const unlockWanted = sudo.enabled()
  lines.push(
    `sudo       ${vault
      ? `unlocked — password stored at ${shortPath(sudo.secretPath())}, deleted when the supervisor closes`
      : unlockWanted
        ? 'on — the supervisor asks at startup and deletes it when it closes'
        : 'off — sfreebuff sudo on'}`
  )
  lines.push(
    `auto-answer ${ptyAvailable() ? 'on (pty)' : 'off — npm install node-pty to enable a pty'}`
  )
  lines.push(
    stopRequested()
      ? 'stop       requested — the next supervisor to check will stop'
      : 'stop       none requested'
  )

  lines.push(`log        ${shortPath(paths().supervisorLog)}`)
  lines.push(
    webhookUrl()
      ? 'reports    discord webhook configured'
      : 'reports    off — sfreebuff notify <webhook-url>'
  )
  console.log(lines.join('\n'))
}

module.exports = { status, activeMonitors }
