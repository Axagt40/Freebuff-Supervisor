# Changelog

All notable changes to FREEBUFF SUPERVISOR are documented here.

## [1.0.2] — 2026-11-11

A release for long unattended tasks, plus a phone link that opens on the phone.

### Added

- **Force continue**, an off-by-default settings switch for very large tasks.
  freebuff stops after each phase even when told to finish everything, so the
  supervisor now types a continue prompt into the same conversation one minute
  after a finished turn, repeating until the agent says it is done. The prompt
  asks it to re-read the original request, work through every remaining phase
  and end with `FREEBUFFS ALL TASKS COMPLETE`. It can be replaced with your own
  text from the settings screen (`e`), and an empty edit restores the default;
  the completion line is appended to a custom prompt as well.
- **Shutdown timer**, an off-by-default settings switch that marks the work done
  when the agent writes that completion line and arms `wait-and-poweroff.sh`
  for the session, with a 15-minute backup deadline. The machine powers off
  when the session ends instead of staying on all night; starting a new session
  cancels a pending poweroff.

### Fixed

- **The call page loads from the phone.** The voice line listens on this
  machine's Tailscale address as well as loopback, and the call link uses that
  address instead of the `127.0.0.1` no phone can open. A link that arrives with
  a trailing slash is answered instead of rejected as unauthorized.
- **A grey dot on the phone is explained.** `sfreebuff voice status` and
  `doctor` read `tailscale status` and name the cause — tailscaled not running,
  a stopped backend, an offline node or an expired key — with the command that
  fixes it, and warn when `tailscale serve` is not proxying the line.
- **A session row no longer shows a blank folder.** Records without a stored
  `cwd` now take it from their own `--cwd` launch argument, and failing that
  from the folder the account was last used in.
- The settings screen keeps its switches and buttons on a short terminal, and
  no longer leaves the previous frame's text under a changed row.

### Changed

- Version bumped to 1.0.2 in the package, dashboard header and documentation.

## [1.0.1] — 2026-11-10

A reliability release. Sessions keep their folder, keep their conversation, and
keep working through failures that previously left them idle or stopped for a
person unnecessarily.

### Fixed

- **Restarts no longer open freebuff's project picker.** A relaunch, or a
  `--continue` run from the home folder or an ancestor of it, now recovers the
  most recently used real project from the supervisor's session records and
  freebuff's own `recent-projects.json`. Previously an unattended restart could
  sit on the folder list, which it can never leave. A new session is left where
  it was started so the person still chooses the folder.
- **A resumed conversation is no longer re-explained.** When the chat is
  genuinely resumed, the supervisor types a short "continue from where you left
  off" prompt instead of replaying the entire task on every restart. Sessions
  with no resumable chat still carry the recovered task in the prompt.
- **The task is recovered from the conversation being resumed.** The newest user
  message in the chat's own `chat-messages.json` is used, falling back to the
  account history only when the chat has none. The account-wide history can lag
  several turns after a restart, so the wrong task used to be restated.
  Structured/block message content is parsed as well as plain strings.
- **The supervisor's own keep-working nudge is never recovered as the task.**
  The short idle prompt is filtered out of task recovery, so it cannot replace
  the real work it was meant to continue.
- **Network timeouts are retried instead of ending the session.** freebuff's
  connection-timeout, "couldn't reach the server", aborted-request and
  connection-reset screens are recognised as a `timeout` state; the message is
  sent again (at most every 60 seconds) on the same conversation. Ordinary prose
  that merely talks about a timeout is not matched.
- **A session sitting on an error is pushed to continue.** If the TUI has drawn
  a failure, ended the turn and is waiting for a message that nothing will send,
  the task is typed in again after the screen settles (15 seconds, at most once
  per error every 10 minutes) instead of the session appearing alive while doing
  nothing until the 20-minute stall watch fires.
- **A quoted yes/no prompt no longer blocks nudges or rings the phone.** Only a
  dialog that has taken the empty input box away and stopped the turn counts as
  blocking. A question the agent printed in its own finished output used to hold
  every nudge still and escalate to the phone.
- **A stale `--cwd` is replaced when the folder is recovered.** If the
  supervisor switches to a recovered project, the launch's old `--cwd` no longer
  puts freebuff back on the picker.
- **The idle nudge is longer and safer.** It now fires after seven minutes
  (previously five) and uses short text that explicitly says to ignore it when
  work is already in progress, so a busy session is not interrupted.

### Changed

- Version bumped to 1.0.1 in the package, dashboard header and documentation.
- Help text describes the resume behaviour and the idle push as they now work.

## [1.0.0] — 2026-11-08

First public release.

- Multiple freebuff accounts, each an isolated config dir, selected
  automatically and rotated to spread free session limits.
- A 24/7 supervision loop that resumes the same conversation after a crash, a
  stall, a dropped connection or a used-up free session, with backoff and
  bounded stop conditions.
- A live terminal dashboard of every account, its credits and every session,
  with mouse support and clickable actions.
- Dialog auto-answering on a pty, escalation of anything risky to a person,
  automatic diagnosis of bad endings, Discord reports and an optional phone line.
- Only a session whose recorded pid is still the freebuff process counts as
  live; leftover rows are reported as `lost` and can be cleared.
