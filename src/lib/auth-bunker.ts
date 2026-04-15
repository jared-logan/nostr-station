/**
 * NIP-46 bunker sign-in flows for dashboard auth.
 *
 * Two entry points are exposed:
 *   - startNostrConnect():   generates an ephemeral keypair + nostrconnect://
 *                            URI, listens on the configured relays for an
 *                            Amber/bunker connect response, then requests a
 *                            signed NIP-98 event. Progress is polled over
 *                            HTTP via the session id (ephemeral pubkey).
 *   - signWithBunkerUrl():   takes a bunker:// URI and runs the connect +
 *                            sign_event flow synchronously with a 30s cap.
 *
 * In both cases the remote signer returns a kind-27235 event whose pubkey
 * must match the configured station owner npub — verifyNip98() enforces
 * that in the verify endpoint.
 */

import nodeCrypto from 'node:crypto';
import { BunkerSigner, parseBunkerInput, createNostrConnectURI } from 'nostr-tools/nip46';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
// @ts-expect-error — qrcode ships no types, CJS default export carries toString
import QRCode from 'qrcode';
import { readIdentity } from './identity.js';

const CONNECT_TIMEOUT_MS = 120_000;
const BUNKER_TIMEOUT_MS  = 30_000;

// ── Relay resolution ────────────────────────────────────────────────────────

// Only wss:// relays are acceptable — a plain ws:// relay for an auth flow
// leaks the NIP-44 encrypted connect/sign_event events in plaintext on the
// wire. Identity read-relays are the default set.
function pickAuthRelays(): string[] {
  const ident = readIdentity();
  const safe  = ident.readRelays.filter(r => /^wss:\/\//i.test(r));
  return safe.length > 0 ? safe.slice(0, 4) : ['wss://relay.damus.io'];
}

// ── Session tracking (for the QR polling flow) ──────────────────────────────

export type BunkerStatus = 'waiting' | 'ok' | 'timeout' | 'error';

export interface BunkerSession {
  ephemeralPubkey: string;
  nostrconnectUri: string;
  relays:          string[];
  createdAt:       number;
  expiresAt:       number;
  status:          BunkerStatus;
  error?:          string;
  // Once the remote signer finishes signing, we stash the signed event so
  // the /api/auth/verify path (or the polling endpoint) can issue a session.
  signedEvent?:    any;
  challenge?:      string;
}

const bunkerSessions = new Map<string, BunkerSession>();

function pruneBunkerSessions(): void {
  const now = Date.now();
  for (const [k, v] of bunkerSessions) {
    if (v.expiresAt < now) bunkerSessions.delete(k);
  }
}

export function getBunkerSession(eph: string): BunkerSession | null {
  pruneBunkerSessions();
  return bunkerSessions.get(eph) ?? null;
}

// Mark the session consumed and free the map entry — the caller uses the
// snapshot it already holds.
export function consumeBunkerSession(eph: string): BunkerSession | null {
  const s = bunkerSessions.get(eph) ?? null;
  if (s) bunkerSessions.delete(eph);
  return s;
}

// ── nostrconnect:// flow (Amber QR) ─────────────────────────────────────────

export interface NostrConnectStart {
  ephemeralPubkey: string;
  nostrconnectUri: string;
  qrSvg:           string;
  relays:          string[];
  expiresAt:       number;
}

// QR code rendered server-side to an SVG string with inverted colors (dark
// background, light modules) so it drops into the dashboard's card without
// a bundler for the qrcode lib, which ships CJS only.
async function renderQrSvg(uri: string): Promise<string> {
  try {
    return await QRCode.toString(uri, {
      type:   'svg',
      margin: 1,
      width:  256,
      color:  { dark: '#e8e6dc', light: '#0b0d10' },
      errorCorrectionLevel: 'M',
    });
  } catch {
    return '';
  }
}

export async function startNostrConnect(
  challenge: string, dashboardUrl: string,
): Promise<NostrConnectStart> {
  const relays = pickAuthRelays();
  const secretKey = generateSecretKey();
  const ephemeralPubkey = getPublicKey(secretKey);
  const connectSecret = nodeCrypto.randomBytes(16).toString('hex');

  const nostrconnectUri = createNostrConnectURI({
    clientPubkey: ephemeralPubkey,
    relays,
    secret: connectSecret,
    perms: ['sign_event:27235'],
    name:  'nostr-station',
    url:   dashboardUrl,
  });

  const qrSvg = await renderQrSvg(nostrconnectUri);

  const now = Date.now();
  const session: BunkerSession = {
    ephemeralPubkey,
    nostrconnectUri,
    relays,
    createdAt: now,
    expiresAt: now + CONNECT_TIMEOUT_MS,
    status: 'waiting',
    challenge,
  };
  bunkerSessions.set(ephemeralPubkey, session);

  // Run the connect+sign flow in the background. Any result is written
  // back to the map and picked up by the polling endpoint.
  runNostrConnectFlow(session, secretKey, challenge, dashboardUrl).catch(err => {
    session.status = 'error';
    session.error  = err?.message || String(err);
  });

  return {
    ephemeralPubkey,
    nostrconnectUri,
    qrSvg,
    relays,
    expiresAt: session.expiresAt,
  };
}

async function runNostrConnectFlow(
  session:   BunkerSession,
  secretKey: Uint8Array,
  challenge: string,
  dashboardUrl: string,
): Promise<void> {
  let signer: any;
  try {
    signer = await BunkerSigner.fromURI(
      secretKey, session.nostrconnectUri, {}, CONNECT_TIMEOUT_MS,
    );
  } catch (e: any) {
    if (session.status === 'waiting') {
      session.status = 'timeout';
      session.error  = e?.message || 'bunker connect failed';
    }
    return;
  }

  try {
    const template = {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['u', dashboardUrl],
        ['method', 'POST'],
      ],
      content: challenge,
    };
    const signed = await signer.signEvent(template);
    session.signedEvent = signed;
    session.status      = 'ok';
  } catch (e: any) {
    session.status = 'error';
    session.error  = e?.message || 'bunker sign_event failed';
  } finally {
    try { await signer.close(); } catch {}
  }
}

// ── bunker:// URL flow (paste) ──────────────────────────────────────────────

export interface BunkerUrlResult {
  ok:     boolean;
  signedEvent?: any;
  error?: string;
}

export async function signWithBunkerUrl(
  bunkerUrl: string, challenge: string, dashboardUrl: string,
): Promise<BunkerUrlResult> {
  if (!/^bunker:\/\//i.test(bunkerUrl)) {
    return { ok: false, error: 'invalid bunker URL' };
  }
  const bp = await parseBunkerInput(bunkerUrl);
  if (!bp) return { ok: false, error: 'could not parse bunker URL' };

  const secretKey = generateSecretKey();
  let signer: any;
  try {
    signer = BunkerSigner.fromBunker(secretKey, bp, {});
  } catch (e: any) {
    return { ok: false, error: e?.message || 'bunker init failed' };
  }

  const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms)),
    ]);

  try {
    await withTimeout(signer.connect(), BUNKER_TIMEOUT_MS, 'connect');
    const template = {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['u', dashboardUrl],
        ['method', 'POST'],
      ],
      content: challenge,
    };
    const signed = await withTimeout(signer.signEvent(template), BUNKER_TIMEOUT_MS, 'sign_event');
    return { ok: true, signedEvent: signed };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'bunker flow failed' };
  } finally {
    try { await signer.close(); } catch {}
  }
}
