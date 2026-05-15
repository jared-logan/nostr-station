/**
 * Sign routes — generic NIP-46 signing surface for in-dashboard surfaces
 * (initially the embedded Ditto iframe via station-signer.js) that need
 * to sign arbitrary events through the station's saved bunker pairing
 * without going through /api/client/publish's kind whitelist + broadcast.
 *
 * The Client panel iframes Ditto, which calls `window.nostr.signEvent()`
 * for every publish, follow, reaction, profile edit, list update, etc.
 * Without a station-side signer, those calls hit whichever NIP-07
 * extension the user installed (Alby, nos2x), forcing per-origin
 * per-kind permission prompts because Alby treats the dashboard origin
 * as a fresh site. Routing those calls through the station's persisted
 * NIP-46 bunker pairing (Amber, Alby Hub, etc.) collapses every Ditto
 * sign into "one trusted app" from the signer's perspective — the same
 * grant the dashboard already established for Chat/Blossom publishes.
 *
 * Surface:
 *   GET  /api/sign/status   — { bunkerPaired: bool, ownerNpub, ownerHex }
 *                             (lets the Config toggle disable itself when
 *                             no bunker is set up).
 *   GET  /api/sign/pubkey   — { pubkey: hex, npub } for getPublicKey().
 *   POST /api/sign/event    — body: { template: {kind, created_at, tags, content} }
 *                             → { ok, signedEvent } | { ok: false, error }.
 *
 * Deliberately NOT included in this PR (follow-up):
 *   POST /api/sign/nip04-encrypt|decrypt
 *   POST /api/sign/nip44-encrypt|decrypt
 *   GET  /api/sign/relays
 * Ditto's DM features call these; without them, DMs fall back to whatever
 * window.nostr.nip04 the page's signer (or none) provides. The shim is
 * forward-compatible — it just doesn't install nip04/nip44 namespaces yet.
 *
 * Auth: same as the rest of /api/* — the dashboard's session token
 * middleware gates this, so a request without a valid Bearer token gets
 * 401 before reaching us.
 */
import http from 'http';
import { readIdentity, npubToHex } from '../identity.js';
import { readSavedBunkerClient } from '../bunker-storage.js';
import { signEventWithSavedBunker } from '../auth-bunker.js';
import { readBody } from './_shared.js';

function json(res: http.ServerResponse, status: number, body: any): true {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

// Centralised "where's my owner" lookup. Returns null when setup isn't
// finished (no npub configured), so handlers can 400 with a clear hint
// rather than 500 on a broken assumption.
function ownerInfo(): { npub: string; hex: string } | null {
  const ident = readIdentity();
  if (!ident.npub) return null;
  try {
    const hex = npubToHex(ident.npub).toLowerCase();
    return { npub: ident.npub, hex };
  } catch {
    return null;
  }
}

export async function handleSign(
  req:    http.IncomingMessage,
  res:    http.ServerResponse,
  url:    string,
  method: string,
): Promise<boolean> {
  if (!url.startsWith('/api/sign/')) return false;
  const u = new URL(url, 'http://localhost');
  const path = u.pathname;

  // GET /api/sign/status — { bunkerPaired, ownerNpub, ownerHex }.
  //
  // The Config toggle calls this on render to decide whether station-
  // signing is even configurable. If no bunker is paired, the toggle
  // disables itself and points at the setup wizard instead. Cheap —
  // just disk lookups, no network.
  if (path === '/api/sign/status' && method === 'GET') {
    const owner = ownerInfo();
    if (!owner) {
      return json(res, 200, { bunkerPaired: false, ownerNpub: null, ownerHex: null });
    }
    const saved = readSavedBunkerClient(owner.npub);
    return json(res, 200, {
      bunkerPaired: !!saved,
      ownerNpub:    owner.npub,
      ownerHex:     owner.hex,
    });
  }

  // GET /api/sign/pubkey — { pubkey: hex, npub }.
  //
  // Implements the getPublicKey() half of the NIP-07 contract for the
  // station-signer shim. The pubkey lives in identity.json (the npub
  // the user paired during setup); no bunker round-trip needed.
  if (path === '/api/sign/pubkey' && method === 'GET') {
    const owner = ownerInfo();
    if (!owner) return json(res, 400, { error: 'no station owner configured — finish setup first' });
    return json(res, 200, { pubkey: owner.hex, npub: owner.npub });
  }

  // POST /api/sign/event — sign an arbitrary event template via the
  // saved bunker pairing.
  //
  // Body: { template: { kind: number, created_at: number, tags: string[][], content: string } }
  // Resp: { ok: true,  signedEvent }
  //   |   { ok: false, error: string, tried: bool }
  //
  // Unlike /api/client/publish (which whitelists kinds 1/6/7 and
  // broadcasts to the station's read relays), this endpoint signs ANY
  // kind and returns the signed event without broadcasting. Ditto
  // handles its own relay fan-out — it just needs a signature.
  //
  // The 60s timeout matches /api/client/publish; bunker round-trips can
  // legitimately take 10-30s when Amber prompts the user on first
  // approval, and we'd rather wait than fail a real sign request.
  if (path === '/api/sign/event' && method === 'POST') {
    let body: any;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'bad json' }); }

    const t = body?.template;
    if (!t || typeof t !== 'object') {
      return json(res, 400, { error: 'template required' });
    }
    if (typeof t.kind !== 'number' ||
        typeof t.created_at !== 'number' ||
        typeof t.content !== 'string' ||
        !Array.isArray(t.tags)) {
      return json(res, 400, { error: 'template missing kind/created_at/tags/content' });
    }
    // Shallow tag-shape check — every tag must be an array of strings.
    // BunkerSigner.signEvent will accept anything we hand it, but
    // malformed tags would fail at the signer or at verifyEvent time;
    // catching the obvious shape errors here keeps the diagnostic
    // close to the bad input.
    for (const tag of t.tags) {
      if (!Array.isArray(tag) || !tag.every((x: any) => typeof x === 'string')) {
        return json(res, 400, { error: 'tags must be string[][]' });
      }
    }

    const owner = ownerInfo();
    if (!owner) return json(res, 400, { error: 'no station owner configured — finish setup first' });

    const result = await signEventWithSavedBunker(
      {
        kind:       t.kind,
        created_at: t.created_at,
        tags:       t.tags,
        content:    t.content,
      },
      60_000,
    );
    if (!result.ok || !result.signedEvent) {
      // tried=false → no saved bunker (configuration problem, 400).
      // tried=true  → bunker round-trip failed (502 upstream-ish).
      return json(res, result.tried ? 502 : 400, {
        ok:    false,
        error: result.error || 'sign failed',
        tried: result.tried,
      });
    }
    // Sanity: the signed event's pubkey should match the station owner.
    // Defensive — if a future bunker pairing somehow drifts off-owner,
    // surface it rather than silently signing as someone else.
    if (typeof result.signedEvent.pubkey === 'string' &&
        result.signedEvent.pubkey.toLowerCase() !== owner.hex) {
      return json(res, 500, {
        ok:    false,
        error: 'signed event pubkey does not match station owner',
      });
    }
    return json(res, 200, { ok: true, signedEvent: result.signedEvent });
  }

  return false;
}
