'use strict'

/**
 * Handing a conversation over to another account.
 *
 * Account containers have separate config dirs, so `--continue` in the new
 * account cannot see the conversation the previous one was working in. On a
 * pty the supervisor types the task into the new session; without one there is
 * no way to type anything, so the conversation itself is moved instead.
 *
 * freebuff keeps one chat per project directory:
 *
 *   <config>/projects/<basename(cwd)>/chats/<chatId>/
 *     chat-messages.json, run-state.json, chat-meta.json, log.jsonl
 *
 * `--continue <chatId>` resumes exactly that directory (it resolves the id
 * inside the current account's project dir), so copying the previous account's
 * latest chat into the new account under a fresh id makes a plain launch carry
 * the task on with its history intact.
 */

const fs = require('fs')
const path = require('path')

const MESSAGES_FILE = 'chat-messages.json'
/**
 * The files a chat rewrites while it is being used. A directory's own time is
 * when it was created, so a chat resumed from history keeps an old directory
 * time while it is the one actually being worked in.
 */
const ACTIVITY_FILES = ['chat-messages.json', 'log.jsonl', 'run-state.json', 'chat-meta.json']

function projectChatsDir (configDir, cwd) {
  return path.join(configDir, 'projects', path.basename(cwd), 'chats')
}

function isDirectory (target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

function readEntries (dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** The newest chat in one chats directory, or null when it holds none. */
function newestChatIn (root) {
  let newest = null
  for (const id of readEntries(root)) {
    const dir = path.join(root, id)
    try {
      const stats = fs.statSync(dir)
      if (!stats.isDirectory()) continue
      if (!fs.existsSync(path.join(dir, MESSAGES_FILE))) continue
      // The chat's own last write, not the directory's creation time: resuming
      // an older conversation makes it the newest one without recreating it.
      let updatedAt = 0
      for (const name of ACTIVITY_FILES) {
        try {
          updatedAt = Math.max(updatedAt, fs.statSync(path.join(dir, name)).mtimeMs)
        } catch {
          // A chat that has not written this file yet.
        }
      }
      if (!updatedAt) updatedAt = stats.mtimeMs
      if (!newest || updatedAt > newest.mtimeMs) {
        newest = { id, dir, mtimeMs: updatedAt }
      }
    } catch {
      // A chat that cannot be read is simply not a candidate.
    }
  }
  return newest
}

/** Does any chat of this project record the folder it ran in? */
function chatsNameCwd (projectDir, cwd) {
  if (!cwd) return false
  const chatsDir = path.join(projectDir, 'chats')
  for (const chat of readEntries(chatsDir)) {
    for (const name of ['chat-meta.json', 'run-state.json']) {
      try {
        if (fs.readFileSync(path.join(chatsDir, chat, name), 'utf8').includes(cwd)) return true
      } catch {
        // A chat without that file cannot name anything.
      }
    }
  }
  return false
}

/**
 * The chats directories freebuff may keep this folder's conversations in.
 *
 * freebuff usually keys a project by the folder's base name, but it can key it
 * by the whole path or a sanitised version of it (the same fallback work.js and
 * supervise.js make). Looking only at `projects/<basename>` resumed a chat from
 * an unrelated folder that happened to share the name, and `--continue <id>`
 * for a chat freebuff cannot resolve in this folder is answered with its
 * project picker — the folder list an unattended session can never leave. A
 * project whose own chats name this folder wins; the base name is the fallback.
 */
function chatDirsFor (configDir, cwd) {
  if (!configDir || !cwd) return []
  const projectsDir = path.join(configDir, 'projects')
  const named = readEntries(projectsDir)
    .filter((entry) => chatsNameCwd(path.join(projectsDir, entry), cwd))
    .map((entry) => path.join(projectsDir, entry, 'chats'))
  if (named.length > 0) return named
  const base = path.basename(cwd)
  return base ? [path.join(projectsDir, base, 'chats')] : []
}

/**
 * The chat freebuff itself would continue for this project: the one written
 * most recently. Chats without messages are skipped, matching what freebuff's
 * own history list shows.
 */
function latestChat (configDir, cwd) {
  if (!configDir || !cwd) return null
  let newest = null
  for (const root of chatDirsFor(configDir, cwd)) {
    const chat = newestChatIn(root)
    if (chat && (!newest || chat.mtimeMs > newest.mtimeMs)) newest = chat
  }
  return newest
}

/** The id shape freebuff writes: an ISO timestamp with colons made safe. */
function newChatId (now = Date.now()) {
  return new Date(now).toISOString().replace(/:/g, '-')
}

/** Never overwrite an existing chat in the destination account. */
function freshChatId (root, now) {
  const base = newChatId(now)
  let id = base
  let counter = 1
  while (fs.existsSync(path.join(root, id))) {
    id = `${base}-${counter}`
    counter += 1
  }
  return id
}

/**
 * Copy the previous account's conversation for `cwd` into another account.
 * Returns `{ id, from, to }`, or null when there is nothing to hand over (same
 * account, no chat, or an unreadable destination).
 */
function copyConversation ({ fromConfigDir, toConfigDir, cwd, now } = {}) {
  if (!fromConfigDir || !toConfigDir || !cwd) return null
  if (path.resolve(fromConfigDir) === path.resolve(toConfigDir)) return null

  const source = latestChat(fromConfigDir, cwd)
  if (!source) return null

  const root = projectChatsDir(toConfigDir, cwd)
  try {
    fs.mkdirSync(root, { recursive: true })
    const id = freshChatId(root, now)
    const destination = path.join(root, id)
    fs.cpSync(source.dir, destination, { recursive: true, errorOnExist: false })
    return { id, from: source.dir, to: destination }
  } catch {
    return null
  }
}

/**
 * `--continue <chatId>`, replacing any `--continue` flag already present so a
 * relaunch points at the handed-over chat instead of an unrelated one.
 */
function continueWithChat (args, chatId) {
  const list = Array.isArray(args) ? args : []
  const kept = []

  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index]
    if (arg === '--continue') {
      // Its optional value belongs to the flag, so it goes with it.
      const next = list[index + 1]
      if (next !== undefined && !String(next).startsWith('-')) index += 1
      continue
    }
    if (arg.startsWith('--continue=')) continue
    kept.push(arg)
  }

  return ['--continue', chatId, ...kept]
}

module.exports = {
  MESSAGES_FILE,
  ACTIVITY_FILES,
  projectChatsDir,
  chatsNameCwd,
  chatDirsFor,
  latestChat,
  newChatId,
  copyConversation,
  continueWithChat
}
