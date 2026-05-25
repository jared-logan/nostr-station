#!/usr/bin/env bash
# nostr-station installer
#   curl -fsSL https://raw.githubusercontent.com/jared-logan/nostr-station/main/install.sh | bash
#
# What this does, in order:
#   1. Detect the OS (macOS / Linux). Refuse anything else.
#   2. Check that git is available — required for the clone/update step.
#   2b. Check that `make`, a C++ compiler, and `python3` are available —
#       required for the node-gyp source builds of better-sqlite3 +
#       node-pty when no platform prebuild is published.
#   3. Install Node 22+ via nvm if missing or too old. Silent.
#   4. Clone nostr-station to ~/nostr-station (or fast-forward if already
#      present), install dependencies, build, and `npm link` so the
#      `nostr-station` command resolves to bin/nostr-station.sh in that
#      checkout. The wrapper relaunches node on dist/cli.js whenever the
#      dashboard exits with code 75 (used by the in-app "Update" button).
#   5. exec nostr-station — the dashboard boots, the browser opens.
#
# Re-running this script upgrades an existing install: the git checkout
# fast-forwards to origin/main, dependencies are refreshed, and the
# build is rerun.
#
# What it does NOT do:
#   - install Docker, OrbStack, or docker-compose
#   - install Rust / cargo / system build tools (only detects them)
#   - run sudo or apt-get
#   - publish or consume an npm registry package
#
# Total time on a warm machine: ~30-45 seconds (npm ci is the bulk).

set -euo pipefail

CYAN='\033[0;36m'; GREEN='\033[0;32m'; RESET='\033[0m'
log() { echo -e "${CYAN}▸${RESET} $*"; }
ok()  { echo -e "${GREEN}✓${RESET} $*"; }

REQUIRED_NODE=22
INSTALL_DIR="${HOME}/nostr-station"
REPO_URL="https://github.com/jared-logan/nostr-station.git"

# 1 — OS guard
case "$(uname -s)" in
  Darwin|Linux) ;;
  *) echo "Unsupported OS: $(uname -s) — nostr-station only supports macOS and Linux."; exit 1 ;;
esac

# 2 — git guard. We build from source now, so git is a hard requirement.
# macOS ships git (or prompts for xcode-select install); Linux distros
# usually ship git but minimal images sometimes don't.
if ! command -v git >/dev/null 2>&1; then
  echo "git is required to install nostr-station from source."
  echo "Install git first, then re-run this script."
  echo "  macOS:   xcode-select --install   (provides git)"
  echo "  Debian:  sudo apt-get install -y git"
  echo "  Fedora:  sudo dnf install -y git"
  exit 1
fi

# 2b — build toolchain. better-sqlite3 + node-pty are native node modules.
# When a prebuild matching the host's platform/arch/glibc isn't published
# (common on freshly-released distros or unusual arch combinations), npm
# falls back to source compilation via node-gyp, which needs `make`, a
# C++ compiler, and `python3`. Without these the install dies inside
# `npm ci` with an error that — even with --silent dropped — reads as a
# wall of node-gyp output. Detecting up-front gives the user a one-line
# fix instead of a stack trace to decode.
missing_build_tools=""
command -v make    >/dev/null 2>&1 || missing_build_tools+=" make"
command -v python3 >/dev/null 2>&1 || missing_build_tools+=" python3"
case "$(uname -s)" in
  Darwin)
    # Xcode CLI Tools provide clang/clang++ + make + python3 together,
    # so any one of them missing means the whole kit is absent.
    command -v clang++ >/dev/null 2>&1 || command -v c++ >/dev/null 2>&1 \
      || missing_build_tools+=" clang++"
    ;;
  Linux)
    # build-essential pulls in g++ on Debian/Ubuntu; Fedora's
    # "Development Tools" group has the equivalent.
    command -v g++ >/dev/null 2>&1 || command -v c++ >/dev/null 2>&1 \
      || missing_build_tools+=" g++"
    ;;
esac

if [ -n "${missing_build_tools}" ]; then
  echo "Build tools are required to compile native dependencies"
  echo "(better-sqlite3 + node-pty) when a prebuild isn't available for"
  echo "your platform."
  echo ""
  echo "Missing:${missing_build_tools}"
  echo ""
  echo "Install the toolchain, then re-run this script:"
  echo "  macOS:   xcode-select --install   (provides clang, make, python3)"
  echo "  Debian:  sudo apt-get install -y build-essential python3"
  echo "  Fedora:  sudo dnf groupinstall -y 'Development Tools' && sudo dnf install -y python3"
  echo "  Alpine:  sudo apk add build-base python3"
  echo "  Arch:    sudo pacman -S --needed base-devel python"
  exit 1
fi

# 3 — Node. Source nvm first in case it's already installed (handles
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

# 4 — clone or update the source checkout, install deps, build, link.
#
# Three states for INSTALL_DIR:
#   (a) doesn't exist          → clone fresh
#   (b) exists as a git repo   → fast-forward pull (upgrade path)
#   (c) exists but no .git/    → refuse loudly. We don't want to clobber
#                                a user's unrelated directory.
if [ -d "${INSTALL_DIR}/.git" ]; then
  log "Updating existing checkout at ${INSTALL_DIR}…"
  git -C "${INSTALL_DIR}" fetch origin main --quiet
  git -C "${INSTALL_DIR}" merge --ff-only origin/main --quiet
elif [ -d "${INSTALL_DIR}" ]; then
  echo "Error: ${INSTALL_DIR} exists but isn't a git checkout."
  echo "  Move it aside first:"
  echo "    mv ${INSTALL_DIR} ${INSTALL_DIR}.bak"
  echo "  Then re-run this installer."
  exit 1
else
  log "Cloning nostr-station into ${INSTALL_DIR}…"
  git clone "${REPO_URL}" "${INSTALL_DIR}" --quiet
fi

cd "${INSTALL_DIR}"

log "Installing dependencies…"
# `npm ci` (not `npm install`) so the working tree stays clean across
# installs. `npm install` can nudge package-lock.json on every run
# (npm-version drift, platform-specific optional deps, registry
# metadata refresh) which would leave a fresh install with a dirty
# lockfile — the in-app one-click update flow refuses to pull on a
# dirty tree, so a user's first Update click would fail until they
# manually `git checkout package-lock.json`. `npm ci` strictly
# installs from the committed lockfile and never writes back.
#
# `--silent` removed deliberately: when a native module build fails
# (better-sqlite3 / node-pty falling back to source compile), --silent
# hides the node-gyp output and the user sees only an opaque exit 1.
# Letting npm's normal logging through means a real install error
# stays visible. Step 2b above pre-empts the most common cause
# (missing build tools) so the happy-path output is still tidy.
npm ci --no-audit --no-fund

log "Building…"
# STATION_SKIP_DITTO=1 short-circuits scripts/fetch-ditto.mjs so the
# Ditto source build (git clone soapbox-pub/ditto + npm ci on 1k+
# packages + vite build, typically 3-5 min) doesn't pad the install.
# The Client panel detects a missing dist/ditto/ at runtime and shows
# a "Build Ditto now" button that runs the build on demand — users
# opt into the wait the first time they actually open the panel,
# rather than every installer paying for it upfront.
STATION_SKIP_DITTO=1 npm run build --silent

# Wrapper script needs the execute bit. We tracked it as 0755 in git but a
# fresh clone in some environments (umask 0077, ZIP downloads) lands it
# at 0644 — npm-link the wrapper without +x and the global command
# silently produces "Permission denied". Idempotent chmod here.
if [ -f "${INSTALL_DIR}/bin/nostr-station.sh" ]; then
  chmod +x "${INSTALL_DIR}/bin/nostr-station.sh"
fi

log "Linking the nostr-station command globally…"
# npm link is idempotent — re-running just refreshes the symlink. The
# command resolves to bin/nostr-station.sh inside this checkout, which
# in turn runs dist/cli.js. The wrapper restarts node on exit code 75
# so the in-app "Update" button can hot-replace the build without the
# user touching the terminal. Subsequent `git pull && npm run build`
# upgrades still pick up automatically with no re-link needed.
npm link --silent
ok "nostr-station installed at ${INSTALL_DIR}"

# 5 — launch immediately. exec replaces this shell so the user lands
# straight in the dashboard process; Ctrl+C inside nostr-station ends
# both the dashboard and this script in one shot, no orphaned PIDs.
echo ""
echo "Launching nostr-station…"
exec nostr-station
