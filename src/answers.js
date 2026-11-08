'use strict'

/**
 * Which freebuff dialogs the supervisor is allowed to answer by itself.
 *
 * Most of freebuff's dialog text comes from the agent back end, so it cannot be
 * enumerated in advance from the binary. Two consequence follow, and this file
 * is built around them:
 *
 *   1. A dialog that is not recognised is never guessed at. If it looks like an
 *      approval at all, it is escalated to the Discord webhook instead.
 *   2. Anything that would widen what the session can reach — sudo, network
 *      fetches, credentials, deleting things, publishing — is refused a
 *      self-answer even when the wording matches a safe pattern.
 *
 * `safe` entries are answered with their keystrokes; an entry marked
 * `repeat: true` is answered again each time it comes back (a retry screen),
 * rather than once per dialog. `unsafe` entries are only ever escalated. Both
 * are overridable with ~/.freebuffs/answers.json, so a dialog the supervisor
 * meets in the wild can be taught without editing code:
 *
 *   { "safe": [{ "name": "my-dialog", "match": "some text", "keys": "y\r" }],
 *     "unsafe": [{ "name": "my-risky-dialog", "match": "are you sure" }] }
 */

const fs = require('fs')
const path = require('path')
const { paths } = require('./paths')

/** Phrasing that means "yes, carry on" and cannot grant anything new. */
const SAFE = [
  // freebuff's "Enter: retry" / "Press Enter to retry" screen after a failed
  // admission. Enter only repeats the request that just failed, so it is safe
  // to press — and it must be pressable again for every later retry screen.
  {
    name: 'retry-enter',
    match: 'press enter to retry',
    keys: '\r',
    repeat: true
  },
  {
    name: 'retry-enter',
    match: 'enter: retry',
    keys: '\r',
    repeat: true
  },
  {
    name: 'retry-enter',
    match: 'enter to retry',
    keys: '\r',
    repeat: true
  },
  {
    name: 'enter-continue',
    match: 'press enter to continue',
    keys: '\r'
  },
  {
    name: 'plan-approval',
    match: 'The project plan is ready for approval',
    keys: '\r',
    // Its wording is a statement, not a question, but it is the dialog itself.
    explicit: true
  },
  {
    name: 'continue-path',
    match: 'continue this path',
    keys: 'y\r',
    explicit: true
  },
  {
    name: 'continue-work',
    match: 'continue working',
    keys: 'y\r'
  },
  {
    name: 'retry',
    match: 'try again',
    keys: 'y\r'
  },
  {
    name: 'keep-going',
    match: 'keep going',
    keys: 'y\r'
  },
  {
    name: 'trust-repository',
    match: 'Only load them if you trust this repository',
    keys: 'y\r',
    explicit: true
  }
]

/** Anything here needs a person, even when a safe phrase also matched. */
const UNSAFE = [
  { name: 'sudo', match: 'password for' },
  { name: 'sudo', match: 'sudo' },
  { name: 'credentials', match: 'credential' },
  { name: 'credentials', match: 'api key' },
  { name: 'credentials', match: 'access token' },
  { name: 'credentials', match: 'secret' },
  { name: 'destructive', match: 'delete' },
  { name: 'destructive', match: 'remove all' },
  { name: 'destructive', match: 'rm -rf' },
  { name: 'destructive', match: 'overwrite' },
  { name: 'network', match: 'npm install -g' },
  { name: 'network', match: 'pip install' },
  { name: 'network', match: 'curl' },
  { name: 'network', match: 'wget' },
  { name: 'publish', match: 'git push' },
  { name: 'publish', match: 'deploy' },
  { name: 'publish', match: 'publish' },
  { name: 'spend', match: 'payment' },
  { name: 'spend', match: 'subscribe' },
  { name: 'unidentified', match: 'could not say who is asking' }
]

/**
 * A dialog-shaped screen we do not recognise. Deliberately narrow: it needs an
 * approval word *and* a question mark, so ordinary agent output does not trip
 * it. Matching it only escalates; it never answers.
 */
const APPROVAL_WORD = /(approve|allow|deny|reject|permission|grant)\b/i

/**
 * How much of the stream is treated as "on screen".
 *
 * A blocking prompt is drawn at the bottom of the TUI, so only the last lines
 * can be one. The rest is the conversation: agent prose mentions deleting,
 * sudo, deploying and payments all the time, and treating those words as a
 * dialog froze real sessions (they set a pending dialog that blocked the
 * continue prompt and every nudge until the stall watch fired).
 */
const TAIL_LINES = 10

/**
 * A screen that could be carrying a prompt: a yes/no affordance, a line ending
 * in a question mark, or an instruction to press Enter. This gates the rules
 * that type an answer; escalation needs more than this (see AFFORDANCE below),
 * because the agent ends prose lines with a question mark too.
 */
const DIALOG_SHAPE = /(?:\(y\/n\)|\[y\/n\]|\(yes\/no\)|press enter|enter to (?:retry|continue|confirm|approve)|enter:\s*(?:retry|continue)|\?\s*$)/im

/** The last `count` non-empty lines, trimmed: the bottom of the screen. */
function screenTail (clean, count = TAIL_LINES) {
  return String(clean)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count)
}

function looksLikeDialog (screen) {
  return DIALOG_SHAPE.test(Array.isArray(screen) ? screen.join('\n') : String(screen))
}

/**
 * What an actual prompt offers a person: a yes/no marker, or an instruction to
 * press Enter. A bare question mark is not enough.
 *
 * The agent ends lines with a question mark in ordinary prose all the time
 * ("Should I also rename the handler?"). Counting that as a dialog-shaped
 * screen made any risky word in the conversation — delete, sudo, curl, api key
 * — a CRITICAL escalation: Discord pinged and the phone rang every few minutes
 * while the session was working normally. A prompt that really blocks has
 * something to answer, so only that is escalated.
 */
const AFFORDANCE = /(?:\(y\/n\)|\[y\/n\]|\(yes\/no\)|press enter|enter to (?:retry|continue|confirm|approve)|enter:\s*(?:retry|continue))/i

/**
 * The prompt at the bottom of the screen, or null: the line that offers the
 * affordance and the two lines below it, which is where a yes/no dialog puts
 * what it is about ("This step will run sudo rm -rf /" under "Keep going?").
 */
function blockingPrompt (screen) {
  const rows = Array.isArray(screen) ? screen : screenTail(screen)
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (AFFORDANCE.test(rows[index])) return rows.slice(index, index + 3)
  }
  return null
}

function configPath () {
  return path.join(paths().home, 'answers.json')
}

/**
 * The rules as last read, and the file identity they were read from.
 *
 * loadRules() runs for every chunk of the session's output (see decide), so
 * reading and parsing the file each time was a synchronous disk hit on a path
 * that usually does not exist — measured at ~150µs of the ~330µs a chunk cost.
 * The rules are re-read only when the file itself changes, so a dialog taught
 * with answers.json still applies on the next chunk.
 */
let cachedRules = null
let cachedKey = null

function rulesKey () {
  try {
    const stats = fs.statSync(configPath())
    // mtimeMs carries sub-millisecond precision where the filesystem does, so
    // two rewrites in the same second are still told apart.
    return `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`
  } catch {
    return 'builtin'
  }
}

/** User additions, so an unknown dialog does not need a code change. */
function loadRules () {
  const key = rulesKey()
  if (cachedRules && cachedKey === key) return cachedRules

  let raw
  try {
    raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
  } catch {
    const builtin = { safe: SAFE, unsafe: UNSAFE, from: 'builtin' }
    cachedRules = builtin
    cachedKey = key
    return builtin
  }

  const parse = (entries) => (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry.match === 'string' && entry.match.trim())
    .map((entry) => ({
      name: String(entry.name || 'custom'),
      match: entry.match,
      keys: typeof entry.keys === 'string' && entry.keys ? entry.keys : 'y\r',
      repeat: Boolean(entry.repeat),
      // A rule somebody wrote for their own dialog is taken at its word; a
      // built-in rule has to land on a dialog-shaped screen as well.
      explicit: entry.explicit !== false
    }))

  const safe = parse(raw && raw.safe)
  const unsafe = parse(raw && raw.unsafe)

  const rules = {
    safe: safe.length > 0 ? safe : SAFE,
    unsafe: unsafe.length > 0 ? unsafe : UNSAFE,
    from: configPath()
  }
  cachedRules = rules
  cachedKey = key
  return rules
}

/** Strip ANSI so escape codes cannot hide or fake a match. */
function plainText (value) {
  return String(value || '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
    .replace(/\r/g, '\n')
}

/**
 * Decide what to do about whatever is on screen.
 *
 * @returns {{action:'answer'|'escalate'|'none', name?:string, keys?:string, prompt?:string, reason?:string}}
 */
function decide (text, rules = loadRules()) {
  const clean = plainText(text)
  if (!clean.trim()) return { action: 'none' }

  // Only the bottom of the screen can be a blocking prompt. Everything above
  // it is conversation, and conversation uses the same words.
  const screen = screenTail(clean)
  const dialog = looksLikeDialog(screen)
  // Only a prompt that actually offers an answer can need a person. Escalating
  // on a question mark alone is what rang the phone about prose.
  const prompt = blockingPrompt(screen)

  // Dialog wording is not under our control and starts a sentence as often as
  // not, so every rule matches without regard to case.
  const haystack = screen.join('\n').toLowerCase()
  const matches = (rule) => haystack.includes(String(rule.match).toLowerCase())
  const promptText = prompt ? prompt.join('\n').toLowerCase() : ''
  const onPrompt = (rule) => promptText.includes(String(rule.match).toLowerCase())

  const unsafeHit = prompt && rules.unsafe.find(onPrompt)
  if (unsafeHit) {
    return {
      action: 'escalate',
      name: unsafeHit.name,
      reason: `matched the "${unsafeHit.name}" rule`,
      // The affordance row is what identifies the dialog. The lines under it
      // are its detail, and they change as the session draws (a log line, an
      // exit message), so they cannot be what says "this is the same
      // question" — that made one open dialog report itself again.
      question: prompt[0],
      prompt: excerpt(prompt.join('\n'), unsafeHit.match)
    }
  }

  const safeHit = rules.safe.find(matches)
  if (safeHit) {
    if (!dialog && !safeHit.explicit) return { action: 'none' }
    return {
      action: 'answer',
      name: safeHit.name,
      keys: safeHit.keys,
      repeat: Boolean(safeHit.repeat),
      prompt: excerpt(screen.join('\n'), safeHit.match)
    }
  }

  if (prompt && APPROVAL_WORD.test(prompt.join('\n'))) {
    return {
      action: 'escalate',
      name: 'unrecognised-approval',
      reason: 'looks like an approval dialog with no matching rule',
      question: prompt[0],
      prompt: prompt.join('\n')
    }
  }

  return { action: 'none' }
}

/** The matched line, trimmed, so a report shows what was on screen. */
function excerpt (clean, needle) {
  const lines = clean.split('\n').map((line) => line.trim()).filter(Boolean)
  const wanted = String(needle).toLowerCase()
  const line = lines.find((item) => item.toLowerCase().includes(wanted))
  return (line || clean.trim()).slice(-400)
}

module.exports = {
  SAFE,
  UNSAFE,
  TAIL_LINES,
  loadRules,
  decide,
  plainText,
  screenTail,
  blockingPrompt,
  looksLikeDialog,
  configPath
}
