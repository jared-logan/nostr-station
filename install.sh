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

# ── 1b. Detect Docker ─────────────────────────────────────────────────────────
#
# nostr-station runs as a docker-compose stack. Without docker the
# launcher (`nostr-station start`) can't bring anything up. Don't fail
# the install — Node + the launcher binary are still useful, and the
# user may install Docker afterwards. Just print actionable next-steps
# so the missing dep is obvious before they hit it from the launcher.
DOCKER_OK=true
if ! command -v docker &>/dev/null; then
  DOCKER_OK=false
  warn "docker not found on PATH."
  if [[ "$OS" == "macos" ]]; then
    echo "  Install OrbStack (recommended for Apple Silicon — fast, low-memory):"
    echo "    https://orbstack.dev/download"
    echo "  Or Docker Desktop:"
    echo "    https://www.docker.com/products/docker-desktop"
  else
    echo "  Install via your package manager:"
    echo "    sudo apt install -y docker.io docker-compose-plugin   # Debian/Ubuntu"
    echo "    sudo dnf install -y docker docker-compose-plugin      # Fedora"
    echo "  Or follow the official install guide:"
    echo "    https://docs.docker.com/engine/install/"
  fi
  echo ""
elif ! docker info &>/dev/null; then
  DOCKER_OK=false
  warn "docker is installed but the daemon is not responding."
  echo "  Start Docker Desktop / OrbStack, then run \`nostr-station\` again."
  echo ""
else
  ok "docker $(docker --version | sed 's/^Docker //; s/,.*//')"
fi

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

# Confirm the binary is reachable — if not, surface the fix without
# making the user re-source their shell rc.
if ! command -v nostr-station &>/dev/null; then
  warn "nostr-station not found on PATH in this shell."
  warn "Open a NEW terminal — your shell rc files will pick up the install automatically."
  echo "  Or run this one-liner in the current shell:"
  echo "    . ~/.nvm/nvm.sh && nostr-station"
  echo ""
  echo "  If you'd rather edit your rc by hand, this PATH entry covers it:"
  echo "    export PATH=\"${NPM_GLOBAL_BIN}:\$PATH\""
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

# ── 6. Final message ──────────────────────────────────────────────────────────
#
# The install path is intentionally fast: no Rust compile, no apt
# install, no host relay binary. The heavy work (image pulls/builds)
# happens lazily on first `nostr-station start`. The final banner is
# just "you're done; here's how to launch", with the only branch being
# whether docker is reachable.

COMPLETE_DIR="${HOME}/.nostr-station"
COMPLETE_FILE="${COMPLETE_DIR}/install-complete.txt"
mkdir -p "${COMPLETE_DIR}"
cat > "${COMPLETE_FILE}" <<EOF
nostr-station — install complete

The launcher binary and compose assets are in place at:
  ${COMPOSE_DIR:-${HOME}/.nostr-station/compose}

To start the stack:

  nostr-station                    # brings up docker compose + opens the dashboard

Other launcher commands:
  nostr-station start              # same as bare invocation
  nostr-station stop               # bring stack down (volumes preserved)
  nostr-station ps                 # show container status
  nostr-station --help             # full reference

If you don't have Docker yet, install it first:
  macOS: https://orbstack.dev/download  or  https://www.docker.com/products/docker-desktop
  Linux: sudo apt install -y docker.io docker-compose-plugin
EOF

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  ✓ nostr-station installed"
echo "════════════════════════════════════════════════════════════════"
echo ""
if [[ "$DOCKER_OK" == "true" ]]; then
  echo "  Run \`nostr-station\` to bring up the dashboard."
else
  echo "  Install Docker (instructions above), then run:"
  echo "    nostr-station"
fi
echo ""
echo "  Notes saved to ${COMPLETE_FILE}"
echo ""
