#!/usr/bin/env bash
# nostr-station installer
# Usage: curl -fsSL https://raw.githubusercontent.com/jared-logan/nostr-station/main/install.sh | bash
# Or:    NPUB=npub1... bash <(curl -fsSL ...)
set -euo pipefail

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RESET='\033[0m'
log()  { echo -e "${CYAN}▸${RESET} $*"; }
ok()   { echo -e "${GREEN}✓${RESET} $*"; }
warn() { echo -e "${YELLOW}⚠${RESET}  $*"; }

REQUIRED_NODE=22
NPM_PKG="nostr-station"

# ── 1. Detect OS ───────────────────────────────────────────────────────────────
case "$(uname -s)" in
  Darwin) OS="macos" ;;
  Linux)  OS="linux" ;;
  *)      echo "Unsupported OS: $(uname -s)"; exit 1 ;;
esac

# ── 2. Source nvm if already installed (handles existing installs) ─────────────
export NVM_DIR="${HOME}/.nvm"
# shellcheck disable=SC1091
[ -s "${NVM_DIR}/nvm.sh" ] && source "${NVM_DIR}/nvm.sh"

# ── 3. Node — install if missing or too old ────────────────────────────────────
node_version() {
  node -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null || echo "0"
}

if [[ "$(node_version)" -lt "$REQUIRED_NODE" ]]; then
  log "Node ${REQUIRED_NODE}+ not found — installing via nvm..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  # Source immediately — curl script wrote to .bashrc/.zshrc but we need
  # nvm active in this session right now, not after a shell restart
  [ -s "${NVM_DIR}/nvm.sh" ] && source "${NVM_DIR}/nvm.sh"
  nvm install --lts
  nvm use --lts
  ok "Node $(node --version) ready"
else
  ok "Node $(node --version) found"
fi

# ── 4. Ensure npm global bin is on PATH ────────────────────────────────────────
# npm prefix -g can differ between system Node and nvm Node
NPM_GLOBAL_BIN="$(npm prefix -g)/bin"
export PATH="${NPM_GLOBAL_BIN}:${PATH}"

# ── 5. Install nostr-station npm package ───────────────────────────────────────
log "Installing nostr-station..."
npm install -g "${NPM_PKG}@latest" --quiet
ok "nostr-station installed"

# Confirm the binary is reachable — if not, fall back to direct path
if ! command -v nostr-station &>/dev/null; then
  warn "nostr-station not found on PATH yet."
  warn "Add this to your ~/.zshrc or ~/.bashrc and restart your shell:"
  echo "  export PATH=\"${NPM_GLOBAL_BIN}:\$PATH\""
  STATION_CMD="${NPM_GLOBAL_BIN}/nostr-station"
else
  STATION_CMD="nostr-station"
fi

# ── 6. Hand off to Ink wizard ─────────────────────────────────────────────────
log "Launching onboard wizard..."
echo ""

# Pass any pre-set env vars through — wizard reads process.env
"${STATION_CMD}" onboard
