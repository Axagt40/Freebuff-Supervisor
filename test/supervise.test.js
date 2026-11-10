'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const supervise = require('../src/supervise')
const answers = require('../src/answers')
const sudo = require('../src/sudo')
const state = require('../src/state')
const accounts = require('../src/accounts')
const { removeTree, writeCredentials } = require('./helpers')

const dirs = []
function tempHome () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuffs-loop-'))
  dirs.push(root)
  process.env.FREEBUFFS_HOME = path.join(root, 'home')
  return process.env.FREEBUFFS_HOME
}

test.after(() => {
  for (const dir of dirs) {
    removeTree(dir)
  }
})

/** A run() that returns a scripted result per attempt. */
function scripted (results) {
  let index = 0
  return async (info) => {
    const next = results[index] || results[results.length - 1]
    index += 1
    return { attempt: info.attempt, ...next }
  }
}

test('a session moves to the account that has been idle longest, never a broken one', () => {
  const home = tempHome()
  const make = (id, extra = {}) => {
    const configDir = path.join(home, id)
    writeCredentials(configDir)
    return {
      id,
      label: id,
      configDir,
      shared: false,
      createdAt: new Date().toISOString(),
      signedInAt: new Date().toISOString(),
      lastUsedAt: null,
      sessions: 0,
      totalMs: 0,
      lastError: null,
      ...extra
    }
  }

  const busy = make('account-1', { lastUsedAt: new Date().toISOString() })
  const idle = make('account-2', { lastUsedAt: new Date(Date.now() - 3600_000).toISOString() })
  const idleLongest = make('account-3', { lastUsedAt: new Date(Date.now() - 7200_000).toISOString() })
  // Idle the longest of all, but it reported an auth failure: moving to it
  // would only repeat the same failure under another number. The timestamp is
  // ahead of the credentials file so the failure is unambiguously still active
  // instead of racing the mtime that clears it.
  const broken = make('account-4', { authFailedAt: new Date(Date.now() + 1000).toISOString() })
  state.saveState({
    version: 1,
    createdAt: new Date().toISOString(),
    accounts: [busy, idle, idleLongest, broken],
    sessions: [],
    lastAccountId: 'account-1',
    lastAccountByCwd: {}
  })

  assert.equal(supervise.anotherAccount('account-1').id, 'account-3')

  // An account waiting out its quota is not offered either.
  state.mutateState((current) =>
    accounts.markCooldown(current, 'account-3', new Date(Date.now() + 3600_000).toISOString())
  )
  assert.equal(supervise.anotherAccount('account-1').id, 'account-2')
})

test('a clean exit ends the loop after one session', async () => {
  tempHome()
  const outcome = await supervise.supervise({
    baseBackoffMs: 10,
    run: scripted([{ code: 0, signal: null, sessionId: 's1', elapsedMs: 60_000 }])
  })

  assert.equal(outcome.attempts, 1)
  assert.equal(outcome.stopped, 'completed')
  assert.equal(outcome.code, 0)
})

test('a failed session is retried, and a crash loop stops with a critical reason', async () => {
  tempHome()
  const seen = []
  const critical = []

  const argsSeen = []
  const outcome = await supervise.supervise({
    baseBackoffMs: 10,
    maxFastFailures: 3,
    run: async (info) => {
      seen.push(info.attempt)
      argsSeen.push([...(info.args || [])])
      return {
        code: 1,
        signal: null,
        sessionId: `s${info.attempt}`,
        accountId: 'account-1',
        // Fast failures are the ones that count as a crash loop.
        elapsedMs: 200
      }
    },
    onCritical: (reason, detail) => critical.push({ reason, detail })
  })

  // Three identical failed starts, then the one automatic fix left (a new
  // conversation, because the saved one may be what freebuff keeps choking on),
  // then the same three again before a person is asked to step in.
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6], 'it should retry before giving up')
  assert.ok(argsSeen[3].includes('--continue') === false, 'the fourth attempt starts a fresh conversation')
  assert.equal(outcome.attempts, 6)
  assert.equal(critical.length, 1, 'a crash loop must be reported once')
  assert.match(critical[0].reason, /3 failed starts in a row/)
  assert.match(outcome.stopped, /3 failed starts in a row/)
})

test('a slow failure resets the crash counter instead of tripping it', async () => {
  tempHome()
  let attempts = 0
  const outcome = await supervise.supervise({
    baseBackoffMs: 10,
    maxFastFailures: 2,
    run: async (info) => {
      attempts += 1
      if (attempts >= 3) return { code: 0, signal: null, sessionId: 'ok', elapsedMs: 1000 }
      return {
        code: 1,
        signal: null,
        sessionId: `s${info.attempt}`,
        // Long enough to be a real session, not a failed start.
        elapsedMs: supervise.FAST_FAILURE_MS + 1000
      }
    }
  })

  assert.equal(attempts, 3)
  assert.equal(outcome.stopped, 'completed')
  assert.equal(outcome.code, 0)
})

test('Ctrl-C stops the loop instead of restarting', async () => {
  tempHome()
  const outcome = await supervise.supervise({
    baseBackoffMs: 10,
    run: scripted([{ code: 130, signal: 'SIGINT', sessionId: 's1', elapsedMs: 5000 }])
  })

  assert.equal(outcome.attempts, 1)
  assert.equal(outcome.stopped, 'interrupted')
  assert.equal(outcome.code, 130)
})

test('a stop requested while running is honoured without a critical report', async () => {
  const home = tempHome()
  const critical = []

  const outcome = await supervise.supervise({
    baseBackoffMs: 10,
    run: async (info) => {
      // `sfreebuff stop` arrives while the supervisor is mid-session.
      supervise.requestStop()
      assert.ok(fs.existsSync(path.join(home, 'stop')))
      return { code: 1, signal: null, sessionId: 's1', elapsedMs: 200, attempt: info.attempt }
    },
    onCritical: (reason) => critical.push(reason)
  })

  assert.equal(outcome.stopped, 'stopped on request')
  assert.equal(critical.length, 0, 'an intentional stop is not a critical error')
  assert.ok(!fs.existsSync(path.join(home, 'stop')), 'the stop request is consumed')
})

test('a stale stop request does not kill the next supervisor', async () => {
  const home = tempHome()
  supervise.requestStop()

  const outcome = await supervise.supervise({
    baseBackoffMs: 10,
    run: scripted([{ code: 0, signal: null, sessionId: 's1', elapsedMs: 60_000 }])
  })

  assert.equal(outcome.attempts, 1)
  assert.equal(outcome.stopped, 'completed')
  assert.ok(!fs.existsSync(path.join(home, 'stop')))
})

test('a session that cannot start at all is fatal, not a crash loop', async () => {
  tempHome()
  const critical = []
  const outcome = await supervise.supervise({
    baseBackoffMs: 10,
    run: scripted([{
      code: 1,
      signal: null,
      fatal: 'no account can run a session',
      fatalDetail: 'every signed-in account reported an auth failure',
      elapsedMs: 50
    }]),
    onCritical: (reason, detail) => critical.push({ reason, detail })
  })

  assert.equal(outcome.attempts, 1, 'a fatal error must not be retried')
  assert.equal(critical.length, 1)
  assert.match(critical[0].reason, /no account can run a session/)
})

test('every restart continues the conversation without duplicating the flag', () => {
  assert.deepEqual(
    supervise.continueArgs(['--cwd', '.']),
    ['--continue', '--cwd', '.']
  )
  assert.deepEqual(
    supervise.continueArgs(['--continue', '--cwd', '.']),
    ['--continue', '--cwd', '.']
  )
  // A `--continue=<id>` form is replaced by the bare flag, not kept twice.
  assert.deepEqual(supervise.continueArgs(['--continue=x']), ['--continue'])
})

test('hasContinue and withoutContinue split a resume flag off the arguments', () => {
  assert.equal(supervise.hasContinue(['--continue', '--cwd', '.']), true)
  assert.equal(supervise.hasContinue(['--continue=x']), true)
  assert.equal(supervise.hasContinue(['--cwd', '.']), false)
  assert.deepEqual(supervise.withoutContinue(['--continue', '--cwd', '.']), ['--cwd', '.'])
  assert.deepEqual(supervise.withoutContinue(['--continue=x', '--cwd', '.']), ['--cwd', '.'])
})

test('a clean exit in the middle of a turn resumes the task instead of closing it', async () => {
  // freebuff quitting on its own while the agent is still working is a random
  // exit, not a finished task. Resuming the conversation kept the job alive;
  // treating exit 0 as "done" used to close it halfway through.
  tempHome()
  const seen = []

  const outcome = await supervise.supervise({
    baseBackoffMs: 10,
    maxCleanResumes: 2,
    run: async (info) => {
      seen.push({ attempt: info.attempt, args: info.args, restarting: info.restarting })
      if (info.attempt >= 3) return { code: 0, signal: null, sessionId: 'ok', elapsedMs: 600_000 }
      return {
        code: 0,
        signal: null,
        sessionId: `s${info.attempt}`,
        accountId: 'account-1',
        elapsedMs: 90_000,
        // The turn was still running when the TUI went away.
        busyAtExit: true
      }
    }
  })

  assert.equal(outcome.attempts, 3)
  assert.equal(outcome.stopped, 'completed', 'the last session finished normally')
  assert.deepEqual(seen[1].args, ['--continue'], 'the conversation is resumed')
  assert.equal(seen[1].restarting, true)
})

test('a TUI that keeps quitting mid-turn stops for a person', async () => {
  tempHome()
  const critical = []

  const outcome = await supervise.supervise({
    baseBackoffMs: 10,
    maxCleanResumes: 1,
    run: async () => ({
      code: 0,
      signal: null,
      sessionId: 's1',
      accountId: 'account-1',
      elapsedMs: 120_000,
      dialogAtExit: true
    }),
    onCritical: (reason) => critical.push(reason)
  })

  assert.equal(outcome.attempts, 2)
  assert.match(String(outcome.stopped), /quitting in the middle of a turn/)
  assert.equal(critical.length, 1)
})

test('a session that ends cleanly with an idle screen is still a finished task', async () => {
  tempHome()
  const outcome = await supervise.supervise({
    baseBackoffMs: 10,
    run: scripted([{
      code: 0,
      signal: null,
      sessionId: 's1',
      elapsedMs: 60_000,
      busyAtExit: false,
      dialogAtExit: false
    }])
  })

  assert.equal(outcome.attempts, 1)
  assert.equal(outcome.stopped, 'completed')
})

test('a transient start failure is retried instead of closing the task', async () => {
  // The binary being replaced, or a pty that broke, looks fatal but clears up.
  // Only a failure a retry cannot fix may end the supervisor.
  tempHome()
  const critical = []

  const outcome = await supervise.supervise({
    baseBackoffMs: 10,
    maxFatalRetries: 1,
    run: async (info) => {
      if (info.attempt >= 2) return { code: 0, signal: null, sessionId: 'ok', elapsedMs: 600_000 }
      return {
        code: 1,
        signal: null,
        sessionId: 's1',
        elapsedMs: 50,
        fatal: 'freebuff could not be started',
        fatalDetail: 'spawn EBUSY',
        retryable: true
      }
    },
    onCritical: (reason) => critical.push(reason)
  })

  assert.equal(outcome.attempts, 2)
  assert.equal(outcome.stopped, 'completed')
  assert.equal(critical.length, 0)
})

test('a transient failure that keeps happening still stops for a person', async () => {
  tempHome()
  const critical = []

  const outcome = await supervise.supervise({
    baseBackoffMs: 10,
    maxFatalRetries: 1,
    run: async () => ({
      code: 1,
      signal: null,
      sessionId: 's1',
      elapsedMs: 50,
      fatal: 'freebuff could not be started',
      fatalDetail: 'spawn EBUSY',
      retryable: true
    }),
    onCritical: (reason) => critical.push(reason)
  })

  assert.equal(outcome.attempts, 2)
  assert.equal(critical.length, 1)
  assert.match(critical[0], /freebuff could not be started/)
})

test('a restart never appends anything to the arguments', () => {
  // freebuff's only positional argument is `login`, and `--continue` takes an
  // optional conversation id, so a trailing word would be read as an id rather
  // than as a prompt. Anything extra would break the resume it is meant to do.
  const original = ['--continue', '--cwd', '/tmp/project']
  const relaunch = supervise.continueArgs(original)

  assert.deepEqual(relaunch, ['--continue', '--cwd', '/tmp/project'])
  assert.equal(relaunch.length, original.length)
})

test('a restart is told which account ran the previous attempt', async () => {
  tempHome()
  const seen = []

  const outcome = await supervise.supervise({
    baseBackoffMs: 10,
    run: async (info) => {
      seen.push({ attempt: info.attempt, restarting: info.restarting, previousAccountId: info.previousAccountId })
      if (info.attempt >= 3) return { code: 0, signal: null, sessionId: 'ok', elapsedMs: 1000 }
      return {
        code: 1,
        signal: null,
        sessionId: `s${info.attempt}`,
        accountId: `account-${info.attempt}`,
        elapsedMs: 600_000
      }
    }
  })

  assert.equal(outcome.attempts, 3)
  assert.deepEqual(seen[0], { attempt: 1, restarting: false, previousAccountId: null })
  // The second attempt picks up from the account the first one used, so a
  // rotated session can continue the task from that account's history.
  assert.deepEqual(seen[1], { attempt: 2, restarting: true, previousAccountId: 'account-1' })
  assert.equal(seen[2].previousAccountId, 'account-2')
})

test('a stalled session is restarted with --continue, not treated as fatal', async () => {
  tempHome()
  const attempts = []

  const outcome = await supervise.supervise({
    baseBackoffMs: 10,
    run: async (info) => {
      attempts.push(info.args)
      if (info.attempt >= 2) return { code: 0, signal: null, sessionId: 'ok', elapsedMs: 1000 }
      return {
        code: null,
        signal: 'SIGTERM',
        sessionId: `s${info.attempt}`,
        elapsedMs: 600_000,
        stalled: true
      }
    }
  })

  assert.equal(attempts.length, 2)
  assert.deepEqual(attempts[1], ['--continue'], 'the retry resumes the conversation')
  assert.equal(outcome.stopped, 'completed')
})

test('activity is read from the files freebuff rewrites while it works', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuffs-activity-'))
  dirs.push(configDir)

  assert.equal(supervise.activityStamp(configDir), 0, 'an empty dir has no activity')

  const history = path.join(configDir, 'message-history.json')
  fs.writeFileSync(history, '[]')
  const before = supervise.activityStamp(configDir)
  assert.ok(before > 0, 'the history file counts as activity')

  const live = path.join(configDir, 'freebuff-live-1234.json')
  fs.writeFileSync(live, '{}')
  fs.utimesSync(live, new Date(), new Date(Date.now() + 5000))
  assert.ok(supervise.activityStamp(configDir) > before, 'live files count too')

  // The work itself is recorded below projects/<project>/chats/<chat>/. A
  // session that appends there is working, and used to look silent: the
  // watchdog then pressed Enter into it and pasted its prompt again.
  const workBefore = supervise.activityStamp(configDir)
  const chatDir = path.join(configDir, 'projects', 'proj', 'chats', '2026-01-01T00-00-00.000Z')
  fs.mkdirSync(chatDir, { recursive: true })
  const chatLog = path.join(chatDir, 'log.jsonl')
  fs.writeFileSync(chatLog, '{}\n')
  const later = new Date(Date.now() + 60_000)
  fs.utimesSync(chatLog, later, later)
  assert.ok(supervise.activityStamp(configDir) > workBefore, 'a running chat counts as work')
  assert.ok(
    supervise.activityStamp(configDir, path.join('/work', 'proj')) > workBefore,
    'the running project is enough to find it'
  )
  assert.equal(
    supervise.activityStamp(configDir, path.join('/work', 'some-other-project')),
    workBefore,
    'another project\'s chats are not this session\'s progress'
  )
})

test('a chat freebuff filed under another project name still counts as work', () => {
  // freebuff does not always key `projects/<name>` by the folder's base name.
  // Looking only at the base name made a working session look silent, so the
  // stall watch killed it and the diagnosis blamed "no progress" on a session
  // that had been working the whole time.
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuffs-activity-named-'))
  dirs.push(configDir)
  const cwd = path.join('/work', 'my project')
  const chatDir = path.join(configDir, 'projects', '--work-my-project', 'chats', 'chat-1')
  fs.mkdirSync(chatDir, { recursive: true })
  // The chat itself names the folder it ran in, which is the signal used when
  // the project directory is named something else.
  fs.writeFileSync(path.join(chatDir, 'chat-meta.json'), JSON.stringify({ cwd }))
  fs.writeFileSync(path.join(chatDir, 'log.jsonl'), '{}\n')

  const later = new Date(Date.now() + 120_000)
  fs.utimesSync(path.join(chatDir, 'log.jsonl'), later, later)
  assert.ok(supervise.activityStamp(configDir, cwd) > 0, 'the chat is this session\'s work')
})

test('backoff doubles and then holds at the cap', () => {
  assert.equal(supervise.backoffFor(1, 1000), 1000)
  assert.equal(supervise.backoffFor(2, 1000), 2000)
  assert.equal(supervise.backoffFor(3, 1000), 4000)
  assert.equal(supervise.backoffFor(50, 1000), 5 * 60 * 1000)
})

test('an unrecognised approval dialog is escalated, never answered', () => {
  tempHome()
  const verdict = answers.decide('Allow the agent to write files? (y/n)')
  assert.equal(verdict.action, 'escalate')
  assert.equal(verdict.name, 'unrecognised-approval')
  assert.equal(verdict.keys, undefined, 'an escalated dialog gets no keystrokes')
})

test('known continuation dialogs are answered', () => {
  tempHome()
  const plan = answers.decide('The project plan is ready for approval.')
  assert.equal(plan.action, 'answer')
  assert.equal(plan.name, 'plan-approval')

  const path_ = answers.decide('Do you want to continue this path?')
  assert.equal(path_.action, 'answer')
  assert.equal(path_.keys, 'y\r')
})

test('a retry screen is answered with Enter and stays answerable', () => {
  tempHome()
  for (const prompt of [
    'Press Enter to retry.',
    'press enter to retry',
    'Enter: retry'
  ]) {
    const verdict = answers.decide(prompt)
    assert.equal(verdict.action, 'answer', prompt)
    assert.equal(verdict.name, 'retry-enter', prompt)
    assert.equal(verdict.keys, '\r', prompt)
    assert.equal(verdict.repeat, true, 'a later retry screen must be pressed again')
  }
})

test('dialog matching ignores capitalisation', () => {
  tempHome()
  assert.equal(answers.decide('The Project Plan Is Ready For Approval.').action, 'answer')
  assert.equal(answers.decide('Sudo needs a password for root (y/n)').action, 'escalate')
})

test('a risky dialog is escalated even when a safe phrase also matches', () => {
  tempHome()
  const verdict = answers.decide(
    'Keep going? (y/n)\nThis step will run sudo rm -rf / and ask for password for root.'
  )
  assert.equal(verdict.action, 'escalate')
  assert.ok(['sudo', 'destructive'].includes(verdict.name))
})

test('risky words in ordinary agent output are not a dialog', () => {
  // Agent prose talks about deleting, sudo, deploying and payments constantly.
  // Treating those words as a dialog froze real sessions: the "pending dialog"
  // blocked the continue prompt and every nudge until the stall watch fired.
  tempHome()
  const prose = [
    'I will delete the duplicate menu block, then run sudo make flash.',
    'Next I deploy the firmware and publish the release notes.',
    'The payment flow still needs a subscribe button, and curl works.',
    'Removed the old handler; now overwriting the stale config.'
  ].join('\n')

  assert.equal(answers.decide(prose).action, 'none')

  // The same words on a dialog-shaped screen still stop the session.
  assert.equal(
    answers.decide('Allow the agent to run sudo? (y/n)').action,
    'escalate'
  )
})

test("a question in the agent's own prose is not escalated", () => {
  // The agent asks questions while it works, and writes about deleting, sudo
  // and API keys while it works. Together those used to read as a blocking
  // dialog: Discord pinged and the phone rang about work that needed nothing.
  tempHome()
  assert.equal(
    answers.decide('I will delete the duplicate menu block now.\nShould I also rename the handler?').action,
    'none'
  )
  assert.equal(
    answers.decide('Fixed the parser.\nDo you want me to allow that file?').action,
    'none'
  )
  assert.equal(
    answers.decide('Ran the tests.\nDo you want me to use curl for that?').action,
    'none'
  )
  // A prompt that offers an answer is still escalated.
  assert.equal(answers.decide('Allow the agent to write files? (y/n)').action, 'escalate')
})

test('only the bottom of the screen can be a dialog', () => {
  tempHome()
  const output = [
    'Allow the agent to write files? (y/n)',
    ...Array.from({ length: 12 }, (_, index) => `step ${index}: wrote a file`)
  ].join('\n')

  assert.equal(
    answers.decide(output).action,
    'none',
    'a prompt scrolled off the screen is history, not a question'
  )
})

test('ordinary agent output is left alone', () => {
  tempHome()
  assert.equal(answers.decide('Wrote 3 files and ran the test suite.').action, 'none')
  assert.equal(answers.decide('').action, 'none')
})

test('answer rules can be extended without touching the code', () => {
  const home = tempHome()
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(
    path.join(home, 'answers.json'),
    JSON.stringify({ safe: [{ name: 'house-dialog', match: 'Shall I tidy up', keys: 'y\r' }] })
  )

  const verdict = answers.decide('Shall I tidy up?')
  assert.equal(verdict.action, 'answer')
  assert.equal(verdict.name, 'house-dialog')
})

test('an edited answer rule applies on the next chunk', () => {
  // The rules are cached so an output chunk does not read and parse the file
  // again; an edit must still be picked up without restarting a session.
  const home = tempHome()
  fs.mkdirSync(home, { recursive: true })
  const file = path.join(home, 'answers.json')
  fs.writeFileSync(
    file,
    JSON.stringify({ safe: [{ name: 'first', match: 'Shall I tidy up', keys: 'y\r' }] })
  )
  assert.equal(answers.decide('Shall I tidy up?').name, 'first')

  fs.writeFileSync(
    file,
    JSON.stringify({ safe: [{ name: 'second', match: 'Shall I sweep up', keys: 'y\r' }] })
  )
  assert.equal(
    answers.decide('Shall I sweep up?').name,
    'second',
    'the edited rules are read again'
  )
  assert.equal(answers.decide('Shall I tidy up?').action, 'none', 'the replaced rule is gone')
})

test('ansi escapes cannot hide a dialog from the matcher', () => {
  // Its own home, so the built-in rules apply rather than a previous test's.
  tempHome()
  const wrapped = '\u001b[1mThe project plan is ready for approval.\u001b[0m'
  assert.equal(answers.decide(wrapped).action, 'answer')
})

test('hidden input keeps what was typed, and masks it with stars', () => {
  tempHome()

  const typed = sudo.applyKeys('', 'hunter2')
  assert.equal(typed.value, 'hunter2')
  assert.equal(typed.echo, '*******', 'one star per character, never the character')
  assert.equal(typed.submitted, false)

  const erased = sudo.applyKeys('hunter2', '\u007f')
  assert.equal(erased.value, 'hunter')
  assert.equal(erased.echo, '\b \b')

  assert.equal(sudo.applyKeys('hunter', '\u007f'.repeat(20)).value, '', 'backspace stops at the start')
  assert.deepEqual(
    sudo.applyKeys('abc', '\r'),
    { value: 'abc', echo: '', submitted: true, cancelled: false }
  )
  assert.equal(sudo.applyKeys('abc', '\u0003').cancelled, true, 'Ctrl-C cancels')
  assert.equal(sudo.applyKeys('abc', '\u001b[D').value, 'abc', 'arrow keys are not typed text')
})

test('the sudo prompt reads the password when Enter is pressed', async () => {
  const pty = require('node-pty')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuffs-ask-'))
  dirs.push(dir)
  const driver = path.join(dir, 'ask.js')
  fs.writeFileSync(
    driver,
    `'use strict'
const { askHidden } = require(${JSON.stringify(path.resolve(__dirname, '..', 'src', 'sudo'))})
askHidden('sudo password: ').then((value) => {
  process.stdout.write('RESULT:' + JSON.stringify(value) + '\\n')
  process.exit(0)
})
`
  )

  const term = pty.spawn(process.execPath, [driver], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    env: { ...process.env, FREEBUFFS_HOME: tempHome() }
  })
  let output = ''
  term.onData((chunk) => { output += chunk })
  const exited = new Promise((resolve) => term.onExit(resolve))

  const deadline = Date.now() + 8000
  while (!/sudo password:/.test(output) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  term.write('hunter2')
  term.write('\u007f')
  term.write('3\r')
  await exited

  assert.match(output, /sudo password: \*{7}/, 'typing should look like it is happening')
  assert.match(output, /RESULT:"hunter3"/, 'Enter must deliver what was typed')
  assert.doesNotMatch(
    output.split('RESULT:')[0],
    /hunter/,
    'the password never reaches the screen'
  )
})

test('starting the supervisor unlocks sudo with the password typed at the prompt', async () => {
  const pty = require('node-pty')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuffs-sudo-ask-'))
  dirs.push(dir)
  const home = tempHome()

  // A fake sudo that only accepts the password this test types: `-n` fails so
  // the prompt is needed, `-S` reads the password from stdin.
  const fake = path.join(dir, 'sudo')
  fs.writeFileSync(
    fake,
    '#!/bin/sh\ncase "$1" in\n  -n) exit 1 ;;\n  -S) read -r line; [ "$line" = "hunter2" ] ;;\n  -k) exit 0 ;;\nesac\n'
  )
  fs.chmodSync(fake, 0o755)

  const driver = path.join(dir, 'driver.js')
  fs.writeFileSync(
    driver,
    `'use strict'
const sudo = require(${JSON.stringify(path.resolve(__dirname, '..', 'src', 'sudo'))})
sudo.start({ enabled: true, interactive: true }).then((vault) => {
  process.stdout.write('VAULT:' + JSON.stringify({ active: vault.active, reason: vault.reason }) + '\\n')
  sudo.clear()
  process.exit(0)
})
`
  )

  const term = pty.spawn(process.execPath, [driver], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    env: { ...process.env, FREEBUFFS_HOME: home, FREEBUFFS_SUDO_BIN: fake }
  })
  let output = ''
  term.onData((chunk) => { output += chunk })
  const exited = new Promise((resolve) => term.onExit(resolve))

  const deadline = Date.now() + 8000
  while (!/sudo password/.test(output) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  term.write('hunter2\r')
  await exited

  assert.match(output, /\*{7}/, 'the typed password should be acknowledged, never echoed')
  assert.match(output, /VAULT:\{"active":true/, 'the password must reach sudo, not be discarded')
  assert.doesNotMatch(output.split('VAULT:')[0], /hunter2/)
  assert.equal(sudo.isActive(), false, 'clearing removes the stored password')
})

test('the sudo vault writes nothing readable, and clears on close', () => {
  tempHome()
  const files = sudo.store('hunter2')

  assert.equal(fs.statSync(sudo.secretPath()).mode & 0o777, 0o600)
  assert.equal(fs.statSync(files.askpass).mode & 0o777, 0o700)
  assert.ok(fs.existsSync(path.join(files.shim, 'sudo')))
  assert.equal(sudo.read(), 'hunter2')
  assert.equal(sudo.isActive(), true)

  const removed = sudo.clear()
  assert.ok(removed.includes(sudo.secretPath()))
  assert.equal(sudo.isActive(), false)
  assert.equal(sudo.read(), null)
  assert.ok(!fs.existsSync(files.askpass))
  assert.ok(!fs.existsSync(path.join(files.shim, 'sudo')))
})

test('clearing twice is safe, so an exit handler cannot fail', () => {
  tempHome()
  sudo.store('hunter2')
  sudo.clear()
  assert.doesNotThrow(() => sudo.clear())
})

test('a password that sudo rejects is not stored', async () => {
  tempHome()
  // A fake sudo that accepts only one password, so nothing real is touched.
  const fake = path.join(path.dirname(process.env.FREEBUFFS_HOME), 'fake-sudo')
  fs.mkdirSync(path.dirname(fake), { recursive: true })
  fs.writeFileSync(fake, '#!/bin/sh\nread -r line\n[ "$line" = "correct-horse" ]\n')
  fs.chmodSync(fake, 0o755)
  process.env.FREEBUFFS_SUDO_BIN = fake

  assert.equal(sudo.validate('correct-horse'), true)
  assert.equal(sudo.validate('wrong'), false)
  assert.equal(sudo.isActive(), false, 'validation alone stores nothing')

  delete process.env.FREEBUFFS_SUDO_BIN
})

test('sudo unlock is on by default and can be turned off', () => {
  tempHome()
  assert.equal(sudo.enabled({}), true)
  assert.equal(sudo.enabled({ FREEBUFFS_SUDO: '0' }), false)
  assert.equal(sudo.enabled({ FREEBUFFS_SUDO: 'off' }), false)
  assert.equal(sudo.enabled({ FREEBUFFS_SUDO: '1' }), true)

  sudo.setEnabled(false)
  assert.equal(sudo.enabled({}), false, 'the stored preference wins over the default')
  sudo.setEnabled(true)
  assert.equal(sudo.enabled({}), true)
})

test('a session whose prompt never left the input box is relaunched, not left sitting', async () => {
  tempHome()
  const seen = []

  // freebuff's input box can stop accepting a typed message. The session is
  // retired and the same conversation started again, because nothing typed at
  // the old TUI can recover it.
  const outcome = await supervise.supervise({
    baseBackoffMs: 10,
    maxStuckRestarts: 3,
    run: async (info) => {
      seen.push(info.attempt)
      // Killed by the caller after the stuck prompt was reported, so it looks
      // like a signal rather than a clean finish.
      if (info.attempt >= 3) return { code: 0, signal: null, sessionId: `s${info.attempt}`, elapsedMs: 120_000 }
      return {
        code: 0,
        signal: 'SIGTERM',
        sessionId: `s${info.attempt}`,
        elapsedMs: 120_000,
        stuck: true
      }
    }
  })

  assert.deepEqual(seen, [1, 2, 3], 'it keeps the conversation going')
  assert.equal(outcome.stopped, 'completed', 'a later clean session finishes normally')
})

test('a TUI that refuses every typed prompt stops the loop and says so', async () => {
  tempHome()
  const critical = []

  const outcome = await supervise.supervise({
    baseBackoffMs: 10,
    maxStuckRestarts: 3,
    run: async (info) => ({
      code: 0,
      signal: 'SIGTERM',
      sessionId: `s${info.attempt}`,
      accountId: 'account-1',
      elapsedMs: 120_000,
      stuck: true
    }),
    onCritical: (reason, detail) => critical.push({ reason, detail })
  })

  assert.equal(outcome.attempts, 3, 'three restarts, then a person')
  assert.match(outcome.stopped, /will not accept a typed prompt/)
  assert.equal(critical.length, 1)
  assert.match(critical[0].detail, /input box/)
})

/** An account container that looks signed in to freebuff. */
function signedInAccount (root, id) {
  const configDir = path.join(root, id, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(
    path.join(configDir, 'credentials.json'),
    JSON.stringify({ default: { id, tokenStore: { accessToken: 't' } } })
  )
  return {
    id,
    label: id,
    configDir,
    shared: false,
    signedInAt: new Date().toISOString(),
    lastUsedAt: null,
    sessions: 0,
    totalMs: 0,
    lastError: null
  }
}

function seedState (home, accounts) {
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    accounts,
    sessions: [],
    lastAccountId: null,
    lastAccountByCwd: {}
  }))
  return home
}

test('a limited account is not a finished task: it rotates instead of stopping', async () => {
  const home = tempHome()
  // No usage API in the tests: the wait falls back to the configured time.
  process.env.FREEBUFFS_CREDITS = '0'
  const root = path.dirname(home)
  const accounts = [
    signedInAccount(root, 'account-1'),
    signedInAccount(root, 'account-2')
  ]
  seedState(home, accounts)

  const seen = []
  const startedAt = Date.now()
  const outcome = await supervise.supervise({
    baseBackoffMs: 10,
    limitWaitMs: 20,
    minLimitWaitMs: 10,
    run: async (info) => {
      seen.push({ attempt: info.attempt, previous: info.previousAccountId })
      if (info.attempt === 1) {
        return {
          code: 0,
          signal: null,
          sessionId: 's1',
          accountId: 'account-1',
          elapsedMs: 60_000,
          limited: {
            kind: 'session-limit',
            message: 'Session limit reached.',
            ends: true,
            wait: true
          }
        }
      }
      return { code: 0, signal: null, sessionId: 's2', accountId: 'account-2', elapsedMs: 60_000 }
    }
  })

  assert.equal(outcome.attempts, 2, 'the next attempt is made on another account')
  assert.equal(outcome.stopped, 'completed')
  assert.deepEqual(seen[1], { attempt: 2, previous: 'account-1' })
  assert.ok(
    Date.now() - startedAt < 3000,
    'with another account available it must not sit out the reset'
  )

  const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'))
  const limited = state.accounts.find((account) => account.id === 'account-1')
  const other = state.accounts.find((account) => account.id === 'account-2')
  assert.ok(Date.parse(limited.cooldownUntil) > Date.now(), 'the used-up account is skipped')
  assert.ok(!other.cooldownUntil, 'the other account stays usable')
})

test('with no other account the loop waits for the reset and continues', async () => {
  const home = tempHome()
  process.env.FREEBUFFS_CREDITS = '0'
  const root = path.dirname(home)
  seedState(home, [signedInAccount(root, 'account-1')])

  let attempts = 0
  const outcome = await supervise.supervise({
    baseBackoffMs: 10,
    limitWaitMs: 15,
    minLimitWaitMs: 10,
    run: async (info) => {
      attempts = info.attempt
      if (info.attempt === 1) {
        return {
          code: 0,
          signal: null,
          sessionId: 's1',
          accountId: 'account-1',
          elapsedMs: 60_000,
          limited: { kind: 'session-limit', message: 'Session limit reached.', ends: true, wait: true }
        }
      }
      return { code: 0, signal: null, sessionId: 's2', accountId: 'account-1', elapsedMs: 60_000 }
    }
  })

  assert.equal(attempts, 2, 'the task is retried after the wait')
  assert.equal(outcome.attempts, 2)
  assert.equal(outcome.stopped, 'completed')
})

test('a free session that ended is retried at once, however the session exited', async () => {
  const home = tempHome()
  process.env.FREEBUFFS_CREDITS = '0'
  const root = path.dirname(home)
  seedState(home, [signedInAccount(root, 'account-1')])

  const seen = []
  const outcome = await supervise.supervise({
    baseBackoffMs: 10,
    run: async (info) => {
      seen.push(info.attempt)
      // A clean exit 0 with the session ended on screen: the work is not done.
      if (info.attempt <= 4) {
        return {
          code: 0,
          signal: null,
          sessionId: `s${info.attempt}`,
          accountId: 'account-1',
          elapsedMs: 60_000,
          limited: {
            kind: 'session-ended',
            message: 'Your free session ended.',
            ends: false,
            wait: false,
            retype: true,
            delayMs: 10
          }
        }
      }
      return { code: 0, signal: null, sessionId: 'done', accountId: 'account-1', elapsedMs: 60_000 }
    }
  })

  assert.deepEqual(seen, [1, 2, 3, 4, 5], 'it keeps continuing the task')
  assert.equal(outcome.stopped, 'completed')
})

test('a stop request during a quota wait is honoured', async () => {
  const home = tempHome()
  process.env.FREEBUFFS_CREDITS = '0'
  const root = path.dirname(home)
  seedState(home, [signedInAccount(root, 'account-1')])

  const outcome = await supervise.supervise({
    baseBackoffMs: 10,
    // A long wait, stopped almost immediately by the stop file.
    limitWaitMs: 10_000,
    minLimitWaitMs: 300,
    run: async () => {
      setTimeout(() => supervise.requestStop(), 50)
      return {
        code: 0,
        signal: null,
        sessionId: 's1',
        accountId: 'account-1',
        elapsedMs: 60_000,
        limited: { kind: 'session-limit', message: 'Session limit reached.', ends: true, wait: true }
      }
    }
  })

  assert.equal(outcome.stopped, 'stopped on request')
  assert.ok(!fs.existsSync(path.join(home, 'stop')), 'the request is consumed')
})

test('a session state that never clears stops for a person instead of looping', async () => {
  const home = tempHome()
  process.env.FREEBUFFS_CREDITS = '0'
  const root = path.dirname(home)
  seedState(home, [signedInAccount(root, 'account-1')])

  const critical = []
  let attempts = 0
  const outcome = await supervise.supervise({
    baseBackoffMs: 10,
    maxLimitRestarts: 2,
    run: async (info) => {
      attempts = info.attempt
      return {
        code: 0,
        signal: null,
        sessionId: `s${info.attempt}`,
        accountId: 'account-1',
        elapsedMs: 60_000,
        limited: {
          kind: 'session-ended',
          message: 'Your free session ended.',
          ends: false,
          wait: false,
          retype: true,
          delayMs: 10
        }
      }
    },
    onCritical: (reason) => critical.push(reason)
  })

  assert.equal(attempts, 3, 'it retries twice, then asks for a person')
  assert.match(outcome.stopped, /keeps ending the session/)
  assert.equal(critical.length, 1)
  assert.match(critical[0], /keeps ending the session/)
})

test('a new session from home keeps the picker, and its restart recovers the project folder', async () => {
  const home = tempHome()
  const project = path.join(home, 'project')
  fs.mkdirSync(project, { recursive: true })
  state.saveState({
    version: 1,
    createdAt: new Date().toISOString(),
    accounts: [],
    sessions: [{
      id: 'old-session',
      accountId: 'account-1',
      cwd: project,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      exitCode: 0,
      exitSignal: null,
      note: null
    }],
    lastAccountId: null,
    lastAccountByCwd: {}
  })

  const seen = []
  // The home folder is exactly where freebuff would show the picker.
  await supervise.supervise({
    run: async (info) => {
      seen.push(info.cwd)
      return { code: 0, signal: null, elapsedMs: 100, accountId: 'account-1' }
    },
    cwd: os.homedir(),
    forever: false,
    env: {}
  })

  assert.deepEqual(
    seen,
    [os.homedir()],
    'a new session leaves the folder for the person to pick'
  )

  const restarted = []
  await supervise.supervise({
    baseBackoffMs: 10,
    env: {},
    run: async (info) => {
      restarted.push(info.cwd)
      if (info.attempt >= 2) return { code: 0, signal: null, sessionId: 'ok', elapsedMs: 1000 }
      return { code: 1, signal: null, sessionId: 's1', elapsedMs: 600_000 }
    },
    cwd: os.homedir()
  })

  assert.deepEqual(restarted, [os.homedir(), project], 'the restart continues in the project')
})
