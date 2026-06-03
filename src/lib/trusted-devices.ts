// Trusted-devices allowlist — the pubkeys (besides the dashboard owner's)
// allowed to reach the dashboard over a non-loopback (mesh) interface.
//
// Security model: this list is consumed by dashboard-binding's
// `allowDashboardConnection` gate. A pubkey here means "a mesh peer signing
// as this key may connect" — the #240 mesh-origin gate (Host/Origin pinned
// to the tunnel interface) and Bearer session auth STILL apply on top. The
// file lives in the owner's home (0700 dir / 0600 file), so only the local
// user can change who's trusted. We re-validate every entry on read so a
// hand-edited or corrupted file can never inject a malformed key into the
// gate. Pubkeys are PUBLIC — nothing secret is stored here.
//
// Owner's own devices (phone + laptop sharing the owner pubkey via NIP-46)
// are already trusted by dashboard-binding without being listed; this is for
// OTHER pubkeys the owner wants to admit.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { npubToHex } from './identity.js';

// Resolved per call (not frozen at import) so $HOME changes / tests are honored.
function configDir(): string  { return path.join(os.homedir(), '.nostr-station'); }
function configFile(): string { return path.join(configDir(), 'trusted-devices.json'); }

export interface TrustedDevicesConfig {
  /** Trusted pubkeys, stored canonically as lowercase 64-char hex. */
  pubkeys: string[];
  updatedAt?: number;
}

// Normalize an npub or 64-hex pubkey to lowercase hex; null on anything else.
// Pure — the validation core, unit-tested with synthetic keys.
export function normalizeTrustedPubkey(input: string): string | null {
  if (typeof input !== 'string') return null;
  const v = input.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(v)) return v;
  if (v.startsWith('npub1')) { try { return npubToHex(v).toLowerCase(); } catch { return null; } }
  return null;
}

// Read + re-validate the allowlist. Malformed file / entries → dropped (fail
// safe: a corrupt file yields an EMPTY list, never a bogus trust).
export function readTrustedDevices(): TrustedDevicesConfig {
  try {
    if (!fs.existsSync(configFile())) return { pubkeys: [] };
    const parsed = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.pubkeys)) return { pubkeys: [] };
    const normalized: string[] = [];
    for (const p of parsed.pubkeys as unknown[]) {
      const hex = normalizeTrustedPubkey(String(p));
      if (hex) normalized.push(hex);
    }
    const pubkeys = [...new Set(normalized)].sort();
    return { pubkeys, updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : undefined };
  } catch {
    return { pubkeys: [] };
  }
}

function writeTrustedDevices(pubkeys: string[]): TrustedDevicesConfig {
  try { fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 }); } catch { /* best effort */ }
  const stamped: TrustedDevicesConfig = { pubkeys: [...pubkeys].sort(), updatedAt: Date.now() };
  fs.writeFileSync(configFile(), JSON.stringify(stamped, null, 2) + '\n', { mode: 0o600 });
  return stamped;
}

export interface TrustedDevicesResult { ok: boolean; detail: string; pubkeys: string[] }

export function addTrustedDevice(input: string): TrustedDevicesResult {
  const hex = normalizeTrustedPubkey(input);
  const cur = readTrustedDevices().pubkeys;
  if (!hex) return { ok: false, detail: 'not a valid npub or 64-char hex pubkey', pubkeys: cur };
  if (cur.includes(hex)) return { ok: true, detail: 'already trusted', pubkeys: cur };
  const next = writeTrustedDevices([...cur, hex]).pubkeys;
  return { ok: true, detail: 'device trusted', pubkeys: next };
}

export function removeTrustedDevice(input: string): TrustedDevicesResult {
  const cur = readTrustedDevices().pubkeys;
  // Accept either encoding for removal; fall back to the raw lowered string so
  // a stale/odd stored entry can still be cleared.
  const target = normalizeTrustedPubkey(input) || String(input).trim().toLowerCase();
  const next = cur.filter(p => p !== target);
  if (next.length === cur.length) return { ok: true, detail: 'not in the list', pubkeys: cur };
  return { ok: true, detail: 'device removed', pubkeys: writeTrustedDevices(next).pubkeys };
}
