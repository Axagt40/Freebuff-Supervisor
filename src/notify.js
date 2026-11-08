'use strict'

const { configPath, readConfig, writeConfig } = require('./config')
const { logLine, logEvent } = require('./log')
const { shortHome, formatDuration } = require('./util')

/**
 * Session reports for a Discord channel.
 *
 * The webhook URL is a secret, so it is never compiled in, never printed and
 * never written to the supervisor log: it lives in ~/.freebuffs/config.json, or
 * in FREEBUFFS_DISCORD_WEBHOOK for a single run. Posting is best effort — a
 * failed report is logged and otherwise ignored, so it can never slow down or
 * break a session.
 */

const TIMEOUT_MS = 5000
const DISCORD_HOSTS = ['discord.com', 'discordapp.com']
const USAGE = `usage:
  sfreebuff notify <webhook-url>   post session reports to a Discord webhook
  sfreebuff notify off             stop posting reports
  sfreebuff notify test            send one test report now`

function isWebhookUrl (value) {
  try {
    const parsed = new URL(String(value).trim())
    return parsed.protocol === 'https:' &&
      DISCORD_HOSTS.includes(parsed.hostname) &&
      parsed.pathname.startsWith('/api/webhooks/')
  } catch {
    return false
  }
}

/** The environment wins, so a one-off run can override the stored webhook. */
function webhookUrl (env = process.env) {
  const fromEnv = String((env && env.FREEBUFFS_DISCORD_WEBHOOK) || '').trim()
  if (fromEnv) return fromEnv
  const stored = readConfig().discordWebhook
  return typeof stored === 'string' ? stored.trim() : ''
}

/** Store a webhook, or clear it with '' / `off`. Throws on anything else. */
function setWebhook (value) {
  const trimmed = String(value || '').trim()
  const config = readConfig()

  if (trimmed === '' || trimmed.toLowerCase() === 'off') {
    delete config.discordWebhook
    writeConfig(config)
    return { cleared: true }
  }
  if (!isWebhookUrl(trimmed)) {
    throw new Error(
      'expected a Discord webhook URL (https://discord.com/api/webhooks/...) or `off`'
    )
  }
  config.discordWebhook = trimmed
  writeConfig(config)
  return { cleared: false }
}

/** POST one message. Never throws: reporting is best effort. */
async function send (content, options = {}) {
  const url = options.url || webhookUrl()
  if (!url) return { sent: false, reason: 'no webhook configured' }

  const timeoutMs = options.timeoutMs || TIMEOUT_MS
  const doFetch = options.fetchImpl || fetch

  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // allowed_mentions stops a folder name like "@everyone" from pinging the
      // whole channel. A critical report is the one message that is allowed to
      // ping, and even then only because every interpolated value below has
      // had its @ neutralised.
      body: JSON.stringify({
        content,
        allowed_mentions: options.mention ? { parse: ['everyone'] } : { parse: [] }
      }),
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok) {
      return { sent: false, reason: `discord responded ${response.status}` }
    }
    return { sent: true }
  } catch (error) {
    return { sent: false, reason: error.message }
  }
}

/**
 * Fire-and-forget a report, recording the outcome in the supervisor log.
 * Resolves to whether it was delivered; a pending post keeps the process alive
 * just long enough to finish, which is what we want at session end.
 */
function report (content, extra = {}) {
  if (!webhookUrl()) return Promise.resolve(false)
  return send(content, { mention: Boolean(extra.mention) })
    .then((result) => {
      logEvent(result.sent ? 'report.sent' : 'report.failed', {
        kind: extra.kind,
        session: extra.session,
        account: extra.account,
        reason: result.reason
      })
      if (!result.sent) {
        logLine('warn', 'report not delivered', {
          kind: extra.kind,
          reason: result.reason
        })
      }
      return result.sent
    })
    .catch(() => false)
}

/**
 * `@` is broken up with a zero-width space in anything we interpolate, so a
 * folder called `@everyone` can never ping a channel even when the message
 * itself is allowed to ping.
 */
function plain (value) {
  return String(value == null ? '' : value).replace(/@/g, '@\u200b')
}

/** Backticks are stripped so a path can never break the message formatting. */
function code (value) {
  return `\`${plain(value).replace(/`/g, '')}\``
}

const TITLE = '**Freebuff Supervisor**'

function sessionStarted ({ accountId, sessionId, cwd, binary }) {
  return [
    `${TITLE} · session started`,
    `account: ${code(accountId)}`,
    `folder: ${code(shortHome(cwd))}`,
    `session: ${code(sessionId)}`,
    `freebuff: ${code(shortHome(binary) || 'unknown')}`
  ].join('\n')
}

/** Posted once when a supervisor run begins. */
function supervisorStarted ({ cwd, accounts, signedIn, mode, sudo, pty, monitorPid }) {
  return [
    `${TITLE} · started`,
    `folder: ${code(shortHome(cwd))}`,
    `accounts: ${code(`${signedIn}/${accounts}`)}`,
    `mode: ${code(mode)}`,
    `sudo: ${code(sudo)}`,
    `auto-answer: ${code(pty ? 'on' : 'off')}`,
    `monitor: ${code(monitorPid ? `pid ${monitorPid}` : 'none')}`
  ].join('\n')
}

/** Posted once when a supervisor run ends, however it ends. */
function supervisorStopped ({ cwd, reason, attempts, uptimeMs, code: exitCode }) {
  return [
    `${TITLE} · stopped`,
    `folder: ${code(shortHome(cwd))}`,
    `reason: ${plain(reason || 'session finished')}`,
    `sessions: ${code(attempts || 1)}`,
    `uptime: ${formatDuration(uptimeMs || 0)}`,
    `exit: ${code(exitCode == null ? 'unknown' : exitCode)}`
  ].join('\n')
}

function sessionEnded ({ accountId, sessionId, cwd, code: exitCode, signal, durationMs, cause, report, restarting, limited }) {
  const status = signal ? `signal ${signal}` : `exit code ${exitCode}`
  return [
    `${TITLE} · session ended (${status})`,
    `account: ${code(accountId)}`,
    `folder: ${code(shortHome(cwd))}`,
    `session: ${code(sessionId)}`,
    `duration: ${formatDuration(durationMs)}`,
    limited ? `state: ${plain(limited)}` : null,
    cause ? `cause: ${plain(cause).slice(0, 200)}` : null,
    report ? `report: ${code(shortHome(report))}` : null,
    `next: ${restarting ? 'restarting automatically' : 'stopped'}`
  ].filter(Boolean).join('\n')
}

/**
 * An account has no free sessions left. Not CRITICAL: the supervisor handles
 * this by itself, by switching account or waiting for the quota reset.
 */
function sessionLimited ({ accountId, sessionId, cwd, detail }) {
  return [
    `${TITLE} · free sessions used up`,
    accountId ? `account: ${code(accountId)}` : null,
    sessionId ? `session: ${code(sessionId)}` : null,
    cwd ? `folder: ${code(shortHome(cwd))}` : null,
    detail ? `detail: ${plain(detail).slice(0, 300)}` : null,
    'next: switching to another signed-in account, or waiting for the reset and continuing the task'
  ].filter(Boolean).join('\n')
}

function authFailure ({ accountId, sessionId, detail }) {
  return [
    `${TITLE} · account needs sign-in`,
    `account: ${code(accountId)}`,
    `session: ${code(sessionId)}`,
    `detail: ${String(detail || '').slice(0, 300)}`,
    `fix: \`sfreebuff login --account ${String(accountId).replace(/`/g, '')}\``
  ].join('\n')
}

/**
 * The one report that asks a person to do something. Everything else is
 * informational; this one means the supervisor has stopped trying.
 */
function critical ({ reason, detail, accountId, sessionId, cwd, action }) {
  return [
    `${TITLE} · **CRITICAL — user interaction required**`,
    `reason: ${plain(reason || 'unknown').slice(0, 300)}`,
    detail ? `detail: ${plain(detail).slice(0, 400)}` : null,
    accountId ? `account: ${code(accountId)}` : null,
    sessionId ? `session: ${code(sessionId)}` : null,
    cwd ? `folder: ${code(shortHome(cwd))}` : null,
    `action: ${plain(action || 'standard')}`,
    '@here — the supervisor stopped and will not continue on its own.'
  ].filter(Boolean).join('\n')
}

/**
 * A prompt the supervisor typed but could not get sent. The session is alive,
 * so this is a warning rather than a call for a person — it is reported so a
 * session that looks busy but is waiting at its input box is visible.
 */
function promptUnsent ({ prompt, sessionId, accountId, cwd }) {
  return [
    `${TITLE} · prompt could not be sent`,
    'reason: a prompt typed into the session stayed in the input box',
    `prompt: ${plain(prompt).slice(0, 200)}`,
    sessionId ? `session: ${code(sessionId)}` : null,
    accountId ? `account: ${code(accountId)}` : null,
    cwd ? `folder: ${code(shortHome(cwd))}` : null,
    'action: the session is retired and the conversation relaunched, so the task can be typed into a clean input box'
  ].filter(Boolean).join('\n')
}

/** A dialog the supervisor refused to answer on its own. */
function needsInput ({ prompt, sessionId, accountId, cwd }) {
  return [
    `${TITLE} · **CRITICAL — user interaction required**`,
    'reason: freebuff is waiting on a question the supervisor will not answer alone',
    `question: ${plain(prompt).slice(0, 400)}`,
    sessionId ? `session: ${code(sessionId)}` : null,
    accountId ? `account: ${code(accountId)}` : null,
    cwd ? `folder: ${code(shortHome(cwd))}` : null,
    'action: answer it in the freebuff window, then the session continues'
  ].filter(Boolean).join('\n')
}

/** `sfreebuff notify ...`; returns a process exit code. */
async function notifyCommand (argv = []) {
  const [action, ...rest] = argv

  if (!action || action === 'help' || action === '--help' || action === '-h') {
    console.log(USAGE)
    return 0
  }

  if (action === 'off') {
    setWebhook('')
    logLine('info', 'notify.off')
    console.log('reports off — the supervisor will not post anything.')
    return 0
  }

  if (action === 'test') {
    if (!webhookUrl()) {
      console.error(`sfreebuff: no webhook configured — ${USAGE.split('\n')[1].trim()}`)
      return 1
    }
    const result = await send(`${TITLE} · test report — reporting works.`)
    if (!result.sent) {
      console.error(`sfreebuff: test report not delivered — ${result.reason}`)
      return 1
    }
    console.log('test report delivered.')
    return 0
  }

  // Accept both `notify <url>` and `notify set <url>`.
  const value = action === 'set' ? rest.join(' ').trim() : [action, ...rest].join(' ').trim()
  try {
    setWebhook(value)
  } catch (error) {
    console.error(`sfreebuff: ${error.message}`)
    return 1
  }
  logLine('info', 'notify.on')
  console.log(`reports on — session reports will be posted (webhook kept in ${shortHome(configPath())}).`)
  return 0
}

module.exports = {
  TITLE,
  configPath,
  readConfig,
  writeConfig,
  isWebhookUrl,
  webhookUrl,
  setWebhook,
  send,
  report,
  plain,
  sessionStarted,
  sessionEnded,
  supervisorStarted,
  supervisorStopped,
  authFailure,
  critical,
  needsInput,
  promptUnsent,
  sessionLimited,
  notifyCommand
}
