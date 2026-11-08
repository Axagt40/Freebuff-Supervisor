'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const accounts = require('../src/accounts')
const { emptyState } = require('../src/state')
const { writeCredentials, makeJwt, removeTree } = require('./helpers')

const dirs = []
test.beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuffs-unit-'))
  dirs.push(root)
  process.env.FREEBUFFS_HOME = path.join(root, 'home')
  process.env.FREEBUFFS_DEFAULT_CONFIG_DIR = path.join(root, 'default-config')
})

test.after(() => {
  for (const dir of dirs) removeTree(dir)
})

test('the first account is the existing freebuff config dir', () => {
  const state = emptyState()
  const account = accounts.ensureDefaultAccount(state)
  assert.equal(account.id, 'account-1')
  assert.equal(account.configDir, process.env.FREEBUFFS_DEFAULT_CONFIG_DIR)
  assert.equal(account.shared, true)
  assert.equal(state.accounts.length, 1)
})

test('extra containers are isolated and signed-in detection follows credentials', () => {
  const state = emptyState()
  accounts.ensureDefaultAccount(state)
  const container = accounts.createContainer(state)

  assert.equal(container.id, 'account-2')
  assert.ok(container.configDir.startsWith(path.join(process.env.FREEBUFFS_HOME, 'accounts')))
  assert.notEqual(container.configDir, process.env.FREEBUFFS_DEFAULT_CONFIG_DIR)
  assert.equal(accounts.isSignedIn(container), false)

  writeCredentials(container.configDir)
  assert.equal(accounts.isSignedIn(container), true)
})

test('selection prefers the least recently used signed-in account', () => {
  const state = emptyState()
  const first = accounts.ensureDefaultAccount(state)
  const second = accounts.createContainer(state)
  writeCredentials(first.configDir)
  writeCredentials(second.configDir)

  assert.equal(accounts.chooseAccount(state).id, 'account-1')

  accounts.markAccountUsed(state, first.id, '/tmp/project')
  assert.equal(accounts.chooseAccount(state).id, 'account-2')

  accounts.markAccountUsed(state, second.id, '/tmp/project')
  assert.equal(accounts.chooseAccount(state).id, 'account-1')

  const third = accounts.createContainer(state)
  assert.equal(accounts.chooseAccount(state).id, 'account-1')
  assert.equal(accounts.isSignedIn(third), false)
})

test('--continue follows the account that last ran in the directory', () => {
  const state = emptyState()
  const first = accounts.ensureDefaultAccount(state)
  const second = accounts.createContainer(state)
  writeCredentials(first.configDir)
  writeCredentials(second.configDir)

  state.lastAccountByCwd['/tmp/some-project'] = second.id
  accounts.markAccountUsed(state, first.id, '/tmp/other-project')

  const chosen = accounts.chooseAccount(state, {
    cwd: '/tmp/some-project',
    preferCwd: true
  })
  assert.equal(chosen.id, 'account-2')
})

test('credential expiry is read from a JWT auth token', () => {
  const state = emptyState()
  const account = accounts.ensureDefaultAccount(state)
  const exp = Math.floor(Date.now() / 1000) + 3600
  writeCredentials(account.configDir, { authToken: makeJwt(exp) })

  const expiry = accounts.credentialExpiry(account)
  assert.equal(expiry.expiresAt, exp * 1000)
  assert.equal(expiry.source, 'credentials')
  assert.equal(accounts.isExpiring(account).expiring, false)
})

test('rotation skips accounts inside the expiry grace window', () => {
  const state = emptyState()
  const first = accounts.ensureDefaultAccount(state)
  const second = accounts.createContainer(state)
  const now = Math.floor(Date.now() / 1000)
  writeCredentials(first.configDir, { authToken: makeJwt(now + 60) })
  writeCredentials(second.configDir, { authToken: makeJwt(now + 86400) })

  assert.equal(accounts.chooseAccount(state).id, 'account-2')
  accounts.markAccountUsed(state, second.id, '/tmp/project')
  assert.equal(accounts.chooseAccount(state).id, 'account-2')

  // With the grace disabled only expired tokens are skipped.
  assert.equal(accounts.chooseAccount(state, { graceMs: 0 }).id, 'account-1')
})

test('when every token is expiring, the latest expiry wins', () => {
  const state = emptyState()
  const first = accounts.ensureDefaultAccount(state)
  const second = accounts.createContainer(state)
  const now = Math.floor(Date.now() / 1000)
  writeCredentials(first.configDir, { authToken: makeJwt(now + 60) })
  writeCredentials(second.configDir, { authToken: makeJwt(now + 600) })

  assert.equal(accounts.chooseAccount(state).id, 'account-2')
})

test('forced accounts must exist and be signed in', () => {
  const state = emptyState()
  const first = accounts.ensureDefaultAccount(state)
  const unsigned = accounts.createContainer(state)

  assert.throws(
    () => accounts.chooseAccount(state, { requested: 'account-9' }),
    /no such account/
  )
  assert.throws(
    () => accounts.chooseAccount(state, { requested: unsigned.id }),
    /not signed in/
  )
  assert.throws(
    () => accounts.chooseAccount(state, { requested: '1' }),
    /not signed in/
  )

  writeCredentials(first.configDir)
  assert.equal(accounts.chooseAccount(state, { requested: 'account-1' }).id, 'account-1')
})

test('finalizeSession records duration once and keeps the real exit status', () => {
  const state = emptyState()
  const account = accounts.ensureDefaultAccount(state)
  const session = {
    id: 'session-1',
    accountId: account.id,
    startedAt: new Date(Date.now() - 2000).toISOString(),
    endedAt: null,
    exitCode: null,
    exitSignal: null
  }
  accounts.recordSession(state, session)

  const reconciled = accounts.finalizeSession(state, 'session-1', { note: 'monitor' })
  assert.ok(reconciled.endedAt)
  assert.equal(reconciled.note, 'monitor')
  const totalAfterMonitor = account.totalMs
  assert.ok(totalAfterMonitor >= 1900)

  const finished = accounts.finalizeSession(state, 'session-1', {
    exitCode: 0,
    note: 'launcher'
  })
  assert.equal(finished.exitCode, 0)
  assert.equal(finished.note, 'monitor')
  assert.equal(account.totalMs, totalAfterMonitor)

  accounts.finalizeSession(state, 'session-1', { exitCode: 7 })
  assert.equal(finished.exitCode, 0, 'a later caller must not rewrite the exit code')
})

test('rotation skips an account that used up its free sessions', () => {
  const state = emptyState()
  const first = accounts.ensureDefaultAccount(state)
  const second = accounts.createContainer(state)
  writeCredentials(first.configDir)
  writeCredentials(second.configDir)
  accounts.markAccountUsed(state, second.id, '/tmp/project')

  // account-1 is the least recently used, so it would normally win.
  assert.equal(accounts.chooseAccount(state).id, 'account-1')

  accounts.markCooldown(state, first.id, new Date(Date.now() + 3600_000).toISOString())
  assert.equal(accounts.coolingDown(first), true)
  assert.equal(accounts.chooseAccount(state).id, 'account-2', 'a cooled account is skipped')

  // Once every account is waiting, the one whose reset comes first is picked.
  accounts.markCooldown(state, first.id, new Date(Date.now() + 7200_000).toISOString())
  accounts.markCooldown(state, second.id, new Date(Date.now() + 1800_000).toISOString())
  const now = Date.now()
  assert.equal(
    accounts.chooseAccount(state, { now }).id,
    'account-2',
    'the soonest reset wins when nothing is ready'
  )

  accounts.clearCooldown(state, first.id)
  assert.equal(accounts.coolingDown(first), false)
  assert.equal(accounts.chooseAccount(state).id, 'account-1')
})

test('an account is removed with its container, but never the shared one', () => {
  const state = emptyState()
  const first = accounts.ensureDefaultAccount(state)
  const second = accounts.createContainer(state)
  writeCredentials(second.configDir)
  accounts.markAccountUsed(state, second.id, '/tmp/project')

  // account-1 is the machine's own freebuff config dir.
  const refused = accounts.removeAccount(state, first.id)
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /own freebuff config/)
  assert.equal(state.accounts.length, 2)

  const container = path.join(process.env.FREEBUFFS_HOME, 'accounts', 'account-2')
  assert.equal(fs.existsSync(container), true)

  const removed = accounts.removeAccount(state, second.id)
  assert.equal(removed.ok, true)
  assert.equal(removed.removed, true)
  assert.deepEqual(state.accounts.map((account) => account.id), ['account-1'])
  assert.equal(fs.existsSync(container), false, 'the container is deleted with it')
  assert.equal(state.lastAccountId, 'account-1')
  assert.equal(state.lastAccountByCwd['/tmp/project'], undefined)
})

test('the same freebuff account is only listed once', () => {
  const state = emptyState()
  const first = accounts.ensureDefaultAccount(state)
  const second = accounts.createContainer(state)
  // Both config dirs hold credentials for the same freebuff identity, which is
  // what signing the same account in twice leaves behind.
  writeCredentials(first.configDir)
  writeCredentials(second.configDir)

  assert.equal(accounts.duplicateOf(state, second).id, first.id)
  assert.deepEqual(accounts.dedupeAccounts(state), [second.id])
  assert.deepEqual(state.accounts.map((account) => account.id), ['account-1'])
  assert.equal(accounts.dedupeAccounts(state).length, 0, 'nothing is left to drop')
})

test('a duplicate is kept while a session is still running on it', () => {
  const state = emptyState()
  const first = accounts.ensureDefaultAccount(state)
  const second = accounts.createContainer(state)
  writeCredentials(first.configDir)
  writeCredentials(second.configDir)
  accounts.recordSession(state, {
    id: 'session-live',
    accountId: second.id,
    cwd: '/tmp/project',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null
  })

  assert.deepEqual(accounts.dedupeAccounts(state), [])
  assert.equal(state.accounts.length, 2, 'a live session is never orphaned')
})

test('an account with a live session is not removed', () => {
  const state = emptyState()
  accounts.ensureDefaultAccount(state)
  const container = accounts.createContainer(state)
  accounts.recordSession(state, {
    id: 'session-live',
    accountId: container.id,
    cwd: '/tmp/project',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null
  })

  const result = accounts.removeAccount(state, container.id)
  assert.equal(result.ok, false)
  assert.match(result.reason, /live session/)
  assert.equal(state.accounts.length, 2)
})
