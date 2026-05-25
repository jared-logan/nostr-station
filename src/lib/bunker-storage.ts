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
  // Consecutive silent re-auth failures. Bumped by recordSilentFailure(),
  // reset by recordSilentSuccess() or any explicit re-pairing (QR /
  // bunker:// paste). The pairing is cleared only after this exceeds
  // SILENT_FAILURE_THRESHOLD so a single transient blip (coffee-shop
  // wifi, phone briefly offline) doesn't permanently kick the user into
  // the QR flow. Absent / undefined means zero — legacy saves stay valid.
  failureCount?: number;
}

// How many consecutive silent-reauth failures we tolerate before
// clearing the saved pairing. Each silent attempt has a 20s window
// (SILENT_BUNKER_TIMEOUT_MS), so three failures span ~60s of user-
// observable retries before we give up on the pairing entirely.
const SILENT_FAILURE_THRESHOLD = 3;

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

/**
 * Called from silentBunkerSign() on a successful silent re-auth. Zeroes
 * the consecutive-failure counter so a previously-flaky pairing doesn't
 * count past failures against its next bad day. No-op if there's no
 * saved client (silent path doesn't run in that case) or the counter
 * is already zero.
 */
export function recordSilentSuccess(ownerNpub: string): void {
  const saved = readSavedBunkerClient(ownerNpub);
  if (!saved) return;
  if (!saved.failureCount) return;
  writeSavedBunkerClient({ ...saved, failureCount: 0 });
}

/**
 * Called from silentBunkerSign() on a silent re-auth failure that's
 * NOT a definitive "pairing is dead" signal (i.e. connect/sign_event
 * timeouts, not BunkerSigner.fromBunker init errors). Bumps the
 * consecutive-failure counter and clears the pairing only after it
 * crosses SILENT_FAILURE_THRESHOLD. Returns whether the pairing was
 * cleared so the caller can decide whether to surface a "pair Amber
 * again" hint vs. just falling through to QR.
 */
export function recordSilentFailure(ownerNpub: string): { cleared: boolean } {
  const saved = readSavedBunkerClient(ownerNpub);
  if (!saved) return { cleared: false };
  const next = (saved.failureCount ?? 0) + 1;
  if (next >= SILENT_FAILURE_THRESHOLD) {
    clearSavedBunkerClient();
    return { cleared: true };
  }
  writeSavedBunkerClient({ ...saved, failureCount: next });
  return { cleared: false };
}
