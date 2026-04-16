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
  NVM_FALLBACK="v0.40.3"
  NVM_LATEST=$(curl -fsSL --max-time 5 https://api.github.com/repos/nvm-sh/nvm/releases/latest \
    | grep '"tag_name"' | cut -d'"' -f4 2>/dev/null) || true
  if [[ -z "${NVM_LATEST:-}" ]]; then
    warn "Could not fetch latest nvm version — using fallback ${NVM_FALLBACK}"
    NVM_LATEST="$NVM_FALLBACK"
  fi
  curl -o- "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_LATEST}/install.sh" | bash
  # Source immediately — curl script wrote to .bashrc/.zshrc but we need
  # nvm active in this session right now, not after a shell restart
  # shellcheck disable=SC1091
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

# ── 6. SSH + tmux safety check ────────────────────────────────────────────────
if [[ -n "${SSH_CLIENT:-}" ]] || [[ -n "${SSH_TTY:-}" ]]; then
  if [[ -z "${TMUX:-}" ]]; then
    echo ""
    warn "Running over SSH. If your connection drops, the install will stop."
    echo "     For long Rust compiles we recommend running inside tmux:"
    echo ""
    if command -v tmux &>/dev/null; then
      echo "       tmux"
      echo "       nostr-station onboard"
      echo ""
      echo "       # If disconnected, reconnect and run:"
      echo "       tmux attach"
    else
      echo "       # Install tmux first:"
      if [[ "$OS" == "macos" ]]; then
        echo "       brew install tmux"
      else
        echo "       sudo apt install tmux   (or brew install tmux)"
      fi
      echo ""
      echo "       tmux"
      echo "       nostr-station onboard"
      echo ""
      echo "       # If disconnected, reconnect and run:"
      echo "       tmux attach"
    fi
    echo ""
    read -r -p "  Press Enter to continue anyway, or Ctrl+C to exit and use tmux. "
  fi
fi

# ── 7. Hand off to onboard wizard ─────────────────────────────────────────────
#
# The TUI wizard still owns heavy installs (Rust toolchain, nostr-rs-relay,
# systemd/launchd units). Once it completes successfully it marks
# identity.setupComplete = true, so subsequent `nostr-station` invocations
# skip the wizard and go straight to the dashboard.
#
# Power users who prefer the terminal can keep running `nostr-station
# onboard` directly. Everyone else just runs `nostr-station` — it opens
# the dashboard, or the web setup wizard at /setup if first-run state is
# still missing.
if [ -t 0 ]; then
  log "Launching onboard wizard..."
  echo ""
  # Pass any pre-set env vars through — wizard reads process.env
  "${STATION_CMD}" onboard
  echo ""
  ok "Setup complete."
  echo ""
  echo "  Next time, just run:"
  echo "    nostr-station                    # opens the dashboard in your browser"
  echo ""
  echo "  Or for the terminal UI:"
  echo "    nostr-station tui                # live events, logs, status"
  echo "    nostr-station onboard            # re-run this wizard"
  echo ""
else
  echo ""
  ok "nostr-station installed"
  echo ""
  echo "  No interactive terminal detected."
  echo "  To finish setup, open a terminal and run one of:"
  echo "    nostr-station                    # web dashboard + first-run wizard"
  echo "    nostr-station onboard            # terminal wizard"
  echo ""
  echo "  Or if connecting via SSH:"
  echo "    ssh -t user@host"
  echo "    nostr-station onboard"
  echo ""
fi
