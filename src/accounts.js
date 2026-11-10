'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { paths, defaultConfigDir } = require('./paths')
const { nowIso, readJson, isPidAlive } = require('./util')

const SUPPORT_FILES = ['rg', 'tree-sitter.wasm']
const MAX_SESSIONS = 100
const DEFAULT_EXPIRY_GRACE_MINUTES = 15

function accountConfigDir (account) {
  return account.configDir || path.join(paths().accountsDir, account.id, 'config')
}

/**
 * True when freebuff would open its project picker instead of a chat.
 *
 * freebuff's own check is `path.relative(startCwd, homeDir)` being empty or a
 * path inside home: the picker appears when the session starts in the home
 * folder or in an ancestor of it. Those folders are not a project, so an
 * unattended restart that starts there can never leave the folder list.
 */
function isProjectPickerFolder (dir, home = os.homedir()) {
  if (!dir) return false
  const relative = path.relative(path.resolve(dir), path.resolve(home))
  return relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Folders this machine has used before, most recently used first.
 *
 * The supervisor's own session records and freebuff's `recent-projects.json`
 * are both consulted: the latter is what the project picker itself writes when
 * a folder is chosen, so a person's last pick survives a process restart.
 * Missing folders are dropped instead of being resumed.
 */
function recentProjectFolders (state, home = os.homedir()) {
  const found = new Map()
  const add = (folder, at) => {
    if (typeof folder !== 'string' || !folder) return
    const resolved = path.resolve(folder)
    if (isProjectPickerFolder(resolved, home)) return
    try {
      if (!fs.statSync(resolved).isDirectory()) return
    } catch {
      return
    }
    const stamp = Number.isFinite(at) ? at : 0
    if (!found.has(resolved) || found.get(resolved) < stamp) {
      found.set(resolved, stamp)
    }
  }

  for (const session of (state && state.sessions) || []) {
    add(session.cwd, Date.parse(session.startedAt) || 0)
  }
  for (const account of (state && state.accounts) || []) {
    const raw = readJson(path.join(accountConfigDir(account), 'recent-projects.json'))
    if (!Array.isArray(raw)) continue
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue
      add(entry.path, Number(entry.lastOpened) || 0)
    }
  }
  for (const folder of Object.keys((state && state.lastAccountByCwd) || {})) {
    add(folder, 0)
  }

  return [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([folder]) => folder)
}

/**
 * The folder a session should actually run in.
 *
 * A launch from home (a reboot service, an autostart entry, a kept-open shell)
 * would otherwise land on freebuff's project picker on every restart. When that
 * is about to happen the most recently used real project is used instead, so a
 * restart continues in the folder the previous session worked in.
 */
function resolveProjectFolder (cwd, state, home = os.homedir()) {
  if (!isProjectPickerFolder(cwd, home)) return cwd
  const known = recentProjectFolders(state, home)
  return known[0] || cwd
}

function credentialsPath (account) {
  return path.join(accountConfigDir(account), 'credentials.json')
}

/** An account is usable when freebuff login wrote a credential set for it. */
function isSignedIn (account) {
  const credentials = readJson(credentialsPath(account))
  if (!credentials || typeof credentials !== 'object') return false
  const entry = credentials.default
  if (!entry || typeof entry !== 'object') return false
  return Boolean(entry.tokenStore || entry.id)
}

/**
 * How long before expiry an account stops being picked. Configurable through
 * FREEBUFFS_EXPIRY_GRACE_MINUTES; 0 only skips already-expired accounts.
 */
function expiryGraceMs () {
  const raw = Number(process.env.FREEBUFFS_EXPIRY_GRACE_MINUTES)
  const minutes = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_EXPIRY_GRACE_MINUTES
  return minutes * 60 * 1000
}

function decodeJwtExpiry (token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const seconds = Number(payload.exp)
    return Number.isFinite(seconds) ? seconds * 1000 : null
  } catch {
    return null
  }
}

function parseExpiry (value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    if (value > 1e12) return value
    if (value > 1e9) return value * 1000
    return null
  }
  if (typeof value === 'string') {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return parseExpiry(numeric)
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * freebuff keeps the real auth token in the OS keychain when it can and only
 * writes `tokenStore: "keychain"` to credentials.json. Where plaintext is used
 * (keychain unavailable) the token is right there. JWT `exp` is the only
 * client-visible expiry, so a non-JWT token means "unknown", never "expired".
 */
function keychainToken (account) {
  if (process.platform !== 'linux') return null
  try {
    const token = execFileSync(
      'secret-tool',
      ['lookup', 'service', 'freebuff-cli', 'username', credentialsPath(account)],
      { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    return token.trim() || null
  } catch {
    return null
  }
}

/** Returns { expiresAt: number|null, source: 'credentials'|'keychain'|null }. */
function credentialExpiry (account) {
  const credentials = readJson(credentialsPath(account))
  const entry = credentials && credentials.default
  if (!entry || typeof entry !== 'object') return { expiresAt: null, source: null }

  const direct = parseExpiry(
    entry.expiresAt ?? entry.expires_at ?? entry.expiry ?? entry.exp
  )
  if (direct) return { expiresAt: direct, source: 'credentials' }

  let token = entry.authToken
  let source = 'credentials'
  if (!token && entry.tokenStore === 'keychain') {
    token = keychainToken(account)
    source = 'keychain'
  }

  const expiresAt = decodeJwtExpiry(token)
  return { expiresAt, source: expiresAt ? source : null }
}

/** True when credentials are inside the grace window (or already expired). */
function isExpiring (account, options = {}) {
  const now = options.now ?? Date.now()
  const grace = options.graceMs ?? expiryGraceMs()
  const { expiresAt } = credentialExpiry(account)
  return {
    expiresAt,
    expiring: Boolean(expiresAt && expiresAt - now <= grace),
    expired: Boolean(expiresAt && expiresAt <= now)
  }
}

/**
 * An account whose free sessions are used up cannot run anything until its
 * quota resets. Remembering that in the state file is what lets a second
 * account take over immediately instead of relaunching the same dead one.
 */
function markCooldown (state, accountId, until, reason = 'free sessions used up') {
  const account = state.accounts.find((item) => item.id === accountId)
  if (!account) return null
  account.cooldownUntil = until instanceof Date ? until.toISOString() : String(until)
  account.cooldownReason = reason
  return account
}

function clearCooldown (state, accountId) {
  const account = state.accounts.find((item) => item.id === accountId)
  if (!account) return
  account.cooldownUntil = null
  account.cooldownReason = null
}

/** When the account may run again, or null when it is not waiting. */
function cooldownUntil (account) {
  if (!account || !account.cooldownUntil) return null
  const at = Date.parse(account.cooldownUntil)
  return Number.isFinite(at) ? at : null
}

function coolingDown (account, options = {}) {
  const until = cooldownUntil(account)
  return Boolean(until && until > (options.now ?? Date.now()))
}

/**
 * An auth failure stays active until the credentials change (login writes a
 * new file, so its mtime moves past the failure timestamp) or login clears it.
 */
function authFailureActive (account) {
  if (!account || !account.authFailedAt) return false
  const at = Date.parse(account.authFailedAt)
  if (!Number.isFinite(at)) return false
  try {
    if (fs.statSync(credentialsPath(account)).mtimeMs > at) return false
  } catch {
    return false
  }
  return true
}

function markAuthFailure (state, accountId, detail) {
  const account = state.accounts.find((item) => item.id === accountId)
  if (!account) return null
  account.authFailedAt = nowIso()
  account.lastError = detail ? `auth failure: ${detail}` : 'auth failure'
  return account
}

function clearAuthFailure (state, accountId) {
  const account = state.accounts.find((item) => item.id === accountId)
  if (!account) return
  account.authFailedAt = null
  account.lastError = null
}

/** Internal only: the supervisor never prints identities. */
function identity (account) {
  const credentials = readJson(credentialsPath(account))
  const entry = credentials && credentials.default
  if (!entry) return null
  return {
    id: entry.id || null,
    name: entry.name || null,
    email: entry.email || null
  }
}

/** Symlink the large support files so containers stay tiny. */
function linkSupportFiles (account) {
  const destination = accountConfigDir(account)
  const source = defaultConfigDir()
  fs.mkdirSync(destination, { recursive: true })
  if (path.resolve(destination) === path.resolve(source)) return

  for (const name of SUPPORT_FILES) {
    const from = path.join(source, name)
    const to = path.join(destination, name)
    if (!fs.existsSync(from) || fs.existsSync(to)) continue
    try {
      fs.symlinkSync(from, to)
    } catch {
      try {
        fs.copyFileSync(from, to)
      } catch {
        // Missing support files only cost performance, not correctness.
      }
    }
  }
}

function nextAccountId (state) {
  const used = new Set(state.accounts.map((account) => account.id))
  let index = 1
  while (used.has(`account-${index}`)) index += 1
  return `account-${index}`
}

/** The number in an `account-N` id, or null for an id without one. */
function accountNumber (account) {
  const match = /-(\d+)$/.exec(String((account && account.id) || ''))
  return match ? Number(match[1]) : null
}

/**
 * Accounts are shown by number, so the list has to read 1, 2, 3, 4. A removed
 * container frees its number for the next sign-in, which was pushed at the end
 * and left the list as 1, 2, 4, 3. Ids without a number sort after the rest.
 */
function sortAccounts (list) {
  return (list || []).sort((a, b) => {
    const aNumber = accountNumber(a)
    const bNumber = accountNumber(b)
    if (aNumber !== null && bNumber !== null && aNumber !== bNumber) {
      return aNumber - bNumber
    }
    if (aNumber === null && bNumber !== null) return 1
    if (aNumber !== null && bNumber === null) return -1
    return String(a.id).localeCompare(String(b.id))
  })
}

/**
 * Account 1 is the machine's existing freebuff config dir, so a signed-in
 * machine works on first run without duplicating credentials.
 */
function createDefaultAccount (state) {
  const configDir = defaultConfigDir()
  fs.mkdirSync(configDir, { recursive: true })
  const account = {
    id: 'account-1',
    label: 'account-1',
    configDir,
    shared: true,
    createdAt: nowIso(),
    signedInAt: null,
    lastUsedAt: null,
    sessions: 0,
    totalMs: 0,
    lastError: null
  }
  state.accounts.push(account)
  state.lastAccountId = account.id
  return account
}

function ensureDefaultAccount (state) {
  if (state.accounts.length > 0) {
    const existing = state.accounts[0]
    // A machine that was already signed in through freebuff itself has no
    // supervisor record yet; reflect the credentials it found.
    if (!existing.signedInAt && isSignedIn(existing)) {
      existing.signedInAt = nowIso()
    }
    return existing
  }
  return createDefaultAccount(state)
}

function createContainer (state) {
  const id = nextAccountId(state)
  const account = {
    id,
    label: id,
    configDir: path.join(paths().accountsDir, id, 'config'),
    shared: false,
    createdAt: nowIso(),
    signedInAt: null,
    lastUsedAt: null,
    sessions: 0,
    totalMs: 0,
    lastError: null
  }
  fs.mkdirSync(account.configDir, { recursive: true })
  linkSupportFiles(account)
  state.accounts.push(account)
  sortAccounts(state.accounts)
  return account
}

/**
 * The identity key of a record, or null when it has not been signed in yet.
 * freebuff's own id is the strongest key; the email is used when only that is
 * written.
 */
function identityKey (account) {
  const who = identity(account)
  if (!who) return null
  if (who.id) return `id:${who.id}`
  if (who.email) return `email:${who.email}`
  return null
}

/** The other record signed in as the same freebuff account, or null. */
function duplicateOf (state, account) {
  const key = identityKey(account)
  if (!key) return null
  return (state.accounts || []).find(
    (other) => other.id !== account.id && identityKey(other) === key
  ) || null
}

/**
 * One freebuff account, one record. `login --new` on an identity that was
 * already signed in used to leave a second container behind, and the dashboard
 * then listed the same account twice and rotated between them. The first
 * record wins (account 1 is the machine's own config dir); a duplicate is only
 * dropped when nothing is running on it, so a live session is never orphaned.
 */
function dedupeAccounts (state) {
  const seen = new Map()
  const removed = []
  for (const account of (state.accounts || []).slice()) {
    const key = identityKey(account)
    if (!key) continue
    const first = seen.get(key)
    if (!first) {
      seen.set(key, account)
      continue
    }

    const busy = (state.sessions || []).some(
      (session) =>
        session.accountId === account.id &&
        !session.endedAt &&
        isPidAlive(session.pid)
    )
    if (busy) continue

    state.accounts.splice(state.accounts.indexOf(account), 1)
    removed.push(account.id)
    if (state.lastAccountId === account.id) state.lastAccountId = first.id
    for (const [cwd, id] of Object.entries(state.lastAccountByCwd || {})) {
      if (id === account.id) state.lastAccountByCwd[cwd] = first.id
    }
  }
  return removed
}

function findAccount (state, wanted) {
  if (!wanted) return null
  const text = String(wanted).trim()
  if (!text) return null
  const direct = state.accounts.find(
    (account) => account.id === text || account.label === text
  )
  if (direct) return direct
  if (/^\d+$/.test(text)) {
    return state.accounts[Number(text) - 1] || null
  }
  return null
}

/**
 * Pick the signed-in account used least recently, which spreads daily session
 * limits across accounts. `preferCwd` keeps `--continue` coherent, since
 * conversation history lives inside each account's config dir.
 */
function chooseAccount (state, options = {}) {
  const requested = options.requested
  if (requested) {
    const account = findAccount(state, requested)
    if (!account) {
      throw new Error(
        `no such account: ${requested} (try \`sfreebuff login --new\`)`
      )
    }
    if (!isSignedIn(account)) {
      throw new Error(
        `account ${account.id} is not signed in (run \`sfreebuff login\`)`
      )
    }
    return account
  }

  const signedIn = state.accounts.filter(isSignedIn)
  if (signedIn.length === 0) return null

  // A refused account is not retried until it is signed in again; otherwise
  // every launch would pick the broken one and fail the same way.
  const usable = signedIn.filter((account) => !authFailureActive(account))
  if (usable.length === 0) {
    throw new Error(
      'every signed-in account reported an auth failure (' +
      signedIn.map((account) => account.id).join(', ') +
      '). Run `sfreebuff login --account <id>` to re-sign one.'
    )
  }

  const now = options.now ?? Date.now()
  const grace = options.graceMs ?? expiryGraceMs()
  const freshness = usable.map((account) => ({
    account,
    expiresAt: credentialExpiry(account).expiresAt
  }))
  const fresh = freshness.filter(
    (item) => !item.expiresAt || item.expiresAt - now > grace
  )

  // Every known token is inside the grace window: the one with the most time
  // left is still better than refusing to launch, and the user is warned.
  if (fresh.length === 0 && freshness.some((item) => item.expiresAt)) {
    return freshness.slice().sort(
      (a, b) => (b.expiresAt || 0) - (a.expiresAt || 0)
    )[0].account
  }

  // An account that already used its free sessions for the day is last, and
  // the one whose reset comes soonest comes first. This is a preference rather
  // than a hard skip: a manual launch on a machine with one account should
  // still start the TUI instead of refusing, and the 24/7 loop decides whether
  // to rotate or wait.
  const ready = fresh.filter((item) => !coolingDown(item.account, { now }))
  const pool = ready.length > 0
    ? ready.map((item) => item.account)
    : fresh.map((item) => item.account)

  if (options.preferCwd && options.cwd) {
    const lastId = state.lastAccountByCwd[options.cwd]
    const last = pool.find((account) => account.id === lastId)
    if (last) return last
  }

  return pool.sort((a, b) => {
    const aCool = coolingDown(a, { now }) ? cooldownUntil(a) : 0
    const bCool = coolingDown(b, { now }) ? cooldownUntil(b) : 0
    if (aCool !== bCool) return aCool - bCool
    const aUsed = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0
    const bUsed = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0
    if (aUsed !== bUsed) return aUsed - bUsed
    return String(a.id).localeCompare(String(b.id))
  })[0]
}

function markAccountUsed (state, accountId, cwd) {
  const account = state.accounts.find((item) => item.id === accountId)
  if (!account) return
  account.lastUsedAt = nowIso()
  account.sessions = (account.sessions || 0) + 1
  account.lastError = null
  state.lastAccountId = account.id
  if (cwd) state.lastAccountByCwd[cwd] = account.id
}

function recordSession (state, session) {
  state.sessions.unshift(session)
  if (state.sessions.length > MAX_SESSIONS) {
    state.sessions.length = MAX_SESSIONS
  }
}

/**
 * Idempotent: the launcher records the real exit status, while the monitor
 * reconciles sessions whose launcher disappeared. Whichever runs first sets
 * `endedAt`; the other only fills in details.
 */
function finalizeSession (state, sessionId, result = {}) {
  const session = state.sessions.find((item) => item.id === sessionId)
  if (!session) return null
  const account = state.accounts.find((item) => item.id === session.accountId)
  const alreadyEnded = Boolean(session.endedAt)

  if (!alreadyEnded) {
    session.endedAt = nowIso()
    if (account) {
      const elapsed = Math.max(0, Date.now() - Date.parse(session.startedAt))
      account.totalMs = (account.totalMs || 0) + elapsed
    }
  }
  // The first observed exit status wins: the monitor may finalize before the
  // launcher reports the real code, and a later caller must not rewrite it.
  if (
    result.exitCode !== undefined &&
    result.exitCode !== null &&
    (session.exitCode === null || session.exitCode === undefined)
  ) {
    session.exitCode = result.exitCode
  }
  if (result.signal && !session.exitSignal) session.exitSignal = result.signal
  // A note explains why this process ended the session, so only the writer
  // that actually set `endedAt` owns it.
  if (result.note && !alreadyEnded && !session.note) session.note = result.note
  return session
}

/**
 * Delete an account: its record, its sign-in and its chat history.
 *
 * Account 1 is the machine's existing freebuff config dir (~/.config/manicode),
 * not a container this supervisor made, so it is refused here — emptying it
 * would take freebuff itself off the machine. Only a container under
 * ~/.freebuffs/accounts is deleted from disk, and only when nothing is running
 * on the account.
 */
function removeAccount (state, accountId, options = {}) {
  const wanted = String(accountId || '').trim()
  const index = state.accounts.findIndex(
    (item) => item.id === wanted || item.label === wanted
  )
  if (index < 0) return { ok: false, reason: `no such account: ${wanted}` }

  const account = state.accounts[index]
  if (account.shared) {
    return {
      ok: false,
      reason: `${account.id} is this machine's own freebuff config — sign out in freebuff instead`
    }
  }

  const busy = (state.sessions || []).some((session) =>
    session.accountId === account.id &&
    !session.endedAt &&
    isPidAlive(session.pid)
  )
  if (busy) {
    return { ok: false, reason: `${account.id} has a live session — stop it first` }
  }

  state.accounts.splice(index, 1)
  sortAccounts(state.accounts)
  if (state.lastAccountId === account.id) {
    state.lastAccountId = state.accounts[0] ? state.accounts[0].id : null
  }
  for (const [cwd, id] of Object.entries(state.lastAccountByCwd || {})) {
    if (id === account.id) delete state.lastAccountByCwd[cwd]
  }

  let removed = false
  if (options.deleteFiles !== false) {
    const base = path.resolve(paths().accountsDir)
    const container = path.resolve(paths().accountsDir, account.id)
    if (container.startsWith(`${base}${path.sep}`)) {
      try {
        fs.rmSync(container, { recursive: true, force: true })
        removed = true
      } catch {
        // The record is gone either way; a leftover folder only wastes space.
      }
    }
  }

  return { ok: true, account, removed }
}

module.exports = {
  SUPPORT_FILES,
  accountConfigDir,
  isProjectPickerFolder,
  recentProjectFolders,
  resolveProjectFolder,
  credentialsPath,
  isSignedIn,
  credentialExpiry,
  expiryGraceMs,
  isExpiring,
  markCooldown,
  clearCooldown,
  cooldownUntil,
  coolingDown,
  authFailureActive,
  markAuthFailure,
  clearAuthFailure,
  identity,
  linkSupportFiles,
  nextAccountId,
  sortAccounts,
  createDefaultAccount,
  ensureDefaultAccount,
  createContainer,
  identityKey,
  duplicateOf,
  dedupeAccounts,
  removeAccount,
  findAccount,
  chooseAccount,
  markAccountUsed,
  recordSession,
  finalizeSession
}
