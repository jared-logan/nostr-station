#!/usr/bin/env bash
# Reverse of install-systemd-unit.sh.
#
# Stops the unit, disables it, removes the unit file, and (optionally)
# revokes linger. Leaves ~/.nostr-station/ alone — that's data, not
# service plumbing.

set -euo pipefail

unit_dir="$HOME/.config/systemd/user"
unit_path="$unit_dir/nostr-station.service"

if systemctl --user is-active nostr-station.service >/dev/null 2>&1; then
  systemctl --user stop nostr-station.service || true
fi
if systemctl --user is-enabled nostr-station.service >/dev/null 2>&1; then
  systemctl --user disable nostr-station.service || true
fi

if [[ -f "$unit_path" ]]; then
  rm -f "$unit_path"
  echo "removed $unit_path"
else
  echo "no unit file at $unit_path (nothing to remove)"
fi

systemctl --user daemon-reload

# Only revoke linger if the user passed --revoke-linger explicitly.
# Many users will have linger enabled for other reasons (other --user
# services, tmux sessions, etc.); silently revoking it would break
# unrelated things.
if [[ "${1:-}" == "--revoke-linger" ]]; then
  if command -v loginctl >/dev/null 2>&1; then
    loginctl disable-linger "$USER" || true
    echo "revoked linger for $USER"
  fi
fi

echo "done."
