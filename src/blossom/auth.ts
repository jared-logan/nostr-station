/**
 * NIP-98 verifier scoped to the in-process Blossom server.
 *
 * Diverges from `src/lib/auth.ts:verifyNip98` in two ways:
 *   1. No `challenge` requirement. The dashboard-auth variant embeds a
 *      server-issued challenge tag; Blossom uploads use vanilla NIP-98
 *      where the body's payload SHA is the integrity bind.
 *   2. ±5 min `created_at` window (vs. ±60s). Local development across
 *      VMs / containers / wsl often has unsynced clocks; the looser
 *      window keeps "upload my avatar" working without forcing users
 *      to run ntpdate. The server is loopback-only, so timestamp
 *      tolerance is a usability tradeoff with no real attacker.
 *
 * The verifier doesn't decide auth policy — it just confirms "this
 * event is a well-formed NIP-98 for this exact request." The caller
 * (HTTP route handler) compares the resolved pubkey against
 * owner / whitelist / test-identity registries.
 */

import { verifyEvent } from 'nostr-tools/pure';
import type { UploaderKind } from './types.js';

const KIND_NIP98 = 27235;
const CLOCK_SKEW_S = 5 * 60;  // ±5 min

export interface Nip98VerifyInput {
  event:        any;
  method:       string;
  expectedUrl:  string;
  // Optional: when set, the event MUST carry an `x` tag with this sha256.
  // Used for PUT /upload to bind the auth event to the body's hash.
  expectedSha?: string | null;
}

export type Nip98VerifyResult =
  | { ok: true;  pubkey: string }
  | { ok: false; status: number; error: string };

export function verifyBlossomAuth(input: Nip98VerifyInput): Nip98VerifyResult {
  const ev = input.event;
  if (!ev || typeof ev !== 'object') {
    return { ok: false, status: 400, error: 'missing auth event' };
  }
  if (ev.kind !== KIND_NIP98) {
    return { ok: false, status: 401, error: `auth event kind must be ${KIND_NIP98}` };
  }
  const nowS = Math.floor(Date.now() / 1000);
  const ts   = Number(ev.created_at) || 0;
  if (!ts || Math.abs(nowS - ts) > CLOCK_SKEW_S) {
    return { ok: false, status: 401, error: `auth event timestamp outside ±${CLOCK_SKEW_S}s window` };
  }

  const tags: string[][] = Array.isArray(ev.tags) ? ev.tags : [];
  const uTag = tags.find(t => Array.isArray(t) && t[0] === 'u');
  const mTag = tags.find(t => Array.isArray(t) && t[0] === 'method');
  if (!uTag || uTag[1] !== input.expectedUrl) {
    return { ok: false, status: 401, error: `auth u-tag does not match request URL` };
  }
  if (!mTag || (mTag[1] || '').toUpperCase() !== input.method.toUpperCase()) {
    return { ok: false, status: 401, error: `auth method-tag does not match request method` };
  }
  if (input.expectedSha) {
    const xTag = tags.find(t => Array.isArray(t) && t[0] === 'x');
    if (!xTag || (xTag[1] || '').toLowerCase() !== input.expectedSha.toLowerCase()) {
      return { ok: false, status: 400, error: `auth x-tag does not match body sha256` };
    }
  }

  let valid = false;
  try { valid = verifyEvent(ev); } catch { valid = false; }
  if (!valid) return { ok: false, status: 401, error: 'invalid auth event signature' };

  const pubkey = String(ev.pubkey || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubkey)) {
    return { ok: false, status: 401, error: 'auth event has invalid pubkey' };
  }
  return { ok: true, pubkey };
}

// Classify a pubkey against the local auth registries. Caller wires the
// three predicates; this module stays free of references to the higher-
// level identity / whitelist / test-identity modules so it can be tested
// in isolation.
export function classifyUploader(
  pubkey: string,
  predicates: {
    isOwner:        (hex: string) => boolean;
    isWhitelisted:  (hex: string) => boolean;
    isTestIdentity: (hex: string) => boolean;
  },
): UploaderKind | null {
  if (predicates.isOwner(pubkey))        return 'owner';
  if (predicates.isWhitelisted(pubkey))  return 'whitelist';
  if (predicates.isTestIdentity(pubkey)) return 'test-identity';
  return null;
}

// Parses the Authorization header that NIP-98 uses:
//   Authorization: Nostr <base64-encoded JSON event>
// Returns the decoded event or null on any parse failure.
export function parseAuthHeader(raw: string | undefined): any | null {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/^Nostr\s+([A-Za-z0-9+/=]+)$/i);
  if (!m) return null;
  try {
    const json = Buffer.from(m[1], 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}
