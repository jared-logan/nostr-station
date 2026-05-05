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
import { nip19 } from 'nostr-tools';
// @ts-expect-error — qrcode ships no types, CJS default export carries toString
import QRCode from 'qrcode';
import {
  readIdentity, writeIdentity, DEFAULT_READ_RELAYS,
} from './identity.js';
import {
  readSavedBunkerClient, writeSavedBunkerClient, clearSavedBunkerClient,
  type SavedBunkerClient,
} from './bunker-storage.js';

const CONNECT_TIMEOUT_MS = 120_000;
const BUNKER_TIMEOUT_MS  = 30_000;
// Silent re-auth uses the saved bunker client — the user is watching a
// loading state, so we need to decide quickly whether Amber is going to
// respond or we should fall back to QR. ~20s gives them enough time to
// pick up their phone and tap approve without making the dashboard feel
// stuck.
const SILENT_BUNKER_TIMEOUT_MS = 20_000;

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
    // Persist the client secret + bunker pointer so future sign-ins can
    // silently reuse this Amber pairing instead of showing another QR.
    // We only save on success; a partial / errored flow leaves any prior
    // save untouched, which is the right behavior if the user's trying
    // to recover from a broken pairing.
    persistBunkerClient(secretKey, signer?.bp);
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
    persistBunkerClient(secretKey, signer?.bp);
    return { ok: true, signedEvent: signed };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'bunker flow failed' };
  } finally {
    try { await signer.close(); } catch {}
  }
}

// ── Silent re-auth via saved bunker ─────────────────────────────────────────

function persistBunkerClient(secretKey: Uint8Array, bp: any): void {
  try {
    if (!bp || typeof bp.pubkey !== 'string' || !Array.isArray(bp.relays)) return;
    const clientSecretHex = Array.from(secretKey)
      .map(b => b.toString(16).padStart(2, '0')).join('');
    const ident = readIdentity();
    if (!ident.npub) return;
    writeSavedBunkerClient({
      ownerNpub:       ident.npub,
      clientSecretHex,
      bunker: {
        relays: bp.relays,
        pubkey: bp.pubkey,
        secret: bp.secret ?? null,
      },
      savedAt: Date.now(),
    });
  } catch { /* best-effort — only costs us silent re-auth next time */ }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export interface SilentBunkerResult {
  ok:           boolean;
  tried:        boolean;         // false = no saved bunker; caller should fall back to QR
  signedEvent?: any;
  error?:       string;
}

/**
 * Attempts to silently re-authenticate using a previously-saved bunker
 * client. Returns { tried: false } if no saved client exists — the caller
 * should then fall back to the QR flow. On any other failure (connect
 * timeout, user denies, relay unreachable), returns { ok: false, tried:
 * true } and the caller should fall back to QR too; we clear the saved
 * state so the next attempt doesn't try the same dead bunker.
 *
 * Success case: Amber already trusts this client pubkey, pushes the user
 * a "Approve sign-in?" notification, they tap yes, signed event comes
 * back in a few seconds — no QR, no bunker cleanup.
 */
export async function silentBunkerSign(
  challenge: string, dashboardUrl: string,
): Promise<SilentBunkerResult> {
  const ident = readIdentity();
  if (!ident.npub) return { ok: false, tried: false };

  const saved = readSavedBunkerClient(ident.npub);
  if (!saved) return { ok: false, tried: false };

  const secretKey = hexToBytes(saved.clientSecretHex);
  let signer: any;
  try {
    signer = BunkerSigner.fromBunker(secretKey, saved.bunker, {});
  } catch (e: any) {
    clearSavedBunkerClient();
    return { ok: false, tried: true, error: e?.message || 'bunker init failed' };
  }

  const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms)),
    ]);

  try {
    await withTimeout(signer.connect(), SILENT_BUNKER_TIMEOUT_MS, 'connect');
    const template = {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['u', dashboardUrl],
        ['method', 'POST'],
      ],
      content: challenge,
    };
    const signed = await withTimeout(
      signer.signEvent(template), SILENT_BUNKER_TIMEOUT_MS, 'sign_event',
    );
    return { ok: true, tried: true, signedEvent: signed };
  } catch (e: any) {
    // A failure here usually means the user revoked the bunker pairing
    // in Amber, uninstalled the app, or the relays changed. Clear the
    // saved state so the next attempt goes straight to the QR fallback
    // instead of retrying a broken path.
    clearSavedBunkerClient();
    return { ok: false, tried: true, error: e?.message || 'silent bunker flow failed' };
  } finally {
    try { await signer.close(); } catch {}
  }
}

// ── Setup wizard pairing (first-run /setup) ─────────────────────────────────
//
// startSetupAmber() is the initial-pairing analogue of startNostrConnect():
// same nostrconnect:// QR flow, but on success we capture the user's pubkey
// from the bunker handshake, write it as the station owner npub, and save
// the bunker client for future silent re-auth + signing. NO event is signed
// during the handshake — pairing alone is a one-tap operation; signing is
// deferred to /api/setup/verify (the live verification stage). This keeps
// the "two phone taps total" guarantee from the user-journey spec.

export interface SetupAmberStart {
  ephemeralPubkey: string;
  nostrconnectUri: string;
  qrSvg:           string;
  relays:          string[];
  expiresAt:       number;
}

export interface SetupAmberSession extends BunkerSession {
  // Captured after a successful connect — the user's main npub, written
  // straight into identity.json so the wizard never has to ask for it.
  userNpub?: string;
}

const setupSessions = new Map<string, SetupAmberSession>();

function pruneSetupSessions(): void {
  const now = Date.now();
  for (const [k, v] of setupSessions) if (v.expiresAt < now) setupSessions.delete(k);
}

export function getSetupAmberSession(eph: string): SetupAmberSession | null {
  pruneSetupSessions();
  return setupSessions.get(eph) ?? null;
}

export function consumeSetupAmberSession(eph: string): SetupAmberSession | null {
  const s = setupSessions.get(eph) ?? null;
  if (s) setupSessions.delete(eph);
  return s;
}

// Setup pairing uses a fixed list of well-known public bunker relays. The
// user has no identity yet, so we can't pull their preferred read-relays
// from identity.json the way startNostrConnect() does. These are the
// relays Amber + the major Nostr clients use for NIP-46 routing.
const SETUP_AMBER_RELAYS = [
  'wss://relay.nsec.app',
  'wss://relay.damus.io',
  'wss://nos.lol',
];

export async function startSetupAmber(dashboardUrl: string): Promise<SetupAmberStart> {
  const secretKey       = generateSecretKey();
  const ephemeralPubkey = getPublicKey(secretKey);
  const connectSecret   = nodeCrypto.randomBytes(16).toString('hex');

  const nostrconnectUri = createNostrConnectURI({
    clientPubkey: ephemeralPubkey,
    relays:       SETUP_AMBER_RELAYS,
    secret:       connectSecret,
    // Permissions requested at pairing — covers the verify stage's kind-1
    // test event plus the kinds the user is most likely to publish in
    // their first session. Adding more permissions post-pairing is cheap;
    // requesting too many up-front trains users to "approve all" which
    // defeats the per-event prompt model.
    perms: ['sign_event:1', 'sign_event:0', 'sign_event:6', 'get_public_key'],
    name:  'nostr-station',
    url:   dashboardUrl,
  });

  const qrSvg = await renderQrSvg(nostrconnectUri);

  const now = Date.now();
  const session: SetupAmberSession = {
    ephemeralPubkey,
    nostrconnectUri,
    relays:    SETUP_AMBER_RELAYS,
    createdAt: now,
    expiresAt: now + CONNECT_TIMEOUT_MS,
    status:    'waiting',
  };
  setupSessions.set(ephemeralPubkey, session);

  // Run the connect flow in the background. On success: persist npub +
  // bunker client. On failure: status is updated so the polling endpoint
  // can surface the error.
  runSetupAmberFlow(session, secretKey).catch(err => {
    session.status = 'error';
    session.error  = err?.message || String(err);
  });

  return {
    ephemeralPubkey,
    nostrconnectUri,
    qrSvg,
    relays:    SETUP_AMBER_RELAYS,
    expiresAt: session.expiresAt,
  };
}

async function runSetupAmberFlow(
  session:   SetupAmberSession,
  secretKey: Uint8Array,
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
    // Ask the bunker for the user's pubkey via NIP-46's get_public_key.
    // BunkerSigner exposes this as `getPublicKey()`. The returned hex is
    // the user's main pubkey (what the user signs with), not the bunker's
    // app-pubkey on `bp`. Some bunkers return the same value for both;
    // for Amber-style "delegated app pubkey" setups they differ, and
    // this method gives us the right one.
    let userPubkeyHex: string;
    if (typeof signer.getPublicKey === 'function') {
      userPubkeyHex = await signer.getPublicKey();
    } else {
      // Fallback for older nostr-tools — bp.pubkey is Amber's pubkey,
      // which for Amber's main flow is the user's pubkey.
      userPubkeyHex = String(signer?.bp?.pubkey ?? '');
    }
    if (!/^[0-9a-f]{64}$/.test(userPubkeyHex)) {
      throw new Error(`invalid pubkey from bunker: ${userPubkeyHex}`);
    }

    const npub = nip19.npubEncode(userPubkeyHex);

    // Write identity.json. Read first to preserve any pre-existing
    // requireAuth / readRelays values; we only set the npub + ensure
    // setupComplete stays false until /api/setup/complete runs.
    const prev = readIdentity();
    writeIdentity({
      ...prev,
      npub,
      readRelays: prev.readRelays?.length ? prev.readRelays : DEFAULT_READ_RELAYS.slice(),
      setupComplete: false,
    });

    // Save the bunker client so future signing requests (verify stage,
    // ngit pushes, nsite publishes) silently reuse this pairing.
    persistBunkerClient(secretKey, signer?.bp);

    session.userNpub = npub;
    session.status   = 'ok';
  } catch (e: any) {
    session.status = 'error';
    session.error  = e?.message || 'bunker handshake failed';
  } finally {
    try { await signer.close(); } catch {}
  }
}

// ── Generic event signing via saved bunker ──────────────────────────────────
//
// signEventWithSavedBunker() is the building block /api/setup/verify uses
// to ask Amber to sign the test kind-1 event. It's also the path future
// publish/deploy flows will call when they need a signed event without a
// fresh QR. Returns { ok: false, tried: false } when no saved client
// exists — the caller can decide whether to surface a "pair Amber first"
// error or fall through to a different sign source.

export interface SignWithBunkerResult {
  ok:           boolean;
  tried:        boolean;
  signedEvent?: any;
  error?:       string;
}

export async function signEventWithSavedBunker(
  template:  { kind: number; created_at: number; tags: string[][]; content: string },
  timeoutMs: number = BUNKER_TIMEOUT_MS,
): Promise<SignWithBunkerResult> {
  const ident = readIdentity();
  if (!ident.npub) return { ok: false, tried: false, error: 'no station npub configured' };

  const saved = readSavedBunkerClient(ident.npub);
  if (!saved) return { ok: false, tried: false, error: 'no saved bunker client' };

  const secretKey = hexToBytes(saved.clientSecretHex);
  let signer: any;
  try {
    signer = BunkerSigner.fromBunker(secretKey, saved.bunker, {});
  } catch (e: any) {
    return { ok: false, tried: true, error: e?.message || 'bunker init failed' };
  }

  const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms)),
    ]);

  try {
    await withTimeout(signer.connect(), timeoutMs, 'connect');
    const signed = await withTimeout(signer.signEvent(template), timeoutMs, 'sign_event');
    return { ok: true, tried: true, signedEvent: signed };
  } catch (e: any) {
    return { ok: false, tried: true, error: e?.message || 'bunker sign failed' };
  } finally {
    try { await signer.close(); } catch {}
  }
}
