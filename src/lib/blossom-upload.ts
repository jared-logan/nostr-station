/**
 * Blossom upload client (BUD-01 + BUD-02) — the publish-side counterpart
 * to src/blossom/ (which is an in-process READ/WRITE server for local dev).
 *
 * This module uploads blobs to EXTERNAL public Blossom servers as part of
 * the nsite deploy flow. It speaks BUD-02, NOT the NIP-98 (kind 27235)
 * dialect the in-process server validates:
 *
 *   - One kind:24242 authorization event covers a whole batch. It carries
 *     a `["t","upload"]` tag, one `["x", <sha256>]` per blob in the batch,
 *     and an `["expiration", <unix>]`. A single signature authorizes every
 *     blob whose hash appears in the `x` tags until it expires — so the
 *     deploy signs ONCE (one Amber prompt) and reuses the token as the
 *     `Authorization: Nostr <base64(event)>` header for every PUT to every
 *     server. This mirrors exactly what shakespeare.diy signs.
 *
 *   - Per blob, per server: a cheap `HEAD /<sha256>` is tried first. A 200
 *     means the bytes are already there (content-addressed → identical
 *     across deploys), so we skip the PUT. Otherwise `PUT /upload` streams
 *     the raw bytes with the shared auth header.
 *
 * Signing is INJECTED, not done here: the caller passes an already-signed
 * 24242 event (the deploy route signs via signEventWithSavedBunker). That
 * keeps this module free of identity/bunker imports and trivially testable
 * with a local key.
 *
 * Failure model is partial-tolerant: a blob counts as uploaded once it
 * lands on AT LEAST ONE server. The orchestrator reports per-server detail
 * so the caller can surface "3/4 servers ok" without failing the deploy.
 */

import crypto from 'crypto';

// Minimal event shapes — kept local so this module doesn't couple to the
// signer's type surface. A signed event is just the template plus id/sig/
// pubkey, which fetch() never inspects (we only base64 the JSON).
export interface UploadAuthTemplate {
  kind:       24242;
  created_at: number;
  tags:       string[][];
  content:    string;
}

export interface BlobToUpload {
  /** Lowercase hex sha256 of `bytes`. Caller computes; we trust + re-bind. */
  sha256: string;
  bytes:  Buffer;
  /** Content-Type sent on PUT. Defaults to application/octet-stream. */
  mime:   string;
  /** Optional absolute site path (e.g. "/index.html") — for progress logs only. */
  path?:  string;
}

export interface ServerUploadOutcome {
  server:  string;
  ok:      boolean;
  /** True when a HEAD probe found the blob already present (no PUT issued). */
  skipped: boolean;
  status?: number;
  error?:  string;
}

export interface BlobUploadResult {
  sha256:  string;
  path?:   string;
  /** Per-server outcomes, in the order servers were supplied. */
  servers: ServerUploadOutcome[];
  /** True iff the blob now lives on at least one server (PUT ok or skipped). */
  ok:      boolean;
}

export interface UploadProgress {
  /** 1-based index of the blob currently finishing. */
  index: number;
  total: number;
  result: BlobUploadResult;
}

export interface UploadBlobsOptions {
  /** External Blossom base URLs (https://…). Trailing slashes tolerated. */
  servers:   string[];
  blobs:     BlobToUpload[];
  /** A SIGNED kind:24242 event whose `x` tags cover every blob hash. */
  authEvent: unknown;
  /** Per-blob settled callback — drives the deploy SSE progress stream. */
  onProgress?: (p: UploadProgress) => void;
  /** Per-request timeout (HEAD or PUT). Default 30s. */
  timeoutMs?: number;
  /** Max blobs uploaded concurrently. Default 4. */
  concurrency?: number;
}

const DEFAULT_TIMEOUT_MS  = 30_000;
const DEFAULT_CONCURRENCY = 4;
const UPLOAD_AUTH_KIND     = 24242 as const;
/** BUD-02 token lifetime. Matches shakespeare.diy's 1-hour expiry. */
export const UPLOAD_AUTH_TTL_S = 3600;

const HEX64 = /^[0-9a-f]{64}$/;

/** Lowercase-hex sha256 of a buffer. Exported for the deploy walker. */
export function sha256Hex(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Build the unsigned kind:24242 batch-upload authorization template.
 * The caller signs it (once) and threads the signed event into
 * uploadBlobs. Hashes are lowercased, de-duped, and validated; an empty
 * or all-invalid hash set throws rather than producing a token that
 * authorizes nothing.
 */
export function buildUploadAuthTemplate(
  hashes: string[],
  opts?: { now?: number; ttlSeconds?: number; content?: string },
): UploadAuthTemplate {
  const now = opts?.now ?? Math.floor(Date.now() / 1000);
  const ttl = opts?.ttlSeconds ?? UPLOAD_AUTH_TTL_S;

  const seen = new Set<string>();
  const xTags: string[][] = [];
  for (const h of hashes) {
    const hex = String(h || '').trim().toLowerCase();
    if (!HEX64.test(hex) || seen.has(hex)) continue;
    seen.add(hex);
    xTags.push(['x', hex]);
  }
  if (xTags.length === 0) {
    throw new Error('buildUploadAuthTemplate: no valid sha256 hashes to authorize');
  }

  return {
    kind:       UPLOAD_AUTH_KIND,
    created_at: now,
    tags: [
      ['t', 'upload'],
      ...xTags,
      ['expiration', String(now + ttl)],
    ],
    content: opts?.content ?? 'Upload blobs',
  };
}

/** Encode a signed Nostr event as a BUD/NIP-98 `Authorization` header value. */
export function encodeAuthHeader(signedEvent: unknown): string {
  const json = JSON.stringify(signedEvent);
  return `Nostr ${Buffer.from(json, 'utf8').toString('base64')}`;
}

/** Strip a single trailing slash so `${base}/${sha}` never doubles up. */
function normalizeServer(url: string): string {
  return url.replace(/\/+$/, '');
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Upload a single blob to a single server: HEAD-probe to skip existing,
 * else PUT /upload. Never throws — network/abort errors are folded into
 * the returned outcome so one dead server can't sink the batch.
 */
async function uploadOne(
  server: string,
  blob: BlobToUpload,
  authHeader: string,
  timeoutMs: number,
): Promise<ServerUploadOutcome> {
  const base = normalizeServer(server);

  // BUD-01 existence check. Content-addressed storage means a 200 here is
  // definitive — the bytes match the hash by construction. Treat any
  // non-200 (incl. 405 from servers that don't allow HEAD) as "upload it".
  try {
    const head = await fetchWithTimeout(`${base}/${blob.sha256}`, { method: 'HEAD' }, timeoutMs);
    if (head.status === 200) {
      return { server: base, ok: true, skipped: true, status: 200 };
    }
  } catch {
    // HEAD probe failed (timeout / network) — fall through to PUT.
  }

  try {
    const res = await fetchWithTimeout(`${base}/upload`, {
      method: 'PUT',
      headers: {
        'Authorization':    authHeader,
        'Content-Type':     blob.mime || 'application/octet-stream',
        'X-Content-Sha256': blob.sha256,
      },
      // Node's Buffer is a valid request body at runtime, but undici's
      // BodyInit types reject it under our (DOM-less) lib config. Cast at
      // the boundary rather than copying bytes.
      body: blob.bytes as unknown as BodyInit,
    }, timeoutMs);

    if (res.status >= 200 && res.status < 300) {
      return { server: base, ok: true, skipped: false, status: res.status };
    }
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch {}
    return {
      server: base, ok: false, skipped: false, status: res.status,
      error: detail || `HTTP ${res.status}`,
    };
  } catch (e: any) {
    return {
      server: base, ok: false, skipped: false,
      error: e?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (e?.message || String(e)),
    };
  }
}

/** Upload one blob to every server (in parallel across servers). */
async function uploadBlobToServers(
  blob: BlobToUpload,
  servers: string[],
  authHeader: string,
  timeoutMs: number,
): Promise<BlobUploadResult> {
  const outcomes = await Promise.all(
    servers.map(s => uploadOne(s, blob, authHeader, timeoutMs)),
  );
  return {
    sha256:  blob.sha256,
    path:    blob.path,
    servers: outcomes,
    ok:      outcomes.some(o => o.ok),
  };
}

/**
 * Orchestrate a full batch upload. Blobs are processed with bounded
 * concurrency; within each blob, all servers run in parallel. The signed
 * 24242 event is reused as the auth header for every request. Returns one
 * result per blob, preserving input order.
 */
export async function uploadBlobs(opts: UploadBlobsOptions): Promise<BlobUploadResult[]> {
  const servers = opts.servers.map(normalizeServer).filter(Boolean);
  if (servers.length === 0) throw new Error('uploadBlobs: no Blossom servers configured');

  const authHeader  = encodeAuthHeader(opts.authEvent);
  const timeoutMs   = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const total       = opts.blobs.length;

  const results: BlobUploadResult[] = new Array(total);
  let next = 0;
  let done = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= total) return;
      const r = await uploadBlobToServers(opts.blobs[i], servers, authHeader, timeoutMs);
      results[i] = r;
      done++;
      try { opts.onProgress?.({ index: done, total, result: r }); } catch {}
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
  await Promise.all(workers);
  return results;
}
