'use strict'

/**
 * What the tailnet looks like from this machine.
 *
 * The phone reaches the voice line over Tailscale, so two things decide whether
 * the call link can load at all: this machine's tailnet address, and whether the
 * node is connected. A grey dot in the iPhone app means the node is offline —
 * tailscaled is not running, the key expired, or the machine is off or asleep.
 * None of that is visible from the page, so it is read here and reported with
 * the command that fixes it.
 *
 * Everything is best effort: the answers come from the CLI when `tailscale` is
 * installed and from the interface list when it is not. A failure returns an
 * empty view instead of throwing, because a missing Tailscale must never keep
 * the voice line down.
 */

const os = require('os')
const { spawnSync } = require('child_process')

/** Tailscale hands out addresses from 100.64.0.0/10 (CGNAT). */
const TAILNET_RANGE = /^100\.(?:6[4-9]|[7-9]\d|[1][01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/
const CLI_TIMEOUT_MS = 2500
const CACHE_MS = 15 * 1000

let cache = { key: '', at: 0, value: null }

function cliPath () {
  return String(process.env.FREEBUFFS_TAILSCALE_BIN || 'tailscale')
}

/**
 * `FREEBUFFS_VOICE_TAILNET_IP` forces the address (or turns discovery off with
 * `off`). It is the escape hatch for a machine whose Tailscale CLI is missing
 * or behind a different binary name, and what the tests use.
 */
function forcedAddress () {
  const value = String(process.env.FREEBUFFS_VOICE_TAILNET_IP || '').trim()
  if (!value) return undefined
  if (/^(?:off|0|no|false|none)$/i.test(value)) return null
  return value
}

function run (args) {
  const result = spawnSync(cliPath(), args, {
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    env: process.env,
    stdio: ['ignore', 'pipe', 'ignore']
  })
  return {
    ok: !result.error && result.status === 0,
    missing: Boolean(result.error && result.error.code === 'ENOENT'),
    stdout: String(result.stdout || '').trim()
  }
}

function empty (extra = {}) {
  return {
    installed: false,
    disabled: false,
    backendState: '',
    online: null,
    ip: '',
    dnsName: '',
    magicDnsSuffix: '',
    https: null,
    keyExpired: null,
    version: '',
    ...extra
  }
}

/** The tailnet address from the interfaces, for a machine without the CLI. */
function interfaceAddress () {
  let nets = {}
  try {
    nets = os.networkInterfaces()
  } catch {
    return ''
  }
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      const family = net && (net.family === 'IPv4' || net.family === 4)
      if (family && !net.internal && TAILNET_RANGE.test(net.address)) return net.address
    }
  }
  return ''
}

function parseStatus (text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const self = data.Self && typeof data.Self === 'object' ? data.Self : {}
  const addresses = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : []
  const ip = addresses
    .map((item) => String(item))
    .find((item) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(item)) || ''
  const dnsName = String(self.DNSName || '').replace(/\.$/, '')
  const certs = Array.isArray(data.CertDomains) ? data.CertDomains : []
  // A wildcard certificate is issued for the tailnet's DNS suffix, not for the
  // node name itself, so either form counts as HTTPS-capable.
  const wildcard = certs.find((item) => String(item).startsWith('*.'))
  const suffix = wildcard ? String(wildcard).slice(2) : ''
  const https = certs.length === 0
    ? false
    : (certs.some((item) => {
        const value = String(item)
        return Boolean(dnsName) && (dnsName.endsWith(value) || value.endsWith(dnsName))
      }) || Boolean(suffix && dnsName.endsWith(suffix)) || null)
  // Tailscale writes year 1 for "no expiry"; that is not an expired key.
  const expiry = self.KeyExpiry ? Date.parse(self.KeyExpiry) : NaN
  const keyExpired = Number.isFinite(expiry)
    ? (expiry > Date.UTC(2000, 0, 1) ? expiry <= Date.now() : false)
    : null

  return empty({
    installed: true,
    backendState: String(data.BackendState || ''),
    online: typeof self.Online === 'boolean' ? self.Online : null,
    ip,
    dnsName,
    magicDnsSuffix: String(data.MagicDNSSuffix || ''),
    https,
    keyExpired,
    version: String(data.Version || '')
  })
}

/**
 * The machine's tailnet view. Cached for a few seconds because the dashboard
 * asks for it on every frame, and running a CLI once a second is not free.
 */
function status (options = {}) {
  const forced = forcedAddress()
  if (forced === null) return empty({ disabled: true })
  if (forced) {
    return empty({ installed: true, backendState: 'Running', online: true, ip: forced })
  }

  const key = cliPath()
  if (!options.fresh && cache.value && cache.key === key && Date.now() - cache.at < CACHE_MS) {
    return cache.value
  }

  let value = empty()
  const json = run(['status', '--json'])
  if (json.ok) {
    const parsed = parseStatus(json.stdout)
    if (parsed) value = parsed
  }
  // The CLI answering with an error still means it is installed: a stopped
  // tailscaled has no tailnet address to report, which is not the same thing
  // as a machine that never had Tailscale.
  const cliExists = json.ok || !json.missing
  if (!value.ip) {
    const ip = run(['ip', '-4'])
    if (ip.ok) {
      const found = ip.stdout.split(/\s+/).find((item) => TAILNET_RANGE.test(item))
      if (found) value.ip = found
    }
  }
  // The CLI can be absent on a machine that is still on the tailnet.
  if (!value.ip) value.ip = interfaceAddress()
  if (value.ip || cliExists) value.installed = true

  cache = { key, at: Date.now(), value }
  return value
}

/** Does `tailscale serve` proxy this port? null when it cannot be read. */
function served (port) {
  const result = run(['serve', 'status'])
  if (!result.ok) return null
  if (!result.stdout) return false
  return new RegExp(`:${port}(?!\\d)`).test(result.stdout)
}

/** One line for `voice status`: is this node reachable from the phone? */
function describe (site) {
  if (!site) return 'unknown'
  if (site.disabled) return 'not checked (FREEBUFFS_VOICE_TAILNET_IP=off)'
  if (!site.installed) return 'no Tailscale on this machine'
  const where = site.dnsName || site.ip || 'this machine'
  if (site.keyExpired) return `offline — node key expired (${where})`
  if (site.backendState && site.backendState !== 'Running') {
    return `not connected — ${site.backendState} (${where})`
  }
  if (!site.ip) return 'not connected — no tailnet address'
  if (site.online === false) return `offline in the tailnet (${where})`
  return `connected as ${where}`
}

/**
 * Why the phone cannot open the call link, and the command that fixes it.
 * `advice: false` drops the HTTPS hint, which is a suggestion rather than a
 * fault (the page loads over http; only the microphone needs HTTPS).
 */
function problems (options = {}, site = status()) {
  const out = []
  if (!site || site.disabled) return out
  const port = Number(options.port) || 8787
  const publicUrl = String(options.publicUrl || '')
  const advice = options.advice !== false

  if (!site.installed) {
    out.push(
      'Tailscale is not installed here, so the phone cannot reach the call link — ' +
      'install it and run `sudo tailscale up`.'
    )
    return out
  }
  if (site.keyExpired) {
    out.push(
      'This machine\'s Tailscale key has expired — that is the grey dot on the iPhone. ' +
      'Run `sudo tailscale up --reauth` (or re-authenticate it in the admin console).'
    )
  } else if (site.backendState && site.backendState !== 'Running') {
    out.push(
      `Tailscale is ${site.backendState || 'not running'} on this machine — the iPhone shows a grey dot until ` +
      '`sudo systemctl enable --now tailscaled && sudo tailscale up`.'
    )
  } else if (site.online === false) {
    out.push(
      'This machine is offline in the tailnet (grey dot on the iPhone) — run `sudo tailscale up`, ' +
      'and check that it is not asleep or powered off.'
    )
  } else if (!site.ip) {
    out.push(
      'Tailscale is not connected here (no tailnet address), so the phone cannot reach the line — ' +
      'run `sudo tailscale up`.'
    )
  }

  if (site.https === false) {
    out.push(
      'HTTPS is not enabled for this tailnet, so `tailscale serve` cannot give the call page a ' +
      'certificate — enable HTTPS in the Tailscale admin console under DNS.'
    )
  }

  if (publicUrl) {
    if (served(port) === false) {
      out.push(`The phone URL is set but nothing is serving port ${port} — run \`tailscale serve --bg ${port}\`.`)
    }
  } else if (advice && site.ip) {
    out.push(
      `The call link is http://${site.ip}:${port}; iOS only allows the microphone over HTTPS — ` +
      `run \`tailscale serve --bg ${port}\`, then ` +
      `\`sfreebuff voice url https://${site.dnsName || '<machine>.<tailnet>.ts.net'}\`.`
    )
  }

  return out.slice(0, 3)
}

module.exports = {
  TAILNET_RANGE,
  interfaceAddress,
  parseStatus,
  status,
  served,
  describe,
  problems
}
