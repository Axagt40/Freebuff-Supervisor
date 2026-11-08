'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const BIN = path.join(ROOT, 'bin', 'sfreebuff.js')

function tempRoot () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'freebuffs-test-'))
}

/**
 * Remove a scratch tree, patiently.
 *
 * A detached monitor keeps writing its heartbeat into the world's home until
 * it notices the stub freebuff is gone, and on a busy machine that takes a
 * while — long enough for a recursive remove to hit ENOTEMPTY. Retrying covers
 * the common case; the last resort is to leave the directory in the OS temp dir
 * rather than fail a test that already proved what it needed to.
 */
function removeTree (target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 60, retryDelay: 100 })
  } catch {
    // Deliberately ignored: scratch space in the temp dir.
  }
}

function writeCredentials (configDir, options = {}) {
  fs.mkdirSync(configDir, { recursive: true })
  const entry = {
    id: 'stub-user',
    name: 'Stub User',
    email: 'stub@example.com'
  }
  if (options.authToken) entry.authToken = options.authToken
  else entry.tokenStore = { accessToken: 'stub-token' }

  fs.writeFileSync(
    path.join(configDir, 'credentials.json'),
    JSON.stringify({ default: entry })
  )
}

/** Minimal unsigned JWT carrying only an expiry, for expiry tests. */
function makeJwt (expSeconds) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ exp: expSeconds })}.stub`
}

function writeStubBinary (dir) {
  const file = path.join(dir, 'stub-freebuff')
  const source = `#!/usr/bin/env node
'use strict'
const fs = require('fs')
const path = require('path')
const configDir = process.env.FREEBUFF_CONFIG_DIR
const out = process.env.STUB_OUT
fs.mkdirSync(configDir, { recursive: true })

if (process.argv[2] === 'login') {
  // Each container is its own freebuff account unless a test names the
  // identity the sign-in returned, so duplicate detection has something
  // faithful to compare.
  const id = process.env.STUB_ACCOUNT_ID || configDir
  fs.writeFileSync(
    path.join(configDir, 'credentials.json'),
    JSON.stringify({ default: { id, name: 'Stub', email: 's@example.com', tokenStore: { accessToken: 't' } } })
  )
  process.exit(0)
}

if (process.env.STUB_STDERR) process.stderr.write(process.env.STUB_STDERR)

fs.mkdirSync(out, { recursive: true })
fs.appendFileSync(
  path.join(out, 'invocations.jsonl'),
  JSON.stringify({
    argv: process.argv.slice(2),
    configDir,
    cwd: process.cwd(),
    home: process.env.HOME
  }) + '\\n'
)
fs.writeFileSync(
  path.join(configDir, 'freebuff-live-' + process.pid + '.json'),
  JSON.stringify({ ownerPid: process.pid, instanceId: 'stub' })
)
setTimeout(
  () => {
    if (process.env.STUB_DELETE_CREDENTIALS === '1') {
      fs.rmSync(path.join(configDir, 'credentials.json'), { force: true })
    }
    process.exit(Number(process.env.STUB_EXIT_CODE || 0))
  },
  Number(process.env.STUB_DELAY_MS || 600)
)
`
  fs.writeFileSync(file, source)
  fs.chmodSync(file, 0o755)
  return file
}

/**
 * Isolated world: its own supervisor home, its own default freebuff config dir
 * and a stub binary, so tests never touch the real account or terminal.
 */
function makeWorld (options = {}) {
  const root = tempRoot()
  const home = path.join(root, 'supervisor')
  const defaultConfig = path.join(root, 'default-config')
  const out = path.join(root, 'out')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(out, { recursive: true })
  if (options.signedIn !== false) {
    writeCredentials(defaultConfig, options.credentials)
  }

  const bin = writeStubBinary(root)
  const env = {
    ...process.env,
    FREEBUFFS_HOME: home,
    FREEBUFFS_DEFAULT_CONFIG_DIR: defaultConfig,
    FREEBUFFS_BINARY: bin,
    FREEBUFFS_MONITOR_INTERVAL_MS: '100',
    // Tests must never open a real supervisor window.
    FREEBUFFS_MONITOR_WINDOW: '0',
    // One session per run unless a test opts into the 24/7 loop, so a stub
    // that exits non-zero cannot restart itself forever.
    FREEBUFFS_FOREVER: '0',
    // Never touch the real sudo vault or ask for a password.
    FREEBUFFS_SUDO: '0',
    FREEBUFFS_PTY: '0',
    STUB_OUT: out,
    STUB_DELAY_MS: options.delay || '400',
    ...(options.env || {})
  }

  return {
    root,
    home,
    defaultConfig,
    out,
    env,
    run (args, extraEnv = {}) {
      return spawnSync(process.execPath, [BIN, ...args], {
        env: { ...env, ...extraEnv },
        encoding: 'utf8',
        timeout: 20000
      })
    },
    /** Same as run(), but without blocking this process's event loop. */
    runAsync (args, extraEnv = {}) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN, ...args], {
          env: { ...env, ...extraEnv }
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => { stdout += chunk })
        child.stderr.on('data', (chunk) => { stderr += chunk })
        child.on('close', (status) => resolve({ status, stdout, stderr }))
      })
    },
    cleanup () {
      removeTree(root)
    },
    state () {
      return JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'))
    },
    invocations () {
      try {
        return fs.readFileSync(path.join(out, 'invocations.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      } catch {
        return []
      }
    },
    events () {
      try {
        return fs.readFileSync(path.join(home, 'logs', 'supervisor.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      } catch {
        return []
      }
    },
    log () {
      try {
        return fs.readFileSync(path.join(home, 'logs', 'supervisor.log'), 'utf8')
      } catch {
        return ''
      }
    }
  }
}

/**
 * A live process whose command line is a supervisor script.
 *
 * A session counts as live only while its recorded pid is still the program it
 * was recorded for, so a test that needs a running session cannot point the
 * record at itself: this starts a node process named `sfreebuff.js` and waits
 * until its command line is readable.
 */
async function fakeSupervisorPid () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuffs-fake-sup-'))
  const script = path.join(dir, 'sfreebuff.js')
  fs.writeFileSync(script, 'setTimeout(() => {}, 120000)\n')
  const child = spawn(process.execPath, [script], { stdio: 'ignore' })
  child.unref()
  const { processMatches, SUPERVISOR_COMMAND } = require('../src/util')
  const ready = await waitFor(() => processMatches(child.pid, SUPERVISOR_COMMAND), 3000)
  if (!ready) {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
  return {
    pid: child.pid,
    stop () {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      removeTree(dir)
    }
  }
}

async function waitFor (predicate, timeoutMs = 6000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return false
}

module.exports = { makeWorld, waitFor, writeCredentials, makeJwt, removeTree, fakeSupervisorPid }
