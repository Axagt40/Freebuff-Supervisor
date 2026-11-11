# FREEBUFF SUPERVISOR — v1.0.2

An unattended supervisor for [freebuff](https://freebuff.com) coding sessions.

A freebuff session normally ends when you stop looking at it: a crash, a dropped
connection, a used-up turn, a closed window. This keeps it going. It starts the
session, watches it, and when something interrupts the work it relaunches the
same conversation and tells the agent to carry on — so a long task finishes
without anybody babysitting the terminal.

One command: **`sfreebuff`**. Run it with no arguments and you get the
dashboard: every account, its credits, and every session, one keypress from
starting work.

```
  FREEBUFFS  supervisor dashboard  v1.0.2                            23:12:04
────────────────────────────────────────────────────────────────────────────
  FREEBUFF SUPERVISOR v1.0.2 — freebuff sessions, kept running unattended
  ACCOUNTS  2/2 signed in
   ＋ add account  sign in another freebuff account
   ● account-1    signed in   1 live   6 sess    12m ago        480
 ▸ ● account-2    expiring    idle     3 sess    2h01m ago       12
  SESSIONS  1 live · 0 lost · 0 monitors
 ▸ ＋ new session  with account-2 in ~/code/my-project
   ~/code/my-project          account-1   live  12m30s  pid 20137  —
────────────────────────────────────────────────────────────────────────────
  [ enter start ] [ n new session ] [ x stop ] [ l login ] [ d remove ] [ s settings ] …
```

## Requirements

- **Node.js 18 or newer**
- **freebuff**. The supervisor launches and watches that binary; it does not
  bundle it. `install.sh` installs it for you when it is missing.
- Optional: `node-pty` for auto-answering dialogs and typing into a session
  (`install.sh` tries to build it; everything else works without it).

## Install

One command, nothing to download by hand:

```bash
curl -fsSL https://raw.githubusercontent.com/Axagt40/Freebuff-Supervisor/main/install.sh | sh
```

That fetches the latest release, checks Node, installs the optional dependency,
puts `sfreebuff` on your `PATH` (and records it in `~/.bashrc`, `~/.zshrc` or
`~/.profile` so new terminals find it), installs freebuff itself if it is
missing, and signs in one account. Re-running the same line upgrades in place;
the program is kept in `~/.local/share/freebuff-supervisor`.

It stops before the browser sign-in with `--no-login`, and answers every prompt
with `--yes` (or `FREEBUFFS_YES=1`) so it can run unattended:

```bash
curl -fsSL https://raw.githubusercontent.com/Axagt40/Freebuff-Supervisor/main/install.sh | sh -s -- --yes
```

Nothing is started and no session runs until you ask for one.

**From a downloaded package folder** — the same thing, offline:

```bash
tar -xzf freebuff-supervisor-1.0.2.tgz
cd package
sh install.sh
```

**With npm**, if you prefer a global install:

```bash
npm install -g ./freebuff-supervisor-1.0.2.tgz
sfreebuff --version
```

**From a checkout** without the script:

```bash
node bin/sfreebuff.js install
```

## Quick start

```bash
sfreebuff login        # sign in an account (freebuff's own browser flow)
sfreebuff              # open the dashboard; enter starts a session
sfreebuff run          # start a session in this folder, keep it alive
sfreebuff status       # accounts, credits, live sessions, monitor
sfreebuff stop         # stop a running supervisor after its current session
```

Add more accounts with `sfreebuff login` (repeat), `sfreebuff setup
--accounts 3`, or the `＋ add account` row in the dashboard. Each account is an
isolated freebuff config dir; the big binary and support files are shared, never
duplicated.

## What it does

- **Keeps a session alive 24/7.** A crash, a stall, a dropped connection or a
  finished free session is treated as an interruption: the supervisor relaunches
  freebuff with `--continue`, backs off between attempts, and keeps the work
  going in the resumed conversation: a short “continue from where you left off”
  when that chat is resumed, or the recovered task itself when there is no chat
  to resume. A clean exit in the middle of a turn is recognised as a cut-off
  task, not a finished one.
- **Runs several sessions at once**, one per account and folder, each an
  ordinary supervisor that logs, reports and can be stopped on its own.
- **Moves a session to another account** when one runs out of free sessions.
  Rotation picks the longest-idle eligible account, and never one that reported
  an auth failure, is cooling down after a used-up quota, or has an expired
  token. With no alternative it waits for the quota reset and then continues the
  same task.
- **Answers the dialogs it may answer** (plan approval, “continue this path”,
  retry screens) when `node-pty` is available, and escalates anything risky —
  sudo, credentials, deleting files, network installs, publishing, spending —
  or unrecognised to you.
- **Nudges a quiet agent** with the task it was last given, and picks the work
  back up after freebuff records a turn as interrupted.
- **Diagnoses bad endings**: a session that ends badly leaves
  `~/.freebuffs/logs/diagnose-<session>.log` with the cause and the action.
- **Reports to Discord** when it starts, when a session ends, when it stops, and
  when it needs a person (CRITICAL).
- **Can call your phone** when a decision is needed, over Tailscale, and take a
  spoken approve/deny.

It stops only when a person is needed: a clean exit that finished the work,
Ctrl-C, `sfreebuff stop`, several failed starts in a row, or no account that can
run a session. The last two are reported as CRITICAL.

## Dashboard

`sfreebuff` (or `sfreebuff dashboard`) is a live terminal view of every account
and session, with credits coloured green → yellow → red as they run down.

| key | action |
| --- | --- |
| `↑` `↓` | move the cursor |
| `tab` | switch between the account list and the session list |
| `enter` | **start** on the `＋ new session` row, **continue** that conversation on a session row |
| `n` | start a new session with the highlighted account |
| `x` | stop the selected session, or clear the row when nothing of it is running any more |
| `l` | open sign-in for the account |
| `a` | add an account (`＋ add account` is also a row) |
| `d` | remove the account under the cursor (press twice; refuses a live one) |
| `s` | settings — voice, optimization, force continue and shutdown switches |
| `r` | redraw |
| `q` | quit |

Every action is also a clickable button; the mouse wheel scrolls the lists.
A session started here gets its own window (or runs detached on a machine with
no display), skips the extra monitor window because the dashboard is the view,
and runs `--no-sudo` since nobody is at its keyboard. A session it starts is
**new**: it begins its own conversation. `enter` on an existing row instead
**continues** that one — the supervisor resumes the chat and types the continue
prompt. Rows for sessions that are no longer running are shown as `lost`, never
as `live`, and `x` clears a stale record instead of leaving it behind forever.

Settings has four switches, all but voice off by default: **Voice calls** (the
phone line); **Optimization**, which starts sessions at a lower CPU priority so
two busy sessions cannot starve the desktop on a small machine (turning it on
also lowers the priority of sessions already running); **Force continue**; and
the **Shutdown timer**.

**Force continue** exists for very large tasks. freebuff splits the work into
phases and then stops at its prompt after one of them, even when it was told to
finish everything. With the switch on, the supervisor types a continue prompt
into the same conversation a minute after a finished turn and keeps doing that
until the agent reports it is done. The prompt asks freebuff to re-read the
original request, carry on with every remaining phase, never stop after one,
and end with `FREEBUFFS ALL TASKS COMPLETE` when, and only when, everything is
finished. `e` on the row (or the prompt button) edits that text, and an empty
edit restores the built-in wording; the completion line is always appended to a
custom prompt so "done" stays detectable.

**Shutdown timer** powers the machine off once the agent writes that completion
line, using the included `wait-and-poweroff.sh` (logind, no password). It waits
for the session's processes to end, with a 15-minute backup deadline, so a
finished task cannot leave the machine on all night and a hung one cannot keep
it on forever. It turns force continue on with it, because that is what produces
the completion line. Starting a new session cancels a pending poweroff.

Piped output is one plain snapshot, so `sfreebuff dashboard` also works in a
script.

## Command reference

| command | purpose |
| --- | --- |
| `sfreebuff` | the dashboard |
| `sfreebuff run [args…]` | launch in this folder and keep the session alive |
| `sfreebuff [args…]` | forward freebuff arguments (still kept alive) |
| `sfreebuff --once` | one session, then return |
| `sfreebuff --fresh` | start a conversation of its own instead of continuing the folder's last chat |
| `sfreebuff --continue` | resume the folder's conversation on the account that last ran here |
| `sfreebuff --account <id>` | force one account |
| `sfreebuff --pty` / `--no-pty` | force / disable the pseudo-terminal |
| `sfreebuff --no-monitor` | no side monitor window |
| `sfreebuff --no-sudo` | do not unlock sudo for this run |
| `sfreebuff stop` | stop a supervisor after its current session |
| `sfreebuff setup [--accounts N]` | first-run sign-in |
| `sfreebuff login [--new\|--account <id>]` | add or re-sign an account |
| `sfreebuff status` | accounts, credits, live sessions, monitors, sudo |
| `sfreebuff doctor` | check binary, credentials, monitors, logs |
| `sfreebuff logs [-f] [-n N]` | supervisor log |
| `sfreebuff sudo on\|off\|status` | sudo vault for sessions |
| `sfreebuff github --ask` | store a GitHub token in the same vault, typed hidden |
| `sfreebuff github status\|off` | check the stored token, or forget it |
| `sfreebuff push [args…]` | push with the stored token, no prompt |
| `sfreebuff notify <url\|off\|test>` | Discord reports |
| `sfreebuff voice …` | the phone line (on/off/status/serve/call/url/ntfy/lang/key/persona) |
| `sfreebuff install` | put the command on `PATH` |

`sfreebuff --help` lists everything.

## Accounts

Each account is a freebuff config dir, selected with `FREEBUFF_CONFIG_DIR`.
Account 1 is your existing `~/.config/manicode`, so an already signed-in
freebuff works with nothing to copy; extra accounts live under
`~/.freebuffs/accounts/account-N/config/` and share the binary and support
files.

Rotation chooses the signed-in account used least recently, which spreads
freebuff's daily session limits. `--continue` reuses the account that last ran
in that folder, because conversation history lives inside the account's config
dir. When an account hits a limit or fails auth, the supervisor moves the
session — hand-off of the conversation included — to another usable account,
and leaves the broken one out until it is signed in again.

## Reports and the phone

```bash
sfreebuff notify <webhook-url>    # Discord reports on
sfreebuff voice on                # the phone line
sfreebuff voice status            # call link and settings
```

The webhook is stored in `~/.freebuffs/config.json`, readable only by you, and
is never printed or logged. The voice page is served on loopback and on this
machine's Tailscale address, so the call link opens from the phone as soon as it
is on the tailnet. iOS still needs HTTPS for the microphone: run
`tailscale serve --bg 8787`, then `sfreebuff voice url
https://<machine>.<tailnet>.ts.net`. If the Tailscale app shows the machine with
a grey dot, `sfreebuff voice status` (or `doctor`) names the cause and the fix.
Speech recognition and speech synthesis run on the phone, so audio never reaches
the machine.

## Data and configuration

Everything lives in `~/.freebuffs`:

```
state.json       accounts and session history
config.json      webhook, voice settings
accounts/        one isolated freebuff config dir per extra account
logs/            supervisor.log, supervisor.jsonl, diagnose-*.log
run/             monitor heartbeats and live session state
```

Set `FREEBUFFS_HOME` to relocate it. Nothing in this package contains accounts,
credentials, logs or any other user data — the supervised freebuff keeps its own
state in `~/.config/manicode` and in `~/.freebuffs` after you run it.

Frequently used settings: `FREEBUFFS_RESTART_MS`, `FREEBUFFS_STALL_MS`,
`FREEBUFFS_NUDGE_MS`, `FREEBUFFS_MAX_FAST_FAILURES`,
`FREEBUFFS_MAX_CLEAN_RESUMES`, `FREEBUFFS_LIMIT_WAIT_MS`, `FREEBUFFS_SUDO=0`,
`FREEBUFFS_PTY=0`, `FREEBUFFS_MONITOR_WINDOW=0`, `FREEBUFFS_CREDITS=0`,
`FREEBUFFS_VOICE_TAILNET_IP` (force the phone link's address, or `off`).

## What's new in 1.0.2

Long unattended tasks, and a phone line that actually opens on the phone.

- **Force continue** (Settings, off by default) types a continue prompt into the
  same conversation a minute after each finished turn, so freebuff works
  through every phase of a large task instead of stopping after the first. The
  prompt is editable and always ends by asking for
  `FREEBUFFS ALL TASKS COMPLETE`.
- **Shutdown timer** (off by default) powers the machine off once the agent
  writes that completion line, with a 15-minute backup deadline; starting a new
  session cancels a pending poweroff.
- **Optimization** (off by default) runs supervised sessions at a lower CPU
  priority, including the sessions already running, so two busy sessions cannot
  starve a small machine.
- **The call page opens from the phone.** The voice line also listens on the
  machine's Tailscale address and the link uses it instead of `127.0.0.1`; a
  trailing slash on the link works too.
- **A grey dot is explained.** `voice status` and `doctor` name why the phone
  cannot reach the machine — tailscaled stopped, backend down, node offline or
  an expired key — with the command that fixes it, and warn when
  `tailscale serve` is not proxying the port.
- **A session row always has a folder**, recovered from `--cwd` or from the
  folder the account was last used in instead of showing a blank cell.
- The settings screen fits a short terminal and no longer leaves the previous
  frame's text under a changed row.
- Stale `--cwd` values are replaced when a restart recovers a different folder,
  and the idle nudge moved to seven minutes with short, non-disruptive text.

See [CHANGELOG.md](CHANGELOG.md) for the full history.

## License

MIT — see [LICENSE](LICENSE).

Tests: `npm test` (stub freebuff binary; never touches a real sign-in).
