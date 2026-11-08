'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

function fromEnv (name) {
  const value = process.env[name]
  return value ? path.resolve(value) : null
}

/**
 * Where freebuff itself keeps its config and downloaded binary. The npm
 * launcher hardcodes this location, so it is also the source we link support
 * files from when creating new account containers.
 */
function defaultConfigDir () {
  return (
    fromEnv('FREEBUFFS_DEFAULT_CONFIG_DIR') ||
    path.join(os.homedir(), '.config', 'manicode')
  )
}

/** All supervisor data lives here; overridable for tests. */
function freebuffsHome () {
  return fromEnv('FREEBUFFS_HOME') || path.join(os.homedir(), '.freebuffs')
}

function paths () {
  const home = freebuffsHome()
  return {
    home,
    accountsDir: path.join(home, 'accounts'),
    logsDir: path.join(home, 'logs'),
    runDir: path.join(home, 'run'),
    statePath: path.join(home, 'state.json'),
    stateLockPath: path.join(home, 'state.lock'),
    supervisorLog: path.join(home, 'logs', 'supervisor.log'),
    supervisorJsonl: path.join(home, 'logs', 'supervisor.jsonl')
  }
}

function ensureDirs () {
  const p = paths()
  for (const dir of [p.home, p.accountsDir, p.logsDir, p.runDir]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

module.exports = { defaultConfigDir, freebuffsHome, paths, ensureDirs }
