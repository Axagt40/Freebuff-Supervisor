'use strict'

/**
 * The voice line: freebuff on the phone, over Tailscale.
 *
 * A tiny HTTP server on the supervisor machine serves one mobile page. The
 * page is the call: the phone's own speech recognition turns talk into text,
 * the supervisor answers in text, and the phone's own speech synthesis speaks
 * it back. Nothing leaves the tailnet except the optional ring, and there is no
 * per-minute model bill: iOS/Android system voices are free and the "brain" is
 * whatever local LLM the person already runs (Ollama by default), with a
 * deterministic fallback when none is installed.
 *
 * Two directions:
 *
 *   - the person calls freebuff by opening the page (Tailscale keeps it.
 *     private; `tailscale serve` gives it HTTPS, which iOS requires for the
 *     microphone).
 *   - freebuff calls the person when a session needs a decision: the
 *     supervisor posts a ring to this server, an open page speaks it, and a
 *     configured ntfy topic pushes it to the phone when the page is closed.
 *
 * The page is protected by a random token in its URL, and the server binds
 * loopback by default. Speech recognition and synthesis run on the phone, so
 * the server never receives audio at all.
 */

const crypto = require('crypto')
const fs = require('fs')
const { execFile } = require('child_process')
const http = require('http')
const path = require('path')
const { spawn } = require('child_process')
const { readConfig, writeConfig } = require('./config')
const { paths, ensureDirs } = require('./paths')
const { logLine, logEvent } = require('./log')
const { shortHome, formatDuration, isPidAlive, killIfMatches, safeUnlink } = require('./util')
const tailnet = require('./tailnet')

const DEFAULT_PORT = 8787
const DEFAULT_LLM_URL = 'http://127.0.0.1:11434/v1'
const DEFAULT_LLM_MODEL = 'qwen2.5:3b'
const NTFY_BASE = 'https://ntfy.sh'
const MAX_BODY = 256 * 1024
const MAX_PENDING = 20
const LLM_TIMEOUT_MS = 20 * 1000
const PUSH_TIMEOUT_MS = 8000
/**
 * How long a spoken reply waits for the model before the scripted answer is
 * said instead. A phone call cannot stay silent while a model thinks, and the
 * person on the other end hears that silence as "it is stuck".
 */
const REPLY_BUDGET_MS = 6000
/** Failed model calls in a row before the model is skipped for a while. */
const LLM_FAILURES_BEFORE_COOLDOWN = 2
const LLM_COOLDOWN_MS = 60 * 1000
/** How long a built state snapshot is reused; the page polls it while open. */
const STATE_CACHE_MS = 2000
/** How long the line may take to answer a liveness probe. */
const HEALTH_TIMEOUT_MS = 1500
/** The same call is not repeated while the question has not changed. */
const RING_REPEAT_MS = 10 * 60 * 1000
/** How much of the owner's own speaking instructions is kept and sent. */
const PERSONA_MAX = 2000
/** A ring must not hang: the call is spoken as soon as this much is known. */
const RING_TIMEOUT_MS = 4000
/** A short utterance recorded on the phone, before it is transcribed. */
const MAX_AUDIO = 8 * 1024 * 1024
const TRANSCRIBE_TIMEOUT_MS = 30 * 1000
/**
 * How often the line looks at the sessions itself. Anything under the two
 * minutes a session may be quiet is enough: the point is that "it stopped" is
 * known a moment after it happens, not at the next question.
 */
const SESSION_WATCH_MS = 15 * 1000
/**
 * The full Whisper, not the turbo distillate: turbo is faster but on short
 * Finnish utterances ("hyväksyn", "hylkää") it loses exactly the words this
 * line depends on.
 */
const WHISPER_MODEL = 'whisper-large-v3'
/** Bias for short, command-like Finnish: without it Whisper guesses a sentence. */
const WHISPER_PROMPT = 'Moro. Hyväksyn. Hylkää. Tila. Aloita. Lopeta. Kyllä. Ei. ' +
  'Montako istuntoa on käynnissä? Onko odottavia päätöksiä?'
/** Phrases the phone page prefers, in order, when it has them installed. */
const PREFERRED_VOICES = [
  'Samantha', 'Ava', 'Allison', 'Serena', 'Karen', 'Daniel',
  'Google US English', 'Microsoft Aria Online (Natural)'
]

function voiceDir () {
  return path.join(paths().home, 'voice')
}

function heartbeatPath () {
  return path.join(paths().runDir, 'voice.json')
}

/**
 * How the voice server's own command line looks. The heartbeat file outlives a
 * server that was killed hard or a machine that rebooted, and the pid in it is
 * then just a number: on a long-running machine it can belong to the desktop
 * shell or another supervisor. Signalling it without this check killed whatever
 * had inherited the number, and the supervisor asked every 30 seconds, so it
 * happened again and again.
 */
const VOICE_SERVER_COMMAND = /sfreebuff(?:\.js|\.cmd)?\s+voice\s+serve/

function pendingPath () {
  return path.join(voiceDir(), 'pending.json')
}

function answersPath () {
  return path.join(voiceDir(), 'answers.json')
}

function tokenPath () {
  return path.join(voiceDir(), 'token')
}

/** Tasks the phone handed to freebuff, waiting to be typed into a session. */
function tasksPath () {
  return path.join(voiceDir(), 'tasks.json')
}

function readTasks () {
  try {
    const raw = JSON.parse(fs.readFileSync(tasksPath(), 'utf8'))
    return Array.isArray(raw) ? raw.filter((item) => item && item.text) : []
  } catch {
    return []
  }
}

function writeTasks (list) {
  fs.mkdirSync(voiceDir(), { recursive: true })
  fs.writeFileSync(tasksPath(), `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Put work on freebuff's queue; the supervisor types it into the session.
 * `session` addresses one session when several are running; a task without it
 * belongs to whichever session is idle first.
 */
function queueTask (text, extra = {}) {
  const task = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 1500),
    ...extra
  }
  if (!task.text) return null
  if (!task.session) delete task.session
  const list = readTasks()
  list.push(task)
  writeTasks(list.slice(-20))
  logEvent('voice.task', { chars: task.text.length })
  return task
}

/**
 * The next task for a session, removed from the queue as it is handed over.
 * A task spoken for another session is left for that session; a task spoken
 * without one is for whichever session reads it first.
 */
function takeTask (sessionId) {
  const list = readTasks()
  const index = list.findIndex(
    (task) => !task.session || (sessionId && task.session === sessionId)
  )
  if (index < 0) return null
  const [next] = list.splice(index, 1)
  writeTasks(list)
  return next
}

function readPending () {
  try {
    const raw = JSON.parse(fs.readFileSync(pendingPath(), 'utf8'))
    return Array.isArray(raw) ? raw.filter((item) => item && item.id) : []
  } catch {
    return []
  }
}

function writePending (items) {
  try {
    fs.mkdirSync(voiceDir(), { recursive: true })
    const target = pendingPath()
    const temp = `${target}.tmp-${process.pid}`
    fs.writeFileSync(temp, `${JSON.stringify(items.slice(-MAX_PENDING), null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temp, target)
  } catch {
    // A pending list is best effort; a call must never break a session.
  }
}

/**
 * Answers spoken on the phone, waiting for their session to type them in.
 *
 * The voice server and a supervisor are separate processes, so a decision is
 * handed over as a small queue file: the supervisor that owns the dialog types
 * the key press into its pty, and only while a dialog is actually on screen.
 * Only yes/no are accepted, and they are explicit words ("approve", "deny"),
 * because a misheard "yes" must never authorize a risky action.
 */
function readAnswers () {
  try {
    const raw = JSON.parse(fs.readFileSync(answersPath(), 'utf8'))
    return Array.isArray(raw) ? raw.filter((item) => item && item.keys) : []
  } catch {
    return []
  }
}

function writeAnswers (items) {
  try {
    fs.mkdirSync(voiceDir(), { recursive: true })
    const target = answersPath()
    const temp = `${target}.tmp-${process.pid}`
    fs.writeFileSync(temp, `${JSON.stringify(items, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temp, target)
  } catch {
    // Best effort: a lost answer just leaves the dialog for a person.
  }
}

/**
 * Queue one answer for a session: a key press, a choice from the question on
 * screen, or words for a question that wants text. Older than 10 minutes is
 * stale.
 *
 * A choice is stored as the numbers the person saw, and resolved against the
 * live screen when it is typed in — so "two" always means the second row of
 * the dialog that is open, never a fixed key. That is what lets a multi-select
 * question be answered at all: choosing rows two and three arrows down and
 * toggles them, it does not send a `y`.
 */
function queueAnswer ({ sessionId, askId, keys, choice, text, now = Date.now() } = {}) {
  if (!sessionId) return false
  const entry = {
    id: crypto.randomUUID(),
    askId: askId || null,
    sessionId,
    at: new Date(now).toISOString()
  }
  if (choice !== undefined && choice !== null) {
    const numbers = require('./dialog').normaliseChoices(choice).slice(0, 9)
    if (numbers.length === 0) return false
    entry.choice = numbers
  } else if (typeof text === 'string' && text.trim()) {
    entry.text = text.trim().slice(0, 1000)
  } else if (typeof keys === 'string' && keys && keys.length <= 20) {
    entry.keys = keys
  } else {
    return false
  }
  const fresh = readAnswers().filter((item) => now - Date.parse(item.at) < 10 * 60 * 1000)
  fresh.push(entry)
  writeAnswers(fresh)
  return true
}

/** Take the next answer for this session, if one is waiting. */
function takeAnswer (sessionId, now = Date.now()) {
  if (!sessionId) return null
  const all = readAnswers()
  const fresh = all.filter((item) => now - Date.parse(item.at) < 10 * 60 * 1000)
  const index = fresh.findIndex((item) => item.sessionId === sessionId)
  if (index < 0) {
    if (fresh.length !== all.length) writeAnswers(fresh)
    return null
  }
  const [answer] = fresh.splice(index, 1)
  writeAnswers(fresh)
  return answer
}

/** The shared secret in the call URL. Generated once, never printed in logs. */
function token () {
  const stored = readConfig().voiceToken
  if (typeof stored === 'string' && /^[a-f0-9]{16,128}$/i.test(stored)) return stored

  const created = crypto.randomBytes(24).toString('hex')
  const config = readConfig()
  config.voiceToken = created
  writeConfig(config)
  logEvent('voice.token_created', {})
  return created
}

function safeEqual (left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/** Settings, with the environment able to override the stored values. */
function settings (env = process.env) {
  const config = readConfig()
  const stored = config.voice && typeof config.voice === 'object' ? config.voice : {}
  const port = Number(stored.port)
  return {
    enabled: Boolean(stored.enabled),
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
    host: typeof stored.host === 'string' && stored.host ? stored.host : '127.0.0.1',
    publicUrl: typeof stored.publicUrl === 'string' ? stored.publicUrl.replace(/\/+$/, '') : '',
    ntfy: typeof stored.ntfy === 'string' ? stored.ntfy : '',
    llmUrl: String(env.FREEBUFFS_VOICE_LLM_URL || stored.llmUrl || DEFAULT_LLM_URL).replace(/\/+$/, ''),
    llmModel: String(env.FREEBUFFS_VOICE_LLM_MODEL || stored.llmModel || DEFAULT_LLM_MODEL),
    // A key is only used for a hosted OpenAI-compatible endpoint; a local
    // Ollama needs none. Kept in config.json, which is mode 0600.
    llmKey: String(env.FREEBUFFS_VOICE_LLM_KEY || stored.llmKey || ''),
    voiceName: String(stored.voiceName || ''),
    voiceRate: Number(stored.voiceRate) > 0 ? Number(stored.voiceRate) : 1,
    // The owner's own description of how the line should talk, including
    // example lines. Appended to the model's prompt, never spoken by itself.
    persona: String(stored.persona || '').slice(0, PERSONA_MAX),
    lang: String(env.FREEBUFFS_VOICE_LANG || stored.lang || 'en-US')
  }
}

function updateSettings (patch) {
  const config = readConfig()
  const stored = config.voice && typeof config.voice === 'object' ? config.voice : {}
  config.voice = { ...stored, ...patch }
  writeConfig(config)
  return settings()
}

/** The language the phone speaks, listens to, and is answered in. */
function language (env = process.env) {
  return String(settings(env).lang || 'en-US')
}

function isFinnish (env = process.env) {
  return /^fi(?:[-_]|$)/i.test(language(env))
}

/**
 * Every spoken sentence exists in both languages, and the configured one is
 * the only one ever said or written back. Finnish is not a translation layer
 * over English text: the sentence is chosen before it is built.
 */
const t = (en, fi) => (isFinnish() ? fi : en)

/**
 * Turn the whole line on or off. Callers that want it listening now ask
 * ensureServer() themselves, so toggling a setting never races two servers.
 */
function setEnabled (value) {
  const enabled = Boolean(value)
  updateSettings({ enabled })
  if (enabled) {
    token()
  } else {
    stopServer()
  }
  logLine('info', enabled ? 'voice.enabled' : 'voice.disabled')
  logEvent('voice.toggle', { enabled })
  return settings()
}

function running () {
  try {
    const data = JSON.parse(fs.readFileSync(heartbeatPath(), 'utf8'))
    if (data && isPidAlive(data.pid)) return data
  } catch {
    // Not running.
  }
  return null
}

/** The URL to open on the phone, including the access token. */
function callUrl (env = process.env) {
  const current = settings(env)
  if (current.publicUrl) return `${current.publicUrl}/call/${token()}`
  // 127.0.0.1 is not an address a phone can open. The tailnet address is the
  // one the page is reachable on when no HTTPS URL has been set up.
  const site = tailnet.status()
  const host = site && site.ip ? site.ip : '127.0.0.1'
  return `http://${host}:${current.port}/call/${token()}`
}

function summary (env = process.env) {
  const current = settings(env)
  const live = running()
  const site = tailnet.status()
  return {
    enabled: current.enabled,
    running: Boolean(live),
    url: current.enabled || live ? callUrl(env) : '',
    port: current.port,
    host: current.host,
    ntfy: Boolean(current.ntfy),
    model: current.llmModel,
    llmUrl: current.llmUrl,
    pending: readPending().length,
    tailnet: {
      ip: site.ip,
      dnsName: site.dnsName,
      online: site.online,
      backendState: site.backendState,
      keyExpired: site.keyExpired,
      description: tailnet.describe(site)
    }
  }
}

/**
 * A plain summary of the supervisor for the spoken assistant and the phone's
 * status card. Never touches the network except for cached credits.
 *
 * The page asks for this every time it opens or refreshes, and building it
 * walks the state file, every account's credentials and every session's chat.
 * So the built answer is reused for a couple of seconds: a burst of loads (a
 * wake-up, a reload, the status line) costs one scan instead of one per
 * request, and the page is not left waiting on a folder scan.
 */
let snapshotCache = { key: '', at: 0, value: null }
let snapshotPending = null

/**
 * The cache is keyed by the home and the state file's write time, so a new
 * session, a removed account or a different supervisor home is never answered
 * from a snapshot that was built before it.
 */
function snapshotKey () {
  const current = paths()
  let stamp = 0
  try {
    stamp = fs.statSync(current.statePath).mtimeMs
  } catch {
    // No state file is its own key.
  }
  return `${current.home}|${stamp}`
}

async function snapshot (options = {}) {
  const ttl = options.cacheMs === undefined ? STATE_CACHE_MS : options.cacheMs
  const key = snapshotKey()
  if (
    !options.fresh &&
    snapshotCache.value &&
    snapshotCache.key === key &&
    Date.now() - snapshotCache.at <= ttl
  ) {
    return snapshotCache.value
  }
  // Two requests arriving together share one build instead of racing.
  if (snapshotPending) return snapshotPending
  snapshotPending = buildSnapshot()
    .then((value) => {
      snapshotCache = { key: snapshotKey(), at: Date.now(), value }
      return value
    })
    .finally(() => {
      snapshotPending = null
    })
  return snapshotPending
}

async function buildSnapshot () {
  const { loadState } = require('./state')
  const accounts = require('./accounts')
  const credits = require('./credits')
  const dashboard = require('./dashboard')

  let state = { accounts: [], sessions: [] }
  try {
    state = loadState()
  } catch {
    // Empty state is a valid answer.
  }

  const model = dashboard.collect({ now: Date.now() })
  const signedIn = state.accounts.filter(accounts.isSignedIn)
  let balances = new Map()
  try {
    balances = await credits.getAll(signedIn, { timeoutMs: 2500 })
  } catch {
    balances = new Map()
  }

  const creditsLine = signedIn.map((account) => {
    const balance = balances.get(account.id)
    if (balance && balance.ok) {
      return t(
        `${account.id}: ${balance.remaining} credits left`,
        `${account.id}: ${balance.remaining} krediittiä jäljellä`
      )
    }
    return t(`${account.id}: credits unavailable`, `${account.id}: krediitit eivät ole saatavilla`)
  })

  const live = model.sessions.filter((session) => session.alive)
  // Spoken: no paths. A folder read out loud is noise on a phone call.
  const sessionsLine = live.slice(0, 3).map((session) =>
    t(
      `${session.account} for ${formatDuration(session.elapsedMs)}`,
      `${session.account}, ${formatDuration(session.elapsedMs)}`
    )
  )
  // Written: the exact folders and ids, for the page's transcript.
  const sessionDetails = live.slice(0, 6).map((session) =>
    `${session.account} \u00b7 ${shortHome(session.cwd)} \u00b7 ${formatDuration(session.elapsedMs)}`
  )

  // What each session is doing right now, from the side monitors that publish
  // it every few seconds (and from freebuff's chat files when there is none).
  // This covers interrupted, idle, ended and lost sessions too, not only the
  // ones the dashboard still calls live.
  let sessionWork = []
  try {
    sessionWork = require('./work').sessions({ now: model.now })
  } catch {
    sessionWork = []
  }

  return {
    version: model.version,
    accounts: state.accounts.length,
    signedIn: signedIn.length,
    live: live.length,
    lost: model.lost,
    sessions: sessionsLine,
    sessionDetails,
    work: sessionWork,
    credits: creditsLine,
    pending: readPending(),
    voice: settings()
  }
}

/** Speakable, short sentences: this text is read aloud, not printed. */
async function statusSpeech () {
  const snap = await snapshot()
  const lines = []
  if (snap.signedIn === 0) {
    lines.push(t(
      'No freebuff account is signed in, so nothing can run.',
      'Yksikään freebuff-tili ei ole kirjautuneena, joten mitään ei voi ajaa.'
    ))
  } else {
    lines.push(t(
      `Freebuff has ${snap.signedIn} of ${snap.accounts} accounts signed in, and ${snap.live} live session${snap.live === 1 ? '' : 's'}.`,
      `Freebuff: ${snap.signedIn}/${snap.accounts} tiliä kirjautuneena, ${snap.live === 1 ? '1 istunto' : `${snap.live} istuntoa`} käynnissä.`
    ))
  }
  if (snap.sessions.length > 0) {
    lines.push(t(`Running: ${snap.sessions.join('; ')}.`, `Istunnot: ${snap.sessions.join('; ')}.`))
  }
  if (snap.pending.length > 0) {
    const ask = snap.pending[snap.pending.length - 1]
    lines.push(ask.speech || t(`One decision is waiting: ${ask.question}`, `Yksi päätös odottaa: ${ask.question}`))
  }
  return lines.join(' ')
}

function helpSpeech (snap) {
  const ask = snap.pending[snap.pending.length - 1]
  if (ask) {
    // A call that was phrased for the phone is said exactly as it rang; the
    // raw question is only for asks stored before that existed.
    if (ask.speech) return ask.speech
    const action = ask.action ? ` ${ask.action}` : ''
    return t(
      `Freebuff needs a decision. ${ask.question}${action}`,
      `Freebuff tarvitsee päätöksen. ${ask.question}${action}`
    )
  }
  return t(
    'Nothing needs you right now. You can ask for status, or say start or stop to control a session.',
    'Nyt ei tarvita sinua. Voit kysyä tilanteen tai sanoa aloita tai lopeta.'
  )
}

function listSpeech (snap) {
  if (snap.credits.length === 0) return t('No signed-in accounts to report.', 'Ei kirjautuneita tilejä.')
  return snap.credits.join('. ') + '.'
}

/** "valitse 2", "choose 1 and 3", "ota vaihtoehto 2". */
const CHOOSE_COMMAND = /^(?:valitse|ota|choose|select|pick)\s*(?:vaihtoehto|option|numero|number)?\s*((?:\d{1,2})(?:\s*(?:,|ja|and|\+|&)\s*\d{1,2})*)$/i

/** One key press, only while a question or an unsent prompt is waiting. */
const KEY_COMMAND = /^(?:paina\s+|press\s+)?(enter|return|esc|escape|tab|space|down|alas|up|ylös|ylos)$/i
const KEY_COMMAND_KEYS = {
  enter: '\r',
  return: '\r',
  esc: '\u001b',
  escape: '\u001b',
  tab: '\t',
  space: ' ',
  down: '\u001b[B',
  alas: '\u001b[B',
  up: '\u001b[A',
  ylös: '\u001b[A',
  ylos: '\u001b[A'
}

/** "mitä se kysyy", "näytä ruutu", "what is it asking". */
const DIALOG_QUESTION = /(?:mitä|mikä|mitkä)[^?]{0,40}(?:kysy|kysyy|kysymys|valinta|vaihtoeh)|(?:näytä|nayta|kerro)[^?]{0,24}(?:ruutu|ruudusta|näyttö|naytto|dialogi|kysymys)|what(?:'s| is| does)[^?]{0,40}(?:ask|asking|screen|dialog)|show (?:me )?(?:the )?(?:screen|dialog)/i

/** Local, deterministic commands. These work with no model installed. */
async function commandReply (text, snap, options = {}) {
  // Unicode letters are kept: "hyväksy" must not collapse to "hyv ks y" when
  // the ä is stripped, or a Finnish approval could never match.
  const said = ` ${String(text || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim()} `
  const has = (...words) => words.some((word) => said.includes(` ${word} `))
  // Destructive commands have to be short commands, not a sentence that
  // happens to contain the word: "the tests stopped" must never stop every
  // session on the machine. Finnish works the same way.
  const plain = said.trim()
  // A question mark, or a question word: those are answered by the line itself
  // instead of being handed to freebuff as work.
  const question = /\?\s*$/.test(String(text || '').trim())
  // A leading "istunnolle 2" / "account-2" picks the session, and the rest of
  // the sentence is the task or the question.
  const target = sessionTarget(plain)
  const body = target ? target.rest : plain
  // Read from the body, not the whole sentence, so a targeted stop
  // ("istunnolle 2 lopeta") stops that session instead of missing the command.
  const isStop = /^(?:please )?(?:stop|halt)(?: (?:it|everything|all|all sessions|the session|the sessions|now|please))*$/.test(body) ||
    /^(?:lopeta|seis|pysäytä|pysayta)(?: (?:kaikki|nyt|heti|se|istunto|istunnot))*$/.test(body)
  // "new session", "uusi istunto", "avaa uusi istunto": starting one is a
  // command, never something to queue for freebuff as work. The wrapper-less
  // forms are what people actually say on a phone.
  const isStart = /^(?:please )?(?:start|begin|launch|open|create)(?: (?:it|a|an|new|another|one|session|now|please))*$/.test(plain) ||
    /^(?:new|another)\s+(?:session|one)$/.test(plain) ||
    /^(?:aloita|käynnistä|kaynista|jatka|avaa|luo|perusta|lisää|lisaa)\s+(?:uusi\s+|uudet\s+|vielä\s+|viela\s+)?(?:istunto|istunnot|sessio|sessiot)$/.test(plain) ||
    /^(?:uusi|uudet)\s+(?:istunto|istunnot|sessio|sessiot)$/.test(plain) ||
    /^(?:aloita|käynnistä|kaynista|jatka)(?: (?:kaikki|nyt|se))*$/.test(plain)
  // Explicit words only: a misheard "yes" must not authorize sudo or a delete.
  const isApprove = /^(?:please )?(?:yes )?(?:approve|approve it|approved|allow|allow it|do it|go ahead)(?: please)?$/.test(plain) ||
    /^(?:hyväksy|hyvaksy|hyväksyn|hyvaksyn|salli|sallin|anna mennä|anna menna|ok|okei)$/.test(plain)
  const isDeny = /^(?:please )?(?:no|deny|deny it|denied|reject|cancel|do not|dont)(?: please)?$/.test(plain) ||
    /^(?:hylkää|hylkaa|hylkään|hylkaan|älä|ala|peruuta|estä|esta|ei)$/.test(plain)

  if (isApprove || isDeny) {
    // A question with choices is answered by choosing the row that means yes or
    // no, not by typing `y` at a list: on those screens a letter does nothing.
    const asking = dialogTarget(snap, resolveTarget(snap, target) ||
      (options.sessionId ? (snap.work || []).find((item) => item.sessionId === options.sessionId) : null))
    if (asking && asking.dialog && asking.dialog.options.length > 0) {
      const wanted = isApprove
        ? /^(?:yes|y|allow|approve|continue|proceed|ok|accept|trust|enable)\b/i
        : /^(?:no|n|deny|reject|cancel|stop|disable|skip)\b/i
      const option = asking.dialog.options.find((item) => wanted.test(String(item.text)))
      if (option) {
        queueAnswer({ sessionId: asking.sessionId, choice: [option.index] })
        logEvent('voice.answer', { session: asking.sessionId, option: option.index, approved: isApprove })
        return {
          reply: isApprove ? t('Approved.', 'Hyväksytty.') : t('Denied.', 'Hylätty.'),
          display: optionsList(asking),
          action: true
        }
      }
      return {
        reply: isApprove
          ? t(
              'I cannot tell which option means yes here. Say "choose 1" or "choose 2".',
              'En tiedä, kumpi näistä on kyllä. Sano "valitse 1" tai "valitse 2".'
            )
          : t(
              'I cannot tell which option means no here. Say "choose 1" or "choose 2".',
              'En tiedä, kumpi näistä on ei. Sano "valitse 1" tai "valitse 2".'
            ),
        display: optionsList(asking),
        action: true
      }
    }

    const ask = snap.pending[snap.pending.length - 1]
    if (!ask || !ask.sessionId) {
      // Saying approve with nothing waiting is not an error worth a sentence:
      // one word back, the same way a greeting is answered.
      return { reply: t('Okay.', 'Okei.'), action: true }
    }
    queueAnswer({
      sessionId: ask.sessionId,
      askId: ask.id,
      keys: isApprove ? 'y\r' : 'n\r'
    })
    writePending(readPending().filter((item) => item.id !== ask.id))
    logEvent('voice.answer', { ask: ask.id, session: ask.sessionId, approved: isApprove })
    return {
      reply: isApprove
        ? t('Approved. The session has been told to carry on.', 'Hyväksytty. Istunnolle kerrottiin, että se voi jatkaa.')
        : t('Denied. The session has been told no.', 'Hylätty. Istunnolle kerrottiin ei.'),
      action: true
    }
  }

  // A bare "yes"/"kyllä" is never enough to authorize anything.
  if (['yes', 'kyllä', 'kylla', 'joo'].includes(plain) && snap.pending.length > 0) {
    return {
      reply: t(
        'Say approve to authorize it, or deny to refuse.',
        'Sano hyväksy tai hylkää.'
      ),
      action: true
    }
  }

  if (isStop) {
    // "istunnolle 2 lopeta" retires that one and leaves the others running;
    // without a number the whole supervisor stops, as it always has.
    const wanted = resolveTarget(snap, target)
    if (target && !wanted) {
      return {
        reply: t('There is no session with that number.', 'Sellaista istuntoa ei ole.'),
        display: targetList(snap),
        action: true
      }
    }
    const dashboard = require('./dashboard')
    const live = dashboard.collect({ now: Date.now() }).sessions.filter((session) => session.alive)
    const doomed = wanted ? live.filter((session) => session.id === wanted.sessionId) : live
    if (doomed.length === 0) {
      return {
        reply: t(
          'No session is running, so there is nothing to stop.',
          'Yhtään istuntoa ei ole käynnissä, joten pysäytettävää ei ole.'
        ),
        action: true
      }
    }
    let stopped = 0
    for (const session of doomed) {
      if (dashboard.stopSession(session).ok) stopped += 1
    }
    if (wanted) {
      return {
        reply: t(
          `Asked ${wanted.account} to stop.`,
          `Pyydettiin ${wanted.account} lopettamaan.`
        ),
        action: true
      }
    }
    return {
      reply: t(
        `Asked ${stopped} session${stopped === 1 ? '' : 's'} to stop.`,
        `Pyydettiin ${stopped} ${stopped === 1 ? 'istunto' : 'istuntoa'} lopettamaan.`
      ),
      action: true
    }
  }

  if (isStart) {
    const dashboard = require('./dashboard')
    const model = dashboard.collect({ now: Date.now() })
    const account = model.accounts.find((item) => item.signedIn && !item.authFailed)
    if (!account) {
      return {
        reply: t(
          'No account can start a session yet. Sign one in from the dashboard first.',
          'Yhtään tiliä ei voi käynnistää. Kirjaudu ensin sisään dashboardista.'
        ),
        action: true
      }
    }
    // The same folder the running session is in: a second account picking up
    // the same project is the usual reason to ask for one from the phone. A
    // voice server started from somewhere unrelated still gets a real folder.
    const live = model.sessions.find((session) => session.alive && session.cwd && fs.existsSync(session.cwd))
    const cwd = (live && live.cwd) || process.cwd()
    const result = dashboard.startSession({ account, cwd })
    return {
      reply: result.ok
        ? (result.window === false
            ? t(
                `Started a session for ${account.id} in the background, in ${shortHome(cwd)}.`,
                `Aloitin istunnon tilille ${account.id} taustalle, kansioon ${shortHome(cwd)}.`
              )
            : t(`Starting a session for ${account.id}.`, `Aloitetaan istunto tilille ${account.id}.`))
        : t(`I could not start a session: ${result.reason}`, `Istunnon aloittaminen ei onnistunut: ${result.reason}`),
      action: true
    }
  }

  // "en tarkoittanut tuota" / "not that": the work is withdrawn here, by the
  // supervisor, and freebuff is told to forget it. "not that, but the last
  // part was correct" keeps the last part instead of throwing all of it away.
  const withdrawal = withdrawalFrom(plain)
  if (withdrawal) {
    const list = readTasks()
    const last = list[list.length - 1] || null
    const keep = withdrawal.partial && last ? lastClause(last.text) : ''
    const correction = keep
      ? 'Ignore the previous instruction except its last part. Do nothing else from the earlier message; work only on this: ' +
        `"${keep}".`
      : 'Cancel the previous instruction: I did not mean it. Do not do that work; stop and wait for a new message.'
    writeTasks([])
    queueTask(correction, last && last.session ? { session: last.session } : {})
    logEvent('voice.task_withdrawn', { count: list.length, partial: withdrawal.partial })
    return {
      reply: withdrawal.partial
        ? t('Right, only the last part stays.', 'Jees, jätetään vaan se viimeinen osa.')
        : t('Right, I told it to stop and forget that.', 'Jees, käskin sen lopettaa ja unohtaa ton.'),
      display: keep || correction,
      action: true
    }
  }

  // The queue itself, by voice: what is waiting, drop one, or drop all.
  // A task can be spoken while a session is busy — it waits its turn instead
  // of interrupting the turn that is running.
  // Lazy separators on purpose: greedy ones ate all but the last letter of the
  // new wording, so "muuta tehtävä 1 korjaa testit" edited it to "t".
  const editTarget = /(?:muuta|vaihda|p\u00e4ivit\u00e4|paivita|edit|change|replace)\D{0,14}?(\d{1,2})\D+?(.+)$/i.exec(plain)
  const appendTarget = /(?:lis\u00e4\u00e4|lisaa|append)\D{0,14}?(\d{1,2})\D+?(.+)$/i.exec(plain)
  const removeTarget = /(?:poista|peruuta|remove|cancel)\D{0,14}(\d{1,2})/i.exec(plain)
  const queueWord = has('jono', 'jonossa', 'jonoon', 'teht\u00e4v\u00e4t', 'tehtavat', 'teht\u00e4vi\u00e4', 'tehtavia', 'teht\u00e4v\u00e4\u00e4n', 'queue', 'tasks')
  if (queueWord || editTarget || appendTarget || removeTarget) {
    const list = readTasks()
    // Editing and appending are spoken the same way as anything else: number
    // the task, then say the words, and no buttons are involved.
    if (!removeTarget && (editTarget || appendTarget)) {
      const match = editTarget || appendTarget
      const index = Number(match[1]) - 1
      if (index < 0 || index >= list.length) {
        return { reply: t('There is no task with that number.', 'Sellaista numeroa ei ole jonossa.'), action: true }
      }
      const english = await englishTask(match[2].trim())
      if (editTarget) list[index].text = english
      else list[index].text = `${list[index].text} ${english}`.trim()
      writeTasks(list)
      logEvent('voice.task_edited', { edited: Boolean(editTarget) })
      return {
        reply: editTarget
          ? t('Changed.', 'Muutin sen.')
          : t('Added to it.', 'Lis\u00e4sin sen siihen.'),
        display: `${index + 1}. ${list[index].text}`,
        action: true
      }
    }
    if (queueWord && has('kaikki', 'tyhjenn\u00e4', 'tyhjenna', 'clear', 'empty', 'all')) {
      writeTasks([])
      logEvent('voice.tasks_cleared', { count: list.length })
      return { reply: t('Queue cleared.', 'Tyhjensin jonon.'), action: true }
    }
    const one = removeTarget
    if (one) {
      const index = Number(one[1]) - 1
      if (index < 0 || index >= list.length) {
        return { reply: t('There is no task with that number.', 'Sellaista numeroa ei ole jonossa.'), action: true }
      }
      const [gone] = list.splice(index, 1)
      writeTasks(list)
      logEvent('voice.task_removed', { count: list.length })
      return { reply: t(`Removed: ${gone.text}`, `Poistin: ${gone.text}`), display: gone.text, action: true }
    }
    if (list.length === 0) {
      return { reply: t('Nothing is queued.', 'Jonossa ei ole mit\u00e4\u00e4n.'), action: true }
    }
    const numbered = list.map((task, index) => `${index + 1}. ${task.text}`)
    // Said short, written complete: a long list of tasks should not be read out
    // in full on a phone call.
    const spoken = list.length === 1
      ? t(`One task is queued: ${list[0].text}`, `Jonossa on yksi teht\u00e4v\u00e4: ${list[0].text}`)
      : t(`${list.length} tasks are queued.`, `Jonossa on ${list.length} teht\u00e4v\u00e4\u00e4.`)
    return { reply: spoken, display: numbered.join('\n'), action: true }
  }

  // Which session the person means: "istunnolle 2 ..." / "account-2 ...".
  // With more than one session running, a task or a data question has to name
  // one instead of being sent to whoever happens to be idle.
  const chosen = resolveTarget(snap, target) ||
    (options.sessionId
      ? (snap.work || []).find((item) => item.sessionId === options.sessionId) || null
      : null)
  if (target && !chosen) {
    return {
      reply: t('There is no session with that number.', 'Sellaista istuntoa ei ole.'),
      display: targetList(snap),
      action: true
    }
  }
  const needsTarget = workList(snap).length > 1 && !target

  // A question on screen is answered by choosing a row, not by typing a task:
  // "valitse 2" resolves against the dialog that is open right now.
  const choiceCommand = CHOOSE_COMMAND.exec(String(body).trim())
  if (choiceCommand) {
    const asked = dialogTarget(snap, chosen)
    if (!asked) {
      return {
        reply: t('No session is asking a question right now.', 'Mikään istunto ei kysy nyt mitään.'),
        display: targetList(snap),
        action: true
      }
    }
    const numbers = require('./dialog').normaliseChoices(choiceCommand[1])
    queueAnswer({ sessionId: asked.sessionId, choice: numbers })
    logEvent('voice.choice', { session: asked.sessionId, choice: numbers })
    return {
      reply: numbers.length === 1
        ? t(`Chose option ${numbers[0]}.`, `Valitsin vaihtoehdon ${numbers[0]}.`)
        : t(`Chose options ${numbers.join(' and ')}.`, `Valitsin vaihtoehdot ${numbers.join(' ja ')}.`),
      display: optionsList(asked),
      action: true
    }
  }

  // One key press: Enter to confirm, Esc to close a question, arrows to move.
  // Only while something is actually waiting, so a word cannot press keys into
  // a running turn.
  const keyCommand = KEY_COMMAND.exec(String(body).trim())
  if (keyCommand) {
    const asking = dialogTarget(snap, chosen) ||
      (snap.work || []).find((item) => item.live !== false && item.unsent)
    if (!asking) {
      return {
        reply: t('Nothing is waiting for a key press right now.', 'Mikään ei odota näppäintä juuri nyt.'),
        action: true
      }
    }
    const key = String(keyCommand[1]).toLowerCase()
    // Esc stops a turn when no question is open; here it only closes a dialog.
    if (/^esc/.test(key) && !asking.dialog) {
      return {
        reply: t('Esc would stop the turn, so I left it alone.', 'Esc lopettaisi työn, joten jätin sen painamatta.'),
        action: true
      }
    }
    queueAnswer({ sessionId: asking.sessionId, keys: KEY_COMMAND_KEYS[key] })
    logEvent('voice.key', { session: asking.sessionId, key: /^[a-zäö]+$/i.test(key) ? key : 'key' })
    return { reply: t('Pressed it.', 'Painoin sen.'), display: optionsList(asking), action: true }
  }

  // What is on screen, in words: the question reads out loud, the rows stay on
  // the page. This is the live view the phone exists for.
  if (DIALOG_QUESTION.test(body)) {
    const asking = dialogTarget(snap, chosen)
    if (!asking) {
      return {
        reply: t('No session is asking anything right now.', 'Mikään istunto ei kysy nyt mitään.'),
        display: targetList(snap),
        action: true
      }
    }
    const question = String(asking.dialog.question || '').trim()
    const options = asking.dialog.options
      .map((item) => `${item.index}: ${item.text}`)
      .join(', ')
    return {
      reply: t(
        `The session is asking: ${question || 'a question'}. The options are ${options}.`,
        `Istunto kysyy: ${question || 'kysymys'}. Vaihtoehdot: ${options}.`
      ),
      display: [optionsList(asking), screenDetail(asking)].filter(Boolean).join('\n---\n'),
      action: true
    }
  }

  // Work for freebuff itself: an instruction is handed to the session instead
  // of being answered as chat. This is the whole point of talking to the line:
  // say it, and the project gets it. A wrapper ("lisää istunto joka ...",
  // "voisitko ...") is stripped first, so the session gets the task itself.
  const asked = taskFrom(body)
  if (asked) {
    if (needsTarget) return targetQuestion(snap)
    return taskReply(asked, snap, chosen && chosen.sessionId)
  }

  if (has('credits', 'balance', 'credit', 'krediitit', 'kreditit', 'saldo')) return listSpeech(snap)

  // What the session is doing right now, and whether it is doing anything at
  // all. A live session that has written nothing for minutes is waiting, not
  // working, and the two answers must not sound the same.
  if ((question || CHAT_OPENER.test(body)) && WORK_QUESTION.test(body)) {
    if (needsTarget) return targetQuestion(snap)
    // The live screen wins over the transcript: a question on screen is why
    // nothing is happening, and a running turn is what is happening.
    return { reply: workSpeech(snap, chosen), display: workDetail(snap, chosen) }
  }

  // What is done, and what is still in progress.
  if (PROGRESS_QUESTION.test(body)) {
    const item = chosen ||
      (snap.work || []).find((row) => row.live !== false) ||
      (snap.work || [])[0]
    if (!item) {
      return {
        reply: t(
          'No session is running, so nothing has been done.',
          'Ei oo istuntoo auki, joten mitään ei oo tehty.'
        ),
        action: true
      }
    }
    return { reply: progressSpeech(item), display: recentDetail(item) }
  }

  if (has(
    'help', 'needs me', 'need me', 'decision', 'problem', 'wrong', 'stuck', 'status', 'doing', 'going',
    'apua', 'tila', 'tilanne', 'kuulumiset', 'ongelma', 'jumissa', 'vika', 'kiinni', 'kuuluu'
  )) {
    return snapshotHelp(snap)
  }

  if (has('test', 'call', 'ring', 'testi', 'soita', 'puhelu')) {
    await ring({
      kind: 'test',
      question: t('This is a test call from freebuff.', 'Tämä on testisoitto freebuffista.')
    })
    return {
      reply: t('This is a test call. The line works.', 'Tämä on testisoitto. Linja toimii.'),
      action: true
    }
  }

  // A greeting is answered with a greeting, not a status report: the person
  // says hello to start talking, and asks for the status when they want it.
  // Short is the point - one word back, then wait for the instruction.
  const greeting = [
    ['moro', 'Moro.'],
    ['moi', 'Moi.'],
    ['hei', 'Hei.'],
    ['terve', 'Terve.'],
    ['huomenta', 'Huomenta.'],
    ['päivää', 'Päivää.'],
    ['iltaa', 'Iltaa.']
  ].find(([word]) => has(word))
  if (greeting) return t('Hello.', greeting[1])
  if (has('hello', 'hi', 'hey')) return t('Hello.', 'Moro.')

  // No magic phrase needed: the line is freebuff's input box on the phone, so
  // anything that is an instruction rather than a question or small talk is
  // work. This runs after the commands above on purpose, so "näytä krediitit"
  // still reports credits instead of becoming a task.
  const broad = taskFrom(body, { broad: true, question })
  if (broad) {
    if (needsTarget) return targetQuestion(snap)
    return taskReply(broad, snap, chosen && chosen.sessionId)
  }

  return null
}

function snapshotHelp (snap) {
  const { speech, detail } = statusParts(snap)
  if (snap.pending.length > 0) return { reply: helpSpeech(snap), display: detail }
  return { reply: speech, display: detail }
}

/**
 * Split a status into what is said and what is only written: counts and
 * durations are spoken, paths and ids are left on the page to be read.
 */
function statusParts (snap) {
  return {
    speech: statusSpeechSync(snap),
    detail: Array.isArray(snap.sessionDetails) ? snap.sessionDetails.join('\n') : ''
  }
}

function statusSpeechSync (snap) {
  const parts = [
    t(
      `${snap.live} live session${snap.live === 1 ? '' : 's'}.`,
      `${snap.live === 1 ? '1 istunto' : `${snap.live} istuntoa`} käynnissä.`
    )
  ]
  if (snap.sessions.length > 0) {
    parts.push(t(`Running: ${snap.sessions.join('; ')}.`, `Istunnot: ${snap.sessions.join('; ')}.`))
  }
  // A question waiting on screen is the most useful thing to say: the session
  // cannot do anything at all until somebody answers it.
  const asking = dialogSessions(snap)[0]
  if (asking && asking.dialog) {
    const options = asking.dialog.options
      .map((option) => `${option.index}: ${option.text}`)
      .join(', ')
    parts.push(t(
      `A session is waiting for an answer: ${asking.dialog.question || 'a question'} The options are ${options}.`,
      `Yksi istunto odottaa vastausta: ${asking.dialog.question || 'kysymys'} Vaihtoehdot: ${options}.`
    ))
  }
  // A live session that stopped working is the thing worth saying: nothing is
  // on fire, but nothing is happening either, and it is about two minutes old.
  const idle = (snap.work || []).filter(
    (item) => item.live !== false && item.phase !== 'working' && item.phase !== 'unknown'
  )
  if (idle.length > 0) {
    const described = idle.map((item) => {
      const ago = quietAgo(item.quietMs)
      return `${item.account}: ${item.phase}${ago ? `, ${ago}` : ''}`
    })
    parts.push(t(
      `Not working: ${described.join(', ')}.`,
      `Ei työstä: ${described.join(', ')}.`
    ))
  }
  parts.push(t('Nothing is waiting on you.', 'Mitään ei odota sinua.'))
  return parts.join(' ')
}

/**
 * The answer to one spoken turn.
 *
 * Anything with a side effect (approve, deny, stop, start, ring) is handled
 * deterministically: a model must never decide whether a session stops. Every
 * other reply is the model's when one is reachable, in the owner's own style;
 * the scripted sentence is only the backup for when it is not.
 */
async function answer (text, options = {}) {
  // A turn is decided on what is true now: the page may reuse a snapshot for a
  // couple of seconds, but a decision must never be answered from a list that
  // still holds a question somebody already answered.
  const snap = await snapshot({ fresh: true })
  const command = await commandReply(text, snap, options)
  if (command) {
    const info = typeof command === 'string' ? { reply: command } : command
    const llm = options.llm || llmReply
    // A hosted model is the voice whenever it can be reached; a local one on a
    // small laptop is not worth a 20 s wait, so it never delays the scripted
    // reply either.
    const modelPossible = Boolean(options.llm) || Boolean(settings().llmKey)
    if (!info.action && modelPossible) {
      const spoken = await withinBudget(llm(text, snap, options), options.replyBudgetMs)
      if (spoken) {
        return { reply: spoken, source: 'model', display: info.display || '' }
      }
    }
    // A command may carry a written half (paths, ids) that must not be read
    // aloud; the page prints it under the spoken sentence.
    return { reply: info.reply, source: 'supervisor', display: info.display || '' }
  }

  const llm = options.llm || llmReply
  const reply = await withinBudget(llm(text, snap, options), options.replyBudgetMs)
  if (reply) return { reply, source: 'model' }

  return {
    reply: t(
      'I can report status, read a decision that is waiting, check credits, or start and stop a session. ' +
      'Say status, help, credits, start, or stop.',
      'Voin kertoa tilanteen, lukea odottavan päätöksen, tarkistaa krediitit tai käynnistää ja lopettaa istunnon. ' +
      'Sano tila, apua, krediitit, aloita tai lopeta.'
    ),
    source: 'fallback'
  }
}

/**
 * The instruction as freebuff should receive it: one English imperative line.
 * Deliberately its own tiny call, so a translation failure never turns into a
 * lost task: the spoken Finnish is queued unchanged instead.
 */
async function englishTask (text, options = {}) {
  const current = settings()
  if (!current.llmKey) return text
  const fetchImpl = options.fetch || globalThis.fetch
  try {
    const response = await fetchImpl(`${current.llmUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${current.llmKey}`
      },
      body: JSON.stringify({
        model: current.llmModel,
        temperature: 0,
        max_tokens: 160,
        messages: [
          {
            role: 'system',
            content: 'Translate the instruction into one clear, imperative English sentence for a coding agent. ' +
              'Keep file names, paths and identifiers exactly as they are. Return only the translation.'
          },
          { role: 'user', content: String(text) }
        ]
      }),
      signal: AbortSignal.timeout(options.timeoutMs || 6000)
    })
    if (!response.ok) return text
    const data = await response.json()
    const content = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content
    if (typeof content !== 'string') return text
    const line = content.replace(/\s+/g, ' ').trim().replace(/^["'`]+|["'`]+$/g, '')
    return line || text
  } catch {
    return text
  }
}

/**
 * The work part of what was said, or null when it is conversation.
 *
 * The line is freebuff's input box on the phone, so an instruction does not
 * need a magic opening; what it does need is for the wrapper to be left
 * behind. "lisää istunto tehtävä joka korjaa bugeja" and "voisitko korjata
 * bugeja" both reach the session as "korjaa bugeja". A plain instruction
 * ("korjaa se bugi") goes as it was said, verb included, because "se bugi"
 * alone is a fragment freebuff would have to guess about. With `broad`,
 * anything that is not a question or small talk is work too, so a sentence
 * does not have to start with a task verb.
 */
// No \b after a verb: it is ASCII-only, and a Finnish verb ending in ä ("lisää",
// "pistä", "päivitä") has no word boundary before the space, so those verbs
// never matched and their sentences fell through to the model as chat.
const TASK_VERB = /^(?:(?:hei|moro|moi|no|ookoo|okei|please)\s+)?(?:laita|laittaa|pistä|pista|pistää|pistaa|työnnä|tyonna|tee|tehdä|tehda|hoida|korjaa|korjata|fiksaa|fiksata|lisää|lisaa|lisätä|lisata|rakenna|rakentaa|toteuta|toteuttaa|siivoa|siivota|päivitä|paivita|päivittää|paivittaa|testaa|testata|debuggaa|debugata|fix|add|remove|delete|refactor|update|upgrade|build|implement|clean|test|debug|write|create|rename|move|improve|change|investigate|document|optimize|optimise|migrate|check|ensure|install|configure|deploy|release|bump|format|lint|review|audit|simplify|split|extract|replace)(?:\s+(.*))?$/i

/** A request wrapper: "voisitko korjata bugin". The wrapper is not the task. */
const TASK_REQUEST = /^(?:(?:hei|moro|moi|no|ookoo|okei|please)\s+)?(?:voisitko|voisitkos|voitko|voisit|pystyisitkö|pystyisitko|viitsitkö|viitsitko|jaksatko|haluaisin että|haluan että|tarvisin että|tarvitsen että|can you|could you|would you|will you|i need you to|i want you to|i'd like you to|i would like you to|go ahead and|please)\s+(.+)$/i

/** Nouns that mean a piece of work: "lisää istunto tehtävä joka ...". */
const TASK_NOUN =
  '(?:istunto\\w*|tehtävä\\w*|tehtava\\w*|homm\\w*|työ\\w*|tyo\\w*|juttu\\w*|sessio\\w*|keikka\\w*|ajo|session\\w*|task\\w*|job\\w*|ticket\\w*|work\\s+item)'

/** Verbs that mean "put this on freebuff's queue". */
const SCHEDULE_VERB =
  '(?:lisää|lisaa|lisätä|lisata|tee|tehdä|tehda|laita|pistä|pista|työnnä|tyonna|luo|perusta|avaa|aloita|käynnistä|kaynista|anna|add|create|make|start|queue|give|open)'

/** "lisää istunto tehtävä joka korjaa bugeja" -> the work after the wrapper. */
const TASK_FRAME = new RegExp(
  '^(?:(?:hei|moro|moi|no|ookoo|okei|please)\\s+)?' + SCHEDULE_VERB +
  '\\s+(?:minulle|mul(?:l)?e|uusi|uudet|vielä|viela|another|a|an|one|new|up|for\\s+me)?\\s*' +
  TASK_NOUN + '(?:\\s+' + TASK_NOUN + ')*' +
  '\\s*(?:(?:joka|jotka|jossa|johon|jolla|josta|että|etta|siten\\s+että|siten\\s+etta|that|which|where|and|to)\\s+)?' +
  '(.+)$',
  'i'
)

/** Talk that is not work: greetings, thanks, acknowledgements. */
const SMALL_TALK = /^(?:kiitos|kiitti|kiitoksia|thanks|thank you|cheers|bye|moi moi|nähdään|nahdaan|ok|okei|okay|selvä|selva|joo|juu|jep|kyllä|kylla|ei|no|noniin|hyvä|hyva|hienoa|mahtavaa|loistavaa|great|nice|cool|perfect|good|hei|moi|moro|terve|huomenta|päivää|paivaa|iltaa|hello|hi|hey)$/i

/** Openers that mean a question, which the line answers instead of queueing. */
const CHAT_OPENER = /^(?:mitä|mika|mikä|mitkä|miksi|miten|kuinka|montako|monenko|onko|eikö|oletko|kerro\w*|kerto\w*|selit\w*|selost\w*|näyt\w*|what|why|how|when|where|who|whom|which|whose|is|are|was|were|am|do|does|did|can|could|would|will|should|may|might|tell|explain|show|list|describe)(?:\s|$)/i

/** "What are you working on?", "is it actually working?" — answered by work.js. */
const WORK_QUESTION = /(?:mitä\s+(?:sinä\s+)?(?:nyt\s+)?(?:teet|tekee|työstät|työstää)|mitä\s+on\s+(?:työn\s+alla|kesken|meneillään)|(?:työn\s+alla|kesken|meneillään)|onko\s+(?:se|istunto)\s+(?:töissä|kiireinen|odottamassa|jumissa|tekemässä)|what(?:'s| is)?\s+(?:it|the session|you)\s+(?:working on|doing)|what are you (?:working on|doing)|is it (?:working|stuck|waiting|idle|busy))/i

/**
 * "What is done so far?", "how much is left?" — answered from the steps the
 * session has recorded, not from the last prompt. This is the question a person
 * asks halfway through a long task.
 */
const PROGRESS_QUESTION = /(?:mitä\s+(?:on\s+)?(?:jo\s+)?(?:tehty|valmiina|valmista|saatu|aikaan)|mitä\s+on\s+(?:vielä\s+|enää\s+)?(?:jäljellä|jaljella|kesken)|missä\s+(?:mennään|menee)|onko\s+(?:jo\s+)?valmis|valmistuiko|kuinka\s+paljon\s+on\s+(?:jäljellä|jaljella)|what(?:'s| is)\s+(?:been\s+)?(?:done|finished)|what(?:'s| is)\s+(?:left|in progress)|what have you done|how (?:far|much (?:is )?left)|progress so far)/i

/**
 * A correction to what was already asked: "en tarkoittanut tuota" withdraws
 * the work, "not that, but the last part was correct" keeps only the last
 * clause. Only a short sentence counts, so an instruction that merely starts
 * with "not that" plus a new task is not swallowed.
 */
function withdrawalFrom (plain) {
  const text = String(plain || '').trim()
  if (!text) return null
  const partial = /(?:viimeinen|jälkimmäinen|jalkimmainen|loppuosa|loppu|last\s+part|last\s+bit)/i.test(text) &&
    /(?:oikein|oikea|correct|right)/i.test(text)
  const opener = /^(?:en\s+tarkoittanut|en\s+tarkottanut|en\s+tarkoita|ei\s+(?:tuota|tota|noin|sita|sitä)|not\s+that|that\s+was\s+wrong|i\s+(?:didn'?t|did\s+not)\s+mean|älä\s+(?:lähetä|laheta|tee|jatka)|ala\s+(?:laheta|tee|jatka)|peru(?:uta|un)?|never\s+mind|forget\s+it|väärin|vaarin)/i.test(text)
  const short = text.split(/\s+/).length <= 12
  if (!short) return null
  if (partial) return { partial: true }
  if (opener) return { partial: false }
  return null
}

/** The last clause of a prompt: the part a partial correction keeps. */
function lastClause (text) {
  const parts = String(text || '')
    .split(/(?:[.!?;]\s+|\s+(?:ja|and|sekä|seka)\s+)/i)
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

/** One line of work, without greetings and trailing politeness. */
function cleanWork (text) {
  return String(text || '')
    .replace(/^(?:hei|moro|moi|no|ookoo|okei|noniin|please)\s+/i, '')
    .replace(/\s*(?:kiitos|kiitti|thanks|thank you|please)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;:!?]+|[\s,.;:!?]+$/g, '')
    .trim()
    .slice(0, 1500)
}

function taskFrom (plain, options = {}) {
  const text = String(plain || '').trim()
  if (!text) return null

  // "voisitko korjata bugin": the request is the task, not the politeness.
  const request = TASK_REQUEST.exec(text)
  if (request) return taskFrom(request[1], options)

  // "lisää istunto tehtävä joka korjaa bugeja" -> "korjaa bugeja".
  const framed = TASK_FRAME.exec(text)
  if (framed) {
    const work = cleanWork(framed[1])
    if (work) return work
  }

  // "korjaa se bugi": the verb belongs to the instruction.
  const verb = TASK_VERB.exec(text)
  if (verb) {
    // A verb with nothing after it is not a task ("korjaa" on its own is a
    // mishearing); a verb with an object is, even when the object is one word
    // ("lisää testit").
    if (!String(verb[1] || '').trim()) return null
    return cleanWork(text)
  }

  if (!options.broad) return null
  if (options.question) return null
  if (SMALL_TALK.test(text)) return null
  if (CHAT_OPENER.test(text)) return null
  // A single word with no verb is a fragment, not work.
  if (text.split(/\s+/).length < 2) return null
  return cleanWork(text)
}

/**
 * "istunnolle 2 korjaa testit" / "account-2: fix the tests" — the leading
 * selector. The rest of the sentence is the work or the question.
 */
const SESSION_TARGET = /^(?:tehtävä istunnolle|istunnolle|istuntoon|istunnossa|istunnosta|istunto|sessiolle|sessiosta|sessio|sessionille|session|task for|account|tilille|tili)\s*-?\s*(\d{1,2})\b\s*[:,]?\s*(.*)$/i

function sessionTarget (plain) {
  const match = SESSION_TARGET.exec(String(plain || '').trim())
  if (!match) return null
  return {
    number: Number(match[1]),
    byAccount: /^(?:account|tili|tilille)/i.test(String(plain || '').trim()),
    rest: String(match[2] || '').trim()
  }
}

/** Sessions with a question on screen right now. */
function dialogSessions (snap) {
  return (snap.work || []).filter((item) => item.dialog)
}

/** The session a decision is for: the one named, else the one asking. */
function dialogTarget (snap, chosen) {
  if (chosen && chosen.dialog) return chosen
  return dialogSessions(snap)[0] || null
}

/** The question and its numbered choices, as written under the spoken answer. */
function optionsList (item) {
  if (!item || !item.dialog) return ''
  const dialog = item.dialog
  const question = String(dialog.question || '').trim()
  const options = (dialog.options || [])
    .map((option) => `${option.index}. ${option.text}${option.checked ? ' [on]' : ''}`)
  return [question, ...options].filter(Boolean).join('\n')
}

/** The bottom rows of the session that is asking, for the page to show. */
function screenDetail (item) {
  if (!item || !Array.isArray(item.screen) || item.screen.length === 0) return ''
  return item.screen.slice(-10).join('\n')
}

/** Live sessions: the ones a task can actually be typed into. */
function workList (snap) {
  return (snap.work || []).filter((item) => item.live !== false)
}

/** The live session a selector points at, or null. */
function resolveTarget (snap, target) {
  if (!target) return null
  const list = workList(snap)
  if (target.byAccount) {
    return list.find((item) =>
      item.account === `account-${target.number}` || String(item.account).endsWith(`-${target.number}`)
    ) || null
  }
  return list[target.number - 1] || null
}

/** The numbered sessions, so the person can pick one. */
function targetList (snap) {
  return workList(snap)
    .map((item, index) => `${index + 1}. ${item.account} \u00b7 ${shortHome(item.cwd)} \u00b7 ${item.phase}`)
    .join('\n')
}

/** Several sessions are running, so the person has to say which one. */
function targetQuestion (snap) {
  return {
    reply: t(
      'More than one session is running. Which one? Say the number and the task, for example "session 2: fix the tests".',
      'Istuntoja on useampi kuin yksi. Minkä niistä? Sano numero ja tehtävä, esim. "istunnolle 2: korjaa testit".'
    ),
    display: targetList(snap),
    action: true
  }
}

/**
 * Words a real spoken task contains, as stems because Finnish adds its cases
 * to the end ("korjaa" -> "korjaan", "korjata"). A transcription that matches
 * none of them is not work: a garbled sentence carrying a stray verb used to
 * reach freebuff as an instruction, and a wrong action from noise is worse
 * than asking the person to say it again.
 */
const KNOWN_STEMS = [
  // Finnish
  'korja', 'lis', 'teh', 'tee', 'lait', 'päivit', 'paivit', 'poist', 'siivo', 'test', 'aja', 'raken',
  'toteut', 'suunnit', 'tutki', 'selvit', 'etsi', 'tarkist', 'varmist', 'lue', 'kirjoit', 'muut',
  'vaihd', 'paran', 'nopeut', 'optimoi', 'dokumentoi', 'kommentoi', 'yhdist', 'asenn', 'käynnist',
  'kaynnist', 'lopet', 'keskeyt', 'jatk', 'aloit', 'näyt', 'nayt', 'kerr', 'avaa', 'sulje', 'tallen',
  'lataa', 'lähet', 'lahet', 'hae', 'aset', 'sääd', 'saad', 'poimi', 'siirr', 'kopioi', 'nime', 'luo',
  'perust', 'bugi', 'virhe', 'ongelma', 'ominaisuus', 'sivu', 'nappi', 'painik', 'ikkun', 'käyttöliit',
  'kayttoli', 'tietokanta', 'palvelin', 'tiedosto', 'kansio', 'hakemist', 'projekti', 'sovellu', 'koodi',
  'repo', 'versio', 'asetu', 'käyttäjä', 'kayttaj', 'salasan', 'kirjautu', 'wifi', 'yhteys', 'verkko',
  'puhelin', 'kuva', 'ääni', 'aani', 'video', 'musiik', 'tiedo', 'data', 'lasku', 'hinta', 'maksu',
  'raportti', 'loki', 'ajoitu', 'nopeu', 'muisti', 'levy', 'polku', 'nimi', 'numer', 'teksti', 'väri',
  'vari', 'tyyli', 'asettel', 'mobiil', 'selain', 'verkkosivu', 'käänn', 'kann', 'suomenn', 'englann',
  'kieli', 'dokumentaa', 'readme', 'kommentti', 'istunto', 'valvoja', 'puhelu', 'päätös', 'paatos',
  // English
  'fix', 'add', 'remove', 'delete', 'refactor', 'update', 'upgrade', 'build', 'implement', 'clean',
  'test', 'debug', 'write', 'create', 'rename', 'move', 'improve', 'change', 'investigate', 'document',
  'optimize', 'optimise', 'migrate', 'check', 'ensure', 'install', 'configure', 'deploy', 'release',
  'bump', 'format', 'lint', 'review', 'audit', 'simplify', 'split', 'extract', 'replace', 'make', 'run',
  'start', 'stop', 'restart', 'bug', 'error', 'issue', 'feature', 'page', 'button', 'window', 'database',
  'server', 'file', 'folder', 'directory', 'project', 'app', 'application', 'code', 'repository',
  'commit', 'branch', 'version', 'setting', 'user', 'password', 'login', 'auth', 'network', 'connection',
  'phone', 'image', 'music', 'audio', 'report', 'log', 'path', 'name', 'number', 'text', 'color', 'style',
  'layout', 'mobile', 'browser', 'website', 'translate', 'language', 'docs', 'api', 'endpoint',
  'component', 'function', 'class', 'module', 'config', 'screen', 'dashboard', 'session', 'supervisor',
  'voice', 'call', 'please', 'need', 'want', 'help', 'also', 'the', 'this', 'that', 'and', 'with', 'for',
  'from', 'into', 'should', 'would', 'make'
]

/** Does the spoken task contain at least one real word? */
function understandableTask (text) {
  const words = String(text || '').toLowerCase().match(/[\p{L}\p{N}_.\/-]+/gu) || []
  if (words.length === 0) return false
  // A path, a file name or an identifier is real work even with no prose.
  if (words.some((word) => /[./_-]/.test(word) && /\p{L}/u.test(word))) return true
  return words.some((word) => KNOWN_STEMS.some((stem) => word.startsWith(stem)))
}

/** Queue the work and speak as the one doing it, not as a messenger. */
async function taskReply (asked, snap, sessionId) {
  // The sentence was transcribed before it was translated; if it is not made of
  // words in either language, freebuff never sees it.
  if (!understandableTask(asked)) {
    logEvent('voice.task_rejected', { chars: String(asked).length })
    return {
      reply: t(
        'I could not make out the words, so I did not give that to freebuff. Say it again.',
        'En saanut tuosta selvää, joten en antanut sitä freebuffille. Sano uudestaan.'
      ),
      display: asked,
      action: true
    }
  }
  // freebuff follows English instructions more reliably, so the task is
  // translated before it is queued; the confirmation is still Finnish and the
  // original words are kept when no model is reachable.
  const english = await englishTask(asked)
  queueTask(english, sessionId ? { session: sessionId } : {})
  return {
    reply: snap.live > 0
      ? t('Right, I’ll do that.', 'Selvä, teen sen.')
      : t('Right, I’ll do it as soon as a session is open.', 'Selvä, teen sen heti kun istunto on auki.'),
    display: english === asked ? asked : `${english}\n(${asked})`,
    action: true
  }
}

/**
 * "3 minutes ago", spoken. A raw millisecond count is unreadable out loud.
 */
function quietAgo (ms) {
  const value = Number(ms)
  if (ms === null || ms === undefined || !Number.isFinite(value)) return ''
  const seconds = Math.max(1, Math.round(value / 1000))
  if (seconds < 2) return t('just now', 'juuri äsken')
  if (seconds < 90) return t(`${seconds} seconds ago`, `${seconds} sekuntia sitten`)
  const minutes = Math.round(seconds / 60)
  return t(
    `${minutes} minute${minutes === 1 ? '' : 's'} ago`,
    `${minutes} minuuttia sitten`
  )
}

/**
 * What the session is working on, in the first person, and whether it is
 * working at all. A session that went quiet, was interrupted, ended or was
 * lost is not work, and each of those has to sound different: "I'm working on
 * it" a minute after it stopped is the one answer that is plainly false.
 */
function workSpeech (snap, chosen) {
  const list = snap.work || []
  if (list.length === 0) {
    return t(
      'No session is running, so I am not working on anything right now.',
      'Ei oo istuntoo auki, joten mitään ei oo nyt työn alla.'
    )
  }
  // The session furthest from idle answers when no session was named, and a
  // live one is always preferred over a session that already ended. A question
  // waiting to be answered comes before anything else: nothing can happen
  // until it is answered.
  const order = { dialog: 0, working: 1, interrupted: 2, waiting: 3, stalled: 4, ended: 5, lost: 6, unknown: 7 }
  const work = chosen || [...list].sort((a, b) => (order[a.phase] ?? 6) - (order[b.phase] ?? 6))[0]
  const doing = String(work.text || '').replace(/[\s.]+$/, '')
  const ago = quietAgo(work.quietMs)

  if (work.phase === 'dialog' && work.dialog) {
    const options = work.dialog.options
      .map((option) => `${option.index}: ${option.text}`)
      .join(', ')
    const question = String(work.dialog.question || '').trim() || t('a question', 'kysymys')
    return t(
      `I am not working, I am waiting for an answer. The question is: ${question} The options are ${options}.`,
      `En työstä nyt, vaan odotan vastausta. Kysymys: ${question} Vaihtoehdot: ${options}.`
    )
  }
  if (work.phase === 'working') {
    return doing
      ? t(`I am working on it right now: ${doing}.`, `Jees, työstän parhaillaan: ${doing}.`)
      : t('The session is working right now.', 'Jees, homma on käynnissä.')
  }
  if (work.phase === 'interrupted') {
    const when = ago ? ` ${ago}` : ''
    return doing
      ? t(
          `I am not working now, that session was interrupted${when}. The last thing was: ${doing}.`,
          `En työstä nyt, toi istunto keskeytyi${when}. Viimeks tein: ${doing}.`
        )
      : t(
          `I am not working now, that session was interrupted${when}.`,
          `En työstä nyt, toi istunto keskeytyi${when}.`
        )
  }
  if (work.phase === 'waiting') {
    return doing
      ? t(
          `I am not working right now, the session is waiting. The last thing was: ${doing}.`,
          `En työstä nyt, toi istunto vaan odottaa. Viimeks tein: ${doing}.`
        )
      : t('The session is waiting for a message, not working.', 'Toi istunto odottaa viestiä, ei työstä nyt.')
  }
  if (work.phase === 'stalled') {
    return t(
      `The session has done nothing${ago ? ` for a long time (last write ${ago})` : ' for a long time'} and is stuck.`,
      `Toi istunto on jumissa, ei oo tehny pitkään aikaan mitään${ago ? ` (viimeks ${ago})` : ''}.`
    )
  }
  if (work.phase === 'ended') {
    return t(
      `That session is not running any more, it ended${ago ? ` ${ago}` : ''}.`,
      `Ei oo enää käynnissä, toi istunto päättyi${ago ? ` ${ago}` : ''}.`
    )
  }
  if (work.phase === 'lost') {
    return t(
      'That session is gone — its process disappeared without recording an end.',
      'Toi istunto katosi, sen prosessi hävis eikä loppua kirjattu.'
    )
  }
  return t('I cannot see what the session is doing.', 'En nää, mitä toi istunto tekee.')
}

/**
 * What is finished and what is still going. The transcript cannot prove a task
 * is complete, so this says exactly what has been recorded: the current step in
 * progress, and the ones before it as done so far.
 */
function progressSpeech (item) {
  const recent = (item.recent || [])
    .map((text) => String(text).replace(/\[response interrupted\]\s*/i, '').trim())
    .filter(Boolean)
  if (item.dialog) {
    return t(
      'It is not working: it is waiting for an answer. What is done so far I cannot say until it continues.',
      'Se ei työstä nyt, vaan odottaa vastausta. Valmiista en voi sanoa ennen kuin se jatkaa.'
    )
  }
  const parts = []
  const done = recent.slice(1, 4)
  const doing = item.phase === 'working' ? (recent[0] || item.text || '') : ''
  if (doing) {
    parts.push(t(`In progress: ${doing}.`, `Kesken: ${doing}.`))
  }
  if (done.length > 0) {
    parts.push(t(
      `Done so far: ${done.join('; ')}.`,
      `Tehtyä tähän mennessä: ${done.join('; ')}.`
    ))
  }
  if (parts.length === 0) {
    parts.push(t(
      'Nothing has been recorded from this session yet, so I cannot say what is done.',
      'Tästä istunnosta ei oo vielä kirjattu mitään, joten en voi sanoa valmiista.'
    ))
  }
  if (item.phase !== 'working') {
    parts.push(t('It is not working right now.', 'Se ei työstä juuri nyt.'))
  }
  return parts.join(' ')
}

/** The recorded steps under the spoken answer, newest first. */
function recentDetail (item) {
  const steps = (item.recent || []).slice(0, 5).map((text) => `- ${text}`)
  return [
    `${item.account} · ${shortHome(item.cwd)} · ${item.phase}`,
    ...steps
  ].join('\n')
}

/** The same answer as text under the spoken sentence: account, folder, phase. */
function workDetail (snap, chosen) {
  const list = chosen ? [chosen] : (snap.work || [])
  return list
    .map((item) => {
      const state = item.phase === 'ended'
        ? `ended${item.exitCode === null || item.exitCode === undefined ? '' : ` (exit ${item.exitCode})`}`
        : item.phase
      const quiet = item.phase !== 'working' && Number.isFinite(Number(item.quietMs))
        ? ` · quiet ${formatDuration(item.quietMs)}`
        : ''
      return `${item.account} · ${shortHome(item.cwd)} · ${state}${quiet} · ${item.text || ''}`.trim()
    })
    .join('\n')
}

/** A compact description of the world for the local model. */
function contextFor (snap) {
  return [
    `freebuff supervisor ${snap.version}`,
    `accounts: ${snap.signedIn} of ${snap.accounts} signed in`,
    `live sessions: ${snap.live}`,
    snap.sessions.length ? `sessions: ${snap.sessions.join('; ')}` : 'sessions: none',
    snap.credits.length ? `credits: ${snap.credits.join('; ')}` : 'credits: unknown',
    snap.pending.length ? `waiting decisions: ${snap.pending.map((ask) => ask.question).join('; ')}` : 'waiting decisions: none',
    snap.work && snap.work.length
      ? `sessions and their state: ${snap.work.map((item) => {
          const quiet = item.phase !== 'working' && Number.isFinite(Number(item.quietMs))
            ? `, quiet for ${formatDuration(item.quietMs)}`
            : ''
          const running = item.live === false ? ' (not running)' : ''
          return `${item.account} is ${item.phase}${running}${quiet}${item.text ? ` \u2014 ${item.text}` : ''}`
        }).join('; ')}`
      : 'work right now: no session',
    snap.work && snap.work.some((item) => item.recent && item.recent.length)
      ? `recent steps: ${snap.work.filter((item) => item.recent && item.recent.length).map((item) =>
          `${item.account}: ${item.recent.slice(0, 4).join(' | ')}`).join('; ')}`
      : 'recent steps: none recorded',
    snap.work && snap.work.some((item) => item.dialog)
      ? `questions on screen: ${snap.work.filter((item) => item.dialog).map((item) =>
          `${item.account} asks "${item.dialog.question || 'a question'}" with options ` +
          `${item.dialog.options.map((option) => `${option.index}. ${option.text}`).join(', ')}` +
          ' — the person answers with "choose N"').join('; ')}`
      : 'questions on screen: none',
    readTasks().length
      ? `tasks spoken on the phone and still queued: ${readTasks().map((task) => task.text).join('; ')}`
      : 'tasks spoken on the phone: none waiting',
    // Without this the model has no idea what it can do and invents a vague
    // answer when asked. The words are the commands the line really accepts.
    isFinnish()
      ? 'commands it understands: tila, apua, krediitit, aloita, lopeta, hyväksy, hylkää'
      : 'commands it understands: status, help, credits, start, stop, approve, deny'
  ].join('. ')
}

const SYSTEM_PROMPT =
  'You are the voice of a freebuff supervisor, speaking on a phone call. ' +
  'Answer in at most two short sentences that sound natural out loud. ' +
  'Do not ask follow-up questions and do not ask for more details: say what you know and what you can do, then stop. ' +
  'When greeted, answer with one short greeting ("Moro", "Moi", "Hei") and wait for the next instruction. ' +
  'Use only the facts given; never invent sessions, accounts, credits or actions. ' +
  'Never read file paths, URLs, ids or code aloud unless asked.'

// The Finnish line is written in Finnish from the start, not translated: a
// translated greeting reads like a form letter out loud.
const SYSTEM_PROMPT_FI =
  'Olet freebuff-valvojan ääni puhelimessa. Vastaa aina suomeksi, myös silloin kun käyttäjä puhuu englantia tai sekakieltä; älä vaihda englantiin kesken lauseen. ' +
  'Enintään kaksi lyhyttä lausetta, jotka kuulostavat luontevilta ääneen sanottuina. ' +
  'Älä kysy vastakysymyksiä äläkä pyydä lisätietoja: kerro lyhyesti, mitä tiedät ja mitä osaat tehdä, ja lopeta siihen. ' +
  'Kun sinua tervehditään, vastaa yhdellä lyhyellä tervehdyksellä (esim. "Moro", "Moi", "Hei") ja odota seuraavaa komentoa. ' +
  'Kun käyttäjä kiittää tai kuittaa, vastaa lyhyesti (esim. "Ole hyvä") äläkä tervehdi uudelleen. ' +
  'Käytä vain annettuja faktoja; älä keksi istuntoja, tilejä, krediittejä tai toimintoja. ' +
  'Älä lue tiedostopolkuja, URL-osoitteita, tunnisteita tai koodia ääneen, ellet sitä erikseen pyydä.'

/**
 * The owner's own instructions on how to talk, with their example lines.
 *
 * It is added after the built-in rules and explicitly wins over them, because
 * the usual reason to set it is that the default tone or length is wrong for
 * this person. An empty persona adds nothing at all, so the default prompt is
 * byte-for-byte what it was before.
 */
/**
 * How the model talks about the work itself. The facts name the concrete
 * thing; the model says it in the first person, in the line's own tone, so a
 * question gets "työstän parhaillaan wifi-yhdistämispainiketta" rather than a
 * status report about a session.
 */
const WORK_RULE_FI =
  ' Kun kysytään, mitä teet tai työstät parhaillaan, vastaa minä-muodossa ja kerro se konkreettinen asia, ' +
  'joka on työn alla. Jos istunto vain odottaa eikä työstä mitään, sano se suoraan. ' +
  'Kun kysytään, mitä on tehty tai paljonko on jäljellä, luettele lyhyesti valmiit askeleet ja se, mikä on kesken; ' +
  'älä väitä koko työtä valmiiksi, koska et voi tietää sitä. ' +
  'Puhu rentoa puhekieltä (esim. "Jees", "toi", "mä"), älä kirjakieltä.'

const WORK_RULE_EN =
  ' When asked what you are working on, answer in the first person and name the concrete thing ' +
  'being worked on. If the session is only waiting and doing nothing, say that plainly. ' +
  'When asked what is done or what is left, list the finished steps briefly and what is in progress; ' +
  'never claim the whole task is finished, because you cannot know that.'

function personaBlock (current = settings()) {
  const persona = String(current.persona || '').trim()
  if (!persona) return ''
  return isFinnish()
    ? '\n\nTyyli, jolla puhut (noudata tätä tarkasti, myös esimerkkien tapaa ja pituutta; ' +
      `jos tämä on ristiriidassa yllä olevan kanssa, tämä voittaa):\n${persona}`
    : '\n\nHow you speak (follow this exactly, including the style and length of any ' +
      `examples; if it conflicts with the rules above, this wins):\n${persona}`
}

/*
 * A model that has just timed out is not asked again for a minute. Every turn
 * used to pay the full timeout while the endpoint was unreachable, which is
 * what "it thinks for so long" sounded like on the phone.
 */
let llmFailures = 0
let llmCoolUntil = 0

function noteLlmFailure (now = Date.now()) {
  llmFailures += 1
  if (llmFailures >= LLM_FAILURES_BEFORE_COOLDOWN) {
    llmCoolUntil = now + LLM_COOLDOWN_MS
    llmFailures = 0
    logLine('warn', 'voice model skipped for a moment', { forMs: LLM_COOLDOWN_MS })
  }
}

/** Is the model being skipped right now? */
function llmCooling (now = Date.now()) {
  return now < llmCoolUntil
}

/**
 * Wait for a model reply only as long as a call can bear it. The late answer
 * is not cancelled, it is simply not spoken: the known-good sentence is.
 */
function withinBudget (promise, budgetMs) {
  const budget = Number(budgetMs === undefined ? REPLY_BUDGET_MS : budgetMs)
  if (!(budget > 0)) return promise
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logEvent('voice.reply.slow', { budgetMs: budget })
      resolve(null)
    }, budget)
    if (timer.unref) timer.unref()
    promise.then((value) => {
      clearTimeout(timer)
      resolve(value)
    }).catch(() => {
      clearTimeout(timer)
      resolve(null)
    })
  })
}

/** Ask a local OpenAI-compatible endpoint (Ollama, llama.cpp, LM Studio). */
async function llmReply (text, snap, options = {}) {
  const current = settings()
  const fetchImpl = options.fetch || globalThis.fetch
  const now = options.now ?? Date.now()
  if (llmCooling(now)) return null
  try {
    const response = await fetchImpl(`${current.llmUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(current.llmKey ? { authorization: `Bearer ${current.llmKey}` } : {})
      },
      body: JSON.stringify({
        model: current.llmModel,
        temperature: 0.4,
        // Short on purpose: this is read aloud on a phone, and every extra
        // sentence is a second of silence on a slow link.
        max_tokens: 140,
        messages: [
          {
            role: 'system',
            content: `${isFinnish() ? SYSTEM_PROMPT_FI : SYSTEM_PROMPT}` +
              `${isFinnish() ? WORK_RULE_FI : WORK_RULE_EN}${personaBlock(current)}\n\nFacts: ${contextFor(snap)}`
          },
          { role: 'user', content: String(text) }
        ]
      }),
      signal: AbortSignal.timeout(options.timeoutMs || LLM_TIMEOUT_MS)
    })
    if (!response.ok) {
      noteLlmFailure(now)
      return null
    }
    const data = await response.json()
    const content = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content
    if (typeof content !== 'string' || !content.trim()) {
      noteLlmFailure(now)
      return null
    }
    llmFailures = 0
    return content.trim().slice(0, 1200)
  } catch {
    noteLlmFailure(now)
    return null
  }
}

/**
 * Speech to text for the phone's fallback path.
 *
 * Safari's own recogniser opens a microphone and returns nothing often enough
 * that a recording plus Whisper is the dependable way to hear an answer. The
 * audio never leaves the machine except to the configured model endpoint.
 */
/** Re-encode a phone recording to what Whisper transcribes best. */
function toWav (audio) {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1'],
        { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
        (error, stdout) => resolve(!error && stdout && stdout.length ? stdout : null)
      )
      child.on('error', () => resolve(null))
      child.stdin.on('error', () => resolve(null))
      child.stdin.end(audio)
    } catch {
      resolve(null)
    }
  })
}

async function transcribeAudio (audio, contentType = 'audio/webm', options = {}) {
  const current = settings()
  if (!current.llmKey) return { ok: false, reason: 'no model key is set for transcription' }
  if (!audio || !audio.length) return { ok: false, reason: 'no audio' }

  const fetchImpl = options.fetch || globalThis.fetch
  const type = String(contentType || '').split(';')[0].trim()
  // Safari records fragmented mp4 whose codec Whisper can misread as noise.
  // Converting to 16 kHz mono WAV first is the difference between "hyväksyn"
  // and a guess; without ffmpeg the original bytes are sent unchanged.
  let send = audio
  let sendType = type || 'audio/webm'
  let extension = /mp4|m4a|aac/.test(sendType) ? 'm4a' : /wav/.test(sendType) ? 'wav' : /ogg/.test(sendType) ? 'ogg' : 'webm'
  if (options.transcode !== false && !/wav/.test(sendType)) {
    const wav = await toWav(audio)
    if (wav && wav.length) {
      send = wav
      sendType = 'audio/wav'
      extension = 'wav'
    }
  }
  try {
    const form = new FormData()
    form.append('file', new Blob([send], { type: sendType }), `call.${extension}`)
    form.append('model', WHISPER_MODEL)
    // The line's language, so a Finnish answer is not guessed from an accent.
    const primary = String(current.lang || '').split(/[-_]/)[0]
    if (primary) form.append('language', primary)
    // Short commands are exactly what Whisper turns into invented sentences.
    form.append('prompt', WHISPER_PROMPT)
    form.append('temperature', '0')
    const response = await fetchImpl(`${current.llmUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${current.llmKey}` },
      body: form,
      signal: AbortSignal.timeout(options.timeoutMs || TRANSCRIBE_TIMEOUT_MS)
    })
    if (!response.ok) return { ok: false, reason: `transcription failed: ${response.status}` }
    const data = await response.json()
    const text = String((data && data.text) || '').trim()
    if (!text) return { ok: false, reason: 'nothing was heard' }
    return { ok: true, text: text.slice(0, 1000) }
  } catch (error) {
    return { ok: false, reason: error.message }
  }
}

/**
 * What a ring actually says out loud.
 *
 * A call is not a status report: it opens with at most one short greeting and
 * then goes straight to what is wrong, in the owner's own spoken style. The
 * model only ever rephrases the facts it is given; without a fast hosted model
 * (a local one is too slow to hold a ringing phone) the compact fallback below
 * speaks instead, so a call never waits or goes silent.
 */
const RING_PROMPT_FI =
  'Soitat puhelun omistajalle, koska freebuff tarvitsee häntä. ' +
  'Aloita korkeintaan yhdellä lyhyellä tervehdyksellä (esim. "Moro") ja mene heti asiaan: ' +
  'mikä on vialla ja mitä hänen pitää tehdä. Puhu puhekielellä ja rennosti. ' +
  'Älä selitä mikä freebuff on, älä kysy sopiiko nyt puhua, älä pyydä anteeksi, älä toista tervehdystä, älä luettele tiedostopolkuja. ' +
  'Jätä englanninkieliset tekniset nimet (dialogien ja työkalujen nimet) sellaisinaan äläkä käännä niitä. ' +
  'Enintään kaksi lyhyttä lausetta, enintään 22 sanaa. Lopeta vain yhteen lyhyeen kysymykseen, älä kahteen peräkkäiseen. ' +
  'Jos tarvitaan hyväksyntä tai hylkäys, se kysymys on "hyväksytkö?".'

const RING_PROMPT =
  'You are calling the owner because freebuff needs them. ' +
  'Open with at most one short greeting and go straight to what is wrong and what they have to do. ' +
  'Do not explain what freebuff is, do not ask whether now is a good time, do not apologise, do not repeat the greeting, do not read out file paths. ' +
  'Keep English names of dialogs and tools as they are instead of translating them. ' +
  'At most two short sentences, at most 22 words. If a decision is needed, end with a short question.'

/** The short line spoken when no model is fast enough to phrase the call. */
function ringFallback (entry) {
  const problem = String(entry.question || '').replace(/\s+/g, ' ').trim()
  if (!problem) return isFinnish() ? 'Moro. Tarviin sun apuu.' : 'Freebuff needs you.'
  const body = /[.!?]$/.test(problem) ? problem : `${problem}.`
  const tail = entry.kind === 'help' ? t(' Can you take a look?', ' Haluuksä et mä katon?') : ''
  return `${t('Moro.', 'Moro.')} ${body}${tail}`
}

async function ringSpeech (entry, options = {}) {
  const fallback = ringFallback(entry)
  // The most common call is freebuff waiting on a named dialog. The name is a
  // technical word ("trust", "bypass permissions"): said as it is, always in
  // the same shape, instead of leaving the model to translate it into Russian
  // roulette like "luotuksen hyväksyntää".
  const waiting = /waiting on ([\w][\w.-]{0,40})/i.exec(String(entry.question || ''))
  if (waiting && isFinnish()) {
    return `Moro. Freebuff odottaa: ${waiting[1]}. Hyv\u00e4ksytk\u00f6?`
  }
  const current = settings()
  // A local model takes tens of seconds a sentence on a small laptop; a phone
  // that rings late is worse than one that rings with plain words.
  if (!current.llmKey || options.speech === false) return fallback

  const fetchImpl = options.fetch || globalThis.fetch
  try {
    const response = await fetchImpl(`${current.llmUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${current.llmKey}`
      },
      body: JSON.stringify({
        model: current.llmModel,
        temperature: 0.5,
        max_tokens: 90,
        messages: [
          {
            role: 'system',
            // Deliberately without the conversation persona: slang examples
            // written for chat make the model garble a one-line emergency
            // sentence, and this text is the one thing that must be clear.
            content: isFinnish() ? RING_PROMPT_FI : RING_PROMPT
          },
          {
            role: 'user',
            content: `kind: ${entry.kind}\nproblem: ${entry.question}\n` +
              `request: ${entry.action || '-'}\nsession: ${entry.sessionId || '-'}\naccount: ${entry.accountId || '-'}`
          }
        ]
      }),
      signal: AbortSignal.timeout(options.timeoutMs || RING_TIMEOUT_MS)
    })
    if (!response.ok) return fallback
    const data = await response.json()
    const content = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content
    if (typeof content !== 'string') return fallback
    const line = content.replace(/\s+/g, ' ').trim().slice(0, 300)
    return line || fallback
  } catch {
    return fallback
  }
}

/** A phone-friendly ring. Ntfy is opt-in and free; a topic is a shared secret. */
function ntfyUrl (topic) {
  const value = String(topic || '').trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  return `${NTFY_BASE}/${encodeURIComponent(value)}`
}

async function pushRing (ask, options = {}) {
  const current = settings()
  const url = ntfyUrl(current.ntfy)
  if (!url) return { sent: false, reason: 'no ntfy topic' }

  const fetchImpl = options.fetch || globalThis.fetch
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        // Priority 5 asks the ntfy app to ring like a call, not to wait for
        // the next notification batch.
        Priority: '5',
        // Swedish on the lock screen is worse than a short Finnish sentence:
        // the notification says what the call will say.
        Title: t('Agent needs you', 'Agentti tarvitsee sinua'),
        Tags: 'phone',
        Click: callUrl(),
        'Content-Type': 'text/plain; charset=utf-8'
      },
      body: ask.speech || `${ask.question}${ask.action ? ` ${ask.action}` : ''}`,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS)
    })
    return { sent: response.ok, reason: response.ok ? null : `ntfy ${response.status}` }
  } catch (error) {
    return { sent: false, reason: error.message }
  }
}

/**
 * Ring the phone: write the ask, tell a running page, and push when a topic is
 * configured. Every part is best effort and a ring never blocks a session.
 *
 * @param {{kind?:string, question:string, action?:string, accountId?:string, sessionId?:string, cwd?:string}} ask
 */
async function ring (ask = {}, options = {}) {
  const current = settings()
  if (!current.enabled) return { ok: false, reason: 'voice calls are off' }

  const entry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    kind: ask.kind || 'help',
    question: String(ask.question || 'Freebuff needs a decision.').slice(0, 400),
    action: ask.action ? String(ask.action).slice(0, 300) : '',
    accountId: ask.accountId || null,
    sessionId: ask.sessionId || null,
    cwd: ask.cwd || null
  }

  // A question that is already waiting is not pushed again. A dialog left on
  // screen is re-detected every few minutes, and every detection rang the
  // phone — sometimes with slightly different words, because the screen had
  // redrawn — which is what made the notifications feel like they were about
  // questions that did not exist.
  const now = Date.now()
  const shape = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9äöå]+/g, ' ').trim().slice(0, 80)
  const repeat = readPending().find((item) => {
    const at = Date.parse(item.at)
    if (!Number.isFinite(at)) return false
    if (item.sessionId && entry.sessionId && item.sessionId !== entry.sessionId) return false
    const age = now - at
    // The same words are suppressed for longer than a different question in
    // the same session, which is only held back long enough to stop a redraw
    // from ringing twice.
    return shape(item.question) === shape(entry.question)
      ? age < RING_REPEAT_MS
      : age < 2 * 60 * 1000
  })
  if (repeat && options.repeat !== true) {
    logLine('info', 'voice.ring skipped — the same question is already waiting', {
      kind: entry.kind,
      session: entry.sessionId
    })
    logEvent('voice.ring.duplicate', {
      kind: entry.kind,
      session: entry.sessionId,
      question: entry.question
    })
    return { ok: true, local: false, push: false, duplicate: true, entry: repeat }
  }

  // Phrased before the page is told, so the first thing the owner hears is
  // already the problem rather than a preamble the page has to fill in.
  entry.speech = await ringSpeech(entry, options)

  const pending = readPending()
  pending.push(entry)
  writePending(pending)

  let local = { ok: false }
  try {
    if (!running()) await ensureServer({ waitMs: 2500 })
    local = await postRing(entry, options)
  } catch (error) {
    local = { ok: false, reason: error.message }
  }

  const pushed = await pushRing(entry, options)
  logLine('info', 'voice.ring', {
    kind: entry.kind,
    local: local.ok ? 'delivered' : (local.reason || 'not running'),
    push: pushed.sent ? 'delivered' : (pushed.reason || 'off')
  })
  logEvent('voice.ring', {
    kind: entry.kind,
    question: entry.question,
    local: local.ok,
    push: pushed.sent
  })
  return { ok: true, local: local.ok, push: pushed.sent, entry }
}

async function postRing (entry, options = {}) {
  const current = settings()
  const fetchImpl = options.fetch || globalThis.fetch
  try {
    const response = await fetchImpl(`http://127.0.0.1:${current.port}/api/ring?token=${encodeURIComponent(token())}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ broadcastOnly: true, ...entry }),
      signal: AbortSignal.timeout(3000)
    })
    return { ok: response.ok }
  } catch (error) {
    return { ok: false, reason: error.message }
  }
}

/** Start the server in the background if it is not already up. */
async function ensureServer (options = {}) {
  const live = running()
  if (live && options.probe !== false) {
    // The heartbeat file only says a process exists. A server that is wedged,
    // or one that died before it started listening, leaves the call link dead
    // while the file still looks healthy, so the line itself is asked.
    if (await probe(options)) return live
    const signalled = killIfMatches(live.pid, VOICE_SERVER_COMMAND)
    logLine('warn', 'voice server is not answering — restarting it', {
      pid: live.pid,
      port: live.port,
      signalled
    })
    if (!signalled) {
      // The pid is not the server any more, so the heartbeat is a leftover of a
      // server that died without cleaning up. It is dropped instead of being
      // signalled, and the fresh server below replaces it.
      safeUnlink(heartbeatPath())
      logLine('warn', 'stale voice heartbeat removed', { pid: live.pid })
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  } else if (live) {
    return live
  }

  const launcher = path.join(__dirname, '..', 'bin', 'sfreebuff.js')
  try {
    const child = spawn(process.execPath, [launcher, 'voice', 'serve'], {
      detached: true,
      stdio: 'ignore',
      env: process.env
    })
    child.unref()
  } catch (error) {
    logLine('warn', 'voice server could not be started', { error: error.message })
    return null
  }

  const waitMs = options.waitMs === undefined ? 2000 : options.waitMs
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const started = running()
    if (started && await probe(options)) return started
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return running()
}

/** Does the line answer on its port right now? */
async function probe (options = {}) {
  const current = settings()
  const fetchImpl = options.fetch || globalThis.fetch
  try {
    const response = await fetchImpl(
      `http://127.0.0.1:${options.port || current.port}/healthz`,
      { signal: AbortSignal.timeout(options.timeoutMs || HEALTH_TIMEOUT_MS) }
    )
    return Boolean(response && response.ok)
  } catch {
    return false
  }
}

function stopServer () {
  const live = running()
  if (!live) return false
  // Only the process that is still the voice server is stopped; a heartbeat
  // whose pid was reused belongs to somebody else, and the file is dropped.
  const signalled = killIfMatches(live.pid, VOICE_SERVER_COMMAND)
  if (!signalled) safeUnlink(heartbeatPath())
  return signalled
}

// ---------------------------------------------------------------------------
// The HTTP server
// ---------------------------------------------------------------------------

function sendJson (res, code, body) {
  const text = `${JSON.stringify(body)}\n`
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store'
  })
  res.end(text)
}

/** Raw bytes, for audio: the text reader would corrupt them. */
function readBinary (req, limit = MAX_AUDIO) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('request too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Serve the phone page and its three endpoints until the process is stopped.
 * Returns `{ server, close, port, url }` once it is listening.
 */
async function serve (options = {}) {
  const current = settings()
  const host = options.host || current.host
  const port = options.port === undefined ? current.port : options.port
  const secret = token()
  const clients = new Set()

  // The page is the same bytes on every load, so it is written once: a phone
  // opening the call link must not wait for a template to be built, and a
  // reload while the machine is busy still returns at once.
  let pageHtml = ''
  const page = () => {
    if (!pageHtml) {
      pageHtml = appHtml({
        token: secret,
        voiceName: current.voiceName,
        voiceRate: current.voiceRate,
        lang: current.lang
      })
    }
    return pageHtml
  }

  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of clients) {
      try {
        client.write(frame)
      } catch {
        clients.delete(client)
      }
    }
  }

  const handle = async (req, res) => {
    let url
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    } catch {
      sendJson(res, 400, { error: 'bad request' })
      return
    }

    // A liveness answer that needs no token: the heartbeat file only proves a
    // process exists, not that the line is answering. The supervisor and
    // ensureServer() check this before trusting an existing server.
    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true, pid: process.pid, uptime: Math.round(process.uptime()) })
      return
    }

    const given = url.searchParams.get('token') ||
      String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const authed = safeEqual(given, secret)

    // The home page does not reveal the token: only the link with it works.
    if (req.method === 'GET' && url.pathname === '/') {
      if (!authed) {
        sendJson(res, 401, { error: 'open the call link printed by `sfreebuff voice status`' })
        return
      }
      res.writeHead(302, { location: `/call/${secret}` })
      res.end()
      return
    }

    // A link that arrives with a trailing slash (iOS, a chat app, a typed
    // address) is the same link: answer it instead of failing as unauthorized.
    const callPath = `/call/${secret}`
    if (req.method === 'GET' && url.pathname.replace(/\/+$/, '').toLowerCase() === callPath.toLowerCase()) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      })
      res.end(page())
      return
    }

    if (!authed) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      try {
        const snap = await snapshot()
        const live = settings()
        sendJson(res, 200, {
          ...snap,
          pending: readPending(),
          voice: { name: live.voiceName, rate: live.voiceRate }
        })
      } catch (error) {
        sendJson(res, 500, { error: error.message })
      }
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive'
      })
      res.write('retry: 3000\n\n')
      // One replay, not a burst: reconnecting must not read every old call
      // out loud again. The page shows it without speaking unless it is new.
      const pending = readPending()
      if (pending.length > 0) {
        const latest = { ...pending[pending.length - 1], replay: true }
        res.write(`event: ring\ndata: ${JSON.stringify(latest)}\n\n`)
      }
      clients.add(res)
      const keepAlive = setInterval(() => {
        try {
          res.write(': keep-alive\n\n')
        } catch {
          clearInterval(keepAlive)
          clients.delete(res)
        }
      }, 15000)
      req.on('close', () => {
        clearInterval(keepAlive)
        clients.delete(res)
      })
      return
    }

    // Which system voice speaks the replies. The phone picks it once ("the man
    // sounding one", the iPhone default, or automatic), and the choice is
    // stored on the supervisor so it survives a reload.
    if (req.method === 'POST' && url.pathname === '/api/voice') {
      try {
        const body = JSON.parse(await readBody(req) || '{}')
        const name = String(body.name || '').trim().slice(0, 80)
        updateSettings({ voiceName: name })
        logEvent('voice.voice_chosen', { name: name || 'automatic' })
        sendJson(res, 200, { ok: true, name })
      } catch (error) {
        sendJson(res, 400, { error: error.message })
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/turn') {
      try {
        const raw = await readBody(req)
        const body = JSON.parse(raw || '{}')
        const text = String(body.text || '').trim()
        if (!text) {
          sendJson(res, 400, { error: 'no text' })
          return
        }
        const reply = await answer(text, { sessionId: body.session || null })
        logEvent('voice.turn', { source: reply.source, chars: text.length })
        sendJson(res, 200, reply)
      } catch (error) {
        sendJson(res, 400, { error: error.message })
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/transcribe') {
      try {
        const audio = await readBinary(req)
        const result = await transcribeAudio(audio, req.headers['content-type'])
        if (!result.ok) {
          sendJson(res, 502, { error: result.reason })
          return
        }
        logEvent('voice.transcribe', { chars: result.text.length })
        sendJson(res, 200, { text: result.text })
      } catch (error) {
        sendJson(res, 400, { error: error.message })
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/ring') {
      let entry
      let body
      try {
        const raw = await readBody(req)
        body = JSON.parse(raw || '{}')
        entry = {
          id: body.id || crypto.randomUUID(),
          at: body.at || new Date().toISOString(),
          kind: body.kind || 'help',
          question: String(body.question || 'Freebuff needs a decision.').slice(0, 400),
          action: body.action ? String(body.action).slice(0, 300) : '',
          accountId: body.accountId || null,
          sessionId: body.sessionId || null,
          cwd: body.cwd || null
        }
        // The ring lands first and is phrased second. Waiting for the model
        // here is what made a ring arrive after the supervisor had given up on
        // it (its 3 s timeout), which is why a call could ring late or not at
        // all: the sentence that is already known is sent at once, and the
        // model's better wording follows as an update when it arrives.
        entry.speech = body.speech ? String(body.speech).slice(0, 300) : ringFallback(entry)
        if (!body.broadcastOnly) {
          const pending = readPending()
          pending.push(entry)
          writePending(pending)
        }
      } catch (error) {
        sendJson(res, 400, { error: error.message })
        return
      }

      broadcast('ring', entry)
      // Answer before anything slow happens, so a ring is never a timeout.
      sendJson(res, 200, { ok: true })

      if (!body.speech) {
        void ringSpeech(entry).then((speech) => {
          const better = String(speech || '').trim().slice(0, 300)
          if (!better || better === entry.speech) return
          const pending = readPending()
          const stored = pending.find((item) => item.id === entry.id)
          if (stored) {
            stored.speech = better
            writePending(pending)
          }
          broadcast('ring', { ...entry, speech: better })
        }).catch(() => {
          // The ring has already been delivered with its plain sentence.
        })
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/resolve') {
      writePending([])
      broadcast('resolved', {})
      sendJson(res, 200, { ok: true })
      return
    }

    sendJson(res, 404, { error: 'not found' })
  }

  // One bad request must never take the line down. An exception inside an
  // async handler is an unhandled rejection, and that ends the process — which
  // is exactly what made the call page sometimes fail to load at all: the port
  // was still in the heartbeat file, but nothing was listening on it.
  const onRequest = (req, res) => {
    handle(req, res).catch((error) => {
      logLine('warn', 'voice request failed', { path: req.url, error: error.message })
      try {
        if (res.headersSent) res.end()
        else sendJson(res, 500, { error: 'internal error' })
      } catch {
        // The socket is already gone.
      }
    })
  }
  const server = http.createServer(onRequest)

  // A page reloaded while its event stream is open, or a phone that sleeps
  // mid-request, must not leave a socket that holds the next request up.
  server.keepAliveTimeout = 5000
  server.headersTimeout = 15000
  server.requestTimeout = 60 * 1000
  server.on('clientError', (error, socket) => {
    logLine('warn', 'voice client error', { error: error.message })
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    } catch {
      // Ignore.
    }
  })
  server.on('error', (error) => {
    logLine('error', 'voice server error', { error: error.message })
  })

  // The line watches the sessions itself, so a session that stops working is
  // known within a heartbeat of it happening instead of at the next question.
  // Each transition is logged once, and an open page is told to refresh.
  const work = require('./work')
  const seen = new Map()
  const watchSessions = () => {
    let rows = []
    try {
      rows = work.sessions({ now: Date.now() })
    } catch {
      return
    }
    let changed = false
    for (const row of rows) {
      const before = seen.get(row.sessionId)
      seen.set(row.sessionId, row)
      if (!before || before.phase === row.phase) continue
      changed = true
      if (row.phase === 'working') continue
      logEvent('voice.session_state', {
        session: row.sessionId,
        account: row.account,
        from: before.phase,
        to: row.phase,
        quietMs: row.quietMs,
        interrupted: row.interrupted
      })
    }
    for (const id of [...seen.keys()]) {
      if (!rows.some((row) => row.sessionId === id)) seen.delete(id)
    }
    if (changed) broadcast('sessions', { work: rows })
  }
  const watchTimer = setInterval(watchSessions, SESSION_WATCH_MS)
  if (watchTimer.unref) watchTimer.unref()
  watchSessions()

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })

  const actualPort = server.address().port
  // The phone reaches the line over the tailnet, never over loopback. With the
  // default bind (127.0.0.1) a second listener is opened on this machine's
  // tailnet address, so the call link loads without `tailscale serve` at all.
  // The same handler, token and event stream serve both listeners; when the
  // tailnet is down the second bind fails quietly and loopback stays.
  const site = tailnet.status()
  const loopbackBind = /^(?:127\.0\.0\.1|localhost|::1)$/i.test(String(host))
  const extraServers = []
  let tailnetHost = ''
  if (loopbackBind && site.ip) {
    const listener = http.createServer(onRequest)
    listener.keepAliveTimeout = 5000
    listener.on('error', (error) => {
      logLine('warn', 'voice tailnet listener unavailable', {
        host: site.ip,
        error: error.message
      })
    })
    const bound = await new Promise((resolve) => {
      listener.once('error', () => resolve(false))
      try {
        listener.listen(actualPort, site.ip, () => resolve(true))
      } catch {
        resolve(false)
      }
    })
    if (bound) {
      extraServers.push(listener)
      tailnetHost = site.ip
      logEvent('voice.tailnet_listener', { host: site.ip, port: actualPort })
    }
  }

  const heartbeat = {
    pid: process.pid,
    port: actualPort,
    host,
    ...(tailnetHost ? { tailnetHost } : {}),
    startedAt: new Date().toISOString()
  }
  try {
    ensureDirs()
    fs.writeFileSync(heartbeatPath(), `${JSON.stringify(heartbeat)}\n`, { mode: 0o600 })
  } catch {
    // The server still works without a heartbeat; only discovery is lost.
  }

  // The page asks for this the moment it opens, so it is built in advance:
  // the first load of a call is then a cache hit instead of a folder scan.
  void snapshot().catch(() => {})

  const close = () => {
    clearInterval(watchTimer)
    for (const client of clients) {
      try {
        client.end()
      } catch {
        // Ignore.
      }
    }
    clients.clear()
    for (const listener of extraServers) {
      try {
        listener.close()
      } catch {
        // Ignore.
      }
    }
    try {
      server.close()
    } catch {
      // Ignore.
    }
    try {
      const currentHeartbeat = JSON.parse(fs.readFileSync(heartbeatPath(), 'utf8'))
      if (currentHeartbeat.pid === process.pid) fs.unlinkSync(heartbeatPath())
    } catch {
      // Ignore.
    }
  }

  return {
    server,
    close,
    port: actualPort,
    host,
    tailnetHost,
    tailnet: site,
    hosts: [host, ...(tailnetHost ? [tailnetHost] : [])],
    url: `${current.publicUrl || `http://${tailnetHost || (host === '0.0.0.0' ? '<tailscale-ip>' : host)}:${actualPort}`}/call/${secret}`
  }
}

/** `sfreebuff voice serve`: the foreground server. */
async function serveCommand (argv = []) {
  const hostFlag = argv.indexOf('--host')
  const portFlag = argv.indexOf('--port')
  const printUrl = argv.includes('--print-url')
  const plan = await serve({
    host: hostFlag >= 0 ? argv[hostFlag + 1] : undefined,
    port: portFlag >= 0 ? Number(argv[portFlag + 1]) || undefined : undefined
  })

  // The actual bound port, not the configured one: `serve --port` must print
  // the link that works.
  const url = plan.url
  console.log(`sfreebuff voice line listening on ${plan.host}:${plan.port}`)
  if (plan.tailnetHost) console.log(`  also on the tailnet at ${plan.tailnetHost}:${plan.port}`)
  console.log(`call it from the phone: ${url}`)
  const current = settings()
  if (!current.publicUrl) {
    const site = tailnet.status()
    console.log('the link above opens on the tailnet; iOS needs HTTPS for the microphone:')
    console.log(`  tailscale serve --bg ${plan.port}`)
    console.log(`  sfreebuff voice url https://${site.dnsName || '<machine>.<tailnet>.ts.net'}`)
  }
  for (const line of tailnet.problems({ port: plan.port, publicUrl: current.publicUrl, advice: false })) {
    console.log(`note: ${line}`)
  }
  if (printUrl) console.log(url)
  logLine('info', 'voice.serve', { host: plan.host, port: plan.port })

  const shutdown = () => {
    plan.close()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  // Keep the process alive until a signal.
  return new Promise(() => {})
}

// ---------------------------------------------------------------------------
// The phone page
// ---------------------------------------------------------------------------

const USAGE = `usage:
  sfreebuff voice                 show the voice line's settings and call link
  sfreebuff voice on|off          turn voice calls on or off
  sfreebuff voice serve           run the voice line in the foreground
  sfreebuff voice call [text]     ring the phone now (a test call)
  sfreebuff voice url <url|off>   the address the phone opens (Tailscale HTTPS)
  sfreebuff voice ntfy <topic|auto|off>
                                  push rings with the free ntfy app
  sfreebuff voice lang <fi-FI>    language the line speaks and listens in
  sfreebuff voice model <name>    local model for conversation (Ollama)
  sfreebuff voice llm <url>       OpenAI-compatible endpoint for that model
  sfreebuff voice key <key|off>   API key for a hosted endpoint (stored 0600)
  sfreebuff voice persona <text|off>
                                  how it should talk, with your own examples
  sfreebuff voice persona --file <path>
                                  read those instructions from a file
  sfreebuff voice resolve         clear the waiting calls

Speech recognition and the voice itself run on the phone, so there is no
per-minute bill. For a more realistic voice, install a Premium voice on the
iPhone under Settings > Accessibility > Spoken Content > Voices.`

/** `sfreebuff voice ...`; returns a process exit code. */
async function voiceCommand (argv = []) {
  const [action, ...rest] = argv
  const value = rest.join(' ').trim()

  if (!action || action === 'status') {
    const current = settings()
    const live = running()
    const pending = readPending()
    const site = tailnet.status({ fresh: true })
    console.log(`voice calls   ${current.enabled ? 'on' : 'off'}`)
    console.log(`server        ${live ? `running (pid ${live.pid}, ${live.host}:${live.port})` : 'stopped'}`)
    console.log(`call link     ${current.enabled || live ? callUrl() : 'off — sfreebuff voice on'}`)
    console.log(`tailnet       ${tailnet.describe(site)}`)
    console.log(`push rings    ${current.ntfy ? `ntfy topic "${current.ntfy}"` : 'off — sfreebuff voice ntfy auto'}`)
    console.log(`model         ${current.llmModel} at ${current.llmUrl}`)
    console.log(`language      ${current.lang}`)
    console.log(`model key     ${current.llmKey ? 'set' : 'none'}`)
    console.log(`persona       ${current.persona ? `own instructions (${current.persona.length} characters)` : 'default'}`)
    console.log(`waiting       ${pending.length === 0 ? 'nothing' : `${pending.length} call${pending.length === 1 ? '' : 's'}`}`)
    if (current.enabled || live) {
      for (const line of tailnet.problems({ port: current.port, publicUrl: current.publicUrl }, site)) {
        console.log(`fix           ${line}`)
      }
    }
    console.log('voice         system voice on the phone (install a Premium voice for the best sound)')
    return 0
  }

  if (action === 'on' || action === 'off') {
    const current = setEnabled(action === 'on')
    if (!current.enabled) {
      console.log('voice calls off — the supervisor no longer rings the phone.')
      return 0
    }
    const server = await ensureServer({ waitMs: 3000 })
    const site = tailnet.status({ fresh: true })
    console.log(`voice calls on — call link: ${callUrl()}`)
    console.log(server
      ? `voice line running on ${server.host}:${server.port}`
      : 'the voice line could not start — run `sfreebuff voice serve` to see why')
    if (!current.publicUrl) {
      if (site.ip) {
        console.log('the link above opens on the tailnet; iOS needs HTTPS for the microphone:')
        console.log(`  tailscale serve --bg ${current.port}`)
        console.log(`  sfreebuff voice url https://${site.dnsName || '<machine>.<tailnet>.ts.net'}`)
      } else {
        console.log('no tailnet address found — is Tailscale connected here? (`sfreebuff voice status`)')
      }
    }
    for (const line of tailnet.problems({ port: current.port, publicUrl: current.publicUrl, advice: false }, site)) {
      console.log(`fix: ${line}`)
    }
    return 0
  }

  if (action === 'serve') {
    await serveCommand(rest)
    return 0
  }

  if (action === 'call' || action === 'test') {
    const result = await ring({
      kind: 'test',
      question: value || 'This is a test call from freebuff.'
    })
    if (!result.ok) {
      console.error(`sfreebuff: ${result.reason}`)
      return 1
    }
    console.log(
      `ring sent — page: ${result.local ? 'delivered' : 'no phone page open'}, ` +
      `push: ${result.push ? 'delivered' : 'off'}`
    )
    return 0
  }

  if (action === 'url') {
    if (!value || value === 'off') {
      updateSettings({ publicUrl: '' })
      console.log(`call link ${callUrl()}`)
      return 0
    }
    if (!/^https?:\/\//i.test(value)) {
      console.error('sfreebuff: expected an http(s) URL, e.g. https://machine.tailnet.ts.net')
      return 1
    }
    updateSettings({ publicUrl: value.replace(/\/+$/, '') })
    console.log(`call link ${callUrl()}`)
    return 0
  }

  if (action === 'ntfy') {
    if (!value || value === 'off') {
      updateSettings({ ntfy: '' })
      console.log('push rings off — only an open call page will ring.')
      return 0
    }
    const topic = value === 'auto'
      ? `freebuff-${crypto.randomBytes(6).toString('hex')}`
      : value
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(topic)) {
      console.error('sfreebuff: an ntfy topic is 3-64 letters, digits, - or _')
      return 1
    }
    updateSettings({ ntfy: topic })
    console.log(`push rings on — subscribe to "${topic}" in the ntfy app on the phone.`)
    if (value === 'auto') console.log(`topic: ${topic}`)
    return 0
  }

  if (action === 'model') {
    if (!value) {
      console.log(settings().llmModel)
      return 0
    }
    updateSettings({ llmModel: value })
    console.log(`voice model ${value} (at ${settings().llmUrl})`)
    return 0
  }

  if (action === 'persona' || action === 'style') {
    const current = settings()
    if (!value) {
      console.log(current.persona || 'persona: default (no own instructions)')
      return 0
    }
    if (value === 'off' || value === 'clear') {
      updateSettings({ persona: '' })
      console.log('persona cleared — the default tone is used again')
      return 0
    }
    let text = value
    if (rest[0] === '--file' || rest[0] === '-f') {
      const file = rest.slice(1).join(' ').trim()
      if (!file) {
        console.error('sfreebuff: expected a file path after --file')
        return 1
      }
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch (error) {
        console.error(`sfreebuff: could not read ${file}: ${error.message}`)
        return 1
      }
    }
    text = String(text).trim()
    if (!text) {
      console.error('sfreebuff: the persona is empty')
      return 1
    }
    updateSettings({ persona: text.slice(0, PERSONA_MAX) })
    console.log(`persona saved (${settings().persona.length} characters) — the line uses it from the next answer on`)
    if (text.length > PERSONA_MAX) {
      console.log(`note: kept the first ${PERSONA_MAX} characters`)
    }
    return 0
  }

  if (action === 'key') {
    if (!value || value === 'off') {
      updateSettings({ llmKey: '' })
      console.log('model key cleared')
      return 0
    }
    updateSettings({ llmKey: value })
    // Never echo the key back; config.json is written with mode 0600.
    console.log(`model key stored (${value.length} characters)`)
    return 0
  }

  if (action === 'lang') {
    if (!value) {
      console.log(settings().lang)
      return 0
    }
    if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/i.test(value)) {
      console.error('sfreebuff: expected a language tag, e.g. fi-FI or en-US')
      return 1
    }
    updateSettings({ lang: value })
    console.log(`voice language ${value}`)
    return 0
  }

  if (action === 'llm') {
    if (!value || !/^https?:\/\//i.test(value)) {
      console.error('sfreebuff: expected an http(s) URL, e.g. http://127.0.0.1:11434/v1')
      return 1
    }
    updateSettings({ llmUrl: value.replace(/\/+$/, '') })
    console.log(`voice model endpoint ${settings().llmUrl}`)
    return 0
  }

  if (action === 'resolve') {
    writePending([])
    console.log('waiting calls cleared.')
    return 0
  }

  if (action === 'help' || action === '--help' || action === '-h') {
    console.log(USAGE)
    return 0
  }

  console.error(USAGE)
  return 1
}

function appHtml ({ token: secret, voiceName, voiceRate, lang }) {
  const finnish = /^fi(?:[-_]|$)/i.test(String(lang || 'en-US'))
  const L = finnish
    ? {
        brand: 'FREEBUFF \u00b7 puhelinlinja',
        connecting: 'yhdistet\u00e4\u00e4n',
        live: 'linja auki',
        reconnecting: 'yhdistet\u00e4\u00e4n uudelleen',
        ringTitle: 'Freebuff tarvitsee sinua',
        testTitle: 'Testisoitto',
        ringHint: 'Sano tai kirjoita \u201dhyv\u00e4ksy\u201d tai \u201dhylk\u00e4\u00e4\u201d.',
        approve: 'hyv\u00e4ksy',
        deny: 'hylk\u00e4\u00e4',
        dismiss: 'ohita',
        call: 'Soita',
        noMic: 'ei mikki\u00e4',
        hintIdle: 'Napauta puhuaksesi. Se kuuntelee vastauksen j\u00e4lkeen.',
        hintListening: 'Puhu nyt \u2014 napauta lopettaaksesi.',
        hintThinking: 'Freebuff miettii\u2026',
        hintSpeaking: 'Freebuff puhuu\u2026',
        hintBusy: 'Vastaus on viel\u00e4 kesken \u2014 hetki.',
        placeholder: 'kirjoita: tila, lopeta, hyv\u00e4ksy\u2026',
        send: 'l\u00e4het\u00e4',
        test: 'testisoitto',
        clear: 'tyhjenn\u00e4',
        noSpeechRecognition: 'T\u00e4m\u00e4 selain ei kuuntele \u2014 kirjoita komento alle.',
        micBlocked: 'Mikki on estetty. Salli se Safarin asetuksista.',
        noSpeech: 'En kuullut mit\u00e4\u00e4n. Napauta ja yrit\u00e4 uudelleen.',
        listenStopped: 'Kuuntelu pys\u00e4htyi: ',
        listenFailed: 'Kuuntelu ei k\u00e4ynnistynyt: ',
        unreachable: 'Puhelinlinja ei tavoittanut valvojaa: ',
        ringSent: 'Soitto l\u00e4hetetty.',
        testFailed: 'Testi ep\u00e4onnistui: ',
        announceTest: 'T\u00e4m\u00e4 on testisoitto freebuffista.',
        announceDecision: 'Moro. ',
        tapToHear: 'Napauta kerran, niin soitto luetaan \u00e4\u00e4neen.',
        voiceChosen: '\u00c4\u00e4ni: ',
        chooseVoice: 'valitse ääni',
        micStatus: 'mikki: ',
        hear: 'kuuntele',
        record: 'Puhu',
        recording: 'Tallennan \u2014 napauta lopettaaksesi',
        recordingHint: 'Napauta Puhu, puhu rauhassa ja napauta uudelleen.',
        transcribeOff: 'Puheen purku ei ole k\u00e4yt\u00f6ss\u00e4 \u2014 k\u00e4ytet\u00e4\u00e4n selaimen kuuntelua.',
        whisperMode: 'Kuuntelu t\u00e4ll\u00e4 sivulla ei toimi, joten \u00e4\u00e4ni l\u00e4hetet\u00e4\u00e4n tekstiksi. Napauta Puhu ja puhu.',
        whisperSwitched: 'Safarin kuuntelu ei vastannut \u2014 napauta Puhu, niin puhut suoraan tallennukseen.'
      }
    : {
        brand: 'FREEBUFF \u00b7 voice line',
        connecting: 'connecting',
        live: 'live',
        reconnecting: 'reconnecting',
        ringTitle: 'Freebuff needs you',
        testTitle: 'Test call',
        ringHint: 'Say or type \u201capprove\u201d or \u201cdeny\u201d.',
        approve: 'approve',
        deny: 'deny',
        dismiss: 'dismiss',
        call: 'Call',
        noMic: 'no mic',
        hintIdle: 'Tap to talk. It listens after it answers.',
        hintListening: 'Speak now \u2014 tap to stop.',
        hintThinking: 'Freebuff is thinking\u2026',
        hintSpeaking: 'Freebuff is talking\u2026',
        hintBusy: 'Still answering \u2014 one moment.',
        placeholder: 'type: status, stop, approve\u2026',
        send: 'send',
        test: 'ring test',
        clear: 'clear',
        noSpeechRecognition: 'This browser cannot listen \u2014 type a command below.',
        micBlocked: 'Microphone is blocked. Allow it in Safari settings.',
        noSpeech: 'I did not hear anything. Tap to try again.',
        listenStopped: 'Listening stopped: ',
        listenFailed: 'Could not start listening: ',
        unreachable: 'The voice line could not reach the supervisor: ',
        ringSent: 'Ring sent.',
        testFailed: 'Test failed: ',
        announceTest: 'This is a test call from freebuff.',
        announceDecision: 'Freebuff needs a decision. ',
        tapToHear: 'Tap once and the call is read out.',
        voiceChosen: 'Voice: ',
        chooseVoice: 'choose voice',
        micStatus: 'mic: ',
        hear: 'play',
        record: 'Talk',
        recording: 'Recording \u2014 tap to stop',
        recordingHint: 'Tap Talk, speak, then tap again.',
        transcribeOff: 'Transcription is not configured \u2014 using the browser recogniser.',
        whisperMode: 'Listening is not available in this browser, so your voice is sent as text instead. Tap Talk and speak.',
        whisperSwitched: 'Safari\u2019s recogniser did not answer \u2014 tap Talk and speak instead.'
      }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#0b0f14">
<title>Freebuff</title>
<style>
  :root { color-scheme: dark; --ink:#e8f4f8; --dim:#8aa0ad; --line:#1e2a35; --accent:#38e8d0; --bg:#0b0f14; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin:0; height:100%; background:var(--bg); color:var(--ink);
    font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { display:flex; flex-direction:column; padding: env(safe-area-inset-top) 18px env(safe-area-inset-bottom); }
  header { display:flex; align-items:center; justify-content:space-between; padding:14px 0 6px; }
  .brand { letter-spacing:.14em; font-size:12px; color:var(--dim); text-transform:uppercase; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--line); margin-right:8px; display:inline-block; }
  .dot.live { background:var(--accent); box-shadow:0 0 12px var(--accent); }
  #status { font-size:12px; color:var(--dim); display:flex; align-items:center; }
  #ring { display:none; border:1px solid var(--accent); border-radius:16px; padding:14px; margin:8px 0; }
  #ring.show { display:block; }
  #ring .why { color:var(--dim); font-size:13px; margin-top:4px; }
  #log { flex:1; overflow-y:auto; padding:12px 0 20px; display:flex; flex-direction:column; gap:10px; }
  .turn { max-width:88%; padding:11px 14px; border-radius:16px; white-space:pre-wrap; }
  .me { align-self:flex-end; background:#14212b; border:1px solid var(--line); }
  .you { align-self:flex-start; background:#0f2a28; border:1px solid #17413d; }
  .you.tts { color:var(--dim); font-style:italic; }
  /* Written details: paths and ids stay on screen, never read aloud. */
  .you.detail { color:var(--dim); font-size:13px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
  footer { padding:10px 0 max(18px, env(safe-area-inset-bottom)); display:flex; flex-direction:column; gap:10px; }
  #call { width:86px; height:86px; border-radius:50%; border:none; margin:0 auto; font-size:15px; font-weight:600;
    color:#04211d; background:var(--accent); box-shadow:0 10px 30px rgba(56,232,208,.25); }
  /* The talk button moves the way a call does: a slow ring while it listens,
     a stronger pulse while the reply is spoken, so it is obvious from across
     the room which side is talking. */
  #call { transition: background .2s ease, transform .15s ease; }
  #call.listening { background:#ffd166; animation: mic-pulse 1.2s ease-in-out infinite; }
  #call.thinking { background:#7cc4ff; animation: think-pulse 1.6s ease-in-out infinite; }
  #call.speaking { background:#c8a2ff; animation: talk-pulse .8s ease-in-out infinite; }
  #call:disabled { opacity:.6; }
  @keyframes mic-pulse {
    0%, 100% { transform:scale(1); box-shadow:0 0 0 0 rgba(255,209,102,.5); }
    50% { transform:scale(1.06); box-shadow:0 0 0 16px rgba(255,209,102,0); }
  }
  @keyframes talk-pulse {
    0%, 100% { transform:scale(1.04); box-shadow:0 0 0 0 rgba(200,162,255,.55); }
    50% { transform:scale(1.12); box-shadow:0 0 0 20px rgba(200,162,255,0); }
  }
  @keyframes think-pulse {
    0%, 100% { transform:scale(1); }
    50% { transform:scale(1.04); }
  }
  .hint { text-align:center; font-size:12px; color:var(--dim); }
  button.ghost { background:transparent; border:1px solid var(--line); color:var(--dim); border-radius:10px; padding:8px 12px; font-size:12px; }
  .row { display:flex; gap:8px; justify-content:center; }
  /* Typing is the fallback for browsers that refuse speech recognition:
     DuckDuckGo, in-app browsers, and anything without a working mic. */
  #composer { display:flex; gap:8px; }
  #composer input { flex:1; min-width:0; background:#0e1720; border:1px solid var(--line); color:var(--ink);
    border-radius:12px; padding:12px 14px; font:inherit; }
  #composer input::placeholder { color:var(--dim); }
  #composer button { background:var(--accent); color:#04211d; border:none; border-radius:12px;
    padding:0 18px; font-weight:600; font-size:14px; }
  /* The live question from the session: each choice is one tap. */
  .hidden { display:none !important; }
  #question { border:1px solid var(--line); border-radius:12px; padding:10px 12px; display:flex;
    flex-direction:column; gap:8px; }
  #questiontitle { font-size:13px; color:var(--ink); }
  #options { flex-wrap:wrap; }
  #options button { flex:1 1 40%; text-align:left; }
  /* One control for the voice: it shows the voice in use and opens the
     phone's own list, the way a model row does in a freebuff session. */
  #voicepick { width:100%; background:#0e1720; border:1px solid var(--line); color:var(--dim);
    border-radius:10px; padding:9px 12px; font:inherit; font-size:12px; text-align:center;
    appearance:none; -webkit-appearance:none; }
</style>
</head>
<body>
<header>
  <div class="brand">${L.brand}</div>
  <div id="status"><span class="dot" id="dot"></span><span id="statustext">${L.connecting}</span></div>
</header>
<section id="ring">
  <strong id="ringtitle">${L.ringTitle}</strong>
  <div class="why" id="ringwhy"></div>
  <div class="hint" style="text-align:left;margin-top:8px">${L.ringHint}</div>
  <div class="row" style="margin-top:10px">
    <button class="ghost" id="approve">${L.approve}</button>
    <button class="ghost" id="deny">${L.deny}</button>
    <button class="ghost" id="hear">${L.hear}</button>
    <button class="ghost" id="dismiss">${L.dismiss}</button>
  </div>
</section>
<section id="question" class="hidden">
  <strong id="questiontitle"></strong>
  <div class="row" id="options"></div>
</section>
<main id="log" aria-live="polite"></main>
<footer>
  <button id="call">${L.call}</button>
  <div class="hint" id="hint">${L.hintIdle}</div>
  <form id="composer" autocomplete="off">
    <input id="say" type="text" autocomplete="off" autocapitalize="sentences" enterkeyhint="send"
      placeholder="${L.placeholder}" aria-label="${L.placeholder}">
    <button id="send" type="submit">${L.send}</button>
  </form>
  <select id="voicepick" aria-label="${L.chooseVoice}"></select>
  <div class="row">
    <button class="ghost" id="test">${L.test}</button>
    <button class="ghost" id="clear">${L.clear}</button>
  </div>
</footer>
<script>
'use strict'
const TOKEN = ${JSON.stringify(secret)}
let PREFERRED_VOICE = ${JSON.stringify(voiceName || '')}
const RATE = ${JSON.stringify(voiceRate || 1)}
const log = document.getElementById('log')
const call = document.getElementById('call')
const hint = document.getElementById('hint')
const dot = document.getElementById('dot')
const statustext = document.getElementById('statustext')
const ringBox = document.getElementById('ring')
const composer = document.getElementById('composer')
const say = document.getElementById('say')
const questionBox = document.getElementById('question')
const questionTitle = document.getElementById('questiontitle')
const optionsBox = document.getElementById('options')
const voicepick = document.getElementById('voicepick')
const SR = window.SpeechRecognition || window.webkitSpeechRecognition
// Language of the line, decided by the supervisor, not by the phone's locale.
const L = ${JSON.stringify(L)}
const LANG = ${JSON.stringify(String(lang || 'en-US'))}
const FI = ${finnish}
const T = {
  dialogFallback: FI ? 'kysymys' : 'a question',
  multi: FI ? '(voit valita useamman)' : '(you can pick more than one)',
  voiceAuto: FI ? 'Automaattinen — puhelimen oma ääni' : 'Automatic — the phone\u2019s own voice',
  chosen: FI ? 'Valittu ääni: ' : 'Voice: '
}

let listening = false
let busy = false
let wantListening = false
let recognizer = null
let voices = []

function setState (state, text) {
  call.className = state
  call.textContent = state === 'listening' ? (FI ? 'Kuuntelen' : 'Listening')
    : state === 'thinking' ? (FI ? 'Mietin' : 'Thinking')
    : state === 'speaking' ? (FI ? 'Puhun' : 'Speaking')
    : whisperMode ? L.record
    : L.call
  hint.textContent = text || (state === 'listening'
    ? L.hintListening
    : state === 'thinking' ? L.hintThinking
    : state === 'speaking' ? L.hintSpeaking
    : L.hintIdle)
}

function add (text, who, extra) {
  const div = document.createElement('div')
  div.className = 'turn ' + who + (extra ? ' ' + extra : '')
  div.textContent = text
  log.appendChild(div)
  log.scrollTop = log.scrollHeight
  return div
}

function pickVoice () {
  // The line's own language wins: a Finnish reply read by an English voice is
  // worse than no preference at all.
  const primary = String(LANG).toLowerCase().split(/[-_]/)[0]
  const sameLang = voices.filter((v) => String(v.lang).toLowerCase().startsWith(primary))
  // A downloaded Premium/Enhanced voice sounds like a person; the built-in
  // compact one sounds like a 1990s answering machine. When both are installed
  // the better one is not necessarily first in the list, so prefer it by name.
  const better = (v) => /premium|enhanced|neural|natural|siri/i.test(v.name)
  if (PREFERRED_VOICE) {
    const wanted = sameLang.find(
      (v) => v.name.toLowerCase() === PREFERRED_VOICE.toLowerCase()
    )
    if (wanted) return wanted
  }
  const best = sameLang.find(better)
  if (best) return best
  const sameLanguage = sameLang[0]
  if (sameLanguage) return sameLanguage
  for (const name of ${JSON.stringify(PREFERRED_VOICES)}) {
    const found = voices.find((v) => v.name.toLowerCase() === name.toLowerCase())
    if (found) return found
  }
  return voices[0] || null
}

/**
 * The question the session is showing right now, with one button per choice.
 * This is the live view of the supervisor call: the phone sees the same rows
 * the person would see in the terminal, and answers with one tap.
 */
function renderQuestion (state) {
  const asking = (state.work || []).filter((item) => item.dialog)
  if (asking.length === 0) {
    questionBox.classList.add('hidden')
    optionsBox.innerHTML = ''
    return
  }
  const item = asking[0]
  const dialog = item.dialog
  questionTitle.textContent = (item.account ? item.account + ' · ' : '') +
    (dialog.question || T.dialogFallback) + (dialog.multi ? ' ' + T.multi : '')
  optionsBox.innerHTML = ''
  for (const option of dialog.options || []) {
    const button = document.createElement('button')
    button.className = 'ghost'
    button.textContent = option.index + '. ' + option.text + (option.checked ? ' ✓' : '')
    button.addEventListener('click', (event) => {
      event.preventDefault()
      chooseOption(item.sessionId, option)
    })
    optionsBox.appendChild(button)
  }
  questionBox.classList.remove('hidden')
}

async function chooseOption (sessionId, option) {
  add(option.index + '. ' + option.text, 'me')
  setState('thinking')
  try {
    const data = await post('/api/turn', { text: 'valitse ' + option.index, session: sessionId })
    add(data.reply, 'you')
    if (data.display) add(data.display, 'you', 'detail')
    await speak(data.reply)
  } catch (error) {
    add(L.unreachable + error.message, 'you', 'tts')
  } finally {
    setState('off')
  }
}

/**
 * One picker for the whole line: it shows the voice in use and opens the
 * phone's own list. iOS lists the same voice twice (a compact one and the
 * downloaded Premium/Enhanced one), which used to read as two identical
 * buttons, so a name is only offered once.
 */
function renderVoices () {
  if (!voicepick || !('speechSynthesis' in window)) return
  const primary = String(LANG).toLowerCase().split(/[-_]/)[0]
  const seen = new Set()
  const list = []
  for (const voice of voices || []) {
    if (!String(voice.lang).toLowerCase().startsWith(primary)) continue
    const key = String(voice.name).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    list.push(voice)
  }

  voicepick.innerHTML = ''
  const auto = document.createElement('option')
  auto.value = ''
  auto.textContent = T.voiceAuto
  voicepick.appendChild(auto)
  for (const voice of list) {
    const option = document.createElement('option')
    option.value = voice.name
    option.textContent = voice.name
    voicepick.appendChild(option)
  }
  // A stored voice this phone no longer has still reads as the choice.
  if (PREFERRED_VOICE && !list.some((voice) => voice.name === PREFERRED_VOICE)) {
    const stored = document.createElement('option')
    stored.value = PREFERRED_VOICE
    stored.textContent = PREFERRED_VOICE
    voicepick.appendChild(stored)
  }
  voicepick.value = PREFERRED_VOICE || ''
}

/**
 * The choice is used before it is saved: the phone speaks in the voice that
 * was just picked even when the request that stores it fails, and the picker
 * keeps showing it.
 */
async function setVoice (name) {
  PREFERRED_VOICE = name
  renderVoices()
  const chosen = pickVoice()
  hint.textContent = T.chosen + (chosen ? chosen.name : T.voiceAuto)
  if (chosen) {
    await speak(FI ? 'Moi, tältä minä kuulostan.' : 'Hi, this is how I sound.', { force: true })
  }
  try {
    await post('/api/voice', { name })
  } catch (error) {
    hint.textContent = L.unreachable + error.message
  }
}

if (voicepick) {
  voicepick.addEventListener('change', () => { setVoice(voicepick.value) })
}

let voiceUnlocked = false
let spokeAtLeastOnce = false
let lastAnnouncement = ''
let announcementSpoken = false

/**
 * iOS only lets speechSynthesis start from a user gesture. The replies and
 * rings arrive later, from a fetch or the event stream, so the first tap or
 * keypress speaks one silent syllable to unlock it for the whole visit.
 */
function unlockVoice () {
  if (voiceUnlocked || !('speechSynthesis' in window)) return
  voiceUnlocked = true
  try {
    const warm = new SpeechSynthesisUtterance(' ')
    warm.volume = 0
    speechSynthesis.speak(warm)
  } catch {}
}

let speakingNow = false

/** The phone's own voice speaks every reply: no audio is generated server-side. */
async function speak (text, options = {}) {
  if (!text) return
  // One voice at a time. A single tap fires pointerdown, touchstart, touchend
  // and click, and each of those used to cancel and restart the sentence —
  // the call appeared to loop its opening line.
  if (speakingNow && !options.force) return
  return speakSystem(text, options)
}

function speakSystem (text, options = {}) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window) || !text) { resolve(); return }
    if (speakingNow && !options.force) { resolve(); return }
    try { speechSynthesis.cancel() } catch {}
    const utterance = new SpeechSynthesisUtterance(text)
    // iOS silently drops speech that was not started by a gesture. There is no
    // error event for that, so the first sound is watched for instead: if
    // nothing starts, the page says so and asks for one tap.
    utterance.onstart = () => {
      spokeAtLeastOnce = true
      if (text === lastAnnouncement) announcementSpoken = true
    }
    setTimeout(() => {
      if (!spokeAtLeastOnce) hint.textContent = L.tapToHear
    }, 900)
    const voice = pickVoice()
    if (voice) utterance.voice = voice
    utterance.lang = LANG
    utterance.rate = RATE
    utterance.pitch = 1
    speakingNow = true
    const finish = () => { speakingNow = false; resolve() }
    utterance.onend = finish
    utterance.onerror = finish
    // iOS drops an utterance queued in the same tick as cancel(), and a reply
    // spoken straight out of a fetch callback is not a user gesture. A short
    // pause after the silent warm-up is what makes the first reply audible.
    setTimeout(() => {
      setState('speaking')
      try { speechSynthesis.speak(utterance) } catch { resolve() }
    }, 80)
    // A phone can drop the end event when the screen locks; do not hang.
    setTimeout(finish, Math.min(30000, 5000 + text.length * 90))
  })
}

async function post (path, body) {
  const response = await fetch(path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  })
  if (!response.ok) throw new Error('request failed: ' + response.status)
  return response.json()
}

async function turn (text) {
  if (!text.trim() || busy) return
  busy = true
  add(text, 'me')
  setState('thinking')
  try {
    const data = await post('/api/turn', { text })
    add(data.reply, 'you')
    if (data.display) add(data.display, 'you', 'detail')
    await speak(data.reply)
  } catch (error) {
    add(L.unreachable + error.message, 'you', 'tts')
  } finally {
    busy = false
    if (wantListening) listen()
    else setState('off')
  }
}

let micChecked = false
let noSpeechTries = 0

/** Ask for the microphone once, so a blocked mic says so instead of silence. */
let recordingStream = null

async function micAllowed () {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return true
  try {
    // Kept open for the recording that follows, instead of being opened twice.
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    return true
  } catch {
    hint.textContent = L.micBlocked
    return false
  }
}

async function listen () {
  if (whisperMode) {
    // Recording needs a tap to start and to stop; it cannot run by itself.
    hint.textContent = L.recordingHint
    return
  }
  if (!SR) {
    hint.textContent = L.noSpeechRecognition
    return
  }
  if (listening || busy) return
  // iOS gives a recogniser that starts and hears nothing when the page has no
  // microphone permission, so the permission is the first thing checked.
  if (!micChecked) {
    micChecked = true
    if (!(await micAllowed())) { wantListening = false; return }
  }
  // Never talk over the reply that is still playing.
  try { speechSynthesis.cancel() } catch {}
  // iOS keeps the audio session in playback mode for a moment after speech is
  // cancelled. Starting the recogniser inside that window is the usual reason
  // a call hears nothing, so the microphone is opened a beat later.
  await new Promise((resolve) => setTimeout(resolve, 250))
  try {
    recognizer = new SR()
    // The line's language, not the phone's: a Finnish line expects Finnish.
    recognizer.lang = LANG
    recognizer.interimResults = false
    recognizer.continuous = false
    recognizer.maxAlternatives = 1
    recognizer.onresult = (event) => {
      noSpeechTries = 0
      const text = Array.from(event.results).map((result) => result[0].transcript).join(' ').trim()
      if (text) turn(text)
    }
    recognizer.onerror = (event) => {
      listening = false
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed' || event.error === 'audio-capture') {
        wantListening = false
        setState('off', L.micBlocked)
      } else if (event.error === 'no-speech' && wantListening && noSpeechTries < 2) {
        // The mic opened but heard nothing: on iOS this is common the first
        // time after the voice has spoken, so it listens again by itself
        // instead of asking for another tap.
        noSpeechTries += 1
        setState('listening', L.hintListening)
        setTimeout(() => listen(), 300)
      } else if (event.error === 'no-speech') {
        // The recogniser has now failed for good this visit: switch the button
        // to recording so the next tap actually reaches Whisper.
        whisperMode = true
        call.textContent = L.record
        setState('off', L.whisperSwitched)
      } else {
        setState('off', L.listenStopped + event.error)
      }
    }
    recognizer.onend = () => {
      listening = false
      if (wantListening && !busy) setTimeout(() => listen(), 350)
      else if (!busy) setState('off')
    }
    listening = true
    setState('listening')
    recognizer.start()
  } catch (error) {
    listening = false
    setState('off', L.listenFailed + error.message)
  }
}

function stopListening () {
  wantListening = false
  if (recognizer) {
    try { recognizer.stop() } catch {}
  }
  try { speechSynthesis.cancel() } catch {}
  listening = false
  setState('off')
}

// Recording and Whisper is the default, not a fallback: Safari's own
// recogniser is what made a call hear nothing half the time, and Whisper
// understands ordinary, mumbled Finnish far better than a live recogniser.
let whisperMode = true
let recorder = null
let recording = false
let chunks = []

/**
 * The dependable way to hear an answer on iOS: record it and let the server
 * transcribe. Safari's own recogniser opens and hears nothing too often to be
 * the only way in.
 */
async function toggleRecording () {
  if (recording) {
    recording = false
    try { recorder.stop() } catch {}
    return
  }
  // A reply still being spoken would be recorded and transcribed as if the
  // owner had said it, which turns every answer into nonsense.
  try { speechSynthesis.cancel() } catch {}
  speakingNow = false
  if (!(await micAllowed())) return
  await new Promise((resolve) => setTimeout(resolve, 250))
  try {
    // One microphone stream only: probing and then re-opening it leaves iOS
    // with a dead track on some versions.
    const stream = recordingStream || await navigator.mediaDevices.getUserMedia({ audio: true })
    const type = window.MediaRecorder && MediaRecorder.isTypeSupported('audio/mp4')
      ? 'audio/mp4'
      : (window.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '')
    recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream)
    chunks = []
    recorder.ondataavailable = (event) => { if (event.data && event.data.size) chunks.push(event.data) }
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop())
      recordingStream = null
      const blob = new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' })
      setState('thinking')
      try {
        const response = await fetch('/api/transcribe?token=' + encodeURIComponent(TOKEN), {
          method: 'POST',
          headers: { 'content-type': blob.type || 'audio/webm' },
          body: blob
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || ('transcription failed: ' + response.status))
        const text = String(data.text || '').trim()
        if (!text) { setState('off', L.noSpeech); return }
        await turn(text)
      } catch (error) {
        // The server has no transcription endpoint or key: fall back to the
        // browser's own recogniser, which is worse but needs nothing.
        if (SR && /model key|404|not found|transcription failed: 5/i.test(error.message)) {
          whisperMode = false
          hint.textContent = L.transcribeOff
          setState('off')
          wantListening = true
          listen()
          return
        }
        setState('off', L.unreachable + error.message)
      }
    }
    recorder.start()
    recording = true
    setState('listening', L.recording)
  } catch (error) {
    setState('off', L.listenFailed + error.message)
  }
}

call.addEventListener('click', () => {
  if (whisperMode) { toggleRecording(); return }
  if (wantListening) { stopListening(); return }
  wantListening = true
  listen()
})

document.getElementById('hear').addEventListener('click', () => {
  if (lastAnnouncement) speak(lastAnnouncement, { force: true })
})

document.getElementById('test').addEventListener('click', async () => {
  try {
    await post('/api/ring', { kind: 'test', question: L.announceTest })
    hint.textContent = L.ringSent
  } catch (error) { hint.textContent = L.testFailed + error.message }
})

document.getElementById('clear').addEventListener('click', () => { log.innerHTML = '' })
composer.addEventListener('submit', async (event) => {
  event.preventDefault()
  const text = say.value.trim()
  if (!text) return
  if (busy) { hint.textContent = L.hintBusy; return }
  say.value = ''
  await turn(text)
})
document.getElementById('approve').addEventListener('click', async () => {
  ringBox.classList.remove('show')
  await turn('approve')
})
document.getElementById('deny').addEventListener('click', async () => {
  ringBox.classList.remove('show')
  await turn('deny')
})
document.getElementById('dismiss').addEventListener('click', async () => {
  ringBox.classList.remove('show')
  try { await post('/api/resolve', {}) } catch {}
})

function showRing (ask) {
  ringBox.classList.add('show')
  document.getElementById('ringtitle').textContent = ask.kind === 'test' ? L.testTitle : L.ringTitle
  document.getElementById('ringwhy').textContent = ask.question + (ask.action ? ' ' + ask.action : '')
  // The server already phrased the call: greeting, then the problem. Older
  // stored asks have no speech, so the plain sentence stays as a fallback.
  const announcement = ask.kind === 'test' ? L.announceTest : (ask.speech || L.announceDecision + ask.question)
  if (announcement !== lastAnnouncement) announcementSpoken = false
  lastAnnouncement = announcement
  // A replayed ring (reconnect, or the page being opened after the call) is
  // spoken too when the owner is answering it, and then it listens for the
  // answer: answering a call should not need a second tap.
  if (!ask.replay || ask.auto) {
    if (navigator.vibrate) navigator.vibrate([180, 90, 180])
    return speak(announcement)
  }
  return Promise.resolve()
}

let callAnswered = false

/**
 * Opened from the ring notification: say the call straight away and start
 * listening for the answer, instead of waiting for a tap on the call button.
 */
async function answerWaitingRing () {
  if (callAnswered) return
  let ask = null
  try {
    const response = await fetch('/api/state?token=' + encodeURIComponent(TOKEN))
    if (!response.ok) return
    const state = await response.json()
    const pending = state.pending || []
    if (pending.length > 0) ask = pending[pending.length - 1]
  } catch {
    return
  }
  if (!ask) return
  callAnswered = true
  const startedAt = Date.now()
  await showRing({ ...ask, auto: true })
  // iOS refuses speechSynthesis outside a gesture. When the line ends in
  // milliseconds nothing was heard, so the first touch says it again.
  if (Date.now() - startedAt < 400) {
    callAnswered = false
    hint.textContent = L.tapToHear
    const again = () => { document.removeEventListener('pointerdown', again); answerWaitingRing() }
    document.addEventListener('pointerdown', again, { once: true })
    return
  }
  if (SR && !busy && !whisperMode) {
    wantListening = true
    listen()
  }
}

function connect () {
  const source = new EventSource('/api/events?token=' + encodeURIComponent(TOKEN))
  source.addEventListener('open', () => { dot.classList.add('live'); statustext.textContent = L.live })
  source.addEventListener('error', () => { dot.classList.remove('live'); statustext.textContent = L.reconnecting })
  source.addEventListener('ring', (event) => {
    try { showRing(JSON.parse(event.data)) } catch {}
  })
  source.addEventListener('resolved', () => ringBox.classList.remove('show'))
  // The line pushes a session's state as soon as it changes (idle, interrupted,
  // ended), so the page shows it without waiting for its own poll.
  source.addEventListener('sessions', () => { refresh() })
}

async function refresh () {
  try {
    const response = await fetch('/api/state?token=' + encodeURIComponent(TOKEN))
    if (!response.ok) return
    const state = await response.json()
    dot.classList.add('live')
    // The server owns the choice, so a reload or a second phone shows the
    // voice that is stored rather than the one this page was served with.
    if (state.voice && typeof state.voice.name === 'string' &&
      state.voice.name !== PREFERRED_VOICE) {
      PREFERRED_VOICE = state.voice.name
      renderVoices()
    }
    renderQuestion(state)
    const idle = (state.work || []).filter(
      (item) => item.live !== false && item.phase !== 'working' && item.phase !== 'unknown'
    ).length
    statustext.textContent = FI
      ? state.live + ' istuntoa · ' + state.signedIn + ' tiliä' + (idle ? ' · ' + idle + ' ei työstä' : '')
      : state.live + ' live · ' + state.signedIn + ' accounts' + (idle ? ' · ' + idle + ' idle' : '')
  } catch {}
}

if ('speechSynthesis' in window) {
  // The chosen voice is written under the buttons once, so it is obvious from
  // the phone whether the Premium voice is actually the one in use.
  const load = () => {
    voices = speechSynthesis.getVoices() || []
    renderVoices()
    const v = pickVoice()
    if (v && !hint.dataset.voice) {
      hint.dataset.voice = '1'
      // The same line says whether this browser can hear at all: Safari can,
      // DuckDuckGo and a home-screen icon cannot.
      hint.textContent = L.voiceChosen + v.name + ' \u00b7 ' + L.micStatus + (SR ? 'ok' : '\u2014')
    }
  }
  load()
  speechSynthesis.addEventListener('voiceschanged', load)
}
// The button talks to Whisper. With no recogniser at all (DuckDuckGo, an
// in-app browser, a home-screen icon) that is still the one path that works.
call.textContent = L.record
if (!SR) hint.textContent = L.whisperMode
else hint.textContent = L.recordingHint
/**
 * Speaking without a tap.
 *
 * iOS only lets speech start from a gesture, but the first interaction with
 * the page is itself a gesture: a scroll, a tap on the screen, the tap that
 * opened the link. All of them unlock the voice, and if a ring is waiting and
 * has not been heard yet, it is read out at that moment instead of sitting
 * there as text.
 */
let armed = false
function armFromGesture () {
  if (!armed) {
    armed = true
    unlockVoice()
  }
  if (lastAnnouncement && !announcementSpoken && !speakingNow) speak(lastAnnouncement)
}
for (const event of ['pointerdown', 'touchstart', 'touchend', 'click', 'keydown', 'scroll']) {
  document.addEventListener(event, armFromGesture, { passive: true })
}
// A page that is unlocked once stays unlocked; coming back to it should not
// need a fresh tap either.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  if (lastAnnouncement && !announcementSpoken && !speakingNow) speak(lastAnnouncement)
})
// A silent element played at load warms the media session on WebKit, which is
// what lets the first real sound come out without another gesture.
if ('speechSynthesis' in window) {
  try {
    const warm = new SpeechSynthesisUtterance(' ')
    warm.volume = 0
    warm.onstart = () => { voiceUnlocked = true; spokeAtLeastOnce = true }
    speechSynthesis.speak(warm)
  } catch {}
}
connect()
refresh()
// Answering a call starts the call: the ring line is spoken on arrival and the
// microphone is opened for the reply without another tap.
answerWaitingRing()
setInterval(refresh, 15000)
</script>
</body>
</html>`
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_LLM_URL,
  DEFAULT_LLM_MODEL,
  NTFY_BASE,
  PREFERRED_VOICES,
  voiceDir,
  heartbeatPath,
  pendingPath,
  readPending,
  writePending,
  tasksPath,
  readTasks,
  writeTasks,
  queueTask,
  takeTask,
  answersPath,
  readAnswers,
  writeAnswers,
  queueAnswer,
  takeAnswer,
  token,
  settings,
  updateSettings,
  setEnabled,
  running,
  callUrl,
  summary,
  snapshot,
  statusSpeech,
  statusParts,
  answer,
  llmReply,
  englishTask,
  transcribeAudio,
  personaBlock,
  ringSpeech,
  ringFallback,
  contextFor,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_FI,
  ntfyUrl,
  pushRing,
  ring,
  ensureServer,
  stopServer,
  serve,
  serveCommand,
  voiceCommand,
  USAGE,
  appHtml
}
