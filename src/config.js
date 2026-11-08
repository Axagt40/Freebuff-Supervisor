'use strict'

/**
 * The supervisor's own settings file, ~/.freebuffs/config.json.
 *
 * It holds things that are not credentials but are still private: the Discord
 * webhook, and whether sudo should be unlocked for a run. Mode 0600, written
 * atomically, and never printed.
 */

const fs = require('fs')
const path = require('path')
const { paths, ensureDirs } = require('./paths')

function configPath () {
  return path.join(paths().home, 'config.json')
}

function readConfig () {
  try {
    const data = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

function writeConfig (config) {
  ensureDirs()
  const target = configPath()
  const temp = `${target}.tmp-${process.pid}`
  fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, target)
}

/** Read one key, then set or delete it, in a single write. */
function updateConfig (key, value) {
  const config = readConfig()
  if (value === undefined || value === null) delete config[key]
  else config[key] = value
  writeConfig(config)
  return config
}

module.exports = { configPath, readConfig, writeConfig, updateConfig }
