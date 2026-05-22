/**
 * Mobile Access — toggle that controls whether the dashboard binds
 * to non-loopback interfaces (making it reachable from peers on the
 * nvpn mesh, not just from the host's own browser).
 *
 * Architecture under Path B:
 *
 *   - When DISABLED (default), the dashboard binds to 127.0.0.1.
 *     Only processes on the host can reach it. Same as the baseline
 *     model before Mobile Access existed.
 *
 *   - When ENABLED, the dashboard binds to 0.0.0.0 (all interfaces).
 *     Mesh peers can NOW reach the HTTP port — but the connection-time
 *     peer-pubkey filter from dashboard-binding.ts gates EVERY non-
 *     loopback connection by pubkey. Only the dashboard owner's own
 *     pubkey is trusted by default, so only the user's own devices
 *     (which pair the same NIP-46 bunker) get through. Random mesh
 *     members are dropped at the TCP layer with no HTTP response.
 *
 *   - Flipping the toggle persists the choice here but doesn't
 *     re-bind a running server. The dashboard reads this file at
 *     boot to pick the interface; users restart to apply.
 *
 * No nvpn-specific binding (e.g. binding to the live tunnel IP)
 * because the tunnel IP can change between sessions and renaming
 * an interface mid-flight is messy. 0.0.0.0 + the peer filter
 * achieves the same effective security with less moving parts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_DIR  = path.join(os.homedir(), '.nostr-station');
const CONFIG_FILE = path.join(CONFIG_DIR, 'mobile-access.json');

export interface MobileAccessConfig {
  /** When true, the dashboard binds to 0.0.0.0 on next boot. */
  enabled: boolean;
  /** Last time the toggle was changed (ms epoch). Surfaced in the UI
   *  so a user troubleshooting can see "you toggled this 3min ago,
   *  did you restart?". */
  updatedAt?: number;
}

const DEFAULT: MobileAccessConfig = { enabled: false };

/** Read the persisted toggle state. Returns the default (off) on
 *  missing / malformed file — fail safe. */
export function readMobileAccessConfig(): MobileAccessConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT };
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT };
    return {
      enabled:   parsed.enabled === true,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : undefined,
    };
  } catch {
    return { ...DEFAULT };
  }
}

/** Persist a new toggle state. Returns the saved config. */
export function writeMobileAccessConfig(cfg: MobileAccessConfig): MobileAccessConfig {
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 }); } catch {}
  const stamped: MobileAccessConfig = {
    enabled:   cfg.enabled === true,
    updatedAt: Date.now(),
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(stamped, null, 2) + '\n', { mode: 0o600 });
  return stamped;
}

/**
 * The bind host the dashboard should listen on at boot. Honors:
 *   1. DEV_HOST env var (existing override; always wins)
 *   2. Mobile Access enabled ⇒ 0.0.0.0
 *   3. Default ⇒ 127.0.0.1 (loopback only)
 *
 * Centralized here so web-server.ts has one call to consult at
 * listen time, rather than re-reading + re-deciding inline.
 */
export function dashboardBindHost(): string {
  if (process.env.DEV_HOST) return process.env.DEV_HOST;
  const cfg = readMobileAccessConfig();
  return cfg.enabled ? '0.0.0.0' : '127.0.0.1';
}
