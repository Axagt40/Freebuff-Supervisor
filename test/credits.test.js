'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const credits = require('../src/credits')

function tempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'freebuffs-credits-'))
}

function makeAccount (dir, entry) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'credentials.json'),
    JSON.stringify({ default: entry })
  )
  return { id: 'account-1', configDir: dir }
}

function fakeFetch (value) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      json: async () => value
    }
  }
  impl.calls = calls
  return impl
}

test.beforeEach(() => {
  credits.reset()
  delete process.env.FREEBUFFS_CREDITS
})

test('level turns green, yellow and red as the balance runs down', () => {
  assert.equal(credits.level({ ok: true, remaining: 500 }), 'green')
  assert.equal(credits.level({ ok: true, remaining: 100 }), 'green')
  assert.equal(credits.level({ ok: true, remaining: 99 }), 'yellow')
  assert.equal(credits.level({ ok: true, remaining: 10 }), 'yellow')
  assert.equal(credits.level({ ok: true, remaining: 9 }), 'red')
  assert.equal(credits.level({ ok: true, remaining: 0 }), 'red')
  assert.equal(credits.level({ ok: false, reason: 'x' }), 'unknown')
  assert.equal(credits.level(null), 'unknown')
  assert.equal(
    credits.level({ ok: true, remaining: 50 }, { FREEBUFFS_CREDITS_GREEN: '40', FREEBUFFS_CREDITS_YELLOW: '20' }),
    'green',
    'thresholds are configurable'
  )
})

test('paint colours the balance from green to red, and is plain when off', () => {
  assert.equal(credits.paint('400', { ok: true, remaining: 400 }, true), '\u001b[32m400\u001b[0m')
  assert.equal(credits.paint('50', { ok: true, remaining: 50 }, true), '\u001b[33m50\u001b[0m')
  assert.equal(credits.paint('2', { ok: true, remaining: 2 }, true), '\u001b[31m2\u001b[0m')
  assert.equal(credits.paint('—', { ok: false }, true), '\u001b[2m—\u001b[0m')
  assert.equal(credits.paint('400', { ok: true, remaining: 400 }, false), '400')
})

test('describe is plain words for logs and non-tty output', () => {
  assert.equal(credits.describe({ ok: true, remaining: 1 }), '1 credit · empty')
  assert.equal(credits.describe({ ok: true, remaining: 12 }), '12 credits · running low')
  assert.equal(credits.describe({ ok: true, remaining: 5 }), '5 credits · empty')
  assert.equal(credits.describe({ ok: false, reason: 'no readable token' }), 'unavailable (no readable token)')
  assert.equal(credits.describe(null), 'unavailable')
})

test('get asks the usage endpoint with the account token', async () => {
  const dir = tempDir()
  const account = makeAccount(dir, { authToken: 'tok-123' })
  const fetch = fakeFetch({
    remainingBalance: 77,
    usage: 23,
    next_quota_reset: '2026-11-01T00:00:00.000Z'
  })

  const value = await credits.get(account, { fetch, now: Date.now() })
  assert.deepEqual(value, {
    ok: true,
    remaining: 77,
    used: 23,
    resetsAt: '2026-11-01T00:00:00.000Z'
  })

  assert.equal(fetch.calls.length, 1)
  assert.equal(fetch.calls[0].url, credits.DEFAULT_USAGE_URL)
  assert.equal(fetch.calls[0].init.method, 'POST')
  const body = JSON.parse(fetch.calls[0].init.body)
  assert.equal(body.authToken, 'tok-123')
  assert.equal(body.fingerprintId, 'cli-usage')

  // A second read inside the cache window does not hit the network again.
  await credits.get(account, { fetch })
  assert.equal(fetch.calls.length, 1)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('an unreadable token reports unavailable without a request', async () => {
  const dir = tempDir()
  const account = makeAccount(dir, { tokenStore: 'keychain' })
  const fetch = fakeFetch({ remainingBalance: 5 })

  const value = await credits.get(account, { fetch })
  assert.equal(value.ok, false)
  assert.match(value.reason, /no readable token/)
  assert.equal(fetch.calls.length, 0)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('API failures and odd responses are reported, not guessed', async () => {
  const dir = tempDir()
  const account = makeAccount(dir, { authToken: 'tok' })

  const denied = await credits.get(account, {
    now: Date.now(),
    fetch: async () => ({ ok: false, status: 500 })
  })
  assert.equal(denied.ok, false)
  assert.match(denied.reason, /usage API 500/)

  credits.reset()
  const noBalance = await credits.get(account, {
    now: Date.now(),
    fetch: async () => ({ ok: true, json: async () => ({ usage: 3 }) })
  })
  assert.equal(noBalance.ok, false)
  assert.match(noBalance.reason, /no balance/)

  credits.reset()
  const broken = await credits.get(account, {
    now: Date.now(),
    fetch: async () => { throw new Error('network down') }
  })
  assert.equal(broken.ok, false)
  assert.match(broken.reason, /network down/)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('FREEBUFFS_CREDITS=0 turns the lookup off entirely', async () => {
  const dir = tempDir()
  const account = makeAccount(dir, { authToken: 'tok' })
  let called = false
  const value = await credits.get(account, {
    env: { FREEBUFFS_CREDITS: '0' },
    fetch: async () => { called = true; return { ok: true, json: async () => ({}) } }
  })
  assert.equal(value.ok, false)
  assert.equal(value.reason, 'credits disabled')
  assert.equal(called, false)

  process.env.FREEBUFFS_CREDITS = '0'
  credits.reset()
  const fromEnv = await credits.get(account, { fetch: async () => { called = true } })
  assert.equal(fromEnv.reason, 'credits disabled')
  assert.equal(called, false)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('getAll fetches every account once, in parallel, keyed by id', async () => {
  const dir = tempDir()
  const first = makeAccount(path.join(dir, 'a'), { authToken: 'a' })
  const second = { id: 'account-2', configDir: path.join(dir, 'b') }
  fs.mkdirSync(second.configDir, { recursive: true })

  const balances = await credits.getAll([first, second], {
    now: Date.now(),
    fetch: fakeFetch({ remainingBalance: 10 })
  })

  assert.deepEqual([...balances.keys()].sort(), ['account-1', 'account-2'])
  assert.equal(balances.get('account-1').ok, true)
  assert.equal(balances.get('account-2').ok, false)
  assert.match(balances.get('account-2').reason, /no readable token/)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('the usage URL can be pointed at another host', () => {
  assert.equal(
    credits.usageUrl({ FREEBUFFS_USAGE_URL: 'http://127.0.0.1:9/usage' }),
    'http://127.0.0.1:9/usage'
  )
  assert.equal(credits.usageUrl({}), credits.DEFAULT_USAGE_URL)
})
