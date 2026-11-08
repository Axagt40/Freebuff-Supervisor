'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { removeTree } = require('./helpers')
const { spawnSync } = require('child_process')

const ptyrun = require('../src/ptyrun')

const dirs = []
test.after(() => {
  for (const dir of dirs) removeTree(dir)
})

/**
 * The runner forwards the TUI's bytes to this process's stdout, so the tests
 * drive it from a child process and read what the terminal would have shown.
 */
function scenario (tuiSource, {
  timeoutMs = 20000,
  nudge = null,
  resume = null,
  progress = null,
  stuck = false,
  limit = false,
  phoneAnswer = null,
  verifyMs = null,
  maxRetries = null,
  limitQuietMs = null
} = {}) {
  // progress: 'clock' means work is always happening; a number is a frozen
  // stamp, which is how a session that makes no progress looks.
  const progressFn = progress === 'clock'
    ? '() => Date.now()'
    : progress == null
      ? 'undefined'
      : `() => ${Number(progress)}`

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuffs-pty-'))
  dirs.push(dir)

  const tui = path.join(dir, 'fake-tui.js')
  fs.writeFileSync(tui, tuiSource)

  fs.mkdirSync(path.join(dir, 'home'), { recursive: true })
  const driver = path.join(dir, 'driver.js')
  fs.writeFileSync(
    driver,
    `'use strict'
const { runOnPty } = require(${JSON.stringify(path.resolve(__dirname, '..', 'src', 'ptyrun'))})
let PHONE_ANSWER = ${phoneAnswer ? JSON.stringify(phoneAnswer) : 'null'}
runOnPty({
  binary: process.execPath,
  args: [${JSON.stringify(tui)}],
  cwd: ${JSON.stringify(dir)},
  nudge: ${JSON.stringify(nudge)},
  resume: ${JSON.stringify(resume)},
  progress: ${progressFn},
  verifyMs: ${verifyMs == null ? 'undefined' : Number(verifyMs)},
  maxRetries: ${maxRetries == null ? 'undefined' : Number(maxRetries)},
  limitQuietMs: ${limitQuietMs == null ? 'undefined' : Number(limitQuietMs)},
  onStuck: ${stuck
    ? "(text) => { process.stderr.write('STUCK ' + JSON.stringify(text) + '\\n') }"
    : 'undefined'},
  onLimit: ${limit
    ? "(verdict) => { process.stderr.write('LIMIT ' + JSON.stringify(verdict) + '\\n') }"
    : 'undefined'},
  takeAnswer: ${phoneAnswer
    ? '() => { const a = PHONE_ANSWER; PHONE_ANSWER = null; return a }'
    : 'undefined'},
  onSpawn: (handle) => {
    process.stderr.write('SPAWN ' + JSON.stringify({ pid: handle.pid }) + '\\n')
  },
  env: { ...process.env, FREEBUFFS_HOME: ${JSON.stringify(path.join(dir, 'home'))} }
}).then((result) => {
  process.stderr.write('RESULT ' + JSON.stringify(result) + '\\n')
  process.exit(0)
}).catch((error) => {
  process.stderr.write('ERROR ' + error.message + '\\n')
  process.exit(3)
})
`
  )

  const result = spawnSync(process.execPath, [driver], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, FREEBUFFS_HOME: path.join(dir, 'home') }
  })

  const match = /RESULT (\{.*\})/.exec(result.stderr || '')
  const spawned = /SPAWN (\{.*\})/.exec(result.stderr || '')
  const limited = /LIMIT (\{.*\})/.exec(result.stderr || '')
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
    result: match ? JSON.parse(match[1]) : null,
    spawnPid: spawned ? JSON.parse(spawned[1]).pid : null,
    limit: limited ? JSON.parse(limited[1]) : null
  }
}

test('a frame painted with cursor moves is read as the rows a person sees', () => {
  // freebuff repaints by jumping to a position and writing there, so its output
  // has no newlines between rows. Read as plain text the whole screen is one
  // line, and the input box could never be found in it.
  const at = (row, col, text) => `\u001b[${row};${col}H${text}`
  const idle = [
    at(1, 1, '╭──────────────────────────────╮'),
    at(2, 1, '│ ▍Enter a coding task or / for commands │'),
    at(3, 1, '╰──────────────────────────────╯'),
    at(4, 1, 'MiMo v2.6 Flash Fast · /project · /model to change')
  ].join('')
  assert.equal(ptyrun.inputBoxIdle(idle), true, 'the empty box is found')
  assert.equal(ptyrun.busyOnScreen(idle), false)

  // The second placeholder freebuff uses once a chat is under way: the empty
  // box has to be recognised there too, or every resumed session looks as if
  // its box were full.
  const underway = [
    at(1, 1, 'Reply with OK and stop. Do not use tools.'),
    at(2, 1, 'OK'),
    at(3, 1, '  ▍ Add to the current task (/ for commands)')
  ].join('')
  assert.equal(ptyrun.inputBoxIdle(underway), true, 'the other placeholder is an empty box')

  const busy = [
    at(1, 1, 'Let me check the tests.'),
    at(2, 1, '• Thinking'),
    at(3, 1, '╭──────────────────────────────╮'),
    at(4, 1, '│ Continue the unfinished task │'),
    at(5, 1, '╰──────────────────────────────╯')
  ].join('')
  assert.equal(ptyrun.busyOnScreen(busy), true, 'a running turn is recognised')
  assert.equal(ptyrun.inputBoxIdle(busy), false, 'a full box is not an empty one')
})

test('node-pty is available for the opt-in auto-answer mode', () => {
  assert.equal(ptyrun.available(), true, 'node-pty should be installed')
})

test('numbers from node-pty are reported as the signals the rest of the code uses', () => {
  assert.equal(ptyrun.signalName(2), 'SIGINT')
  assert.equal(ptyrun.signalName(15), 'SIGTERM')
  assert.equal(ptyrun.signalName('SIGINT'), 'SIGINT')
})

test('a familiar dialog is answered on the pty without anyone typing', () => {
  // The fake TUI asks the question freebuff asks before a plan is run, then
  // only finishes if something answered it.
  const run = scenario(`'use strict'
process.stdout.write('The project plan is ready for approval.\\n')
process.stdin.setEncoding('utf8')
process.stdin.once('data', () => {
  process.stdout.write('ANSWERED\\n')
  process.exit(7)
})
setTimeout(() => {
  process.stdout.write('TIMED OUT\\n')
  process.exit(9)
}, 8000)
`)

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /project plan is ready for approval/)
  assert.match(run.stdout, /ANSWERED/, 'the dialog must have been answered')
  assert.ok(run.result, 'the driver should report a result')
  assert.equal(run.result.code, 7, 'the TUI decided how to exit')
  assert.equal(run.result.answered, 1)
  assert.equal(run.result.escalated, 0)
})

test('a dialog the supervisor will not answer is left for a person', () => {
  const run = scenario(`'use strict'
process.stdout.write('Allow the agent to write files? (y/n)\\n')
process.stdin.setEncoding('utf8')
process.stdin.once('data', () => {
  process.stdout.write('ANSWERED\\n')
  process.exit(7)
})
setTimeout(() => {
  process.stdout.write('LEFT ALONE\\n')
  process.exit(11)
}, 3000)
`)

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /LEFT ALONE/, 'nothing should have been typed at it')
  assert.doesNotMatch(run.stdout, /ANSWERED/)
  assert.equal(run.result.code, 11)
  assert.equal(run.result.answered, 0)
  assert.equal(run.result.escalated, 1, 'it should be reported, not answered')
})

test('a quiet session is nudged by typing at it', () => {
  // freebuff takes no prompt as an argument, so an agent left waiting is pushed
  // forward by typing, exactly as a person would.
  const run = scenario(`'use strict'
console.log('Waiting at the prompt.')
process.stdin.setEncoding('utf8')
process.stdin.once('data', (chunk) => {
  console.log('NUDGED:' + JSON.stringify(chunk))
  process.exit(21)
})
setTimeout(() => process.exit(22), 9000)
`, { nudge: { text: 'keep going', idleMs: 1000, max: 1 } })

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /NUDGED:/, 'the session should have been typed at')
  assert.match(run.stdout, /keep going/, 'the nudge text should be what arrived')
  assert.equal(run.result.code, 21)
  assert.equal(run.result.nudges, 1)
})

test('risky words in ordinary agent output do not freeze the session', () => {
  // Deleting, sudo, deploying and payments are things an agent writes about
  // constantly. Treating them as a dialog used to hold a pending dialog open,
  // which blocked every nudge and left real sessions sitting still.
  const run = scenario(`'use strict'
console.log('I will delete the duplicate menu, then run sudo make flash and deploy it.')
console.log('The payment flow still needs a subscribe button; curl works.')
process.stdin.setEncoding('utf8')
process.stdin.once('data', (chunk) => {
  console.log('NUDGED:' + JSON.stringify(chunk))
  process.exit(21)
})
setTimeout(() => process.exit(22), 12000)
`, { nudge: { text: 'keep going', idleMs: 1000, max: 1 } })

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /NUDGED:/, 'ordinary output must not block the nudge')
  assert.equal(run.result.escalated, 0, 'prose is not a dialog')
  assert.equal(run.result.nudges, 1)
})

test('an idle session is nudged again and again, not just three times', () => {
  // The work must not be abandoned after a few pushes: the wait grows, but the
  // nudge never stops while the session is idle.
  const run = scenario(`'use strict'
let heard = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  heard += chunk
  const count = (heard.match(/keep going/g) || []).length
  if (count >= 4) {
    console.log('NUDGES ' + count)
    process.exit(21)
  }
})
setTimeout(() => process.exit(22), 25000)
`, { nudge: { text: 'keep going', idleMs: 1000 }, timeoutMs: 30000 })

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /NUDGES 4/, 'the fourth push should have been typed')
  assert.ok(run.result.nudges >= 4)
})

test('a restarted session is asked to continue the unfinished task', () => {
  // A new session after a crash, a stall or an account switch waits at an
  // empty prompt. The supervisor types the continue prompt soon after startup
  // instead of leaving the task abandoned.
  const run = scenario(`'use strict'
process.stdout.write('Your first message starts the session.\\n')
process.stdout.write('Enter a coding task or / for commands\\n')
process.stdin.setEncoding('utf8')
process.stdin.once('data', (chunk) => {
  process.stdout.write('RESUMED:' + JSON.stringify(chunk) + '\\n')
  process.exit(7)
})
setTimeout(() => process.exit(9), 9000)
`, { resume: { text: 'continue the unfinished task', delayMs: 300, idleMs: 100 } })

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /RESUMED:/, 'the new session should have been asked to continue')
  assert.match(run.stdout, /continue the unfinished task/)
  assert.equal(run.result.code, 7)
  assert.equal(run.result.resumed, true)
  assert.ok(run.spawnPid > 0, 'the caller gets the pid to monitor and kill')
})

test('the continue prompt is sent with an Enter of its own', () => {
  // freebuff's TUI reads "text\r" arriving together as pasted text: the prompt
  // fills in and nothing is sent. Enter has to be a separate key press.
  const run = scenario(`'use strict'
// A TUI reads keys in raw mode, one key press at a time.
process.stdin.setRawMode(true)
process.stdout.write('Your first message starts the session.\\n')
process.stdout.write('Enter a coding task or / for commands\\n')
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (chunk.includes('continue the unfinished task') && chunk.includes('\\r')) {
    process.stdout.write('SENT IN ONE CHUNK\\n')
    process.exit(9)
  }
  if (chunk === '\\r') {
    process.stdout.write('ENTER PRESSED\\n')
    process.exit(7)
  }
})
setTimeout(() => process.exit(11), 9000)
`, { resume: { text: 'continue the unfinished task', delayMs: 300, idleMs: 100 } })

  assert.equal(run.status, 0, run.stderr)
  assert.doesNotMatch(run.stdout, /SENT IN ONE CHUNK/, 'Enter must not be pasted with the text')
  assert.match(run.stdout, /ENTER PRESSED/, 'the prompt should have been submitted')
  assert.equal(run.result.code, 7)
  assert.equal(run.result.resumed, true)
})

test('a nudged session gets its Enter as a separate key press too', () => {
  const run = scenario(`'use strict'
process.stdin.setRawMode(true)
console.log('Waiting at the prompt.')
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (chunk.includes('keep going') && chunk.includes('\\r')) {
    process.stdout.write('SENT IN ONE CHUNK\\n')
    process.exit(9)
  }
  if (chunk === '\\r') {
    process.stdout.write('ENTER PRESSED\\n')
    process.exit(7)
  }
})
setTimeout(() => process.exit(11), 9000)
`, { nudge: { text: 'keep going', idleMs: 1000, max: 1 } })

  assert.equal(run.status, 0, run.stderr)
  assert.doesNotMatch(run.stdout, /SENT IN ONE CHUNK/)
  assert.match(run.stdout, /ENTER PRESSED/)
  assert.equal(run.result.code, 7)
})

test('the typed prompt arrives as a paste, so no character of it acts as a key', () => {
  // Without bracketed paste the TUI reads the prompt as individual key presses.
  // A single character that survives a mangled write ("?", "/", Esc) then
  // runs the TUI's own command instead of filling in the message.
  const run = scenario(`'use strict'
process.stdin.setRawMode(true)
process.stdout.write('Your first message starts the session.\\n')
process.stdout.write('Enter a coding task or / for commands\\n')
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (!chunk.includes('continue the unfinished task')) return
  const pasted = chunk.includes('\\u001b[200~') && chunk.includes('\\u001b[201~')
  process.stdout.write('PASTE ' + pasted + '\\n')
  process.exit(pasted ? 7 : 9)
})
setTimeout(() => process.exit(11), 9000)
`, { resume: { text: 'continue the unfinished task', delayMs: 300, idleMs: 100 } })

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /PASTE true/, 'the prompt should be pasted, not typed as keys')
  assert.equal(run.result.code, 7)
})

test('freebuff\'s help screen is closed and the task typed again', () => {
  // The help screen is a dead end: it does nothing by itself, so a session left
  // on it never starts working. The supervisor closes it and re-sends the task.
  const run = scenario(`'use strict'
process.stdin.setRawMode(true)
process.stdout.write('Enter a coding task or / for commands\\n')
let typed = 0
setTimeout(() => {
  process.stdout.write('Keyboard shortcuts\\n')
  process.stdout.write('Esc  Close help / stop\\n')
}, 1500)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (chunk === '\\u001b') {
    process.stdout.write('HELP CLOSED\\n')
    return
  }
  if (!chunk.includes('continue the unfinished task')) return
  typed += 1
  if (typed === 1) {
    process.stdout.write('FIRST TYPE\\n')
    return
  }
  process.stdout.write('RETYPED\\n')
  process.exit(7)
})
setTimeout(() => process.exit(9), 12000)
`, {
    resume: { text: 'continue the unfinished task', delayMs: 300, idleMs: 100 },
    progress: 0,
    verifyMs: 600
  })

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /HELP CLOSED/, 'the help screen should be closed with Esc')
  assert.match(run.stdout, /RETYPED/, 'the task should be typed again')
  assert.equal(run.result.code, 7)
})

test('an agent writing about shortcuts is not interrupted with Esc', () => {
  // The help screen is recognised by its title and one of its shortcut rows,
  // but it is only a help screen when the session is idle: a turn that is
  // writing about freebuff's keys must not be stopped.
  const run = scenario(`'use strict'
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (chunk === '\\u001b') {
    process.stdout.write('ESC SENT\\n')
    process.exit(9)
  }
})
let ticks = 0
const timer = setInterval(() => {
  ticks += 1
  process.stdout.write('Keyboard shortcuts\\nEsc  Close help / stop\\n')
  // The input box is redrawn after the conversation it belongs to.
  process.stdout.write('Enter a coding task or / for commands\\n')
  if (ticks >= 8) {
    clearInterval(timer)
    process.stdout.write('DONE\\n')
    process.exit(7)
  }
}, 300)
`, {
    resume: { text: 'continue the unfinished task', delayMs: 200, idleMs: 100 },
    progress: 'clock',
    verifyMs: 600
  })

  assert.equal(run.status, 0, run.stderr)
  assert.doesNotMatch(run.stdout, /ESC SENT/, 'a working turn must not be stopped')
  assert.match(run.stdout, /DONE/)
  assert.equal(run.result.code, 7)
})

test('agent output that mentions auth does not mark the account signed out', () => {
  // On a pty the agent's own prose and the output of the commands it runs share
  // freebuff's stream. "401" or "not signed in" in a test log is not an auth
  // failure and used to bench a working account.
  const { createAuthWatcher } = require('../src/authwatch')
  const hits = []
  const watch = createAuthWatcher((detail) => hits.push(detail), { merged: true })
  watch('BLE Suite chrome PASS title bar reads VANDETA BLE PASS code 401 working...\n')
  watch('the tests expect a 401 when the session is not signed in\n')
  assert.deepEqual(hits, [])

  watch('Error: 401 Unauthorized — authentication failed\n')
  assert.equal(hits.length, 1, 'a real auth error must still be caught')
})

test('a prompt that was sent is left alone once work starts', () => {
  // The watchdog reads freebuff's records: once they move, the prompt was
  // accepted and nothing else should be typed.
  const run = scenario(`'use strict'
process.stdin.setRawMode(true)
process.stdout.write('Your first message starts the session.\\n')
process.stdout.write('Enter a coding task or / for commands\\n')
process.stdin.setEncoding('utf8')
process.stdin.once('data', (chunk) => {
  process.stdout.write('> ' + chunk + '\\n')
  setTimeout(() => process.exit(7), 2500)
})
setTimeout(() => process.exit(9), 9000)
`, {
    resume: { text: 'continue the unfinished task', delayMs: 300, idleMs: 100 },
    progress: 'clock',
    stuck: true,
    verifyMs: 600
  })

  assert.equal(run.status, 0, run.stderr)
  assert.doesNotMatch(run.stderr, /STUCK/, 'a prompt that started work is not stuck')
  assert.equal(run.result.code, 7)
  assert.equal(run.result.enterRetries, 0)
  assert.equal(run.result.stuck, 0)
})

test('a prompt stuck in the input box is pressed again and reported, never duplicated', () => {
  // The TUI keeps the text in its input box and nothing is recorded as work.
  // The watchdog presses Enter again, and then reports the prompt instead of
  // typing it in again: a second copy of the same text in the box is exactly
  // what made a real session look like it had two prompts. The session is left
  // running, so it is the session's own exit that ends it.
  const run = scenario(`'use strict'
process.stdin.setRawMode(true)
// A box that keeps drawing its hint row, with the typed text on the row below.
process.stdout.write('Enter a coding task or / for commands\\n')
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (chunk === '\\r') {
    process.stdout.write('ENTER PRESSED\\n')
    return
  }
  process.stdout.write('continue the unfinished task\\n')
})
setTimeout(() => process.exit(9), 12000)
`, {
    resume: { text: 'continue the unfinished task', delayMs: 300, idleMs: 100 },
    progress: 0,
    stuck: true,
    verifyMs: 600,
    maxRetries: 1,
    timeoutMs: 18000
  })

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /ENTER PRESSED/, 'Enter should be pressed again')
  assert.match(run.stderr, /STUCK/, 'the stuck prompt should be reported')
  assert.match(run.stderr, /continue the unfinished task/)
  assert.equal(run.result.enterRetries, 1, 'Enter should be pressed again once')
  assert.equal(run.result.resends, 0, 'the prompt must not be typed in again')
  assert.equal(run.result.stuck, 1)
  assert.equal(
    (run.stdout.match(/continue the unfinished task/g) || []).length,
    1,
    'the prompt should appear on screen only once'
  )
  assert.equal(run.result.code, 9, 'the session keeps running and ends on its own')
})

test('a prompt queued behind a running turn is left alone, not pressed at or typed again', () => {
  // freebuff keeps the text of a message that was submitted while a turn was
  // running visible in its input area until the turn ends. The old watchdog
  // read that as "still in the box", pressed Enter and then pasted the prompt a
  // second time, which is how one prompt turned into two. A turn that is really
  // running (its elapsed time is ticking) owns the session until it ends.
  const run = scenario(`'use strict'
const at = (row, col, text) => '\\u001b[' + row + ';' + col + 'H' + text
const paint = (lines) => process.stdout.write('\\u001b[2J' + lines.map((l, i) => at(i + 1, 1, l)).join(''))
process.stdin.setRawMode(true)
let typed = 0
let presses = 0
let seconds = 1
let ticker = null
paint(['⎘ • 1s • △▽', 'Enter a coding task or / for commands'])
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (chunk === '\\r') {
    presses += 1
    return
  }
  if (!chunk.includes('continue the unfinished task')) return
  typed += 1
  // The message was taken while a turn was running, so freebuff keeps it in
  // the box until that turn ends — and the turn keeps working, its clock
  // ticking, which is what a running turn looks like.
  if (ticker) return
  ticker = setInterval(() => {
    seconds += 1
    paint(['• Thinking', '│ continue the unfinished task │', '⎘ • ' + seconds + 's • △▽'])
  }, 500)
})
setTimeout(() => {
  if (ticker) clearInterval(ticker)
  process.stdout.write('TYPED ' + typed + ' PRESSES ' + presses + '\\n')
  process.exit(7)
}, 6000)
`, {
    resume: { text: 'continue the unfinished task', delayMs: 300, idleMs: 100 },
    progress: 0,
    stuck: true,
    verifyMs: 600,
    timeoutMs: 15000
  })

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /TYPED 1 PRESSES 1/, 'one paste and its one Enter only')
  assert.doesNotMatch(run.stderr, /STUCK/, 'a queued prompt is not an unsent one')
  assert.equal(run.result.resends, 0)
  assert.equal(run.result.stuck, 0)
  assert.doesNotMatch(run.stdout, /TYPED 2/, 'the prompt must not be typed in a second time')
  assert.equal(run.result.code, 7)
})

test('a sent prompt sitting in the conversation is not pressed at again', () => {
  // freebuff takes the message: it moves up into the conversation, above the
  // input box that draws its placeholder again. The old check saw the text on
  // screen and called the prompt unsent, which interrupted a session that had
  // done exactly what it was asked to do.
  const run = scenario(`'use strict'
process.stdin.setRawMode(true)
process.stdout.write('Your first message starts the session.\\n')
process.stdout.write('Enter a coding task or / for commands\\n')
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (chunk !== '\\r') return
  process.stdout.write('> continue the unfinished task\\n')
  process.stdout.write('Enter a coding task or / for commands\\n')
})
setTimeout(() => process.exit(7), 5000)
`, {
    resume: { text: 'continue the unfinished task', delayMs: 300, idleMs: 100 },
    progress: 0,
    stuck: true,
    verifyMs: 600
  })

  assert.equal(run.status, 0, run.stderr)
  assert.doesNotMatch(run.stderr, /STUCK/, 'a sent prompt is not an unsent one')
  assert.equal(run.result.enterRetries, 0, 'Enter must not be pressed into a sent prompt')
  assert.equal(run.result.resends, 0)
  assert.equal(run.result.code, 7)
})

test('a prompt the TUI dropped is typed in again as plain keys', () => {
  // A TUI that does not understand bracketed paste swallows the paste, so the
  // input box stays empty and pressing Enter at it sends nothing. The prompt
  // has to be written again — as ordinary keystrokes, which every TUI reads.
  const run = scenario(`'use strict'
process.stdin.setRawMode(true)
process.stdout.write('Your first message starts the session.\\n')
process.stdout.write('Enter a coding task or / for commands\\n')
process.stdin.setEncoding('utf8')
let typed = false
process.stdin.on('data', (chunk) => {
  if (chunk.includes('\\u001b[200~')) {
    // Bracketed paste is not understood, so the whole write is swallowed.
    process.stdout.write('PASTE IGNORED\\n')
    return
  }
  if (chunk === '\\r') {
    if (!typed) {
      process.stdout.write('ENTER IGNORED\\n')
      return
    }
    process.stdout.write('SENT\\n')
    process.exit(7)
  }
  if (chunk.includes('continue the unfinished task')) {
    typed = true
    process.stdout.write('TYPED KEYS\\n')
  }
})
setTimeout(() => process.exit(9), 12000)
`, {
    resume: { text: 'continue the unfinished task', delayMs: 300, idleMs: 100 },
    progress: 0,
    stuck: true,
    verifyMs: 600
  })

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /PASTE IGNORED/)
  assert.match(run.stdout, /TYPED KEYS/, 'the prompt should be typed again as keystrokes')
  assert.match(run.stdout, /SENT/, 'the typed prompt should then be sent')
  assert.doesNotMatch(run.stderr, /STUCK/, 'a prompt that got in is not stuck')
  assert.equal(run.result.resends, 2)
  assert.equal(run.result.code, 7)
})

test('a turn status row is only a turn while it is still moving', () => {
  // freebuff leaves the last turn's status row on screen after the turn ends
  // (`⎘ • 3s • △▽`, frozen at its final duration) and keeps the transcript's
  // own `• Thinking` line above the input box forever. Reading either as a
  // running turn is what left a dead session looking busy: no nudge, no retry,
  // no restart ever touched it.
  const at = (row, col, text) => `\u001b[${row};${col}H${text}`
  const frame = (rows) => '\u001b[2J' + rows.map((row, index) => at(index + 1, 1, row)).join('')

  const interrupted = frame([
    'Show 257 more lines',
    '• Thinking  Now run the tests again and check the picker. [response interrupted]',
    '⎘ • 3s • △▽',
    '╭──────────────────────────────────────────╮',
    '│ continue the unfinished task                │',
    '╰──────────────────────────────────────────╯'
  ])
  assert.equal(ptyrun.busyOnScreen(interrupted), true, 'the status row is still drawn')
  assert.equal(
    ptyrun.turnRunning(interrupted, Date.now() - 60000),
    false,
    'a status row that has stopped moving is not a running turn'
  )
  assert.equal(
    ptyrun.promptOnScreen(interrupted, 'continue the unfinished task'),
    true,
    'the message is still inside the bordered input box'
  )

  const running = frame([
    'Let me look at the tests.',
    '⎘ • 12s • △▽',
    'Enter a coding task or / for commands'
  ])
  assert.equal(ptyrun.turnRunning(running, Date.now()), true, 'a moving status row is a turn')

  // A message that was sent moves into the conversation without the box's
  // border, so a running turn no longer looks like an unsent prompt.
  const sent = frame([
    'Reply with OK and stop. Do not use tools. ⎘',
    'OK',
    '⎘ • 3s • △▽',
    'Enter a coding task or / for commands'
  ])
  assert.equal(
    ptyrun.promptOnScreen(sent, 'Reply with OK and stop. Do not use tools.'),
    false,
    'a sent message is not in the box'
  )
})

test('an interrupted turn left on screen does not hide a prompt that never went in', () => {
  // The state a 503 leaves behind: freebuff stops mid-turn, the transcript keeps
  // `• Thinking … [response interrupted]`, the status row stays frozen, and the
  // typed task is still in the input box. The supervisor must press Enter again
  // and then report it, instead of believing a turn is running forever.
  const run = scenario(`'use strict'
process.stdin.setRawMode(true)
const at = (row, col, text) => '\\u001b[' + row + ';' + col + 'H' + text
const paint = (lines) => process.stdout.write('\\u001b[2J' + lines.map((l, i) => at(i + 1, 1, l)).join(''))
// The TUI is ready: an empty input box, as freebuff draws it on start.
paint(['⎘ • 3s • △▽', 'Enter a coding task or / for commands'])
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (chunk === '\\r') {
    process.stdout.write('ENTER PRESSED\\n')
    return
  }
  if (!chunk.includes('continue the unfinished task')) return
  // The paste lands while freebuff is not taking messages: the turn was
  // interrupted, the status row froze, and the text stays in the box.
  paint([
    'Show 257 more lines',
    '• Thinking  Now run the tests again. [response interrupted]',
    '⎘ • 3s • △▽',
    '╭──────────────────────────────────╮',
    '│ continue the unfinished task       │',
    '╰──────────────────────────────────╯'
  ])
})
setTimeout(() => process.exit(9), 12000)
`, {
    resume: { text: 'continue the unfinished task', delayMs: 300, idleMs: 100 },
    progress: 0,
    stuck: true,
    verifyMs: 600,
    maxRetries: 1,
    timeoutMs: 18000
  })

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /ENTER PRESSED/, 'Enter should be pressed again')
  assert.match(run.stderr, /STUCK/, 'the prompt should be reported as stuck')
  assert.equal(run.result.stuck, 1)
  assert.equal(run.result.enterRetries, 1)
  assert.equal(run.result.code, 9)
})

test('a turn that keeps drawing is left alone, never interrupted with Esc', () => {
  // Real work keeps saying something new: streamed text, a command line, a tool
  // result, the turn's elapsed time. Esc must never be pressed into it — that
  // is what cut long test runs short and left `[response interrupted]` behind.
  const run = scenario(`'use strict'
const at = (row, col, text) => '\\u001b[' + row + ';' + col + 'H' + text
const paint = (lines) => process.stdout.write('\\u001b[2J' + lines.map((l, i) => at(i + 1, 1, l)).join(''))
process.stdin.setRawMode(true)
let step = 0
const timer = setInterval(() => {
  step += 1
  paint(['Writing file ' + step + '...', '⎘ • ' + step + 's • △▽'])
}, 400)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (chunk === '\\u001b') {
    process.stdout.write('INTERRUPTED\\n')
    process.exit(9)
  }
})
setTimeout(() => { clearInterval(timer); process.stdout.write('DONE\\n'); process.exit(7) }, 7000)
`, {
    progress: 0,
    timeoutMs: 15000
  })

  assert.equal(run.status, 0, run.stderr)
  assert.doesNotMatch(run.stdout, /INTERRUPTED/, 'a turn that is drawing must be left alone')
  assert.match(run.stdout, /DONE/)
  assert.equal(run.result.code, 7)
})

test('a screen that keeps drawing is left alone, not pressed at', () => {
  // Pressing Enter into a TUI that is mid-turn would type into the work. Only a
  // screen that has stopped moving can be a prompt waiting to be sent.
  const run = scenario(`'use strict'
process.stdin.setRawMode(true)
process.stdout.write('Your first message starts the session.\\n')
process.stdout.write('Enter a coding task or / for commands\\n')
process.stdin.setEncoding('utf8')
process.stdin.on('data', () => {})
const spinner = setInterval(() => {
  process.stdout.write('> continue the unfinished task · working...\\n')
}, 200)
setTimeout(() => { clearInterval(spinner); process.exit(7) }, 4000)
`, {
    resume: { text: 'continue the unfinished task', delayMs: 300, idleMs: 100 },
    progress: 0,
    stuck: true,
    verifyMs: 600,
    maxRetries: 2
  })

  assert.equal(run.status, 0, run.stderr)
  assert.doesNotMatch(run.stderr, /STUCK/, 'a drawing TUI must not be called stuck')
  assert.equal(run.result.enterRetries, 0)
  assert.equal(run.result.stuck, 0)
  assert.equal(run.result.code, 7)
})

test('a session that is never restarted gets no continue prompt', () => {
  const run = scenario(`'use strict'
process.stdout.write('Your first message starts the session.\\n')
process.stdout.write('Enter a coding task or / for commands\\n')
process.stdin.setEncoding('utf8')
process.stdin.once('data', () => {
  process.stdout.write('TYPED INTO\\n')
  process.exit(8)
})
setTimeout(() => process.exit(31), 3000)
`)

  assert.equal(run.status, 0, run.stderr)
  assert.doesNotMatch(run.stdout, /TYPED INTO/)
  assert.equal(run.result.code, 31)
  assert.equal(run.result.resumed, false)
})

test('a retry screen is pressed with Enter again each time it comes back', () => {
  // The task must not get stuck on freebuff's "Press Enter to retry" screen.
  const run = scenario(`'use strict'
let presses = 0
const ask = () => process.stdout.write('Press Enter to retry.\\n')
process.stdin.setEncoding('utf8')
process.stdin.on('data', () => {
  presses += 1
  if (presses >= 2) {
    process.stdout.write('RETRIED twice\\n')
    process.exit(7)
  }
  // A retry that fails again shows the same screen a moment later.
  setTimeout(ask, 4500)
})
ask()
setTimeout(() => process.exit(9), 16000)
`)

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /RETRIED twice/, 'Enter should have been pressed again')
  assert.equal(run.result.code, 7)
  assert.ok(run.result.answered >= 2, 'the repeatable retry rule should fire twice')
})

test('a session that is still producing output is not nudged', () => {
  const run = scenario(`'use strict'
let ticks = 0
process.stdin.setEncoding('utf8')
process.stdin.once('data', () => {
  console.log('NUDGED')
  process.exit(21)
})
const timer = setInterval(() => {
  ticks += 1
  console.log('working ' + ticks)
  if (ticks >= 6) { clearInterval(timer); process.exit(31) }
}, 400)
`, { nudge: { text: 'keep going', idleMs: 1000, max: 1 } })

  assert.equal(run.status, 0, run.stderr)
  assert.doesNotMatch(run.stdout, /NUDGED/)
  assert.equal(run.result.code, 31)
  assert.equal(run.result.nudges, 0)
})

test('a clean exit while the turn is still running is reported as cut off', () => {
  // freebuff sometimes quits on its own mid-turn and still exits 0. The exit
  // code alone would say "work finished", so the screen at exit is reported and
  // the supervisor resumes the conversation instead of closing the task.
  const run = scenario(`'use strict'
const at = (row, col, text) => '\\u001b[' + row + ';' + col + 'H' + text
process.stdout.write(at(1, 1, 'Let me run the tests.'))
process.stdout.write(at(2, 1, '• Thinking'))
setTimeout(() => {
  process.stdout.write(at(1, 1, 'Let me run the tests.  '))
  process.stdout.write(at(2, 1, '• Thinking          '))
}, 1200)
setTimeout(() => process.exit(0), 2400)
`)

  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.result.code, 0)
  assert.equal(run.result.busyAtExit, true, 'the turn was still running when it quit')
})

test('an unanswered dialog blocks the nudge, so it is never typed into', () => {
  const run = scenario(`'use strict'
console.log('Allow the agent to write files? (y/n)')
process.stdin.setEncoding('utf8')
process.stdin.once('data', () => {
  console.log('NUDGED')
  process.exit(21)
})
setTimeout(() => process.exit(41), 8000)
`, { nudge: { text: 'keep going', idleMs: 1000, max: 1 } })

  assert.equal(run.status, 0, run.stderr)
  assert.doesNotMatch(run.stdout, /NUDGED/, 'a nudge must not answer a dialog')
  assert.equal(run.result.code, 41)
  assert.equal(run.result.escalated, 1)
  assert.equal(run.result.nudges, 0)
})

test('ordinary output is passed straight through', () => {
  const run = scenario(`'use strict'
process.stdout.write('Wrote 3 files and ran the test suite.\\n')
process.exit(0)
`)

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /Wrote 3 files/)
  assert.equal(run.result.code, 0)
  assert.equal(run.result.answered, 0)
  assert.equal(run.result.escalated, 0)
})

test('a used-up free account is reported, never pressed at or called stuck', () => {
  // This is the screen freebuff leaves when the account has no free sessions
  // left. Pressing Enter at it sends nothing, and retiring it as a "stuck
  // prompt" restarted the same dead account until the loop gave up on a person.
  const run = scenario(`'use strict'
process.stdin.setRawMode(true)
const at = (row, col, text) => '\\u001b[' + row + ';' + col + 'H' + text
const paint = (lines) => process.stdout.write('\\u001b[2J' + lines.map((l, i) => at(i + 1, 1, l)).join(''))
paint(['Enter a coding task or / for commands'])
let typed = 0
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (chunk === '\\r') {
    process.stdout.write('ENTER PRESSED\\n')
    return
  }
  if (!chunk.includes('continue the unfinished task')) return
  typed += 1
  paint([
    'Session limit reached. See https://freebuff.com/plans or choose another model with /model.',
    '╭──────────────────────────────────────────────╮',
    '│ continue the unfinished task                  │',
    '╰──────────────────────────────────────────────╯'
  ])
})
setTimeout(() => {
  process.stdout.write('TYPED ' + typed + '\\n')
  process.exit(7)
}, 6000)
`, {
    resume: { text: 'continue the unfinished task', delayMs: 300, idleMs: 100 },
    progress: 0,
    stuck: true,
    limit: true,
    verifyMs: 600,
    // The line has to outlive a quiet window before it is believed; the test
    // must not wait out the real one.
    limitQuietMs: 1000,
    timeoutMs: 15000
  })

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /TYPED 1/, 'the task is typed once, not endlessly')
  assert.equal(
    (run.stdout.match(/ENTER PRESSED/g) || []).length,
    1,
    'only the resume key press, no retries at the limit screen'
  )
  assert.doesNotMatch(run.stderr, /STUCK/, 'a used-up account is not a broken input box')
  assert.ok(run.limit, 'the caller is told about the limit')
  assert.equal(run.limit.kind, 'session-limit')
  assert.equal(run.result.limit.kind, 'session-limit')
  assert.equal(run.result.enterRetries, 0)
  assert.equal(run.result.stuck, 0)
  assert.equal(run.result.code, 7)
})

test('a free session that ended has its message typed into the new session', () => {
  // freebuff says "send a message to start a new session and continue". The
  // supervisor does exactly that, instead of pressing Enter at the old one and
  // then giving up on the task.
  const run = scenario(`'use strict'
process.stdin.setRawMode(true)
const at = (row, col, text) => '\\u001b[' + row + ';' + col + 'H' + text
const paint = (lines) => process.stdout.write('\\u001b[2J' + lines.map((l, i) => at(i + 1, 1, l)).join(''))
paint(['Enter a coding task or / for commands'])
let typed = 0
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (chunk === '\\r') {
    process.stdout.write('ENTER PRESSED\\n')
    return
  }
  if (!chunk.includes('continue the unfinished task')) return
  typed += 1
  if (typed === 1) {
    // The first message arrived after the free session had already ended.
    paint([
      'Your free session ended before this message was processed. Send it again after starting a new session.',
      '╭──────────────────────────────────────────────╮',
      '│ continue the unfinished task                  │',
      '╰──────────────────────────────────────────────╯'
    ])
    return
  }
  process.stdout.write('RETYPED INTO THE NEW SESSION\\n')
  process.exit(7)
})
setTimeout(() => process.exit(9), 15000)
`, {
    resume: { text: 'continue the unfinished task', delayMs: 300, idleMs: 100 },
    progress: 0,
    stuck: true,
    limit: true,
    verifyMs: 600,
    timeoutMs: 20000
  })

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /RETYPED INTO THE NEW SESSION/, 'the task is sent into the new session')
  assert.doesNotMatch(run.stderr, /STUCK/, 'this is not a stuck prompt')
  assert.equal(run.limit.kind, 'session-ended')
  assert.equal(run.result.resumed, true)
  assert.equal(run.result.code, 7)
})

test('a decision spoken on the phone answers the dialog that rang it', () => {
  // The escalation is what rings the phone, so the answer has to reach the
  // dialog on screen. It is typed in only while that dialog is waiting.
  const run = scenario(`'use strict'
process.stdin.setRawMode(true)
process.stdout.write('Allow the agent to write files? (y/n)\\n')
process.stdin.setEncoding('utf8')
process.stdin.once('data', (chunk) => {
  process.stdout.write('ANSWERED FROM PHONE ' + JSON.stringify(chunk) + '\\n')
  process.exit(7)
})
setTimeout(() => process.exit(9), 8000)
`, {
    phoneAnswer: { keys: 'y\r' },
    timeoutMs: 15000
  })

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /ANSWERED FROM PHONE "y\\r"/)
  assert.equal(run.result.escalated, 1, 'the dialog is still reported as needing a person')
  assert.equal(run.result.remoteAnswers, 1)
  assert.equal(run.result.code, 7)
})

test('a free session that ends on its own is continued at once, not minutes later', () => {
  // The account's free session can end while the agent is working, with nothing
  // of ours waiting in the input box. freebuff says "send a message to start a
  // new session and continue", and only the idle nudge was left to do it — five
  // minutes later, so the task looked abandoned.
  const run = scenario(`'use strict'
const ESC = String.fromCharCode(27)
const at = (row, col, text) => ESC + '[' + row + ';' + col + 'H' + text
const paint = (lines) => process.stdout.write(ESC + '[2J' + lines.map((l, i) => at(i + 1, 1, l)).join(''))
process.stdin.setRawMode(true)
paint(['Enter a coding task or / for commands'])
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (chunk === '\\r') {
    process.stdout.write('ENTER PRESSED\\n')
    return
  }
  if (!chunk.includes('keep going')) return
  process.stdout.write('CONTINUED\\n')
  process.exit(7)
})
setTimeout(() => {
  paint(['Your free session ended, so the agent stopped here. Send a message to start a new session and continue.'])
}, 1200)
setTimeout(() => process.exit(9), 9000)
`, {
    nudge: { text: 'keep going', idleMs: 600000, max: 1 },
    progress: 0,
    limit: true,
    timeoutMs: 20000
  })

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /CONTINUED/, 'the task is sent into the new session')
  assert.equal(run.result.code, 7)
  assert.equal(run.limit.kind, 'session-ended')
  assert.equal(run.result.nudges, 0, 'this is not the five-minute idle nudge')
  assert.doesNotMatch(run.stderr, /STUCK/)
})

test('an interrupted turn is continued at once instead of waiting for the nudge', () => {
  // A stopped turn leaves `[response interrupted]` in the conversation and the
  // session sits there: it is alive, it has done no work since, and only a new
  // message starts it again.
  const run = scenario(`'use strict'
const ESC = String.fromCharCode(27)
const at = (row, col, text) => ESC + '[' + row + ';' + col + 'H' + text
const paint = (lines) => process.stdout.write(ESC + '[2J' + lines.map((l, i) => at(i + 1, 1, l)).join(''))
process.stdin.setRawMode(true)
paint(['Enter a coding task or / for commands'])
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (chunk === '\\r') return
  if (!chunk.includes('keep going')) return
  process.stdout.write('CONTINUED\\n')
  process.exit(7)
})
setTimeout(() => {
  paint([
    '• Thinking  Running the test suite. [response interrupted]',
    'Enter a coding task or / for commands'
  ])
}, 1000)
setTimeout(() => process.exit(9), 12000)
`, {
    nudge: { text: 'keep going', idleMs: 600000, max: 1 },
    progress: 0,
    timeoutMs: 20000
  })

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /CONTINUED/, 'the interrupted task is picked back up')
  assert.equal(run.result.code, 7)
  assert.equal(run.result.nudges, 0, 'this is not the five-minute idle nudge')
})

test('an agent writing about session limits does not retire the account', () => {
  // "Session limit reached. See https://freebuff.com/plans…" is freebuff's own
  // notice, and it is also a line an agent writes while it works on this very
  // repository. Acting on it retired a working session, took the account out of
  // rotation and reported a limit that did not exist.
  const run = scenario(`'use strict'
const ESC = String.fromCharCode(27)
const at = (row, col, text) => ESC + '[' + row + ';' + col + 'H' + text
const paint = (lines) => process.stdout.write(ESC + '[2J' + lines.map((l, i) => at(i + 1, 1, l)).join(''))
process.stdin.setRawMode(true)
let step = 0
const timer = setInterval(() => {
  step += 1
  paint([
    'Session limit reached. See https://freebuff.com/plans or choose another model with /model.',
    'Updated the README notice at step ' + step + '.',
    'Enter a coding task or / for commands'
  ])
}, 500)
process.stdin.setEncoding('utf8')
process.stdin.on('data', () => {})
setTimeout(() => { clearInterval(timer); process.exit(7) }, 5000)
`, { progress: 'clock', limit: true, timeoutMs: 15000 })

  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.limit, null, 'a working session has not run out of sessions')
  assert.equal(run.result.limit, null, 'the caller is not told about a made-up limit')
  assert.equal(run.result.code, 7)
})

test('a pty handle signals nothing once its session has ended', { skip: !ptyrun.available() }, () => {
  // The launcher schedules a SIGKILL a few seconds after retiring a session.
  // If the session exits first, that number is free for the kernel to hand to
  // another process, and node-pty's kill() passes it straight to
  // process.kill(). A delayed kill that landed on the desktop shell was what
  // reloaded it mid-task.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuffs-pty-kill-'))
  dirs.push(dir)
  const driver = path.join(dir, 'kill-after-exit.js')
  fs.writeFileSync(
    driver,
    `'use strict'
const { runOnPty } = require(${JSON.stringify(path.resolve(__dirname, '..', 'src', 'ptyrun'))})
let handle = null
runOnPty({
  binary: process.execPath,
  args: ['-e', 'process.exit(0)'],
  cwd: ${JSON.stringify(dir)},
  env: process.env,
  onSpawn: (spawned) => { handle = spawned }
}).then(() => {
  const calls = []
  const realKill = process.kill
  process.kill = (pid, signal) => { calls.push([pid, signal]); return true }
  const sent = handle.kill('SIGKILL')
  process.kill = realKill
  process.stderr.write('KILL ' + JSON.stringify({ sent, calls }) + '\\n')
  process.exit(0)
}).catch((error) => {
  process.stderr.write('ERROR ' + error.message + '\\n')
  process.exit(3)
})
`
  )

  const result = spawnSync(process.execPath, [driver], {
    encoding: 'utf8',
    timeout: 20000,
    env: process.env
  })
  const match = /KILL (\{.*\})/.exec(result.stderr || '')

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(match && JSON.parse(match[1]), { sent: false, calls: [] })
})
