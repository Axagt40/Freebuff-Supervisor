'use strict'

/**
 * Low-CPU mode for a small machine.
 *
 * Two freebuff sessions at once can keep every core busy on a potato PC, and
 * once the desktop itself has no time to run, the machine looks crashed. The
 * supervisor cannot make freebuff cheaper, but it can stop its sessions from
 * outranking everything else: with this on, every supervised freebuff starts at
 * a lower scheduling priority (nice 10) and everything it runs inherits it, so
 * the desktop and the supervisor still get a slice and the machine stays
 * usable.
 *
 * Off by default. The switch lives in ~/.freebuffs/config.json as
 * `optimize: true`; turning it off removes the key rather than writing false.
 */

const os = require('os')
const { readConfig, updateConfig } = require('./config')
const { logLine } = require('./log')

/** Nice value given to supervised sessions; 0 is the kernel default. */
const LOW_PRIORITY = 10

function enabled () {
  return readConfig().optimize === true
}

/** Store the switch. Returns its new value. */
function setEnabled (value) {
  const on = Boolean(value)
  updateConfig('optimize', on ? true : undefined)
  logLine('info', on ? 'optimize.on' : 'optimize.off', { nice: on ? LOW_PRIORITY : 0 })
  return on
}

/**
 * Lower one spawned process's priority. Children inherit the nice value, which
 * is where the CPU actually goes.
 *
 * Lowering priority (a positive nice value) never needs root; raising it would.
 * Windows has no equivalent and os.setPriority throws there, which is ignored:
 * the switch must stay harmless on every platform.
 */
function apply (pid) {
  if (!enabled()) return false
  if (!Number.isInteger(pid) || pid <= 1) return false
  if (typeof os.setPriority !== 'function') return false
  try {
    os.setPriority(pid, LOW_PRIORITY)
    return true
  } catch {
    return false
  }
}

module.exports = { LOW_PRIORITY, enabled, setEnabled, apply }
