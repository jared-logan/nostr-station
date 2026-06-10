/**
 * App Center routes — manage the station owner's NIP-89 "handler
 * information" events (kind 31990) from the dashboard #apps panel.
 *
 * A kind-31990 event advertises an application to the network: which
 * event kinds it can open (`k` tags), where to open them (`web` / `ios`
 * / `android` handler tags with a `<bech32>` placeholder), free-form
 * categories (`t` tags), and a kind-0-shaped JSON `content` carrying the
 * app's name / about / picture / banner / website / lud16 / nip05.
 *
 * Every event this surface publishes is auto-stamped with the canonical
 * 4-element nostr-station `client` tag (src/lib/client-tag.ts) — so an
 * app you publish here links back to nostr-station as the tool that
 * created it, exactly the way a kind-1 from the Client panel does.
 *
 * Signing mirrors the Client panel's two-mode contract:
 *   - bunker:  server signs the template via the saved Amber pairing
 *   - nip07:   the browser pre-signs and POSTs the signed event back
 * plus an owner-only third mode:
 *   - project: sign locally with NOSTR_STATION_NSEC (the project key
 *              that anchors the nostr-station handler the client tag
 *              points at). Only available when that env var is set and
 *              derives to the project pubkey.
 *
 * Surface:
 *   GET  /api/apps/signers            — which signing identities are available
 *   GET  /api/apps/list?author=me|project
 *                                     — kind-31990 events authored by that key
 *   POST /api/apps/publish/build      — build the unsigned template (NIP-07 flow)
 *   POST /api/apps/publish            — sign (bunker/project) + broadcast, or
 *                                       broadcast a pre-signed NIP-07 event
 *   POST /api/apps/upload             — upload an icon/banner blob to Blossom,
 *                                       returns the hosted URL (the "Upload" tab)
 *   POST /api/apps/delete             — publish a NIP-09 deletion request
 *
 * Returns `true` when matched and a response was written; `false` lets
 * the orchestrator continue trying its remaining route groups.
 */
import http from 'http';
import { readIdentity, npubToHex, getEffectiveReadRelays } from '../identity.js';
import { queryRelaysDirect as queryRelays, type NostrEvent } from '../nostr-query.js';
import { signEventWithSavedBunker } from '../auth-bunker.js';
import { readSavedBunkerClient } from '../bunker-storage.js';
import { publishEventToRelays } from './repo.js';
import { stampClientTag, CLIENT_HANDLER_PUBKEY } from '../client-tag.js';
import { readBody } from './_shared.js';
import {
  sha256Hex, buildUploadAuthTemplate, uploadBlobs,
  type BlobToUpload,
} from '../blossom-upload.js';
import { readNsiteConfig, effectiveDeployBlossomServers } from '../nsite-config.js';

// ── Constants ──────────────────────────────────────────────────────────────

const HANDLER_KIND = 31990;
const DELETE_KIND  = 5;
const RELAY_QUERY_TIMEOUT_MS = 8_000;
const MAX_CONTENT_FIELD = 4_000;
const MAX_IMAGE_BYTES   = 8 * 1024 * 1024; // 8 MB — generous for an icon/banner

// Tag names with dedicated form fields. Everything else a fetched event
// carries (that isn't bookkeeping) round-trips through the "Additional
// tags" editor so a republish never silently drops data.
const STRUCTURED_TAGS = new Set(['d', 'k', 'web', 'ios', 'android', 't', 'client', 'alt']);

// Handler platforms we expose as first-class rows. NIP-89 also allows
// other platform names; any we don't recognize fall through to extra tags.
const HANDLER_PLATFORMS = new Set(['web', 'ios', 'android']);

// MIME → extension for the hosted Blossom URL. Blossom is content-addressed
// (the path is the sha256) so the extension is cosmetic, but a real
// extension makes the URL render inline in more clients.
const MIME_EXT: Record<string, string> = {
  'image/png':  'png',
  'image/jpeg': 'jpg',
  'image/jpg':  'jpg',
  'image/gif':  'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};

// ── Helpers ──────────────────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, body: object): boolean {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

function ownerHex(): string | null {
  const ident = readIdentity();
  if (!ident.npub) return null;
  try { return npubToHex(ident.npub).toLowerCase(); }
  catch { return null; }
}

function readRelays(): string[] {
  return getEffectiveReadRelays().filter(r => /^wss?:\/\//i.test(r));
}

function capRelays(relays: string[]): string[] {
  return relays.slice(0, 8);
}

// True when NOSTR_STATION_NSEC is set AND derives to the project pubkey
// the client tag points at. The owner-only "project" signing mode is
// gated on this — for everyone else the option is simply absent.
async function projectKeyAvailable(): Promise<boolean> {
  const sk = await decodeProjectSecret();
  return sk !== null;
}

async function decodeProjectSecret(): Promise<Uint8Array | null> {
  const nsec = process.env.NOSTR_STATION_NSEC;
  if (!nsec) return null;
  try {
    const { nip19, getPublicKey } = await import('nostr-tools');
    const decoded = nip19.decode(nsec);
    if (decoded.type !== 'nsec') return null;
    const sk = decoded.data as Uint8Array;
    if (getPublicKey(sk).toLowerCase() !== CLIENT_HANDLER_PUBKEY) return null;
    return sk;
  } catch {
    return null;
  }
}

// Slugify a free-form name into a stable `d`-tag identifier. Keeps the
// addressable coordinate URL-safe and predictable.
function slugify(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// ── Template builder (shared by /publish and /publish/build) ─────────────
//
// Single source of truth for turning the form body into an unsigned
// kind-31990 template, so the bunker, project, and NIP-07 paths all emit
// an identical tag set. The author's pubkey is NOT needed here — the
// signer fills it in.
type TemplateBuildResult =
  | { ok: true;  template: { kind: number; created_at: number; tags: string[][]; content: string } }
  | { ok: false; error: string };

function str(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }

export function buildAppTemplate(body: any): TemplateBuildResult {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body required' };

  // ── content (kind-0-shaped JSON) ──
  const name    = str(body.name);
  if (!name) return { ok: false, error: 'name required' };

  const contentObj: Record<string, string> = {};
  const setField = (key: string, val: string) => {
    if (!val) return;
    if (val.length > MAX_CONTENT_FIELD) return; // silently skip oversize
    contentObj[key] = val;
  };
  setField('name',    name);
  setField('about',   str(body.about));
  setField('picture', str(body.picture));
  setField('banner',  str(body.banner));
  setField('website', str(body.website));
  setField('lud16',   str(body.lud16));
  setField('nip05',   str(body.nip05));

  // ── d-tag (the addressable identifier) ──
  // An EXPLICIT d-tag is preserved verbatim — it's the replaceable address,
  // and re-slugifying it (which lowercases) would change the coordinate and
  // fork a NEW app instead of replacing the existing one (e.g. editing
  // "nostrVM" must NOT become "nostrvm"). Only DERIVE-from-name slugifies.
  const explicitD = str(body.d);
  const dTag = explicitD || slugify(name);
  if (!dTag) return { ok: false, error: 'could not derive a valid identifier (d-tag) — set a Name or App identifier' };

  const tags: string[][] = [['d', dTag]];

  // ── k tags (supported kinds) ──
  if (body.kinds != null) {
    if (!Array.isArray(body.kinds)) return { ok: false, error: 'kinds must be an array' };
    const seen = new Set<string>();
    for (const raw of body.kinds) {
      const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        return { ok: false, error: `invalid kind: ${raw}` };
      }
      const s = String(n);
      if (seen.has(s)) continue;
      seen.add(s);
      tags.push(['k', s]);
    }
  }

  // ── handler tags (web / ios / android) ──
  if (body.handlers != null) {
    if (!Array.isArray(body.handlers)) return { ok: false, error: 'handlers must be an array' };
    for (const h of body.handlers) {
      if (!h || typeof h !== 'object') continue;
      const platform = str(h.platform).toLowerCase();
      const template = str(h.template);
      if (!platform || !template) continue;
      if (!HANDLER_PLATFORMS.has(platform)) {
        return { ok: false, error: `unsupported handler platform: ${platform}` };
      }
      // <bech32> is OPTIONAL: a template with the placeholder opens a
      // specific entity (nevent/naddr/…); a plain URL just opens the app
      // (e.g. a homepage handler, as nostrVM publishes). NIP-89 allows
      // both. The entity type is only meaningful alongside a placeholder.
      const hasPlaceholder = template.includes('<bech32>');
      const entity = hasPlaceholder ? str(h.entity) : '';
      tags.push(entity ? [platform, template, entity] : [platform, template]);
    }
  }

  // ── t tags (categories) ──
  if (body.topics != null) {
    if (!Array.isArray(body.topics)) return { ok: false, error: 'topics must be an array' };
    const seen = new Set<string>();
    for (const raw of body.topics) {
      const t = str(raw).toLowerCase();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      tags.push(['t', t]);
    }
  }

  // ── arbitrary extra tags (round-tripped from the editor) ──
  if (body.extraTags != null) {
    if (!Array.isArray(body.extraTags)) return { ok: false, error: 'extraTags must be an array' };
    for (const raw of body.extraTags) {
      if (!Array.isArray(raw) || raw.length === 0) continue;
      const tagName = str(raw[0]);
      if (!tagName || STRUCTURED_TAGS.has(tagName)) continue; // never let extras shadow structured tags
      const values = raw.slice(1).map(v => (typeof v === 'string' ? v : String(v ?? '')));
      tags.push([tagName, ...values]);
    }
  }

  // ── canonical nostr-station client tag (always) ──
  stampClientTag(tags);

  return {
    ok: true,
    template: {
      kind: HANDLER_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: JSON.stringify(contentObj),
    },
  };
}

// Parse a fetched kind-31990 into the shape the editor consumes. The
// inverse of buildAppTemplate — structured tags become fields, the rest
// become extraTags so nothing is lost on republish.
interface AppSummary {
  id:        string;
  pubkey:    string;
  created_at: number;
  d:         string;
  name:      string;
  about:     string;
  picture:   string;
  banner:    string;
  website:   string;
  lud16:     string;
  nip05:     string;
  kinds:     number[];
  handlers:  { platform: string; template: string; entity: string }[];
  topics:    string[];
  extraTags: string[][];
}

export function parseHandlerEvent(ev: NostrEvent): AppSummary {
  let content: any = {};
  try { content = JSON.parse(ev.content || '{}'); } catch { content = {}; }
  const field = (k: string) => (typeof content[k] === 'string' ? content[k] : '');

  const out: AppSummary = {
    id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at,
    d: '', name: field('name') || field('display_name'),
    about: field('about'), picture: field('picture'), banner: field('banner'),
    website: field('website'), lud16: field('lud16'), nip05: field('nip05'),
    kinds: [], handlers: [], topics: [], extraTags: [],
  };

  for (const t of ev.tags) {
    if (!Array.isArray(t) || typeof t[0] !== 'string') continue;
    const [name, ...rest] = t;
    if (name === 'd') { out.d = typeof rest[0] === 'string' ? rest[0] : ''; continue; }
    if (name === 'k') {
      const n = parseInt(String(rest[0]), 10);
      if (Number.isInteger(n)) out.kinds.push(n);
      continue;
    }
    if (HANDLER_PLATFORMS.has(name)) {
      const template = typeof rest[0] === 'string' ? rest[0] : '';
      if (template) out.handlers.push({ platform: name, template, entity: typeof rest[1] === 'string' ? rest[1] : '' });
      continue;
    }
    if (name === 't') { if (typeof rest[0] === 'string') out.topics.push(rest[0]); continue; }
    if (name === 'client' || name === 'alt') continue; // bookkeeping — re-stamped on republish
    out.extraTags.push([name, ...rest.map(v => (typeof v === 'string' ? v : String(v ?? '')))]);
  }
  return out;
}

// Pick the newest event per d-tag (replaceable: relays may still hand back
// a stale duplicate from a slow mirror).
function newestByDTag(events: NostrEvent[]): NostrEvent[] {
  const byD = new Map<string, NostrEvent>();
  for (const ev of events) {
    if (ev.kind !== HANDLER_KIND) continue;
    const d = ev.tags.find(t => t[0] === 'd')?.[1] ?? '';
    const prev = byD.get(d);
    if (!prev || ev.created_at > prev.created_at) byD.set(d, ev);
  }
  return [...byD.values()].sort((a, b) => b.created_at - a.created_at);
}

// Sign a template via the requested mode. Returns the Client-panel-style
// result shape so the publish handler can branch on tried/error uniformly.
async function signTemplate(
  template: { kind: number; created_at: number; tags: string[][]; content: string },
  signWith: 'bunker' | 'project',
): Promise<{ ok: boolean; tried: boolean; signedEvent?: any; error?: string }> {
  if (signWith === 'project') {
    const sk = await decodeProjectSecret();
    if (!sk) return { ok: false, tried: false, error: 'project key not available (NOSTR_STATION_NSEC unset or mismatched)' };
    try {
      const { finalizeEvent } = await import('nostr-tools');
      return { ok: true, tried: true, signedEvent: finalizeEvent(template, sk) };
    } catch (e: any) {
      return { ok: false, tried: true, error: e?.message || 'project sign failed' };
    }
  }
  return signEventWithSavedBunker(template, 60_000);
}

// Validate a browser-signed kind-24242 authorization (NIP-07 upload path).
// Must be a verifiable 24242 that covers `sha256`, isn't expired, and is
// signed by the station owner (when one is configured).
async function validatePresignedAuth(
  headerB64: string,
  sha256: string,
  owner: string | null,
): Promise<{ ok: true; event: any } | { ok: false; error: string }> {
  let ev: any;
  try {
    ev = JSON.parse(Buffer.from(headerB64, 'base64').toString('utf8'));
  } catch {
    return { ok: false, error: 'X-Auth-Event is not valid base64 JSON' };
  }
  if (!ev || ev.kind !== 24242 || !Array.isArray(ev.tags) || typeof ev.sig !== 'string') {
    return { ok: false, error: 'X-Auth-Event must be a signed kind-24242 event' };
  }
  if (owner && typeof ev.pubkey === 'string' && ev.pubkey.toLowerCase() !== owner && ev.pubkey.toLowerCase() !== CLIENT_HANDLER_PUBKEY) {
    return { ok: false, error: 'upload authorization signed by an unexpected key' };
  }
  const coversHash = ev.tags.some((t: unknown) => Array.isArray(t) && t[0] === 'x' && String(t[1]).toLowerCase() === sha256);
  if (!coversHash) return { ok: false, error: 'upload authorization does not cover this image' };
  const exp = ev.tags.find((t: unknown) => Array.isArray(t) && t[0] === 'expiration')?.[1];
  if (exp && Number(exp) < Math.floor(Date.now() / 1000)) {
    return { ok: false, error: 'upload authorization has expired — retry' };
  }
  const { verifyEvent } = await import('nostr-tools/pure');
  let valid = false;
  try { valid = verifyEvent(ev); } catch { valid = false; }
  if (!valid) return { ok: false, error: 'upload authorization signature invalid' };
  return { ok: true, event: ev };
}

// ── Route ──────────────────────────────────────────────────────────────

export async function handleApps(
  req:    http.IncomingMessage,
  res:    http.ServerResponse,
  url:    string,
  method: string,
): Promise<boolean> {
  if (!url.startsWith('/api/apps/')) return false;
  const path = url.split('?')[0];

  // ── GET /api/apps/signers ────────────────────────────────────────────────
  if (path === '/api/apps/signers' && method === 'GET') {
    const ident = readIdentity();
    const me = ownerHex();
    const bunker = !!(ident.npub && readSavedBunkerClient(ident.npub));
    return json(res, 200, {
      owner:           me,
      bunker,
      project:         await projectKeyAvailable(),
      projectPubkey:   CLIENT_HANDLER_PUBKEY,
    });
  }

  // ── GET /api/apps/list?author=me|project ─────────────────────────────────
  if (path === '/api/apps/list' && method === 'GET') {
    const author = new URL(url, 'http://x').searchParams.get('author') || 'me';
    const pubkey = author === 'project' ? CLIENT_HANDLER_PUBKEY : ownerHex();
    if (!pubkey) {
      return json(res, 200, { apps: [], unavailable: true, reason: 'no-owner',
        empty: 'no station owner configured — finish setup first' });
    }
    const relays = capRelays(readRelays());
    if (relays.length === 0) {
      return json(res, 200, { apps: [], unavailable: true, reason: 'no-read-relays',
        empty: 'no read relays configured — add one in Config → Identity' });
    }
    try {
      const r = await queryRelays({
        filter: { kinds: [HANDLER_KIND], authors: [pubkey], limit: 200 },
        relays,
        timeoutMs: RELAY_QUERY_TIMEOUT_MS,
        stream: false,
      });
      const apps = newestByDTag(r.events).map(parseHandlerEvent);
      return json(res, 200, { apps, author, pubkey });
    } catch (e: any) {
      return json(res, 502, { error: e?.message || 'relay query failed', apps: [] });
    }
  }

  // ── POST /api/apps/publish/build ─────────────────────────────────────────
  // Returns the unsigned template for the NIP-07 (browser-extension) flow.
  if (path === '/api/apps/publish/build' && method === 'POST') {
    let body: any;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'bad json' }); }
    const built = buildAppTemplate(body);
    if (!built.ok) return json(res, 400, { error: built.error });
    return json(res, 200, { template: built.template });
  }

  // ── POST /api/apps/publish ───────────────────────────────────────────────
  //
  // Two body shapes:
  //   1. { ...formFields, signWith?: 'bunker'|'project' } — server signs.
  //   2. { event: SignedEvent } — pre-signed via NIP-07; server broadcasts.
  if (path === '/api/apps/publish' && method === 'POST') {
    let body: any;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'bad json' }); }

    const me = ownerHex();
    let signedEvent: any;

    if (body && body.event && typeof body.event === 'object') {
      // Mode 2 — pre-signed NIP-07 event.
      const ev = body.event;
      if (typeof ev.id !== 'string' || typeof ev.sig !== 'string' ||
          typeof ev.pubkey !== 'string' || ev.kind !== HANDLER_KIND ||
          typeof ev.created_at !== 'number' || !Array.isArray(ev.tags) ||
          typeof ev.content !== 'string') {
        return json(res, 400, { error: 'event must be a signed kind-31990' });
      }
      const pk = ev.pubkey.toLowerCase();
      // Accept the station owner OR the project key (owner publishing the
      // nostr-station self-handler) — but nothing else.
      if (pk !== me && pk !== CLIENT_HANDLER_PUBKEY) {
        return json(res, 403, { error: 'event pubkey is neither the station owner nor the project key' });
      }
      const { verifyEvent } = await import('nostr-tools/pure');
      let valid = false;
      try { valid = verifyEvent(ev); } catch { valid = false; }
      if (!valid) return json(res, 400, { error: 'event signature invalid' });
      signedEvent = ev;
    } else {
      // Mode 1 — server signs.
      const signWith: 'bunker' | 'project' = body?.signWith === 'project' ? 'project' : 'bunker';
      if (signWith === 'bunker' && !me) {
        return json(res, 400, { error: 'no station owner configured — finish setup first' });
      }
      const built = buildAppTemplate(body);
      if (!built.ok) return json(res, 400, { error: built.error });
      const signed = await signTemplate(built.template, signWith);
      if (!signed.ok || !signed.signedEvent) {
        return json(res, signed.tried ? 502 : 400, { error: signed.error || 'sign failed', tried: signed.tried });
      }
      signedEvent = signed.signedEvent;
    }

    const relays = capRelays(readRelays());
    if (relays.length === 0) {
      return json(res, 502, { error: 'no read relays configured — cannot broadcast', signedEvent });
    }
    const results = await publishEventToRelays(signedEvent, relays);
    const accepted = results.filter(r => r.ok).length;
    return json(res, accepted > 0 ? 200 : 502, {
      ok: accepted > 0, signedEvent, publish: results, accepted, targets: relays.length,
    });
  }

  // ── GET /api/apps/upload/auth?sha256=… ───────────────────────────────────
  // Returns the unsigned kind-24242 BUD-02 authorization template for a
  // given blob hash. The NIP-07 upload path fetches this, signs it with
  // window.nostr, and threads the signed event back via the X-Auth-Event
  // header on the upload POST — so a browser-extension user (no server
  // signer) can still upload.
  if (path === '/api/apps/upload/auth' && method === 'GET') {
    const sha256 = (new URL(url, 'http://x').searchParams.get('sha256') || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) return json(res, 400, { error: 'sha256 must be 64-char hex' });
    return json(res, 200, { template: buildUploadAuthTemplate([sha256]) });
  }

  // ── POST /api/apps/upload ────────────────────────────────────────────────
  //
  // Raw image bytes in the request body. Headers:
  //   Content-Type   — the image MIME (png/jpeg/gif/webp/svg/avif)
  //   X-Sign-With    — 'bunker' (default) | 'project'  (server signs the auth)
  //   X-Auth-Event   — base64 of a pre-signed kind-24242 (NIP-07 path); when
  //                    present the server skips its own signing and just does
  //                    the Blossom PUTs with the supplied authorization.
  // Returns { url } pointing at the blob on the first server that accepted.
  if (path === '/api/apps/upload' && method === 'POST') {
    const mime = (req.headers['content-type'] || '').toString().split(';')[0].trim().toLowerCase();
    if (!MIME_EXT[mime]) {
      return json(res, 400, { error: `unsupported image type: ${mime || '(none)'} — use PNG, JPG, GIF, WebP, SVG, or AVIF` });
    }
    const bytes = await readRawBody(req, MAX_IMAGE_BYTES);
    if (!bytes) return json(res, 413, { error: `image too large (max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB)` });
    if (bytes.length === 0) return json(res, 400, { error: 'empty image body' });

    const servers = effectiveDeployBlossomServers(readNsiteConfig());
    if (servers.length === 0) return json(res, 502, { error: 'no Blossom servers configured' });

    const sha256 = sha256Hex(bytes);

    // Resolve the signed BUD-02 authorization — either pre-signed by the
    // browser (NIP-07) or signed server-side (bunker / project key).
    let authEvent: any;
    const headerAuth = req.headers['x-auth-event'];
    if (typeof headerAuth === 'string' && headerAuth.length > 0) {
      const checked = await validatePresignedAuth(headerAuth, sha256, ownerHex());
      if (!checked.ok) return json(res, 400, { error: checked.error });
      authEvent = checked.event;
    } else {
      const signWith: 'bunker' | 'project' = (req.headers['x-sign-with'] === 'project') ? 'project' : 'bunker';
      const signed = await signTemplate(
        // buildUploadAuthTemplate is kind 24242; signTemplate's type wants the
        // generic template shape, which it structurally matches.
        buildUploadAuthTemplate([sha256]) as unknown as { kind: number; created_at: number; tags: string[][]; content: string },
        signWith,
      );
      if (!signed.ok || !signed.signedEvent) {
        return json(res, signed.tried ? 502 : 400, { error: signed.error || 'could not sign upload authorization', tried: signed.tried });
      }
      authEvent = signed.signedEvent;
    }

    const blob: BlobToUpload = { sha256, bytes, mime };
    let results;
    try {
      results = await uploadBlobs({ servers, blobs: [blob], authEvent });
    } catch (e: any) {
      return json(res, 502, { error: e?.message || 'upload failed' });
    }
    const blobResult = results[0];
    if (!blobResult || !blobResult.ok) {
      return json(res, 502, { error: 'no Blossom server accepted the upload', detail: blobResult?.servers });
    }
    const okServer = blobResult.servers.find(s => s.ok);
    const base = (okServer?.server || servers[0]).replace(/\/+$/, '');
    const url = `${base}/${sha256}.${MIME_EXT[mime]}`;
    return json(res, 200, { url, sha256, servers: blobResult.servers });
  }

  // ── POST /api/apps/delete ────────────────────────────────────────────────
  // Publishes a NIP-09 kind-5 deletion request for an app's coordinate.
  // Replaceable events can't be truly erased, but this signals retraction.
  if (path === '/api/apps/delete' && method === 'POST') {
    let body: any;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'bad json' }); }

    const me = ownerHex();
    let signedEvent: any;

    if (body && body.event && typeof body.event === 'object') {
      // Pre-signed kind-5 from a NIP-07 signer.
      const ev = body.event;
      if (ev.kind !== DELETE_KIND || typeof ev.sig !== 'string' || typeof ev.pubkey !== 'string') {
        return json(res, 400, { error: 'event must be a signed kind-5 deletion' });
      }
      const pk = ev.pubkey.toLowerCase();
      if (pk !== me && pk !== CLIENT_HANDLER_PUBKEY) {
        return json(res, 403, { error: 'deletion pubkey is neither the station owner nor the project key' });
      }
      const { verifyEvent } = await import('nostr-tools/pure');
      let valid = false;
      try { valid = verifyEvent(ev); } catch { valid = false; }
      if (!valid) return json(res, 400, { error: 'deletion signature invalid' });
      signedEvent = ev;
    } else {
      const dTag = str(body?.d);
      if (!dTag) return json(res, 400, { error: 'd (app identifier) required' });
      const signWith: 'bunker' | 'project' = body?.signWith === 'project' ? 'project' : 'bunker';
      const authorPubkey = signWith === 'project' ? CLIENT_HANDLER_PUBKEY : me;
      if (!authorPubkey) return json(res, 400, { error: 'no station owner configured' });
      const template = {
        kind: DELETE_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['a', `${HANDLER_KIND}:${authorPubkey}:${dTag}`],
          ['k', String(HANDLER_KIND)],
        ],
        content: str(body?.reason) || 'Retracted via nostr-station App Center',
      };
      const signed = await signTemplate(template, signWith);
      if (!signed.ok || !signed.signedEvent) {
        return json(res, signed.tried ? 502 : 400, { error: signed.error || 'sign failed', tried: signed.tried });
      }
      signedEvent = signed.signedEvent;
    }
    const relays = capRelays(readRelays());
    if (relays.length === 0) return json(res, 502, { error: 'no read relays configured' });
    const results = await publishEventToRelays(signedEvent, relays);
    const accepted = results.filter(r => r.ok).length;
    return json(res, accepted > 0 ? 200 : 502, { ok: accepted > 0, accepted, targets: relays.length });
  }

  return false;
}

// Buffer the raw request body up to `max` bytes. Returns null if the body
// exceeds the cap (so the caller can answer 413 without buffering forever).
function readRawBody(req: http.IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      total += c.length;
      if (total > max) { aborted = true; resolve(null); try { req.destroy(); } catch {} return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)); });
    req.on('error', () => { if (!aborted) { aborted = true; resolve(null); } });
  });
}
