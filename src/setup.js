'use strict'

const readline = require('readline')
const { ensureDirs } = require('./paths')
const { loadState, mutateState } = require('./state')
const accounts = require('./accounts')
const { login } = require('./login')

const MIN_ACCOUNTS = 1
const MAX_ACCOUNTS = 10

function parseSetupFlags (argv) {
  let requested = null
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--accounts' || arg === '-a') {
      requested = argv[index + 1] ?? null
      index += 1
      continue
    }
    if (arg.startsWith('--accounts=')) {
      requested = arg.slice('--accounts='.length)
    }
  }
  return { accounts: requested }
}

function ask (question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

function clamp (value) {
  return Math.min(MAX_ACCOUNTS, Math.max(MIN_ACCOUNTS, Math.floor(value)))
}

/**
 * First-run setup: sign in as many accounts as the user wants, one after the
 * other, using freebuff's normal sign-in. Non-interactive runs (pipes, CI)
 * simply ensure one account exists.
 */
async function setup (argv = {}) {
  const options = Array.isArray(argv) ? parseSetupFlags(argv) : argv || {}
  ensureDirs()
  mutateState((state) => accounts.ensureDefaultAccount(state))

  const before = loadState().accounts.filter(accounts.isSignedIn).length
  let target = options.accounts

  if (target === null || target === undefined) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const fallback = Math.max(MIN_ACCOUNTS, before)
      const answer = await ask(
        `How many freebuff accounts should be signed in? [${fallback}] `
      )
      const parsed = Number(answer)
      target = Number.isFinite(parsed) ? parsed : fallback
    } else {
      target = Math.max(MIN_ACCOUNTS, before)
    }
  }

  target = Number(target)
  if (!Number.isFinite(target)) {
    throw new Error('--accounts expects a number')
  }
  target = clamp(target)

  const need = Math.max(0, target - before)
  if (need === 0) {
    console.log(`Setup complete — ${before} account(s) ready.`)
    return { signedIn: before, added: 0 }
  }

  console.log(`Signing in ${need} account(s) with freebuff's normal sign-in.`)
  for (let index = 0; index < need; index += 1) {
    await login({})
  }

  const after = loadState().accounts.filter(accounts.isSignedIn).length
  if (after === 0) {
    throw new Error('setup finished without a signed-in account')
  }

  console.log(`Setup complete — ${after} account(s) ready.`)
  return { signedIn: after, added: Math.min(need, after) }
}

module.exports = { setup, parseSetupFlags }
