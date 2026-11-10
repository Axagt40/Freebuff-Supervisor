'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { makeWorld, removeTree } = require('./helpers')

const handoff = require('../src/handoff')

const dirs = []
test.after(() => {
  for (const dir of dirs) removeTree(dir)
})

function tempDir () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuffs-handoff-'))
  dirs.push(dir)
  return dir
}

/** A project chat directory as freebuff writes it. */
function writeChat (configDir, cwd, id, messages, mtimeMs) {
  const dir = path.join(handoff.projectChatsDir(configDir, cwd), id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'chat-messages.json'), JSON.stringify(messages))
  fs.writeFileSync(path.join(dir, 'run-state.json'), '{"sessionState":{}}')
  if (mtimeMs) setChatTimes(dir, mtimeMs)
  return dir
}

/** Backdate a whole chat: the directory and the files it writes as it works. */
function setChatTimes (dir, mtimeMs) {
  const when = new Date(mtimeMs)
  fs.utimesSync(dir, when, when)
  for (const name of handoff.ACTIVITY_FILES) {
    try {
      fs.utimesSync(path.join(dir, name), when, when)
    } catch {
      // A chat that has not written this file yet.
    }
  }
}

test('the conversation to hand over is the most recently written chat', () => {
  const config = tempDir()
  const cwd = path.join(tempDir(), 'project')

  writeChat(config, cwd, '2026-10-27T10-00-00.000Z', [{ content: 'old' }], 1_000_000)
  writeChat(config, cwd, '2026-10-27T20-00-00.000Z', [{ content: 'new' }], 2_000_000)

  const latest = handoff.latestChat(config, cwd)
  assert.equal(latest.id, '2026-10-27T20-00-00.000Z')
})

test('a resumed older chat is handed over, not the newest folder', () => {
  const config = tempDir()
  const cwd = path.join(tempDir(), 'project')

  // The older conversation was created first and continued later, so its files
  // are the newest while its directory still carries the creation time. Picking
  // by directory time copied the abandoned chat instead of the work in progress.
  writeChat(config, cwd, 'old', [{ content: 'the work in progress' }], 1_000_000)
  writeChat(config, cwd, 'created-later', [{ content: 'abandoned' }], 2_000_000)
  const resumed = path.join(handoff.projectChatsDir(config, cwd), 'old', 'chat-messages.json')
  fs.utimesSync(resumed, new Date(3_000_000), new Date(3_000_000))

  assert.equal(handoff.latestChat(config, cwd).id, 'old')
})

test('an empty or missing project has nothing to hand over', () => {
  const config = tempDir()
  const cwd = path.join(tempDir(), 'project')

  assert.equal(handoff.latestChat(config, cwd), null, 'missing project dir')
  assert.equal(handoff.latestChat(config, null), null, 'no cwd')
  assert.equal(handoff.latestChat(null, cwd), null, 'no config dir')

  // A chat without messages is not a conversation freebuff would resume.
  fs.mkdirSync(path.join(handoff.projectChatsDir(config, cwd), 'empty'), { recursive: true })
  assert.equal(handoff.latestChat(config, cwd), null)
})

test('the folder conversation is found when freebuff keyed the project by its path', () => {
  // freebuff can key a project by the whole path instead of the base name. The
  // chat was then missed, and the fallback resumed whatever lived under
  // `projects/<base name>` — a conversation freebuff cannot resolve in this
  // folder, which it answers with its project picker instead of the chat.
  const config = tempDir()
  const cwd = path.join(tempDir(), 'app')

  const sameName = path.join(config, 'projects', 'app', 'chats', 'other-folder')
  fs.mkdirSync(sameName, { recursive: true })
  fs.writeFileSync(path.join(sameName, 'chat-messages.json'), '[]')
  fs.writeFileSync(
    path.join(sameName, 'run-state.json'),
    JSON.stringify({ sessionState: { cwd: path.join('/elsewhere', 'app') } })
  )

  const keyed = path.join(config, 'projects', 'home-user-app', 'chats', 'mine')
  fs.mkdirSync(keyed, { recursive: true })
  fs.writeFileSync(path.join(keyed, 'chat-messages.json'), '[]')
  fs.writeFileSync(
    path.join(keyed, 'run-state.json'),
    JSON.stringify({ sessionState: { cwd } })
  )

  assert.equal(handoff.latestChat(config, cwd).id, 'mine')
})

test('copying puts the conversation in the other account under a fresh id', () => {
  const from = tempDir()
  const to = tempDir()
  const cwd = path.join(tempDir(), 'project')

  const source = writeChat(from, cwd, '2026-10-27T20-00-00.000Z', [
    { variant: 'user', content: 'finish the flux capacitor' }
  ])

  const copied = handoff.copyConversation({ fromConfigDir: from, toConfigDir: to, cwd })
  assert.ok(copied, 'the chat should have been copied')
  assert.notEqual(copied.id, '2026-10-27T20-00-00.000Z', 'a fresh id avoids overwriting')
  assert.ok(fs.existsSync(path.join(copied.to, 'chat-messages.json')))
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(copied.to, 'chat-messages.json'), 'utf8')),
    [{ variant: 'user', content: 'finish the flux capacitor' }]
  )
  assert.ok(fs.existsSync(source), 'the original chat is left in place')

  // The new account now sees exactly the copied conversation as its latest.
  assert.equal(handoff.latestChat(to, cwd).id, copied.id)
})

test('copying is a no-op without a source or when the account is the same', () => {
  const config = tempDir()
  const cwd = path.join(tempDir(), 'project')
  assert.equal(
    handoff.copyConversation({ fromConfigDir: config, toConfigDir: tempDir(), cwd }),
    null,
    'nothing was ever written'
  )

  writeChat(config, cwd, 'chat', [{ content: 'x' }])
  assert.equal(
    handoff.copyConversation({ fromConfigDir: config, toConfigDir: config, cwd }),
    null,
    'the same account needs no handoff'
  )
})

test('the relaunch points --continue at the handed-over chat', () => {
  assert.deepEqual(
    handoff.continueWithChat(['--continue', '--cwd', '.'], 'chat-1'),
    ['--continue', 'chat-1', '--cwd', '.']
  )
  // A bare flag or an old id must not survive next to the new one.
  assert.deepEqual(
    handoff.continueWithChat(['--continue', 'old-chat', '--cwd', '.'], 'chat-1'),
    ['--continue', 'chat-1', '--cwd', '.']
  )
  assert.deepEqual(
    handoff.continueWithChat(['--continue=old-chat', 'x'], 'chat-1'),
    ['--continue', 'chat-1', 'x']
  )
})

/**
 * A fake TUI that reports the auth failure that retires its account, records
 * whether it got a terminal and what was typed at it, then exits non-zero so
 * the supervisor restarts with the next account.
 */
function writeTui (file) {
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
'use strict'
const fs = require('fs')
const log = (entry) => fs.appendFileSync(process.env.RECORD, JSON.stringify(entry) + '\\n')
log({ event: 'start', isTTY: Boolean(process.stdin.isTTY), argv: process.argv.slice(2) })
process.stderr.write('Error: 401 Unauthorized — authentication failed\\n')
process.stdout.write('Enter a coding task or / for commands\\n')
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => log({ event: 'input', chunk }))
setTimeout(() => process.exit(1), 3000)
`
  )
  fs.chmodSync(file, 0o755)
  return file
}

function readRecords (file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test('an account switch continues the task even with --no-pty', () => {
  const world = makeWorld()
  const cwdName = path.basename(process.cwd())
  const chatId = '2026-10-27T20-17-26.579Z'
  const record = path.join(world.root, 'tui-record.jsonl')
  const tui = writeTui(path.join(world.root, 'fake-tui.js'))
  try {
    assert.equal(world.run(['login']).status, 0)
    const first = world.state().accounts[0]
    const second = world.state().accounts[1]

    // The first account's conversation and the task the user typed in it.
    writeChat(first.configDir, process.cwd(), chatId, [
      { id: 'user-1', variant: 'user', content: 'fix the flux capacitor shutdown bug' }
    ])
    fs.writeFileSync(
      path.join(first.configDir, 'message-history.json'),
      JSON.stringify(['fix the flux capacitor shutdown bug', 'continue where you left off'])
    )

    const result = world.run(['run'], {
      FREEBUFFS_BINARY: tui,
      FREEBUFFS_PTY: '0',
      FREEBUFFS_FOREVER: '1',
      FREEBUFFS_RESTART_MS: '50',
      FREEBUFFS_RESUME_MS: '200',
      FREEBUFFS_MAX_FAST_FAILURES: '2',
      RECORD: record
    })
    assert.equal(result.status, 1, result.stderr)

    const starts = readRecords(record).filter((item) => item.event === 'start')
    assert.equal(starts.length, 2, 'both attempts should have reached the TUI')
    assert.equal(starts[0].isTTY, false, 'the first session keeps the real terminal')
    // A plain launch continues the folder's conversation, even with --no-pty.
    assert.deepEqual(starts[0].argv, ['--continue', chatId, '--cwd', process.cwd()])

    // The switched account gets a pty even though --no-pty was asked for, so
    // the task can actually be pushed forward, and it resumes the chat.
    assert.equal(starts[1].isTTY, true, 'the switched session needs typing')
    assert.equal(starts[1].argv[0], '--continue')
    assert.ok(starts[1].argv[1], 'the handed-over chat id should follow --continue')

    assert.ok(
      fs.existsSync(path.join(
        second.configDir, 'projects', cwdName, 'chats', starts[1].argv[1], 'chat-messages.json'
      )),
      'the conversation should have been copied into the switched account'
    )

    const typed = readRecords(record)
      .filter((item) => item.event === 'input')
      .map((item) => item.chunk)
      .join('')
    assert.match(typed, /Continue the unfinished task/)
    assert.match(typed, /fix the flux capacitor shutdown bug/)

    const events = world.events().map((event) => event.event)
    assert.ok(events.includes('session.handoff'))
    assert.ok(events.includes('session.continue_pty'))
    assert.ok(events.includes('session.resume'))
  } finally {
    world.cleanup()
  }
})

test('a plain launch continues the folder conversation from where it stopped', () => {
  // This is the case the supervisor kept getting wrong: opening a session in a
  // folder it has worked in before must carry on with that work, not sit at a
  // new empty chat waiting for somebody to type the task again. The chat is
  // resumed, so the task is already in it and is not restated.
  const world = makeWorld()
  const record = path.join(world.root, 'tui-record.jsonl')
  const tui = writeTui(path.join(world.root, 'fake-tui.js'))
  const chatId = '2026-10-27T20-17-26.579Z'
  try {
    assert.equal(world.run(['login']).status, 0)
    const account = world.state().accounts[0]
    writeChat(account.configDir, process.cwd(), chatId, [
      { id: 'user-1', variant: 'user', content: 'fix the flux capacitor shutdown bug' }
    ])
    fs.writeFileSync(
      path.join(account.configDir, 'message-history.json'),
      JSON.stringify(['fix the flux capacitor shutdown bug'])
    )

    const result = world.run(['run'], {
      FREEBUFFS_BINARY: tui,
      FREEBUFFS_PTY: '1',
      FREEBUFFS_RESUME_MS: '200',
      RECORD: record
    })
    assert.equal(result.status, 1, result.stderr)

    const starts = readRecords(record).filter((item) => item.event === 'start')
    assert.equal(starts.length, 1)
    assert.deepEqual(starts[0].argv, ['--continue', chatId, '--cwd', process.cwd()])

    const typed = readRecords(record)
      .filter((item) => item.event === 'input')
      .map((item) => item.chunk)
      .join('')
    assert.match(typed, /Continue from where you left off/)
    assert.doesNotMatch(
      typed,
      /fix the flux capacitor shutdown bug/,
      'the resumed chat already holds the task, so it is not explained again'
    )

    const events = world.events()
    const start = events.find((event) => event.event === 'session.start')
    assert.equal(start.resumedChat, chatId)
    assert.equal(start.resume, true)
    assert.ok(events.some((event) => event.event === 'session.resume'))
  } finally {
    world.cleanup()
  }
})

test('--no-pty sessions that stay on their account never get a pty', () => {
  const world = makeWorld()
  const record = path.join(world.root, 'tui-record.jsonl')
  const tui = writeTui(path.join(world.root, 'fake-tui.js'))
  try {
    const result = world.run(['--account', '1', '--no-monitor'], {
      FREEBUFFS_BINARY: tui,
      FREEBUFFS_PTY: '0',
      FREEBUFFS_FOREVER: '1',
      FREEBUFFS_RESTART_MS: '50',
      FREEBUFFS_MAX_FAST_FAILURES: '2',
      RECORD: record
    })
    assert.equal(result.status, 1, result.stderr)

    // Two failed starts, then the same two on a fresh conversation, which is
    // the supervisor's last automatic fix before it gives up for a person.
    const starts = readRecords(record).filter((item) => item.event === 'start')
    assert.equal(starts.length, 4)
    for (const start of starts) {
      assert.equal(start.isTTY, false, '--no-pty must stay pty-free without a switch')
    }

    const events = world.events().map((event) => event.event)
    assert.ok(!events.includes('session.continue_pty'))
    assert.ok(!events.includes('session.handoff'))
  } finally {
    world.cleanup()
  }
})

test('an account switched without a pty resumes the previous conversation', () => {
  const world = makeWorld()
  const cwdName = path.basename(process.cwd())
  const chatId = '2026-10-27T20-17-26.579Z'
  try {
    assert.equal(world.run(['login']).status, 0)
    const accounts = world.state().accounts
    const first = accounts[0].configDir
    const second = accounts[1].configDir

    // What the first account was working on, in freebuff's own chat format.
    writeChat(first, process.cwd(), chatId, [
      { id: 'user-1', variant: 'user', content: 'fix the flux capacitor shutdown bug' }
    ])

    const result = world.run(['run'], {
      FREEBUFFS_FOREVER: '1',
      FREEBUFFS_RESTART_MS: '50',
      FREEBUFFS_MAX_FAST_FAILURES: '2',
      STUB_STDERR: 'Error: 401 Unauthorized — authentication failed',
      STUB_EXIT_CODE: '1'
    })
    assert.equal(result.status, 1, result.stderr)

    const invocations = world.invocations()
    assert.equal(invocations.length, 2, 'the failed start should be retried once more')
    assert.equal(invocations[0].configDir, first)
    // The conversation of this folder is resumed rather than a new chat begun.
    assert.deepEqual(invocations[0].argv, ['--continue', chatId, '--cwd', process.cwd()])

    // The switched account is told to continue the copied conversation.
    assert.equal(invocations[1].configDir, second)
    assert.equal(invocations[1].argv[0], '--continue')
    const copiedId = invocations[1].argv[1]
    assert.ok(copiedId, 'the chat id should follow --continue')
    assert.notEqual(copiedId, chatId)

    const copied = path.join(
      second, 'projects', cwdName, 'chats', copiedId, 'chat-messages.json'
    )
    assert.ok(fs.existsSync(copied), 'the conversation should have been handed over')
    assert.match(fs.readFileSync(copied, 'utf8'), /fix the flux capacitor shutdown bug/)
    assert.ok(
      fs.existsSync(path.join(first, 'projects', cwdName, 'chats', chatId)),
      'the original conversation stays in the retired account'
    )

    const event = world.events().find((item) => item.event === 'session.handoff')
    assert.ok(event, 'the handoff should be visible in the log')
    assert.equal(event.fromAccount, 'account-1')
    assert.equal(event.toAccount, 'account-2')
    assert.equal(event.chatId, copiedId)
  } finally {
    world.cleanup()
  }
})

test('a new session starts its own conversation instead of resuming the last', () => {
  const world = makeWorld()
  try {
    writeChat(world.defaultConfig, process.cwd(), 'previous', [
      { role: 'user', content: 'finish the flux capacitor' }
    ])

    // What the dashboard's "new session" asks for.
    assert.equal(world.run(['--fresh'], { STUB_EXIT_CODE: '0' }).status, 0)
    const fresh = world.invocations().pop()
    assert.equal(fresh.argv.includes('--continue'), false, 'it does not resume the old chat')
    assert.equal(fresh.argv.includes('--fresh'), false, 'the flag is ours, not freebuff\'s')

    // A launch in the same folder without it still continues that chat.
    assert.equal(world.run(['run'], { STUB_EXIT_CODE: '0' }).status, 0)
    const resumed = world.invocations().pop()
    assert.equal(resumed.argv.includes('--continue'), true)
  } finally {
    world.cleanup()
  }
})
