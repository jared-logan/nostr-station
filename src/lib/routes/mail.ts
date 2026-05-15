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
import { KIND_EMAIL, KIND_INBOX_RELAYS } from '../mail/types.js';
import {
  buildMessage, mintMessageId,
  shouldInlineByteCount, INLINE_THRESHOLD_BYTES,
  type AttachmentSpec,
} from '../mail/rfc2822.js';
import { readIdentity, npubToHex, isValidRelayUrl } from '../identity.js';
import { signEventWithSavedBunker } from '../auth-bunker.js';
import { encryptBlob, decryptBlob } from '../mail/file-crypto.js';
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

// Attachment input shape accepted by POST /api/mail/send. Two flavours:
//
//   inline  — small files (≤32 KiB). The compose form encoded the bytes
//             as base64 client-side; we drop them straight into a MIME
//             multipart section. No Blossom round-trip.
//
//   blossom — large files. The compose form uploaded via
//             /api/mail/attachment first, which encrypted the bytes
//             with AES-256-GCM and pushed the CIPHERTEXT to Blossom.
//             Metadata (url + sha256 + key + nonce) travels in the
//             X-Nostr-Blossom-* MIME headers; the part body is empty.
//
// Mixed sets in one send are fine.
type AttachmentInput =
  | { kind: 'inline';  name: string; mime: string; size: number; base64: string }
  | { kind: 'blossom'; name: string; mime: string; size: number;
      url: string; sha256: string; encryptionKey: string; encryptionNonce: string };

function isValidAttachment(a: any): a is AttachmentInput {
  if (!a || typeof a.name !== 'string' || typeof a.mime !== 'string'
        || typeof a.size !== 'number' || a.size <= 0) return false;
  if (a.kind === 'inline') {
    return typeof a.base64 === 'string' && a.base64.length > 0;
  }
  if (a.kind === 'blossom') {
    return typeof a.url    === 'string' && /^https?:\/\//.test(a.url)
        && typeof a.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(a.sha256)
        && typeof a.encryptionKey   === 'string' && /^[0-9a-f]{64}$/i.test(a.encryptionKey)
        && typeof a.encryptionNonce === 'string' && /^[0-9a-f]{24}$/i.test(a.encryptionNonce);
  }
  return false;
}

function toRfc2822AttachmentSpec(a: AttachmentInput): AttachmentSpec {
  if (a.kind === 'inline') {
    return {
      name: a.name, mime: a.mime, size: a.size,
      inline: { base64: a.base64 },
    };
  }
  return {
    name: a.name, mime: a.mime, size: a.size,
    blossom: {
      url:      a.url,
      sha256:   a.sha256,
      keyHex:   a.encryptionKey,
      nonceHex: a.encryptionNonce,
    },
  };
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
  // Defaults to bucket=inbox so the existing UI keeps working. Passing
  // ?bucket=quarantine returns the Requests bucket; passing ?bucket=all
  // returns every thread regardless of bucket (used by callers that
  // pre-date PR 7's spam protection).
  if (pathname === '/api/mail/inbox' && method === 'GET') {
    const store     = getMailStore();
    const bucketIn  = (parsed.searchParams.get('bucket') || 'inbox').toLowerCase();
    const threads   = bucketIn === 'all'
      ? store.threadSummaries()
      : store.threadSummaries(bucketIn === 'quarantine' ? 'quarantine' : 'inbox');
    return json(res, 200, { threads, bucket: bucketIn });
  }

  // ── GET /api/mail/requests ─────────────────────────────────────────────
  // Convenience alias for the Requests tab. Equivalent to
  // /api/mail/inbox?bucket=quarantine.
  if (pathname === '/api/mail/requests' && method === 'GET') {
    return json(res, 200, {
      threads: getMailStore().threadSummaries('quarantine'),
      bucket:  'quarantine',
    });
  }

  // ── GET /api/mail/lists ────────────────────────────────────────────────
  // Read the current allowlist + blocklist. Drives the Blocked tab's
  // UI and lets the user audit which senders they've explicitly accepted.
  if (pathname === '/api/mail/lists' && method === 'GET') {
    const store = getMailStore();
    return json(res, 200, {
      allowlist: store.allowlist(),
      blocklist: store.blocklist(),
    });
  }

  // ── POST /api/mail/accept ──────────────────────────────────────────────
  // Move a counterparty's quarantined thread to the inbox + add them to
  // the allowlist so future mail lands directly in inbox.
  if (pathname === '/api/mail/accept' && method === 'POST') {
    let body: any;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'bad json' }); }
    const pubkey = typeof body?.pubkey === 'string' ? body.pubkey.toLowerCase() : '';
    if (!isHex64(pubkey)) return json(res, 400, { error: 'pubkey must be 64-char hex' });
    const r = getMailStore().acceptCounterparty(pubkey);
    return json(res, 200, { ok: true, ...r });
  }

  // ── POST /api/mail/block ───────────────────────────────────────────────
  // Block a counterparty: blocklist + delete every message we already
  // have from them. The inbox worker drops future wraps before they
  // ever land in the store.
  if (pathname === '/api/mail/block' && method === 'POST') {
    let body: any;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'bad json' }); }
    const pubkey = typeof body?.pubkey === 'string' ? body.pubkey.toLowerCase() : '';
    if (!isHex64(pubkey)) return json(res, 400, { error: 'pubkey must be 64-char hex' });
    const r = getMailStore().blockCounterparty(pubkey);
    return json(res, 200, { ok: true, ...r });
  }

  // ── POST /api/mail/unblock ─────────────────────────────────────────────
  // Remove from blocklist. Doesn't restore deleted history — once blocked,
  // history is gone — but future mail from this pubkey will go through
  // the normal bucket-decision path.
  if (pathname === '/api/mail/unblock' && method === 'POST') {
    let body: any;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'bad json' }); }
    const pubkey = typeof body?.pubkey === 'string' ? body.pubkey.toLowerCase() : '';
    if (!isHex64(pubkey)) return json(res, 400, { error: 'pubkey must be 64-char hex' });
    getMailStore().unblockCounterparty(pubkey);
    return json(res, 200, { ok: true });
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

  // ── GET /api/mail/stream ───────────────────────────────────────────────
  // Server-sent events stream so the Mail panel can update the inbox in
  // real time instead of polling /api/mail/inbox every 6 seconds.
  //
  // Frame shapes:
  //   data: { type: "hello",          stats }      — sent on connect
  //   data: { type: "mail-received",  rumorId }    — InboxWorker decoded a new rumor
  //   data: { type: "relay-retry",    url, delay } — inbox-relay reconnect heads-up
  //
  // EventSource cannot set Authorization, so callers append ?token=… and
  // the loopback-only guard in web-server.ts checks origin/referer.
  if (pathname === '/api/mail/stream' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache, no-transform',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const worker = getInboxWorker();
    const emit = (payload: object) => {
      if (res.writableEnded) return;
      try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* socket gone */ }
    };

    emit({ type: 'hello', stats: worker.stats });

    const onMailReceived = (info: { rumorId: string }) => {
      emit({ type: 'mail-received', rumorId: info?.rumorId });
    };
    const onRelayRetry = (info: { url: string; delay: number; reason: string }) => {
      emit({ type: 'relay-retry', url: info?.url, delay: info?.delay, reason: info?.reason });
    };
    const onRelayClosed = (info: { url: string; reason: string }) => {
      emit({ type: 'relay-closed', url: info?.url, reason: info?.reason });
    };
    worker.on('mail-received', onMailReceived);
    worker.on('relay-retry',   onRelayRetry);
    worker.on('relay-closed',  onRelayClosed);

    // 15s heartbeat keeps proxies / browsers from idling the connection
    // out when no mail has arrived.
    const heartbeat = setInterval(() => {
      if (res.writableEnded) return;
      try { res.write(': heartbeat\n\n'); } catch {}
    }, 15_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      worker.off('mail-received', onMailReceived);
      worker.off('relay-retry',   onRelayRetry);
      worker.off('relay-closed',  onRelayClosed);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    return true;
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
  // Upload a LARGE file (>32 KiB) to the in-process Blossom server and
  // return the URL + AES-256-GCM key/nonce the compose UI embeds in the
  // outgoing RFC 2822 multipart MIME headers. Bypasses Blossom's
  // NIP-98 auth path because we're already inside the authenticated
  // dashboard session.
  //
  // Files ≤32 KiB never hit this endpoint — the compose form
  // base64-encodes them client-side and inlines them in the multipart
  // body. The whole RFC 2822 message then gift-wraps end-to-end via
  // NIP-44, so small attachments are E2E by construction.
  //
  // Large files: the body is AES-256-GCM encrypted server-side and the
  // CIPHERTEXT is uploaded to Blossom. The key + nonce return to the
  // client which puts them in the X-Nostr-Encryption-* MIME headers
  // of the corresponding multipart section. /api/mail/download reverses
  // the operation on receive.
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

    // ── PR 8: end-to-end encrypt the blob bytes ───────────────────────
    //
    // Generate a fresh AES-256-GCM key + nonce per attachment, encrypt
    // the body, upload the CIPHERTEXT to Blossom. The blob is now
    // unrecoverable without the key — and the key only travels inside
    // the gift-wrapped rumor, so only the recipient can decrypt.
    // Blossom stores the encrypted blob with mime=application/octet-stream
    // (since the bytes aren't really an image/png/whatever anymore);
    // the *original* mime travels in the rumor as the `m` tag and the
    // download proxy uses it to set the response Content-Type.
    const { ciphertext, keyHex, nonceHex } = encryptBlob(body);

    const r = server.blobStore.put(
      ciphertext,
      'application/octet-stream',
      ownerHex,
      'owner',
    );
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
      sha256: r.record.sha256,   // sha256 of the CIPHERTEXT — what the rumor's `x` tag should carry
      // size + mime reflect the ORIGINAL plaintext (the value the UI shows
      // and the value the recipient sees after decryption). The encrypted
      // blob is 16 bytes larger and has mime octet-stream, but those
      // numbers only matter to the proxy-download path.
      size:   body.length,
      mime,
      name,
      // Embedded in the rumor as encryption-key / encryption-nonce tags.
      encryptionKey:   keyHex,
      encryptionNonce: nonceHex,
    });
  }

  // ── GET /api/mail/download?id=<rumor-id>&sha=<attachment-sha256> ──────
  //
  // Proxy-decrypt download for Blossom-hosted attachments. Looks up the
  // rumor in mail.db, finds the matching attachment by sha256 within
  // its parsed attachments[] list, fetches the ciphertext, decrypts
  // with the embedded key/nonce, and streams the plaintext back.
  //
  // The sha256 disambiguates when one message carries multiple
  // attachments. It also acts as a coarse access control — the proxy
  // refuses to download any sha256 that isn't actually attached to one
  // of the user's messages, so the endpoint can't be used to probe
  // arbitrary Blossom content.
  if (pathname === '/api/mail/download' && method === 'GET') {
    const rumorId = parsed.searchParams.get('id')  || '';
    const wantSha = (parsed.searchParams.get('sha') || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/i.test(rumorId)) {
      return json(res, 400, { error: 'id must be 64-char hex rumor id' });
    }
    if (!/^[0-9a-f]{64}$/.test(wantSha)) {
      return json(res, 400, { error: 'sha must be 64-char hex attachment sha256' });
    }
    const row = getMailStore().messageById(rumorId);
    if (!row) return json(res, 404, { error: 'no message with that id' });
    const att = row.attachments.find(a => a.blossom?.sha256?.toLowerCase() === wantSha);
    if (!att || !att.blossom) {
      return json(res, 404, { error: 'no attachment with that sha on this message' });
    }

    let ciphertext: Buffer;
    try {
      const r = await fetch(att.blossom.url, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) return json(res, 502, { error: `upstream returned ${r.status}` });
      const ab = await r.arrayBuffer();
      ciphertext = Buffer.from(ab);
    } catch (e: any) {
      return json(res, 502, { error: `fetch failed: ${e?.message || e}` });
    }
    let plaintext: Buffer;
    try { plaintext = decryptBlob(ciphertext, att.blossom.keyHex, att.blossom.nonceHex); }
    catch (e: any) { return json(res, 500, { error: `decrypt failed: ${e?.message || e}` }); }

    res.writeHead(200, {
      'Content-Type':        att.mime || 'application/octet-stream',
      'Content-Length':      String(plaintext.length),
      'Content-Disposition': `attachment; filename="${(att.name || 'attachment').replace(/"/g, '')}"`,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(plaintext);
    return true;
  }

  // ── POST /api/mail/send ────────────────────────────────────────────────
  // nostr-mail send pipeline (PR 9 — kind 1301 + RFC 2822):
  //   1. Resolve the recipient (npub | hex | NIP-05).
  //   2. Build the RFC 2822 message — headers + plaintext body, OR
  //      multipart/mixed with one part per attachment (inline base64
  //      for ≤32 KiB; Blossom URL + AES-GCM metadata in
  //      X-Nostr-Blossom-* MIME headers for larger).
  //   3. Wrap the whole thing in a single kind-1301 rumor + NIP-59
  //      gift wrap for the recipient, plus a self-wrap so the sender's
  //      own inbox view sees the sent message across devices.
  //   4. Publish the recipient wrap to the recipient's kind 10050
  //      inbox relays (fall back to our own inbox-relays when they've
  //      advertised none). Publish the self-wrap to our own inbox.
  //   5. Persist the rumor in mail.db immediately so the sender's UI
  //      updates without waiting for the self-wrap to round-trip back.
  if (pathname === '/api/mail/send' && method === 'POST') {
    let body: any;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'bad json' }); }

    const toInput  = typeof body?.to      === 'string' ? body.to      : '';
    const subject  = typeof body?.subject === 'string' ? body.subject : '';
    const content  = typeof body?.body    === 'string' ? body.body    : '';
    const inReplyTo  = typeof body?.inReplyTo  === 'string' ? body.inReplyTo  : '';
    const references = Array.isArray(body?.references)
      ? body.references.filter((s: any): s is string => typeof s === 'string' && s.length > 0)
      : [];
    const attachments: AttachmentInput[] = Array.isArray(body?.attachments)
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

    // Build the RFC 2822 payload. Sender pubkey comes from Amber so the
    // From: header matches the rumor's signer (which the receiver will
    // verify via the seal anyway — the header is display-only).
    const signer = new AmberSigner();
    let senderPubkey: string;
    try { senderPubkey = await signer.getPublicKey(); }
    catch (e: any) { return json(res, 500, { error: `signer pubkey unavailable: ${e?.message || e}` }); }

    const rfc2822 = buildMessage({
      fromPubkey: senderPubkey,
      toPubkey:   resolved.pubkey,
      subject:    subject.trim(),
      body:       content,
      messageId:  mintMessageId(),
      inReplyTo:  inReplyTo || undefined,
      references: references.length > 0 ? references : undefined,
      attachments: attachments.map(toRfc2822AttachmentSpec),
    });

    let pair;
    try {
      pair = await buildGiftWrapPair(
        { kind: KIND_EMAIL, content: rfc2822, tags: [['p', resolved.pubkey]] },
        resolved.pubkey,
        signer,
      );
    } catch (e: any) {
      return json(res, 500, { error: `sign/wrap failed: ${e?.message || e}` });
    }

    // Publish.
    const ownInbox = readInboxRelays();
    const recipientTargets = resolved.inboxRelays.length > 0
      ? resolved.inboxRelays
      : ownInbox;
    const [recipientResults, selfResults] = await Promise.all([
      publishEventToRelays(pair.recipientWrap, recipientTargets),
      publishEventToRelays(pair.selfWrap,      ownInbox),
    ]);

    // Persist the sender's view immediately.
    try {
      const ident = readIdentity();
      if (ident.npub) {
        const ownHex = npubToHex(ident.npub).toLowerCase();
        const store  = getMailStore();
        // Replying implies trust — promote the recipient out of
        // quarantine if they were there. acceptCounterparty is
        // idempotent so the call is safe even for already-trusted
        // recipients.
        if (resolved.pubkey !== ownHex && !store.isBlocklisted(resolved.pubkey)) {
          store.acceptCounterparty(resolved.pubkey);
        }
        store.insertMessage(pair.rumor, pair.selfWrap.id, ownHex);
      }
    } catch { /* non-fatal; the worker will catch up */ }

    return json(res, 200, {
      ok:           true,
      rumorId:      pair.rumor.id,
      recipient:    { results: recipientResults, targets: recipientTargets },
      self:         { results: selfResults,      targets: ownInbox },
      attachments:  attachments.length,
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
