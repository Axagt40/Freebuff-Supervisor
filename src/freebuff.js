'use strict'

const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { defaultConfigDir } = require('./paths')
const optimize = require('./optimize')

function binaryName () {
  return process.platform === 'win32' ? 'freebuff.exe' : 'freebuff'
}

/** Path of the downloaded freebuff binary (the npm wrapper's install target). */
function binaryPath () {
  const override = process.env.FREEBUFFS_BINARY
  if (override) return path.resolve(override)
  return path.join(defaultConfigDir(), binaryName())
}

/**
 * Find the binary, letting the npm wrapper download it on a fresh machine.
 * The 137 MB download lives in the default config dir and is shared by every
 * account container, so this happens at most once.
 */
function resolveBinary () {
  const candidate = binaryPath()
  if (fs.existsSync(candidate)) return candidate

  if (process.env.FREEBUFFS_BINARY) {
    throw new Error(`FREEBUFFS_BINARY does not exist: ${candidate}`)
  }

  const command = process.platform === 'win32' ? 'freebuff.cmd' : 'freebuff'
  const result = spawnSync(command, ['--version'], { stdio: 'inherit' })
  if (fs.existsSync(candidate)) return candidate

  const detail = result.error ? ` (${result.error.message})` : ''
  throw new Error(
    `freebuff binary not found at ${candidate}${detail}. ` +
    'Install it with `npm install -g freebuff` and run `freebuff --version` once.'
  )
}

/**
 * Each account is isolated by FREEBUFF_CONFIG_DIR. Support files are pulled
 * from that account's dir when present, otherwise from the default config dir,
 * so a container never needs its own copy of rg or the tree-sitter wasm.
 */
function environmentFor (account) {
  const configDir = account.configDir
  const env = { ...process.env, FREEBUFF_CONFIG_DIR: configDir }

  if (!env.CODEBUFF_RG_PATH) {
    for (const dir of [configDir, defaultConfigDir()]) {
      const candidate = path.join(dir, 'rg')
      if (fs.existsSync(candidate)) {
        env.CODEBUFF_RG_PATH = candidate
        break
      }
    }
  }

  if (!env.CODEBUFF_WASM_DIR) {
    for (const dir of [defaultConfigDir(), configDir]) {
      if (fs.existsSync(path.join(dir, 'tree-sitter.wasm'))) {
        env.CODEBUFF_WASM_DIR = dir
        break
      }
    }
  }

  // When the supervisor unlocked sudo for this run, put its `sudo` shim first
  // on PATH so a command freebuff runs with piped stdio can answer for itself.
  const shim = env.FREEBUFFS_SUDO_SHIM
  if (shim && fs.existsSync(path.join(shim, 'sudo'))) {
    env.PATH = `${shim}${path.delimiter}${env.PATH || ''}`
    env.SUDO_ASKPASS = env.SUDO_ASKPASS || path.join(path.dirname(shim), 'sudo-askpass.sh')
  }

  return env
}

/**
 * stdout and stdin stay inherited so the TUI keeps a real terminal. stderr can
 * optionally be teed for diagnostics (the official launcher does the same on
 * Windows); bytes are forwarded unchanged so nothing about rendering changes.
 */
function spawnFreebuff ({ binary, account, args, cwd, onStderr }) {
  const child = spawn(binary, args, {
    cwd: cwd || process.cwd(),
    env: environmentFor(account),
    stdio: onStderr ? ['inherit', 'inherit', 'pipe'] : 'inherit'
  })
  // Low-CPU mode: the TUI and everything it runs start below normal priority.
  optimize.apply(child.pid)

  if (onStderr && child.stderr) {
    child.stderr.on('data', (chunk) => {
      try {
        process.stderr.write(chunk)
      } catch {
        // stderr may be closed
      }
      try {
        onStderr(chunk)
      } catch {
        // Diagnostics must never break the session.
      }
    })
  }

  return child
}

/**
 * Wait for a TUI child while staying alive long enough to record the session.
 * Ctrl-C reaches the child through the terminal's process group; the launcher
 * only needs to avoid exiting first and to forward explicit kills.
 */
function waitForExit (child) {
  return new Promise((resolve, reject) => {
    const SIGINT_NOOP = () => {}
    const forward = (signal) => {
      try {
        child.kill(signal)
      } catch {
        // The child may already be gone.
      }
    }

    process.on('SIGINT', SIGINT_NOOP)
    process.on('SIGTERM', forward)
    process.on('SIGHUP', forward)

    const cleanup = () => {
      process.removeListener('SIGINT', SIGINT_NOOP)
      process.removeListener('SIGTERM', forward)
      process.removeListener('SIGHUP', forward)
    }

    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('exit', (code, signal) => {
      cleanup()
      resolve({ code, signal })
    })
  })
}

/** Put the terminal back in a usable state if a TUI left it in raw modes. */
function resetTerminal () {
  if (!process.stdout.isTTY) return
  try {
    process.stdout.write(
      '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l' +
      '\x1b[?2004l\x1b[<u\x1b[>4;0m\x1b[?25h'
    )
  } catch {
    // Ignore.
  }
}

module.exports = {
  binaryPath,
  resolveBinary,
  environmentFor,
  spawnFreebuff,
  waitForExit,
  resetTerminal
}
