'use strict'

/**
 * Remaining credits for an account.
 *
 * freebuff keeps the auth token in the OS keychain (Bun's libsecret store on
 * Linux), not in credentials.json. Where the token is readable — plaintext
 * credentials, or the Secret Service through python-gi — the same usage
 * endpoint freebuff's own UI calls answers with the remaining balance:
 *
 *   POST /api/v1/usage  { fingerprintId: "cli-usage", authToken }
 *   -> { usage, remainingBalance, balanceBreakdown, next_quota_reset }
 *
 * The token is used for that one request, never logged and never written. A
 * machine with no readable token or no network simply reports "unavailable"
 * instead of guessing, and the callers show that dim rather than as a balance.
 */

const fs = require('fs')
const { spawnSync } = require('child_process')

const accounts = require('./accounts')

const DEFAULT_USAGE_URL = 'https://www.codebuff.com/api/v1/usage'
const CACHE_MS = 60 * 1000
const FAILURE_CACHE_MS = 30 * 1000
const TOKEN_CACHE_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000

/** Keep the levels and their colours in one place for status and dashboard. */
const LEVELS = {
  green: { ansi: '32', label: 'healthy' },
  yellow: { ansi: '33', label: 'running low' },
  red: { ansi: '31', label: 'empty' },
  unknown: { ansi: '2', label: 'unavailable' }
}

const results = new Map()
const tokens = new Map()

/** Reads the token from Bun's libsecret entries (service freebuff-cli). */
const KEYCHAIN_SCRIPT = `
import sys
try:
    import gi
    gi.require_version('Secret', '1')
    from gi.repository import Secret
except Exception:
    sys.exit(3)
schema = Secret.Schema.new("com.oven-sh.bun.Secret", Secret.SchemaFlags.NONE, {
    "service": Secret.SchemaAttributeType.STRING,
    "account": Secret.SchemaAttributeType.STRING,
})
value = Secret.password_lookup_sync(
    schema, {"service": "freebuff-cli", "account": sys.argv[1]}, None
)
sys.stdout.write(value or "")
`

function usageUrl (env = process.env) {
  return String(env.FREEBUFFS_USAGE_URL || DEFAULT_USAGE_URL)
}

/**
 * The auth token for an account, from credentials.json when it is there, else
 * from the keychain freebuff used after moving it out of the file.
 */
function tokenFor (account, options = {}) {
  const credentialsFile = accounts.credentialsPath(account)
  const cached = tokens.get(credentialsFile)
  const now = options.now ?? Date.now()
  if (cached && now - cached.at < TOKEN_CACHE_MS) return cached.token

  let token = null
  let entry = null
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'))
    entry = raw && raw.default
    if (entry && typeof entry.authToken === 'string' && entry.authToken) {
      token = entry.authToken
    }
  } catch {
    return null
  }

  if (!token && entry && entry.tokenStore === 'keychain' && options.keychain !== false) {
    const python = String(process.env.FREEBUFFS_KEYCHAIN_PYTHON || 'python3')
    const result = spawnSync(python, ['-c', KEYCHAIN_SCRIPT, credentialsFile], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    if (result.status === 0) token = String(result.stdout || '').trim() || null
  }

  tokens.set(credentialsFile, { at: now, token })
  return token
}

/** One request per account, cached so a one-second dashboard is not chatty. */
async function get (account, options = {}) {
  if (!account) return { ok: false, reason: 'no account' }
  if (String(options.env?.FREEBUFFS_CREDITS ?? process.env.FREEBUFFS_CREDITS ?? '') === '0') {
    return { ok: false, reason: 'credits disabled' }
  }

  const now = options.now ?? Date.now()
  const cached = results.get(account.id)
  if (cached && now - cached.at < (cached.value.ok ? CACHE_MS : FAILURE_CACHE_MS)) {
    return cached.value
  }

  const token = tokenFor(account, { now })
  if (!token) {
    const value = { ok: false, reason: 'no readable token' }
    results.set(account.id, { at: now, value })
    return value
  }

  const fetchImpl = options.fetch || globalThis.fetch
  try {
    const response = await fetchImpl(usageUrl(options.env), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprintId: 'cli-usage', authToken: token }),
      signal: AbortSignal.timeout(options.timeoutMs || FETCH_TIMEOUT_MS)
    })
    if (!response.ok) {
      const value = { ok: false, reason: `usage API ${response.status}` }
      results.set(account.id, { at: now, value })
      return value
    }

    const data = await response.json()
    const remaining = Number(data && data.remainingBalance)
    if (!Number.isFinite(remaining)) {
      const value = { ok: false, reason: 'no balance in the response' }
      results.set(account.id, { at: now, value })
      return value
    }

    const value = {
      ok: true,
      remaining,
      used: Number(data.usage) || 0,
      resetsAt: typeof data.next_quota_reset === 'string' ? data.next_quota_reset : null
    }
    results.set(account.id, { at: now, value })
    return value
  } catch (error) {
    const value = { ok: false, reason: error.message || 'usage request failed' }
    results.set(account.id, { at: now, value })
    return value
  }
}

/** All of them at once; a slow account never delays its siblings. */
async function getAll (list, options = {}) {
  const entries = await Promise.all(
    (list || []).map(async (account) => [account.id, await get(account, options)])
  )
  return new Map(entries)
}

/** green when there is plenty, yellow when it is running down, red when empty. */
function level (credits, env = process.env) {
  if (!credits || !credits.ok) return 'unknown'
  const green = Number(env.FREEBUFFS_CREDITS_GREEN ?? 100)
  const yellow = Number(env.FREEBUFFS_CREDITS_YELLOW ?? 10)
  if (!Number.isFinite(credits.remaining)) return 'unknown'
  if (credits.remaining >= green) return 'green'
  if (credits.remaining >= yellow) return 'yellow'
  return 'red'
}

/** Plain words for logs and non-tty output. */
function describe (credits) {
  if (!credits || !credits.ok) {
    return credits && credits.reason ? `unavailable (${credits.reason})` : 'unavailable'
  }
  const count = `${credits.remaining} credit${credits.remaining === 1 ? '' : 's'}`
  return `${count} · ${LEVELS[level(credits)].label}`
}

/** ANSI colour for the level, or plain text when colours are off. */
function paint (text, credits, enabled) {
  const current = level(credits)
  if (!enabled) return text
  return `\u001b[${LEVELS[current].ansi}m${text}\u001b[0m`
}

/** Clear the caches; tests and `status` after a long pause use this. */
function reset () {
  results.clear()
  tokens.clear()
}

module.exports = {
  DEFAULT_USAGE_URL,
  LEVELS,
  CACHE_MS,
  usageUrl,
  tokenFor,
  get,
  getAll,
  level,
  describe,
  paint,
  reset
}
