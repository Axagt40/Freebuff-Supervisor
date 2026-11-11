'use strict'

const fs = require('fs')
const path = require('path')

/**
 * Terminal emulators the supervisor can open its own window in, most likely
 * first. `style` is how each one expects a command to follow it:
 *
 *   'dash-dash' -> `-- cmd args`      'dash-e' -> `-e cmd args`
 *   'dash-x'    -> `-x cmd args`      'plain'  -> `cmd args`
 *   'wezterm'   -> `start -- cmd args`
 */
const LINUX_TERMINALS = [
  { command: 'x-terminal-emulator', style: 'dash-e' },
  { command: 'gnome-terminal', style: 'dash-dash' },
  { command: 'konsole', style: 'dash-e' },
  { command: 'xfce4-terminal', style: 'dash-x' },
  { command: 'mate-terminal', style: 'dash-x' },
  { command: 'tilix', style: 'dash-e' },
  // kitty keeps the OS window after its child exits unless told otherwise.
  { command: 'kitty', style: 'plain', extraArgs: ['-o', 'close_on_child_death=yes'] },
  { command: 'foot', style: 'plain' },
  { command: 'alacritty', style: 'dash-e' },
  { command: 'wezterm', style: 'wezterm' },
  { command: 'xterm', style: 'dash-e' }
]

function isExecutable (file) {
  try {
    if (!fs.statSync(file).isFile()) return false
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** `which` without spawning a shell; an absolute path is used as given. */
function which (command, env = process.env) {
  const wanted = String(command || '').trim()
  if (!wanted) return null
  if (wanted.includes('/')) return isExecutable(wanted) ? wanted : null

  const dirs = String((env && env.PATH) || '')
    .split(path.delimiter)
    .filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, wanted)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

/**
 * The emulator to launch the supervisor window in. `TERMINAL` wins when it
 * names something we can find, because that is the terminal the user actually
 * runs; otherwise the first known emulator on PATH is used.
 */
function styleFor (resolved, name) {
  // `x-terminal-emulator` is an alternatives symlink. On Debian and Ubuntu
  // with XFCE it points at xfce4-terminal, which wants `-x`, while the generic
  // name is listed as `-e`; the wrong form makes the window fail to open. The
  // program behind the name decides, not the name it was called by.
  let real = resolved
  try {
    real = fs.realpathSync(resolved)
  } catch {
    // A broken link still gets the name-based guess below.
  }
  const byProgram = LINUX_TERMINALS.find(
    (entry) => entry.command === path.basename(real)
  )
  if (byProgram) {
    return { command: resolved, style: byProgram.style, extraArgs: byProgram.extraArgs }
  }
  const byName = LINUX_TERMINALS.find(
    (entry) => entry.command === path.basename(String(name || ''))
  )
  if (byName) {
    return { command: resolved, style: byName.style, extraArgs: byName.extraArgs }
  }
  // An emulator we do not know: `-e` is the commonest convention.
  return { command: resolved, style: 'dash-e' }
}

function findTerminal (env = process.env) {
  const preferred = String((env && env.TERMINAL) || '').trim()
  if (preferred) {
    const resolved = which(preferred, env)
    if (resolved) return styleFor(resolved, preferred)
  }

  for (const entry of LINUX_TERMINALS) {
    const resolved = which(entry.command, env)
    if (resolved) return styleFor(resolved, entry.command)
  }
  return null
}

/** Wrap the command in the separator this emulator expects. */
function argsForStyle (style, extraArgs, command, args) {
  const extra = extraArgs || []
  switch (style) {
    case 'plain':
      return [...extra, command, ...args]
    case 'wezterm':
      return [...extra, 'start', '--', command, ...args]
    case 'dash-x':
      return [...extra, '-x', command, ...args]
    case 'dash-dash':
      return [...extra, '--', command, ...args]
    case 'dash-e':
    default:
      return [...extra, '-e', command, ...args]
  }
}

/** One POSIX single-quoted argument for the shell Terminal.app will run. */
function shellQuote (value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

function shellCommand (command, args) {
  return [command, ...args].map(shellQuote).join(' ')
}

function appleScriptString (text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Can this machine show a window at all? Headless Linux (SSH, a bare TTY, a
 * container) has the emulator binaries but no display, and a window that never
 * opens would take the monitor down with it.
 */
function hasDisplay (env = process.env) {
  return Boolean(env && (env.DISPLAY || env.WAYLAND_DISPLAY))
}

/**
 * Command that opens `command args` in a new terminal window, or null when this
 * machine cannot show one. Windows uses `cmd start` and is handled by launch.js.
 */
function windowCommand ({ platform, command, args, env = process.env }) {
  if (platform === 'darwin') {
    const osascript = which('osascript', env) ||
      (isExecutable('/usr/bin/osascript') ? '/usr/bin/osascript' : null)
    if (!osascript) return null
    // The trailing `exit` makes Terminal.app close the window when the monitor
    // stops instead of dropping back to a shell prompt.
    const script = `tell application "Terminal" to do script ${
      appleScriptString(`${shellCommand(command, args)}; exit`)
    }`
    return { command: osascript, args: ['-e', script] }
  }

  if (platform !== 'linux' || !hasDisplay(env)) return null

  const terminal = findTerminal(env)
  if (!terminal) return null
  return {
    command: terminal.command,
    args: argsForStyle(terminal.style, terminal.extraArgs, command, args)
  }
}

module.exports = {
  LINUX_TERMINALS,
  which,
  findTerminal,
  styleFor,
  argsForStyle,
  shellQuote,
  hasDisplay,
  windowCommand
}
