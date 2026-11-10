'use strict'

/**
 * The 24/7 loop that keeps a freebuff session alive.
 *
 * A single freebuff TUI exits for all sorts of reasons that are not the end of
 * the work: a crashed agent, a dropped connection, an expired token that the
 * next account has anyway, a terminal app that gave up. The supervisor treats
 * those as interruptions. It relaunches freebuff with `--continue` so the same
 * conversation carries on, backing off between attempts.
 *
 * It stops only when a person must step in, and when it stops for that reason
 * it says so on the Discord webhook as a CRITICAL report:
 *
 *   - freebuff exited cleanly (exit code 0) and the work is done: that is the
 *     normal "I'm done" quit. An exit 0 while a turn was still running or a
 *     question was open is not that: the conversation ended mid-work, so the
 *     same conversation is resumed (`FREEBUFFS_MAX_CLEAN_RESUMES`, 3 in a row)
 *     before it is reported as a TUI that keeps quitting
 *   - the user interrupted it (Ctrl-C), which reaches freebuff as SIGINT
 *   - a stop was requested with `sfreebuff stop`
 *   - it failed over and over immediately after starting, which means the
 *     problem is not something a retry can fix
 *   - there is no account that can run a session at all
 *
 * A session that is alive but idle is a different failure: nothing crashed, the
 * agent is simply waiting. `stallMs` of no activity in the account's own config
 * dir means freebuff is stuck, so the loop restarts it with a nudge prompt.
 *
 * A free session ending is neither a crash nor a finished task, which is why it
 * is handled before the clean-exit rule. `result.limited` (see limits.js) says
 * what freebuff showed:
 *
 *   - session-limit: this account has no free sessions left. Another signed-in
 *     account takes over at once; with none, the loop waits for the quota reset
 *     (the usage API's next-quota time when it can be read) and continues.
 *   - session-ended / turn-limit / capacity: freebuff asked for the message
 *     again on a new session or turn, so it is retried without being counted
 *     as a failed start.
 */

const fs = require('fs')
const path = require('path')
const { paths } = require('./paths')
const { logLine, logEvent } = require('./log')
const { shortHome, formatDuration, safeUnlink } = require('./util')
const notify = require('./notify')
const voice = require('./voice')
const accounts = require('./accounts')
const credits = require('./credits')
const { loadState, mutateState } = require('./state')

const BASE_BACKOFF_MS = 5000
const MAX_BACKOFF_MS = 5 * 60 * 1000
const DEFAULT_MAX_FAST_FAILURES = 3
const FAST_FAILURE_MS = 45 * 1000
const DEFAULT_STALL_MS = 20 * 60 * 1000
/**
 * How many sessions in a row may be retired because freebuff would not take a
 * typed prompt before the loop stops for a person. Restarting recovers a TUI
 * whose input box stopped working; a TUI that refuses every time is a real
 * problem, and a restart every few minutes is not a fix.
 */
const DEFAULT_MAX_STUCK_RESTARTS = 3
/** Consecutive "session ended, continue" states before stopping for a person. */
const DEFAULT_MAX_LIMIT_RESTARTS = 10
/**
 * How many clean exits in a row may happen while a turn was still running
 * before the loop decides the TUI itself keeps quitting. freebuff does exit 0
 * on its own mid-task (a quit key, a TUI bug, an ended conversation), and
 * treating that as "work finished" closed the task while the job was half done.
 */
const DEFAULT_MAX_CLEAN_RESUMES = 3
/**
 * How many times a transient start/supervision failure is retried before the
 * loop stops for a person. A binary being replaced, a pty hiccup or a resource
 * limit clears up; a broken install does not, and is still reported.
 */
const DEFAULT_MAX_FATAL_RETRIES = 2
/**
 * How many times, after repeated fast failures, the loop abandons the saved
 * conversation and starts a fresh one with the task typed in. A corrupt chat
 * state makes freebuff exit immediately every time, and only a new
 * conversation recovers it.
 */
const DEFAULT_MAX_FRESH_RESTARTS = 1
/**
 * How long a pty session may be quiet before the "keep working" nudge is
 * typed at it. Only an idle session is nudged (no running turn, empty input
 * box), so a session that is already working is never interrupted.
 */
const DEFAULT_NUDGE_MS = 7 * 60 * 1000
/**
 * How long to keep an account out of rotation after its free sessions run out
 * when the reset time cannot be read, and the longest wait the loop will sit
 * through in one go. Waiting is the correct behaviour here: the account really
 * cannot run anything until the quota resets.
 */
const DEFAULT_LIMIT_WAIT_MS = 30 * 60 * 1000
const MAX_LIMIT_WAIT_MS = 12 * 60 * 60 * 1000
const MIN_LIMIT_WAIT_MS = 60 * 1000
/** Sleep in slices so `sfreebuff stop` is noticed during a long wait. */
const LIMIT_WAIT_SLICE_MS = 1000
/** Files freebuff rewrites while it works, used to tell "idle" from "working". */
const ACTIVITY_FILES = ['message-history.json', 'recent-projects.json']
/** The files a running chat appends to while the agent works. */
const CHAT_FILES = ['log.jsonl', 'chat-messages.json', 'run-state.json', 'chat-meta.json']

function numberFromEnv (env, name, fallback) {
  const value = Number((env && env[name]) || NaN)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * `sfreebuff stop` writes the global file; the dashboard writes one named for
 * a single launcher so several supervisors can be controlled independently.
 */
function stopFilePath (launcherPid) {
  return launcherPid
    ? path.join(paths().home, `stop-${launcherPid}`)
    : path.join(paths().home, 'stop')
}

/** Ask a supervisor to stop after its current session (all when no pid). */
function requestStop (launcherPid) {
  fs.mkdirSync(paths().home, { recursive: true })
  const file = stopFilePath(launcherPid)
  fs.writeFileSync(file, `${new Date().toISOString()}\n`)
  return file
}

function stopRequested (launcherPid) {
  if (fs.existsSync(stopFilePath())) return true
  return Boolean(launcherPid && fs.existsSync(stopFilePath(launcherPid)))
}

function clearStopRequest (launcherPid) {
  safeUnlink(stopFilePath())
  if (launcherPid) safeUnlink(stopFilePath(launcherPid))
}

function readEntries (dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** How long a resolved project directory name is trusted before looking again. */
const PROJECT_LOOKUP_MS = 30 * 1000
/**
 * How long one activity scan is reused. A session probes it every second, and
 * the scan stats every file of the project's chats: 200 chats measured at
 * ~14ms, i.e. a whole percent of a core per session, for a timestamp the
 * prompt verification window (6s) does not need to the second.
 */
const ACTIVITY_CACHE_MS_DEFAULT = 2000
/** config dir + cwd -> the last scan, for callers that probe every second. */
const activityStamps = new Map()
/** config dir + cwd -> the `projects/<name>` directory freebuff keeps chats in. */
const projectNames = new Map()

/** Does any chat of this project record the folder it ran in? */
function chatsNameCwd (projectDir, cwd) {
  if (!cwd) return false
  const chatsDir = path.join(projectDir, 'chats')
  for (const chat of readEntries(chatsDir)) {
    for (const name of CHAT_FILES) {
      if (name === 'log.jsonl') continue
      try {
        if (fs.readFileSync(path.join(chatsDir, chat, name), 'utf8').includes(cwd)) return true
      } catch {
        // A chat without that file cannot name anything.
      }
    }
  }
  return false
}

/**
 * The `projects/<name>` directory freebuff keeps this folder's chats in.
 *
 * freebuff usually keys it by the folder's base name, but it can key it by the
 * whole path or a sanitised version of it. Looking only at the base name meant
 * a working session looked silent whenever freebuff chose another name: the
 * stall watch killed it after 20 minutes and the diagnosis blamed "no
 * progress" on a session that had been working the whole time. The project that
 * names this folder is used instead — the same fallback work.js makes — and the
 * answer is cached, because the progress probe runs every second.
 */
function projectDirName (configDir, cwd) {
  if (!cwd) return null
  const key = `${configDir}\n${cwd}`
  const now = Date.now()
  const cached = projectNames.get(key)
  if (cached && now - cached.at < PROJECT_LOOKUP_MS) return cached.name

  const projectsDir = path.join(configDir, 'projects')
  const base = path.basename(cwd)
  const entries = readEntries(projectsDir)
  let name = base && entries.includes(base) ? base : null
  if (!name && base) {
    name = entries.find((entry) => entry.includes(base)) || null
  }
  if (!name) {
    name = entries.find((entry) =>
      chatsNameCwd(path.join(projectsDir, entry), cwd)
    ) || null
  }

  projectNames.set(key, { name, at: now })
  return name
}

/**
 * Last time freebuff wrote anything inside its own config dir.
 *
 * A session records its work far below the config dir: the chat it is running
 * appends to `projects/<project>/chats/<chat>/log.jsonl` (plus its
 * chat-messages.json and run-state.json) as the agent works. Looking only at
 * the config dir's own files saw none of that, so a busy session looked silent:
 * the watchdog believed a typed prompt had never been sent, and pressed Enter
 * and pasted the prompt again on top of itself.
 *
 * `cwd` narrows the scan to the project being worked on, so the cost does not
 * grow with every other chat on the machine.
 */
function activityStamp (configDir, cwd, options = {}) {
  if (!configDir) return 0

  const maxAgeMs = Number(options.maxAgeMs) > 0 ? Number(options.maxAgeMs) : 0
  const key = `${configDir}\n${cwd || ''}`
  if (maxAgeMs > 0) {
    const cached = activityStamps.get(key)
    if (cached && Date.now() - cached.at <= maxAgeMs) return cached.value
  }

  let newest = 0
  const note = (file) => {
    try {
      const stats = fs.statSync(file)
      if (stats.mtimeMs > newest) newest = stats.mtimeMs
    } catch {
      // Missing or unreadable files simply do not count.
    }
  }

  for (const name of ACTIVITY_FILES) note(path.join(configDir, name))
  for (const name of readEntries(configDir)) {
    if (name.startsWith('freebuff-live-')) note(path.join(configDir, name))
  }

  const projectsDir = path.join(configDir, 'projects')
  const projects = cwd
    ? [projectDirName(configDir, cwd)].filter(Boolean)
    : readEntries(projectsDir)
  for (const project of projects) {
    const projectDir = path.join(projectsDir, project)
    // The project and its chats dir move when a chat is created.
    note(projectDir)
    const chatsDir = path.join(projectDir, 'chats')
    note(chatsDir)
    for (const chat of readEntries(chatsDir)) {
      const chatDir = path.join(chatsDir, chat)
      for (const file of CHAT_FILES) note(path.join(chatDir, file))
    }
  }
  if (maxAgeMs > 0) activityStamps.set(key, { value: newest, at: Date.now() })
  return newest
}

function backoffFor (consecutiveFailures, baseMs = BASE_BACKOFF_MS) {
  const step = Math.max(1, consecutiveFailures)
  return Math.min(MAX_BACKOFF_MS, baseMs * 2 ** (step - 1))
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * How long until this account may run again. The usage API's next-quota time
 * is the only real answer; without it a conservative default is used, because
 * retrying earlier only produces the same free-session screen.
 */
async function resetWaitMs (accountId, options = {}) {
  const now = options.now ?? Date.now()
  const state = loadState()
  const account = state.accounts.find((item) => item.id === accountId)
  const balance = account
    ? await credits.get(account, { timeoutMs: options.timeoutMs || 3000 })
    : null
  const resetsAt = balance && balance.ok && balance.resetsAt
    ? Date.parse(balance.resetsAt)
    : NaN
  const wanted = Number.isFinite(resetsAt)
    ? resetsAt - now
    : (options.defaultMs ?? DEFAULT_LIMIT_WAIT_MS)
  const floor = options.minMs ?? MIN_LIMIT_WAIT_MS
  return Math.min(MAX_LIMIT_WAIT_MS, Math.max(floor, wanted))
}

/** Keep an account out of rotation until its quota should be back. */
function coolAccount (accountId, waitMs, reason = 'free sessions used up', now = Date.now()) {
  const until = new Date(now + waitMs + 60 * 1000).toISOString()
  mutateState((state) => accounts.markCooldown(state, accountId, until, reason))
  return until
}

/**
 * Where a session may move next.
 *
 * Only an account that can actually run is a candidate: signed in, not the one
 * that just failed, not waiting out a consumed quota, not one whose token has
 * expired, and — the case that matters when several sessions run at once — not
 * one that already reported an auth failure. Moving to a broken account only
 * reproduces the same failure under a different number and burns a start.
 *
 * The longest-idle candidate wins, because that is the account with the most
 * free sessions left; taking the first in the file handed every rotation to the
 * same neighbour and left the rest unused.
 */
function anotherAccount (accountId, options = {}) {
  const now = options.now ?? Date.now()
  const grace = options.graceMs ?? accounts.expiryGraceMs()
  const state = loadState()
  const candidates = state.accounts.filter((account) => {
    if (account.id === accountId) return false
    if (!accounts.isSignedIn(account)) return false
    if (accounts.authFailureActive(account)) return false
    if (accounts.coolingDown(account, { now })) return false
    const { expiresAt } = accounts.credentialExpiry(account)
    if (expiresAt && expiresAt - now <= grace) return false
    return true
  })
  if (candidates.length === 0) return null
  return candidates.sort((a, b) => {
    const aUsed = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0
    const bUsed = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0
    if (aUsed !== bUsed) return aUsed - bUsed
    return String(a.id).localeCompare(String(b.id))
  })[0]
}

/** Sleep until the deadline, noticing a stop request between slices. */
async function waitForReset (deadline, options = {}) {
  const launcherPid = options.launcherPid ?? process.pid
  while (Date.now() < deadline) {
    if (stopRequested(launcherPid)) return false
    const slice = Math.min(LIMIT_WAIT_SLICE_MS, Math.max(0, deadline - Date.now()))
    if (slice <= 0) break
    await sleep(slice)
  }
  return !stopRequested(launcherPid)
}

/**
 * Ensure the relaunch resumes the same conversation.
 *
 * Nothing else may be appended. freebuff's only positional argument is the
 * `login` command — a bare prompt is rejected outright — and `--continue`
 * takes an optional conversation id, so a trailing word would be silently
 * read as "continue conversation named that" instead of as a prompt. Nudging a
 * quiet agent is done by typing into it instead, which needs `--pty`.
 */
function continueArgs (args) {
  return ['--continue', ...withoutContinue(args)]
}

/** Is this argument list resuming a saved conversation? */
function hasContinue (args) {
  return (args || []).some(
    (arg) => arg === '--continue' || String(arg).startsWith('--continue=')
  )
}

/** The same arguments without the resume flag, for a fresh conversation. */
function withoutContinue (args) {
  return (args || []).filter(
    (arg) => arg !== '--continue' && !String(arg).startsWith('--continue=')
  )
}

/**
 * @param {object} options
 * @param {(info: object) => Promise<object>} options.run  one session
 * @param {string[]} options.args      freebuff arguments as typed
 * @param {boolean} [options.forever]  false runs exactly one session
 * @param {(accountId: string) => string} [options.configDirFor] activity probe
 * @param {(reason: string, detail: string, extra: object) => void} [options.onCritical]
 */
async function supervise (options) {
  let {
    run,
    args = [],
    cwd = process.cwd(),
    forever = true,
    env = process.env,
    configDirFor = null,
    onCritical = null,
    // The first session asked for a conversation of its own (the dashboard's
    // "new session"); every restart after it resumes that conversation.
    fresh = false,
    // A forced `--account` cannot rotate to another account, so a limit waits
    // for that account's reset instead.
    requested = null
  } = options

  const maxFastFailures = options.maxFastFailures ??
    numberFromEnv(env, 'FREEBUFFS_MAX_FAST_FAILURES', DEFAULT_MAX_FAST_FAILURES)
  const stallMs = options.stallMs ?? numberFromEnv(env, 'FREEBUFFS_STALL_MS', DEFAULT_STALL_MS)
  const maxStuckRestarts = options.maxStuckRestarts ??
    numberFromEnv(env, 'FREEBUFFS_MAX_STUCK_RESTARTS', DEFAULT_MAX_STUCK_RESTARTS)
  // How many times in a row freebuff may say "that session ended, send it
  // again" before the loop stops for a person. A retry is right once or twice;
  // ten identical ones are a condition a restart is not fixing.
  const maxLimitRestarts = options.maxLimitRestarts ??
    numberFromEnv(env, 'FREEBUFFS_MAX_LIMIT_RESTARTS', DEFAULT_MAX_LIMIT_RESTARTS)
  const maxCleanResumes = options.maxCleanResumes ??
    numberFromEnv(env, 'FREEBUFFS_MAX_CLEAN_RESUMES', DEFAULT_MAX_CLEAN_RESUMES)
  const maxFatalRetries = options.maxFatalRetries ??
    numberFromEnv(env, 'FREEBUFFS_MAX_FATAL_RETRIES', DEFAULT_MAX_FATAL_RETRIES)
  const maxFreshRestarts = options.maxFreshRestarts ??
    numberFromEnv(env, 'FREEBUFFS_MAX_FRESH_RESTARTS', DEFAULT_MAX_FRESH_RESTARTS)
  // How long to wait before the first retry; doubling from there. Tests and
  // impatient setups can shorten it.
  const baseBackoffMs = options.baseBackoffMs ??
    numberFromEnv(env, 'FREEBUFFS_RESTART_MS', BASE_BACKOFF_MS)
  const limitWaitMs = options.limitWaitMs ??
    numberFromEnv(env, 'FREEBUFFS_LIMIT_WAIT_MS', DEFAULT_LIMIT_WAIT_MS)

  clearStopRequest(process.pid)

  let attempt = 0
  let consecutiveFailures = 0
  // Sessions retired because a typed prompt never left freebuff's input box.
  let stuckRestarts = 0
  // "Session ended, continue in a new one" states that keep coming back.
  let limitRestarts = 0
  // Clean exits that ended the conversation mid-work.
  let cleanResumes = 0
  // Transient failures that were retried instead of stopping for a person.
  let fatalRetries = 0
  // Times the saved conversation was abandoned for a fresh one.
  let freshRestarts = 0
  let currentArgs = args
  let lastCode = 0
  // The account that ran the previous attempt, so a session started
  // automatically (a restart, or a rotation after an auth failure) can pick up
  // the task from the conversation it is replacing.
  let previousAccountId = null

  const stop = async ({ reason, detail, action, sessionId, accountId, stoppedAs }) => {
    if (reason) {
      logLine('error', 'supervisor.stopped', { reason, detail })
      logEvent('supervisor.stopped', { reason, detail, action })
      void notify.report(
        notify.critical({
          reason,
          detail,
          accountId,
          sessionId,
          cwd,
          action
        }),
        {
          kind: 'supervisor.critical',
          session: sessionId,
          account: accountId,
          mention: true
        }
      )
      // With voice calls on, the phone rings too, so a stop for a person is
      // not only a message waiting to be read.
      void voice.ring({
        kind: 'critical',
        question: detail ? `${reason}: ${detail}` : reason,
        action,
        sessionId,
        accountId,
        cwd
      })
      if (onCritical) onCritical(reason, detail, { sessionId, accountId })
    }
    return { code: lastCode, attempts: attempt, stopped: stoppedAs || reason || 'clean' }
  }

  for (;;) {
    // An automatic restart from home (a reboot service, an autostart entry)
    // would relaunch freebuff on its project picker, which an unattended
    // session can never leave. From the second attempt on, adopt the folder
    // that was picked or used last so every restart continues in the same
    // project. The first attempt of a new session is left alone: the picker is
    // where the person chooses the folder themselves.
    const continuing = hasContinue(currentArgs)
    if ((attempt > 0 || continuing) && accounts.isProjectPickerFolder(cwd)) {
      const recovered = accounts.resolveProjectFolder(cwd, loadState())
      if (recovered !== cwd) {
        logLine('info', 'session folder recovered', {
          from: shortHome(cwd),
          to: shortHome(recovered)
        })
        logEvent('supervisor.cwd_recovered', {
          from: cwd,
          to: recovered,
          reason: 'a restart was about to start in the home folder'
        })
        cwd = recovered
      }
    }

    attempt += 1
    const result = await run({
      attempt,
      cwd,
      args: currentArgs,
      restarting: attempt > 1,
      previousAccountId,
      stallMs,
      configDirFor,
      fresh
    })

    lastCode = result.code
    previousAccountId = result.accountId || previousAccountId
    const elapsedMs = result.elapsedMs || 0
    const signal = result.signal
    logEvent('supervisor.attempt', {
      attempt,
      session: result.sessionId,
      account: result.accountId,
      code: result.code,
      signal,
      durationMs: elapsedMs,
      stalled: Boolean(result.stalled)
    })

    // A transient failure (the binary was being replaced, the pty broke, a
    // resource limit) is retried instead of closing the task. Only a failure a
    // retry cannot fix, or too many of them in a row, stops for a person.
    if (result.fatal && result.retryable === true && fatalRetries < maxFatalRetries) {
      fatalRetries += 1
      consecutiveFailures = 0
      const wait = backoffFor(fatalRetries, baseBackoffMs)
      logLine('warn', 'transient session failure — trying again', {
        reason: result.fatal,
        detail: result.fatalDetail || '',
        retry: fatalRetries,
        in: formatDuration(wait)
      })
      logEvent('supervisor.fatal_retry', {
        reason: result.fatal,
        detail: result.fatalDetail || '',
        retry: fatalRetries,
        waitMs: wait,
        session: result.sessionId,
        account: result.accountId
      })
      currentArgs = continueArgs(args)
      await sleep(wait)
      continue
    }

    // Something the loop cannot fix: report it and stop trying.
    if (result.fatal) {
      return await stop({
        reason: result.fatal,
        detail: result.fatalDetail || '',
        action: result.fatalAction || 'inspect the supervisor log, then run `sfreebuff`',
        sessionId: result.sessionId,
        accountId: result.accountId
      })
    }

    // A free session ending is not a crash and not a finished task. Handling
    // it before the clean-exit rule below is what stopped the supervisor from
    // quitting when the session ran out of free sessions, and what stops it
    // from restarting the same dead account until it gives up for a person.
    if (result.limited) {
      const limited = result.limited
      consecutiveFailures = 0
      stuckRestarts = 0
      logLine('warn', 'session interrupted by a freebuff state', {
        state: limited.kind,
        account: result.accountId,
        detail: limited.message
      })
      logEvent('supervisor.limited', {
        state: limited.kind,
        account: result.accountId,
        session: result.sessionId,
        detail: limited.message
      })

      if (stopRequested(process.pid)) {
        clearStopRequest(process.pid)
        logLine('info', 'supervisor.stop_requested')
        return await stop({
          reason: null,
          stoppedAs: 'stopped on request',
          sessionId: result.sessionId,
          accountId: result.accountId,
          action: 'stopped on request'
        })
      }

      if (!forever) {
        return { code: lastCode, attempts: attempt, stopped: limited.kind }
      }

      if (limited.kind === 'session-limit' && result.accountId) {
        const waitMs = await resetWaitMs(result.accountId, {
          defaultMs: limitWaitMs,
          minMs: options.minLimitWaitMs ?? MIN_LIMIT_WAIT_MS
        })
        const until = coolAccount(result.accountId, waitMs)
        const alternative = requested ? null : anotherAccount(result.accountId)

        if (alternative) {
          logLine('info', 'free sessions used up — switching account', {
            from: result.accountId,
            to: alternative.id
          })
          logEvent('supervisor.rotate', {
            from: result.accountId,
            to: alternative.id,
            reason: 'free sessions used up'
          })
          currentArgs = continueArgs(args)
          continue
        }

        logLine('info', 'free sessions used up — waiting for the reset', {
          account: result.accountId,
          until,
          wait: formatDuration(waitMs)
        })
        logEvent('supervisor.limit_wait', {
          account: result.accountId,
          until,
          waitMs
        })
        const ready = await waitForReset(Date.now() + waitMs, { launcherPid: process.pid })
        if (!ready) {
          clearStopRequest(process.pid)
          logLine('info', 'supervisor.stop_requested')
          return await stop({
            reason: null,
            stoppedAs: 'stopped on request',
            sessionId: result.sessionId,
            accountId: result.accountId,
            action: 'stopped on request'
          })
        }
        currentArgs = continueArgs(args)
        continue
      }

      // freebuff asked for the message again on a new session or turn, so the
      // task is simply typed into the next attempt. Not a failure.
      limitRestarts += 1
      if (limitRestarts > maxLimitRestarts) {
        return await stop({
          reason: 'freebuff keeps ending the session',
          detail:
            `${limitRestarts} sessions in a row ended on the same freebuff state ` +
            `(${limited.kind}) and had to be continued. Relaunching is not recovering it.`,
          action: 'run `sfreebuff doctor`, then open this folder with freebuff by hand',
          sessionId: result.sessionId,
          accountId: result.accountId
        })
      }
      currentArgs = continueArgs(args)
      await sleep(Math.max(1000, limited.delayMs || baseBackoffMs))
      continue
    }

    // A completed or crashed session resets the "keeps ending" counts.
    limitRestarts = 0
    fatalRetries = 0

    // A prompt that never left the input box is retried by relaunching the
    // conversation, which is what the caller has just done. A TUI that does
    // the same thing every time needs a person, not another restart.
    stuckRestarts = result.stuck ? stuckRestarts + 1 : 0
    if (stuckRestarts >= maxStuckRestarts) {
      return await stop({
        reason: 'freebuff will not accept a typed prompt',
        detail:
          `${stuckRestarts} sessions in a row ended with a message left in ` +
          "freebuff's input box. Relaunching the conversation does not recover it.",
        action: 'check that freebuff runs by hand in this folder, then start the supervisor again',
        sessionId: result.sessionId,
        accountId: result.accountId
      })
    }

    if (!forever) return { code: lastCode, attempts: attempt, stopped: 'once' }

    if (stopRequested(process.pid)) {
      clearStopRequest(process.pid)
      logLine('info', 'supervisor.stop_requested')
      logEvent('supervisor.stop_requested', { attempt })
      return await stop({
        reason: null,
        stoppedAs: 'stopped on request',
        sessionId: result.sessionId,
        accountId: result.accountId,
        action: 'stopped on request'
      })
    }

    // Ctrl-C in the freebuff window is the human saying "that is enough".
    if (signal === 'SIGINT') {
      logLine('info', 'supervisor.interrupted')
      logEvent('supervisor.interrupted', { attempt, session: result.sessionId })
      return { code: 130, attempts: attempt, stopped: 'interrupted' }
    }

    // A clean exit is freebuff finishing normally, not a failure to retry. A
    // session the supervisor retired itself (a prompt stuck in the input box)
    // may still exit 0, and that is not the work being done.
    if (result.code === 0 && !signal && !result.stalled && !result.stuck) {
      // Except when the TUI went away in the middle of a turn, or with a
      // question still open. That exit code says "the conversation ended", not
      // "the task is finished", and stopping there closed the task while the
      // work was half done. The conversation is resumed instead.
      const cutShort = (result.busyAtExit || result.dialogAtExit) && forever
      if (cutShort && cleanResumes < maxCleanResumes) {
        cleanResumes += 1
        logLine('warn', 'freebuff exited in the middle of a turn — resuming the task', {
          attempt: attempt + 1,
          running: Boolean(result.busyAtExit),
          question: Boolean(result.dialogAtExit),
          resume: cleanResumes
        })
        logEvent('supervisor.clean_resume', {
          attempt: attempt + 1,
          running: Boolean(result.busyAtExit),
          question: Boolean(result.dialogAtExit),
          session: result.sessionId,
          account: result.accountId,
          resume: cleanResumes
        })
        currentArgs = continueArgs(args)
        const wait = backoffFor(1, baseBackoffMs)
        await sleep(wait)
        continue
      }
      if (cutShort) {
        return await stop({
          reason: 'freebuff keeps quitting in the middle of a turn',
          detail:
            `${cleanResumes} sessions in a row ended while the agent was still working or a ` +
            'question was open. Resuming the conversation did not keep it alive.',
          action: 'check the freebuff window by hand; the TUI itself is quitting',
          sessionId: result.sessionId,
          accountId: result.accountId
        })
      }
      logLine('info', 'supervisor.done')
      logEvent('supervisor.done', { attempt, session: result.sessionId })
      return { code: 0, attempts: attempt, stopped: 'completed' }
    }

    const fast = elapsedMs < FAST_FAILURE_MS
    consecutiveFailures = fast ? consecutiveFailures + 1 : 0
    // Getting this far means a session actually ran, so the TUI is not freshly
    // broken: the next burst of failures may try a new conversation again.
    if (!fast) cleanResumes = 0

    if (fast && consecutiveFailures >= maxFastFailures) {
      // Before asking a person to step in, the one automatic fix left is to
      // stop resuming the saved conversation. A corrupt chat state makes the
      // TUI exit within seconds every time, and a fresh conversation with the
      // task typed into it runs normally again.
      if (hasContinue(currentArgs) && freshRestarts < maxFreshRestarts) {
        freshRestarts += 1
        consecutiveFailures = 0
        logLine('warn', 'freebuff keeps failing at once — starting a new conversation', {
          reason: 'the saved conversation may be corrupt'
        })
        logEvent('supervisor.fresh_conversation', {
          attempt: attempt + 1,
          reason: 'repeated fast failures',
          session: result.sessionId,
          account: result.accountId
        })
        currentArgs = withoutContinue(args)
        await sleep(backoffFor(1, baseBackoffMs))
        continue
      }
      return await stop({
        reason: `${consecutiveFailures} failed starts in a row`,
        detail:
          `freebuff exited within ${Math.round(FAST_FAILURE_MS / 1000)}s of starting ` +
          `${consecutiveFailures} times (exit code ${result.code}` +
          `${signal ? `, signal ${signal}` : ''}). A retry cannot fix this.`,
        action: 'run `sfreebuff doctor`, fix the cause, then start it again',
        sessionId: result.sessionId,
        accountId: result.accountId
      })
    }

    // Resume the same conversation on every retry.
    currentArgs = continueArgs(args)

    const wait = backoffFor(consecutiveFailures || 1, baseBackoffMs)
    logLine('info', 'supervisor.restarting', {
      attempt: attempt + 1,
      in: formatDuration(wait),
      cwd: shortHome(cwd),
      stalled: Boolean(result.stalled)
    })
    logEvent('supervisor.restart', {
      attempt: attempt + 1,
      waitMs: wait,
      stalled: Boolean(result.stalled)
    })
    await sleep(wait)
  }
}

module.exports = {
  supervise,
  requestStop,
  stopRequested,
  clearStopRequest,
  stopFilePath,
  activityStamp,
  projectDirName,
  backoffFor,
  continueArgs,
  hasContinue,
  withoutContinue,
  resetWaitMs,
  coolAccount,
  anotherAccount,
  waitForReset,
  DEFAULT_LIMIT_WAIT_MS,
  DEFAULT_STALL_MS,
  DEFAULT_NUDGE_MS,
  FAST_FAILURE_MS,
  DEFAULT_MAX_FAST_FAILURES,
  DEFAULT_MAX_STUCK_RESTARTS,
  DEFAULT_MAX_LIMIT_RESTARTS,
  DEFAULT_MAX_CLEAN_RESUMES,
  DEFAULT_MAX_FATAL_RETRIES,
  DEFAULT_MAX_FRESH_RESTARTS
}
