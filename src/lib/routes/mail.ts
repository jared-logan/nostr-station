/**
 * Mail routes — HTTP surface for the dashboard's Mail panel.
 *
 * Surface (this PR — read-only):
 *   GET  /api/mail/inbox          — thread summaries
 *   GET  /api/mail/thread?counterparty=hex
 *                                 — full message list for one thread
 *   POST /api/mail/mark-read      — body { ids: [string] } — local-only flip
 *   GET  /api/mail/status         — inbox worker stats
 *
 * Send + inbox-relay management + attachments arrive in later PRs.
 */

import http from 'http';
import { readBody } from './_shared.js';
import { getMailStore } from '../mail/store.js';
import { getInboxWorker } from '../mail/inbox.js';
import { resolveRecipient, RecipientError } from '../mail/resolve.js';
import { buildGiftWrapPair } from '../mail/wrap.js';
import { AmberSigner } from '../mail/signer.js';
import {
  readInboxRelays, writeInboxRelays, DEFAULT_INBOX_RELAYS,
} from '../mail/inbox-relays.js';
import { publishEventToRelays } from './repo.js';
import { KIND_DM_RUMOR, KIND_FILE_RUMOR, KIND_INBOX_RELAYS } from '../mail/types.js';
import { readIdentity, npubToHex, isValidRelayUrl } from '../identity.js';
import { signEventWithSavedBunker } from '../auth-bunker.js';
import type { BlossomServer } from '../../blossom/index.js';

// Optional dependency accessor — web-server.ts wires this. When the
// in-process Blossom server is off, attachment uploads return a 409 so
// the UI can prompt the user to enable Blossom.
let _getBlossom: () => BlossomServer | null = () => null;
export function setMailBlossomAccessor(get: () => BlossomServer | null): void {
  _getBlossom = get;
}

function json(res: http.ServerResponse, status: number, body: any): true {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

function isHex64(s: any): s is string {
  return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);
}

interface AttachmentRef {
  url:    string;
  sha256: string;
  mime:   string;
  size:   number;
  name?:  string;
}
function isValidAttachment(a: any): a is AttachmentRef {
  return !!a
    && typeof a.url    === 'string' && /^https?:\/\//.test(a.url)
    && typeof a.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(a.sha256)
    && typeof a.mime   === 'string'
    && typeof a.size   === 'number' && a.size > 0;
}

export async function handleMail(
  req:    http.IncomingMessage,
  res:    http.ServerResponse,
  url:    string,
  method: string,
): Promise<boolean> {
  if (!url.startsWith('/api/mail/')) return false;

  // url is the raw request URL (path + query) — same shape every other
  // route handler sees. Parse with a dummy base so we can pull
  // query parameters cleanly.
  const parsed   = new URL(url, 'http://127.0.0.1');
  const pathname = parsed.pathname;

  // ── GET /api/mail/inbox ────────────────────────────────────────────────
  if (pathname === '/api/mail/inbox' && method === 'GET') {
    const store    = getMailStore();
    const threads  = store.threadSummaries();
    return json(res, 200, { threads });
  }

  // ── GET /api/mail/thread?counterparty=hex ──────────────────────────────
  if (pathname === '/api/mail/thread' && method === 'GET') {
    const counterparty = parsed.searchParams.get('counterparty') || '';
    if (!isHex64(counterparty)) {
      return json(res, 400, { error: 'counterparty must be 64-char hex pubkey' });
    }
    const store    = getMailStore();
    const messages = store.messagesForThread(counterparty.toLowerCase());
    return json(res, 200, { counterparty: counterparty.toLowerCase(), messages });
  }

  // ── POST /api/mail/mark-read ───────────────────────────────────────────
  if (pathname === '/api/mail/mark-read' && method === 'POST') {
    let body: any;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'bad json' }); }
    const ids = Array.isArray(body?.ids)
      ? body.ids.filter((s: any): s is string => typeof s === 'string' && s.length > 0)
      : [];
    if (ids.length === 0) return json(res, 200, { ok: true, updated: 0 });
    getMailStore().markRead(ids);
    return json(res, 200, { ok: true, updated: ids.length });
  }

  // ── GET /api/mail/status ───────────────────────────────────────────────
  // Surface the inbox worker's stats so the Mail panel can show
  // "connected to N inbox relays, M unread" without polling the DB
  // for every keystroke.
  if (pathname === '/api/mail/status' && method === 'GET') {
    const worker = getInboxWorker();
    return json(res, 200, { stats: worker.stats });
  }

  // ── POST /api/mail/resolve ─────────────────────────────────────────────
  // Pre-flight lookup that the compose form calls as the user types a
  // recipient. Returns the resolved pubkey + the recipient's inbox
  // relays so the UI can warn if delivery is unlikely.
  if (pathname === '/api/mail/resolve' && method === 'POST') {
    let body: any;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'bad json' }); }
    const input = typeof body?.to === 'string' ? body.to : '';
    try {
      const r = await resolveRecipient(input);
      return json(res, 200, {
        ok:           true,
        pubkey:       r.pubkey,
        inboxRelays:  r.inboxRelays,
        hasInbox:     r.inboxRelays.length > 0,
        nip05:        r.nip05 ?? null,
      });
    } catch (e: any) {
      if (e instanceof RecipientError) {
        return json(res, 400, { ok: false, error: e.message });
      }
      return json(res, 500, { ok: false, error: e?.message || 'resolve failed' });
    }
  }

  // ── POST /api/mail/attachment ──────────────────────────────────────────
  // Upload a file to the in-process Blossom server and return the public
  // URL + sha256 the compose UI needs to attach it to a send. Bypasses
  // Blossom's NIP-98 auth path because we're already inside the
  // authenticated dashboard session — the dashboard's session token
  // gate has already run by the time control reaches this handler.
  //
  // NOTE on privacy: the blob is stored UNENCRYPTED in Blossom and the
  // URL is publicly retrievable by anyone who knows the sha256. The
  // URL itself is encrypted inside the gift wrap (nobody can extract
  // the URL without the recipient's key), so practical guessability is
  // ~zero — but a sophisticated recipient could leak the URL out-of-band
  // and the blob is then accessible. For users who need attachments that
  // are E2E-secret too, this needs a future patch that encrypts the
  // blob bytes with a per-attachment key embedded in the rumor.
  if (pathname === '/api/mail/attachment' && method === 'POST') {
    const server = _getBlossom();
    if (!server) {
      return json(res, 409, {
        error: 'Blossom is not running — enable it in Config → Blossom before attaching files.',
      });
    }
    const ident = readIdentity();
    if (!ident.npub) {
      return json(res, 412, { error: 'no station npub configured' });
    }
    const ownerHex = npubToHex(ident.npub).toLowerCase();

    const mime = (parsed.searchParams.get('mime') || req.headers['content-type'] || 'application/octet-stream').toString();
    const name = parsed.searchParams.get('name') || '';

    // Slurp the raw body. Bound at 25 MiB for a sane upper limit;
    // attachments larger than that should go through an out-of-band
    // share + a plain-text link instead.
    const MAX_BYTES = 25 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    await new Promise<void>((resolve) => {
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BYTES) {
          aborted = true;
          try { req.destroy(); } catch {}
          resolve();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end',   () => resolve());
      req.on('error', () => resolve());
    });
    if (aborted) return json(res, 413, { error: `attachment exceeds ${Math.round(MAX_BYTES / 1024 / 1024)} MiB` });
    const body = Buffer.concat(chunks, total);
    if (body.length === 0) return json(res, 400, { error: 'empty body' });

    const r = server.blobStore.put(body, mime, ownerHex, 'owner');
    if (!r.ok) {
      return json(res, 500, { error: `blossom put failed: ${r.reason}` });
    }
    // Public URL: prefer the user-facing endpoint if Blossom exposes one,
    // else fall back to the in-process 127.0.0.1 binding (which is fine
    // when the recipient is on the same machine, but useless for remote
    // delivery — the UI should warn when only the loopback URL is
    // available).
    const port = (server as any).port || 8081;
    const url  = `http://127.0.0.1:${port}/${r.record.sha256}`;
    return json(res, 200, {
      ok:     true,
      url,
      sha256: r.record.sha256,
      size:   r.record.size,
      mime:   r.record.mime,
      name,
    });
  }

  // ── POST /api/mail/send ────────────────────────────────────────────────
  // Full NIP-17 send pipeline:
  //   1. Resolve the recipient (npub | hex | NIP-05).
  //   2. Build the rumor (kind 14, with subject tag if present).
  //   3. Seal + wrap for the recipient, AND seal + wrap a self-copy so
  //      the sender's own inbox view shows their sent mail.
  //   4. Publish the recipient wrap to the recipient's inbox relays
  //      (with a fallback to the user's own inbox-relay list when the
  //      recipient hasn't advertised any). Publish the self-wrap to
  //      the user's own inbox relays only.
  //   5. Persist the rumor in mail.db so the sender's UI updates
  //      immediately, without waiting for the inbox worker to round-
  //      trip the self-wrap back from a relay.
  if (pathname === '/api/mail/send' && method === 'POST') {
    let body: any;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'bad json' }); }

    const toInput  = typeof body?.to      === 'string' ? body.to      : '';
    const subject  = typeof body?.subject === 'string' ? body.subject : '';
    const content  = typeof body?.body    === 'string' ? body.body    : '';
    // Each attachment is { url, sha256, mime, size, name? } — produced by
    // /api/mail/attachment. We validate the shape but trust the values
    // since they came back from our own Blossom put call.
    const attachments: AttachmentRef[] = Array.isArray(body?.attachments)
      ? body.attachments.filter(isValidAttachment)
      : [];
    if (!content.trim() && attachments.length === 0) {
      return json(res, 400, { error: 'body or at least one attachment is required' });
    }

    // Resolve recipient. Failures here are user-actionable so we surface
    // them as 400s with the original message.
    let resolved;
    try { resolved = await resolveRecipient(toInput); }
    catch (e: any) {
      if (e instanceof RecipientError) return json(res, 400, { error: e.message });
      return json(res, 500, { error: e?.message || 'resolve failed' });
    }

    // Build the rumor + wrap pair via Amber.
    const tags: string[][] = [['p', resolved.pubkey]];
    if (subject.trim()) tags.push(['subject', subject.trim()]);

    const signer = new AmberSigner();
    let pair;
    try {
      pair = await buildGiftWrapPair(
        { kind: KIND_DM_RUMOR, content, tags },
        resolved.pubkey,
        signer,
      );
    } catch (e: any) {
      return json(res, 500, { error: `sign/wrap failed: ${e?.message || e}` });
    }

    // Build one kind-15 rumor per attachment, wrapped for both sides
    // (recipient + self) so the sender's UI sees them in the thread too.
    // Each wrap is independent — they all surface as separate messages
    // in the thread but are visually grouped by created_at.
    const attachmentWraps: Array<{ rumor: any; recipientWrap: any; selfWrap: any }> = [];
    try {
      for (const a of attachments) {
        const fileRumorTags: string[][] = [
          ['p', resolved.pubkey],
          ['url',  a.url],
          ['m',    a.mime],
          ['x',    a.sha256],
          ['size', String(a.size)],
        ];
        if (a.name) fileRumorTags.push(['file', a.name]);
        const pairA = await buildGiftWrapPair(
          { kind: KIND_FILE_RUMOR, content: a.name || a.url, tags: fileRumorTags },
          resolved.pubkey,
          signer,
        );
        attachmentWraps.push(pairA);
      }
    } catch (e: any) {
      return json(res, 500, { error: `sign/wrap attachment failed: ${e?.message || e}` });
    }

    // Publish.
    const ownInbox = readInboxRelays();
    // Fall back to the user's own inbox list if recipient has no kind 10050.
    const recipientTargets = resolved.inboxRelays.length > 0
      ? resolved.inboxRelays
      : ownInbox;
    const publishTasks: Array<Promise<any>> = [];
    publishTasks.push(publishEventToRelays(pair.recipientWrap, recipientTargets));
    publishTasks.push(publishEventToRelays(pair.selfWrap,      ownInbox));
    for (const a of attachmentWraps) {
      publishTasks.push(publishEventToRelays(a.recipientWrap, recipientTargets));
      publishTasks.push(publishEventToRelays(a.selfWrap,      ownInbox));
    }
    const allResults = await Promise.all(publishTasks);
    const recipientResults = allResults[0];
    const selfResults      = allResults[1];

    // Persist the sender's view immediately. ownPubkey is read from
    // identity.json; if it's missing, the rumor still goes onto the
    // wire but won't show in the local inbox until the worker picks
    // up the self-wrap on next connect.
    try {
      const ident = readIdentity();
      if (ident.npub) {
        const ownHex = npubToHex(ident.npub).toLowerCase();
        const store  = getMailStore();
        store.insertMessage(pair.rumor, pair.selfWrap.id, ownHex);
        for (const a of attachmentWraps) {
          store.insertMessage(a.rumor, a.selfWrap.id, ownHex);
        }
      }
    } catch { /* non-fatal; the worker will catch up */ }

    return json(res, 200, {
      ok:          true,
      rumorId:     pair.rumor.id,
      recipient:   { results: recipientResults, targets: recipientTargets },
      self:        { results: selfResults,      targets: ownInbox },
      attachments: attachmentWraps.length,
      usedFallback: resolved.inboxRelays.length === 0,
    });
  }

  // ── GET /api/mail/inbox-relays ─────────────────────────────────────────
  // Returns the user's currently configured inbox-relay list (mirrors
  // what we'd publish as kind 10050) plus the curated default set the
  // UI can offer as "reset to defaults".
  if (pathname === '/api/mail/inbox-relays' && method === 'GET') {
    return json(res, 200, {
      relays:   readInboxRelays(),
      defaults: DEFAULT_INBOX_RELAYS,
    });
  }

  // ── PUT /api/mail/inbox-relays ─────────────────────────────────────────
  // Replace the inbox-relay list. We persist the new list to disk,
  // restart the inbox worker's subscriptions so it tails the new
  // relays immediately, and (if a bunker is paired) publish a fresh
  // kind 10050 so other NIP-17 clients know where to deliver to us.
  if (pathname === '/api/mail/inbox-relays' && method === 'PUT') {
    let body: any;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'bad json' }); }
    const incoming = Array.isArray(body?.relays) ? body.relays : null;
    if (!incoming) return json(res, 400, { error: 'relays must be an array of wss:// URLs' });

    const cleaned: string[] = [];
    for (const r of incoming) {
      if (typeof r !== 'string') continue;
      const trimmed = r.trim();
      if (!isValidRelayUrl(trimmed)) {
        return json(res, 400, { error: `invalid relay url: ${trimmed.slice(0, 80)}` });
      }
      if (!cleaned.includes(trimmed)) cleaned.push(trimmed);
    }
    if (cleaned.length === 0) {
      return json(res, 400, { error: 'at least one inbox relay is required' });
    }
    const saved = writeInboxRelays(cleaned);

    // Live-update the running worker so new mail arrives without a
    // restart. The worker no-ops when not started, so this is safe to
    // call unconditionally.
    try { getInboxWorker().resetRelays(saved); } catch {}

    // Try to publish the kind 10050. Best-effort — failure here doesn't
    // unsave the list, just leaves it un-broadcast (the user can hit
    // "publish kind 10050" again from the UI).
    let publish: any = { attempted: false };
    if (body.publish !== false) {
      publish = await publishInboxRelayList(saved);
    }

    return json(res, 200, { ok: true, relays: saved, publish });
  }

  // ── POST /api/mail/inbox-relays/publish ────────────────────────────────
  // Explicit "republish kind 10050 now" — useful when the user fixes
  // a paired Amber session after the silent publish at save time
  // failed, or wants to re-broadcast to a new relay they just added
  // outside the UI.
  if (pathname === '/api/mail/inbox-relays/publish' && method === 'POST') {
    const result = await publishInboxRelayList(readInboxRelays());
    return json(res, result.ok ? 200 : 500, result);
  }

  return false;
}

// Sign + broadcast a kind 10050 event listing the user's inbox relays.
// Falls back gracefully if no bunker is paired — the local list is still
// usable for receiving (the inbox worker subscribes regardless of whether
// we ever publish), it just means other NIP-17 clients won't discover
// where to send mail for this pubkey.
async function publishInboxRelayList(
  relays: string[],
): Promise<{ ok: boolean; attempted: boolean; results?: any[]; error?: string }> {
  const ident = readIdentity();
  if (!ident.npub) {
    return { ok: false, attempted: false, error: 'no station npub configured' };
  }
  const template = {
    kind:       KIND_INBOX_RELAYS,
    created_at: Math.floor(Date.now() / 1000),
    tags:       relays.map(r => ['relay', r]),
    content:    '',
  };
  const signed = await signEventWithSavedBunker(template);
  if (!signed.ok || !signed.signedEvent) {
    return {
      ok:        false,
      attempted: true,
      error:     signed.error || 'bunker signature unavailable',
    };
  }
  // Publish to the user's own inbox relays + a small fan-out to common
  // discovery relays so other clients can find this kind 10050 even if
  // they don't already know about the user's chosen inbox set.
  const fanout = new Set<string>(relays);
  for (const r of ['wss://purplepag.es', 'wss://relay.damus.io', 'wss://nos.lol']) fanout.add(r);
  const results = await publishEventToRelays(signed.signedEvent, [...fanout]);
  const okCount = results.filter(r => r.ok).length;
  return {
    ok:        okCount > 0,
    attempted: true,
    results,
  };
}
