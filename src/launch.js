'use strict'

const crypto = require('crypto')
const path = require('path')
const { spawn } = require('child_process')
const { ensureDirs } = require('./paths')
const { loadState, mutateState } = require('./state')
const accounts = require('./accounts')
const { logLine, logEvent } = require('./log')
const {
  resolveBinary,
  environmentFor,
  spawnFreebuff,
  waitForExit,
  resetTerminal
} = require('./freebuff')
const { createAuthWatcher } = require('./authwatch')
const diagnose = require('./diagnose')
const { windowCommand } = require('./terminal')
const notify = require('./notify')
const voice = require('./voice')
const sudo = require('./sudo')
const { supervise, activityStamp, DEFAULT_NUDGE_MS } = require('./supervise')
const limits = require('./limits')
const credits = require('./credits')
const {
  runOnPty,
  available: ptyAvailable,
  DEFAULT_RESUME_MS
} = require('./ptyrun')
const task = require('./task')
const handoff = require('./handoff')
const { nowIso, formatDuration, shortHome } = require('./util')

/**
 * How long a "this session cannot run" state freebuff showed still counts as
 * the current one. The pty re-reports a state while it is on screen, so an old
 * one that expired is not the reason a prompt is stuck now.
 */
const LIMIT_FRESH_MS = 90 * 1000

/**
 * The short prompt typed at a session whose conversation is already resumed:
 * the task and everything done so far are in that chat, so repeating them back
 * at it was re-explaining the whole session on every restart.
 */
const RESUME_PROMPT =
  'Continue from where you left off. Do not repeat work that is already done.'

/**
 * The short push typed at a session that went quiet. The pty only sends it when
 * no turn is running and the input box is empty, so a working session is never
 * interrupted by it.
 */
const NUDGE_TEXT =
  'Continue working on the task. Ignore this prompt if you are already working.'

function newSessionId () {
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
}

function flagValue (env, name, fallback) {
  const raw = String((env && env[name]) || '').trim().toLowerCase()
  if (raw === '') return fallback
  return !['0', 'false', 'no', 'off'].includes(raw)
}

/** A flag that was left alone, so the caller can choose its own default. */
function envFlag (env, name) {
  const raw = String((env && env[name]) || '').trim().toLowerCase()
  if (raw === '') return null
  return !['0', 'false', 'no', 'off'].includes(raw)
}

/**
 * Split supervisor flags from freebuff's own arguments. Everything that is not
 * ours is forwarded untouched so `sfreebuff --continue` behaves like freebuff.
 */
function parseLaunchFlags (argv, env = process.env) {
  const passthrough = []
  let requested = null
  let monitor = true
  // A session that survives its own failures is the default; --once restores
  // the old "run freebuff and return" behaviour.
  let forever = flagValue(env, 'FREEBUFFS_FOREVER', true)
  // null means "use a pty when node-pty is installed". The supervisor can only
  // answer a retry screen or ask a fresh session to continue by typing into
  // it, which needs a pseudo-terminal, so this defaults on where it can work.
  let pty = envFlag(env, 'FREEBUFFS_PTY')
  let useSudo = sudo.enabled(env)
  // The dashboard's "new session" asks for a conversation of its own instead of
  // this folder's last one. It is ours to consume: freebuff has no such flag.
  let fresh = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--account') {
      requested = argv[index + 1] || null
      index += 1
      continue
    }
    if (arg.startsWith('--account=')) {
      requested = arg.slice('--account='.length)
      continue
    }
    if (arg === '--no-monitor') {
      monitor = false
      continue
    }
    if (arg === '--once' || arg === '--no-forever') {
      forever = false
      continue
    }
    if (arg === '--forever') {
      forever = true
      continue
    }
    if (arg === '--pty') {
      pty = true
      continue
    }
    if (arg === '--no-pty') {
      pty = false
      continue
    }
    if (arg === '--no-sudo') {
      useSudo = false
      continue
    }
    if (arg === '--fresh') {
      fresh = true
      continue
    }
    passthrough.push(arg)
  }

  return { passthrough, requested, monitor, forever, pty, sudo: useSudo, fresh }
}

/**
 * What to type at a quiet session, and after how long.
 *
 * freebuff accepts no prompt as an argument — its only positional is the
 * `login` command, and `--continue` would swallow a trailing word as a
 * conversation id — so this is typed into the session, which means `--pty`.
 */
function nudgeConfig (env = process.env) {
  const custom = String(env.FREEBUFFS_CONTINUE_PROMPT || '').trim()
  const text = custom ||
    'Continue the unfinished task from the previous session. Inspect the ' +
    'repository and any notes from earlier sessions to see what is already ' +
    'done, then finish the remaining work. Do not start over.'
  const idleMs = Number(env.FREEBUFFS_NUDGE_MS)
  // Unset means "keep pushing an idle session forever": a task left waiting is
  // the failure the supervisor exists to prevent. FREEBUFFS_MAX_NUDGES still
  // caps it (0 turns nudging off) for anyone who wants the old behaviour.
  const maxRaw = String(env.FREEBUFFS_MAX_NUDGES || '').trim()
  const max = maxRaw === '' ? Infinity : Number(maxRaw)
  const resumeMs = Number(env.FREEBUFFS_RESUME_MS)
  return {
    text,
    // The periodic "keep working" push is short: the conversation already has
    // the task, so it only has to say to carry on.
    nudgeText: custom || NUDGE_TEXT,
    // An explicit prompt is used exactly as given, without the recovered task
    // appended, because the person running it chose those words.
    custom: Boolean(custom),
    idleMs: Number.isFinite(idleMs) && idleMs > 0 ? idleMs : DEFAULT_NUDGE_MS,
    max: Number.isFinite(max) && max >= 0 ? max : Infinity,
    resumeMs: Number.isFinite(resumeMs) && resumeMs >= 0 ? resumeMs : DEFAULT_RESUME_MS
  }
}

function cwdFromArgs (argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--cwd' && argv[index + 1]) return path.resolve(argv[index + 1])
    if (arg.startsWith('--cwd=')) return path.resolve(arg.slice('--cwd='.length))
  }
  return null
}

function hasContinue (argv) {
  return argv.some((arg) => arg === '--continue' || arg.startsWith('--continue='))
}

/** The arguments without a `--cwd` of their own, so one can be put in front. */
function withoutFolder (args) {
  const kept = []
  const list = Array.isArray(args) ? args : []
  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index]
    if (arg === '--cwd') {
      if (list[index + 1] !== undefined && !String(list[index + 1]).startsWith('-')) {
        index += 1
      }
      continue
    }
    if (arg.startsWith('--cwd=')) continue
    kept.push(arg)
  }
  return kept
}

/**
 * Name the folder the session runs in, on every launch.
 *
 * freebuff treats the directory it was started in as the project, and a
 * directory it does not consider a project gets its project picker — a list of
 * folders — instead of a chat. Relying on the inherited working directory made
 * an automatic restart depend on that: the folder is now part of the arguments,
 * so a relaunch continues in exactly the folder the previous session worked in.
 *
 * An explicit `--cwd` that points at the same folder is left exactly as given.
 * A different one is replaced: when the supervisor recovers the folder a
 * previous session used, the stale `--cwd` from the launch would otherwise put
 * freebuff back on the picker.
 */
function withFolder (args, cwd) {
  const list = Array.isArray(args) ? args : []
  if (!cwd) return list
  const explicit = cwdFromArgs(list)
  if (explicit && path.resolve(explicit) === path.resolve(cwd)) return list
  return ['--cwd', cwd, ...withoutFolder(list)]
}

/**
 * The same arguments without a resume flag — and without the id it carried.
 *
 * A conversation id left behind on its own is a positional argument, and
 * freebuff's only positional is `login`: a stray id makes the launch fail
 * instead of starting the fresh chat that was asked for.
 */
function withoutContinueArgs (args) {
  const kept = []
  const list = Array.isArray(args) ? args : []
  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index]
    if (arg === '--continue') {
      const next = list[index + 1]
      if (next !== undefined && !String(next).startsWith('-')) index += 1
      continue
    }
    if (arg.startsWith('--continue=')) continue
    kept.push(arg)
  }
  return kept
}

/** Quote one cmd.exe argument; only what cmd would split needs quotes. */
function quoteWindowsArg (value) {
  const text = String(value)
  if (text && !/[\s"&|<>^()]/.test(text)) return text
  return `"${text.replace(/"/g, '')}"`
}

/**
 * A visible supervisor window is the default; FREEBUFFS_MONITOR_WINDOW=0 keeps
 * the monitor silent, which a scripted or remote run may prefer.
 */
function monitorWindowEnabled (env = process.env) {
  const value = String((env && env.FREEBUFFS_MONITOR_WINDOW) || '').trim().toLowerCase()
  return !['0', 'false', 'no', 'off'].includes(value)
}

/**
 * How to start the side monitor.
 *
 * With a window the monitor is visible while the TUI has the terminal:
 * on Windows `detached` only detaches the process without giving it a console,
 * so `cmd start` opens one; on macOS and Linux a terminal emulator is asked to
 * run the monitor. Without a window — `window: false`, or no emulator to be
 * found — it stays a plain detached process that only writes to the log.
 */
function monitorLaunch ({ platform, execPath, monitorPath, sessionId, accountId, pid, cwd, env, window = true }) {
  const base = [
    '--session', sessionId,
    '--account', accountId,
    '--pid', String(pid),
    '--cwd', cwd
  ]
  const options = { detached: true, stdio: 'ignore', env }

  if (!window) {
    return { command: execPath, args: [monitorPath, ...base], options }
  }

  const argv = [...base, '--window', 'true']

  if (platform === 'win32') {
    const command = [
      'start',
      '"sfreebuff supervisor"',
      quoteWindowsArg(execPath),
      quoteWindowsArg(monitorPath),
      ...argv.map(quoteWindowsArg)
    ].join(' ')

    return {
      command: 'cmd.exe',
      // /s keeps cmd from stripping the quotes around paths with spaces.
      args: ['/d', '/s', '/c', `"${command}"`],
      options: { ...options, windowsVerbatimArguments: true }
    }
  }

  const plan = windowCommand({
    platform,
    command: execPath,
    args: [monitorPath, ...argv],
    env
  })
  if (plan) {
    return { command: plan.command, args: plan.args, options }
  }

  // No terminal emulator here: the monitor still runs, it just cannot be seen.
  return { command: execPath, args: [monitorPath, ...base], options }
}

function spawnMonitor ({ sessionId, account, pid, cwd, window }) {
  const plan = monitorLaunch({
    platform: process.platform,
    execPath: process.execPath,
    monitorPath: path.join(__dirname, 'monitor.js'),
    sessionId,
    accountId: account.id,
    pid,
    cwd,
    env: process.env,
    window: window === undefined || window === null ? monitorWindowEnabled() : window
  })

  const child = spawn(plan.command, plan.args, plan.options)
  // A failed supervisor must not take the freebuff session down with it.
  child.on('error', (error) => {
    logLine('error', 'monitor.spawn_failed', {
      session: sessionId,
      account: account.id,
      error: error.message
    })
    logEvent('monitor.spawn_failed', {
      session: sessionId,
      account: account.id,
      error: error.message
    })
  })
  child.unref()
  return child
}

/**
 * Watch for a session that is alive but getting nowhere: freebuff rewrites
 * files inside its own config dir while it works, so silence there for long
 * enough means the agent is stuck rather than busy.
 */
function startStallWatch ({ configDir, cwd, stallMs, onStall }) {
  if (!stallMs || !configDir) return { stop () {} }

  const startedAt = Date.now()
  const interval = Math.max(5000, Math.min(30000, Math.floor(stallMs / 4)))
  let reported = false

  const timer = setInterval(() => {
    if (reported) return
    const newest = Math.max(startedAt, activityStamp(configDir, cwd))
    const quiet = Date.now() - newest
    if (quiet < stallMs) return
    reported = true
    onStall(quiet)
  }, interval)
  if (timer.unref) timer.unref()

  return { stop () { clearInterval(timer) } }
}

/**
 * The task an automatically started session should continue.
 *
 * It comes from the account that ran the previous attempt: after an auth
 * failure that account is retired and the next one starts with none of the
 * conversation, so the typed prompt has to carry the work itself. Without a
 * readable history the configured fallback prompt is used unchanged.
 */
function resumeText (context, account, state, nudges, chatDir = null, options = {}) {
  // The person set their own prompt, so it is used exactly as given.
  if (nudges.custom) return nudges.text
  // The conversation is resumed as it is: the task, the work done so far and
  // the point it stopped at are all in that chat already.
  if (options.preserved) return RESUME_PROMPT

  const previous = context.previousAccountId && context.previousAccountId !== account.id
    ? state.accounts.find((item) => item.id === context.previousAccountId)
    : null
  const source = previous ? accounts.accountConfigDir(previous) : accounts.accountConfigDir(account)
  // The resumed conversation's own newest user message is what the person
  // typed last; the account-wide history can lag behind it by several turns
  // when the session was restarted mid-conversation.
  const recovered = task.lastTask(source, {
    ignore: [nudges.text, nudges.nudgeText],
    chatDir
  })
  return task.continuePrompt(nudges.text, recovered)
}

/**
 * One freebuff session: pick an account, record it, start the monitor, run
 * freebuff and report how it ended. The 24/7 loop calls this repeatedly.
 */
async function runSession (context) {
  const {
    binary,
    requested,
    cwd,
    args,
    monitor,
    flags,
    stallMs,
    configDirFor,
    previousAccountId,
    fresh = false
  } = context

  const state = loadState()
  let account
  try {
    account = accounts.chooseAccount(state, {
      requested,
      cwd,
      preferCwd: hasContinue(args)
    })
  } catch (error) {
    // Nothing can run, so say the same thing on the terminal that goes to the
    // webhook: this is the case where a person has to act.
    console.error(`sfreebuff: ${error.message}`)
    return {
      code: 1,
      signal: null,
      sessionId: null,
      accountId: null,
      elapsedMs: 0,
      fatal: 'no account can run a session',
      fatalDetail: error.message,
      // Signing in is a person's job: retrying cannot create credentials.
      retryable: false,
      fatalAction: 'sign an account in with `sfreebuff login --new`, then start again'
    }
  }

  if (!account) {
    return {
      code: 1,
      signal: null,
      fatal: 'no signed-in account',
      fatalDetail: 'every account container is missing credentials',
      retryable: false,
      fatalAction: 'run `sfreebuff login --new`'
    }
  }

  const expiry = accounts.isExpiring(account)
  if (expiry.expiring) {
    logLine('warn', expiry.expired ? 'account credentials expired' : 'account credentials expiring', {
      account: account.id,
      expiresAt: new Date(expiry.expiresAt).toISOString()
    })
    logEvent('account.expiring', {
      account: account.id,
      expiresAt: expiry.expiresAt,
      expired: expiry.expired
    })
  }

  const sessionId = newSessionId()
  const startedAtMs = Date.now()

  // A switch to another account is always an unfinished task, and the new
  // account has none of the conversation: hand the chat itself over and resume
  // it by id. That alone is not enough (freebuff shows a resumed chat and waits
  // for a message), and `--no-pty` still has to be told to continue, so a
  // switched session is put on a pty just long enough to type the prompt. The
  // session after a crash or a stall on the same account keeps the mode it was
  // started with.
  const switched = Boolean(
    context.restarting && previousAccountId && previousAccountId !== account.id
  )
  let sessionArgs = withFolder(args, cwd)
  let carried = null
  if (switched) {
    const previous = state.accounts.find((item) => item.id === previousAccountId)
    if (previous) {
      carried = handoff.copyConversation({
        fromConfigDir: accounts.accountConfigDir(previous),
        toConfigDir: accounts.accountConfigDir(account),
        cwd
      })
      if (carried) sessionArgs = handoff.continueWithChat(sessionArgs, carried.id)
    }
  }

  // A plain `sfreebuff` in a folder that already has a conversation continues
  // that conversation. freebuff starts a brand new chat otherwise, which leaves
  // the work that was last asked for sitting in the old one.
  const explicitContinue = hasContinue(args)
  // A session asked for as new gets a conversation of its own. Resuming this
  // folder's last chat is what made a brand new session carry on the previous
  // task: its first act was typing the continue prompt into the old chat.
  const freshStart = Boolean(fresh && !context.restarting)
  let resumedChat = null
  // The conversation this attempt really opens on, when there is one. With it
  // the session continues from the exact point it stopped at; without one the
  // task has to be carried in the typed prompt instead.
  let resumableChat = null
  if (!switched && !explicitContinue && !freshStart) {
    resumedChat = handoff.latestChat(accounts.accountConfigDir(account), cwd)
    if (resumedChat) {
      sessionArgs = handoff.continueWithChat(sessionArgs, resumedChat.id)
      resumableChat = resumedChat
    }
  } else if (!switched && explicitContinue) {
    // `--continue` resumes the folder's own conversation, so the same chat (and
    // the same point in the work) is already there.
    resumableChat = handoff.latestChat(accounts.accountConfigDir(account), cwd)
  }

  // A restart only resumes a conversation this account really has for this
  // folder. freebuff answers a `--continue` it cannot resolve in the folder it
  // was given with its project picker — the folder list — and an unattended
  // session can never leave that screen. A folder with no conversation starts a
  // fresh chat there instead, and the typed prompt below carries the task in.
  if (context.restarting && !carried && hasContinue(sessionArgs)) {
    const conversation = handoff.latestChat(accounts.accountConfigDir(account), cwd)
    if (conversation) {
      resumableChat = conversation
    } else {
      sessionArgs = withoutContinueArgs(sessionArgs)
      logLine('info', 'nothing to resume in this folder — starting a new chat', {
        session: sessionId,
        account: account.id,
        cwd
      })
      logEvent('session.fresh_chat', {
        session: sessionId,
        account: account.id,
        cwd,
        reason: 'nothing to resume in this folder'
      })
    }
  }

  const canType = ptyAvailable()
  const typingPty = !flags.pty && switched && canType
  const usePty = flags.pty || typingPty
  if (typingPty) {
    logLine('info', 'session.continue_pty', {
      session: sessionId,
      account: account.id,
      reason: 'typing the continue prompt into the switched session'
    })
    logEvent('session.continue_pty', {
      session: sessionId,
      account: account.id,
      chatId: carried ? carried.id : null
    })
  } else if (!flags.pty && (switched || resumedChat) && !canType) {
    // The conversation is resumed, but with no pty nothing can be typed at it,
    // so the task waits for the person instead of carrying on by itself.
    logLine('warn', 'session.continue_unavailable', {
      session: sessionId,
      account: account.id,
      fix: 'npm install node-pty'
    })
    logEvent('session.continue_unavailable', {
      session: sessionId,
      account: account.id,
      chatId: carried ? carried.id : (resumedChat ? resumedChat.id : null)
    })
  }

  const session = {
    id: sessionId,
    accountId: account.id,
    pid: null,
    launcherPid: process.pid,
    cwd,
    args: sessionArgs,
    startedAt: nowIso(),
    endedAt: null,
    exitCode: null,
    exitSignal: null,
    note: null
  }

  mutateState((current) => {
    accounts.recordSession(current, session)
    accounts.markAccountUsed(current, account.id, cwd)
  })

  const nudges = nudgeConfig()
  // The real task when it can be recovered from freebuff's own history, so a
  // pushed session is told what to carry on with instead of just "continue".
  const continueText = resumeText(
    context,
    account,
    state,
    nudges,
    carried ? carried.from : (resumedChat ? resumedChat.dir : null),
    // A resumed conversation already holds the task and its progress; only a
    // session without one is told what the work was.
    { preserved: Boolean(resumableChat) && !carried && !switched }
  )
  // A session that continues an earlier one (a restart, an explicit
  // --continue, or a conversation resumed on launch) opens waiting for a
  // message, so the prompt is typed as soon as the TUI has settled.
  const continuing = Boolean(context.restarting || explicitContinue || resumedChat)
  // Only a pty session can be typed at, so only then is there a prompt to send.
  const resume = continuing && usePty
    ? { text: continueText, delayMs: nudges.resumeMs }
    : null

  if (carried) {
    logLine('info', 'session.handoff', {
      session: sessionId,
      from: previousAccountId,
      account: account.id,
      chat: carried.id
    })
    logEvent('session.handoff', {
      session: sessionId,
      fromAccount: previousAccountId,
      toAccount: account.id,
      chatId: carried.id
    })
  }

  logLine('info', 'session.start', {
    session: sessionId,
    account: account.id,
    cwd,
    binary,
    attempt: context.attempt,
    pty: usePty,
    resume: Boolean(resume),
    resumedChat: resumedChat ? resumedChat.id : null,
    previousAccount: previousAccountId || null
  })
  logEvent('session.start', {
    session: sessionId,
    account: account.id,
    cwd,
    args: sessionArgs,
    attempt: context.attempt,
    pty: usePty,
    resume: Boolean(resume),
    resumedChat: resumedChat ? resumedChat.id : null,
    previousAccount: previousAccountId || null,
    handoff: carried ? carried.id : null
  })

  if (accounts.authFailureActive(account)) {
    logLine('warn', 'launching an account with a recorded auth failure', {
      account: account.id
    })
  }

  const wasSignedIn = accounts.isSignedIn(account)
  // The last bytes freebuff wrote outside a pty, for the diagnosis report.
  let stderrTail = ''
  let authFailure = null
  const recordAuthFailure = (snippet) => {
    if (authFailure) return
    authFailure = snippet
    mutateState((current) => {
      accounts.markAuthFailure(current, account.id, snippet)
      const record = current.sessions.find((item) => item.id === sessionId)
      if (record) record.authFailure = snippet
    })
    logLine('warn', 'account auth failure detected', {
      session: sessionId,
      account: account.id,
      detail: snippet
    })
    logEvent('account.auth_failure', {
      session: sessionId,
      account: account.id,
      detail: snippet
    })
    void notify.report(
      notify.authFailure({ accountId: account.id, sessionId, detail: snippet }),
      { kind: 'account.auth_failure', session: sessionId, account: account.id }
    )
  }
  // A pty merges freebuff's own errors with everything the agent prints, so
  // only unmistakable auth errors may be trusted there.
  const watchStderr = createAuthWatcher(recordAuthFailure, { merged: usePty })

  // A pty session's process handle only arrives after runOnPty has spawned it;
  // the non-pty branch spawns freebuff directly. Either way the stall watch and
  // the side monitor need the same pid and kill.
  let child = null
  let ptyHandle = null

  const signalChild = (signal) => {
    const target = child || ptyHandle
    if (!target) return
    // A non-positive pid means a process group (and -1 every process of this
    // user), never a session: a delayed kill must not go there.
    if (!Number.isInteger(target.pid) || target.pid <= 1) return
    try {
      target.kill(signal)
    } catch {
      // Already gone.
    }
  }

  let stalled = false
  let stallQuietMs = 0
  let stuckPrompt = false
  // The last "this session cannot run" state freebuff showed (see limits.js).
  let sessionLimit = null
  // The same, for the states that only ask for the message again: a free
  // session that ended, a turn that hit its usage limit, a busy service. Those
  // are not a TUI refusing typed text, which is what a free session ending used
  // to be reported as.
  let lastLimit = null
  let lastLimitAt = 0
  const onStall = (quietMs) => {
    stalled = true
    stallQuietMs = quietMs
    logLine('warn', 'session stalled — restarting it', {
      session: sessionId,
      account: account.id,
      quiet: formatDuration(quietMs)
    })
    logEvent('session.stall', {
      session: sessionId,
      account: account.id,
      quietMs
    })
    signalChild('SIGTERM')
    setTimeout(() => signalChild('SIGKILL'), 10000).unref?.()
  }

  const noteLimit = (verdict) => {
    if (!verdict || verdict.kind === 'none') return
    lastLimit = verdict
    lastLimitAt = Date.now()
    // Only a used-up account ends the session here. The other states ask for
    // the message again, which the session itself can still do.
    if (verdict.kind !== 'session-limit') return
    sessionLimit = verdict

    logLine('warn', 'free sessions used up — retiring the session', {
      session: sessionId,
      account: account.id,
      detail: verdict.message
    })
    logEvent('session.limit_reached', {
      session: sessionId,
      account: account.id,
      detail: verdict.message
    })
    void notify.report(
      notify.sessionLimited({
        accountId: account.id,
        sessionId,
        cwd,
        detail: verdict.message
      }),
      { kind: 'session.limit_reached', session: sessionId, account: account.id }
    )
    // Nothing typed at this session can run until the quota resets, so it is
    // retired instead of sitting on a dead screen. The 24/7 loop then switches
    // account, or waits for the reset and continues the task after it.
    setTimeout(() => signalChild('SIGTERM'), 1500).unref?.()
    setTimeout(() => signalChild('SIGKILL'), 12000).unref?.()
  }

  const noteSpawn = (handle) => {
    if (!handle || !handle.pid) return
    mutateState((current) => {
      const record = current.sessions.find((item) => item.id === sessionId)
      if (record) record.pid = handle.pid
    })
    logEvent('session.spawn', { session: sessionId, pid: handle.pid, account: account.id })
    if (monitor) {
      spawnMonitor({ sessionId, account, pid: handle.pid, cwd })
    }
  }

  // Started, not awaited: the stall watch and monitor must be running while
  // the pty session is alive.
  let ptyRun = null

  void notify.report(
    notify.sessionStarted({ accountId: account.id, sessionId, cwd, binary }),
    { kind: 'session.start', session: sessionId, account: account.id }
  )

  const env = environmentFor(account)
  const configDir = configDirFor ? configDirFor(account.id) : accounts.accountConfigDir(account)

  try {
    if (usePty) {
      ptyRun = runOnPty({
        binary,
        args: sessionArgs,
        cwd,
        env,
        // The live state and the phone are keyed by this, so the screen of a
        // running session can be read from anywhere on the machine.
        sessionId,
        nudge: { text: nudges.nudgeText, idleMs: nudges.idleMs, max: nudges.max },
        // Work asked for on the phone: typed into this session as soon as it
        // is idle, so "korjaa se bugi" becomes an actual turn.
        takeTask: () => require('./voice').takeTask(sessionId),
        // The watchdog reads freebuff's own records to tell work from idling,
        // and verifies that a typed prompt was actually sent. The scan is
        // reused for a couple of seconds: it stats every chat file, and the
        // verification window is measured in seconds anyway.
        progress: () => activityStamp(configDir, cwd, { maxAgeMs: 2000 }),
        onStuck: (text) => {
          // A message that could not be sent because freebuff ended the session
          // — or hit the turn's usage limit — is a limit, not a broken TUI:
          // retiring it as "stuck" reported a prompt fault that does not exist
          // ("prompt could not be sent") and counted towards the
          // stop-for-a-person threshold, so a free session running out ended in
          // a CRITICAL report about a broken input box.
          const limitState = sessionLimit ||
            (lastLimit && lastLimit.retype && Date.now() - lastLimitAt < LIMIT_FRESH_MS
              ? lastLimit
              : null)
          if (limitState) {
            logLine('warn', 'session retired after freebuff ended it', {
              session: sessionId,
              account: account.id,
              state: limitState.kind
            })
            setTimeout(() => signalChild('SIGTERM'), 500).unref?.()
            setTimeout(() => signalChild('SIGKILL'), 10000).unref?.()
            return
          }
          stuckPrompt = true
          // The TUI has been idle with the message in its input box and Enter
          // is not submitting it. Nothing typed at that session recovers it,
          // so it is retired: the 24/7 loop relaunches the same conversation
          // and types the task into a clean box. Doing nothing left the
          // session sitting there for hours, looking alive.
          logLine('warn', 'prompt never left the input box — restarting the session', {
            session: sessionId,
            account: account.id
          })
          logEvent('session.prompt_stuck', {
            session: sessionId,
            account: account.id,
            prompt: String(text).slice(0, 300)
          })
          void notify.report(
            notify.promptUnsent({
              accountId: account.id,
              sessionId,
              cwd,
              prompt: text
            }),
            { kind: 'session.prompt_unsent', session: sessionId, account: account.id }
          )
          setTimeout(() => signalChild('SIGTERM'), 500).unref?.()
          setTimeout(() => signalChild('SIGKILL'), 10000).unref?.()
        },
        // A restart is always an unfinished task: a crash, a stall, or a
        // session that moved to another account. Ask the new session to pick
        // the work back up instead of waiting at an empty prompt.
        resume,
        // The free session ended, the account is out of sessions, or free
        // mode is at capacity. Reported while the session is still alive so a
        // used-up account is retired at once instead of after three attempts.
        onLimit: noteLimit,
        // A yes/no spoken on the phone is queued for this session and typed
        // in only while a dialog is waiting on screen.
        takeAnswer: () => voice.takeAnswer(sessionId),
        // On a pty the CLI's errors arrive in the same stream as the TUI, so
        // this is what still recognises an auth failure and rotates accounts.
        onOutput: watchStderr,
        onSpawn: (handle) => {
          ptyHandle = handle
          noteSpawn(handle)
        },
        onEscalate: (prompt, verdict) => {
          logEvent('dialog.needs_input', {
            session: sessionId,
            account: account.id,
            rule: verdict.name
          })
          void notify.report(
            notify.needsInput({
              prompt,
              sessionId,
              accountId: account.id,
              cwd
            }),
            {
              kind: 'dialog.needs_input',
              session: sessionId,
              account: account.id,
              // Posted without a ping. The session is alive and carries on as
              // soon as the question is answered, so only the report for a
              // supervisor that actually stopped pings the channel.
              mention: false
            }
          )
          // With voice calls on, ring the phone and say the question out loud
          // instead of waiting for a Discord message to be read.
          void voice.ring({
            kind: 'help',
            question: prompt || `freebuff is waiting on ${verdict.name}`,
            action: 'Say approve or deny on the phone, or answer it in the freebuff window.',
            sessionId,
            accountId: account.id,
            cwd
          })
        }
      })
    } else {
      child = spawnFreebuff({
        binary,
        account,
        args: sessionArgs,
        // The session's folder, not whatever directory this process inherited:
        // a `--cwd` session must not run freebuff somewhere else.
        cwd,
        onStderr: (chunk) => {
          stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000)
          watchStderr(chunk)
        }
      })
      noteSpawn(child)
    }
  } catch (error) {
    mutateState((current) =>
      accounts.finalizeSession(current, sessionId, { note: `spawn failed: ${error.message}` })
    )
    logLine('error', 'session.spawn_failed', { session: sessionId, error: error.message })
    return {
      code: 1,
      signal: null,
      sessionId,
      accountId: account.id,
      elapsedMs: Date.now() - startedAtMs,
      fatal: 'freebuff could not be started',
      fatalDetail: error.message,
      // A refused spawn is often the binary being replaced, a pty hiccup, or a
      // transient resource limit, so the loop gives it another go first.
      retryable: true,
      fatalAction: 'run `sfreebuff doctor`'
    }
  }

  const stallWatch = startStallWatch({
    configDir,
    cwd,
    stallMs,
    onStall
  })

  let result
  try {
    if (ptyRun) {
      result = await ptyRun
    } else {
      result = await waitForExit(child)
    }
  } catch (error) {
    stallWatch.stop()
    mutateState((current) =>
      accounts.finalizeSession(current, sessionId, { note: `launcher error: ${error.message}` })
    )
    logLine('error', 'session.error', { session: sessionId, error: error.message })
    resetTerminal()
    return {
      code: 1,
      signal: null,
      sessionId,
      accountId: account.id,
      elapsedMs: Date.now() - startedAtMs,
      fatal: 'the freebuff session could not be supervised',
      fatalDetail: error.message,
      // A pty that broke mid-session is usually the terminal, not freebuff.
      retryable: true,
      fatalAction: 'run `sfreebuff doctor`'
    }
  } finally {
    stallWatch.stop()
  }

  const finished = mutateState((current) =>
    accounts.finalizeSession(current, sessionId, {
      exitCode: result.code,
      signal: result.signal
    })
  )

  // Why the session stopped making progress, when freebuff said so. A pty
  // reports it live; the final screen covers one that ended before the watchdog
  // saw it; a zero balance covers a CLI that simply exited.
  let limited = sessionLimit && sessionLimit.kind !== 'none' ? sessionLimit : null
  if (!limited && result.limit && result.limit.kind !== 'none') {
    // A transient state (session ended, turn limit, busy) is cleared by ptyrun
    // once the screen moves on, so the verdict at exit is the one that counts.
    limited = result.limit
  }
  if (!limited) {
    const fromScreen = limits.detect(result.tail)
    // A pty that saw the line and deliberately ignored it — an agent writing
    // about session limits — must not have it acted on from the screen text
    // afterwards.
    const ignored = result.limitIgnored
    if (fromScreen.kind !== 'none' && !(ignored && fromScreen.message === ignored)) {
      limited = fromScreen
    }
  }
  if (!limited && result.code === 0 && !result.signal && flags.forever && !usePty) {
    // Without a pty there is no screen to read. An empty balance still says a
    // clean exit is the free session ending, not the work being finished.
    const balance = await credits.get(account, { timeoutMs: 3000 })
    if (balance.ok && balance.remaining <= 0) {
      limited = {
        kind: 'session-limit',
        name: 'credits-zero',
        message: `the account has ${balance.remaining} credits left`,
        ends: true,
        wait: true,
        retype: false,
        delayMs: 0
      }
    }
  }

  const stillSignedIn = accounts.isSignedIn(account)
  if (wasSignedIn && !stillSignedIn) {
    recordAuthFailure('freebuff removed its credentials during the session')
  } else if (!authFailure && stillSignedIn && result.code === 0 && !result.signal && !limited) {
    // A clean session proves the credentials work (and that the account has
    // sessions left) again.
    mutateState((current) => {
      accounts.clearAuthFailure(current, account.id)
      accounts.clearCooldown(current, account.id)
    })
  }

  const elapsed = finished && finished.startedAt
    ? Math.max(0, Date.parse(finished.endedAt) - Date.parse(finished.startedAt))
    : Date.now() - startedAtMs

  // Automatic error debugging: a bad end always leaves an explanation behind,
  // so the next attempt (or a person reading `sfreebuff logs`) does not have to
  // guess why. A clean exit needs no report.
  // A stuck prompt alone is reported when it happens (see onStuck) and no
  // longer ends the session, so only a bad end earns a diagnosis file.
  let diagnosis = null
  if (stalled || result.signal || result.code !== 0) {
    diagnosis = diagnose.record(sessionId, {
      accountId: account.id,
      account,
      cwd,
      code: result.code,
      signal: result.signal,
      stalled,
      stuck: stuckPrompt,
      limit: limited,
      quietMs: stallQuietMs,
      elapsedMs: elapsed,
      tail: ptyRun ? result.tail : stderrTail
    })
  }

  const level = result.code === 0 && !result.signal ? 'info' : 'warn'
  logLine(level, 'session.end', {
    session: sessionId,
    account: account.id,
    code: result.code,
    signal: result.signal,
    stalled,
    limited: limited ? limited.kind : null,
    cause: diagnosis ? diagnosis.cause : null,
    duration: formatDuration(elapsed)
  })
  logEvent('session.end', {
    session: sessionId,
    account: account.id,
    code: result.code,
    signal: result.signal,
    stalled,
    answered: ptyRun ? result.answered : null,
    escalated: ptyRun ? result.escalated : null,
    nudges: ptyRun ? result.nudges : null,
    resumed: ptyRun ? result.resumed : null,
    enterRetries: ptyRun ? result.enterRetries : null,
    resends: ptyRun ? result.resends : null,
    stuck: ptyRun ? result.stuck : null,
    remoteAnswers: ptyRun ? result.remoteAnswers : null,
    busyAtExit: ptyRun ? Boolean(result.busyAtExit) : null,
    dialogAtExit: ptyRun ? Boolean(result.dialogAtExit) : null,
    limit: limited ? limited.kind : null,
    cause: diagnosis ? diagnosis.cause : null,
    diagnosis: diagnosis ? diagnosis.file : null,
    durationMs: elapsed
  })
  void notify.report(
    notify.sessionEnded({
      accountId: account.id,
      sessionId,
      cwd,
      code: result.code,
      signal: result.signal,
      durationMs: elapsed,
      cause: diagnosis ? diagnosis.cause : null,
      report: diagnosis ? diagnosis.file : null,
      limited: limited ? limited.kind : null,
      restarting: flags.forever && (Boolean(limited) || (!stalled && (result.code !== 0 || Boolean(result.signal))))
    }),
    { kind: 'session.end', session: sessionId, account: account.id }
  )

  resetTerminal()

  return {
    code: result.code === null || result.code === undefined
      ? (result.signal ? 130 : 0)
      : result.code,
    signal: result.signal,
    sessionId,
    accountId: account.id,
    elapsedMs: elapsed,
    stalled,
    stuck: stuckPrompt,
    // The 24/7 loop retries a limit instead of treating it as a finished task.
    limited,
    // The screen at the moment the TUI went away: a running turn or an open
    // question means the task was cut off, not finished.
    busyAtExit: Boolean(result.busyAtExit),
    dialogAtExit: Boolean(result.dialogAtExit),
    retryable: Boolean(result.retryable)
  }
}

/**
 * `sfreebuff [freebuff args...]`
 *
 * Unlocks sudo for the run if asked, reports that the supervisor is up, then
 * keeps a session alive until something needs a person (see supervise.js) and
 * reports that it stopped.
 */
async function launch (argv) {
  ensureDirs()

  const flags = parseLaunchFlags(argv)
  let cwd = cwdFromArgs(flags.passthrough) || process.cwd()

  mutateState((state) => accounts.ensureDefaultAccount(state))

  let state = loadState()
  // Which account runs is decided per session, so a retired account rotates to
  // the next one on a restart. Only a machine with nothing signed in at all
  // needs setup first, and a forced account is left to fail with its own
  // message rather than being sent through setup.
  if (!state.accounts.some(accounts.isSignedIn) && !flags.requested) {
    console.log('sfreebuff: first run — no account signed in yet.')
    const { setup } = require('./setup')
    await setup({})
    state = loadState()
    if (!state.accounts.some(accounts.isSignedIn)) {
      throw new Error('still no signed-in account after setup')
    }
  }

  // A launch that continues a project (a reboot service, or `--continue` run
  // from the home folder) must not land on freebuff's project picker, which no
  // unattended session can leave, so the last real project is used instead.
  // A new session is left where it was started: the picker is where the person
  // chooses the folder themselves, and it must not be decided for them.
  const continuing = hasContinue(flags.passthrough)
  const recoveredCwd = continuing ? accounts.resolveProjectFolder(cwd, state) : cwd
  if (recoveredCwd !== cwd) {
    logLine('info', 'session folder recovered', {
      from: shortHome(cwd),
      to: shortHome(recoveredCwd)
    })
    logEvent('supervisor.cwd_recovered', {
      from: cwd,
      to: recoveredCwd,
      reason: 'continuing a project from the home folder, which opens the project picker'
    })
    cwd = recoveredCwd
  }

  const binary = resolveBinary()

  const supportsPty = ptyAvailable()
  const usePty = flags.pty === null ? supportsPty : flags.pty
  if (usePty && !supportsPty) {
    throw new Error(
      '--pty needs the optional node-pty dependency: run `npm install node-pty`'
    )
  }
  if (flags.pty === null && !supportsPty) {
    logLine('info', 'pty unavailable — sessions cannot be nudged', {
      install: 'npm install node-pty'
    })
  }
  const sessionFlags = { ...flags, pty: usePty }

  const vault = await sudo.start({ enabled: flags.sudo })
  if (vault.active) {
    process.env.SUDO_ASKPASS = vault.env.SUDO_ASKPASS
    process.env.FREEBUFFS_SUDO_SHIM = vault.env.FREEBUFFS_SUDO_SHIM
  }

  let cleaned = false
  const cleanupVault = () => {
    if (cleaned) return
    cleaned = true
    delete process.env.SUDO_ASKPASS
    delete process.env.FREEBUFFS_SUDO_SHIM
    sudo.clear()
  }
  process.once('exit', cleanupVault)
  process.once('SIGINT', cleanupVault)
  process.once('SIGTERM', cleanupVault)

  const signedIn = state.accounts.filter(accounts.isSignedIn).length
  const startedAtMs = Date.now()
  logLine('info', 'supervisor.start', {
    cwd,
    accounts: state.accounts.length,
    signedIn,
    forever: flags.forever,
    pty: usePty,
    sudo: vault.active ? 'unlocked' : vault.reason
  })
  logEvent('supervisor.start', {
    cwd,
    accounts: state.accounts.length,
    signedIn,
    forever: flags.forever,
    pty: usePty,
    sudo: vault.active,
    sudoReason: vault.reason
  })

  if (vault.active) {
    console.log('sfreebuff: sudo unlocked for this run — the password file is deleted when the supervisor closes.')
  }

  // The phone line is part of the supervisor, so it comes up with it instead
  // of waiting for somebody to run `voice serve` by hand — and stays up. A
  // line that died left the call link pointing at a dead port, which is what
  // "the call page does not load" usually was.
  let voiceWatch = null
  const watchVoice = () => {
    try {
      if (!voice.settings().enabled) return
      void voice.ensureServer()
    } catch {
      // A dead line must never take the supervisor down.
    }
  }
  if (voice.settings().enabled) {
    watchVoice()
    voiceWatch = setInterval(watchVoice, 30 * 1000)
    if (voiceWatch.unref) voiceWatch.unref()
  }

  void notify.report(
    notify.supervisorStarted({
      cwd,
      accounts: state.accounts.length,
      signedIn,
      mode: flags.forever ? '24/7' : 'once',
      sudo: vault.active ? 'unlocked' : (vault.reason || 'off'),
      pty: usePty
    }),
    { kind: 'supervisor.start' }
  )

  const outcome = await supervise({
    args: flags.passthrough,
    cwd,
    forever: flags.forever,
    env: process.env,
    // The first session of this supervisor starts a new conversation when the
    // dashboard asked for one; every restart resumes it.
    fresh: flags.fresh,
    // A forced account cannot rotate away from its own limit.
    requested: flags.requested,
    configDirFor: (accountId) => {
      const current = loadState()
      const found = current.accounts.find((item) => item.id === accountId)
      return found ? accounts.accountConfigDir(found) : null
    },
    run: (info) => runSession({
      ...info,
      binary,
      requested: flags.requested,
      // The supervisor may recover a different folder between attempts (a
      // restart that would otherwise open the project picker), so its value
      // wins over the one this launch started with.
      cwd: info.cwd || cwd,
      monitor: flags.monitor,
      flags: sessionFlags
    })
  })

  logLine('info', 'supervisor.stop', {
    cwd,
    stopped: outcome.stopped,
    attempts: outcome.attempts,
    uptime: formatDuration(Date.now() - startedAtMs)
  })
  logEvent('supervisor.stop', {
    cwd,
    stopped: outcome.stopped,
    attempts: outcome.attempts,
    uptimeMs: Date.now() - startedAtMs
  })

  void notify.report(
    notify.supervisorStopped({
      cwd,
      reason: outcome.stopped,
      attempts: outcome.attempts,
      uptimeMs: Date.now() - startedAtMs,
      code: outcome.code
    }),
    { kind: 'supervisor.stop' }
  )

  if (voiceWatch) clearInterval(voiceWatch)
  cleanupVault()
  console.log(`sfreebuff: supervisor stopped (${outcome.stopped}) — ${shortHome(cwd)}`)
  return outcome.code
}

module.exports = {
  launch,
  runSession,
  nudgeConfig,
  parseLaunchFlags,
  cwdFromArgs,
  withFolder,
  withoutContinueArgs,
  hasContinue,
  monitorLaunch,
  monitorWindowEnabled,
  spawnMonitor,
  startStallWatch,
  newSessionId
}
