#!/usr/bin/env bash
# Install nostr-station as a systemd --user unit that survives reboots.
#
# Defaults to wrapping the `nostr-station` command on PATH. Pass an
# explicit path as the first argument to override (e.g. for a dev
# checkout: ./scripts/install-systemd-unit.sh /home/me/code/nostr-station/dist/cli.js).
#
# What it does:
#   1. Resolves the nostr-station entry point.
#   2. Writes ~/.config/systemd/user/nostr-station.service.
#   3. Reloads the user systemd daemon and enables + starts the unit.
#   4. Enables linger so the service survives logout and persists across
#      reboots without an active login session.
#
# Idempotent: re-running overwrites the unit file with the current
# resolved binary path and restarts the service.

set -euo pipefail

# Resolve the entry point. Three forms supported:
#   - explicit path passed as $1 (taken verbatim — can be either a JS
#     entry like dist/cli.js or a wrapper binary)
#   - `nostr-station` on PATH (the typical install case)
#   - $NOSTR_STATION_BIN env override (for CI / packaging)
if [[ "${1:-}" != "" ]]; then
  entry="$1"
elif [[ -n "${NOSTR_STATION_BIN:-}" ]]; then
  entry="$NOSTR_STATION_BIN"
elif command -v nostr-station >/dev/null 2>&1; then
  entry="$(command -v nostr-station)"
else
  echo "install-systemd-unit: nostr-station not found on PATH." >&2
  echo "  Pass the entry-point path explicitly, e.g.:" >&2
  echo "  $0 /home/me/nostr-station/dist/cli.js" >&2
  exit 1
fi

# If `entry` is a .js file rather than an executable script, we have to
# launch it via node — the unit can't rely on the file's shebang in that
# case, since dist/cli.js is bundled without one in some build configs.
if [[ "$entry" == *.js ]]; then
  node_bin="$(command -v node)"
  if [[ -z "$node_bin" ]]; then
    echo "install-systemd-unit: node not found on PATH (required for .js entry)." >&2
    exit 1
  fi
  exec_start="$node_bin $entry serve"
else
  exec_start="$entry serve"
fi

unit_dir="$HOME/.config/systemd/user"
unit_path="$unit_dir/nostr-station.service"
mkdir -p "$unit_dir"

cat > "$unit_path" <<EOF
[Unit]
Description=nostr-station — Nostr-native dev environment
After=network.target

[Service]
# Foreground process; systemd treats the main pid as the service pid.
ExecStart=$exec_start
# Auto-restart on crash, but rate-limit so a misconfigured boot doesn't
# burn CPU in a fast-fail loop. 5 restarts in 60s == disable until the
# user investigates.
Restart=on-failure
RestartSec=5
StartLimitBurst=5
StartLimitIntervalSec=60
# Logs go to journald via stdout/stderr — view with:
#   journalctl --user -u nostr-station -f
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

echo "wrote $unit_path"

# Reload so the new file is picked up.
systemctl --user daemon-reload

# Enable linger so the service is up between login sessions and across
# reboots. Safe to call repeatedly. Some minimal containers lack
# loginctl; we warn but don't abort, since linger isn't strictly
# required for the service to run while the user is logged in.
if command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "$USER" || {
    echo "install-systemd-unit: enable-linger failed; the service will only run while you're logged in." >&2
  }
else
  echo "install-systemd-unit: loginctl not available; skipping enable-linger." >&2
fi

# Enable + (re)start.
systemctl --user enable --now nostr-station.service

echo
echo "nostr-station is now managed by systemd."
echo "  status:  systemctl --user status nostr-station"
echo "  logs:    journalctl --user -u nostr-station -f"
echo "  stop:    systemctl --user stop nostr-station"
echo "  start:   systemctl --user start nostr-station"
