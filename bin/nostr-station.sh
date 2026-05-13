#!/usr/bin/env bash
# nostr-station launcher with respawn-on-update support.
#
# The dashboard exits with code 75 (EX_TEMPFAIL) when the user applies an
# in-place update from the web UI — this wrapper restarts node so the new
# dist/cli.js takes effect without the user touching the terminal. Any
# other exit code is propagated as-is (including SIGINT/SIGTERM).
#
# `npm link` symlinks this script to the global PATH, so the resolved
# location is e.g. ~/.nvm/.../bin/nostr-station -> ~/nostr-station/bin/
# nostr-station.sh. We follow the symlink to find dist/cli.js next door.

set -u

resolve_self() {
  local src="$1"
  while [ -L "$src" ]; do
    local dir
    dir="$(cd -P "$(dirname "$src")" && pwd)"
    src="$(readlink "$src")"
    [[ "$src" != /* ]] && src="$dir/$src"
  done
  echo "$(cd -P "$(dirname "$src")" && pwd)"
}

BIN_DIR="$(resolve_self "$0")"
CLI="${BIN_DIR}/../dist/cli.js"

if [ ! -f "$CLI" ]; then
  echo "nostr-station: build artifact missing at $CLI" >&2
  echo "Run: cd $(dirname "$BIN_DIR") && npm run build" >&2
  exit 1
fi

while true; do
  node "$CLI" "$@"
  ec=$?
  if [ "$ec" -eq 75 ]; then
    # Update applied — loop and re-exec. A short pause keeps the
    # browser's reconnect poll from racing the listening socket.
    sleep 1
    continue
  fi
  exit "$ec"
done
