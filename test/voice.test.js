'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const voice = require('../src/voice')
const tailnet = require('../src/tailnet')
const { fakeSupervisorPid } = require('./helpers')

// The call link is asserted against loopback in this suite: a machine that
// happens to be on a tailnet must not change the expected URL. The tailnet
// behaviour has its own tests below, which force the address.
process.env.FREEBUFFS_VOICE_TAILNET_IP = 'off'

const homes = []

function tempHome () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuffs-voice-'))
  homes.push(root)
  process.env.FREEBUFFS_HOME = path.join(root, 'home')
  fs.mkdirSync(process.env.FREEBUFFS_HOME, { recursive: true })
  fs.mkdirSync(path.join(process.env.FREEBUFFS_HOME, 'run'), { recursive: true })
  fs.mkdirSync(path.join(process.env.FREEBUFFS_HOME, 'logs'), { recursive: true })
  return process.env.FREEBUFFS_HOME
}

test.after(() => {
  for (const root of homes) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the line is off until it is switched on, and gets its own secret link', () => {
  const home = tempHome()
  const before = voice.summary()
  assert.equal(before.enabled, false)
  assert.equal(before.running, false)
  assert.equal(before.url, '', 'no link is offered while the line is off')

  // Turn it on in the settings only: setEnabled() also starts the server, and
  // a test must not leave a detached process (or its heartbeat) behind.
  voice.updateSettings({ enabled: true })
  const after = voice.summary()
  assert.equal(after.enabled, true)
  assert.match(after.url, /^http:\/\/127\.0\.0\.1:8787\/call\/[a-f0-9]{16,}$/)

  const token = voice.token()
  assert.equal(voice.token(), token, 'the token is stable')
  assert.ok(fs.existsSync(path.join(home, 'config.json')))

  voice.setEnabled(false)
  assert.equal(voice.summary().enabled, false)
  assert.equal(voice.summary().url, '')
})

test('the call link follows the Tailscale address it is given', () => {
  tempHome()
  voice.updateSettings({ enabled: true })
  voice.updateSettings({ publicUrl: 'https://runner.tailnet.ts.net/' })
  assert.match(voice.callUrl(), /^https:\/\/runner\.tailnet\.ts\.net\/call\//)
  voice.updateSettings({ publicUrl: '' })
  assert.match(voice.callUrl(), /^http:\/\/127\.0\.0\.1:8787\/call\//)
})

test('a ring with the line off does nothing', async () => {
  tempHome()
  const result = await voice.ring({ question: 'Needs a decision' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /off/)
})

test('a ring reaches the running page and the ntfy topic', async () => {
  tempHome()
  const plan = await voice.serve({ port: 0, host: '127.0.0.1' })
  try {
    voice.updateSettings({ enabled: true, port: plan.port, ntfy: 'freebuff-test-topic' })
    const pushed = []
    const result = await voice.ring(
      {
        kind: 'help',
        question: 'May I delete the cache?',
        action: 'Answer in the freebuff window.',
        sessionId: 's1'
      },
      {
        fetch: async (url, options) => {
          // The local page post is real; only the push is stubbed.
          if (String(url).startsWith(`http://127.0.0.1:${plan.port}`)) {
            return fetch(url, options)
          }
          pushed.push({ url: String(url), headers: options.headers, body: options.body })
          return { ok: true, status: 200 }
        }
      }
    )

    assert.equal(result.ok, true)
    assert.equal(result.local, true, 'the open page is told at once')
    assert.equal(result.push, true, 'the phone is pushed when the page is closed')
    assert.equal(pushed.length, 1)
    assert.match(pushed[0].url, /ntfy\.sh\/freebuff-test-topic/)
    assert.equal(pushed[0].headers.Priority, '5')
    assert.equal(voice.readPending().length, 1)
    assert.equal(voice.readPending()[0].question, 'May I delete the cache?')
  } finally {
    plan.close()
  }
})

test('the line answers its own liveness check, and serves the page from cache', async () => {
  tempHome()
  const plan = await voice.serve({ port: 0, host: '127.0.0.1' })
  try {
    // The heartbeat file only says a process exists; this is what tells the
    // supervisor that the call link is actually answering.
    const health = await fetch(`http://127.0.0.1:${plan.port}/healthz`)
    assert.equal(health.status, 200)
    assert.equal((await health.json()).ok, true, 'a health check needs no token')

    const url = `http://127.0.0.1:${plan.port}/call/${voice.token()}`
    const first = await fetch(url)
    const second = await fetch(url)
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    const [a, b] = [await first.text(), await second.text()]
    assert.equal(a, b, 'the same page bytes are served on every load')
    assert.match(a, /<html/i)
  } finally {
    plan.close()
  }
})

test('a question that is already waiting is not pushed to the phone twice', async () => {
  tempHome()
  const plan = await voice.serve({ port: 0, host: '127.0.0.1' })
  try {
    voice.updateSettings({ enabled: true, port: plan.port, ntfy: 'freebuff-test-topic' })
    const pushed = []
    const options = {
      fetch: async (url, init) => {
        // The local page post is real; only the push is stubbed.
        if (String(url).startsWith(`http://127.0.0.1:${plan.port}`)) return fetch(url, init)
        pushed.push(String(url))
        return { ok: true, status: 200 }
      }
    }

    const first = await voice.ring({ kind: 'help', question: 'Shall I publish?', sessionId: 's1' }, options)
    const second = await voice.ring({ kind: 'help', question: 'Shall I publish?', sessionId: 's1' }, options)

    assert.equal(first.push, true)
    assert.equal(second.push, false, 'the same waiting question does not ring again')
    assert.equal(second.duplicate, true)
    assert.equal(pushed.length, 1, 'one notification per waiting question')
    assert.equal(voice.readPending().length, 1)
  } finally {
    plan.close()
  }
})

test('push rings use ntfy priority 5 and open the call link', async () => {
  tempHome()
  voice.updateSettings({
    enabled: true,
    ntfy: 'freebuff-test-topic',
    publicUrl: 'https://runner.tailnet.ts.net'
  })

  const calls = []
  const sent = await voice.pushRing(
    { question: 'A decision is waiting', action: 'Answer it.' },
    {
      fetch: async (url, options) => {
        calls.push({ url: String(url), headers: options.headers, body: options.body })
        return { ok: true, status: 200 }
      }
    }
  )

  assert.equal(sent.sent, true)
  assert.equal(calls[0].url, 'https://ntfy.sh/freebuff-test-topic')
  assert.equal(calls[0].headers.Priority, '5', 'priority 5 rings like a call')
  assert.match(calls[0].headers.Click, /^https:\/\/runner\.tailnet\.ts\.net\/call\//)
  assert.match(calls[0].body, /decision is waiting/)
})

test('the local model is asked with the live facts, and its answer is used', async () => {
  tempHome()
  voice.updateSettings({ llmModel: 'test-model', llmUrl: 'http://127.0.0.1:9/v1' })

  const calls = []
  const reply = await voice.llmReply(
    'how are the sessions',
    { version: '0.2.0', signedIn: 2, accounts: 3, live: 1, sessions: ['account-1 in ~/p'], credits: [], pending: [] },
    {
      fetch: async (url, options) => {
        calls.push({ url: String(url), body: JSON.parse(options.body) })
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: 'One session is running.' } }] })
        }
      }
    }
  )

  assert.equal(reply, 'One session is running.')
  assert.equal(calls[0].url, 'http://127.0.0.1:9/v1/chat/completions')
  assert.equal(calls[0].body.model, 'test-model')
  assert.match(calls[0].body.messages[0].content, /live sessions: 1/)
})

test('with no model the assistant still answers by itself', async () => {
  tempHome()
  // A greeting is just a greeting now; the status is asked for by name.
  const hello = await voice.answer('hello')
  assert.equal(hello.source, 'supervisor')
  assert.equal(hello.reply, 'Hello.')

  const status = await voice.answer('status')
  assert.match(status.reply, /live session|account/i)

  const credits = await voice.answer('what are my credits')
  assert.match(credits.reply, /No signed-in accounts/i)

  const stop = await voice.answer('stop')
  assert.match(stop.reply, /nothing to stop/i)

  const unknown = await voice.answer(
    'tell me a long story about the ocean',
    { llm: async () => null }
  )
  assert.equal(unknown.source, 'fallback')
  assert.match(unknown.reply, /status/)
})

test('the phone page and its endpoints are protected by the link token', async () => {
  tempHome()
  const plan = await voice.serve({ port: 0, host: '127.0.0.1' })
  const base = plan.url.replace(/\/call\/.*$/, '')
  const secret = plan.url.split('/call/')[1]
  try {
    assert.match(plan.url, /^http:\/\/127\.0\.0\.1:\d+\/call\/[a-f0-9]+$/)

    assert.equal((await fetch(`${base}/api/state`)).status, 401)
    assert.equal(
      (await fetch(`${base}/api/turn`, { method: 'POST', body: '{}' })).status,
      401,
      'a turn without the token is refused'
    )

    const page = await fetch(plan.url)
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /FREEBUFF · voice line/)
    assert.match(html, /SpeechRecognition/)
    assert.match(html, /\/api\/turn/)
    assert.match(html, /Freebuff needs you/)
    // The typed box is the way in when a browser has no speech recognition.
    assert.match(html, /<form id="composer"/)
    assert.match(html, /<input id="say" type="text"/)
    assert.match(html, /enterkeyhint="send"/)
    assert.match(html, /id="approve"/)
    // iOS only speaks after a gesture, so the first touch of any kind unlocks
    // the voice, and a ring that was never heard is read out at that moment.
    assert.match(html, /function unlockVoice/)
    assert.match(html, /function armFromGesture/)
    assert.match(html, /if \(lastAnnouncement && !announcementSpoken && !speakingNow\) speak\(lastAnnouncement\)/)
    // One tap fires several events; without this the line restarted itself and
    // the call sounded like it was looping its opening sentence.
    assert.match(html, /if \(speakingNow && !options.force\)/)
    assert.match(html, /'pointerdown', 'touchstart', 'touchend', 'click', 'keydown', 'scroll'/)

    const state = await (await fetch(`${base}/api/state?token=${secret}`)).json()
    assert.equal(state.signedIn, 0)
    assert.equal(state.live, 0)

    const turn = await fetch(`${base}/api/turn?token=${secret}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'status' })
    })
    assert.equal(turn.status, 200)
    const said = await turn.json()
    assert.match(said.reply, /live session|signed in|account/i)

    const ring = await fetch(`${base}/api/ring?token=${secret}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Needs a yes', action: 'Answer it.' })
    })
    assert.equal(ring.status, 200)
    assert.equal(voice.readPending().length, 1)
    assert.equal(voice.readPending()[0].question, 'Needs a yes')

    const cleared = await fetch(`${base}/api/resolve?token=${secret}`, { method: 'POST' })
    assert.equal(cleared.status, 200)
    assert.equal(voice.readPending().length, 0)
  } finally {
    plan.close()
  }
})

test('a decision spoken on the phone is queued for its session, once', async () => {
  tempHome()
  voice.writePending([
    {
      id: 'ask-1',
      at: new Date().toISOString(),
      kind: 'help',
      question: 'Allow the agent to write files?',
      sessionId: 'session-1'
    }
  ])

  const said = await voice.answer('approve')
  assert.match(said.reply, /Approved/i)
  assert.equal(voice.readPending().length, 0, 'the answered call is cleared')

  const answer = voice.takeAnswer('session-1')
  assert.equal(answer.keys, 'y\r')
  assert.equal(voice.takeAnswer('session-1'), null, 'it is delivered once')

  assert.equal((await voice.answer('deny')).reply, 'Okay.', 'nothing waiting is one word, not a sentence')
})

test('bare yes does not authorize a waiting dialog', async () => {
  tempHome()
  voice.writePending([
    {
      id: 'ask-2',
      at: new Date().toISOString(),
      kind: 'help',
      question: 'Allow the agent to run sudo?',
      sessionId: 'session-2'
    }
  ])

  const said = await voice.answer('yes')
  assert.match(said.reply, /Say approve/i)
  assert.equal(voice.takeAnswer('session-2'), null, 'nothing was queued')
  assert.equal(voice.readPending().length, 1, 'the call is still waiting')
})

test('a deny is queued just like an approval', async () => {
  tempHome()
  voice.writePending([
    {
      id: 'ask-3',
      at: new Date().toISOString(),
      kind: 'help',
      question: 'Allow the agent to delete the build folder?',
      sessionId: 'session-3'
    }
  ])

  assert.match((await voice.answer('deny')).reply, /Denied/i)
  assert.equal(voice.takeAnswer('session-3').keys, 'n\r')
})

test('a typed command works with no microphone at all', async () => {
  tempHome()
  const plan = await voice.serve({ port: 0, host: '127.0.0.1' })
  const base = plan.url.replace(/\/call\/.*$/, '')
  const secret = plan.url.split('/call/')[1]
  try {
    voice.updateSettings({ enabled: true })
    voice.writePending([
      {
        id: 'ask-typed',
        at: new Date().toISOString(),
        kind: 'help',
        question: 'Allow the agent to write files?',
        sessionId: 'session-typed'
      }
    ])

    // Exactly what the text box posts: no speech, no recogniser involved.
    const response = await fetch(`${base}/api/turn?token=${secret}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'approve' })
    })
    assert.equal(response.status, 200)
    const said = await response.json()
    assert.match(said.reply, /Approved/i)
    assert.equal(voice.takeAnswer('session-typed').keys, 'y\r')

    const status = await (
      await fetch(`${base}/api/turn?token=${secret}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'status' })
      })
    ).json()
    assert.match(status.reply, /session|account/i)
  } finally {
    plan.close()
  }
})

test('a Finnish line answers in Finnish and understands Finnish commands', async () => {
  tempHome()
  voice.updateSettings({ lang: 'fi-FI' })

  const status = await voice.answer('tila')
  assert.match(status.reply, /istunto|tili/i)
  assert.doesNotMatch(status.reply, /live session|signed in/i)

  const stop = await voice.answer('lopeta')
  assert.match(stop.reply, /istunto|pysäytettävää/i)
  assert.doesNotMatch(stop.reply, /nothing to stop/i)

  voice.writePending([
    {
      id: 'ask-fi',
      at: new Date().toISOString(),
      kind: 'help',
      question: 'Saako agentti kirjoittaa tiedostoja?',
      sessionId: 'sess-fi'
    }
  ])
  const approved = await voice.answer('hyväksy')
  assert.match(approved.reply, /Hyväksytty/)
  assert.equal(voice.takeAnswer('sess-fi').keys, 'y\r')

  const late = await voice.answer('hylkää')
  assert.equal(late.reply, 'Okei.', 'a deny with nothing waiting is just acknowledged')
})

test('a bare Finnish yes never authorizes a dialog', async () => {
  tempHome()
  voice.updateSettings({ lang: 'fi-FI' })
  voice.writePending([
    {
      id: 'ask-fi-2',
      at: new Date().toISOString(),
      kind: 'help',
      question: 'Saako ajaa sudo?',
      sessionId: 'sess-fi-2'
    }
  ])

  const said = await voice.answer('kyllä')
  assert.match(said.reply, /Sano hyväksy tai hylkää/)
  assert.equal(voice.takeAnswer('sess-fi-2'), null)
  assert.equal(voice.readPending().length, 1)
})

test('the phone page is Finnish when the line is Finnish', () => {
  const html = voice.appHtml({ token: 'c'.repeat(48), lang: 'fi-FI' })
  assert.match(html, /puhelinlinja/)
  assert.match(html, /hyväksy/)
  assert.match(html, /kirjoita: tila/)
  assert.match(html, /const LANG = "fi-FI"/)
  assert.doesNotMatch(html, /Freebuff needs you/)
})

test('a greeting gets a short greeting back, not a status report', async () => {
  tempHome()
  voice.updateSettings({ lang: 'fi-FI' })
  assert.equal((await voice.answer('moro')).reply, 'Moro.')
  assert.equal((await voice.answer('hei')).reply, 'Hei.')
  assert.equal((await voice.answer('moi')).reply, 'Moi.')
  assert.equal((await voice.answer('huomenta')).reply, 'Huomenta.')
  // Any greeting stays one word: no follow-up question.
  for (const said of ['moro', 'hei', 'moi', 'terve', 'päivää']) {
    assert.ok((await voice.answer(said)).reply.split(' ').length <= 1)
  }
})

test('the Finnish prompt tells the model not to ask questions', async () => {
  tempHome()
  voice.updateSettings({ lang: 'fi-FI', llmModel: 'm', llmUrl: 'http://127.0.0.1:9/v1' })
  let system = ''
  await voice.llmReply('mitä kuuluu', { version: '0.2.0', signedIn: 1, accounts: 1, live: 0, sessions: [], credits: [], pending: [] }, {
    fetch: async (url, options) => {
      system = JSON.parse(options.body).messages[0].content
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Moro.' } }] }) }
    }
  })
  assert.match(system, /Älä kysy vastakysymyksiä/)
  assert.match(system, /Moro/)
})

test('a hosted endpoint gets the API key, a local one does not', async () => {
  tempHome()
  voice.updateSettings({ llmModel: 'm', llmUrl: 'https://api.example.test/v1', llmKey: 'secret-key' })
  let headers = null
  await voice.llmReply('hei', { version: '0.2.0', signedIn: 0, accounts: 0, live: 0, sessions: [], credits: [], pending: [] }, {
    fetch: async (url, options) => {
      headers = options.headers
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Moro.' } }] }) }
    }
  })
  assert.equal(headers.authorization, 'Bearer secret-key')

  voice.updateSettings({ llmKey: '' })
  await voice.llmReply('hei', { version: '0.2.0', signedIn: 0, accounts: 0, live: 0, sessions: [], credits: [], pending: [] }, {
    fetch: async (url, options) => {
      headers = options.headers
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Moro.' } }] }) }
    }
  })
  assert.equal(headers.authorization, undefined)
})

test('a status speaks the count and writes the paths instead of reading them', () => {
  tempHome()
  voice.updateSettings({ lang: 'fi-FI' })
  const snap = {
    signedIn: 1,
    accounts: 1,
    live: 1,
    sessions: ['account-4, käynnissä 51m19s'],
    sessionDetails: ['account-4 · /media/me/SDCARD · 51m19s'],
    pending: []
  }

  const { speech, detail } = voice.statusParts(snap)
  assert.match(speech, /1 istunto käynnissä/)
  assert.doesNotMatch(speech, /\/media|Sdcard/i, 'the folder is never spoken')
  assert.match(detail, /\/media\/me\/Sdcard/i)
})

test('the phone page has one voice picker and a talk button that moves', () => {
  const html = voice.appHtml({ token: 'e'.repeat(48), voiceName: 'Sol', lang: 'en-US' })
  // One control, showing the stored voice, instead of a row of buttons.
  assert.match(html, /<select id="voicepick"/)
  assert.match(html, /PREFERRED_VOICE = "Sol"/)
  assert.match(html, /voicepick\.value = PREFERRED_VOICE \|\| ''/)
  assert.doesNotMatch(html, /voicepick\.appendChild\(button\)/)
  // The same voice is only offered once, however iOS lists it.
  assert.match(html, /const key = String\(voice\.name\)\.toLowerCase\(\)/)
  // The talk button pulses while it listens and while the reply is spoken.
  assert.match(html, /#call\.listening \{ background:#ffd166; animation: mic-pulse/)
  assert.match(html, /#call\.speaking \{ background:#c8a2ff; animation: talk-pulse/)
})

test('the page prints the written detail without speaking it', () => {
  const html = voice.appHtml({ token: 'd'.repeat(48), lang: 'fi-FI' })
  assert.match(html, /\.you\.detail/)
  assert.match(html, /if \(data\.display\) add\(data\.display, 'you', 'detail'\)/)
})

test('the owner\'s own speaking instructions reach the model, examples included', async () => {
  tempHome()
  const persona = 'Puhu kuin kaveri: rento, lyhyt, vähän leikkisä.\n' +
    'Esimerkki:\n' +
    'minä: mitä kuuluu?\n' +
    'sinä: Ihan jees, Homma rullaa.'
  voice.updateSettings({ lang: 'fi-FI', llmModel: 'm', llmUrl: 'http://127.0.0.1:9/v1', persona })
  let system = ''
  await voice.llmReply('mitä kuuluu', { version: '0.2.0', signedIn: 1, accounts: 1, live: 0, sessions: [], credits: [], pending: [] }, {
    fetch: async (url, options) => {
      system = JSON.parse(options.body).messages[0].content
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Ihan jees.' } }] }) }
    }
  })
  assert.match(system, /Tyyli, jolla puhut/)
  assert.match(system, /tämä voittaa/)
  assert.match(system, /Puhu kuin kaveri/)
  assert.match(system, /sinä: Ihan jees, Homma rullaa\./)
})

test('without a persona the prompt is unchanged, and off clears it', async () => {
  tempHome()
  voice.updateSettings({ lang: 'fi-FI', llmModel: 'm', llmUrl: 'http://127.0.0.1:9/v1' })
  assert.equal(voice.settings().persona, '')
  assert.equal(voice.personaBlock(), '')
  let system = ''
  await voice.llmReply('hei', { version: '0.2.0', signedIn: 0, accounts: 0, live: 0, sessions: [], credits: [], pending: [] }, {
    fetch: async (url, options) => {
      system = JSON.parse(options.body).messages[0].content
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Hei.' } }] }) }
    }
  })
  assert.doesNotMatch(system, /Tyyli, jolla puhut/)
  assert.ok(system.startsWith(voice.SYSTEM_PROMPT_FI))

  await voice.voiceCommand(['persona', 'Puhu', 'kuin', 'kaveri'])
  assert.equal(voice.settings().persona, 'Puhu kuin kaveri')
  await voice.voiceCommand(['persona', 'off'])
  assert.equal(voice.settings().persona, '')
})

test('a persona can be read from a file with several example lines', async () => {
  tempHome()
  const file = path.join(process.env.FREEBUFFS_HOME, 'style.txt')
  fs.writeFileSync(file, 'Sano asiat yhdellä lauseella.\nEsimerkki: "Homma hoidossa."\n')
  await voice.voiceCommand(['persona', '--file', file])
  assert.match(voice.settings().persona, /Esimerkki: "Homma hoidossa\."/)
  assert.equal(voice.settings().persona.includes('\n'), true)
})

test('a ring goes straight to the problem, with one short greeting', async () => {
  tempHome()
  voice.updateSettings({
    lang: 'fi-FI',
    enabled: true,
    llmModel: 'm',
    llmUrl: 'https://api.example.test/v1',
    llmKey: 'k'
  })
  let sent = null
  const speech = await voice.ringSpeech(
    { kind: 'help', question: 'freebuff keeps ending the session', action: 'Say approve or deny.' },
    {
      fetch: async (url, options) => {
        sent = JSON.parse(options.body)
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'Moro. Yks istunto katkeilee koko ajan, haluuksä et mä katon?' } }] }) }
      }
    }
  )
  assert.equal(speech, 'Moro. Yks istunto katkeilee koko ajan, haluuksä et mä katon?')
  // The model is told to greet once and then say what is wrong, not to explain itself.
  assert.match(sent.messages[0].content, /mene heti asiaan/)
  assert.match(sent.messages[0].content, /älä kysy sopiiko nyt puhua/)
  assert.match(sent.messages[1].content, /freebuff keeps ending the session/)
})

test('a ring without a fast model still speaks plainly, never a preamble', async () => {
  tempHome()
  voice.updateSettings({ lang: 'fi-FI', enabled: true, llmKey: '' })
  const line = await voice.ringSpeech({ kind: 'help', question: 'freebuff is waiting on trust' })
  // A named dialog is never translated: "trust" stays "trust".
  assert.equal(line, 'Moro. Freebuff odottaa: trust. Hyväksytkö?')
  assert.doesNotMatch(line, /tarvitsee päätöksen/)

  const other = await voice.ringSpeech({ kind: 'help', question: 'kaksi istuntoa jumissa' })
  assert.equal(other, 'Moro. kaksi istuntoa jumissa. Haluuksä et mä katon?')

  voice.updateSettings({ lang: 'en-US' })
  const english = await voice.ringSpeech({ kind: 'critical', question: 'free sessions used up' })
  assert.equal(english, 'Moro. free sessions used up.')
})

test('a ring stores the phrased line so the page says exactly that', async () => {
  tempHome()
  voice.updateSettings({ lang: 'fi-FI', enabled: true, llmKey: '', ntfy: '' })
  const result = await voice.ring({ kind: 'help', question: 'kaksi istuntoa jumissa' }, { speech: false })
  assert.equal(result.entry.speech, 'Moro. kaksi istuntoa jumissa. Haluuksä et mä katon?')
  const stored = voice.readPending()
  assert.equal(stored[stored.length - 1].speech, result.entry.speech)
})

test('a recorded answer is transcribed by Whisper with the line language', async () => {
  tempHome()
  voice.updateSettings({ lang: 'fi-FI', llmUrl: 'https://api.groq.com/openai/v1', llmKey: 'k' })
  let sent = null
  const result = await voice.transcribeAudio(Buffer.from('fake-audio'), 'audio/mp4', {
    transcode: false,
    fetch: async (url, options) => {
      sent = { url: String(url), headers: options.headers, form: options.body }
      return { ok: true, json: async () => ({ text: '  moro, mitä kuuluu  ' }) }
    }
  })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'moro, mitä kuuluu')
  assert.equal(sent.url, 'https://api.groq.com/openai/v1/audio/transcriptions')
  assert.equal(sent.headers.authorization, 'Bearer k')
  assert.equal(sent.form.get('model'), 'whisper-large-v3', 'the full model, not the turbo distillate')
  assert.equal(sent.form.get('language'), 'fi')
  assert.match(sent.form.get('prompt'), /Hyväksyn/, 'short commands are biased towards the real words')
  assert.equal(sent.form.get('file').name, 'call.m4a', 'iOS records mp4, so the name must match')
})

test('transcription without a key says so instead of pretending to hear', async () => {
  tempHome()
  voice.updateSettings({ llmKey: '' })
  const result = await voice.transcribeAudio(Buffer.from('x'), 'audio/webm')
  assert.equal(result.ok, false)
  assert.match(result.reason, /no model key/)
})

test('a spoken instruction becomes a task freebuff is given, not chat', async () => {
  tempHome()
  voice.updateSettings({ lang: 'fi-FI' })
  const said = await voice.answer('korjaa se bugi dashboardissa')
  assert.equal(said.display, 'korjaa se bugi dashboardissa', 'the whole instruction is handed over')
  assert.match(said.reply, /teen sen/, 'the line says it will do it, not that it will pass it on')
  assert.equal(voice.takeTask().text, 'korjaa se bugi dashboardissa')
  assert.equal(voice.takeTask(), null, 'a task is handed to exactly one session')
})

test('a bare verb is conversation, not a task', async () => {
  tempHome()
  voice.updateSettings({ lang: 'fi-FI' })
  await voice.answer('korjaa')
  assert.equal(voice.readTasks().length, 0)
})

test('a spoken Finnish task is queued as English for freebuff', async () => {
  tempHome()
  voice.updateSettings({ lang: 'fi-FI', llmUrl: 'https://api.example.test/v1', llmKey: 'k', llmModel: 'm' })
  const english = await voice.englishTask('korjaa se bugi dashboardissa', {
    fetch: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '  "Fix the dashboard bug."  ' } }] })
    })
  })
  assert.equal(english, 'Fix the dashboard bug.', 'quotes and padding are stripped')
})

test('with no reachable model the task is queued in the words that were said', async () => {
  tempHome()
  voice.updateSettings({ lang: 'fi-FI' })
  const said = await voice.answer('korjaa se bugi dashboardissa')
  assert.match(said.reply, /Selvä, teen sen/)
  assert.equal(voice.takeTask().text, 'korjaa se bugi dashboardissa')
})

test('a translation failure keeps the spoken task instead of losing it', async () => {
  tempHome()
  voice.updateSettings({ lang: 'fi-FI', llmUrl: 'https://api.example.test/v1', llmKey: 'k' })
  const english = await voice.englishTask('korjaa se bugi', {
    fetch: async () => { throw new Error('offline') }
  })
  assert.equal(english, 'korjaa se bugi')
})

test('a framed request reaches freebuff as the work, not as the wrapper', async () => {
  tempHome()
  voice.updateSettings({ lang: 'fi-FI' })
  const said = await voice.answer('Lisää istunto tehtävä joka korjaa bugeja')
  assert.match(said.reply, /teen sen/)
  assert.equal(voice.takeTask().text, 'korjaa bugeja', 'the framing stays with the person')
})

test('an instruction needs no task verb to become work', async () => {
  tempHome()
  voice.updateSettings({ lang: 'fi-FI' })
  await voice.answer('dashboardin bugi pitää korjata')
  assert.equal(voice.takeTask().text, 'dashboardin bugi pitää korjata')
})

test('a question is answered by the line, not queued as work', async () => {
  tempHome()
  voice.updateSettings({ lang: 'fi-FI' })
  await voice.answer('onko istuntoja käynnissä?')
  assert.equal(voice.readTasks().length, 0)
})

test('the line says what the session is working on, and whether it is working', async () => {
  const home = tempHome()
  voice.updateSettings({ lang: 'fi-FI' })
  const configDir = path.join(home, 'accounts', 'account-1', 'config')
  const cwd = path.join(home, 'projekti')
  const chatDir = path.join(configDir, 'projects', 'projekti', 'chats', '2026-01-01T00-00-00.000Z')
  fs.mkdirSync(chatDir, { recursive: true })
  const messages = path.join(chatDir, 'chat-messages.json')
  fs.writeFileSync(messages, JSON.stringify([
    { role: 'user', content: 'lisää wifi-nappi' },
    { role: 'assistant', content: 'Implementing the wifi connect button.' }
  ]))
  require('../src/state').saveState({
    version: 1,
    accounts: [{ id: 'account-1', configDir }],
    sessions: [{
      id: 'session-1',
      accountId: 'account-1',
      cwd,
      pid: process.pid,
      launcherPid: process.pid,
      startedAt: new Date().toISOString()
    }],
    lastAccountId: 'account-1',
    lastAccountByCwd: {}
  })

  const working = await voice.answer('mitä teet nyt')
  assert.match(working.reply, /työstän parhaillaan/i, 'the work is said in the first person')
  assert.match(working.reply, /wifi connect button/, 'and it is the real last thing the agent wrote')
  assert.match(working.display, /working/)

  // Nothing written for ten minutes: the session is alive but waiting, and the
  // line must not claim it is working.
  const quiet = new Date(Date.now() - 10 * 60 * 1000)
  fs.utimesSync(messages, quiet, quiet)
  const waiting = await voice.answer('mitä teet nyt')
  assert.match(waiting.reply, /odottaa/)
})

test('an interrupted turn is interrupted, not working', async () => {
  const home = tempHome()
  voice.updateSettings({ lang: 'fi-FI' })
  const configDir = path.join(home, 'accounts', 'account-1', 'config')
  const cwd = path.join(home, 'projekti')
  const chatDir = path.join(configDir, 'projects', 'projekti', 'chats', 'chat-1')
  fs.mkdirSync(chatDir, { recursive: true })
  fs.writeFileSync(path.join(chatDir, 'chat-messages.json'), JSON.stringify([
    { role: 'user', content: 'lisää wifi-nappi' },
    { role: 'assistant', content: 'Implementing the wifi connect button. [response interrupted]' }
  ]))
  // Stop wrote to the chat a moment ago, so the file time alone would make the
  // session look busy for the next two minutes.
  require('../src/state').saveState({
    version: 1,
    accounts: [{ id: 'account-1', configDir }],
    sessions: [{
      id: 'session-1',
      accountId: 'account-1',
      cwd,
      pid: process.pid,
      launcherPid: process.pid,
      startedAt: new Date(Date.now() - 60 * 1000).toISOString()
    }],
    lastAccountId: 'account-1',
    lastAccountByCwd: {}
  })

  const said = await voice.answer('mitä teet nyt')
  assert.match(said.reply, /keskeytyi/, 'an interrupted turn is said as interrupted')
  assert.match(said.display, /interrupted/)
})

test('a chat whose speaker is stored as variant is read from the agent, not the person', async () => {
  // Some chats spell the speaker `variant` instead of `role`. Reading only
  // `role` made the person's own prompt look like the agent's latest work, so
  // "what are you doing" answered with the task that had just been typed.
  const home = tempHome()
  voice.updateSettings({ lang: 'fi-FI' })
  const configDir = path.join(home, 'accounts', 'account-1', 'config')
  const cwd = path.join(home, 'projekti')
  const chatDir = path.join(configDir, 'projects', 'projekti', 'chats', 'chat-variant')
  fs.mkdirSync(chatDir, { recursive: true })
  fs.writeFileSync(path.join(chatDir, 'chat-messages.json'), JSON.stringify([
    { variant: 'user', content: 'korjaa wifi-liityntä' },
    { variant: 'assistant', content: 'Fixing the wifi join flow in the settings sheet.' }
  ]))
  require('../src/state').saveState({
    version: 1,
    accounts: [{ id: 'account-1', configDir }],
    sessions: [{
      id: 'session-variant',
      accountId: 'account-1',
      cwd,
      pid: process.pid,
      launcherPid: process.pid,
      startedAt: new Date(Date.now() - 60 * 1000).toISOString()
    }],
    lastAccountId: 'account-1',
    lastAccountByCwd: {}
  })

  const said = await voice.answer('mitä teet nyt')
  assert.match(said.reply, /wifi join flow/)
  assert.doesNotMatch(said.reply, /korjaa wifi-liityntä/, 'the person\'s prompt is not the work')
})

test('the line can say what is done and what is still in progress', async () => {
  const home = tempHome()
  voice.updateSettings({ lang: 'fi-FI' })
  const configDir = path.join(home, 'accounts', 'account-1', 'config')
  const cwd = path.join(home, 'projekti')
  const chatDir = path.join(configDir, 'projects', 'projekti', 'chats', 'chat-steps')
  fs.mkdirSync(chatDir, { recursive: true })
  fs.writeFileSync(path.join(chatDir, 'chat-messages.json'), JSON.stringify([
    { role: 'user', content: 'tee asetussivu valmiiksi' },
    { role: 'assistant', content: 'Added the settings screen skeleton.' },
    { role: 'user', content: 'jatka' },
    { role: 'assistant', content: 'Wired the save button to the store.' },
    { role: 'assistant', content: 'Running the settings tests now.' }
  ]))
  require('../src/state').saveState({
    version: 1,
    accounts: [{ id: 'account-1', configDir }],
    sessions: [{
      id: 'session-steps',
      accountId: 'account-1',
      cwd,
      pid: process.pid,
      launcherPid: process.pid,
      startedAt: new Date(Date.now() - 60 * 1000).toISOString()
    }],
    lastAccountId: 'account-1',
    lastAccountByCwd: {}
  })

  const said = await voice.answer('mitä on jo tehty?')
  assert.match(said.reply, /Kesken: Running the settings tests now/, 'what is running is named')
  assert.match(said.reply, /Tehtyä tähän mennessä: .*save button/, 'and the earlier steps are done')
  assert.doesNotMatch(said.reply, /tee asetussivu valmiiksi/, 'the person\'s own prompts are not steps')
  assert.match(said.display, /save button/, 'the written detail lists the steps too')

  // The same question in English, with the steps under the spoken answer.
  voice.updateSettings({ lang: 'en-US' })
  const again = await voice.answer('what is done so far?')
  assert.match(again.reply, /In progress:/)
  assert.match(again.reply, /Done so far:/)
})

test('a chat is found even when the project folder is not named after the folder', async () => {
  const home = tempHome()
  voice.updateSettings({ lang: 'fi-FI' })
  const configDir = path.join(home, 'accounts', 'account-1', 'config')
  const cwd = path.join(home, 'projekti')
  // freebuff may key its project directory differently; the chat itself still
  // names the folder it belongs to.
  const chatDir = path.join(configDir, 'projects', 'some-other-key', 'chats', 'chat-9')
  fs.mkdirSync(chatDir, { recursive: true })
  fs.writeFileSync(path.join(chatDir, 'chat-meta.json'), JSON.stringify({ cwd }))
  fs.writeFileSync(path.join(chatDir, 'chat-messages.json'), JSON.stringify([
    { role: 'assistant', content: 'Running the dashboard tests.' }
  ]))
  require('../src/state').saveState({
    version: 1,
    accounts: [{ id: 'account-1', configDir }],
    sessions: [{
      id: 'session-1',
      accountId: 'account-1',
      cwd,
      pid: process.pid,
      launcherPid: process.pid,
      startedAt: new Date(Date.now() - 60 * 1000).toISOString()
    }],
    lastAccountId: 'account-1',
    lastAccountByCwd: {}
  })

  const said = await voice.answer('mitä teet nyt')
  assert.match(said.reply, /työstän parhaillaan/i)
  assert.match(said.reply, /dashboard tests/)
})

test('a chat from before the session started is not what it is doing', async () => {
  const home = tempHome()
  voice.updateSettings({ lang: 'fi-FI' })
  const configDir = path.join(home, 'accounts', 'account-1', 'config')
  const cwd = path.join(home, 'projekti')
  const chatDir = path.join(configDir, 'projects', 'vanha-projekti', 'chats', 'chat-old')
  fs.mkdirSync(chatDir, { recursive: true })
  const messages = path.join(chatDir, 'chat-messages.json')
  fs.writeFileSync(messages, JSON.stringify([
    { role: 'assistant', content: 'Old work from another conversation.' }
  ]))
  const old = new Date(Date.now() - 60 * 60 * 1000)
  fs.utimesSync(messages, old, old)
  require('../src/state').saveState({
    version: 1,
    accounts: [{ id: 'account-1', configDir }],
    sessions: [{
      id: 'session-2',
      accountId: 'account-1',
      cwd,
      pid: process.pid,
      launcherPid: process.pid,
      startedAt: new Date().toISOString()
    }],
    lastAccountId: 'account-1',
    lastAccountByCwd: {}
  })

  const said = await voice.answer('mitä teet nyt')
  assert.match(said.reply, /En nää/, 'nothing from before this session is reported')
  assert.match(said.display, /unknown/)
})

test('"new session" starts one in the background on a headless machine', async () => {
  const home = tempHome()
  voice.updateSettings({ lang: 'fi-FI' })
  const configDir = path.join(home, 'accounts', 'account-1', 'config')
  const project = path.join(home, 'projekti')
  fs.mkdirSync(configDir, { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(
    path.join(configDir, 'credentials.json'),
    JSON.stringify({ default: { id: 'account-1', authToken: 'tok-stub' } })
  )
  // A running session is a process that still looks like this supervisor.
  const live = await fakeSupervisorPid()
  require('../src/state').saveState({
    version: 1,
    accounts: [{ id: 'account-1', configDir, signedInAt: new Date().toISOString() }],
    sessions: [{
      id: 'session-1',
      accountId: 'account-1',
      cwd: project,
      pid: live.pid,
      launcherPid: live.pid,
      startedAt: new Date().toISOString()
    }],
    lastAccountId: 'account-1',
    lastAccountByCwd: {}
  })

  const dashboard = require('../src/dashboard')
  const original = dashboard.startSession
  const calls = []
  dashboard.startSession = (options) => {
    calls.push(options)
    return { ok: true, window: false, pid: 4242 }
  }
  try {
    const said = await voice.answer('uusi istunto')
    assert.match(said.reply, /taustalle/, 'a headless start is still a session')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].account.id, 'account-1')
    assert.equal(calls[0].cwd, project, 'it opens where the running session works')
  } finally {
    dashboard.startSession = original
    live.stop()
  }
})

test('with several sessions a task names the one it is for', async () => {
  const home = tempHome()
  voice.updateSettings({ lang: 'fi-FI' })
  const startedAt = new Date().toISOString()
  require('../src/state').saveState({
    version: 1,
    accounts: [
      { id: 'account-1', configDir: path.join(home, 'a1') },
      { id: 'account-2', configDir: path.join(home, 'a2') }
    ],
    sessions: [
      { id: 'session-1', accountId: 'account-1', cwd: path.join(home, 'one'), pid: process.pid, launcherPid: process.pid, startedAt },
      { id: 'session-2', accountId: 'account-2', cwd: path.join(home, 'two'), pid: process.pid, launcherPid: process.pid, startedAt }
    ],
    lastAccountId: null,
    lastAccountByCwd: {}
  })

  const unclear = await voice.answer('korjaa testit')
  assert.match(unclear.reply, /Istuntoja on useampi/, 'the line asks which session')
  assert.equal(voice.readTasks().length, 0, 'nothing is queued while the session is unclear')

  const data = await voice.answer('mitä teet nyt')
  assert.match(data.reply, /Minkä niistä/, 'a data question asks the same')
  assert.match(data.display, /1\. account-1/)
  assert.match(data.display, /2\. account-2/)

  const asked = await voice.answer('istunnolle 2 korjaa testit')
  assert.match(asked.reply, /teen sen/)
  assert.equal(voice.takeTask('session-1'), null, 'another session must not take it')
  assert.equal(voice.takeTask('session-2').text, 'korjaa testit')
})

test('a stop spoken for one session leaves the others running', async () => {
  const home = tempHome()
  voice.updateSettings({ lang: 'fi-FI' })
  const startedAt = new Date().toISOString()
  // Both sessions have to look like running ones, not just have a live pid.
  const live = await fakeSupervisorPid()
  require('../src/state').saveState({
    version: 1,
    accounts: [
      { id: 'account-1', configDir: path.join(home, 'a1') },
      { id: 'account-2', configDir: path.join(home, 'a2') }
    ],
    sessions: [
      { id: 'session-1', accountId: 'account-1', cwd: path.join(home, 'one'), pid: live.pid, launcherPid: live.pid, startedAt },
      { id: 'session-2', accountId: 'account-2', cwd: path.join(home, 'two'), pid: live.pid, launcherPid: live.pid, startedAt }
    ],
    lastAccountId: null,
    lastAccountByCwd: {}
  })

  const dashboard = require('../src/dashboard')
  const original = dashboard.stopSession
  const stopped = []
  dashboard.stopSession = (session) => {
    stopped.push(session.id)
    return { ok: true }
  }
  try {
    const said = await voice.answer('istunnolle 2 lopeta')
    assert.match(said.reply, /account-2/)
    assert.deepEqual(stopped, ['session-2'], 'only the named session stops')
  } finally {
    dashboard.stopSession = original
    live.stop()
  }
})

test('editing or withdrawing the queued prompt is done here, not by freebuff', async () => {
  tempHome()
  voice.updateSettings({ lang: 'fi-FI' })
  voice.queueTask('Fix the dashboard bug.')

  const edited = await voice.answer('muuta tehtävä 1 korjaa testit')
  assert.match(edited.reply, /Muutin sen/)
  assert.equal(voice.readTasks().length, 1, 'the edit changed the queue instead of queueing a task')
  assert.equal(voice.readTasks()[0].text, 'korjaa testit')

  const withdrawn = await voice.answer('älä lähetä tuota')
  assert.match(withdrawn.reply, /unohtaa/)
  const correction = voice.takeTask()
  assert.match(correction.text, /Cancel the previous instruction/, 'freebuff is told to forget the work')
  assert.equal(voice.readTasks().length, 0)
})

test('a partial correction keeps only the last part of the prompt', async () => {
  tempHome()
  voice.updateSettings({ lang: 'fi-FI' })
  voice.queueTask('Fix the dashboard bug and update the README')

  const said = await voice.answer('ei tuo, mutta viimeinen osa oli oikein')
  assert.match(said.reply, /viimeinen osa/)
  const correction = voice.takeTask()
  assert.match(correction.text, /update the README/, 'the correct part is kept')
  assert.doesNotMatch(correction.text, /dashboard bug/, 'the wrong part is dropped')
})

test('the live phase comes from the running monitor, not only from chat files', async () => {
  const home = tempHome()
  voice.updateSettings({ lang: 'fi-FI' })
  const configDir = path.join(home, 'accounts', 'account-1', 'config')
  const cwd = path.join(home, 'projekti')
  const chatDir = path.join(configDir, 'projects', 'projekti', 'chats', 'chat-1')
  fs.mkdirSync(chatDir, { recursive: true })
  // The chat was written by the interrupt itself, so on its own it looks like
  // work. The monitor's beat is what knows the turn was stopped.
  fs.writeFileSync(path.join(chatDir, 'chat-messages.json'), JSON.stringify([
    { role: 'assistant', content: 'Implementing the wifi connect button.' }
  ]))
  require('../src/state').saveState({
    version: 1,
    accounts: [{ id: 'account-1', configDir }],
    sessions: [{
      id: 'session-1',
      accountId: 'account-1',
      cwd,
      pid: process.pid,
      launcherPid: process.pid,
      startedAt: new Date(Date.now() - 60 * 1000).toISOString()
    }],
    lastAccountId: 'account-1',
    lastAccountByCwd: {}
  })
  fs.writeFileSync(
    path.join(home, 'run', 'monitor-session-1.json'),
    JSON.stringify({
      monitorPid: process.pid,
      sessionId: 'session-1',
      accountId: 'account-1',
      freebuffPid: process.pid,
      updatedAt: new Date().toISOString(),
      work: {
        phase: 'interrupted',
        quietMs: 5000,
        interrupted: true,
        text: 'Implementing the wifi connect button.'
      }
    })
  )

  const said = await voice.answer('mitä teet nyt')
  assert.match(said.reply, /keskeytyi/, 'the monitor knows before the chat file does')
  assert.match(said.display, /interrupted/)
})

test('a session that ended is reported as ended, not as work', async () => {
  const home = tempHome()
  voice.updateSettings({ lang: 'fi-FI' })
  require('../src/state').saveState({
    version: 1,
    accounts: [{ id: 'account-1', configDir: path.join(home, 'a1') }],
    sessions: [{
      id: 'session-1',
      accountId: 'account-1',
      cwd: path.join(home, 'projekti'),
      pid: process.pid,
      launcherPid: process.pid,
      startedAt: new Date(Date.now() - 120 * 1000).toISOString(),
      endedAt: new Date().toISOString(),
      exitCode: 0
    }],
    lastAccountId: 'account-1',
    lastAccountByCwd: {}
  })

  const said = await voice.answer('mitä teet nyt')
  assert.match(said.reply, /päättyi/, 'an ended session is not doing anything')
  assert.match(said.display, /ended/)

  // Nobody is there to type into, so work is queued for the next session
  // instead of being addressed to the one that ended.
  await voice.answer('korjaa testit')
  const queued = voice.takeTask('session-1')
  assert.equal(queued.session, undefined)
})

test('the queue can be asked about, edited and emptied by voice', async () => {
  tempHome()
  voice.updateSettings({ lang: 'fi-FI' })
  voice.queueTask('Fix the dashboard bug.')
  voice.queueTask('Add tests for the queue.')

  const listed = await voice.answer('mitä on jonossa')
  assert.match(listed.reply, /Jonossa on 2 tehtävää/)
  assert.match(listed.display, /1\. Fix the dashboard bug\./)
  assert.match(listed.display, /2\. Add tests for the queue\./)

  const removed = await voice.answer('poista tehtävä 1')
  assert.match(removed.reply, /Poistin: Fix the dashboard bug\./)
  assert.equal(voice.readTasks().length, 1)

  const edited = await voice.answer('muuta tehtävä 1 korjaa testit')
  assert.match(edited.reply, /Muutin sen/)
  assert.equal(voice.readTasks()[0].text, 'korjaa testit', 'no model key, so the words stay as said')

  const cleared = await voice.answer('tyhjennä jono')
  assert.equal(cleared.reply, 'Tyhjensin jonon.')
  assert.equal(voice.readTasks().length, 0)
  assert.equal((await voice.answer('mitä on jonossa')).reply, 'Jonossa ei ole mitään.')
})

test('the call link is the tailnet address, not loopback, when one is known', () => {
  tempHome()
  const previous = process.env.FREEBUFFS_VOICE_TAILNET_IP
  process.env.FREEBUFFS_VOICE_TAILNET_IP = '100.101.102.103'
  try {
    voice.updateSettings({ enabled: true, publicUrl: '' })
    assert.match(
      voice.callUrl(),
      /^http:\/\/100\.101\.102\.103:8787\/call\/[a-f0-9]{16,}$/,
      'a phone cannot open 127.0.0.1, so the tailnet address is the link'
    )
  } finally {
    process.env.FREEBUFFS_VOICE_TAILNET_IP = previous === undefined ? 'off' : previous
    voice.updateSettings({ publicUrl: '' })
  }
})

test('a call link that arrives with a trailing slash still opens the page', async () => {
  tempHome()
  const plan = await voice.serve({ port: 0, host: '127.0.0.1' })
  try {
    const page = await fetch(`http://127.0.0.1:${plan.port}/call/${voice.token()}/`)
    assert.equal(page.status, 200, 'the extra slash is the same link')
    assert.match(await page.text(), /<html/i)
  } finally {
    plan.close()
  }
})

test('the line listens on the tailnet address as well as loopback', async () => {
  const previous = process.env.FREEBUFFS_VOICE_TAILNET_IP
  process.env.FREEBUFFS_VOICE_TAILNET_IP = '127.0.0.2'
  const plan = await voice.serve({ port: 0 })
  try {
    assert.equal(plan.host, '127.0.0.1')
    if (plan.tailnetHost) {
      assert.deepEqual(plan.hosts, ['127.0.0.1', '127.0.0.2'])
      assert.match(plan.url, /^http:\/\/127\.0\.0\.2:\d+\/call\//)
      const health = await fetch(`http://127.0.0.2:${plan.port}/healthz`)
      assert.equal(health.status, 200, 'the phone link answers on the tailnet')
    }
  } finally {
    process.env.FREEBUFFS_VOICE_TAILNET_IP = previous === undefined ? 'off' : previous
    plan.close()
  }
})

function stubTailscale (script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuffs-tailscale-'))
  homes.push(dir)
  const file = path.join(dir, 'tailscale')
  fs.writeFileSync(file, script)
  fs.chmodSync(file, 0o755)
  process.env.FREEBUFFS_TAILSCALE_BIN = file
  return file
}

test('an offline node is reported as the grey dot, with the fix', () => {
  tempHome()
  const previous = process.env.FREEBUFFS_VOICE_TAILNET_IP
  process.env.FREEBUFFS_VOICE_TAILNET_IP = ''
  stubTailscale(`#!/bin/sh
case "$1 $2" in
  "status --json")
    echo '{"BackendState":"Stopped","Self":{"Online":false,"DNSName":"arc.tailnet.ts.net.","TailscaleIPs":["100.101.102.103"],"KeyExpiry":"2027-01-01T00:00:00Z"},"CertDomains":["tailnet.ts.net"]}'
    exit 0 ;;
  *)
    exit 1 ;;
esac
`)
  try {
    const site = tailnet.status({ fresh: true })
    assert.equal(site.ip, '100.101.102.103')
    assert.equal(site.dnsName, 'arc.tailnet.ts.net')
    assert.equal(site.backendState, 'Stopped')
    assert.equal(site.online, false)
    assert.match(tailnet.describe(site), /not connected/)
    const fixes = tailnet.problems({ port: 8787 }, site)
    assert.ok(fixes.some((line) => /grey dot/.test(line)), 'the phone symptom is named')
    assert.ok(fixes.some((line) => /systemctl enable --now tailscaled/.test(line)))
  } finally {
    delete process.env.FREEBUFFS_TAILSCALE_BIN
    process.env.FREEBUFFS_VOICE_TAILNET_IP = previous === undefined ? 'off' : previous
  }
})

test('a connected node with serve configured has nothing to fix', () => {
  tempHome()
  const previous = process.env.FREEBUFFS_VOICE_TAILNET_IP
  process.env.FREEBUFFS_VOICE_TAILNET_IP = ''
  stubTailscale(`#!/bin/sh
if [ "$1" = "status" ] && [ "$2" = "--json" ]; then
  echo '{"BackendState":"Running","Self":{"Online":true,"DNSName":"arc.tailnet.ts.net.","TailscaleIPs":["100.101.102.103","fd7a::1"],"KeyExpiry":"2027-01-01T00:00:00Z"},"CertDomains":["*.tailnet.ts.net"]}'
  exit 0
fi
if [ "$1" = "serve" ]; then
  echo 'https://arc.tailnet.ts.net (tailnet only) -> http://127.0.0.1:8787'
  exit 0
fi
exit 1
`)
  try {
    const site = tailnet.status({ fresh: true })
    assert.equal(site.online, true)
    assert.equal(site.https, true)
    assert.match(tailnet.describe(site), /connected as arc\.tailnet\.ts\.net/)
    assert.deepEqual(
      tailnet.problems({ port: 8787, publicUrl: 'https://arc.tailnet.ts.net' }, site),
      [],
      'a working HTTPS call link needs no fix'
    )
  } finally {
    delete process.env.FREEBUFFS_TAILSCALE_BIN
    process.env.FREEBUFFS_VOICE_TAILNET_IP = previous === undefined ? 'off' : previous
  }
})

test('an expired node key is not mistaken for a healthy node', () => {
  const site = tailnet.parseStatus(JSON.stringify({
    BackendState: 'Running',
    Self: {
      Online: true,
      DNSName: 'arc.tailnet.ts.net.',
      TailscaleIPs: ['100.101.102.103'],
      KeyExpiry: '2020-01-01T00:00:00Z'
    }
  }))
  assert.equal(site.keyExpired, true)
  assert.match(tailnet.describe(site), /key expired/)
  assert.ok(tailnet.problems({ port: 8787 }, site).some((line) => /reauth/.test(line)))
})
