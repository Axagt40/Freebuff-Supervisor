'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const dashboard = require('../src/dashboard')
const { stopFilePath, clearStopRequest } = require('../src/supervise')
const { makeWorld, waitFor } = require('./helpers')

const ROOT = path.resolve(__dirname, '..')
const BIN = path.join(ROOT, 'bin', 'sfreebuff.js')
const ANSI = /\u001b\[[0-9;]*m/g

function tempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'freebuffs-dash-'))
}

function withHome (fn) {
  const previous = process.env.FREEBUFFS_HOME
  const home = tempDir()
  process.env.FREEBUFFS_HOME = home
  try {
    return fn(home)
  } finally {
    if (previous === undefined) delete process.env.FREEBUFFS_HOME
    else process.env.FREEBUFFS_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
}

function seed (home, state) {
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true })
  fs.mkdirSync(path.join(home, 'run'), { recursive: true })
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify(state, null, 2))
}

const CFG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuffs-dash-cfg-'))

function account (id, extra = {}) {
  const configDir = path.join(CFG_ROOT, id)
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(
    path.join(configDir, 'credentials.json'),
    JSON.stringify({ default: { id, name: id, authToken: 'tok-stub' } })
  )
  return {
    id,
    label: id,
    configDir,
    shared: false,
    createdAt: new Date().toISOString(),
    signedInAt: new Date().toISOString(),
    lastUsedAt: new Date(Date.now() - 60000).toISOString(),
    sessions: 3,
    totalMs: 0,
    lastError: null,
    ...extra
  }
}

function session (id, accountId, extra = {}) {
  return {
    id,
    accountId,
    cwd: '/work/project',
    pid: process.pid,
    launcherPid: 1234,
    startedAt: new Date(Date.now() - 90000).toISOString(),
    endedAt: null,
    exitCode: null,
    args: [],
    ...extra
  }
}

function plain (lines) {
  return lines.map((line) => line.replace(ANSI, ''))
}

function fakeTerminal (dir) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'xterm')
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(file, 0o755)
  return dir
}

test('session arguments pin one account to one folder, with no sudo prompt', () => {
  assert.deepEqual(
    dashboard.sessionArgs({ id: 'account-2' }, '/work'),
    // --no-sudo: the window is unattended, so it never waits for a password.
    // --fresh: a new session starts a conversation of its own instead of
    // continuing whatever chat ran in this folder last.
    ['--account', 'account-2', '--cwd', '/work', '--no-monitor', '--no-sudo', '--fresh']
  )
  // Continuing a row's session resumes the conversation and is typed the
  // continue prompt by the supervisor.
  assert.deepEqual(
    dashboard.sessionArgs({ id: 'account-2' }, '/work', { continue: true }),
    ['--account', 'account-2', '--cwd', '/work', '--no-monitor', '--no-sudo', '--continue']
  )
})

test('keys map to actions, including escape sequences', () => {
  assert.deepEqual(dashboard.keyActions('\u001b[A'), ['up'])
  assert.deepEqual(dashboard.keyActions('\u001b[B'), ['down'])
  assert.deepEqual(dashboard.keyActions('\t'), ['pane'])
  assert.deepEqual(dashboard.keyActions('\r'), ['start'])
  assert.deepEqual(dashboard.keyActions('x'), ['stop'])
  assert.deepEqual(dashboard.keyActions('n'), ['new'])
  assert.deepEqual(dashboard.keyActions('l'), ['login'])
  assert.deepEqual(dashboard.keyActions('a'), ['add'])
  assert.deepEqual(dashboard.keyActions('d'), ['remove'])
  assert.deepEqual(dashboard.keyActions('q'), ['quit'])
  assert.deepEqual(dashboard.keyActions('\u0003'), ['quit'])
  assert.deepEqual(dashboard.keyActions('jj'), ['down', 'down'])
  assert.deepEqual(dashboard.keyActions(''), [])
})

test('a click selects the row under the pointer', () => {
  withHome((home) => {
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: [account('account-1'), account('account-2')],
      sessions: [session('a', 'account-1', { cwd: '/home/me/project' })],
      lastAccountId: 'account-1',
      lastAccountByCwd: {}
    })
    const model = dashboard.collect({})
    const view = dashboard.buildView(model, {
      width: 100,
      height: 30,
      color: false,
      focus: 'sessions',
      selected: { accounts: 0, sessions: 0 }
    })

    // The add-account row sits above the list, so it is cursor position 0.
    assert.deepEqual(dashboard.hitTest(view.layout, 8, view.layout.newAccount.y), {
      action: 'choose-account',
      index: 0
    })

    const accountRow = view.lines.findIndex((line) => line.includes('account-2'))
    assert.deepEqual(dashboard.hitTest(view.layout, 8, accountRow), {
      action: 'choose-account',
      index: 2
    })

    // The new-session row sits above the list, so the first session is 1.
    const sessionRow = view.layout.sessions[0].y
    assert.deepEqual(dashboard.hitTest(view.layout, 8, sessionRow), {
      action: 'choose-session',
      index: 1
    })
    assert.deepEqual(dashboard.hitTest(view.layout, 8, view.layout.newSession.y), {
      action: 'choose-session',
      index: 0
    })

    assert.equal(dashboard.hitTest(view.layout, 1, 1), null, 'the header is not clickable')
  })
})

test('the accounts pane starts with an add-account row', () => {
  withHome((home) => {
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: [account('account-1'), account('account-2')],
      sessions: [],
      lastAccountId: 'account-1',
      lastAccountByCwd: {}
    })
    const model = dashboard.collect({})
    const view = dashboard.buildView(model, {
      width: 100,
      height: 30,
      color: false,
      focus: 'accounts',
      selected: { accounts: 0, sessions: 0 }
    })
    const lines = plain(view.lines)

    const header = lines.findIndex((line) => /ACCOUNTS {2}/.test(line))
    const addRow = lines.findIndex((line) => line.includes('＋ add account'))
    assert.equal(addRow, header + 1, 'it is the first row under the heading')
    assert.match(lines[addRow], /^ ▸ /, 'and it holds the accounts cursor')

    const firstAccount = lines.findIndex((line) => line.includes('account-1'))
    assert.ok(firstAccount > addRow, 'the accounts are listed below it')
    // The row is the button, like the new-session row, so a click reaches it.
    assert.deepEqual(dashboard.hitTest(view.layout, 8, addRow), {
      action: 'choose-account',
      index: 0
    })
    // An account's cursor position is one past its index, since the row is 0.
    assert.deepEqual(dashboard.hitTest(view.layout, 8, firstAccount), {
      action: 'choose-account',
      index: 1
    })
  })
})

test('the footer buttons are clickable actions', () => {
  withHome((home) => {
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: [account('account-1')],
      sessions: [],
      lastAccountId: 'account-1',
      lastAccountByCwd: {}
    })
    const model = dashboard.collect({})
    const view = dashboard.buildView(model, { width: 100, height: 30, color: false })
    const row = view.lines.findIndex((line) => line.includes('[ enter start ]'))
    assert.ok(row > 0, 'the action row is drawn')

    const labels = {
      start: '[ enter start ]',
      new: '[ n new session ]',
      stop: '[ x stop ]',
      login: '[ l login ]',
      remove: '[ d remove ]',
      refresh: '[ r refresh ]',
      quit: '[ q quit ]'
    }
    // The buttons wrap onto a second row on a narrow terminal, so each label
    // is clicked on whichever line it was drawn on.
    const actions = ['start', 'new', 'stop', 'login', 'remove', 'refresh', 'quit']
    const clicks = actions.map((action) => {
      const y = view.lines.findIndex((line) => line.includes(labels[action]))
      if (y < 0) return null
      return dashboard.hitTest(view.layout, view.lines[y].indexOf(labels[action]) + 3, y)
    })
    assert.deepEqual(clicks.map((hit) => hit && hit.action), actions)
    assert.equal(dashboard.hitTest(view.layout, 0, row), null, 'the gaps are not buttons')
  })
})

test('an account container can be removed from the dashboard', () => {
  withHome((home) => {
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: [account('account-1'), account('account-2')],
      sessions: [],
      lastAccountId: 'account-2',
      lastAccountByCwd: { '/work/project': 'account-2' }
    })
    // A container the dashboard made lives under the supervisor's own home.
    const container = path.join(home, 'accounts', 'account-2', 'config')
    fs.mkdirSync(container, { recursive: true })
    fs.writeFileSync(
      path.join(container, 'credentials.json'),
      JSON.stringify({ default: { id: 'account-2' } })
    )

    const result = dashboard.removeAccount('account-2')
    assert.equal(result.ok, true)
    assert.equal(result.removed, true)
    assert.equal(fs.existsSync(container), false)
    assert.deepEqual(
      dashboard.collect({}).accounts.map((entry) => entry.id),
      ['account-1']
    )
  })
})

test('accounts are listed by number, even after an id was reused', () => {
  withHome((home) => {
    // Removing account-3 and signing in again reuses that number, and the new
    // record used to be pushed at the end: 1, 2, 4, 3.
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: ['account-1', 'account-2', 'account-4', 'account-3'].map((id) => account(id)),
      sessions: [],
      lastAccountId: 'account-1',
      lastAccountByCwd: {}
    })
    assert.deepEqual(
      dashboard.collect({}).accounts.map((entry) => entry.id),
      ['account-1', 'account-2', 'account-3', 'account-4']
    )
  })
})

test('the remove button is greyed out for the shared account', () => {
  withHome((home) => {
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: [account('account-1', { shared: true }), account('account-2')],
      sessions: [],
      lastAccountId: 'account-1',
      lastAccountByCwd: {}
    })
    const model = dashboard.collect({})
    const onShared = dashboard.buildView(model, {
      width: 100,
      height: 30,
      color: false,
      focus: 'accounts',
      selected: { accounts: 1, sessions: 0 }
    })
    const removeButton = onShared.layout.buttons.find((button) => button.action === 'remove')
    assert.ok(removeButton, 'the button is drawn')
    assert.match(onShared.lines[removeButton.y], /\[ d remove \]/)

    // Selecting the extra container makes it available.
    const onContainer = dashboard.buildView(model, {
      width: 100,
      height: 30,
      color: true,
      focus: 'accounts',
      selected: { accounts: 2, sessions: 0 }
    })
    const line = onContainer.lines[onContainer.layout.buttons.find((b) => b.action === 'remove').y]
    assert.match(line, /\[ d remove \]/)
    assert.notEqual(line, onShared.lines[removeButton.y], 'a grey button is drawn differently')
  })
})

test('the action row stays on screen when the lists would push it off', () => {
  withHome((home) => {
    const accounts = ['account-1', 'account-2', 'account-3', 'account-4'].map((id) => account(id))
    const sessions = Array.from({ length: 8 }, (_, index) =>
      session(`s${index}`, accounts[index % accounts.length].id, {
        cwd: `/home/me/project-${index}`
      })
    )
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts,
      sessions,
      lastAccountId: 'account-1',
      lastAccountByCwd: {}
    })
    const model = dashboard.collect({})
    const view = dashboard.buildView(model, { width: 100, height: 14, color: false })

    assert.equal(view.lines.length, 14, 'the view never grows past the terminal')
    const row = view.lines.findIndex((line) => line.includes('[ q quit ]'))
    assert.ok(row > 0, 'the buttons are still drawn on a short terminal')
    const x = view.lines[row].indexOf('[ q quit ]') + 3
    assert.deepEqual(dashboard.hitTest(view.layout, x, row), { action: 'quit' })
  })
})

test('mouse input is decoded from the terminal, including the wheel', () => {
  assert.deepEqual(dashboard.mouseEvents('\u001b[<0;10;5M'), [{ x: 9, y: 4, click: true }])
  assert.deepEqual(dashboard.mouseEvents('\u001b[<0;10;5m'), [], 'a release is not a click')
  assert.deepEqual(dashboard.mouseEvents('\u001b[<65;3;4M'), [{ x: 2, y: 3, wheel: 'down' }])
  assert.deepEqual(dashboard.mouseEvents('\u001b[<64;3;4M'), [{ x: 2, y: 3, wheel: 'up' }])
  assert.deepEqual(dashboard.mouseEvents('plain keys'), [])
})

test('collect counts live sessions and reads balances per account', () => {
  withHome((home) => {
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: [account('account-1'), account('account-2')],
      sessions: [
        session('a', 'account-1', { launcherPid: process.pid }),
        session('b', 'account-1', { endedAt: new Date().toISOString() }),
        session('c', 'account-2', { pid: 2147483646, launcherPid: 2147483646 })
      ],
      lastAccountId: 'account-1',
      lastAccountByCwd: {}
    })

    const balances = new Map([
      ['account-1', { ok: true, remaining: 400 }],
      ['account-2', { ok: false, reason: 'no readable token' }]
    ])
    // A live session is a pid that is also still the program it was recorded
    // for; `verify` answers that second half, as it does for a stop.
    const model = dashboard.collect({ balances, now: Date.now(), verify: () => true })

    assert.equal(model.accounts.length, 2)
    assert.equal(model.signedIn, 2)
    assert.equal(model.sessions.length, 2, 'an ended session is not listed')
    assert.equal(model.live, 1)
    assert.equal(model.accounts[0].live, 1)
    assert.equal(model.accounts[1].live, 0)
    assert.equal(model.sessions.find((item) => item.id === 'a').alive, true)
    assert.equal(model.sessions.find((item) => item.id === 'c').alive, false)
    assert.equal(model.accounts[0].credits.remaining, 400)
  })
})

test('render shows accounts, credits colours and the live session', () => {
  withHome((home) => {
    // A failure only stays active while the credentials are older than it, so
    // the timestamp has to be taken after the account's credentials are written.
    const flagged = account('account-2')
    flagged.authFailedAt = new Date(Date.now() + 1000).toISOString()
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: [account('account-1'), flagged],
      sessions: [session('a', 'account-1', { cwd: '/home/me/project', launcherPid: process.pid })],
      lastAccountId: 'account-1',
      lastAccountByCwd: {}
    })

    const balances = new Map([
      ['account-1', { ok: true, remaining: 400 }],
      ['account-2', { ok: true, remaining: 0 }]
    ])
    const model = dashboard.collect({ balances, verify: () => true })
    const width = 100
    const lines = dashboard.render(model, {
      width,
      height: 30,
      color: true,
      focus: 'sessions',
      selected: { sessions: 0, accounts: 0 }
    })

    for (const line of lines) {
      assert.ok(line.replace(ANSI, '').length <= width, `line too wide: ${line}`)
    }

    const text = plain(lines).join('\n')
    assert.match(text, /FREEBUFFS/)
    assert.match(text, /ACCOUNTS {2}2\/2 signed in/)
    assert.match(text, /account-1/)
    assert.match(text, /needs login/)
    assert.match(text, /SESSIONS {2}1 live/)
    assert.match(text, /~\/project|project/)
    assert.match(text, /live/)

    // Green for a healthy balance, red for an empty one.
    assert.ok(lines.some((line) => line.includes('\u001b[32m400')))
    assert.ok(lines.some((line) => line.includes('\u001b[31m0')))
    // The unavailable balance is a dash, never a made-up zero.
    assert.match(text, /—/)
  })
})

test('render without colour emits no escape codes and fits a narrow screen', () => {
  withHome((home) => {
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: [account('account-1')],
      sessions: [session('a', 'account-1')],
      lastAccountId: 'account-1',
      lastAccountByCwd: {}
    })
    const model = dashboard.collect({})
    const lines = dashboard.render(model, { width: 64, height: 20, color: false })
    for (const line of lines) {
      assert.ok(!line.includes('\u001b'), 'no colour when disabled')
      assert.ok(line.length <= 64, `line too wide: ${line}`)
    }
    assert.match(lines.join('\n'), /q quit|↑↓ tab enter x l q/)
  })
})

test('the selected row is marked in the focused pane', () => {
  withHome((home) => {
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: [account('account-1'), account('account-2')],
      // Newest first: the account-2 session is the older one, so it is row 1.
      sessions: [
        session('a', 'account-1'),
        session('b', 'account-2', {
          pid: 2147483646,
          cwd: '/work/other',
          startedAt: new Date(Date.now() - 300000).toISOString()
        })
      ],
      lastAccountId: 'account-1',
      lastAccountByCwd: {}
    })
    const model = dashboard.collect({})

    // Accounts sit one row under the add-account row, so account-2 is 2.
    const accounts = plain(dashboard.render(model, {
      width: 100, height: 30, color: false, focus: 'accounts', selected: { accounts: 2, sessions: 0 }
    }))
    const second = accounts.find((line) => line.includes('account-2'))
    assert.match(second, /^ ▸ ● account-2/)

    const sessions = plain(dashboard.render(model, {
      width: 100, height: 30, color: false, focus: 'sessions', selected: { accounts: 0, sessions: 2 }
    }))
    const lost = sessions.find((line) => line.includes('/work/other'))
    assert.match(lost, /^ ▸ .*account-2/)
    assert.match(lost, /lost/)
  })
})

test('launchPlan opens a terminal window on Linux, a console on Windows', () => {
  const envDir = fakeTerminal(tempDir())
  const env = { PATH: envDir, DISPLAY: ':0', TERMINAL: 'xterm' }

  const plan = dashboard.launchPlan({
    args: ['--account', 'account-2'],
    cwd: '/work',
    env,
    platform: 'linux',
    execPath: '/usr/bin/node'
  })
  assert.equal(plan.command, path.join(envDir, 'xterm'))
  assert.deepEqual(plan.args, ['-e', '/usr/bin/node', path.join(ROOT, 'bin', 'sfreebuff.js'), '--account', 'account-2'])
  assert.equal(plan.options.detached, true)
  assert.equal(plan.options.cwd, '/work')

  assert.equal(
    dashboard.launchPlan({ args: [], cwd: '/work', env: { PATH: envDir }, platform: 'linux', execPath: 'node' }),
    null,
    'no display means no window'
  )

  const win = dashboard.launchPlan({
    args: ['--account', 'account-2'],
    cwd: 'C:\\work',
    env: {},
    platform: 'win32',
    execPath: 'C:\\node.exe'
  })
  assert.equal(win.command, 'C:\\node.exe')
  assert.equal(win.args[0], path.join(ROOT, 'bin', 'sfreebuff.js'))
  assert.equal(win.options.detached, true)
})

test('startSession and loginAccount spawn a detached window per account', () => {
  const envDir = fakeTerminal(tempDir())
  const env = { PATH: envDir, DISPLAY: ':0', TERMINAL: 'xterm' }
  const spawned = []
  const spawnFn = (command, args, options) => {
    spawned.push({ command, args, options })
    return { pid: 4242, unref () {} }
  }

  const started = dashboard.startSession({
    account: { id: 'account-3' }, cwd: '/work', env, platform: 'linux', spawnFn
  })
  assert.equal(started.ok, true)
  assert.equal(started.pid, 4242)
  assert.equal(started.window, true)
  assert.deepEqual(spawned[0].args.slice(-7), [
    '--account', 'account-3', '--cwd', '/work', '--no-monitor', '--no-sudo', '--fresh'
  ])
  assert.equal(spawned[0].options.detached, true)

  const login = dashboard.loginAccount({
    account: { id: 'account-3' }, cwd: '/work', env, platform: 'linux', spawnFn
  })
  assert.equal(login.ok, true)
  assert.deepEqual(spawned[1].args.slice(-3), ['login', '--account', 'account-3'])

  // Adding an account creates a container and signs it in, so it works from a
  // dashboard that has no spare container waiting.
  const added = dashboard.addAccount({
    cwd: '/work', env, platform: 'linux', spawnFn
  })
  assert.equal(added.ok, true)
  assert.deepEqual(spawned[2].args.slice(-2), ['login', '--new'])

  // No display: there is no window to open, but the session still has to be
  // startable from the dashboard and the phone on a headless machine.
  const headless = dashboard.startSession({
    account: { id: 'account-3' }, cwd: '/work', env: { PATH: envDir }, platform: 'linux', spawnFn
  })
  assert.equal(headless.ok, true)
  assert.equal(headless.window, false, 'it runs in the background instead')
  assert.equal(spawned[3].command, process.execPath)
  assert.deepEqual(spawned[3].args.slice(-7), [
    '--account', 'account-3', '--cwd', '/work', '--no-monitor', '--no-sudo', '--fresh'
  ])
  assert.equal(spawned[3].options.detached, true)
  assert.equal(spawned[3].options.stdio, 'ignore')

  assert.equal(dashboard.startSession({}).ok, false)

  const broken = dashboard.startSession({
    account: { id: 'account-3' },
    cwd: '/work',
    env,
    platform: 'linux',
    spawnFn: () => { throw new Error('spawn failed') }
  })
  assert.equal(broken.ok, false)
  assert.match(broken.reason, /spawn failed/)
})

test('stopSession retires one supervisor and leaves the others running', () => {
  withHome((home) => {
    const killed = []
    const result = dashboard.stopSession(
      { pid: 2002, launcherPid: process.pid, alive: true },
      { kill: (pid, signal) => killed.push([pid, signal]), verify: () => true }
    )

    assert.equal(result.ok, true)
    assert.deepEqual(killed, [[2002, 'SIGTERM']])
    assert.equal(result.stopFile, stopFilePath(process.pid))
    assert.ok(fs.existsSync(stopFilePath(process.pid)))
    assert.equal(home, process.env.FREEBUFFS_HOME)

    assert.equal(dashboard.stopSession({ alive: false }).ok, false)
    assert.equal(dashboard.stopSession(null).ok, false)
  })
})

test('stopping a session never signals a pid that is not that session', () => {
  withHome(() => {
    const killed = []
    // A stale record from before a reboot: the numbers now belong to whatever
    // the kernel handed them to, here this very process. Signalling them killed
    // the desktop shell or another supervisor mid-task.
    const result = dashboard.stopSession(
      { pid: process.pid, launcherPid: process.pid, alive: true },
      { kill: (pid, signal) => killed.push([pid, signal]) }
    )

    assert.equal(result.ok, false)
    assert.deepEqual(killed, [], 'an unrelated process is left running')
    assert.equal(fs.existsSync(stopFilePath(process.pid)), false, 'no stop file for a dead launcher')
  })
})

test('sfreebuff dashboard prints a snapshot when output is not a terminal', () => {
  const world = makeWorld({ signedIn: true })
  try {
    const result = world.run(['dashboard'], { FREEBUFFS_CREDITS: '0' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /FREEBUFFS {2}supervisor dashboard/)
    assert.match(result.stdout, /ACCOUNTS {2}1\/1 signed in/)
    assert.match(result.stdout, /account-1/)
    assert.match(result.stdout, /SESSIONS {2}0 live/)
  } finally {
    world.cleanup()
  }
})

test('typing just sfreebuff opens the dashboard', () => {
  // The command on its own is the view over every account and session; a
  // session is started from there (enter) or with `sfreebuff run`.
  const world = makeWorld({ signedIn: true })
  try {
    const result = world.run([], { FREEBUFFS_CREDITS: '0' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /FREEBUFFS {2}supervisor dashboard/)
    assert.match(result.stdout, /ACCOUNTS {2}1\/1 signed in/)
    assert.equal(world.invocations().length, 0, 'no freebuff session is started by the view')
  } finally {
    world.cleanup()
  }
})

test('a stopped session ends its supervisor instead of being restarted', async () => {
  const world = makeWorld({ signedIn: true, delay: 700 })
  try {
    const child = spawn(process.execPath, [BIN, '--forever'], {
      env: world.env,
      stdio: 'ignore'
    })
    try {
      const stateFile = path.join(world.home, 'state.json')
      assert.ok(
        await waitFor(
          () => fs.existsSync(stateFile) && world.state().sessions.some((item) => !item.endedAt),
          8000
        ),
        'session should start'
      )

      const live = world.state().sessions.find((item) => !item.endedAt)
      // The stop file is written where this process's home points, exactly as
      // it would be when the dashboard runs beside the supervisors.
      const previousHome = process.env.FREEBUFFS_HOME
      process.env.FREEBUFFS_HOME = world.home
      let result
      try {
        result = dashboard.stopSession({
          pid: live.pid,
          launcherPid: child.pid,
          alive: true
        })
      } finally {
        if (previousHome === undefined) delete process.env.FREEBUFFS_HOME
        else process.env.FREEBUFFS_HOME = previousHome
      }
      assert.equal(result.ok, true)

      assert.ok(
        await waitFor(() => world.events().some((event) => event.event === 'supervisor.stop_requested'), 8000),
        'the supervisor should stop itself'
      )
      assert.ok(
        await waitFor(() => world.state().sessions.every((item) => item.endedAt), 8000),
        'the session should be finalized'
      )
    } finally {
      child.kill('SIGTERM')
    }
  } finally {
    world.cleanup()
  }
})

test('a pid that now belongs to another process is not a live session', () => {
  withHome((home) => {
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: [account('account-1')],
      // Both numbers are this test process: alive, but neither is freebuff nor a
      // supervisor. This is the record a long uptime leaves behind.
      sessions: [session('ghost', 'account-1', {
        pid: process.pid,
        launcherPid: process.pid
      })],
      lastAccountId: 'account-1',
      lastAccountByCwd: {}
    })

    const model = dashboard.collect({})
    assert.equal(model.live, 0, 'a reused pid is not a live session')
    assert.equal(model.sessions.length, 1, 'the record is still listed, as lost')
    assert.equal(model.sessions[0].alive, false)
    assert.equal(model.accounts[0].live, 0, 'and it does not count against the account')
  })
})

test('stop clears a record whose session is gone', () => {
  withHome((home) => {
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: [account('account-1')],
      sessions: [session('ghost', 'account-1', { pid: 2147483646, launcherPid: 2147483646 })],
      lastAccountId: 'account-1',
      lastAccountByCwd: {}
    })

    const row = dashboard.collect({}).sessions[0]
    assert.equal(row.alive, false)

    const result = dashboard.stopSession(row)
    assert.equal(result.ok, true, 'the key acts instead of refusing forever')
    assert.equal(result.retired, true)
    assert.equal(dashboard.collect({}).sessions.length, 0, 'the phantom row is gone')

    const record = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'))
      .sessions.find((item) => item.id === 'ghost')
    assert.ok(record.endedAt, 'the record is ended, not a live session any more')
  })
})

test('a second supervisor keeps its own stop file', () => {
  withHome(() => {
    const first = dashboard.stopSession(
      { pid: 1, launcherPid: process.pid, alive: true },
      { kill: () => {}, verify: () => true }
    )
    assert.notEqual(first.stopFile, stopFilePath(999999))
    assert.equal(fs.existsSync(stopFilePath(999999)), false)
    // Its own stop file clears when the supervisor retires.
    clearStopRequest(process.pid)
    assert.equal(fs.existsSync(stopFilePath(process.pid)), false)
  })
})

test('the dashboard command is in help', () => {
  const result = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /sfreebuff dashboard/)
})

test('the start button reads continue over an existing session', () => {
  withHome((home) => {
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: [account('account-1')],
      sessions: [session('old', 'account-1', { pid: 2147483646, launcherPid: 2147483646 })],
      lastAccountId: 'account-1',
      lastAccountByCwd: {}
    })
    const model = dashboard.collect({})

    const onNew = plain(dashboard.render(model, {
      width: 100, height: 30, color: false, focus: 'sessions', selected: { sessions: 0, accounts: 0 }
    })).join('\n')
    assert.match(onNew, /\[ enter start \]/)

    // Cursor on the session row: enter continues that conversation, so the
    // button says so instead of promising a start.
    const onOld = plain(dashboard.render(model, {
      width: 100, height: 30, color: false, focus: 'sessions', selected: { sessions: 1, accounts: 0 }
    })).join('\n')
    assert.match(onOld, /\[ enter continue \]/)
    assert.doesNotMatch(onOld, /\[ enter start \]/)
  })
})

test('continuing a session passes --continue, a new one --fresh', () => {
  const spawned = []
  const spawnFn = (command, args, options) => {
    spawned.push({ command, args, options })
    return { pid: 7, unref () {} }
  }
  const base = { account: { id: 'account-2' }, cwd: '/work', env: { PATH: '/nonexistent' }, platform: 'linux', spawnFn }

  assert.equal(dashboard.startSession({ ...base, resume: true }).ok, true)
  assert.equal(spawned[0].args[spawned[0].args.length - 1], '--continue')

  assert.equal(dashboard.startSession({ ...base }).ok, true)
  assert.equal(spawned[1].args[spawned[1].args.length - 1], '--fresh')
})

test('the sessions pane starts on a new session, not on an old one', () => {
  withHome((home) => {
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: [account('account-1'), account('account-2')],
      sessions: [
        session('old', 'account-1', {
          pid: 2147483646,
          endedAt: new Date().toISOString()
        })
      ],
      lastAccountId: 'account-1',
      lastAccountByCwd: {}
    })
    const model = dashboard.collect({})
    const view = dashboard.buildView(model, {
      width: 100,
      height: 30,
      color: false,
      focus: 'sessions',
      // The default cursor position: the row that starts something new.
      selected: { accounts: 2, sessions: 0 }
    })
    const lines = plain(view.lines)
    const newRow = lines.findIndex((line) => line.includes('new session'))
    assert.ok(newRow > 0, 'a new session has a row of its own')
    assert.match(lines[newRow], /^ ▸ /, 'and the cursor starts there')
    assert.match(lines[newRow], /account-2/, 'on the account the accounts pane highlights')
    assert.deepEqual(dashboard.hitTest(view.layout, 8, newRow), {
      action: 'choose-session',
      index: 0
    })
  })
})

test('a button that can act is bright, and only a dead one is grey', () => {
  withHome((home) => {
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: [account('account-1')],
      // Nothing has been started: stop has no row to act on, so only it is grey.
      sessions: [],
      lastAccountId: 'account-1',
      lastAccountByCwd: {}
    })
    const model = dashboard.collect({})
    const view = dashboard.buildView(model, { width: 100, height: 30, color: true })
    const row = view.lines.find((line) => line.includes('[ n new session ]'))
    assert.ok(row, 'the action row is drawn')
    assert.match(row, /\u001b\[1;38;5;16;48;5;45m\[ enter start \]/, 'start is bright')
    assert.match(row, /\u001b\[1;38;5;16;48;5;45m\[ n new session \]/, 'new is bright')
    assert.match(row, /\u001b\[2;38;5;240m\[ x stop \]/, 'stop is grey while nothing is live')
    assert.doesNotMatch(row, /\u001b\[2;38;5;240m\[ enter start \]/, 'start never reads as disabled')
  })
})

test('with nobody signed in the new-session row says what to do instead', () => {
  withHome((home) => {
    const unsigned = account('account-1')
    fs.rmSync(path.join(unsigned.configDir, 'credentials.json'))
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: [unsigned],
      sessions: [],
      lastAccountId: 'account-1',
      lastAccountByCwd: {}
    })
    const model = dashboard.collect({})
    const view = dashboard.buildView(model, { width: 100, height: 30, color: true })
    const lines = plain(view.lines)
    assert.match(lines.join('\n'), /no signed-in account — press l to sign in/)
    const row = view.lines.find((line) => line.includes('l login'))
    assert.match(row, /\u001b\[2;38;5;240m\[ enter start \]/, 'start is grey when it cannot act')
    assert.match(row, /\u001b\[1;38;5;16;48;5;45m\[ l login \]/, 'signing in stays available')
  })
})

test('settings is a button and a key', () => {
  withHome((home) => {
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: [account('account-1')],
      sessions: [],
      lastAccountId: 'account-1',
      lastAccountByCwd: {}
    })
    const model = dashboard.collect({})
    const view = dashboard.buildView(model, { width: 100, height: 30, color: false })
    const row = view.lines.findIndex((line) => line.includes('[ s settings ]'))
    assert.ok(row > 0, 'settings has a button like every other action')
    const x = view.lines[row].indexOf('[ s settings ]') + 3
    assert.deepEqual(dashboard.hitTest(view.layout, x, row), { action: 'settings' })

    assert.deepEqual(dashboard.keyActions('s'), ['settings'])
    assert.deepEqual(dashboard.keyActions(' '), ['activate'])
    assert.deepEqual(dashboard.keyActions('\u001b'), ['back'])
  })
})

test('the settings screen shows the voice toggle and is clickable', () => {
  withHome((home) => {
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: [account('account-1')],
      sessions: [],
      lastAccountId: 'account-1',
      lastAccountByCwd: {}
    })
    const model = dashboard.collect({})
    model.voice = {
      enabled: true,
      running: true,
      url: 'https://runner.tailnet.ts.net/call/secret',
      ntfy: true,
      model: 'qwen2.5:3b'
    }
    const view = dashboard.buildView(model, {
      width: 100,
      height: 30,
      color: false,
      screen: 'settings',
      selected: { settings: 0 }
    })

    const text = view.lines.join('\n')
    assert.match(text, /FREEBUFFS {2}settings/)
    assert.match(text, /Voice calls/)
    assert.match(text, /voice calls ON/)
    assert.match(text, /tailnet\.ts\.net\/call\//)
    assert.match(text, /qwen2\.5:3b/)
    assert.match(text, /ntfy app configured/)

    // The row itself is the switch, and so is the button.
    assert.deepEqual(
      dashboard.hitTest(view.layout, 8, view.layout.settings[0].y),
      { action: 'toggle-voice' }
    )
    const row = view.lines.findIndex((line) => line.includes('[ space turn off ]'))
    assert.ok(row > 0)
    const x = view.lines[row].indexOf('[ space turn off ]') + 3
    assert.deepEqual(dashboard.hitTest(view.layout, x, row), { action: 'toggle-voice' })

    const off = dashboard.buildView(
      { ...model, voice: { ...model.voice, enabled: false, running: false, url: '' } },
      { width: 100, height: 30, color: false, screen: 'settings' }
    )
    assert.match(off.lines.join('\n'), /voice calls off/)
    assert.match(off.lines.join('\n'), /turn voice calls on to get a call link/)
  })
})

test('the settings screen has a low CPU switch that is off by default', () => {
  withHome((home) => {
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: [account('account-1')],
      sessions: [],
      lastAccountId: 'account-1',
      lastAccountByCwd: {}
    })
    const model = dashboard.collect({})
    assert.equal(model.optimize.enabled, false, 'optimization defaults to off')

    const view = dashboard.buildView(model, {
      width: 100,
      height: 30,
      color: false,
      screen: 'settings',
      selected: { settings: 1 }
    })
    const text = view.lines.join('\n')
    assert.match(text, /Optimization/)
    assert.match(text, /optimization off/)
    assert.match(text, /off — sessions run at normal priority/)

    // The row is the switch, and the footer button acts on the selected row.
    const optimizeRow = view.layout.settings.find((item) => item.index === 1)
    assert.ok(optimizeRow, 'the optimization row is clickable')
    assert.deepEqual(
      dashboard.hitTest(view.layout, 8, optimizeRow.y),
      { action: 'toggle-optimize' }
    )
    const buttonRow = view.lines.findIndex((line) => line.includes('[ space turn on ]'))
    assert.ok(buttonRow > 0)
    const x = view.lines[buttonRow].indexOf('[ space turn on ]') + 3
    assert.deepEqual(dashboard.hitTest(view.layout, x, buttonRow), { action: 'toggle-optimize' })

    const on = dashboard.buildView(
      { ...model, optimize: { enabled: true } },
      { width: 100, height: 30, color: false, screen: 'settings', selected: { settings: 1 } }
    )
    assert.match(on.lines.join('\n'), /optimization ON/)
    assert.match(on.lines.join('\n'), /sessions start at nice 10/)
  })
})

test('the optimization switch is stored as off unless it is on', () => {
  withHome((home) => {
    const optimize = require('../src/optimize')
    assert.equal(optimize.enabled(), false)
    optimize.setEnabled(true)
    assert.equal(optimize.enabled(), true)
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).optimize,
      true
    )
    optimize.setEnabled(false)
    assert.equal(optimize.enabled(), false)
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).optimize,
      undefined
    )
  })
})

test('the settings screen keeps both switches and its buttons on a short terminal', () => {
  withHome((home) => {
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: [account('account-1')],
      sessions: [],
      lastAccountId: 'account-1',
      lastAccountByCwd: {}
    })
    const model = dashboard.collect({})
    const view = dashboard.buildView(model, {
      width: 60,
      height: 12,
      color: false,
      screen: 'settings',
      selected: { settings: 0 }
    })
    const text = view.lines.join('\n')
    // Both switches stay visible, and the only way back is not dropped.
    assert.match(text, /Voice calls/)
    assert.match(text, /Optimization/)
    assert.match(text, /\[ esc back \]/)
    assert.match(text, /\[ q quit \]/)
    assert.ok(view.lines.length <= 12)
    assert.equal(view.layout.buttons.length, 3)
    for (const line of view.lines) assert.ok(line.length <= 60, 'no row is wider than the terminal')
  })
})

test('an account waiting out its free sessions is marked as limited', () => {
  withHome((home) => {
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: [
        account('account-1', {
          cooldownUntil: new Date(Date.now() + 3600_000).toISOString(),
          cooldownReason: 'free sessions used up'
        })
      ],
      sessions: [],
      lastAccountId: 'account-1',
      lastAccountByCwd: {}
    })
    const model = dashboard.collect({})
    assert.equal(model.accounts[0].cooling, true)
    const text = plain(dashboard.render(model, { width: 100, height: 30, color: false })).join('\n')
    assert.match(text, /limit/)
  })
})

test('a session whose record lost its folder still shows the path it ran in', () => {
  withHome((home) => {
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: [account('account-1')],
      sessions: [
        {
          id: 'from-args',
          accountId: 'account-1',
          pid: null,
          launcherPid: null,
          args: ['--cwd', '/work/from-args'],
          startedAt: new Date().toISOString()
        },
        {
          id: 'from-account',
          accountId: 'account-1',
          pid: null,
          launcherPid: null,
          args: [],
          startedAt: new Date(Date.now() - 1000).toISOString()
        }
      ],
      lastAccountId: 'account-1',
      lastAccountByCwd: { '/work/from-account': 'account-1' }
    })
    const model = dashboard.collect({})
    assert.equal(model.sessions.length, 2)
    const text = plain(dashboard.render(model, { width: 100, height: 30, color: false })).join('\n')
    // The folder is in the session's own arguments, or failing that the folder
    // the account was last used in. A blank cell was the bug.
    assert.match(text, /\/work\/from-args/)
    assert.match(text, /\/work\/from-account/)
  })
})

test('the settings screen has force continue and shutdown timer switches', () => {
  withHome((home) => {
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: [account('account-1')],
      sessions: [],
      lastAccountId: 'account-1',
      lastAccountByCwd: {}
    })
    const model = dashboard.collect({})
    assert.equal(model.forceContinue.enabled, false, 'force continue defaults to off')
    assert.equal(model.shutdownTimer.enabled, false, 'the shutdown timer defaults to off')

    const view = dashboard.buildView(model, {
      width: 100,
      height: 30,
      color: false,
      screen: 'settings',
      selected: { settings: 2 }
    })
    const text = view.lines.join('\n')
    assert.match(text, /Force continue/)
    assert.match(text, /force continue off/)
    assert.match(text, /Shutdown timer/)
    assert.match(text, /shutdown timer off/)

    const forceRow = view.layout.settings.find((item) => item.index === 2)
    const shutdownRow = view.layout.settings.find((item) => item.index === 3)
    assert.ok(forceRow, 'the force continue row is clickable')
    assert.ok(shutdownRow, 'the shutdown timer row is clickable')
    assert.deepEqual(dashboard.hitTest(view.layout, 8, forceRow.y), { action: 'toggle-force' })
    assert.deepEqual(dashboard.hitTest(view.layout, 8, shutdownRow.y), { action: 'toggle-shutdown' })

    // The selected force continue row also offers the prompt editor.
    const edit = view.layout.buttons.find((item) => item.action === 'edit-prompt')
    assert.ok(edit, 'the prompt editor is a clickable button')
    assert.ok(dashboard.keyActions('e').includes('edit-prompt'))
  })
})

test('a custom force continue prompt is shown, stored, and reset', () => {
  withHome((home) => {
    seed(home, {
      version: 1,
      createdAt: new Date().toISOString(),
      accounts: [account('account-1')],
      sessions: [],
      lastAccountId: 'account-1',
      lastAccountByCwd: {}
    })
    const overnight = require('../src/overnight')
    overnight.setForceContinue(true)
    overnight.setForceContinuePrompt('Carry on with the remaining phases.')

    const model = dashboard.collect({})
    assert.equal(model.forceContinue.enabled, true)
    assert.equal(model.forceContinue.custom, 'Carry on with the remaining phases.')
    assert.match(model.forceContinue.prompt, /FREEBUFFS ALL TASKS COMPLETE/)

    const view = dashboard.buildView(model, {
      width: 100,
      height: 30,
      color: false,
      screen: 'settings',
      selected: { settings: 2 }
    })
    assert.match(view.lines.join('\n'), /custom — "Carry on with the remaining phases\."/)

    const editing = dashboard.buildView(model, {
      width: 100,
      height: 30,
      color: false,
      screen: 'settings',
      selected: { settings: 2 },
      promptEdit: 'Carry on'
    })
    assert.match(editing.lines.join('\n'), /prompt Carry on▌/)
    assert.match(editing.lines.join('\n'), /enter saves · esc cancels/)

    overnight.setForceContinuePrompt('')
    assert.equal(dashboard.collect({}).forceContinue.custom, '')
  })
})
