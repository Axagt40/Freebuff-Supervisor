'use strict'

const fs = require('fs')
const pathsModule = require('./paths')

const { paths, ensureDirs } = pathsModule

function stamp () {
  return new Date().toISOString()
}

function describe (extra) {
  if (!extra) return ''
  const parts = []
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null || value === '') continue
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    parts.push(`${key}=${text}`)
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}

/** Human-readable supervisor log, one line per event. */
function logLine (level, message, extra) {
  const line = `${stamp()} ${level.toUpperCase().padEnd(5)} ${message}${describe(extra)}\n`
  try {
    ensureDirs()
    fs.appendFileSync(paths().supervisorLog, line)
  } catch {
    // Logging must never take the session down.
  }
  return line
}

/** Machine-readable event stream, appended as JSONL. */
function logEvent (name, data) {
  try {
    ensureDirs()
    fs.appendFileSync(
      paths().supervisorJsonl,
      `${JSON.stringify({ ts: stamp(), event: name, ...(data || {}) })}\n`
    )
  } catch {
    // Ignore.
  }
}

module.exports = { logLine, logEvent }
