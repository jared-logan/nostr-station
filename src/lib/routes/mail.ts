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
import { readInboxRelays } from '../mail/inbox-relays.js';
import { publishEventToRelays } from './repo.js';
import { KIND_DM_RUMOR } from '../mail/types.js';
import { readIdentity, npubToHex } from '../identity.js';

function json(res: http.ServerResponse, status: number, body: any): true {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

function isHex64(s: any): s is string {
  return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);
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
    if (!content.trim()) return json(res, 400, { error: 'body is required' });

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

    // Publish.
    const ownInbox = readInboxRelays();
    // Fall back to the user's own inbox list if recipient has no kind 10050.
    const recipientTargets = resolved.inboxRelays.length > 0
      ? resolved.inboxRelays
      : ownInbox;
    const [recipientResults, selfResults] = await Promise.all([
      publishEventToRelays(pair.recipientWrap, recipientTargets),
      publishEventToRelays(pair.selfWrap,      ownInbox),
    ]);

    // Persist the sender's view immediately. ownPubkey is read from
    // identity.json; if it's missing, the rumor still goes onto the
    // wire but won't show in the local inbox until the worker picks
    // up the self-wrap on next connect.
    try {
      const ident = readIdentity();
      if (ident.npub) {
        const ownHex = npubToHex(ident.npub).toLowerCase();
        getMailStore().insertMessage(pair.rumor, pair.selfWrap.id, ownHex);
      }
    } catch { /* non-fatal; the worker will catch up */ }

    return json(res, 200, {
      ok:          true,
      rumorId:     pair.rumor.id,
      recipient:   { results: recipientResults, targets: recipientTargets },
      self:        { results: selfResults,      targets: ownInbox },
      usedFallback: resolved.inboxRelays.length === 0,
    });
  }

  return false;
}
