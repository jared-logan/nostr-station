// nvpn privileged helper — root-owned, fixed-verb interface.
//
// SECURITY MODEL (why this exists). The dashboard runs as an unprivileged
// user and must perform a few privileged ops (place the binary on a system
// PATH, install/manage the systemd service, clear root-owned daemon state).
// The naive approaches are all root-equivalent escalations:
//   * `sudo -v` cache-warming  → opens a window where the dashboard can run
//     ANYTHING as root.
//   * NOPASSWD for `nvpn …`     → the binary lives in a user-writable dir
//     (~/.cargo/bin), so a compromised dashboard swaps it and gets root.
//   * NOPASSWD for a command list with unconstrained args → e.g.
//     `nvpn install-cli <attacker-path>` escalates.
//
// Instead: a single root-owned, NON-user-writable helper script at
// /usr/local/lib/nostr-station/nvpn-admin exposing a FIXED set of verbs.
// sudoers grants NOPASSWD ONLY for `<helper> <verb>` — each verb a complete
// Cmnd with no wildcards and no trailing args. The helper:
//   (A) lives in a root-owned, root-only-writable dir and invokes only the
//       root-owned /usr/local/bin/nvpn — never the cargo-bin copy;
//   (B) takes ZERO user-controlled input: exactly one verb, no other args,
//       a sanitized PATH, and paths derived only from SUDO_USER (set by
//       sudo, not forgeable) — never from arguments or env;
//   (C) re-verifies the staged tarball's SHA256 against a root-owned
//       manifest before installing, so a swapped/forged binary is refused.
//
// Every binary on the privileged path (the helper AND the nvpn it runs) is
// root-owned in a root-owned directory. The escalation tests (binary-swap,
// extra-args, drop-in injection) all refuse by construction.

import { execa } from 'execa';
import fs from 'fs';
import os from 'os';
import { getNvpnTarget } from './detect.js';
import { COMPONENT_VERSIONS, BINARY_SHA256 } from './versions.js';

// ── Fixed, root-owned locations ───────────────────────────────────────────
export const ADMIN_LIB_DIR   = '/usr/local/lib/nostr-station';
export const ADMIN_HELPER     = `${ADMIN_LIB_DIR}/nvpn-admin`;
export const ADMIN_MANIFEST   = `${ADMIN_LIB_DIR}/nvpn.manifest`;
export const ADMIN_NVPN_BIN   = '/usr/local/bin/nvpn';
export const ADMIN_SUDOERS    = '/etc/sudoers.d/nostr-station-nvpn';
// Where the dashboard stages the verified tarball for the helper to pick up
// (relative to the invoking user's home; the helper derives it from
// SUDO_USER, never from an argument).
export const ADMIN_STAGE_REL  = '.cache/nostr-station/nvpn-staged.tar.gz';

const SUDO_TIMEOUT_MS = 60_000;

// The COMPLETE set of privileged verbs the dashboard performs. Each maps to
// a single sudoers Cmnd. If a privileged op isn't here it would still need
// broad sudo — so this list must cover everything.
export const ADMIN_VERBS = [
  'check',        // no-op probe — confirms the NOPASSWD grant is active
  'install',      // verify staged tarball, place binary, service install, drop-ins
  'reinstall',    // alias of install (snapshot+restore guards a failed swap)
  'uninstall',    // service uninstall, remove binary + our drop-ins
  'enable', 'disable',
  'start', 'stop', 'restart',
  'reset-peers',  // stop, clear daemon.recent-peers.json, start
] as const;
export type AdminVerb = (typeof ADMIN_VERBS)[number];

// ── Pure renderers (unit-tested for their security properties) ────────────

// The sudoers grant: NOPASSWD for ONLY `<helper> <verb>`, each a complete
// command with no wildcards and no trailing args. References ONLY the
// root-owned helper path — never nvpn, systemctl, tee, or the cargo path.
export function renderAdminSudoers(user: string): string {
  const cmnds = ADMIN_VERBS.map(v => `${ADMIN_HELPER} ${v}`).join(', ');
  return `${user} ALL=(root) NOPASSWD: ${cmnds}\n`;
}

// The root-owned manifest the helper reads for install: the pinned tag and
// per-target tarball SHA256. Shell-sourceable `KEY=value` lines; values are
// our own pinned constants (hex shas + a semver tag), never user input.
export function renderAdminManifest(
  tag: string, shas: Record<string, string>,
): string {
  const lines = [`NVPN_TAG='${tag}'`];
  for (const [target, sha] of Object.entries(shas)) {
    // target → shell-safe var name (dashes to underscores)
    lines.push(`NVPN_SHA_${target.replace(/[^A-Za-z0-9]/g, '_')}='${sha}'`);
  }
  return lines.join('\n') + '\n';
}

// The helper script itself (runs as root). Self-contained, hardcoded paths,
// zero user-controlled input. Exported so provisioning can embed it AND so
// tests can assert its security properties.
export function renderAdminHelperScript(): string {
  return `#!/usr/bin/env bash
# nostr-station privileged helper. Installed root:root, 0755, in a
# root-owned directory. Invoked ONLY as \`sudo ${ADMIN_HELPER} <verb>\`.
# Takes a FIXED verb and nothing else — no extra args, no env-controlled
# paths. Every path is hardcoded or derived from SUDO_USER (set by sudo).
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 022

readonly NVPN_BIN=${ADMIN_NVPN_BIN}
readonly LIB_DIR=${ADMIN_LIB_DIR}
readonly MANIFEST=${ADMIN_MANIFEST}
readonly PREV_BIN="\$LIB_DIR/nvpn.prev"
readonly UNIT=nvpn.service
readonly DROPIN_DIR="/etc/systemd/system/\${UNIT}.d"
readonly CAPS_DROPIN="\$DROPIN_DIR/10-nostr-station-caps.conf"
readonly CONFIG_DROPIN="\$DROPIN_DIR/20-nostr-station-config.conf"

die() { echo "nvpn-admin: \$*" >&2; exit 1; }

[ "\$(id -u)" -eq 0 ] || die "must run as root (via sudo)"
[ "\$#" -eq 1 ]       || die "exactly one verb, no arguments"
verb=\$1

# Real (invoking) user — set by sudo, not forgeable by the caller. Used
# ONLY to locate the canonical config + staged tarball, never to run.
real_user=\${SUDO_USER:-}
[ -n "\$real_user" ] || die "SUDO_USER not set"
user_home=\$(getent passwd "\$real_user" | cut -d: -f6)
[ -n "\$user_home" ] || die "cannot resolve home for \$real_user"
readonly CANON_CONFIG="\$user_home/.config/nvpn/config.toml"
readonly STAGED="\$user_home/${ADMIN_STAGE_REL}"

detect_target() {
  local m; m=\$(uname -m)
  case "\$(uname -s)" in
    Linux)  case "\$m" in x86_64) echo x86_64-unknown-linux-musl;; aarch64|arm64) echo aarch64-unknown-linux-musl;; *) die "unsupported arch \$m";; esac;;
    Darwin) case "\$m" in arm64|aarch64) echo aarch64-apple-darwin;; *) die "unsupported arch \$m";; esac;;
    *) die "unsupported OS";;
  esac
}

write_caps_dropin() {
  install -d -m 0755 -o root -g root "\$DROPIN_DIR"
  cat > "\$CAPS_DROPIN" <<'CAPS'
# Managed by nostr-station — caps nvpn needs for route-cache flush + resolver.
[Service]
AmbientCapabilities=CAP_NET_ADMIN CAP_DAC_OVERRIDE CAP_NET_RAW
CapabilityBoundingSet=CAP_NET_ADMIN CAP_DAC_OVERRIDE CAP_NET_RAW
CAPS
}

write_config_dropin() {
  # Point ExecStart at the canonical user config (b2). Reads the BASE
  # ExecStart, strips any --config, appends ours. Self-revert if the
  # daemon doesn't come back up.
  local base
  base=\$(systemctl cat "\$UNIT" 2>/dev/null | awk '/^# /{f=(\$2 ~ /\\/'"\$UNIT"'\$/)} f && /^ExecStart=/{sub(/^ExecStart=/,"");print;exit}')
  [ -n "\$base" ] || return 0
  base=\$(echo "\$base" | sed -E 's/[[:space:]]--config([= ])[^ ]+//g')
  install -d -m 0755 -o root -g root "\$DROPIN_DIR"
  cat > "\$CONFIG_DROPIN" <<CFG
# Managed by nostr-station — daemon reads the canonical user config.
[Service]
ExecStart=
ExecStart=\$base --config \$CANON_CONFIG
CFG
}

do_install() {
  [ -f "\$STAGED" ] || die "no staged tarball at \$STAGED (dashboard must download+verify first)"
  # shellcheck disable=SC1090
  . "\$MANIFEST"
  local target sha_var sha
  target=\$(detect_target)
  sha_var="NVPN_SHA_\${target//[^A-Za-z0-9]/_}"
  sha=\${!sha_var:-}
  [ -n "\$sha" ] || die "no pinned sha for \$target in manifest"
  # Re-verify the staged tarball against the ROOT-owned pinned sha. A
  # swapped/forged binary fails here — this is what defeats binary-swap.
  echo "\$sha  \$STAGED" | sha256sum -c - >/dev/null 2>&1 || die "sha256 mismatch on staged tarball — refusing to install"
  local tmp; tmp=\$(mktemp -d /root/.nvpn-admin.XXXXXX)
  # shellcheck disable=SC2064
  trap "rm -rf '\$tmp'" RETURN
  tar -xzf "\$STAGED" -C "\$tmp"
  local src="\$tmp/nvpn"; [ -f "\$src" ] || src="\$tmp/nvpn/nvpn"
  [ -f "\$src" ] || die "nvpn binary not found in tarball"
  # Tear-down protection (#7): snapshot the working binary BEFORE replacing,
  # so a failed (re)install can be rolled back instead of bricking the box.
  install -d -m 0755 -o root -g root "\$LIB_DIR"
  local had_prev=0
  if [ -x "\$NVPN_BIN" ]; then cp -p "\$NVPN_BIN" "\$PREV_BIN"; had_prev=1; fi
  install -m 0755 -o root -g root "\$src" "\$NVPN_BIN"
  write_caps_dropin
  if ! "\$NVPN_BIN" service install; then
    # Roll back to the previous working binary if we had one.
    if [ "\$had_prev" -eq 1 ]; then install -m 0755 -o root -g root "\$PREV_BIN" "\$NVPN_BIN"; "\$NVPN_BIN" service install || true; fi
    die "service install failed — rolled back"
  fi
  systemctl daemon-reload || true
  write_config_dropin
  systemctl daemon-reload || true
  systemctl try-restart "\$UNIT" || true
  # Verify the daemon came up; if not and we have a snapshot, revert the
  # config drop-in (the most likely culprit) and reload.
  if ! systemctl is-active --quiet "\$UNIT"; then
    rm -f "\$CONFIG_DROPIN"; systemctl daemon-reload || true; systemctl try-restart "\$UNIT" || true
  fi
  rm -f "\$PREV_BIN"
}

clear_recent_peers() {
  local d
  for d in "\$(dirname "\$CANON_CONFIG")" /root/.config/nvpn; do
    rm -f "\$d/daemon.recent-peers.json" 2>/dev/null || true
  done
}

case "\$verb" in
  check)     echo ok ;;
  install|reinstall) do_install ;;
  uninstall)
    "\$NVPN_BIN" service uninstall 2>/dev/null || true
    rm -f "\$NVPN_BIN" "\$CAPS_DROPIN" "\$CONFIG_DROPIN" "\$PREV_BIN"
    systemctl daemon-reload 2>/dev/null || true
    ;;
  enable)    systemctl enable "\$UNIT" ;;
  disable)   systemctl disable "\$UNIT" ;;
  start)     systemctl start "\$UNIT" ;;
  stop)      systemctl stop "\$UNIT" ;;
  restart)   systemctl restart "\$UNIT" ;;
  reset-peers)
    systemctl stop "\$UNIT" 2>/dev/null || "\$NVPN_BIN" stop 2>/dev/null || true
    clear_recent_peers
    systemctl start "\$UNIT" 2>/dev/null || true
    ;;
  *) die "unknown verb: \$verb" ;;
esac
`;
}

// The one-time provisioning command the user reviews and runs themselves.
// Installs the helper (root:root 0755 in a root-owned dir), the manifest,
// and the sudoers rule (visudo-validated, 0440). The dashboard NEVER runs
// this — it only displays it, including the full helper body so the user
// sees exactly what will run as root.
export function buildAdminProvisionCommand(opts?: {
  user?: string; tag?: string; shas?: Record<string, string>;
}): string {
  const user = opts?.user || os.userInfo().username;
  const tag  = opts?.tag  || (`v${COMPONENT_VERSIONS['nvpn'] || ''}`);
  const shas = opts?.shas || (BINARY_SHA256['nvpn'] || {});
  const helper   = renderAdminHelperScript();
  const manifest = renderAdminManifest(tag, shas);
  const sudoers  = renderAdminSudoers(user);
  // Heredocs quote their delimiters so nothing in the bodies is expanded.
  return [
    `sudo install -d -m 0755 -o root -g root ${ADMIN_LIB_DIR}`,
    `sudo tee ${ADMIN_HELPER} >/dev/null <<'NVPN_ADMIN_HELPER_EOF'\n${helper}\nNVPN_ADMIN_HELPER_EOF`,
    `sudo chown root:root ${ADMIN_HELPER} && sudo chmod 0755 ${ADMIN_HELPER}`,
    `sudo tee ${ADMIN_MANIFEST} >/dev/null <<'NVPN_ADMIN_MANIFEST_EOF'\n${manifest}NVPN_ADMIN_MANIFEST_EOF`,
    `sudo chown root:root ${ADMIN_MANIFEST} && sudo chmod 0644 ${ADMIN_MANIFEST}`,
    `sudo tee /tmp/nostr-station-nvpn.sudoers >/dev/null <<'NVPN_ADMIN_SUDOERS_EOF'\n${sudoers}NVPN_ADMIN_SUDOERS_EOF`,
    `sudo visudo -cf /tmp/nostr-station-nvpn.sudoers`,
    `sudo install -m 0440 -o root -g root /tmp/nostr-station-nvpn.sudoers ${ADMIN_SUDOERS}`,
    `sudo rm -f /tmp/nostr-station-nvpn.sudoers`,
  ].join(' && \\\n');
}

// ── Runtime ───────────────────────────────────────────────────────────────

export interface AdminState {
  /** Helper script present AND root-owned (not user-writable). */
  helperInstalled: boolean;
  /** Helper dir + binary are root-owned (the security precondition). */
  rootOwned: boolean;
  /** `sudo -n <helper> check` works now (NOPASSWD grant active). */
  ready: boolean;
  /** Manifest tag matches the version we'd install (else re-provision). */
  manifestCurrent: boolean;
  detail: string;
}

// Is a path root-owned (uid 0)? Best-effort; false on stat failure.
function isRootOwned(p: string): boolean {
  try { return fs.statSync(p).uid === 0; } catch { return false; }
}

export async function adminState(): Promise<AdminState> {
  const helperInstalled = (() => { try { return fs.statSync(ADMIN_HELPER).isFile(); } catch { return false; } })();
  const rootOwned = helperInstalled && isRootOwned(ADMIN_HELPER) && isRootOwned(ADMIN_LIB_DIR);
  let ready = false;
  if (helperInstalled) {
    try {
      await execa('sudo', ['-n', ADMIN_HELPER, 'check'], { timeout: 5_000, stdio: 'pipe' });
      ready = true;
    } catch { ready = false; }
  }
  // Manifest currency — cheap string check (the manifest is world-readable).
  let manifestCurrent = false;
  try {
    const want = `v${COMPONENT_VERSIONS['nvpn'] || ''}`;
    manifestCurrent = fs.readFileSync(ADMIN_MANIFEST, 'utf8').includes(`NVPN_TAG='${want}'`);
  } catch { manifestCurrent = false; }
  return {
    helperInstalled, rootOwned, ready, manifestCurrent,
    detail: !helperInstalled
      ? 'admin helper not installed — run the one-time setup command'
      : !rootOwned
        ? 'admin helper is NOT root-owned — refusing to trust it; re-run setup'
        : ready
          ? (manifestCurrent ? 'admin helper ready' : 'admin helper ready (manifest stale — re-run setup before updating)')
          : 'admin helper installed but the sudo grant is missing — re-run setup',
  };
}

export interface AdminRunResult { ok: boolean; detail: string }

// Run a privileged verb through the helper: `sudo -n <helper> <verb>`, or
// `sudo -S <helper> <verb>` when a password is supplied (per-action — NO
// lingering all-sudo cache; we never run `sudo -v`). The password is
// stdin-only, never logged/stored/returned.
export async function runAdminVerb(verb: AdminVerb, password?: string): Promise<AdminRunResult> {
  if (!ADMIN_VERBS.includes(verb)) return { ok: false, detail: `unknown verb: ${verb}` };
  const args = password
    ? ['-S', '-p', '', ADMIN_HELPER, verb]
    : ['-n', ADMIN_HELPER, verb];
  try {
    await execa('sudo', args, {
      ...(password ? { input: password.endsWith('\n') ? password : `${password}\n` } : {}),
      timeout: SUDO_TIMEOUT_MS, stdio: 'pipe',
    });
    return { ok: true, detail: `${verb} ok` };
  } catch (e: any) {
    const stderr = (e?.stderr?.toString?.() || '').toLowerCase();
    if (/incorrect password|sorry, try again/.test(stderr)) return { ok: false, detail: 'incorrect password' };
    if (/a password is required|may not run sudo|not in the sudoers/.test(stderr)) {
      return { ok: false, detail: 'admin helper not authorized — run the one-time setup, or unlock with your password' };
    }
    // Surface the helper's own die() message when present (it's our text).
    const msg = (e?.stderr?.toString?.() || e?.message || '').split('\n').find((l: string) => l.includes('nvpn-admin:'));
    return { ok: false, detail: msg ? msg.trim() : `${verb} failed` };
  }
}
