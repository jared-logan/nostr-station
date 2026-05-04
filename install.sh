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
  # Don't tell the user to `source ~/.bashrc` — nvm's hooks are written
  # in a way that some users find brittle to re-source mid-session, and
  # the simpler advice ("open a new terminal") works on every platform
  # we ship to without extra moving parts. Add the explicit one-liner
  # for users who don't want to spawn a new shell.
  warn "nostr-station not found on PATH in this shell."
  warn "Open a NEW terminal — your shell rc files will pick up the install automatically."
  echo "  Or run this one-liner in the current shell:"
  echo "    . ~/.nvm/nvm.sh && nostr-station onboard"
  echo ""
  echo "  If you'd rather edit your rc by hand, this PATH entry covers it:"
  echo "    export PATH=\"${NPM_GLOBAL_BIN}:\$PATH\""
  STATION_CMD="${NPM_GLOBAL_BIN}/nostr-station"
else
  STATION_CMD="nostr-station"
fi

# ── 5b. Lay down compose assets at ~/.nostr-station/compose/ ──────────────────
#
# The launcher (Phase 3+) shells `docker compose -f <here>/docker-compose.yml`
# against this stable path so end users never type docker compose themselves.
# We copy from the npm package's installed location rather than fetching from
# GitHub so the user's installed version always matches the assets they got.
#
# Idempotent: re-running install.sh overwrites the assets in place. Users who
# customized them locally lose those customizations on re-install — acceptable
# for now since the assets are infrastructure, not configuration.
COMPOSE_DIR="${HOME}/.nostr-station/compose"
NPM_PKG_DIR="$(npm root -g)/${NPM_PKG}"

if [[ -d "$NPM_PKG_DIR" ]]; then
  log "Laying down compose assets at ${COMPOSE_DIR}..."
  mkdir -p "$COMPOSE_DIR"
  for asset in docker-compose.yml Dockerfile.relay Dockerfile.station .dockerignore; do
    if [[ -f "${NPM_PKG_DIR}/${asset}" ]]; then
      cp "${NPM_PKG_DIR}/${asset}" "${COMPOSE_DIR}/${asset}"
    fi
  done
  if [[ -d "${NPM_PKG_DIR}/docker" ]]; then
    cp -R "${NPM_PKG_DIR}/docker" "${COMPOSE_DIR}/"
  fi
  ok "Compose assets at ${COMPOSE_DIR}"
else
  warn "npm package dir not found at ${NPM_PKG_DIR} — skipping compose-asset layout."
  warn "Re-run install.sh after the npm install completes if you intend to use the container stack."
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
  # Wrap with explicit exit-code capture (set +e) so we can run the
  # apt-family broken-state diagnostic (A10) on failure. Without this,
  # onboard's non-zero exit would tip set -euo pipefail's `-e` and
  # tear down the script before any actionable hint reached the user.
  set +e
  # Pass any pre-set env vars through — wizard reads process.env
  "${STATION_CMD}" onboard
  ONBOARD_EXIT=$?
  set -e
  echo ""

  if [[ $ONBOARD_EXIT -ne 0 ]]; then
    # A10 — apt-family broken-state hint.
    #
    # When onboard's installSystemDeps step runs `apt-get install`
    # against a host with half-configured packages, apt exits 100 with
    # a generic "could not configure pre-existing packages" line that
    # doesn't tell the user *what* to do — and onboard then bubbles
    # that up as a non-zero exit. dpkg --audit is the actionable
    # diagnostic: read-only (no sudo), lists exactly which packages
    # are in trouble. We only fire the hint when apt is the package
    # manager AND dpkg actually reports broken state, so a generic
    # onboard failure on Fedora / Arch / macOS still surfaces its
    # own error untouched.
    if command -v apt-get &>/dev/null && [[ -n "$(dpkg --audit 2>/dev/null)" ]]; then
      warn "apt is in an error state — dpkg has broken or half-configured packages."
      echo "  Clear it before retrying nostr-station:"
      echo "    sudo dpkg --configure -a"
      echo ""
      echo "  Then re-run:"
      echo "    nostr-station onboard"
      echo ""
    fi
    exit $ONBOARD_EXIT
  fi

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
  # Non-interactive branch (the curl | bash path) — make the success
  # banner LOUD. nvm's installer alone produces ~50+ lines of bash-rc /
  # rust-toolchain output before this point, so a quiet "✓ installed"
  # at the end gets buried in scroll. Two pieces:
  #   1. A clearly-rendered separator block + ASCII marker so the eye
  #      catches the success even when reviewing scrollback.
  #   2. A dropped file at ~/.nostr-station/install-complete.txt that
  #      the user can `cat` afterwards — the same content as the
  #      console banner, but durable.
  COMPLETE_DIR="${HOME}/.nostr-station"
  COMPLETE_FILE="${COMPLETE_DIR}/install-complete.txt"
  mkdir -p "${COMPLETE_DIR}"
  cat > "${COMPLETE_FILE}" <<EOF
nostr-station — install complete

The npm package is installed. To finish setup:

  1. Open a NEW terminal (so PATH picks up the npm global bin).
  2. Run one of:

       nostr-station                    # web dashboard + first-run wizard
       nostr-station onboard            # terminal wizard

If 'command not found': nvm hasn't loaded yet in this shell. Either
open a new terminal, or run the explicit one-liner:

       . ~/.nvm/nvm.sh && nostr-station onboard

If connecting via SSH:

       ssh -t user@host
       nostr-station onboard
EOF

  echo ""
  echo "════════════════════════════════════════════════════════════════"
  echo "  ✓ nostr-station installed"
  echo "════════════════════════════════════════════════════════════════"
  echo ""
  echo "  Open a NEW terminal and run:"
  echo ""
  echo "    nostr-station                    # web dashboard + first-run wizard"
  echo "    nostr-station onboard            # terminal wizard"
  echo ""
  echo "  These steps were saved to:"
  echo "    ${COMPLETE_FILE}"
  echo ""
  echo "  View again with:  cat ${COMPLETE_FILE}"
  echo ""
fi
