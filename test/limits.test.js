'use strict'

const test = require('node:test')
const assert = require('node:assert')

const limits = require('../src/limits')

test('a used-up free account is recognised, and says it needs the reset', () => {
  // The exact sentence freebuff 0.2.34 shows when the session limit is hit.
  const verdict = limits.detect(
    'some earlier conversation\nSession limit reached. See https://freebuff.com/plans or choose another model with /model.'
  )

  assert.equal(verdict.kind, 'session-limit')
  assert.equal(verdict.ends, true, 'nothing more can run on this account')
  assert.equal(verdict.wait, true, 'only the quota reset can fix it')
  assert.equal(verdict.retype, false, 'typing at it would be useless')
  assert.match(verdict.message, /Session limit reached/)
})

test('a free session that ended is answered by sending the message again', () => {
  for (const sentence of [
    'Your free session ended, so the agent stopped here. Send a message to start a new session and continue.',
    'Your free session ended before this message was processed. Send it again after starting a new session.',
    'This Freebuff session has ended. Start a new session to try again.'
  ]) {
    const verdict = limits.detect(sentence)
    assert.equal(verdict.kind, 'session-ended', sentence)
    assert.equal(verdict.ends, false, 'a new message starts a new session')
    assert.equal(verdict.retype, true, sentence)
    assert.ok(verdict.delayMs > 0)
  }
})

test('a turn that hit the model usage limit continues with a new message', () => {
  const verdict = limits.detect(
    'This turn reached its model usage limit. Your session is still available \u2014 send a new message to continue from here.'
  )

  assert.equal(verdict.kind, 'turn-limit')
  assert.equal(verdict.retype, true)
  assert.equal(verdict.wait, false)
})

test('a busy free mode is a short retry, not a limit', () => {
  for (const sentence of [
    'Freebuff is temporarily busy. Please try again in a moment.',
    'Your free session is still being set up. Try again in a moment.',
    'The model may be busy or unavailable right now: send your message again to retry, or pick another model with /model.'
  ]) {
    const verdict = limits.detect(sentence)
    assert.equal(verdict.kind, 'capacity', sentence)
    assert.equal(verdict.wait, false)
    assert.equal(verdict.retype, true)
  }
})

test('the API error codes are recognised when only the log has them', () => {
  assert.equal(
    limits.detect('{"error":"session_limit_reached","statusCode":409}').kind,
    'session-limit'
  )
  assert.equal(
    limits.detect('{"error":"session_expired","statusCode":410}').kind,
    'session-ended'
  )
})

test('ordinary agent prose about limits is not a session state', () => {
  // The agent writes about limits, sessions and credits in ordinary
  // conversation. Only the bottom of the screen can be the state line; a
  // match high up with a conversation below it must be ignored.
  const prose = [
    'Session limit reached. See https://freebuff.com/plans or choose another model with /model.',
    ...Array.from({ length: 16 }, (_, index) => `step ${index}: still working on the parser`)
  ].join('\n')

  assert.equal(limits.detect(prose).kind, 'none')
})

test('a normal screen is not a state', () => {
  assert.equal(limits.detect('').kind, 'none')
  assert.equal(limits.detect('Wrote 3 files and ran the test suite.').kind, 'none')
  assert.equal(limits.detect(['']).kind, 'none')
})

test('the state is described in words a person can read', () => {
  assert.match(limits.describe({ kind: 'session-limit' }), /used up/)
  assert.match(limits.describe({ kind: 'session-ended' }), /new session/)
  assert.match(limits.describe({ kind: 'capacity' }), /busy/)
  assert.match(limits.describe({ kind: 'timeout' }), /network timeout/)
  assert.match(limits.describe({ kind: 'none' }), /normally/)
})

test('a dropped request is answered by sending the message again', () => {
  // The exact error box freebuff shows after a network timeout.
  const verdict = limits.detect([
    'Connection timed out: no data was received from the server for 5 minutes, so the request was aborted.',
    'This can be a slow model start on our side, or a connection dropped in transit (VPN, proxy, firewall, or flaky network).',
    'Retrying your message usually works. If it keeps happening, try a different model, or check your network/VPN/proxy.'
  ].join('\n'))

  assert.equal(verdict.kind, 'timeout')
  assert.equal(verdict.ends, false, 'the session itself is still alive')
  assert.equal(verdict.wait, false, 'no quota reset is involved')
  assert.equal(verdict.retype, true, 'typing the message again starts a new turn')
  assert.ok(verdict.delayMs > 0)
})

test('a failed connection is not ordinary agent prose', () => {
  assert.equal(
    limits.detect('Couldn\'t reach the server after retrying. Check your connection and try again.').kind,
    'timeout'
  )
  assert.equal(
    limits.detect('I added a timeout to the request and the tests pass.').kind,
    'none',
    'talking about a timeout is not one'
  )
})
