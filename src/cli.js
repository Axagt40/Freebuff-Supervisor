'use strict'

const pkg = require('../package.json')
const { launch } = require('./launch')
const { login } = require('./login')
const { status } = require('./status')
const { showLogs } = require('./logs')
const { install } = require('./install')
const { doctor } = require('./doctor')
const { setup } = require('./setup')
const { notifyCommand } = require('./notify')
const sudo = require('./sudo')
const dashboard = require('./dashboard')
const voice = require('./voice')
const { requestStop } = require('./supervise')

function printHelp () {
  console.log(`sfreebuff ${pkg.version} — freebuff supervisor

Usage:
  sfreebuff                         open the dashboard: every account, its
                                     credits and every session; enter starts
                                     a session for the selected account
  sfreebuff run [freebuff args...]  run freebuff here, and keep it running: a
                                     session that fails is restarted
                                     automatically
  sfreebuff [freebuff args...]      forward args to freebuff (a bare launch
                                     continues this folder's conversation)
  sfreebuff --continue [...]        resume using the account that last ran here
  sfreebuff --account <id>          force an account container for this launch
  sfreebuff --once                  run a single session, then return
  sfreebuff --pty                   force freebuff onto a pseudo-terminal so
                                     known dialogs are answered and a resumed
                                     session can be told to continue
                                     (needs the optional node-pty package)
  sfreebuff --no-pty                do not use a pseudo-terminal. A pty is the
                                     default when node-pty is installed. A
                                     session started after an automatic account
                                     switch still uses one, so the task can be
                                     told to continue
  sfreebuff --no-monitor            launch without the side monitor
                                     (otherwise the monitor opens in its own
                                     window next to the session: a console on
                                     Windows, a terminal on macOS/Linux)
  sfreebuff --no-sudo               do not unlock sudo for this run
  sfreebuff --fresh                 start a conversation of its own instead of
                                     continuing this folder's last chat

  sfreebuff stop                    stop a running supervisor after its session

  sfreebuff setup [--accounts N]    first-run setup: sign in N freebuff accounts
  sfreebuff login [--new]           sign in the next (or a new) account container
  sfreebuff login --account <id>    re-sign an existing container in place
  sfreebuff sudo on|off|status      unlock sudo for sessions, or check the vault
  sfreebuff status                  accounts, credits, live sessions and vault
  sfreebuff dashboard               the same view, named explicitly (tab picks
                                     a pane)
  sfreebuff doctor                  check binary, credentials, monitors and logs
  sfreebuff logs [-f] [-n N]        supervisor log
  sfreebuff install                 put the command on PATH

  sfreebuff notify <webhook-url>    post reports to a Discord webhook
  sfreebuff notify off|test         stop reporting, or send one test report

  sfreebuff voice                   the voice line's settings and phone link
  sfreebuff voice on|off            let freebuff call you for a decision
  sfreebuff voice serve             run the voice line (Tailscale, phone page)
  sfreebuff voice call [text]       ring the phone now
  sfreebuff voice ntfy auto|off     push rings when the page is closed

A supervisor reports to Discord when it starts, when a session ends, when it
stops, and when something needs a person (CRITICAL). A session that fails is
retried with backoff, and the relaunched session is told to continue unfinished
work, including after a switch to another account; Ctrl-C stops it. A plain
launch continues this folder's last conversation, and an idle session is
repeatedly pushed with the last task instead of being left waiting.

Data lives in ~/.freebuffs (accounts/, logs/, run/, state.json).
Accounts are isolated by FREEBUFF_CONFIG_DIR; nothing is listed at launch.
Tasks are typed directly into the freebuff session.`)
}

function sudoCommand (argv = []) {
  const [action] = argv
  if (!action || action === 'status') {
    const state = sudo.status()
    const vault = sudo.isActive()
    console.log(`sudo unlock   ${sudo.enabled() ? 'on' : 'off'}`)
    console.log(`sudo found    ${state.available ? realSudoLabel() : 'not installed'}`)
    console.log(`password file ${vault ? sudo.secretPath() : 'not present (nothing stored)'}`)
    console.log(`helper        ${vault ? sudo.askpassPath() : 'not present'}`)
    return 0
  }

  if (action === 'on') {
    sudo.setEnabled(true)
    console.log('sudo unlock on — the supervisor will ask once and delete the password when it closes.')
    return 0
  }

  if (action === 'off') {
    sudo.setEnabled(false)
    sudo.clear()
    console.log('sudo unlock off — sessions will use sudo without a stored password.')
    return 0
  }

  console.error(`sfreebuff: expected \`sfreebuff sudo on|off|status\``)
  return 1
}

function realSudoLabel () {
  return process.env.FREEBUFFS_SUDO_BIN || '/usr/bin/sudo'
}

async function main (argv) {
  const [command, ...rest] = argv
  let exitCode = 0

  switch (command) {
    case undefined:
      // `sfreebuff` on its own is the view over every account and session;
      // `sfreebuff run` starts one directly in this folder.
      exitCode = await dashboard.run([])
      break
    case 'help':
    case '--help':
    case '-h':
      printHelp()
      break
    case 'version':
    case '--version':
    case '-v':
      console.log(pkg.version)
      break
    case 'setup':
      await setup(rest)
      break
    case 'login':
      await login(rest)
      break
    case 'status':
      await status()
      break
    case 'dashboard':
    case 'dash':
      exitCode = await dashboard.run(rest)
      break
    case 'doctor':
      exitCode = doctor()
      break
    case 'logs':
      showLogs(rest)
      break
    case 'install':
      install()
      break
    case 'notify':
      exitCode = await notifyCommand(rest)
      break
    case 'voice':
      exitCode = await voice.voiceCommand(rest)
      break
    case 'sudo':
      exitCode = sudoCommand(rest)
      break
    case 'stop': {
      const file = requestStop()
      console.log(`stop requested — a running supervisor stops after its current session (${file}).`)
      break
    }
    case 'run':
      exitCode = await launch(rest)
      break
    default:
      // Everything else belongs to freebuff (flags like --continue, --cwd).
      exitCode = await launch(argv)
  }

  process.exitCode = exitCode
  return exitCode
}

module.exports = { main, printHelp, sudoCommand, realSudoLabel }
