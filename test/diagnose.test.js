'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { removeTree } = require('./helpers')

const diagnose = require('../src/diagnose')

const dirs = []
test.after(() => {
  for (const dir of dirs) removeTree(dir)
})

test('an auth failure names the sign-in command', () => {
  const result = diagnose.classify({
    code: 1,
    accountId: 'account-2',
    tail: 'Error: 401 Unauthorized — authentication failed'
  })
  assert.equal(result.cause, 'authentication failed')
  assert.match(result.detail, /401 Unauthorized/)
  assert.match(result.action, /sfreebuff login --account account-2/)
})

test('a prompt that was never sent is its own cause', () => {
  const result = diagnose.classify({ code: null, signal: 'SIGTERM', stuck: true })
  assert.equal(result.cause, 'typed prompt was never sent')
  // The conversation is relaunched so the task can be typed into a clean box.
  assert.match(result.action, /relaunched/)
  assert.match(result.action, /typed text/)
})

test('a stalled session reports how long nothing happened', () => {
  const result = diagnose.classify({ code: 0, stalled: true, quietMs: 20 * 60 * 1000 })
  assert.equal(result.cause, 'no progress')
  assert.match(result.detail, /20m00s/)
})

test('known environment failures are recognised from the output', () => {
  assert.equal(
    diagnose.classify({ code: 1, tail: 'ENOSPC: no space left on device' }).cause,
    'out of disk space'
  )
  assert.equal(
    diagnose.classify({ code: 1, tail: 'Error: listen EADDRINUSE: address already in use' }).cause,
    'port already in use'
  )
  assert.equal(
    diagnose.classify({ code: 127, tail: 'sh: helper: command not found' }).cause,
    'missing command'
  )
  assert.equal(
    diagnose.classify({ code: 1, tail: 'Error: auto-answer needs node-pty' }).cause,
    'terminal problem'
  )
})

test('anything else still says what is known', () => {
  assert.equal(
    diagnose.classify({ code: null, signal: 'SIGKILL' }).cause,
    'terminated by SIGKILL'
  )
  assert.equal(
    diagnose.classify({ code: 3, tail: 'error: something odd' }).cause,
    'freebuff exited with code 3'
  )
  assert.equal(diagnose.classify({ code: 0 }).cause, 'session ended')
})

test('a report is written next to the supervisor log and recorded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuffs-diagnose-'))
  dirs.push(root)
  process.env.FREEBUFFS_HOME = path.join(root, 'home')

  const account = { id: 'account-2', configDir: path.join(root, 'config') }
  const result = diagnose.record('session-9', {
    accountId: 'account-2',
    account,
    cwd: root,
    code: 1,
    tail: 'Error: 401 Unauthorized — authentication failed'
  })

  assert.equal(result.cause, 'authentication failed')
  assert.ok(result.file, 'a report path should be returned')
  assert.equal(path.dirname(result.file), path.join(root, 'home', 'logs'))

  const body = fs.readFileSync(result.file, 'utf8')
  assert.match(body, /session\s+session-9/)
  assert.match(body, /cause\s+authentication failed/)
  assert.match(body, /## checks/)
  assert.match(body, /401 Unauthorized/)

  const events = fs.readFileSync(path.join(root, 'home', 'logs', 'supervisor.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const recorded = events.find((event) => event.event === 'session.diagnose')
  assert.ok(recorded, 'the diagnosis should be in the supervisor log')
  assert.equal(recorded.cause, 'authentication failed')
  assert.equal(recorded.report, result.file)
})
