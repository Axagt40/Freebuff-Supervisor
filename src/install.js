'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { logLine } = require('./log')

const COMMAND = 'sfreebuff'

/**
 * Launchers an earlier version installed under the old command name. They
 * point at bin/freebuffs.js, so they cannot start a session any more; leaving
 * them behind would just shadow the terminal with a stale `freebuffs`.
 */
function removeLegacyLaunchers (binDir) {
  const removed = []
  const candidates = [
    path.join(binDir, 'freebuffs'),
    path.join(binDir, 'freebuffs.cmd')
  ]

  for (const target of candidates) {
    let stats
    try {
      stats = fs.lstatSync(target)
    } catch {
      continue
    }
    try {
      // A symlink is ours by construction; a .cmd file is only ours when it
      // still points at this project's entry point.
      const ours = stats.isSymbolicLink() ||
        fs.readFileSync(target, 'utf8').includes(`bin${path.sep}freebuffs.js`)
      if (!ours) continue
      fs.unlinkSync(target)
      removed.push(target)
    } catch {
      // A launcher that cannot be inspected or removed is not worth failing on.
    }
  }
  return removed
}

/** Put a launcher on PATH so `sfreebuff` works from any project folder. */
function install () {
  const entry = path.resolve(__dirname, '..', 'bin', `${COMMAND}.js`)
  const binDir = path.join(os.homedir(), '.local', 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  fs.chmodSync(entry, 0o755)

  let target
  if (process.platform === 'win32') {
    target = path.join(binDir, `${COMMAND}.cmd`)
    fs.writeFileSync(target, `@echo off\r\nnode "${entry}" %*\r\n`)
  } else {
    target = path.join(binDir, COMMAND)
    try {
      fs.unlinkSync(target)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    fs.symlinkSync(entry, target)
  }

  const onPath = (process.env.PATH || '')
    .split(path.delimiter)
    .includes(binDir)

  console.log(`installed ${target}`)
  for (const legacy of removeLegacyLaunchers(binDir)) {
    console.log(`removed old launcher ${legacy}`)
  }
  if (onPath) {
    console.log(`\`${COMMAND}\` is on PATH.`)
  } else {
    console.log(`add it to PATH: export PATH="${binDir}:$PATH"`)
  }
  logLine('info', 'install', { target })
  return target
}

module.exports = { install }
