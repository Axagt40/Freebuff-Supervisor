'use strict'

const { ensureDirs } = require('./paths')
const { loadState, mutateState } = require('./state')
const accounts = require('./accounts')
const { logLine, logEvent } = require('./log')
const { resolveBinary, spawnFreebuff, waitForExit, resetTerminal } = require('./freebuff')
const { nowIso } = require('./util')

function parseLoginFlags (argv) {
  let fresh = false
  let label = null
  let account = null
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--new' || arg === '-n') {
      fresh = true
      continue
    }
    if (arg === '--label') {
      label = argv[index + 1] || null
      index += 1
      continue
    }
    if (arg.startsWith('--label=')) {
      label = arg.slice('--label='.length)
      continue
    }
    if (arg === '--account') {
      account = argv[index + 1] || null
      index += 1
      continue
    }
    if (arg.startsWith('--account=')) {
      account = arg.slice('--account='.length)
    }
  }
  return { fresh, label, account }
}

/**
 * Sign one account in.
 *
 *   sfreebuff login                   reuse an unsigned container, else add one
 *   sfreebuff login --new             always add a container
 *   sfreebuff login --account <id>    re-sign that container in place
 *
 * Re-signing matters when a token expires: the container and its history stay
 * put, only its credentials are replaced by freebuff's normal login flow.
 */
async function login (argv = {}) {
  const options = Array.isArray(argv) ? parseLoginFlags(argv) : argv || {}
  ensureDirs()
  mutateState((state) => accounts.ensureDefaultAccount(state))

  if (options.account && options.fresh) {
    throw new Error('use either --account <id> or --new, not both')
  }

  const state = loadState()
  let target = null

  if (options.account) {
    const found = accounts.findAccount(state, options.account)
    if (!found) {
      throw new Error(
        `no such account: ${options.account} (run \`sfreebuff login --new\`)`
      )
    }
    target = { ...found }
    accounts.linkSupportFiles(target)
  } else if (!options.fresh) {
    const unsigned = state.accounts.find((account) => !accounts.isSignedIn(account))
    if (unsigned) {
      target = { ...unsigned }
      accounts.linkSupportFiles(target)
    }
  }

  if (!target) {
    target = mutateState((current) => {
      const created = accounts.createContainer(current)
      return { ...created }
    })
  }

  if (options.label) {
    mutateState((current) => {
      const record = current.accounts.find((account) => account.id === target.id)
      if (record) record.label = options.label
    })
    target.label = options.label
  }

  const binary = resolveBinary()
  // This is freebuff's own interactive sign-in (browser/device flow), running
  // inside the account's config dir. The supervisor never asks for credentials.
  console.log(`Signing in ${target.label} — freebuff will open its normal sign-in flow.`)
  logLine('info', 'account.login.start', { account: target.id, configDir: target.configDir })
  logEvent('account.login.start', { account: target.id })

  let result
  try {
    const child = spawnFreebuff({ binary, account: target, args: ['login'], cwd: process.cwd() })
    result = await waitForExit(child)
  } finally {
    resetTerminal()
  }

  const signedIn = accounts.isSignedIn(target)
  mutateState((current) => {
    const record = current.accounts.find((account) => account.id === target.id)
    if (!record) return
    if (signedIn) {
      record.signedInAt = nowIso()
      record.authFailedAt = null
      record.lastError = null
    } else {
      record.lastError = 'login finished without writing credentials'
    }
  })

  // Signing a second container in for an identity that is already listed would
  // show the same freebuff account twice, in the dashboard and in the
  // rotation, so the duplicate record is dropped again instead of kept. The
  // container's files are left alone; only the duplicate listing goes.
  const before = loadState()
  const signed = signedIn
    ? before.accounts.find((item) => item.id === target.id)
    : null
  const duplicate = signed ? accounts.duplicateOf(before, signed) : null
  const dropped = signedIn
    ? mutateState((current) => accounts.dedupeAccounts(current))
    : []

  if (dropped.includes(target.id)) {
    logLine('warn', 'account.login.duplicate', {
      account: target.id,
      duplicateOf: duplicate ? duplicate.id : null
    })
    logEvent('account.login.duplicate', {
      account: target.id,
      duplicateOf: duplicate ? duplicate.id : null
    })
    throw new Error(
      `${target.label} is the same freebuff account as ${
        duplicate ? duplicate.id : 'an account already listed'
      } — the duplicate sign-in was removed instead of being added twice.`
    )
  }
  if (dropped.length > 0) {
    console.log(`Dropped duplicate account(s): ${dropped.join(', ')}.`)
  }

  if (!signedIn) {
    logLine('warn', 'account.login.failed', {
      account: target.id,
      code: result.code,
      signal: result.signal
    })
    logEvent('account.login.failed', {
      account: target.id,
      code: result.code,
      signal: result.signal
    })
    const retry = options.account
      ? `sfreebuff login --account ${target.id}`
      : 'sfreebuff login --new'
    throw new Error(
      `${target.label} is still not signed in ` +
      `(freebuff login did not finish). Run \`${retry}\` to retry.`
    )
  }

  logLine('info', 'account.login', { account: target.id })
  logEvent('account.login', { account: target.id })
  console.log(`Signed in (${target.label}).`)
  return target
}

module.exports = { login, parseLoginFlags }
