'use strict'

/**
 * `sfreebuff dashboard` — a live terminal view of every account and session.
 *
 * One supervisor still owns one terminal (and one freebuff TUI), so many
 * sessions at once means many supervisors. This dashboard starts them in their
 * own terminal windows, one per account and folder, lists all of them from the
 * shared state file, and can stop any one of them without touching the others:
 * stopping writes the per-launcher stop file and ends that session's TUI, so
 * its supervisor exits instead of restarting it.
 *
 * Sessions started here skip the extra side-monitor window — the dashboard is
 * the supervision — but everything is still recorded in the normal state,
 * logs and reports.
 */

const path = require('path')
const { spawn } = require('child_process')
const pkg = require('../package.json')
const { loadState, mutateState } = require('./state')
const accounts = require('./accounts')
const credits = require('./credits')
const { activeMonitors } = require('./status')
const { windowCommand } = require('./terminal')
const { requestStop } = require('./supervise')
const voice = require('./voice')
const {
  processMatches,
  sessionAlive,
  FREEBUFF_COMMAND,
  SUPERVISOR_COMMAND,
  formatDuration,
  shortHome
} = require('./util')

const LAUNCHER = path.join(__dirname, '..', 'bin', 'sfreebuff.js')
const REFRESH_MS = 1000
const CREDITS_MS = 60 * 1000
const LOGIN_WATCH_MS = 10 * 60 * 1000
const MAX_ACCOUNT_ROWS = 8
const MAX_SESSION_ROWS = 12
const MAX_LOST_ROWS = 3

const ANSI = /\u001b\[[0-9;]*m/g

function clip (text, width) {
  const plain = String(text == null ? '' : text).replace(ANSI, '')
  if (width <= 0) return ''
  if (plain.length <= width) return plain
  if (width === 1) return '…'
  return `${plain.slice(0, width - 1)}…`
}

/** Break a sentence into a few short rows for the settings screen. */
function wrap (text, width, maxLines = 3) {
  const words = String(text == null ? '' : text).split(/\s+/).filter(Boolean)
  const rows = []
  let current = ''
  for (const word of words) {
    if (current && current.length + word.length + 1 > width) {
      rows.push(current)
      current = word
    } else {
      current = current ? `${current} ${word}` : word
    }
  }
  if (current) rows.push(current)
  return rows.slice(0, maxLines)
}

/** Pad to a column width without losing colours when the text already fits. */
function pad (text, width) {
  const raw = String(text == null ? '' : text)
  const plain = raw.replace(ANSI, '')
  if (plain.length > width) return clip(plain, width)
  return raw + ' '.repeat(Math.max(0, width - plain.length))
}

function painter (enabled) {
  return (code, text) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : text)
}

/** Everything the view needs, read from the same files `status` uses. */
function collect (options = {}) {
  const now = options.now ?? Date.now()
  const balances = options.balances || new Map()
  let state
  try {
    state = loadState()
  } catch {
    state = { accounts: [], sessions: [] }
  }

  const monitors = activeMonitors()
  const monitorBySession = new Map(monitors.map((item) => [item.session, item]))
  // Liveness has to mean exactly what it means to stopSession: a pid that is
  // alive but no longer this session's (a reused number, a zombie) is not a
  // live session, or the row reads "live" and `x` refuses to stop it.
  const alive = (session) => sessionAlive(session, { verify: options.verify })

  // Live sessions first, then the most recent ones whose supervisor died. An
  // old lost record is useful for a moment, not as a permanent row.
  const open = state.sessions
    .filter((session) => !session.endedAt)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, 50)
    .map((session) => ({
      id: session.id,
      account: session.accountId,
      cwd: session.cwd,
      pid: session.pid,
      launcherPid: session.launcherPid,
      startedAt: session.startedAt,
      elapsedMs: Math.max(0, now - Date.parse(session.startedAt)),
      alive: alive(session),
      monitor: Boolean(monitorBySession.get(session.id)),
      args: Array.isArray(session.args) ? session.args : []
    }))

  const lostSessions = open.filter((session) => !session.alive)
  const sessions = [
    ...open.filter((session) => session.alive),
    ...lostSessions.slice(0, MAX_LOST_ROWS)
  ]

  const accountViews = state.accounts.map((account) => {
    const expiry = accounts.isExpiring(account, { now })
    const live = sessions.filter((session) => session.account === account.id && session.alive)
    return {
      id: account.id,
      shared: Boolean(account.shared),
      signedIn: accounts.isSignedIn(account),
      authFailed: accounts.authFailureActive(account),
      expiring: expiry.expiring,
      expired: expiry.expired,
      expiresAt: expiry.expiresAt,
      // Free sessions used up: skipped by rotation until the reset.
      cooling: accounts.coolingDown(account, { now }),
      coolingUntil: accounts.cooldownUntil(account),
      sessions: account.sessions || 0,
      lastUsedAt: account.lastUsedAt,
      live: live.length,
      credits: balances.get(account.id) || null
    }
  })

  return {
    version: pkg.version,
    now,
    cwd: options.cwd || process.cwd(),
    accounts: accountViews,
    sessions,
    live: sessions.filter((session) => session.alive).length,
    lost: lostSessions.length,
    signedIn: accountViews.filter((account) => account.signedIn).length,
    monitors: monitors.length,
    voice: voice.summary()
  }
}

function accountState (account, paint) {
  if (account.authFailed) return paint('31', 'needs login')
  if (!account.signedIn) return paint('2', 'signed out')
  if (account.expired) return paint('31', 'token expired')
  if (account.cooling) return paint('33', 'limit')
  if (account.expiring) return paint('33', 'expiring')
  return paint('32', 'signed in')
}

function accountDot (account, paint) {
  if (account.authFailed || account.expired) return paint('31', '●')
  if (!account.signedIn) return paint('2', '○')
  if (account.expiring) return paint('33', '●')
  return paint('32', '●')
}

/** One compact balance: just the number, coloured by how low it is. */
function balanceCell (account, paint) {
  const balance = account.credits
  if (!balance || !balance.ok) return paint('2', '—')
  return credits.paint(String(balance.remaining), balance, true)
}

function creditsWidth (accountsView) {
  let width = 7
  for (const account of accountsView) {
    const text = account.credits && account.credits.ok
      ? String(account.credits.remaining)
      : '—'
    if (text.length + 2 > width) width = text.length + 2
  }
  return Math.min(14, width)
}

/**
 * The settings screen: the supervisor-wide switches, drawn in place of the
 * dashboard. Voice calls is the one that matters here: turning it on starts
 * the phone line, and the row itself is the toggle (click it, or press enter).
 */
function buildSettingsView (model, options = {}) {
  const layout = { accounts: [], sessions: [], settings: [], buttons: [] }
  const width = Math.max(60, options.width || 100)
  const height = Math.max(12, options.height || 30)
  const color = options.color !== false
  const paint = painter(color)
  const selected = options.selected || {}
  const message = options.message || ''
  const state = model.voice || {
    enabled: false,
    running: false,
    url: '',
    ntfy: false,
    model: ''
  }

  const muted = (text) => paint('38;5;244', text)
  const title = (text) => paint('1;38;5;45', text)
  const rule = paint('38;5;238', '─'.repeat(width))
  const lines = []
  const clock = new Date(model.now || Date.now())
  lines.push(
    pad(`  ${title('FREEBUFFS')}  ${muted('settings')}`, width - 10) +
    muted(clock.toTimeString().slice(0, 8).padStart(8))
  )
  lines.push(rule)
  lines.push('')

  const chosen = selected.settings === 0
  const marker = chosen ? paint('1;38;5;45', '▸') : ' '
  const switchText = state.enabled
    ? paint('1;38;5;16;48;5;45', ' voice calls ON ')
    : paint('2;38;5;240', ' voice calls off ')
  lines.push(` ${marker} ${pad('Voice calls', 22)}${switchText}`)
  layout.settings.push({ index: 0, y: lines.length - 1 })

  const detail = state.enabled
    ? 'Freebuff rings the phone and reads out a decision it needs. The phone can call in too.'
    : 'Let freebuff call you when it needs a decision, and call it from the phone over Tailscale.'
  for (const row of wrap(detail, Math.max(20, width - 6))) {
    lines.push(`     ${muted(row)}`)
  }
  lines.push('')

  const rows = [
    ['link', state.url || 'off — turn voice calls on to get a call link'],
    ['server', state.running
      ? 'running'
      : (state.enabled ? 'starting, or stopped — `sfreebuff voice serve`' : 'stopped')],
    ['push', state.ntfy
      ? 'ntfy app configured'
      : 'off — an open call page still rings (`sfreebuff voice ntfy auto`)'],
    ['brain', state.model
      ? `${state.model} (local, unlimited)`
      : 'not configured — the built-in supervisor replies are used'],
    ['voice', 'the phone\'s own voice — install a Premium voice for the best sound']
  ]
  for (const [label, value] of rows) {
    lines.push(`     ${muted(pad(label, 8))}${clip(value, Math.max(10, width - 18))}`)
  }
  lines.push('')
  lines.push(`  ${muted('Enter or space switches it on or off. Opening the link on the phone is the call.')}`)

  const spare = height - lines.length - 5
  if (spare > 0) lines.push(...Array(spare).fill(''))
  lines.push(rule)

  const buttons = [
    { action: 'toggle-voice', label: `space ${state.enabled ? 'turn off' : 'turn on'}`, enabled: true },
    { action: 'settings-back', label: 'esc back', enabled: true },
    { action: 'quit', label: 'q quit', enabled: true }
  ]
  const buttonRows = []
  let row = { items: [], text: '  ' }
  for (const button of buttons) {
    const text = `[ ${button.label} ]`
    if (row.items.length > 0 && row.text.length + text.length + 1 > width) {
      buttonRows.push(row)
      row = { items: [], text: '  ' }
    }
    row.items.push({ button, text, start: row.text.length })
    row.text += `${text} `
  }
  buttonRows.push(row)

  const footerStart = lines.length
  lines.push(...buttonRows.map((entry) => '  ' + entry.items.map((item) =>
    color ? `\u001b[1;38;5;16;48;5;45m${item.text}\u001b[0m` : item.text
  ).join(' ')))
  buttonRows.forEach((entry, rowIndex) => {
    for (const item of entry.items) {
      layout.buttons.push({
        action: item.button.action,
        start: item.start,
        end: item.start + item.text.length - 1,
        y: footerStart + rowIndex
      })
    }
  })
  lines.push(message
    ? `  ${muted(clip(message, width - 4))}`
    : muted('  these settings are shared by every supervisor on this machine'))

  const visible = lines.slice(0, height).map((line) => {
    const plain = line.replace(ANSI, '')
    return plain.length > width ? plain.slice(0, width - 1) + '…' : line
  })
  for (const key of Object.keys(layout)) {
    if (!Array.isArray(layout[key])) continue
    layout[key] = layout[key].filter((item) => item.y < visible.length)
  }
  return { lines: visible, layout }
}

/**
 * Render the whole view. Pure: no terminal, no clock, no state reads, so the
 * tests and the non-tty path use exactly what the interactive loop shows.
 */
function render (model, options = {}) {
  return buildView(model, options).lines
}

/**
 * The rendered lines plus where they are on screen, so a mouse click can be
 * turned into the row or button under the pointer.
 */
function buildView (model, options = {}) {
  if (options.screen === 'settings') return buildSettingsView(model, options)

  const layout = { accounts: [], sessions: [], buttons: [] }
  const width = Math.max(60, options.width || 100)
  const height = Math.max(12, options.height || 30)
  const color = options.color !== false
  const paint = painter(color)
  const focus = options.focus === 'accounts' ? 'accounts' : 'sessions'
  const selected = options.selected || {}
  const message = options.message || ''

  const rule = paint('38;5;238', '─'.repeat(width))
  const muted = (text) => paint('38;5;244', text)
  const title = (text) => paint('1;38;5;45', text)

  const lines = []
  const clock = new Date(model.now || Date.now())
  const clockText = clock.toTimeString().slice(0, 8)
  const version = model.version ? `v${model.version}` : ''
  const heading = `  ${title('FREEBUFFS')}  ${muted('supervisor dashboard')}` +
    (version ? `  ${muted(version)}` : '')
  lines.push(
    pad(heading, width - 10) + muted(clockText.padStart(8))
  )
  lines.push(rule)
  // A small watermark under the title: the product name, so a shared screenshot
  // says what this is and which release it came from.
  lines.push(muted(
    version
      ? `  FREEBUFF SUPERVISOR ${version} — freebuff sessions, kept running unattended`
      : '  FREEBUFF SUPERVISOR — freebuff sessions, kept running unattended'
  ))

  const fixed = 10
  const accountBudget = Math.min(
    model.accounts.length,
    Math.max(2, Math.min(MAX_ACCOUNT_ROWS, Math.floor((height - fixed) / 3)))
  )
  const sessionBudget = Math.min(
    model.sessions.length,
    Math.max(2, Math.min(MAX_SESSION_ROWS, height - fixed - accountBudget - 4))
  )

  // Accounts.
  lines.push(
    `  ${title('ACCOUNTS')}  ${muted(`${model.signedIn}/${model.accounts.length} signed in`)}`
  )

  // Narrow terminals drop column widths instead of dropping the balance, which
  // is the number the person is watching.
  const narrow = width < 76
  const accountWidth = narrow ? 11 : 13
  const stateWidth = narrow ? 9 : 11
  const liveWidth = narrow ? 6 : 8
  const sessionsWidth = narrow ? 8 : 10
  const usedWidth = narrow ? 8 : 11
  const creditWidth = creditsWidth(model.accounts)

  // Adding an account is the accounts pane's own row, at the top of the list
  // and at cursor position 0, exactly like `＋ new session` sits above the
  // session list. It is there even before the first sign-in.
  const addChosen = focus === 'accounts' && selected.accounts === 0
  const addMarker = addChosen ? paint('1;38;5;45', '▸') : ' '
  lines.push(
    ` ${addMarker} ＋ add account  ${muted('sign in another freebuff account')}`
  )
  layout.newAccount = { y: lines.length - 1 }

  if (model.accounts.length === 0) {
    lines.push(muted('  no accounts yet — run `sfreebuff login`'))
  }

  for (let index = 0; index < accountBudget; index += 1) {
    const account = model.accounts[index]
    const chosen = focus === 'accounts' && selected.accounts === index + 1
    const marker = chosen ? paint('1;38;5;45', '▸') : ' '
    const lastUsed = account.lastUsedAt
      ? `${formatDuration(model.now - Date.parse(account.lastUsedAt))} ago`
      : 'never'
    const row = [
      marker,
      ' ',
      accountDot(account, paint),
      ' ',
      pad(account.id, accountWidth),
      pad(accountState(account, paint), stateWidth),
      ' ',
      pad(account.live > 0 ? paint('32', `${account.live} live`) : muted('idle'), liveWidth),
      ' ',
      pad(`${account.sessions} sess`, sessionsWidth),
      pad(lastUsed, usedWidth),
      balanceCell(account, paint)
    ].join('')
    lines.push(` ${row}`)
    // The add-account row sits above the list, so an account's cursor
    // position is its index plus one.
    layout.accounts.push({ index: index + 1, y: lines.length - 1 })
  }
  if (model.accounts.length > accountBudget) {
    lines.push(muted(`  +${model.accounts.length - accountBudget} more accounts`))
  }

  // Sessions.
  const lostCount = model.lost ?? model.sessions.filter((session) => !session.alive).length
  lines.push(
    `  ${title('SESSIONS')}  ${muted(
      `${model.live} live · ${lostCount} lost · ${model.monitors} monitor${model.monitors === 1 ? '' : 's'}`
    )}`
  )

  const accountCol = 12
  const stateCol = 6
  const ageCol = 7
  const pidCol = 11
  const monitorCol = 5
  const sessionFolderWidth = Math.max(
    14,
    width - (2 + accountCol + stateCol + ageCol + pidCol + monitorCol + 6)
  )

  // Starting a session is what this dashboard is for, so it is a row of its
  // own and the default cursor position — selecting one of the old (lost)
  // sessions was the only way to get the cursor into this pane before.
  const starter = model.accounts.find(
    (account) => account.signedIn && !account.authFailed
  ) || null
  const starterAccount = () => {
    const picked = model.accounts[selected.accounts - 1]
    if (picked && picked.signedIn && !picked.authFailed) return picked
    return starter
  }
  const newChosen = focus === 'sessions' && selected.sessions === 0
  const newMarker = newChosen ? paint('1;38;5;45', '▸') : ' '
  const newLabel = starter
    ? `＋ new session  ${paint('38;5;244', `with ${starterAccount().id} in ${shortHome(model.cwd)}`)}`
    : paint('38;5;244', 'no signed-in account — press l to sign in')
  lines.push(` ${newMarker} ${newLabel}`)
  layout.newSession = { y: lines.length - 1 }

  if (model.sessions.length === 0) {
    lines.push(muted('  no sessions yet'))
  }

  for (let index = 0; index < sessionBudget; index += 1) {
    const session = model.sessions[index]
    const chosen = focus === 'sessions' && selected.sessions === index + 1
    const marker = chosen ? paint('1;38;5;45', '▸') : ' '
    const state = session.alive ? paint('32', 'live') : paint('31', 'lost')
    const monitor = session.monitor ? paint('32', 'mon') : muted('—')
    const row = [
      marker,
      ' ',
      pad(shortHome(session.cwd), sessionFolderWidth),
      ' ',
      pad(session.account, accountCol),
      pad(state, stateCol),
      pad(formatDuration(session.elapsedMs), ageCol),
      pad(session.pid ? `pid ${session.pid}` : '—', pidCol),
      monitor
    ].join('')  // each column is padded, so the gaps are part of the widths
    lines.push(` ${row}`)
    // The new-session row sits above the list, so a session's cursor position
    // is its index plus one.
    layout.sessions.push({ index: index + 1, y: lines.length - 1 })
  }
  if (model.sessions.length > sessionBudget) {
    lines.push(muted(`  +${model.sessions.length - sessionBudget} more sessions`))
  }

  // Footer pinned to the bottom of the given height when there is room. The
  // action row is a row of buttons: the keyboard shortcuts still work, and a
  // click on one of them does the same thing (see hitTest).
  const canStart = Boolean(starter)
  // A lost row is clearable with the same key, so the button is live whenever
  // there is a row to act on.
  const canStop = model.sessions.length > 0
  // The cursor decides what enter does: on a session row it continues that
  // conversation (the supervisor types the continue prompt into the resumed
  // chat), on the new-session row it starts a fresh one. The button says which,
  // because "enter start" over an existing session was a start that resumed it.
  const continueRow = focus === 'sessions' && selected.sessions > 0
    ? model.sessions[selected.sessions - 1] || null
    : null
  // Removing an account deletes its sign-in and its chat history. account-1 is
  // the machine's own freebuff config dir, so it is never deleted from here,
  // and an account with a session still running is refused until it is stopped.
  const removeTarget = model.accounts[selected.accounts - 1] || null
  const canRemove = Boolean(removeTarget) && !removeTarget.shared && !removeTarget.live
  const buttons = [
    {
      action: 'start',
      label: continueRow ? 'enter continue' : 'enter start',
      enabled: continueRow ? true : canStart
    },
    { action: 'new', label: 'n new session', enabled: canStart },
    { action: 'stop', label: 'x stop', enabled: canStop },
    { action: 'login', label: 'l login', enabled: model.accounts.length > 0 },
    { action: 'remove', label: 'd remove', enabled: canRemove },
    { action: 'settings', label: 's settings', enabled: true },
    { action: 'refresh', label: 'r refresh', enabled: true },
    { action: 'quit', label: 'q quit', enabled: true }
  ]
  // A row of buttons, not just words: the blocks make them look like something
  // a mouse can press. An action that can run now is bright; grey is reserved
  // for one that cannot, because a grey button reads as broken even when the
  // key works — the start button did, and looked dead.
  const buttonText = (button) => `[ ${button.label} ]`
  const asButton = (button) => {
    const text = buttonText(button)
    if (!color) return text
    return button.enabled
      ? `\u001b[1;38;5;16;48;5;45m${text}\u001b[0m`
      : `\u001b[2;38;5;240m${text}\u001b[0m`
  }
  // Buttons wrap onto a second row instead of being cut off: a narrow
  // terminal must not hide the action that starts a session.
  const buttonRows = []
  let buttonRow = { text: '  ', items: [] }
  for (const button of buttons) {
    const text = buttonText(button)
    if (buttonRow.items.length > 0 && buttonRow.text.length + text.length + 1 > width) {
      buttonRows.push(buttonRow)
      buttonRow = { text: '  ', items: [] }
    }
    buttonRow.items.push({ button, text, start: buttonRow.text.length })
    buttonRow.text += `${text} `
  }
  buttonRows.push(buttonRow)
  const styledButtonRows = buttonRows.map(
    (entry) => '  ' + entry.items.map((item) => asButton(item.button)).join(' ')
  )

  const keys = '  ↑↓ select · tab pane · s settings · click a row or button · wheel scroll'
  const footer = [
    rule,
    ...styledButtonRows,
    muted(keys),
    message ? `  ${muted(clip(message, width - 4))}` : muted(`  new sessions start in ${shortHome(model.cwd)}`)
  ]
  const spare = height - lines.length - footer.length
  if (spare > 0) lines.push(...Array(spare).fill(''))
  // On a short terminal the button row must still fit: it is the only way to
  // drive the dashboard with a mouse, so rows are dropped from the bottom of
  // the lists instead of pushing the actions off the screen.
  while (lines.length + footer.length > height && lines.length > 3) lines.pop()
  const footerStart = lines.length
  lines.push(...footer)
  buttonRows.forEach((entry, rowIndex) => {
    const y = footerStart + 1 + rowIndex
    for (const item of entry.items) {
      layout.buttons.push({
        action: item.button.action,
        start: item.start,
        end: item.start + item.text.length - 1,
        y
      })
    }
  })

  const visible = lines.slice(0, height).map((line) => {
    const plain = line.replace(ANSI, '')
    return plain.length > width
      ? plain.slice(0, width - 1) + '…'
      : line
  })
  // Rows and buttons that fell off the bottom of a short terminal are not
  // clickable, since nothing visible sits on that line.
  for (const key of Object.keys(layout)) {
    if (!Array.isArray(layout[key])) continue
    layout[key] = layout[key].filter((item) => item.y < visible.length)
  }
  if (layout.newSession && layout.newSession.y >= visible.length) {
    layout.newSession = null
  }
  if (layout.newAccount && layout.newAccount.y >= visible.length) {
    layout.newAccount = null
  }
  return { lines: visible, layout }
}

/**
 * Arguments for a supervisor that runs one account in a folder.
 *
 * `--no-sudo`: a session opened from the dashboard or from the phone is
 * unattended. There is nobody at that window's keyboard to type a sudo
 * password, so it skips the unlock instead of stopping at a prompt.
 *
 * `--fresh` / `--continue`: a new session is a conversation of its own, while a
 * session continued from a row resumes that folder's chat and is typed the
 * continue prompt. Without one of the two the launcher resumed whatever chat
 * ran last here, so a brand new session carried on the previous task.
 */
function sessionArgs (account, cwd, options = {}) {
  const args = ['--account', account.id, '--cwd', cwd, '--no-monitor', '--no-sudo']
  args.push(options.continue ? '--continue' : '--fresh')
  return args
}

/**
 * How to open a supervisor (or a login) in its own window. Windows detached
 * processes get their own console; POSIX needs a terminal emulator.
 */
function launchPlan ({
  args,
  cwd,
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  launcher = LAUNCHER
}) {
  const options = { detached: true, stdio: 'ignore', cwd, env }

  if (platform === 'win32') {
    return { command: execPath, args: [launcher, ...args], options }
  }

  const plan = windowCommand({
    platform,
    command: execPath,
    args: [launcher, ...args],
    env
  })
  if (!plan) return null
  return { command: plan.command, args: plan.args, options }
}

/**
 * No window, but still a session: the supervisor runs detached and keeps a
 * pty, so freebuff has the terminal it needs even on a machine that cannot
 * show one (a server, a container, an SSH box).
 */
function backgroundPlan ({
  args,
  cwd,
  env = process.env,
  execPath = process.execPath,
  launcher = LAUNCHER
}) {
  return {
    command: execPath,
    args: [launcher, ...args],
    options: { detached: true, stdio: 'ignore', cwd, env }
  }
}

/**
 * Open a new supervisor for one account, in its own terminal window when the
 * machine has one, and in the background when it does not. A headless machine
 * is the normal place for the 24/7 loop, and a session that cannot be started
 * from the dashboard or the phone there would make both views useless.
 */
function startSession ({ account, cwd, resume = false, spawnFn = spawn, ...rest } = {}) {
  if (!account) return { ok: false, reason: 'no account selected' }
  const args = sessionArgs(account, cwd, { continue: resume })
  const window = launchPlan({ args, cwd, ...rest })
  const plan = window || backgroundPlan({ args, cwd, ...rest })

  try {
    const child = spawnFn(plan.command, plan.args, plan.options)
    if (child.unref) child.unref()
    return { ok: true, pid: child.pid, command: plan.command, window: Boolean(window) }
  } catch (error) {
    return { ok: false, reason: error.message }
  }
}

/** Open `sfreebuff login --account N` in its own window. */
function loginAccount ({ account, cwd, spawnFn = spawn, ...rest } = {}) {
  if (!account) return { ok: false, reason: 'no account selected' }
  return spawnLogin({ args: ['login', '--account', account.id], cwd, spawnFn, ...rest })
}

/**
 * Add an account: `sfreebuff login --new` creates a fresh container and runs
 * freebuff's normal sign-in in it. The new row appears here once that window
 * has written its credentials.
 */
function addAccount ({ cwd, spawnFn = spawn, ...rest } = {}) {
  return spawnLogin({ args: ['login', '--new'], cwd, spawnFn, ...rest })
}

function spawnLogin ({ args, cwd, spawnFn, ...rest }) {
  const plan = launchPlan({ args, cwd, ...rest })
  if (!plan) return { ok: false, reason: 'no terminal window available' }
  try {
    const child = spawnFn(plan.command, plan.args, plan.options)
    if (child.unref) child.unref()
    return { ok: true, pid: child.pid }
  } catch (error) {
    return { ok: false, reason: error.message }
  }
}

/**
 * Delete one account container: its record, its sign-in and its chat history.
 * The state file is rewritten in the same locked read-modify-write the rest of
 * the dashboard uses, so a concurrent supervisor cannot resurrect the record.
 */
function removeAccount (accountId) {
  try {
    return mutateState((state) => accounts.removeAccount(state, accountId))
  } catch (error) {
    return { ok: false, reason: error.message }
  }
}

/**
 * Mark a session record as ended because nothing of it is running any more.
 *
 * The launcher and the monitor both do this, and neither can when both are
 * gone: a dashboard session runs with `--no-monitor`, so a window that died
 * outright left its record open for good.
 */
function retireSession (sessionId) {
  try {
    const session = mutateState((state) =>
      accounts.finalizeSession(state, sessionId, {
        note: 'cleared from the dashboard: nothing of this session was running'
      })
    )
    return Boolean(session && session.endedAt)
  } catch {
    return false
  }
}

/**
 * Stop one supervisor and its session, leaving the others alone. Its loop sees
 * the per-launcher stop file and exits instead of restarting the session.
 */
function stopSession (session, options = {}) {
  const kill = options.kill || process.kill
  const verify = options.verify || processMatches
  if (!session || session.endedAt) {
    return { ok: false, reason: 'no live session selected' }
  }

  // The pids in the state file are old numbers on a machine that runs for days:
  // after a reboot or a long uptime the same number belongs to something else —
  // the desktop shell, another session. A stop signals only the processes that
  // still look like this session's freebuff and its supervisor; a number that
  // does not is left alone, and the stale record is simply not stoppable.
  const ownsSession = verify(session.pid, FREEBUFF_COMMAND)
  const ownsLauncher = verify(session.launcherPid, SUPERVISOR_COMMAND)

  let stopFile = null
  if (ownsLauncher) {
    stopFile = requestStop(session.launcherPid)
  }
  if (ownsSession) {
    try {
      kill(session.pid, 'SIGTERM')
    } catch {
      // It may have just exited; the stop file still retires the supervisor.
    }
  }
  if (!stopFile && !ownsSession) {
    // Nothing of this session is left to signal: its pids died, or the numbers
    // now belong to other processes. The record is all that remains, and a
    // record with no process behind it is what kept the row on screen as a live
    // session that could not be stopped. Stopping it clears it.
    const retired = session.id ? retireSession(session.id) : false
    return retired
      ? { ok: true, retired: true }
      : { ok: false, reason: 'that session is no longer running' }
  }
  return { ok: true, stopFile }
}

/**
 * Mouse input in SGR form (\u001b[<b;x;yM), which is what the dashboard asks
 * the terminal for. Lines and columns are 1-based there and 0-based here.
 */
function mouseEvents (chunk) {
  const text = String(chunk)
  const events = []
  const pattern = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g
  let match = pattern.exec(text)
  while (match) {
    const button = Number(match[1])
    const x = Number(match[2]) - 1
    const y = Number(match[3]) - 1
    const pressed = match[4] === 'M'
    if (pressed && button === 0) events.push({ x, y, click: true })
    else if (pressed && button === 64) events.push({ x, y, wheel: 'up' })
    else if (pressed && button === 65) events.push({ x, y, wheel: 'down' })
    match = pattern.exec(text)
  }
  return events
}

/** What a click at (x, y) lands on, if anything. */
function hitTest (layout, x, y) {
  if (!layout) return null
  for (const button of layout.buttons || []) {
    if (y === button.y && x >= button.start && x <= button.end) {
      return { action: button.action }
    }
  }
  for (const row of layout.settings || []) {
    if (y === row.y) return { action: 'toggle-voice' }
  }
  for (const row of layout.accounts || []) {
    if (y === row.y) return { action: 'choose-account', index: row.index }
  }
  for (const row of layout.sessions || []) {
    if (y === row.y) return { action: 'choose-session', index: row.index }
  }
  if (layout.newSession && y === layout.newSession.y) {
    return { action: 'choose-session', index: 0 }
  }
  if (layout.newAccount && y === layout.newAccount.y) {
    return { action: 'choose-account', index: 0 }
  }
  return null
}

/** Turn one chunk of terminal input into actions the loop understands. */
function keyActions (chunk) {
  const text = String(chunk)
  const actions = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\u0003') {
      actions.push('quit')
      break
    }
    if (text.startsWith('\u001b[A', index)) {
      actions.push('up')
      index += 2
      continue
    }
    if (text.startsWith('\u001b[B', index)) {
      actions.push('down')
      index += 2
      continue
    }
    if (char === 'k' || char === 'K') actions.push('up')
    else if (char === 'j' || char === 'J') actions.push('down')
    else if (char === '\t') actions.push('pane')
    else if (char === '\r' || char === '\n') actions.push('start')
    else if (char === 'x' || char === 'X') actions.push('stop')
    else if (char === 'l' || char === 'L') actions.push('login')
    else if (char === 'a' || char === 'A') actions.push('add')
    else if (char === 'd' || char === 'D') actions.push('remove')
    else if (char === 'n' || char === 'N') actions.push('new')
    else if (char === 's' || char === 'S') actions.push('settings')
    else if (char === 'r' || char === 'R') actions.push('refresh')
    else if (char === 'q' || char === 'Q') actions.push('quit')
    else if (char === ' ') actions.push('activate')
    else if (char === '\u001b') actions.push('back')
  }
  return actions
}

function parseArgs (argv = []) {
  return { color: !argv.includes('--no-color') }
}

/**
 * The dashboard. On a terminal it takes over the screen and reacts to keys; in
 * a pipe it prints one snapshot and returns, so it also reads in scripts.
 */
async function run (argv = []) {
  const flags = parseArgs(argv)
  const stdin = process.stdin
  const stdout = process.stdout

  // A freshly installed machine still has the default freebuff account even
  // before its first launch, so create the record rather than showing 0/0.
  // An older state may list the same freebuff account twice; only one row per
  // account belongs on this screen.
  const duplicates = mutateState((state) => {
    accounts.ensureDefaultAccount(state)
    return accounts.dedupeAccounts(state)
  })

  if (!stdin.isTTY || !stdout.isTTY) {
    const state = loadState()
    const balances = await credits.getAll(state.accounts.filter(accounts.isSignedIn))
    const model = collect({ balances })
    const lines = render(model, { width: 100, height: 40, color: false })
    stdout.write(`${lines.join('\n')}\n`)
    return 0
  }

  return new Promise((resolve) => {
    const color = flags.color && !process.env.NO_COLOR
    let focus = 'sessions'
    let screen = 'main'
    const selected = { sessions: 0, accounts: 0, settings: 0 }
    let balances = new Map()
    let message = duplicates.length > 0
      ? `dropped ${duplicates.join(', ')} — the same account was listed twice`
      : ''
    let closed = false
    let refreshing = false
    // Removing an account is the one action here that cannot be undone, so it
    // takes a second press of the same key.
    let confirmRemove = null
    // A login window opened from here writes the account record and its
    // credentials in its own time, so the view can be stale for a tick or two.
    // Watch the state while it runs and fetch the new account's credits as soon
    // as it shows up, instead of waiting for the minute-long balance timer.
    let loginWatch = null

    const view = () => buildView(collect({ balances, cwd: process.cwd() }), {
      width: stdout.columns || 100,
      height: stdout.rows || 30,
      color,
      focus,
      selected,
      screen,
      message
    })

    const draw = () => {
      if (closed) return
      stdout.write(`\u001b[H${view().lines.join('\n')}\u001b[J`)
    }

    const cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(ticker)
      clearInterval(creditTimer)
      stdin.removeListener('data', onData)
      stdout.removeListener('resize', draw)
      try {
        stdin.setRawMode(false)
      } catch {
        // Ignore.
      }
      stdin.pause()
      // Stop reporting the mouse before leaving the alternate screen.
      stdout.write('\u001b[?1000l\u001b[?1006l\u001b[?25h\u001b[?1049l')
    }

    const finish = (code) => {
      cleanup()
      resolve(code)
    }

    const loadBalances = async () => {
      if (refreshing) return
      refreshing = true
      try {
        const state = loadState()
        balances = await credits.getAll(state.accounts.filter(accounts.isSignedIn))
      } catch {
        balances = new Map()
      } finally {
        refreshing = false
        draw()
      }
    }

    const model = () => collect({ balances, cwd: process.cwd() })

    const accountSignature = (current) => current.accounts
      .map((account) => `${account.id}:${account.signedIn}`)
      .join(',')

    const watchLogin = () => {
      loginWatch = {
        signature: accountSignature(model()),
        until: Date.now() + LOGIN_WATCH_MS
      }
    }

    const chosenAccount = () => {
      const current = model()
      if (focus === 'accounts') return current.accounts[selected.accounts - 1] || null
      // Cursor 0 is the new-session row; the list itself starts at 1.
      const session = current.sessions[selected.sessions - 1]
      if (session) {
        return current.accounts.find((account) => account.id === session.account) || null
      }
      // The new-session row runs on the account the accounts pane points at,
      // or on the first account that can start one.
      const picked = current.accounts[selected.accounts - 1]
      if (picked && picked.signedIn && !picked.authFailed) return picked
      return current.accounts.find(
        (account) => account.signedIn && !account.authFailed
      ) || null
    }

    const toggleVoice = () => {
      const before = voice.settings().enabled
      try {
        voice.setEnabled(!before)
        if (!before) void voice.ensureServer()
        message = before
          ? 'voice calls off — the supervisor will not ring the phone'
          : 'voice calls on — open the call link on the phone to speak'
      } catch (error) {
        message = `could not change voice calls: ${error.message}`
      }
    }

    const addNewAccount = () => {
      const result = addAccount({ cwd: process.cwd() })
      if (result.ok) watchLogin()
      message = result.ok
        ? 'sign-in opened for a new account — it is listed when it finishes'
        : result.reason
    }

    const handle = (action, payload = {}) => {
      const current = model()
      const accountCount = current.accounts.length
      const sessionCount = current.sessions.length

      if (action === 'quit') return finish(0)

      // Any other key withdraws a removal that was waiting for confirmation.
      if (action !== 'remove') confirmRemove = null

      // The settings screen is modal: enter must toggle, never start a session.
      if (screen === 'settings') {
        if (action === 'settings-back' || action === 'back' || action === 'settings') {
          screen = 'main'
          return
        }
        if (action === 'toggle-voice' || action === 'activate' || action === 'start') {
          toggleVoice()
          return
        }
        if (action === 'up' || action === 'down') selected.settings = 0
        return
      }

      if (action === 'settings') {
        screen = 'settings'
        selected.settings = 0
        message = ''
        return
      }
      // A click on a row selects it, exactly like moving the cursor there.
      if (action === 'choose-account') {
        focus = 'accounts'
        if (Number.isInteger(payload.index)) selected.accounts = payload.index
        return
      }
      if (action === 'choose-session') {
        focus = 'sessions'
        if (Number.isInteger(payload.index)) selected.sessions = payload.index
        return
      }
      if (action === 'pane') {
        focus = focus === 'sessions' ? 'accounts' : 'sessions'
        return
      }
      if (action === 'up' || action === 'down') {
        const step = action === 'up' ? -1 : 1
        if (focus === 'accounts') {
          // The add-account row is part of the accounts pane, so the cursor
          // wraps over one more entry than there are accounts.
          const rows = accountCount + 1
          selected.accounts = (selected.accounts + step + rows) % rows
        } else {
          // The new-session row is part of the sessions pane, so the cursor
          // wraps over one more entry than there are sessions.
          const rows = sessionCount + 1
          selected.sessions = (selected.sessions + step + rows) % rows
        }
        return
      }
      if (action === 'refresh') {
        message = 'refreshed'
        return
      }
      if (action === 'start' || action === 'new') {
        // Enter on the add-account row adds an account, the way Enter on the
        // new-session row starts a session.
        if (action === 'start' && focus === 'accounts' && selected.accounts === 0) {
          addNewAccount()
          return
        }
        // Enter on a session row continues that conversation rather than
        // starting another one: the row's own account and folder are reused,
        // and the supervisor types the continue prompt into the resumed chat.
        if (action === 'start' && focus === 'sessions' && selected.sessions > 0) {
          const session = current.sessions[selected.sessions - 1]
          if (!session) {
            message = 'no session selected'
            return
          }
          if (session.alive) {
            message = `${session.account} is still running (pid ${session.pid}) — press x to stop it first`
            return
          }
          const owner = current.accounts.find((item) => item.id === session.account)
          if (!owner) {
            message = `no account ${session.account} for that session`
            return
          }
          const cwd = session.cwd || process.cwd()
          const result = startSession({ account: owner, cwd, resume: true })
          message = result.ok
            ? `continuing ${session.account} in ${shortHome(cwd)}`
            : result.reason
          return
        }
        const account = chosenAccount()
        if (!account) {
          message = 'no signed-in account — press l to sign in'
          return
        }
        if (!account.signedIn || account.authFailed) {
          message = `${account.id} needs sign-in — press l`
          return
        }
        const result = startSession({ account, cwd: process.cwd() })
        message = result.ok
          ? `started ${account.id} in ${shortHome(process.cwd())}`
          : result.reason
        return
      }
      if (action === 'stop') {
        const session = current.sessions[selected.sessions - 1]
        const result = stopSession(session)
        message = result.ok
          ? result.retired
            ? `${session.account}: nothing of that session was running — record cleared`
            : `stop requested for ${session.account} (pid ${session.pid})`
          : result.reason
        return
      }
      if (action === 'login') {
        const account = chosenAccount()
        if (!account) {
          message = 'no account selected'
          return
        }
        const result = loginAccount({ account, cwd: process.cwd() })
        if (result.ok) watchLogin()
        message = result.ok
          ? `sign-in opened for ${account.id}`
          : result.reason
        return
      }
      if (action === 'add') {
        addNewAccount()
        return
      }
      if (action === 'remove') {
        // The account the cursor is on: the accounts pane when it has focus,
        // otherwise the account the selected session runs on.
        const target = (focus === 'accounts' ? current.accounts[selected.accounts - 1] : null) ||
          current.accounts.find((account) => account.id ===
            (current.sessions[selected.sessions - 1] || {}).account) ||
          current.accounts[selected.accounts - 1] ||
          null
        if (!target) {
          message = 'no account selected'
          return
        }
        if (target.shared) {
          message = `${target.id} is this machine's own freebuff config — sign out in freebuff instead`
          return
        }
        if (confirmRemove !== target.id) {
          confirmRemove = target.id
          message = `press d again to remove ${target.id} — its sign-in and chat history are deleted`
          return
        }
        confirmRemove = null
        const result = removeAccount(target.id)
        if (!result.ok) {
          message = result.reason
          return
        }
        message = result.removed
          ? `removed ${target.id} and its container`
          : `removed ${target.id} from the dashboard`
        // The cursor must not stay on a row that is no longer there. Rows
        // are the add-account row plus the accounts, and one just went.
        if (selected.accounts > accountCount - 1) selected.accounts = 0
        if (selected.sessions > sessionCount) selected.sessions = 0
      }
    }

    const onData = (chunk) => {
      const clicks = mouseEvents(chunk)
      if (clicks.length > 0) {
        const layout = view().layout
        for (const event of clicks) {
          if (event.wheel) {
            handle(event.wheel)
            continue
          }
          const hit = hitTest(layout, event.x, event.y)
          if (hit) handle(hit.action, hit)
        }
      }
      // Mouse reports are escape sequences too, and a bare Esc means "back"
      // now. Strip them before reading keys, or every click also looks like
      // Esc and closes the settings screen it just toggled.
      const withoutMouse = String(chunk).replace(/\u001b\[<\d+;\d+;\d+[Mm]/g, '')
      for (const action of keyActions(withoutMouse)) handle(action)
      draw()
    }

    const tick = () => {
      draw()
      if (!loginWatch) return
      if (Date.now() > loginWatch.until) {
        loginWatch = null
        return
      }
      const current = model()
      const signature = accountSignature(current)
      if (signature === loginWatch.signature || refreshing) return
      loginWatch.signature = signature
      // The account list changed, so the new row and its credits are drawn now
      // rather than at the next minute tick.
      void loadBalances()
    }
    const ticker = setInterval(tick, REFRESH_MS)
    const creditTimer = setInterval(loadBalances, CREDITS_MS)

    // 1000h reports button presses, 1006h makes them SGR-encoded (which is
    // what mouseEvents parses). Both are switched off again in cleanup.
    stdout.write('\u001b[?1049h\u001b[?25l\u001b[?1000h\u001b[?1006h\u001b[H\u001b[J')
    try {
      stdin.setRawMode(true)
    } catch {
      // The dashboard still draws; keys may need Enter.
    }
    stdin.resume()
    stdin.on('data', onData)
    stdout.on('resize', draw)

    draw()
    void loadBalances()
  })
}

module.exports = {
  run,
  collect,
  render,
  buildView,
  buildSettingsView,
  hitTest,
  mouseEvents,
  sessionArgs,
  launchPlan,
  startSession,
  loginAccount,
  addAccount,
  removeAccount,
  stopSession,
  keyActions,
  parseArgs,
  MAX_ACCOUNT_ROWS,
  MAX_SESSION_ROWS
}
