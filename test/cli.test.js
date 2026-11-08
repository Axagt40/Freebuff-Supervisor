'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { makeWorld, waitFor, makeJwt, removeTree } = require('./helpers')
const {
  monitorLaunch,
  monitorWindowEnabled,
  parseLaunchFlags,
  nudgeConfig
} = require('../src/launch')

const binDirs = []
test.after(() => {
  for (const dir of binDirs) removeTree(dir)
})

/** A directory of fake terminal emulators, so no real window is ever opened. */
function fakeBin (names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuffs-bin-'))
  binDirs.push(dir)
  for (const name of names) {
    const file = path.join(dir, name)
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(file, 0o755)
  }
  return dir
}

function accountsByConfig (world) {
  return world.state().accounts.map((account) => account.configDir)
}

test('a pty is used by default when node-pty is available', () => {
  const env = { FREEBUFFS_SUDO: '0' }
  // null means "decide at launch", which turns it on when node-pty is there.
  assert.equal(parseLaunchFlags([], env).pty, null)
  assert.equal(parseLaunchFlags(['--pty'], env).pty, true)
  assert.equal(parseLaunchFlags(['--no-pty'], env).pty, false)
  assert.equal(parseLaunchFlags([], { ...env, FREEBUFFS_PTY: '0' }).pty, false)
  assert.equal(parseLaunchFlags([], { ...env, FREEBUFFS_PTY: '1' }).pty, true)
})

test('the continue prompt and its startup delay are configurable', () => {
  const config = nudgeConfig({
    FREEBUFFS_CONTINUE_PROMPT: 'carry on',
    FREEBUFFS_RESUME_MS: '1500'
  })
  assert.equal(config.text, 'carry on')
  assert.equal(config.resumeMs, 1500)

  const fallback = nudgeConfig({})
  assert.match(fallback.text, /continue/i)
  assert.ok(fallback.resumeMs > 0)
})

test('login signs the default account in without listing identity', () => {
  const world = makeWorld({ signedIn: false })
  try {
    const result = world.run(['login'])
    assert.equal(result.status, 0, result.stderr)

    const state = world.state()
    assert.equal(state.accounts.length, 1)
    assert.equal(state.accounts[0].id, 'account-1')
    assert.ok(state.accounts[0].signedInAt)
    assert.match(result.stdout, /Signed in \(account-1\)/)
    assert.doesNotMatch(result.stdout, /stub@example\.com/)
    assert.ok(fs.existsSync(path.join(world.defaultConfig, 'credentials.json')))
  } finally {
    world.cleanup()
  }
})

test('a second login creates an isolated container', () => {
  const world = makeWorld()
  try {
    assert.equal(world.run(['login']).status, 0)
    const state = world.state()
    assert.equal(state.accounts.length, 2)

    const container = state.accounts[1]
    assert.equal(container.id, 'account-2')
    assert.ok(container.configDir.includes(path.join('accounts', 'account-2', 'config')))
    assert.ok(fs.existsSync(path.join(container.configDir, 'credentials.json')))
  } finally {
    world.cleanup()
  }
})

test('launch forwards args, records the session and runs the side monitor', async () => {
  const world = makeWorld()
  try {
    const result = world.run(['--continue', '--cwd', '.', 'fix the tests'])
    assert.equal(result.status, 0, result.stderr)

    const invocation = world.invocations().pop()
    assert.deepEqual(invocation.argv, ['--continue', '--cwd', '.', 'fix the tests'])
    assert.equal(invocation.configDir, world.defaultConfig)

    const state = world.state()
    const session = state.sessions[0]
    assert.ok(session)
    assert.equal(session.exitCode, 0)
    assert.ok(session.endedAt)
    assert.ok(session.pid)
    assert.equal(state.accounts[0].sessions, 1)
    assert.equal(state.lastAccountByCwd[process.cwd()], 'account-1')

    assert.ok(
      await waitFor(() => world.events().some((event) => event.event === 'monitor.stop')),
      'monitor should stop after the session ends'
    )
    const events = world.events().map((event) => event.event)
    for (const name of [
      'session.start',
      'session.spawn',
      'monitor.start',
      'session.end',
      'monitor.stop'
    ]) {
      assert.ok(events.includes(name), `missing ${name} event`)
    }
    assert.match(world.log(), /session\.start/)
    assert.match(world.log(), /session\.end/)
  } finally {
    world.cleanup()
  }
})

test('launch on a fresh machine runs setup first', () => {
  const world = makeWorld({ signedIn: false })
  try {
    const result = world.run(['do the thing'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /first run/)
    assert.match(result.stdout, /Setup complete/)

    const state = world.state()
    assert.equal(state.accounts.length, 1)
    assert.ok(state.accounts[0].signedInAt)
    assert.equal(state.sessions[0].exitCode, 0)
    // The folder is named on every launch, so a restart cannot inherit one.
    assert.deepEqual(
      world.invocations().pop().argv,
      ['--cwd', process.cwd(), 'do the thing']
    )
  } finally {
    world.cleanup()
  }
})

test('an automatic restart with nothing to resume starts a fresh chat in the folder', () => {
  // `--continue` in an account with no conversation for this folder is a chat
  // freebuff cannot resolve, so it shows its project picker — a folder list an
  // unattended session can never leave. The restart stays in the folder instead.
  const world = makeWorld()
  try {
    // A second account, so the failed first one rotates instead of ending the run.
    assert.equal(world.run(['login']).status, 0)
    const result = world.run(['run'], {
      FREEBUFFS_FOREVER: '1',
      FREEBUFFS_RESTART_MS: '50',
      FREEBUFFS_MAX_FAST_FAILURES: '2',
      STUB_STDERR: 'Error: 401 Unauthorized — authentication failed',
      STUB_EXIT_CODE: '1'
    })
    assert.equal(result.status, 1, result.stderr)

    const invocations = world.invocations()
    assert.ok(invocations.length >= 2, 'the failed start should be retried')
    for (const item of invocations) {
      assert.ok(
        !item.argv.includes('--continue'),
        'nothing in this folder can be continued'
      )
      assert.deepEqual(
        item.argv.slice(0, 2),
        ['--cwd', process.cwd()],
        'every launch names the folder it runs in'
      )
    }
    const events = world.events().map((event) => event.event)
    assert.ok(events.includes('session.fresh_chat'))
  } finally {
    world.cleanup()
  }
})

test('login --account re-signs an existing container in place', () => {
  const world = makeWorld()
  try {
    assert.equal(world.run(['login']).status, 0)
    assert.equal(world.state().accounts.length, 2)

    const result = world.run(['login', '--account', '2'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Signing in account-2/)
    assert.equal(world.state().accounts.length, 2)
    assert.ok(world.state().accounts[1].signedInAt)
  } finally {
    world.cleanup()
  }
})

test('login --new refuses an account that is already signed in', () => {
  const world = makeWorld()
  try {
    // account-1 is signed in as this identity, so signing in again would list
    // the same freebuff account twice.
    const result = world.run(['login', '--new'], { STUB_ACCOUNT_ID: 'stub-user' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /same freebuff account/)
    assert.equal(world.state().accounts.length, 1)
  } finally {
    world.cleanup()
  }
})

test('login rejects unknown accounts and --account with --new', () => {
  const world = makeWorld()
  try {
    const missing = world.run(['login', '--account', '9'])
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /no such account/)

    const conflict = world.run(['login', '--new', '--account', '1'])
    assert.equal(conflict.status, 1)
    assert.match(conflict.stderr, /not both/)
  } finally {
    world.cleanup()
  }
})

test('an auth failure retires the account and the next launch rotates', () => {
  const world = makeWorld()
  try {
    assert.equal(world.run(['login']).status, 0)
    const configs = accountsByConfig(world)

    const failed = world.run(['fail me'], {
      STUB_STDERR: 'Error: 401 Unauthorized — authentication failed',
      STUB_EXIT_CODE: '1'
    })
    assert.equal(failed.status, 1)
    assert.match(failed.stderr, /401 Unauthorized/)

    let state = world.state()
    assert.equal(state.sessions[0].accountId, 'account-1')
    assert.ok(state.sessions[0].authFailure)
    const flagged = state.accounts.find((account) => account.id === 'account-1')
    assert.ok(flagged.authFailedAt)
    assert.match(flagged.lastError, /auth failure/)

    assert.equal(world.run(['next']).status, 0)
    assert.equal(world.invocations().pop().configDir, configs[1])
  } finally {
    world.cleanup()
  }
})

test('when every account is flagged, launch stops with the fix', () => {
  const world = makeWorld()
  try {
    assert.equal(
      world.run(['run'], { STUB_STDERR: '401 Unauthorized', STUB_EXIT_CODE: '1' }).status,
      1
    )

    const blocked = world.run(['run'])
    assert.equal(blocked.status, 1)
    assert.match(blocked.stderr, /every signed-in account reported an auth failure/)

    const forced = world.run(['--account', '1', '--no-monitor'], { STUB_EXIT_CODE: '0' })
    assert.equal(forced.status, 0, forced.stderr)
  } finally {
    world.cleanup()
  }
})

test('signing an account in clears its auth failure', () => {
  const world = makeWorld()
  try {
    world.run(['run'], { STUB_STDERR: 'invalid token', STUB_EXIT_CODE: '1' })
    assert.ok(world.state().accounts[0].authFailedAt)

    assert.equal(world.run(['login', '--account', '1']).status, 0)
    assert.equal(world.state().accounts[0].authFailedAt, null)
  } finally {
    world.cleanup()
  }
})

test('status surfaces an account that needs sign-in', () => {
  const world = makeWorld()
  try {
    world.run(['run'], { STUB_STDERR: '401 Unauthorized', STUB_EXIT_CODE: '1' })
    const result = world.run(['status'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /auth\s+account-1 needs sign-in/)
  } finally {
    world.cleanup()
  }
})

test('credentials removed during a session flag the account', () => {
  const world = makeWorld()
  try {
    assert.equal(world.run(['run'], { STUB_DELETE_CREDENTIALS: '1' }).status, 0)
    assert.ok(world.state().accounts[0].authFailedAt)
  } finally {
    world.cleanup()
  }
})

test('setup signs the first account in non-interactively', () => {
  const world = makeWorld({ signedIn: false })
  try {
    const result = world.run(['setup'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Setup complete — 1 account\(s\) ready/) 
    const state = world.state()
    assert.equal(state.accounts.length, 1)
    assert.ok(state.accounts[0].signedInAt)
  } finally {
    world.cleanup()
  }
})

test('setup --accounts N signs in that many accounts', () => {
  const world = makeWorld()
  try {
    const result = world.run(['setup', '--accounts', '2'])
    assert.equal(result.status, 0, result.stderr)
    const state = world.state()
    assert.equal(state.accounts.length, 2)
    assert.ok(state.accounts.every((account) => account.signedInAt))
  } finally {
    world.cleanup()
  }
})

test('status warns about credentials close to expiry', () => {
  const world = makeWorld({
    credentials: { authToken: makeJwt(Math.floor(Date.now() / 1000) + 300) }
  })
  try {
    const result = world.run(['status'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /expiry\s+account-1 expires in/)
  } finally {
    world.cleanup()
  }
})

test('doctor reports a healthy supervisor', () => {
  const world = makeWorld()
  try {
    const result = world.run(['doctor'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /sfreebuff doctor/)
    assert.match(result.stdout, /accounts\s+1\/1 signed in/)
    assert.match(result.stdout, /ready/)
  } finally {
    world.cleanup()
  }
})

test('doctor fails when nothing is signed in', () => {
  const world = makeWorld({ signedIn: false })
  try {
    const result = world.run(['doctor'])
    assert.equal(result.status, 1)
    assert.match(result.stdout, /0 signed in/)
    assert.match(result.stdout, /problem\(s\)/)
  } finally {
    world.cleanup()
  }
})

test('successive launches rotate accounts and --account overrides the pick', () => {
  const world = makeWorld()
  try {
    assert.equal(world.run(['login']).status, 0)
    const configs = accountsByConfig(world)
    assert.equal(configs.length, 2)

    assert.equal(world.run(['one']).status, 0)
    assert.equal(world.invocations().pop().configDir, configs[0])

    assert.equal(world.run(['two']).status, 0)
    assert.equal(world.invocations().pop().configDir, configs[1])

    const forced = world.run(['--account', '2', '--no-monitor', 'forced'])
    assert.equal(forced.status, 0, forced.stderr)
    const invocation = world.invocations().pop()
    assert.equal(invocation.configDir, configs[1])
    assert.deepEqual(invocation.argv, ['--cwd', process.cwd(), 'forced'])
  } finally {
    world.cleanup()
  }
})

test('--no-monitor starts no monitor process', async () => {
  const world = makeWorld()
  try {
    assert.equal(world.run(['--no-monitor']).status, 0)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const monitors = world.events().filter((event) => event.event === 'monitor.start')
    assert.equal(monitors.length, 0)
  } finally {
    world.cleanup()
  }
})

test('the session exit code is propagated', () => {
  const world = makeWorld()
  try {
    const result = world.run(['run'], { STUB_EXIT_CODE: '3' })
    assert.equal(result.status, 3)
    assert.equal(world.state().sessions[0].exitCode, 3)
  } finally {
    world.cleanup()
  }
})

test('the supervisor gets its own console window on Windows', () => {
  const plan = monitorLaunch({
    platform: 'win32',
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    monitorPath: 'C:\\Users\\me\\FreebuffS project\\src\\monitor.js',
    sessionId: 'abc',
    accountId: 'account-1',
    pid: 123,
    cwd: 'C:\\Users\\me\\project',
    env: {}
  })

  assert.equal(plan.command, 'cmd.exe')
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c'])
  const command = plan.args[3]
  // The window title, then both space-containing paths quoted.
  assert.match(command, /^"start "sfreebuff supervisor" /)
  assert.match(command, /"C:\\Program Files\\nodejs\\node\.exe"/)
  assert.match(command, /"C:\\Users\\me\\FreebuffS project\\src\\monitor\.js"/)
  assert.match(command, /--window true"$/)
  assert.equal(plan.options.detached, true)
  assert.equal(plan.options.windowsVerbatimArguments, true)
})

test('the supervisor falls back to a hidden process when no terminal is available', () => {
  const plan = monitorLaunch({
    platform: 'linux',
    execPath: '/usr/bin/node',
    monitorPath: '/opt/freebuffs/src/monitor.js',
    sessionId: 'abc',
    accountId: 'account-1',
    pid: 123,
    cwd: '/tmp/project',
    env: {}
  })

  assert.equal(plan.command, '/usr/bin/node')
  assert.deepEqual(plan.args.slice(0, 1), ['/opt/freebuffs/src/monitor.js'])
  assert.ok(!plan.args.includes('--window'))
  assert.equal(plan.options.detached, true)
})

test('the supervisor opens its own terminal window on Linux', () => {
  const dir = fakeBin(['xterm'])
  const plan = monitorLaunch({
    platform: 'linux',
    execPath: '/usr/bin/node',
    monitorPath: '/opt/freebuffs/src/monitor.js',
    sessionId: 'abc',
    accountId: 'account-1',
    pid: 123,
    cwd: '/tmp/project',
    env: { PATH: dir, DISPLAY: ':0' }
  })

  assert.equal(plan.command, path.join(dir, 'xterm'))
  assert.deepEqual(plan.args.slice(0, 3), ['-e', '/usr/bin/node', '/opt/freebuffs/src/monitor.js'])
  assert.deepEqual(plan.args.slice(-2), ['--window', 'true'])
  assert.equal(plan.options.detached, true)
})

test('FREEBUFFS_MONITOR_WINDOW=0 keeps the monitor silent', () => {
  assert.equal(monitorWindowEnabled({}), true)
  assert.equal(monitorWindowEnabled({ FREEBUFFS_MONITOR_WINDOW: '0' }), false)
  assert.equal(monitorWindowEnabled({ FREEBUFFS_MONITOR_WINDOW: 'off' }), false)

  const dir = fakeBin(['xterm'])
  const plan = monitorLaunch({
    platform: 'linux',
    execPath: '/usr/bin/node',
    monitorPath: '/opt/freebuffs/src/monitor.js',
    sessionId: 'abc',
    accountId: 'account-1',
    pid: 123,
    cwd: '/tmp/project',
    env: { PATH: dir, DISPLAY: ':0' },
    window: false
  })

  assert.equal(plan.command, '/usr/bin/node')
  assert.ok(!plan.args.includes('--window'))
})

test('a launch runs the monitor inside a terminal window when one exists', async () => {
  const dir = fakeBin(['xterm'])
  const argsFile = path.join(dir, 'terminal-args.txt')
  // The fake emulator records the command it was given, drops the `-e`
  // separator and runs it, which is what a real emulator does in its window.
  fs.writeFileSync(
    path.join(dir, 'xterm'),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "$FAKE_TERM_ARGS"\nshift\nexec "$@"\n`
  )
  fs.chmodSync(path.join(dir, 'xterm'), 0o755)
  // The stub freebuff starts with `#!/usr/bin/env node`, so node has to stay
  // reachable without putting the real terminal emulators back on PATH.
  fs.symlinkSync(process.execPath, path.join(dir, 'node'))

  const world = makeWorld()
  try {
    const result = world.run(['run'], {
      // Only the fake emulator is visible, so the real one is never started.
      PATH: dir,
      DISPLAY: ':0',
      FREEBUFFS_MONITOR_WINDOW: '1',
      FAKE_TERM_ARGS: argsFile
    })
    assert.equal(result.status, 0, result.stderr)

    assert.ok(await waitFor(() => fs.existsSync(argsFile)), 'the emulator was never started')
    const terminalArgs = fs.readFileSync(argsFile, 'utf8').trim().split('\n')
    assert.deepEqual(terminalArgs.slice(0, 2), ['-e', process.execPath])
    assert.ok(terminalArgs.includes('--window'), 'the monitor must know it has a window')
    assert.ok(terminalArgs.includes('--session'))

    assert.ok(
      await waitFor(() => world.events().some((event) => event.event === 'monitor.start')),
      'the monitor should run inside that window'
    )
    assert.ok(
      await waitFor(() => world.events().some((event) => event.event === 'monitor.stop')),
      'the monitor should finish with the session'
    )
  } finally {
    world.cleanup()
  }
})

test('session reports are posted to the configured webhook', async () => {
  const received = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      received.push({
        contentType: request.headers['content-type'],
        body: JSON.parse(body)
      })
      response.writeHead(204).end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const world = makeWorld()
  try {
    const result = await world.runAsync(['run'], {
      FREEBUFFS_DISCORD_WEBHOOK: `http://127.0.0.1:${port}/api/webhooks/1/stub`
    })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(
      await waitFor(() => received.length >= 2),
      'expected a start and an end report'
    )

    const contents = received.map((item) => item.body.content).join('\n')
    assert.match(contents, /session started/)
    assert.match(contents, /session ended/)
    assert.equal(received[0].contentType, 'application/json')
    assert.deepEqual(received[0].body.allowed_mentions, { parse: [] })
    assert.ok(world.events().some((event) => event.event === 'report.sent'))
  } finally {
    world.cleanup()
    if (server.closeAllConnections) server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('status summarises accounts and monitors without identities', () => {
  const world = makeWorld()
  try {
    const result = world.run(['status'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /accounts\s+1\/1 signed in/)
    assert.doesNotMatch(result.stdout, /stub@example\.com/)
  } finally {
    world.cleanup()
  }
})

test('the 24/7 supervisor restarts a failed session', async () => {
  const world = makeWorld()
  try {
    const result = world.run(['run'], {
      FREEBUFFS_FOREVER: '1',
      FREEBUFFS_RESTART_MS: '50',
      STUB_EXIT_CODE: '1'
    })

    // Still failing, so the exit status of the last session survives. The
    // default gives up after three failed starts, and before that it tries the
    // one fix left: abandon the saved conversation and start a fresh one (see
    // the crash loop test).
    assert.equal(result.status, 1)
    assert.equal(world.invocations().length, 6, 'the session should have been retried')

    const events = world.events().map((event) => event.event)
    assert.ok(events.includes('supervisor.start'), 'the supervisor reports that it started')
    assert.ok(events.includes('supervisor.restart'), 'the retry should be recorded')
    assert.ok(events.includes('supervisor.fresh_conversation'), 'a new conversation is tried')
    assert.ok(events.includes('supervisor.stop'))
    assert.equal(world.state().sessions.length, 6, 'each attempt is its own session')
  } finally {
    world.cleanup()
  }
})

test('a crash loop stops with a critical reason instead of retrying forever', async () => {
  const world = makeWorld()
  try {
    const result = world.run(['run'], {
      FREEBUFFS_FOREVER: '1',
      FREEBUFFS_RESTART_MS: '50',
      FREEBUFFS_MAX_FAST_FAILURES: '2',
      STUB_EXIT_CODE: '1'
    })

    assert.equal(result.status, 1)
    // Two identical failed starts, then one fresh conversation for the same
    // two, and then it gives up instead of looping forever.
    assert.equal(
      world.invocations().length,
      4,
      'it must give up once starts keep failing immediately'
    )

    const stopped = world.events().find((event) => event.event === 'supervisor.stopped')
    assert.ok(stopped, 'giving up must be recorded')
    assert.match(stopped.reason, /failed starts in a row/)
    assert.match(world.log(), /supervisor\.stopped/)
  } finally {
    world.cleanup()
  }
})

test('a session that ends cleanly stops the 24/7 loop', async () => {
  const world = makeWorld()
  try {
    const result = world.run(['run'], {
      FREEBUFFS_FOREVER: '1',
      FREEBUFFS_RESTART_MS: '50',
      STUB_EXIT_CODE: '0'
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(world.invocations().length, 1, 'a clean exit is not something to retry')
    const events = world.events().map((event) => event.event)
    assert.ok(events.includes('supervisor.done'))
    assert.ok(!events.includes('supervisor.restart'))
  } finally {
    world.cleanup()
  }
})

test('--once runs a single session even when the loop is on', () => {
  const world = makeWorld()
  try {
    const result = world.run(['--once'], {
      FREEBUFFS_FOREVER: '1',
      FREEBUFFS_RESTART_MS: '50',
      STUB_EXIT_CODE: '1'
    })

    assert.equal(result.status, 1)
    assert.equal(world.invocations().length, 1)
    assert.ok(!world.events().some((event) => event.event === 'supervisor.restart'))
  } finally {
    world.cleanup()
  }
})

test('the supervisor reports that it started and stopped', async () => {
  const received = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      received.push(JSON.parse(body))
      response.writeHead(204).end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const world = makeWorld()
  try {
    const result = await world.runAsync(['run'], {
      FREEBUFFS_DISCORD_WEBHOOK: `http://127.0.0.1:${port}/api/webhooks/1/stub`
    })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(
      await waitFor(() => received.some((item) => /stopped/.test(item.content))),
      'the supervisor should report that it stopped'
    )

    const contents = received.map((item) => item.content).join('\n')
    assert.match(contents, /\*\*Freebuff Supervisor\*\* · started/)
    assert.match(contents, /\*\*Freebuff Supervisor\*\* · stopped/)
    assert.doesNotMatch(contents, /\*\*sfreebuff\*\*/)
    // An ordinary report must not be able to ping the channel.
    for (const item of received) {
      assert.deepEqual(item.allowed_mentions, { parse: [] })
    }
  } finally {
    world.cleanup()
    if (server.closeAllConnections) server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a critical stop pings the channel, and its text cannot ping by itself', async () => {
  const received = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      received.push(JSON.parse(body))
      response.writeHead(204).end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const world = makeWorld()
  try {
    const result = world.run(['--cwd', '/tmp/@everyone'], {
      FREEBUFFS_DISCORD_WEBHOOK: `http://127.0.0.1:${port}/api/webhooks/1/stub`,
      FREEBUFFS_FOREVER: '1',
      FREEBUFFS_RESTART_MS: '50',
      FREEBUFFS_MAX_FAST_FAILURES: '1',
      STUB_EXIT_CODE: '1'
    })
    assert.equal(result.status, 1)

    assert.ok(
      await waitFor(() => received.some((item) => /CRITICAL/.test(item.content))),
      'a crash loop should be reported as critical'
    )

    const critical = received.find((item) => /CRITICAL/.test(item.content))
    assert.match(critical.content, /user interaction required/)
    assert.deepEqual(critical.allowed_mentions, { parse: ['everyone'] })
    // The folder name contains @everyone; it must not be able to ping.
    assert.doesNotMatch(critical.content, /(?<!@)\u200b?@everyone/)
  } finally {
    world.cleanup()
    if (server.closeAllConnections) server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
