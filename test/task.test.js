'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { makeWorld, removeTree } = require('./helpers')

const task = require('../src/task')
const { nudgeConfig } = require('../src/launch')

const dirs = []
test.after(() => {
  for (const dir of dirs) removeTree(dir)
})

/** An account config dir holding just the prompt history freebuff keeps. */
function historyDir (prompts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuffs-task-'))
  dirs.push(dir)
  if (prompts) {
    fs.writeFileSync(
      path.join(dir, 'message-history.json'),
      JSON.stringify(prompts)
    )
  }
  return dir
}

test('the last real task is recovered from the account history', () => {
  const dir = historyDir([
    'add battery options to the config',
    'the table rows are out of order, fix that'
  ])

  assert.equal(task.lastTask(dir), 'the table rows are out of order, fix that')
})

test('a bare "continue" nudge is never mistaken for the task', () => {
  // Typed by a person or by the supervisor, it says nothing about the work.
  for (const prompt of [
    'continue where you left off',
    'keep going',
    'carry on',
    'resume'
  ]) {
    const dir = historyDir(['build the firmware', prompt])
    assert.equal(task.lastTask(dir), 'build the firmware', prompt)
  }
})

test('the supervisor does not feed its own continue prompt back in', () => {
  // A restart types this into the new session, so it lands in that account's
  // history. Picking it up again would nest the prompt a little deeper on
  // every restart.
  const own = task.continuePrompt('fallback', 'build the firmware')
  const dir = historyDir(['build the firmware', own])
  assert.equal(task.lastTask(dir), 'build the firmware')

  // The earlier release typed a slightly different sentence; it must not be
  // mistaken for a new task either.
  const legacy = historyDir([
    'build the firmware',
    'Continue the unfinished task from the previous session. Inspect the ' +
      'repository and any notes from earlier sessions to see what is already ' +
      'done, then finish the remaining work. Do not start over.'
  ])
  assert.equal(task.lastTask(legacy), 'build the firmware')
})

test('a configured prompt is ignored when looking for the task', () => {
  const dir = historyDir(['build the firmware', 'carry on with it'])
  assert.equal(task.lastTask(dir, { ignore: ['carry on with it'] }), 'build the firmware')
})

test('a session with nothing typed yet yields no task', () => {
  assert.equal(task.lastTask(historyDir([])), null, 'missing history file')
  assert.equal(task.lastTask(historyDir(['  '])), null, 'blank prompt')
  assert.equal(task.lastTask('/nonexistent/freebuffs', {}), null, 'unreadable dir')
  assert.equal(task.lastTask(null), null, 'no config dir')
})

test('task text becomes one line, capped, so the TUI cannot submit early', () => {
  const wrapped = 'first line\nsecond line\r\nthird\tline'
  assert.equal(task.oneLine(wrapped), 'first line second line third line')

  const long = 'x'.repeat(task.MAX_TASK_CHARS + 500)
  const capped = task.oneLine(long)
  assert.equal(capped.length, task.MAX_TASK_CHARS)
  assert.match(capped, /…$/)
})

test('the continue prompt carries the task, and is the fallback without one', () => {
  const fallback = 'continue the unfinished task'
  assert.equal(task.continuePrompt(fallback, null), fallback)
  assert.equal(task.continuePrompt(fallback, ''), fallback)

  const prompt = task.continuePrompt(fallback, 'add battery options\nto the config')
  assert.match(prompt, /Continue the unfinished task/)
  assert.match(prompt, /do not start over/)
  assert.match(prompt, /add battery options to the config/)
  assert.doesNotMatch(prompt, /\n/, 'the prompt must stay on one line')
})

test('an explicit FREEBUFFS_CONTINUE_PROMPT is used exactly as given', () => {
  const config = nudgeConfig({ FREEBUFFS_CONTINUE_PROMPT: 'carry on' })
  assert.equal(config.text, 'carry on')
  assert.equal(config.custom, true, 'so no recovered task is appended')

  assert.equal(nudgeConfig({}).custom, false)
})

test('a session started on another account types the task, not just "continue"', async () => {
  const world = makeWorld()
  const log = path.join(world.root, 'resume-typed.txt')
  const tui = path.join(world.root, 'fake-tui.js')
  try {
    // The account the first attempt runs on: the task the user last typed.
    fs.writeFileSync(
      path.join(world.defaultConfig, 'message-history.json'),
      JSON.stringify([
        'fix the flux capacitor shutdown bug',
        'continue where you left off'
      ])
    )
    assert.equal(world.run(['login']).status, 0)

    // A TUI that reports the auth failure that retires the account, records
    // anything typed at it, and exits non-zero so the supervisor restarts.
    fs.writeFileSync(
      tui,
      `#!/usr/bin/env node
'use strict'
const fs = require('fs')
process.stderr.write('Error: 401 Unauthorized — authentication failed\\n')
process.stdout.write('Enter a coding task or / for commands\\n')
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => fs.appendFileSync(process.env.RESUME_LOG, chunk))
setTimeout(() => process.exit(1), 3000)
`
    )
    fs.chmodSync(tui, 0o755)

    const result = world.run(['run'], {
      FREEBUFFS_BINARY: tui,
      FREEBUFFS_PTY: '1',
      FREEBUFFS_FOREVER: '1',
      FREEBUFFS_RESTART_MS: '100',
      FREEBUFFS_RESUME_MS: '200',
      FREEBUFFS_MAX_FAST_FAILURES: '2',
      RESUME_LOG: log
    })
    assert.equal(result.status, 1, result.stderr)

    const state = world.state()
    // Newest first: the retired first attempt is last.
    assert.equal(state.sessions[1].accountId, 'account-1')
    assert.equal(state.sessions[0].accountId, 'account-2', 'the account should have been switched')

    const typed = fs.readFileSync(log, 'utf8')
    assert.match(typed, /Continue the unfinished task/)
    assert.match(
      typed,
      /fix the flux capacitor shutdown bug/,
      'the switched session must be told what the task is, not just to continue'
    )
    assert.doesNotMatch(typed, /continue where you left off/, 'a bare continuation is not the task')

    const events = world.events().map((event) => event.event)
    assert.ok(events.includes('account.auth_failure'))
    assert.ok(events.includes('session.resume'), 'the continue prompt should have been typed')
  } finally {
    world.cleanup()
  }
})
