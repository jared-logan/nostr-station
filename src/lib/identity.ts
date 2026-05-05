/**
 * User identity + backup-relay list persisted at
 * ~/.config/nostr-station/identity.json.
 *
 * Only the npub (public) and a list of read relays are stored. nsec is
 * never accepted — the API layer rejects any input starting with "nsec"
 * before it reaches the lib.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export interface Identity {
  npub:       string;       // bech32 "npub1..." or 64-char hex
  readRelays: string[];     // ws:// or wss:// URLs
  // Default nostr relay for ngit (used by Projects → ngit init pre-fill and
  // to distinguish ngit "installed but unconfigured" from "configured"
  // in the dashboard Service Health sidebar).
  ngitRelay?: string;
  // Opt-out of dashboard auth for localhost requests (127.0.0.1, ::1). Default
  // true — manual override only, not surfaced in the UI yet.
  requireAuth?: boolean;
  // Tri-state — written by the web setup wizard at /setup:
  //   - false : wizard is in progress (localhost stays exempt so the
  //             remaining stages can hit otherwise-gated endpoints)
  //   - true  : wizard completed; normal auth applies
  //   - undefined : legacy (pre-6.5 TUI onboard, hand-edited json).
  //             Treated as "complete" — we don't want existing users
  //             stuck in exempt mode after an upgrade.
  setupComplete?: boolean;
}

export const DEFAULT_READ_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
];

function configDir(): string {
  return path.join(os.homedir(), '.config', 'nostr-station');
}
function configPath(): string {
  return path.join(configDir(), 'identity.json');
}

export function identityExists(): boolean {
  return fs.existsSync(configPath());
}

export function readIdentity(): Identity {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      npub:       typeof parsed.npub === 'string' ? parsed.npub : '',
      readRelays: Array.isArray(parsed.readRelays) && parsed.readRelays.length > 0
                    ? parsed.readRelays.filter((x: any) => typeof x === 'string')
                    : DEFAULT_READ_RELAYS.slice(),
      ngitRelay:  typeof parsed.ngitRelay === 'string' && parsed.ngitRelay ? parsed.ngitRelay : undefined,
      requireAuth: parsed.requireAuth === false ? false : undefined,
      setupComplete: typeof parsed.setupComplete === 'boolean' ? parsed.setupComplete : undefined,
    };
  } catch {
    return { npub: '', readRelays: DEFAULT_READ_RELAYS.slice() };
  }
}

export function writeIdentity(ident: Identity): void {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath(), JSON.stringify(ident, null, 2), { mode: 0o600 });
}

// ── Validators ────────────────────────────────────────────────────────────

export function isNpubOrHex(s: string): boolean {
  return /^npub1[a-z0-9]{58,}$/.test(s) || /^[0-9a-f]{64}$/.test(s);
}

// ── npub <-> hex pubkey converters ────────────────────────────────────────
// Bech32 encode/decode round-trip. Lifted from the deleted relay-config
// module since the dashboard's identity routes still need them.

import { nip19 } from 'nostr-tools';

export function hexToNpub(hex: string): string {
  return nip19.npubEncode(hex);
}

export function npubToHex(npub: string): string {
  const decoded = nip19.decode(npub);
  if (decoded.type !== 'npub') throw new Error(`expected npub, got ${decoded.type}`);
  return decoded.data;
}

export function isNsec(s: string): boolean {
  // Reject both bech32 nsec and plain 64-hex-labeled-as-nsec variants.
  return s.startsWith('nsec');
}

export function isValidRelayUrl(s: string): boolean {
  return /^wss?:\/\/[^\s]+$/.test(s);
}

// ── Relay list helpers ────────────────────────────────────────────────────

export function addReadRelay(url: string): { ok: boolean; error?: string; relays?: string[] } {
  if (!isValidRelayUrl(url)) return { ok: false, error: 'url must start with ws:// or wss://' };
  const ident = readIdentity();
  if (ident.readRelays.includes(url)) return { ok: true, relays: ident.readRelays };
  ident.readRelays.push(url);
  writeIdentity(ident);
  return { ok: true, relays: ident.readRelays };
}

export function removeReadRelay(url: string): { ok: boolean; relays: string[] } {
  const ident = readIdentity();
  ident.readRelays = ident.readRelays.filter(r => r !== url);
  writeIdentity(ident);
  return { ok: true, relays: ident.readRelays };
}

export function setNgitRelay(url: string): { ok: boolean; error?: string; ngitRelay?: string } {
  const trimmed = url.trim();
  if (!trimmed) {
    const ident = readIdentity();
    delete ident.ngitRelay;
    writeIdentity(ident);
    return { ok: true, ngitRelay: '' };
  }
  if (!isValidRelayUrl(trimmed)) return { ok: false, error: 'url must start with ws:// or wss://' };
  const ident = readIdentity();
  ident.ngitRelay = trimmed;
  writeIdentity(ident);
  return { ok: true, ngitRelay: trimmed };
}

export function setNpub(npub: string): { ok: boolean; error?: string; npub?: string } {
  if (isNsec(npub)) return { ok: false, error: 'nsec detected. nostr-station never stores private keys — paste your npub only.' };
  if (!isNpubOrHex(npub)) return { ok: false, error: 'not a valid npub or 64-char hex' };
  const ident = readIdentity();
  ident.npub = npub;
  writeIdentity(ident);
  return { ok: true, npub };
}

export function setSetupComplete(complete: boolean): void {
  const ident = readIdentity();
  ident.setupComplete = complete;
  writeIdentity(ident);
}
