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
}

const DEFAULT_READ_RELAYS = [
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

export function readIdentity(): Identity {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      npub:       typeof parsed.npub === 'string' ? parsed.npub : '',
      readRelays: Array.isArray(parsed.readRelays) && parsed.readRelays.length > 0
                    ? parsed.readRelays.filter((x: any) => typeof x === 'string')
                    : DEFAULT_READ_RELAYS.slice(),
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

export function setNpub(npub: string): { ok: boolean; error?: string; npub?: string } {
  if (isNsec(npub)) return { ok: false, error: 'nsec detected. nostr-station never stores private keys — paste your npub only.' };
  if (!isNpubOrHex(npub)) return { ok: false, error: 'not a valid npub or 64-char hex' };
  const ident = readIdentity();
  ident.npub = npub;
  writeIdentity(ident);
  return { ok: true, npub };
}
