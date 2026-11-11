'use strict'

/**
 * GitHub credentials for pushing, kept the same way as the sudo password.
 *
 * Pushing from an unattended supervisor has the same problem as sudo: there is
 * nobody at the keyboard to type a username and a token. This stores a token in
 * the vault file `~/.freebuffs/secrets/github.token` (mode 0600) and points
 * git's `GIT_ASKPASS` at a helper (mode 0700) that answers the prompt with it.
 * The token therefore never reaches the command line, the environment of the
 * pushed process, or the shell history, and `git push` works with no terminal.
 *
 * Unlike the sudo password, the token is not tied to a running supervisor: it
 * stays until `sfreebuff github off`. `sudo.clear()` removes only its own three
 * files, so closing a session does not sign git out.
 */

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { paths, ensureDirs } = require('./paths')
const { logLine, logEvent } = require('./log')
const { safeUnlink } = require('./util')

const TOKEN_NAME = 'github.token'
const ASKPASS_NAME = 'git-askpass.sh'
// GitHub accepts any username for a token; the name only has to be non-empty.
const USERNAME = 'x-access-token'

function secretsDir () {
  return path.join(paths().home, 'secrets')
}

function tokenPath () {
  return path.join(secretsDir(), TOKEN_NAME)
}

function askpassPath () {
  return path.join(secretsDir(), ASKPASS_NAME)
}

function isActive () {
  try {
    return fs.statSync(tokenPath()).isFile()
  } catch {
    return false
  }
}

/** The stored token, or null. Never logged, never printed. */
function read () {
  try {
    const token = fs.readFileSync(tokenPath(), 'utf8').replace(/\r?\n$/, '').trim()
    return token || null
  } catch {
    return null
  }
}

function writeFileSecure (target, contents, mode) {
  fs.writeFileSync(target, contents, { mode })
  fs.chmodSync(target, mode)
}

/**
 * A helper git calls for its credential prompts. The prompt text is the first
 * argument; the username prompt gets the placeholder name, anything else gets
 * the token.
 */
function installAskpass () {
  const script = [
    '#!/bin/sh',
    '# Written by the freebuff supervisor; removed by `sfreebuff github off`.',
    'case "$1" in',
    `  *[Uu]sername*) printf '%s\\n' ${JSON.stringify(USERNAME)}; exit 0 ;;`,
    'esac',
    `exec cat ${JSON.stringify(tokenPath())}`
  ].join('\n') + '\n'
  writeFileSecure(askpassPath(), script, 0o700)
  return askpassPath()
}

/** Store a token in the vault. Returns the file it was written to. */
function store (token) {
  const value = String(token || '').trim()
  if (!value) throw new Error('a GitHub token is required')
  ensureDirs()
  fs.mkdirSync(secretsDir(), { recursive: true, mode: 0o700 })
  fs.chmodSync(secretsDir(), 0o700)
  writeFileSecure(tokenPath(), value, 0o600)
  installAskpass()
  logLine('info', 'github.token.stored', { file: tokenPath() })
  logEvent('github.token.stored', {})
  return tokenPath()
}

/** Forget the token and its helper. Idempotent. */
function clear () {
  const removed = []
  for (const target of [tokenPath(), askpassPath()]) {
    if (safeUnlink(target)) removed.push(target)
  }
  if (removed.length > 0) {
    logLine('info', 'github.token.cleared', {})
    logEvent('github.token.cleared', {})
  }
  return removed
}

/** Environment that lets git answer its own credential prompt. */
function envFor (askpass = askpassPath()) {
  return {
    GIT_ASKPASS: askpass,
    GIT_TERMINAL_PROMPT: '0'
  }
}

/**
 * Push through git with the stored token. Arguments are passed straight to
 * `git push`; with none, the current branch is pushed and set as upstream.
 * Resolves with git's exit code.
 */
function push (args = [], options = {}) {
  if (!read()) {
    throw new Error('no GitHub token stored — run `sfreebuff github --ask` (or `sfreebuff github <token>`) once')
  }
  if (!fs.existsSync(askpassPath())) installAskpass()

  const argv = args.length > 0 ? args : ['-u', 'origin', 'HEAD']
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['push', ...argv], {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...envFor() },
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        logEvent('github.push', { args: argv.join(' ') })
      } else {
        logLine('warn', 'github.push.failed', { reason: code === null ? signal : code })
      }
      resolve(code === null ? 1 : code)
    })
  })
}

module.exports = {
  secretsDir,
  tokenPath,
  askpassPath,
  isActive,
  read,
  installAskpass,
  store,
  clear,
  envFor,
  push
}
