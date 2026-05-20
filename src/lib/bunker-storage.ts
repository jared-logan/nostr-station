/**
 * Persisted NIP-46 client state for silent re-auth.
 *
 * On first successful bunker sign-in (QR or bunker:// URL), we stash the
 * ephemeral client secret key + the bunker pointer (pubkey + relays) to
 * ~/.nostr-station/bunker-client.json. Subsequent sign-ins can then
 * reconnect with the same client pubkey — Amber already trusts it, so the
 * user gets a push notification instead of the "delete old bunker, scan
 * new QR" dance.
 *
 * Threat model: the client secret key gated here is NOT the user's
 * signing key (that lives in Amber). It can only trigger NIP-46 requests
 * to a bunker the user has already paired with — which will itself
 * prompt for approval per Amber's per-app permission settings. The
 * worst an attacker with FS access can do is cause Amber prompts on the
 * user's phone, not sign arbitrary events. Same trust level as the
 * watchdog-nsec already living in the keychain.
 *
 * File has mode 0600 (owner-only) and is scoped by the station owner's
 * npub so a key-rotation / identity change invalidates the cached client
 * instead of trying to reuse it against a different Amber pairing.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { atomicWriteJson } from './atomic-write.js';

const DIR  = path.join(os.homedir(), '.nostr-station');
const FILE = path.join(DIR, 'bunker-client.json');

export interface SavedBunkerClient {
  ownerNpub:       string;   // identity.json#npub at save time — discard if different
  clientSecretHex: string;   // 64-char hex, nostr-tools' secret key format
  bunker: {
    relays: string[];        // wss:// relay list from the bunker pointer
    pubkey: string;          // bunker's pubkey (Amber's app-bunker pubkey)
    secret: string | null;   // optional bunker connect secret — usually null post-connect
  };
  savedAt: number;           // ms epoch; purely diagnostic
}

export function readSavedBunkerClient(ownerNpub: string): SavedBunkerClient | null {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const data = JSON.parse(raw) as SavedBunkerClient;
    if (!data || typeof data !== 'object') return null;
    // Guard against a stale cache surviving an npub change (e.g. user
    // re-paired through the wizard with a different key). Silent-reconnect
    // attempts against the wrong bunker would fail anyway, but explicit
    // match skips the round-trip.
    if (data.ownerNpub !== ownerNpub) return null;
    if (typeof data.clientSecretHex !== 'string' || data.clientSecretHex.length !== 64) return null;
    if (!data.bunker || typeof data.bunker.pubkey !== 'string' || !Array.isArray(data.bunker.relays)) return null;
    return data;
  } catch { return null; }
}

export function writeSavedBunkerClient(s: SavedBunkerClient): void {
  try {
    // atomicWriteJson handles mkdir-with-0o700, atomic rename, and
    // defensive chmod-on-overwrite in one place — replaces the prior
    // mkdir + writeFileSync + manual chmod dance.
    atomicWriteJson(FILE, s, { mode: 0o600 });
  } catch { /* best-effort — failure here only costs us silent re-auth */ }
}

export function clearSavedBunkerClient(): void {
  try { fs.unlinkSync(FILE); } catch { /* missing is fine */ }
}
