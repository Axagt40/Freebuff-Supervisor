'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { removeTree } = require('./helpers')

const notify = require('../src/notify')

const roots = []
test.beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuffs-notify-'))
  roots.push(root)
  process.env.FREEBUFFS_HOME = path.join(root, 'home')
  delete process.env.FREEBUFFS_DISCORD_WEBHOOK
})

test.after(() => {
  for (const root of roots) removeTree(root)
})

const WEBHOOK = 'https://discord.com/api/webhooks/123/abc-def'

/** Run a command without letting its console output pollute the test log. */
async function quietly (fn) {
  const log = console.log
  const error = console.error
  console.log = () => {}
  console.error = () => {}
  try {
    return await fn()
  } finally {
    console.log = log
    console.error = error
  }
}

test('nothing is posted until a webhook is configured', async () => {
  assert.equal(notify.webhookUrl(), '')
  assert.equal(await notify.report('hello'), false)
  assert.equal(await quietly(() => notify.notifyCommand(['test'])), 1)
})

test('a webhook is stored outside the project and can be turned off', () => {
  assert.deepEqual(notify.setWebhook(WEBHOOK), { cleared: false })
  assert.equal(notify.webhookUrl(), WEBHOOK)
  assert.equal(notify.readConfig().discordWebhook, WEBHOOK)
  assert.ok(notify.configPath().startsWith(process.env.FREEBUFFS_HOME))

  notify.setWebhook('off')
  assert.equal(notify.webhookUrl(), '')
  assert.equal(notify.readConfig().discordWebhook, undefined)
})

test('only Discord webhook URLs are accepted', () => {
  assert.equal(notify.isWebhookUrl(WEBHOOK), true)
  assert.equal(notify.isWebhookUrl('https://discord.com/channels/1/2'), false)
  assert.equal(notify.isWebhookUrl('http://discord.com/api/webhooks/1/x'), false)
  assert.equal(notify.isWebhookUrl('https://example.com/api/webhooks/1/x'), false)
  assert.equal(notify.isWebhookUrl('not a url'), false)
  assert.throws(() => notify.setWebhook('https://example.com/hook'), /expected a Discord webhook URL/)
  assert.equal(notify.webhookUrl(), '')
})

test('the environment overrides the stored webhook', () => {
  notify.setWebhook(WEBHOOK)
  process.env.FREEBUFFS_DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/999/override'
  assert.equal(notify.webhookUrl(), 'https://discord.com/api/webhooks/999/override')
})

test('sending posts JSON and disables mention parsing', async () => {
  const calls = []
  const result = await notify.send('hi @everyone', {
    url: WEBHOOK,
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return { ok: true, status: 204 }
    }
  })

  assert.deepEqual(result, { sent: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, WEBHOOK)
  assert.equal(calls[0].options.method, 'POST')
  assert.equal(calls[0].options.headers['content-type'], 'application/json')
  const body = JSON.parse(calls[0].options.body)
  assert.equal(body.content, 'hi @everyone')
  assert.deepEqual(body.allowed_mentions, { parse: [] })
})

test('a rejected or unreachable webhook is reported, never thrown', async () => {
  const rejected = await notify.send('hi', {
    url: WEBHOOK,
    fetchImpl: async () => ({ ok: false, status: 500 })
  })
  assert.deepEqual(rejected, { sent: false, reason: 'discord responded 500' })

  const threw = await notify.send('hi', {
    url: WEBHOOK,
    fetchImpl: async () => { throw new Error('network down') }
  })
  assert.deepEqual(threw, { sent: false, reason: 'network down' })

  assert.deepEqual(await notify.send('hi', { url: '' }), {
    sent: false,
    reason: 'no webhook configured'
  })
})

test('a failed report is logged and resolves false', async () => {
  // Port 1 refuses immediately, so this never touches the network.
  process.env.FREEBUFFS_DISCORD_WEBHOOK = 'http://127.0.0.1:1/api/webhooks/1/x'
  assert.equal(await notify.report('hi', { kind: 'session.start' }), false)

  const log = fs.readFileSync(path.join(process.env.FREEBUFFS_HOME, 'logs', 'supervisor.log'), 'utf8')
  assert.match(log, /report not delivered/)
  assert.match(log, /kind=session.start/)
})

test('reports describe the session without leaking the webhook', () => {
  const started = notify.sessionStarted({
    accountId: 'account-2',
    sessionId: 's-1',
    cwd: '/tmp/project',
    binary: '/usr/bin/freebuff'
  })
  assert.match(started, /session started/)
  assert.match(started, /account-2/)
  assert.match(started, /\/tmp\/project/)

  const ended = notify.sessionEnded({
    accountId: 'account-2',
    sessionId: 's-1',
    cwd: '/tmp/project',
    code: 0,
    signal: null,
    durationMs: 65000
  })
  assert.match(ended, /exit code 0/)
  assert.match(ended, /1m05s/)

  const signalled = notify.sessionEnded({
    accountId: 'account-2',
    sessionId: 's-1',
    cwd: '/tmp/project',
    code: null,
    signal: 'SIGINT',
    durationMs: 1000
  })
  assert.match(signalled, /signal SIGINT/)

  const failed = notify.authFailure({
    accountId: 'account-2',
    sessionId: 's-1',
    detail: '401 Unauthorized'
  })
  assert.match(failed, /needs sign-in/)
  assert.match(failed, /sfreebuff login --account account-2/)

  // A prompt that could not be sent is a warning: the session is relaunched,
  // and that is not something only a person can fix.
  const unsent = notify.promptUnsent({
    accountId: 'account-2',
    sessionId: 's-1',
    cwd: '/tmp/project',
    prompt: 'continue the unfinished task'
  })
  assert.match(unsent, /prompt could not be sent/)
  assert.match(unsent, /continue the unfinished task/)
  assert.match(unsent, /relaunched/)
  assert.doesNotMatch(unsent, /CRITICAL/)

  for (const text of [started, ended, signalled, failed, unsent]) {
    assert.ok(!text.includes('webhooks'), 'a report must never carry the webhook')
  }
})

test('notify off clears the stored webhook', async () => {
  notify.setWebhook(WEBHOOK)
  assert.equal(await quietly(() => notify.notifyCommand(['off'])), 0)
  assert.equal(notify.webhookUrl(), '')
})

test('notify rejects a bad URL with a non-zero exit code', async () => {
  assert.equal(await quietly(() => notify.notifyCommand(['https://example.com/hook'])), 1)
  assert.equal(notify.webhookUrl(), '')
})
