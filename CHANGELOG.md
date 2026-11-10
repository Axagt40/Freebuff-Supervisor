# Changelog

All notable changes to FREEBUFF SUPERVISOR are documented here.

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
