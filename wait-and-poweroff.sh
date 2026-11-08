#!/bin/sh
# Power this machine off unattended, without a password.
#
#   ./wait-and-poweroff.sh <pid ...>           wait for those pids + the marker
#   FREEBUFFS_POWEROFF_AFTER_MINUTES=240 ./wait-and-poweroff.sh
#                                              backup: power off after N minutes
#
# The shutdown goes through systemd-logind's PowerOff, which an active local
# session may call without authentication (sudo would need a password nobody is
# here to type). It falls back to `systemctl poweroff`.
#
# Wait mode: every given pid must be gone AND ~/.freebuffs/agent-done must
# exist. The marker is written when the agent finished its work, so a finished
# agent cannot cut a running session short and an ended session cannot leave the
# machine on. The freebuff process that owns the other session is a pid here.
#
# Timer mode: no pids, just FREEBUFFS_POWEROFF_AFTER_MINUTES, so a machine is
# never left on because the watcher died or a session hangs forever.
#
# Cancel everything before it fires:
#
#   touch ~/.freebuffs/shutdown-cancel
#
# Dry run (logs the decision, powers off nothing):
#
#   FREEBUFFS_POWEROFF_DRY_RUN=1 ./wait-and-poweroff.sh <pid ...>

set -u

DRY_RUN="${FREEBUFFS_POWEROFF_DRY_RUN:-0}"
STATE_HOME="${FREEBUFFS_HOME:-$HOME/.freebuffs}"
MARKER="$STATE_HOME/agent-done"
CANCEL="$STATE_HOME/shutdown-cancel"
LOG="$STATE_HOME/shutdown.log"
POLL="${FREEBUFFS_POWEROFF_POLL_SECONDS:-15}"
AFTER_MIN="${FREEBUFFS_POWEROFF_AFTER_MINUTES:-0}"
AFTER_SEC="${FREEBUFFS_POWEROFF_AFTER_SECONDS:-0}"
PIDS="$*"

if [ "$AFTER_SEC" = "0" ] && [ "$AFTER_MIN" != "0" ]; then
  AFTER_SEC=$((AFTER_MIN * 60))
fi

if [ -z "$PIDS" ] && [ "$AFTER_SEC" = "0" ]; then
  echo "usage: $0 [pid ...]  and/or  FREEBUFFS_POWEROFF_AFTER_MINUTES=N" >&2
  exit 2
fi

mkdir -p "$STATE_HOME"
log () {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"
}

# A closed terminal must not disarm the shutdown.
trap '' HUP

START="$(date +%s)"
DEADLINE=$((START + AFTER_SEC))

if [ "$AFTER_SEC" -ge 60 ]; then
  DEADLINE_TEXT="$((AFTER_SEC / 60))m"
else
  DEADLINE_TEXT="${AFTER_SEC}s"
fi
if [ -n "$PIDS" ] && [ "$AFTER_SEC" != "0" ]; then
  MODE="watch pids:$PIDS and $MARKER, backup in $DEADLINE_TEXT"
elif [ -n "$PIDS" ]; then
  MODE="watch pids:$PIDS and $MARKER"
else
  MODE="timer only, backup in $DEADLINE_TEXT"
fi
log "armed: $MODE"

poweroff_now () {
  log "$*"
  if [ "$DRY_RUN" = "1" ]; then
    log "dry run: would power off now"
    exit 0
  fi
  sync
  if command -v gdbus >/dev/null 2>&1 &&
     gdbus call --system \
       --dest org.freedesktop.login1 \
       --object-path /org/freedesktop/login1 \
       --method org.freedesktop.login1.Manager.PowerOff false >/dev/null 2>&1; then
    log "poweroff sent through logind"
    exit 0
  fi
  if command -v systemctl >/dev/null 2>&1 && systemctl poweroff; then
    exit 0
  fi
  command -v poweroff >/dev/null 2>&1 && poweroff
  log "could not power off; nobody is logged in to try by hand"
  exit 1
}

while :; do
  if [ -f "$CANCEL" ]; then
    log "cancelled by $CANCEL; nothing will be shut down"
    rm -f "$CANCEL"
    exit 0
  fi

  alive=""
  for pid in $PIDS; do
    if kill -0 "$pid" 2>/dev/null; then
      alive="$alive $pid"
    fi
  done

  if [ -n "$PIDS" ] && [ -z "$alive" ] && [ -f "$MARKER" ]; then
    poweroff_now "work finished: $PIDS gone, agent done"
  fi

  now="$(date +%s)"
  if [ "$AFTER_SEC" != "0" ] && [ "$now" -ge "$DEADLINE" ]; then
    reason="backup deadline reached"
    [ -n "$alive" ] && reason="$reason; still running:$alive"
    poweroff_now "$reason"
  fi

  sleep "$POLL"
done
