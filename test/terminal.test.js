'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { removeTree } = require('./helpers')

const {
  which,
  findTerminal,
  windowCommand,
  shellQuote,
  hasDisplay
} = require('../src/terminal')

const dirs = []

test.after(() => {
  for (const dir of dirs) removeTree(dir)
})

/** A directory of fake executables, so nothing real is ever launched. */
function binDir (names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuffs-terminal-'))
  dirs.push(dir)
  for (const name of names) {
    const file = path.join(dir, name)
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(file, 0o755)
  }
  return dir
}

test('which finds an executable on PATH and ignores plain files', () => {
  const dir = binDir(['xterm'])
  fs.writeFileSync(path.join(dir, 'not-executable'), 'text')

  assert.equal(which('xterm', { PATH: dir }), path.join(dir, 'xterm'))
  assert.equal(which('not-executable', { PATH: dir }), null)
  assert.equal(which('missing', { PATH: dir }), null)
  assert.equal(which(path.join(dir, 'xterm'), { PATH: '' }), path.join(dir, 'xterm'))
  assert.equal(which('', { PATH: dir }), null)
})

test('the first known emulator on PATH wins', () => {
  const dir = binDir(['xterm', 'gnome-terminal'])
  const found = findTerminal({ PATH: dir })
  assert.equal(path.basename(found.command), 'gnome-terminal')
  assert.equal(found.style, 'dash-dash')
})

test('$TERMINAL is honoured, including emulators we do not know', () => {
  const dir = binDir(['kitty', 'xterm', 'my-term'])

  const kitty = findTerminal({ PATH: dir, TERMINAL: 'kitty' })
  assert.equal(path.basename(kitty.command), 'kitty')
  assert.equal(kitty.style, 'plain')

  const unknown = findTerminal({ PATH: dir, TERMINAL: 'my-term' })
  assert.equal(path.basename(unknown.command), 'my-term')
  assert.equal(unknown.style, 'dash-e')
})

test('no emulator on PATH means no window', () => {
  assert.equal(findTerminal({ PATH: binDir([]) }), null)
})

test('the Linux window runs the monitor in the emulator', () => {
  const dir = binDir(['xterm'])
  const plan = windowCommand({
    platform: 'linux',
    command: '/usr/bin/node',
    args: ['/opt/freebuffs/src/monitor.js', '--session', 'abc'],
    env: { PATH: dir, DISPLAY: ':0' }
  })

  assert.equal(plan.command, path.join(dir, 'xterm'))
  assert.deepEqual(plan.args, [
    '-e',
    '/usr/bin/node',
    '/opt/freebuffs/src/monitor.js',
    '--session',
    'abc'
  ])
})

test('headless Linux gets no window at all', () => {
  const dir = binDir(['xterm'])
  assert.equal(hasDisplay({ PATH: dir }), false)
  assert.equal(hasDisplay({ WAYLAND_DISPLAY: 'wayland-0' }), true)
  assert.equal(
    windowCommand({ platform: 'linux', command: 'node', args: ['m.js'], env: { PATH: dir } }),
    null
  )
})

test('emulators that need their own argument style get it', () => {
  const kittyDir = binDir(['kitty'])
  const kitty = windowCommand({
    platform: 'linux',
    command: 'node',
    args: ['m.js'],
    env: { PATH: kittyDir, DISPLAY: ':0' }
  })
  assert.deepEqual(kitty.args, ['-o', 'close_on_child_death=yes', 'node', 'm.js'])

  const wezDir = binDir(['wezterm'])
  const wez = windowCommand({
    platform: 'linux',
    command: 'node',
    args: ['m.js'],
    env: { PATH: wezDir, DISPLAY: ':0' }
  })
  assert.deepEqual(wez.args, ['start', '--', 'node', 'm.js'])
})

test('Windows never goes through a terminal emulator', () => {
  const dir = binDir(['xterm'])
  const plan = windowCommand({
    platform: 'win32',
    command: 'node.exe',
    args: ['m.js'],
    env: { PATH: dir, DISPLAY: ':0' }
  })
  assert.equal(plan, null)
})

test('macOS asks Terminal.app to run the monitor and close its window', () => {
  const dir = binDir(['osascript'])
  const plan = windowCommand({
    platform: 'darwin',
    command: '/usr/local/bin/node',
    args: ['/Users/me/FreebuffS project/src/monitor.js', '--session', 'abc'],
    env: { PATH: dir }
  })

  assert.equal(plan.command, path.join(dir, 'osascript'))
  assert.equal(plan.args[0], '-e')
  const script = plan.args[1]
  assert.match(script, /^tell application "Terminal" to do script "/)
  assert.match(script, /'\/Users\/me\/FreebuffS project\/src\/monitor\.js'/)
  assert.match(script, /; exit"$/)
})

test('shell quoting survives a quote inside a path', () => {
  assert.equal(shellQuote("/tmp/it's here"), "'/tmp/it'\\''s here'")
})
