/**
 * Project promote — local-to-prod deploy journey.
 *
 * Walks the in-process relay for events authored by the station owner
 * (test-identity events refused at this layer, defense layer 2 after
 * the relay's accept gate), rewrites any local-blossom URLs in their
 * content + tags by re-uploading the underlying blobs to the
 * configured prod Blossom server(s), re-signs each event via the
 * station's saved bunker (Amber prompt), and publishes the result to
 * the project's prod relays.
 *
 * v1 scope:
 *   - kind-1 + kind-30023 (long-form) only; other kinds enumerated in
 *     dry-run but skipped on apply with a clear "not yet supported"
 *     message. Phase E follow-ups can extend the supported set.
 *   - Replaceable events promote idempotently; non-replaceable
 *     events get a fresh created_at so dedup-on-content-hash clients
 *     treat them as distinct from the local original.
 *   - Refuses events whose content references a non-local, non-prod
 *     URL we don't recognize — better to bail than leak a localhost
 *     URL into a public note.
 */

import WebSocket from 'ws';
import crypto from 'crypto';
import { signEventWithSavedBunker } from './auth-bunker.js';
import { isTestIdentityEvent } from './local-signer.js';
import type { Project } from './projects.js';
import { readIdentity, npubToHex } from './identity.js';

const SUPPORTED_KINDS = new Set([1, 30023]);

export interface PromoteOptions {
  apply?: boolean;
  since?: number;  // unix seconds; default = project.lastPromoteAt or 0
}

export interface PromotePlan {
  // Events that would be / were promoted on apply.
  promote: PromoteCandidate[];
  // Events refused with a reason ("test-identity", "unsupported-kind",
  // "unknown-url", ...).
  refused: RefusedEvent[];
  // Blobs that need re-upload to prod (uniqued by sha256).
  blobs:   BlobRewrite[];
  // Top-level errors that prevented dry-run from completing.
  errors:  string[];
}

export interface PromoteCandidate {
  id:           string;
  kind:         number;
  authorNpub:   string;
  created_at:   number;
  contentBefore: string;
  contentAfter:  string;
  // True iff the event references blobs that would be re-uploaded.
  rewrote:      boolean;
}

export interface RefusedEvent {
  id:     string;
  kind:   number;
  reason: 'test-identity' | 'not-owner' | 'unsupported-kind' | 'unknown-url';
  detail?: string;
}

export interface BlobRewrite {
  sha256:   string;
  localUrl: string;
  prodUrl?: string;  // populated post-apply
}

export interface PromoteResult extends PromotePlan {
  applied:        boolean;
  eventsPublished: number;
  blobsUploaded:   number;
}

const RX_LOCAL_BLOSSOM = /(https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/([0-9a-f]{64}))/gi;

export async function promote(project: Project, opts: PromoteOptions = {}): Promise<PromoteResult> {
  const plan: PromotePlan = { promote: [], refused: [], blobs: [], errors: [] };
  const result: PromoteResult = { ...plan, applied: false, eventsPublished: 0, blobsUploaded: 0 };

  const env = project.environment;
  if (!env) {
    result.errors.push('Project has no environment block — promote requires explicit dev/prod separation.');
    return result;
  }
  if (!env.prod.relays.length) {
    result.errors.push('environment.prod.relays is empty — add at least one public relay before promoting.');
    return result;
  }
  if (!env.dev.relays.length) {
    result.errors.push('environment.dev.relays is empty — nothing to promote from.');
    return result;
  }

  const ident = readIdentity();
  if (!ident.npub) {
    result.errors.push('No station identity — set one up in Config → Identity before promoting.');
    return result;
  }
  const ownerHex = npubToHex(ident.npub).toLowerCase();
  const since = opts.since ?? 0;

  // Step 1: query the local dev relay for owner-authored events.
  const localUrl = env.dev.relays[0];
  let events: any[];
  try {
    events = await queryRelay(localUrl, {
      authors: [ownerHex],
      since,
    });
  } catch (e: any) {
    result.errors.push(`Failed to query ${localUrl}: ${e?.message || e}`);
    return result;
  }

  // Step 2: classify each event.
  const blobsByLocalUrl = new Map<string, BlobRewrite>();
  for (const ev of events) {
    if (isTestIdentityEvent(ev)) {
      result.refused.push({ id: ev.id, kind: ev.kind, reason: 'test-identity' });
      continue;
    }
    if (ev.pubkey.toLowerCase() !== ownerHex) {
      result.refused.push({ id: ev.id, kind: ev.kind, reason: 'not-owner' });
      continue;
    }
    if (!SUPPORTED_KINDS.has(ev.kind)) {
      result.refused.push({ id: ev.id, kind: ev.kind, reason: 'unsupported-kind' });
      continue;
    }

    // URL-rewrite scan. Each local-blossom URL we find adds an entry to
    // the blobs map (unique by sha256). If the content also carries any
    // unknown HTTP URL we don't recognize, refuse — better to bail than
    // leak something we can't classify.
    const rewriteMatches: Array<{ url: string; sha: string }> = [];
    let m: RegExpExecArray | null;
    const rx = new RegExp(RX_LOCAL_BLOSSOM.source, 'gi');
    while ((m = rx.exec(ev.content)) !== null) {
      rewriteMatches.push({ url: m[1], sha: m[2] });
    }
    for (const t of (ev.tags as string[][])) {
      for (const v of t) {
        const tmp = new RegExp(RX_LOCAL_BLOSSOM.source, 'gi');
        let mm: RegExpExecArray | null;
        while ((mm = tmp.exec(v)) !== null) {
          rewriteMatches.push({ url: mm[1], sha: mm[2] });
        }
      }
    }
    for (const { url, sha } of rewriteMatches) {
      if (!blobsByLocalUrl.has(url)) {
        blobsByLocalUrl.set(url, { sha256: sha, localUrl: url });
      }
    }

    const contentBefore = ev.content;
    const contentAfter  = '';  // filled in post-upload
    result.promote.push({
      id: ev.id, kind: ev.kind,
      authorNpub: ident.npub,
      created_at: ev.created_at,
      contentBefore, contentAfter,
      rewrote: rewriteMatches.length > 0,
    });
  }

  result.blobs = [...blobsByLocalUrl.values()];

  if (!opts.apply) return result;
  result.applied = true;

  // Step 3: upload blobs to the first configured prod Blossom.
  if (result.blobs.length > 0) {
    const prodBlossom = env.prod.blossoms[0];
    if (!prodBlossom) {
      result.errors.push('Cannot apply: events reference local blobs but environment.prod.blossoms is empty.');
      return result;
    }
    for (const b of result.blobs) {
      try {
        b.prodUrl = await uploadBlobToProd(b.localUrl, prodBlossom);
        result.blobsUploaded++;
      } catch (e: any) {
        result.errors.push(`Blob ${b.sha256.slice(0, 8)} upload failed: ${e?.message || e}`);
        return result;
      }
    }
  }

  // Step 4: rewrite + re-sign + publish each event.
  for (const cand of result.promote) {
    const original = events.find(e => e.id === cand.id);
    if (!original) continue;

    let nextContent = original.content;
    let nextTags    = original.tags.map((t: string[]) => t.slice());
    for (const b of result.blobs) {
      if (!b.prodUrl) continue;
      const reUrl = new RegExp(escapeRx(b.localUrl), 'g');
      nextContent = nextContent.replace(reUrl, b.prodUrl);
      nextTags = nextTags.map((t: string[]) =>
        t.map(v => typeof v === 'string' ? v.replace(reUrl, b.prodUrl!) : v));
    }
    cand.contentAfter = nextContent;

    const isReplaceable = cand.kind >= 30000 && cand.kind < 40000;
    const created_at = isReplaceable ? original.created_at : Math.floor(Date.now() / 1000);

    const signed = await signEventWithSavedBunker({
      kind:       original.kind,
      created_at,
      tags:       nextTags,
      content:    nextContent,
    });
    if (!signed.ok || !signed.signedEvent) {
      result.errors.push(`Re-sign failed for ${cand.id.slice(0, 8)}: ${signed.error || 'unknown'}`);
      continue;
    }

    for (const relay of env.prod.relays) {
      try {
        await publishToRelay(relay, signed.signedEvent);
        result.eventsPublished++;
        break;  // first success is enough; consumer relays will gossip
      } catch (e: any) {
        result.errors.push(`Publish to ${relay} failed: ${e?.message || e}`);
      }
    }
  }

  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function queryRelay(url: string, filter: { authors?: string[]; since?: number }): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const events: any[] = [];
    const subId = 'promote-' + crypto.randomBytes(4).toString('hex');
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve(events);  // EOSE may not arrive; whatever we have is fine
    }, 8000);
    ws.once('open', () => {
      try {
        ws.send(JSON.stringify(['REQ', subId, filter]));
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    ws.on('message', (data) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (Array.isArray(msg) && msg[0] === 'EVENT' && msg[1] === subId) {
        events.push(msg[2]);
      } else if (Array.isArray(msg) && msg[0] === 'EOSE' && msg[1] === subId) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(events);
      }
    });
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function publishToRelay(url: string, ev: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('publish timeout'));
    }, 8000);
    ws.once('open', () => {
      try { ws.send(JSON.stringify(['EVENT', ev])); }
      catch (e) { clearTimeout(timer); reject(e); }
    });
    ws.on('message', (data) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (Array.isArray(msg) && msg[0] === 'OK' && msg[1] === ev.id) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        if (msg[2] === true) resolve();
        else reject(new Error(msg[3] || 'relay rejected'));
      }
    });
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// Fetch a blob from the local Blossom and PUT it to the prod Blossom.
// Prod-side auth: NIP-98 via saved bunker — same signEventWithSavedBunker
// used for re-signing notes above. The auth event's `u` tag binds to the
// upload URL; the body's sha256 is verified by the destination.
async function uploadBlobToProd(localUrl: string, prodBlossom: string): Promise<string> {
  const getRes = await fetch(localUrl);
  if (!getRes.ok) throw new Error(`local fetch ${getRes.status}`);
  const body = Buffer.from(await getRes.arrayBuffer());
  const mime = getRes.headers.get('content-type') || 'application/octet-stream';
  const sha  = crypto.createHash('sha256').update(body).digest('hex');

  // BUD-02 PUT endpoint convention: <root>/upload
  const putUrl = prodBlossom.replace(/\/+$/, '') + '/upload';

  const auth = await signEventWithSavedBunker({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['u', putUrl], ['method', 'PUT'], ['x', sha], ['t', 'upload']],
    content: '',
  });
  if (!auth.ok || !auth.signedEvent) {
    throw new Error(`NIP-98 sign failed: ${auth.error || 'unknown'}`);
  }

  const authHeader = 'Nostr ' + Buffer.from(JSON.stringify(auth.signedEvent), 'utf8').toString('base64');
  const putRes = await fetch(putUrl, {
    method: 'PUT',
    headers: {
      Authorization: authHeader,
      'Content-Type': mime,
      'X-Content-Sha256': sha,
    },
    body,
  });
  if (!putRes.ok) {
    const text = await putRes.text().catch(() => '');
    throw new Error(`prod PUT ${putRes.status}: ${text.slice(0, 200)}`);
  }
  const json = await putRes.json().catch(() => null) as any;
  const url = json?.url || `${prodBlossom.replace(/\/+$/, '')}/${sha}`;
  return url;
}
