'use strict'

/**
 * Real pty control of a session: typing into a box that only takes text once
 * it is clicked, and choosing rows in single- and multi-select questions.
 *
 * Each scenario runs the supervisor's own pty runner against a fake TUI in a
 * child process. Nothing real is launched and nothing outside the test's own
 * temporary home is touched: this is the failure the owner reported — freebuff
 * accepts no prompt until the input box is clicked with a mouse, and answers no
 * question at all unless the choice is navigated with the arrow keys.
 */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { removeTree } = require('./helpers')

const dirs = []
test.after(() => {
  for (const dir of dirs) removeTree(dir)
})

function scenario (tuiSource, {
  timeoutMs = 25000,
  resume = null,
  answer = null,
  sessionId = 'control-1'
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuffs-control-'))
  dirs.push(dir)
  const home = path.join(dir, 'home')
  fs.mkdirSync(path.join(home, 'run'), { recursive: true })
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true })
  const out = path.join(dir, 'tui-out.json')
  const tui = path.join(dir, 'fake-tui.js')
  fs.writeFileSync(tui, tuiSource.replace(/__OUT__/g, JSON.stringify(out)))

  const driver = path.join(dir, 'driver.js')
  fs.writeFileSync(driver, `'use strict'
const { runOnPty } = require(${JSON.stringify(path.resolve(__dirname, '..', 'src', 'ptyrun'))})
let ANSWER = ${answer ? JSON.stringify(answer) : 'null'}
runOnPty({
  binary: process.execPath,
  args: [${JSON.stringify(tui)}],
  cwd: ${JSON.stringify(dir)},
  sessionId: ${JSON.stringify(sessionId)},
  resume: ${JSON.stringify(resume)},
  takeAnswer: ${answer ? '() => { const a = ANSWER; ANSWER = null; return a }' : 'undefined'},
  env: { ...process.env, FREEBUFFS_HOME: ${JSON.stringify(home)} }
}).then((result) => {
  process.stderr.write('RESULT ' + JSON.stringify(result) + '\\n')
  process.exit(0)
}).catch((error) => {
  process.stderr.write('ERROR ' + error.message + '\\n')
  process.exit(3)
})
`)

  const run = spawnSync(process.execPath, [driver], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, FREEBUFFS_HOME: home }
  })
  const match = /RESULT (\{.*\})/.exec(run.stderr || '')
  return {
    status: run.status,
    stdout: run.stdout || '',
    stderr: run.stderr || '',
    result: match ? JSON.parse(match[1]) : null,
    out: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null,
    log: (() => {
      try {
        return fs.readFileSync(path.join(home, 'logs', 'supervisor.jsonl'), 'utf8')
      } catch {
        return ''
      }
    })()
  }
}

/** A frame that freebuff would draw: cursor moves, not newlines. */
function frame (rows) {
  return `\u001b[?1000h\u001b[?1006h\u001b[2J\u001b[H${rows
    .map((row, index) => `\u001b[${index + 1};1H${row}`)
    .join('')}`
}

test('a prompt is typed into a box that only takes text once it is clicked', () => {
  // This is freebuff's real behaviour: without a click in the input box the
  // paste and the Enter go nowhere, which is why nothing was ever sent.
  const run = scenario(`'use strict'
const fs = require('fs')
process.stdout.write(${JSON.stringify(frame([
    '╭──────────────────────────────────────╮',
    '│ ▍Enter a coding task or / for commands │',
    '╰──────────────────────────────────────╯',
    'MiMo v2.6 Flash Fast · /project · /model to change'
  ]))})
let focused = false
let typed = ''
process.stdin.setEncoding('utf8')
// A real TUI puts the terminal in raw mode: every key arrives immediately and
// nothing is echoed back into the screen the supervisor is reading.
if (process.stdin.setRawMode) process.stdin.setRawMode(true)
process.stdin.on('data', (chunk) => {
  if (/\\u001b\\[<0;\\d+;\\d+[Mm]/.test(chunk)) { focused = true; return }
  if (!focused) return
  typed += chunk.replace(/\\u001b\\[20[01]~/g, '').replace(/\\r/g, '')
  if (chunk.includes('\\r')) {
    fs.writeFileSync(__OUT__, JSON.stringify({ typed, focused }))
    process.exit(7)
  }
})
setTimeout(() => {
  fs.writeFileSync(__OUT__, JSON.stringify({ typed: '', focused }))
  process.exit(9)
}, 15000)
`, { resume: { text: 'click to focus test', delayMs: 300, idleMs: 100 } })

  assert.equal(run.status, 0, run.stderr)
  assert.ok(run.result, 'the driver should report a result')
  assert.equal(run.result.code, 7, 'the TUI decided how it exited')
  assert.ok(run.out, 'the TUI should have written what it received')
  assert.equal(run.out.focused, true, 'the input box must be clicked first')
  assert.match(run.out.typed, /click to focus test/)
})

test('a single-select question is answered by choosing the row', () => {
  const run = scenario(`'use strict'
const fs = require('fs')
const path = require('path')
const SESSION = 'control-1'
const livePath = path.join(process.env.FREEBUFFS_HOME, 'run', 'live-' + SESSION + '.json')
process.stdout.write(${JSON.stringify(frame([
    '╭──────────────────────────────────────╮',
    '│ Which option should run the task?    │',
    '│ ❯ 1. First                           │',
    '│   2. Second                          │',
    '│   3. Third                           │',
    '╰──────────────────────────────────────╯'
  ]))})
let cursor = 1
process.stdin.setEncoding('utf8')
// Raw mode, as a real TUI sets it: keys arrive one at a time and are not
// echoed back into the screen.
if (process.stdin.setRawMode) process.stdin.setRawMode(true)
process.stdin.on('data', (chunk) => {
  for (let i = 0; i < chunk.length; i += 1) {
    if (chunk[i] === '\\u001b' && chunk[i + 1] === '[') {
      const key = chunk[i + 2]
      if (key === 'A') cursor -= 1
      else if (key === 'B') cursor += 1
      i += 2
      continue
    }
    if (chunk[i] === '\\r') {
      let seen = null
      try { seen = JSON.parse(fs.readFileSync(livePath, 'utf8')) } catch {}
      fs.writeFileSync(__OUT__, JSON.stringify({
        cursor,
        liveQuestion: seen && seen.dialog ? seen.dialog.question : null,
        liveOptions: seen && seen.dialog ? seen.dialog.options.length : 0,
        liveMulti: seen && seen.dialog ? seen.dialog.multi : null
      }))
      process.exit(7)
    }
  }
})
setTimeout(() => {
  fs.writeFileSync(__OUT__, JSON.stringify({ cursor: 0 }))
  process.exit(9)
}, 20000)
`, { answer: { sessionId: 'control-1', choice: [2] } })

  assert.equal(run.status, 0, run.stderr)
  assert.ok(run.result, 'the driver should report a result')
  assert.equal(run.result.code, 7, 'the TUI decided how it exited')
  assert.equal(run.result.remoteAnswers, 1, 'one answer from the phone was typed in')
  assert.ok(run.out, 'the TUI should have written what it received')
  assert.equal(run.out.cursor, 2, 'the highlight must have moved to the second row')
  assert.match(run.log, /"event":"session\.dialog"/, 'the question is recorded')
  assert.match(run.log, /"event":"dialog\.escalate"/, 'an unanswered question is left for a person')
  assert.equal(run.out.liveQuestion, 'Which option should run the task?', 'the live state carries the question')
  assert.equal(run.out.liveOptions, 3, 'and its choices')
})

test('a multi-select question toggles exactly the chosen rows', () => {
  const run = scenario(`'use strict'
const fs = require('fs')
process.stdout.write(${JSON.stringify(frame([
    '╭──────────────────────────────────────╮',
    '│ Select the parts to clean?           │',
    '│ ❯ [ ] Alpha                          │',
    '│   [x] Beta                           │',
    '│   [ ] Gamma                          │',
    '│ Space toggles · Enter confirms       │',
    '╰──────────────────────────────────────╯'
  ]))})
let cursor = 1
const checked = { 1: false, 2: true, 3: false }
process.stdin.setEncoding('utf8')
if (process.stdin.setRawMode) process.stdin.setRawMode(true)
process.stdin.on('data', (chunk) => {
  for (let i = 0; i < chunk.length; i += 1) {
    if (chunk[i] === '\\u001b' && chunk[i + 1] === '[') {
      const key = chunk[i + 2]
      if (key === 'A') cursor -= 1
      else if (key === 'B') cursor += 1
      i += 2
      continue
    }
    if (chunk[i] === ' ') checked[cursor] = !checked[cursor]
    if (chunk[i] === '\\r') {
      fs.writeFileSync(__OUT__, JSON.stringify({ cursor, checked }))
      process.exit(7)
    }
  }
})
setTimeout(() => {
  fs.writeFileSync(__OUT__, JSON.stringify({ cursor: 0, checked }))
  process.exit(9)
}, 20000)
`, { answer: { sessionId: 'control-1', choice: [1, 3] } })

  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.result && run.result.code, 7, run.stderr)
  assert.ok(run.out)
  assert.deepEqual(run.out.checked, { 1: true, 2: false, 3: true }, 'exactly the chosen rows are on')
})
