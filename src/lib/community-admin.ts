/**
 * NIP-86 (Managed Relays) RPC client for the community supervisor.
 *
 * Wire format:
 *   POST <relay-root> with Content-Type: application/nostr+json+rpc
 *   Body: { "method": "<verb>", "params": [...] }
 *   Authorization: Nostr <base64(NIP-98 event)>
 *
 * Response (per NIP-86):
 *   { "result": <any>, "error": "<msg|null>" }
 *
 * The Authorization header is a base64-encoded kind-27235 (NIP-98)
 * event signed by the community's adminPubkey via the saved Amber
 * bunker. We sign per call; a future commit adds the time-bounded
 * "silent-sign delegation" (8h trust window) the plan describes, so
 * a moderator triaging a flood isn't prompted for every action.
 *
 * Stays focused on the verbs we wire into the dashboard UI today —
 * pubkey allow/ban + listing them, kind allow/disallow + listing,
 * relay metadata + stats. The full NIP-86 method set (event bans, IP
 * bans, etc.) is reachable through callCommunityAdmin() with any
 * method string, but we don't expose typed wrappers for everything
 * until UI exercises them.
 */

import { createHash } from 'node:crypto';
import { signEventWithSavedBunker } from './auth-bunker.js';
import { readCommunityManifest } from './communities.js';
import { readGrainConfig } from './community-yaml.js';
import { communityConfigPath } from './communities.js';
import { communityDir } from './communities.js';
import { parseHostPort } from './community-process.js';

// =====================================================================
// Wire-level types

/** NIP-86 RPC request body. */
export interface AdminRpcRequest {
  method: string;
  params: unknown[];
}

/** NIP-86 RPC response body (loose typing — `result` shape is per-method). */
export interface AdminRpcResponse {
  result?: unknown;
  error?:  string | null;
}

export interface AdminCallResult {
  ok:        boolean;
  /** The parsed response body when ok=true. */
  response?: AdminRpcResponse;
  /** Human-readable diagnostic — never raw stderr or HTML, capped at
   *  ~240 chars so this is safe to surface directly in the UI. */
  detail?:   string;
}

// =====================================================================
// NIP-98 Authorization header

/** NIP-98 kind for HTTP auth. */
const NIP98_KIND = 27235;

/**
 * Build the NIP-98 Authorization header for a single HTTP request.
 * Signs a kind-27235 event with `u`/`method`/`payload` tags via the
 * saved Amber bunker. The signed event is base64-encoded into the
 * `Authorization: Nostr <b64>` header per NIP-98.
 *
 * The `payload` tag is the lowercase-hex SHA-256 of the (UTF-8)
 * request body. We always include it for POST so a MITM can't swap
 * the body while keeping the same auth event.
 *
 * Returns `null` on signing failure with a `detail` describing why
 * (no saved bunker, sign timeout, etc.) — callers map that to the
 * UI's "re-auth needed" banner.
 */
async function buildNip98Header(
  url: string,
  method: 'GET' | 'POST',
  body: string,
): Promise<{ ok: true; header: string } | { ok: false; detail: string }> {
  const payloadHash = payloadHashHex(body);
  const template = {
    kind:       NIP98_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['u',       url],
      ['method',  method],
      ['payload', payloadHash],
    ],
    content: '',
  };

  const signed = await signEventWithSavedBunker(template);
  if (!signed.ok) {
    return {
      ok:     false,
      detail: `NIP-98 signing failed: ${signed.error ?? 'no detail'} ` +
              `(re-pair your dashboard signer if this persists)`,
    };
  }
  const eventJson = JSON.stringify(signed.signedEvent);
  const b64       = Buffer.from(eventJson, 'utf8').toString('base64');
  return { ok: true, header: `Nostr ${b64}` };
}

// =====================================================================
// Bind-address resolution

/**
 * Resolve the URL we POST NIP-86 calls to for a given community.
 * Reads the community's live config.yml so a user who manually
 * changed `server.port` (e.g. moved it to a different interface) is
 * honored without restarting the supervisor.
 */
function communityAdminUrl(id: string): string | null {
  const manifest = readCommunityManifest(id);
  if (!manifest) return null;
  try {
    const cfg = readGrainConfig(communityConfigPath(communityDir(id)));
    const { host, port } = parseHostPort(cfg.server.port);
    // NIP-86 specifies the root URL. We don't add a trailing `admin`
    // path — GRAIN's NIP-86 listener routes off the Content-Type.
    // The hostname falls back to loopback when the bind is `:<port>`
    // (bare-port form), matching the healthcheck probe.
    return `http://${host || '127.0.0.1'}:${port}/`;
  } catch {
    return null;
  }
}

// =====================================================================
// Core call

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Make a NIP-86 RPC call against a community. Returns ok=false with
 * a populated `detail` on any failure (signing, network, HTTP 4xx/5xx,
 * malformed response). On success, `response` is the parsed body —
 * note that NIP-86 itself can return `{error: "..."}` at the response
 * level even when HTTP succeeds; callers check `response.error`.
 */
export async function callCommunityAdmin(
  id:       string,
  rpc:      AdminRpcRequest,
  opts: { timeoutMs?: number } = {},
): Promise<AdminCallResult> {
  const url = communityAdminUrl(id);
  if (!url) {
    return { ok: false, detail: `community ${id} not found or has no valid bind config` };
  }
  const body = JSON.stringify(rpc);

  const auth = await buildNip98Header(url, 'POST', body);
  if (!auth.ok) return { ok: false, detail: auth.detail };

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/nostr+json+rpc',
        'Authorization': auth.header,
      },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // Read but cap the response body — a misconfigured upstream
      // could return HTML or a large error page.
      let text = '';
      try { text = (await res.text()).slice(0, 240); } catch {}
      return {
        ok: false,
        detail: `HTTP ${res.status} from ${url}: ${text || res.statusText}`,
      };
    }
    let parsed: AdminRpcResponse;
    try {
      parsed = (await res.json()) as AdminRpcResponse;
    } catch (e: any) {
      return { ok: false, detail: `unparseable JSON-RPC response: ${(e?.message ?? '').slice(0, 200)}` };
    }
    return { ok: true, response: parsed };
  } catch (e: any) {
    const reason = e?.name === 'AbortError'
      ? `request timed out after ${timeoutMs} ms`
      : (e?.message ?? String(e)).slice(0, 240);
    return { ok: false, detail: reason };
  } finally {
    clearTimeout(timer);
  }
}

// =====================================================================
// Typed verb wrappers
//
// Each helper validates inputs minimally (hex pubkey shape, non-empty
// reason allowed-but-trimmed) and threads through callCommunityAdmin.
// The method names match NIP-86 spec verbatim.

function assertHex64(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${label} must be 64-char lowercase hex; got ${value.slice(0, 12)}…`);
  }
}

export async function banPubkey(id: string, pubkeyHex: string, reason = ''): Promise<AdminCallResult> {
  assertHex64(pubkeyHex, 'pubkey');
  return callCommunityAdmin(id, { method: 'banpubkey', params: [pubkeyHex.toLowerCase(), reason] });
}

export async function unbanPubkey(id: string, pubkeyHex: string): Promise<AdminCallResult> {
  assertHex64(pubkeyHex, 'pubkey');
  // Spec: `allowpubkey` undoes a ban (moves it back into the allowed
  // set when the relay is allowlist-based). NIP-86 doesn't have a
  // separate `unbanpubkey` verb; we expose this wrapper for UI clarity.
  return callCommunityAdmin(id, { method: 'allowpubkey', params: [pubkeyHex.toLowerCase(), ''] });
}

export async function listBannedPubkeys(id: string): Promise<AdminCallResult> {
  return callCommunityAdmin(id, { method: 'listbannedpubkeys', params: [] });
}

export async function listAllowedPubkeys(id: string): Promise<AdminCallResult> {
  return callCommunityAdmin(id, { method: 'listallowedpubkeys', params: [] });
}

export async function allowKind(id: string, kind: number): Promise<AdminCallResult> {
  if (!Number.isInteger(kind) || kind < 0) throw new Error(`kind must be a non-negative integer; got ${kind}`);
  return callCommunityAdmin(id, { method: 'allowkind', params: [kind] });
}

export async function disallowKind(id: string, kind: number): Promise<AdminCallResult> {
  if (!Number.isInteger(kind) || kind < 0) throw new Error(`kind must be a non-negative integer; got ${kind}`);
  return callCommunityAdmin(id, { method: 'disallowkind', params: [kind] });
}

export async function listAllowedKinds(id: string): Promise<AdminCallResult> {
  return callCommunityAdmin(id, { method: 'listallowedkinds', params: [] });
}

export async function getRelayStats(id: string): Promise<AdminCallResult> {
  return callCommunityAdmin(id, { method: 'stats', params: [] });
}

export async function listSupportedMethods(id: string): Promise<AdminCallResult> {
  return callCommunityAdmin(id, { method: 'supportedmethods', params: [] });
}

// =====================================================================
// Pure helpers (exported so tests can verify the wire shape without
// having a live bunker)

/** Compute the lowercase-hex SHA-256 of the request body — used by
 *  NIP-98 to bind auth to a specific payload. Exported for tests. */
export function payloadHashHex(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** Build the *unsigned* kind-27235 NIP-98 template a caller would
 *  sign. Exported for tests to verify the tag shape. */
export function buildNip98Template(
  url: string,
  method: 'GET' | 'POST',
  body: string,
): { kind: number; created_at: number; tags: string[][]; content: string } {
  return {
    kind:       NIP98_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['u',       url],
      ['method',  method],
      ['payload', payloadHashHex(body)],
    ],
    content: '',
  };
}
