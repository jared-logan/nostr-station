#!/usr/bin/env bash
# nostr-station installer
#   curl -fsSL https://raw.githubusercontent.com/jared-logan/nostr-station/main/install.sh | bash
#
# What this does, in order:
#   1. Detect the OS (macOS / Linux). Refuse anything else.
#   2. Install Node 22+ via nvm if it's missing or too old. Silent.
#   3. npm install -g nostr-station. Silent.
#   4. exec nostr-station — the dashboard boots, the browser opens.
#
# What it does NOT do (no longer needed since the in-process relay landed):
#   - install Docker, OrbStack, or docker-compose
#   - install Rust / cargo / system build tools
#   - run sudo or apt-get
#   - copy compose assets to ~/.nostr-station/
#
# The whole pipeline finishes in ~10 seconds on a warm machine.

set -euo pipefail

CYAN='\033[0;36m'; GREEN='\033[0;32m'; RESET='\033[0m'
log() { echo -e "${CYAN}▸${RESET} $*"; }
ok()  { echo -e "${GREEN}✓${RESET} $*"; }

REQUIRED_NODE=22
NPM_PKG="nostr-station"

# 1 — OS guard
case "$(uname -s)" in
  Darwin|Linux) ;;
  *) echo "Unsupported OS: $(uname -s) — nostr-station only supports macOS and Linux."; exit 1 ;;
esac

# 2 — Node. Source nvm first in case it's already installed (handles
# fresh shells on systems where the user installed nvm previously but
# hasn't restarted their terminal). Then check Node version; install
# only if missing or too old.
export NVM_DIR="${HOME}/.nvm"
# shellcheck disable=SC1091
[ -s "${NVM_DIR}/nvm.sh" ] && source "${NVM_DIR}/nvm.sh"

current_node_major() {
  node -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null || echo 0
}

if [ "$(current_node_major)" -lt "${REQUIRED_NODE}" ]; then
  log "Installing Node ${REQUIRED_NODE}+ (one-time, ~30s)…"
  # nvm's install script writes to .bashrc/.zshrc; we source nvm.sh in
  # this shell directly so the rest of this script can use `nvm`/`node`.
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash >/dev/null 2>&1
  # shellcheck disable=SC1091
  source "${NVM_DIR}/nvm.sh"
  nvm install --lts >/dev/null 2>&1
  nvm use --lts >/dev/null 2>&1
fi
ok "Node $(node --version) ready"

# Make sure the global npm bin is on PATH inside this shell. nvm-managed
# Node installs put global binaries somewhere npm-prefix knows but the
# shell may not have picked up yet (no rc reload mid-script).
NPM_BIN="$(npm prefix -g)/bin"
export PATH="${NPM_BIN}:${PATH}"

# 3 — install nostr-station globally. --silent suppresses npm's per-package
# progress chatter; errors still surface because of `set -e`.
log "Installing nostr-station…"
npm install -g "${NPM_PKG}@latest" --silent
ok "nostr-station installed"

# 4 — launch immediately. exec replaces this shell so the user lands
# straight in the dashboard process; Ctrl+C inside nostr-station ends
# both the dashboard and this script in one shot, no orphaned PIDs.
echo ""
echo "Launching nostr-station…"
exec nostr-station
