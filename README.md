# FREEBUFF SUPERVISOR — v1.0.0

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
  FREEBUFFS  supervisor dashboard  v1.0.0                            23:12:04
────────────────────────────────────────────────────────────────────────────
  FREEBUFF SUPERVISOR v1.0.0 — freebuff sessions, kept running unattended
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
- **freebuff**, installed separately (`npm install -g freebuff`). The supervisor
  launches and watches that binary; it does not bundle it.
- Optional: `node-pty` for auto-answering dialogs and typing into a session
  (`install.sh` tries to build it; everything else works without it).

## Install

**From this package folder:**

```bash
sh install.sh
```

It checks Node, installs the optional dependency and puts `sfreebuff` on your
`PATH`. Nothing is started and no account is signed in until you ask.

**From the tarball directly:**

```bash
npm install -g ./freebuff-supervisor-1.0.0.tgz
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
  freebuff with `--continue`, backs off between attempts, and types the last real
  task into a resumed conversation so the work continues. A clean exit in the
  middle of a turn is recognised as a cut-off task, not a finished one.
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
| `s` | settings — the **Voice calls** switch |
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
is never printed or logged. The voice page is served locally and reached over
Tailscale (`tailscale serve --bg 8787`); speech recognition and speech synthesis
run on the phone, so audio never reaches the machine.

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
`FREEBUFFS_PTY=0`, `FREEBUFFS_MONITOR_WINDOW=0`, `FREEBUFFS_CREDITS=0`.

## What's new in 1.0.0

- A session counts as **live** only while its recorded pid is still the freebuff
  process (or its supervisor), not merely a number that is alive — so the
  dashboard no longer shows phantom live sessions.
- `x` on such a leftover row **clears the record** instead of refusing forever,
  and `status` reports live sessions the same way.
- A **new** session starts its own conversation; `enter` on an existing session
  row reads `enter continue` and resumes that conversation with the continue
  prompt.
- Account rotation picks the longest-idle usable account and skips accounts that
  reported an error, are cooling down, or have an expired token.
- Version number and watermark in the dashboard header.

## License

MIT — see [LICENSE](LICENSE).

Tests: `npm test` (stub freebuff binary; never touches a real sign-in).
