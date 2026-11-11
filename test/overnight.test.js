'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const overnight = require('../src/overnight')
const { removeTree } = require('./helpers')

/** A machine of its own, so the switches never touch the real config. */
function withHome (fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuffs-overnight-'))
  const previous = process.env.FREEBUFFS_HOME
  const home = path.join(root, 'home')
  process.env.FREEBUFFS_HOME = home
  try {
    return fn(home)
  } finally {
    if (previous === undefined) delete process.env.FREEBUFFS_HOME
    else process.env.FREEBUFFS_HOME = previous
    removeTree(root)
  }
}

function config (home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}

test('force continue and the shutdown timer are off by default', () => {
  withHome((home) => {
    const summary = overnight.summary()
    assert.equal(summary.forceContinue.enabled, false)
    assert.equal(summary.shutdownTimer.enabled, false)
    assert.equal(summary.forceContinue.custom, '')
    assert.match(summary.forceContinue.prompt, /all tasks complete/i)
    assert.match(summary.forceContinue.prompt, /remaining part/i)
    assert.deepEqual(config(home), {})
  })
})

test('a custom automatic prompt is stored and used, and clearing it restores the default', () => {
  withHome((home) => {
    overnight.setForceContinue(true)
    overnight.setForceContinuePrompt('  Carry on with every remaining phase.  ')

    const saved = overnight.forceContinue()
    assert.equal(saved.enabled, true)
    assert.equal(saved.custom, 'Carry on with every remaining phase.')
    assert.match(saved.prompt, /^Carry on with every remaining phase\./)
    // The completion line is still asked for, or the shutdown timer could
    // never know the task was finished.
    assert.match(saved.prompt, /FREEBUFFS ALL TASKS COMPLETE/)
    assert.equal(config(home).forceContinuePrompt, 'Carry on with every remaining phase.')

    // A prompt that already names the line is not given it twice.
    overnight.setForceContinuePrompt('Done? Write FREEBUFFS ALL TASKS COMPLETE')
    const once = overnight.forceContinue().prompt
    assert.equal(once.match(/FREEBUFFS ALL TASKS COMPLETE/g).length, 1)

    overnight.setForceContinuePrompt('   ')
    assert.equal(config(home).forceContinuePrompt, undefined)
    assert.equal(overnight.forceContinue().custom, '')
    assert.match(overnight.forceContinue().prompt, /remaining part/i)
  })
})

test('the switches are deleted from the config when turned off', () => {
  withHome((home) => {
    overnight.setForceContinue(true)
    overnight.setShutdownTimer(true)
    assert.equal(overnight.forceContinue().enabled, true)
    assert.equal(overnight.shutdownTimer(), true)

    overnight.setForceContinue(false)
    overnight.setShutdownTimer(false)
    assert.equal(overnight.forceContinue().enabled, false)
    assert.equal(overnight.shutdownTimer(), false)
    assert.equal(config(home).forceContinue, undefined)
    assert.equal(config(home).shutdownTimer, undefined)
  })
})

test('the completion line is recognised through wrapping and case', () => {
  assert.equal(overnight.markerShown('work done\nFREEBUFFS ALL TASKS COMPLETE'), true)
  assert.equal(overnight.markerShown('FREEBUFFS   all\ttasks\ncomplete'), true)
  assert.equal(overnight.markerShown('all tasks complete'), false)
  assert.equal(overnight.markerShown(''), false)
})

test('arming the shutdown writes the done marker and starts the watcher', () => {
  withHome((home) => {
    const calls = []
    const spawnFn = (command, args, options) => {
      calls.push({ command, args, options })
      return { unref () {}, on () {} }
    }

    const armed = overnight.armShutdown({
      pids: [1234, 0, 'x', 99],
      home,
      spawnFn,
      env: { PATH: '/bin' }
    })
    assert.equal(armed, true)
    assert.ok(fs.existsSync(path.join(home, 'agent-done')), 'the work is marked done')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, '/bin/sh')
    assert.match(calls[0].args[0], /wait-and-poweroff\.sh$/)
    assert.deepEqual(calls[0].args.slice(1), ['1234', '99'], 'only real pids are passed')
    assert.equal(calls[0].options.detached, true)
    assert.equal(calls[0].options.env.FREEBUFFS_HOME, home)
    assert.equal(
      calls[0].options.env.FREEBUFFS_POWEROFF_AFTER_MINUTES,
      String(overnight.SHUTDOWN_BACKUP_MINUTES)
    )
    assert.ok(!fs.existsSync(path.join(home, 'shutdown-cancel')), 'nothing left to cancel')
  })
})

test('a shutdown is not available where the script cannot run', () => {
  withHome((home) => {
    assert.equal(
      overnight.armShutdown({ pids: [1], home, platform: 'win32', spawnFn: () => ({}) }),
      false
    )
    assert.ok(!fs.existsSync(path.join(home, 'agent-done')))
  })
})

test('starting new work cancels a pending poweroff', () => {
  withHome((home) => {
    assert.equal(overnight.cancelShutdown({ home }), false, 'nothing armed, nothing to cancel')

    overnight.armShutdown({ pids: [1234], home, spawnFn: () => ({ unref () {}, on () {} }) })
    assert.ok(fs.existsSync(path.join(home, 'agent-done')))

    assert.equal(overnight.cancelShutdown({ home }), true)
    assert.ok(!fs.existsSync(path.join(home, 'agent-done')))
    assert.ok(fs.existsSync(path.join(home, 'shutdown-cancel')), 'the watcher is told to stop')
  })
})
