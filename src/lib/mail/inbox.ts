/**
 * Background inbox worker.
 *
 * One worker per nostr-station process. On start:
 *   1. Reads the station owner's pubkey + the configured inbox relay list.
 *   2. Opens a long-lived WebSocket to each relay.
 *   3. Sends ["REQ", id, {"kinds":[1059], "#p":[ownerPubkey]}] on each.
 *   4. For every kind-1059 event received: dedupe against `seen_wraps`,
 *      unwrap via AmberSigner, persist the rumor to the mail store.
 *
 * Reconnect: 5-second exponential backoff up to 5 minutes per relay,
 * independent so one flaky relay can't stall the others.
 *
 * NIP-42 AUTH: some inbox relays gate kind 1059 behind NIP-42. The MVP
 * worker doesn't AUTH; it'll simply not receive events from those
 * relays. Future patch will add an AUTH responder that signs the AUTH
 * challenge via Amber on demand.
 */

import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';

import { readIdentity, npubToHex } from '../identity.js';
import { AmberSigner } from './signer.js';
import { unwrapGift } from './wrap.js';
import { getMailStore } from './store.js';
import { readInboxRelays } from './inbox-relays.js';
import { isContact } from './contacts.js';
import {
  KIND_GIFT_WRAP, KIND_EMAIL, KIND_LABEL, KIND_APP_DATA,
  APP_DATA_D_SETTINGS,
  type NostrEvent,
} from './types.js';
import { parseLabel } from './labels.js';
import { applyIncomingSettingsEvent } from './settings-sync.js';

interface RelayState {
  url:        string;
  ws:         WebSocket | null;
  // Multiple subscriptions per socket: gift wraps, kind 1985 labels
  // authored by us, kind 30078 settings authored by us. Each REQ has
  // its own client-side id; the relay dispatches inbound events back
  // through the matching id so we can fan-out by sub.
  subWrap:    string;
  subLabels:  string;
  subSettings:string;
  retryAt:    number;
  retryDelay: number;
  isOpen:     boolean;
  events:     number;
}

const SUB_PREFIX_WRAP     = 'mail-inbox-';
const SUB_PREFIX_LABELS   = 'mail-labels-';
const SUB_PREFIX_SETTINGS = 'mail-settings-';
const BACKOFF_MIN = 5_000;
const BACKOFF_MAX = 5 * 60_000;

export class InboxWorker extends EventEmitter {
  private started = false;
  private stopping = false;
  private ownerPubkey: string | null = null;
  private signer: AmberSigner | null = null;
  private relays = new Map<string, RelayState>();
  // Pending decrypt queue. Per-wrap decrypts go through Amber which is
  // serial and rate-limited from the user's perspective; queueing keeps
  // a single Amber connection cycle per wrap rather than racing many.
  private decryptQueue: NostrEvent[] = [];
  private decrypting = false;
  // Public stats. /api/mail/inbox-status reads from here.
  public stats = {
    relaysConnected: 0,
    eventsSeen:      0,
    decryptedOk:     0,
    decryptFailed:   0,
    lastError:       '' as string,
    lastEventAt:     0,
  };

  start(): void {
    if (this.started) return;
    this.started  = true;
    this.stopping = false;
    try {
      const ident = readIdentity();
      if (!ident.npub) {
        this.stats.lastError = 'no station npub configured';
        return;
      }
      this.ownerPubkey = npubToHex(ident.npub).toLowerCase();
    } catch (e: any) {
      this.stats.lastError = `bad identity: ${e?.message || e}`;
      return;
    }
    this.signer = new AmberSigner();

    for (const url of readInboxRelays()) {
      this.connectRelay(url);
    }
  }

  stop(): void {
    this.stopping = true;
    this.started  = false;
    for (const r of this.relays.values()) {
      try { r.ws?.close(); } catch {}
      r.ws = null;
      r.isOpen = false;
    }
    this.relays.clear();
    this.decryptQueue.length = 0;
    this.decrypting = false;
    this.stats.relaysConnected = 0;
  }

  /**
   * Replace the current relay set with `next`. Used when the user edits
   * their inbox relays in the UI — we tear down dropped sockets and
   * dial new ones without restarting the whole worker.
   */
  resetRelays(next: string[]): void {
    if (!this.started) return;
    const wanted = new Set(next);

    // Drop relays no longer in the list.
    for (const [url, state] of this.relays) {
      if (!wanted.has(url)) {
        try { state.ws?.close(); } catch {}
        this.relays.delete(url);
      }
    }
    // Open new ones we don't already have.
    for (const url of next) {
      if (!this.relays.has(url)) this.connectRelay(url);
    }
    this.recountConnected();
  }

  private connectRelay(url: string): void {
    if (this.stopping) return;
    const r = () => Math.random().toString(36).slice(2, 10);
    const state: RelayState = {
      url, ws: null,
      subWrap:     SUB_PREFIX_WRAP     + r(),
      subLabels:   SUB_PREFIX_LABELS   + r(),
      subSettings: SUB_PREFIX_SETTINGS + r(),
      retryAt: 0, retryDelay: BACKOFF_MIN, isOpen: false, events: 0,
    };
    this.relays.set(url, state);
    this.dial(state);
  }

  private dial(state: RelayState): void {
    if (this.stopping || !this.ownerPubkey) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(state.url, { handshakeTimeout: 15_000 });
    } catch (e: any) {
      this.scheduleRetry(state, e?.message || 'ws init failed');
      return;
    }
    state.ws = ws;

    ws.on('open', () => {
      state.isOpen = true;
      state.retryDelay = BACKOFF_MIN;
      this.recountConnected();
      // Three subs per relay:
      //   1. gift wraps addressed to us (kind 1059 #p=self).
      //   2. NIP-32 labels we authored (kind 1985 authors=self) —
      //      cross-device folder + read-state sync (PR 10).
      //   3. NIP-78 app data we authored (kind 30078 authors=self
      //      #d=nostr-mail:settings) — settings sync (PR 10).
      // since=0 on each = all-time backfill. Fine for low volumes.
      const me = this.ownerPubkey!;
      try {
        ws.send(JSON.stringify(['REQ', state.subWrap,
          { kinds: [KIND_GIFT_WRAP], '#p': [me] }]));
        ws.send(JSON.stringify(['REQ', state.subLabels,
          { kinds: [KIND_LABEL], authors: [me] }]));
        ws.send(JSON.stringify(['REQ', state.subSettings,
          { kinds: [KIND_APP_DATA], authors: [me], '#d': [APP_DATA_D_SETTINGS] }]));
      } catch {}
    });

    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); }
      catch { return; }
      if (!Array.isArray(msg)) return;

      if (msg[0] === 'EVENT' && msg[2]) {
        const subId = msg[1];
        const ev    = msg[2] as NostrEvent;
        if (subId === state.subWrap && ev.kind === KIND_GIFT_WRAP) {
          state.events++;
          this.stats.eventsSeen++;
          this.stats.lastEventAt = Date.now();
          this.enqueueDecrypt(ev);
        } else if (subId === state.subLabels && ev.kind === KIND_LABEL) {
          this.handleLabel(ev);
        } else if (subId === state.subSettings && ev.kind === KIND_APP_DATA) {
          this.handleSettings(ev);
        }
      }
      // EOSE is informational; we keep the subscription open to tail
      // new events. CLOSED means the relay dropped our REQ — usually
      // a NIP-42 AUTH gate. Log it and don't retry until reconnect.
      if (msg[0] === 'CLOSED' && [state.subWrap, state.subLabels, state.subSettings].includes(msg[1])) {
        this.stats.lastError = `${state.url}: ${msg[2] || 'CLOSED'}`;
        this.emit('relay-closed', { url: state.url, reason: msg[2] });
      }
    });

    ws.on('close', () => {
      state.isOpen = false;
      state.ws = null;
      this.recountConnected();
      this.scheduleRetry(state, 'closed');
    });
    ws.on('error', (e: any) => {
      this.stats.lastError = `${state.url}: ${e?.message || e}`;
    });
  }

  private scheduleRetry(state: RelayState, reason: string): void {
    if (this.stopping || !this.relays.has(state.url)) return;
    const delay = state.retryDelay;
    state.retryDelay = Math.min(delay * 2, BACKOFF_MAX);
    state.retryAt    = Date.now() + delay;
    this.emit('relay-retry', { url: state.url, delay, reason });
    setTimeout(() => {
      if (this.relays.has(state.url) && !this.stopping) this.dial(state);
    }, delay).unref();
  }

  private recountConnected(): void {
    let n = 0;
    for (const r of this.relays.values()) if (r.isOpen) n++;
    this.stats.relaysConnected = n;
  }

  // ── Decrypt pipeline ────────────────────────────────────────────────────

  private enqueueDecrypt(ev: NostrEvent): void {
    const store = getMailStore();
    // Fast path: skip wraps we've already processed (relay re-delivery,
    // overlap between relays, restarts).
    if (store.hasSeenWrap(ev.id)) return;
    this.decryptQueue.push(ev);
    void this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    if (this.decrypting) return;
    this.decrypting = true;
    try {
      while (this.decryptQueue.length > 0 && !this.stopping) {
        const ev = this.decryptQueue.shift()!;
        await this.handleWrap(ev);
      }
    } finally {
      this.decrypting = false;
    }
  }

  // ── Label sync (kind 1985, PR 10) ───────────────────────────────────────

  private handleLabel(ev: NostrEvent): void {
    // The sub filter authors=[me] already constrains this server-side,
    // but a misbehaving relay could send anything; re-verify here.
    if (ev.pubkey.toLowerCase() !== this.ownerPubkey) return;
    const parsed = parseLabel(ev);
    if (!parsed) return;
    const store = getMailStore();
    const applied = store.applyLabel(
      parsed.rumorId, parsed.namespace, parsed.value, parsed.created_at,
    );
    if (applied) {
      // SSE consumers (Mail panel) re-fetch on this event so the
      // folder bucket reflects the cross-device move/read.
      this.emit('mail-received', { rumorId: parsed.rumorId, bucket: 'inbox' });
    }
  }

  // ── Settings sync (kind 30078, PR 10) ───────────────────────────────────

  private handleSettings(ev: NostrEvent): void {
    if (ev.pubkey.toLowerCase() !== this.ownerPubkey) return;
    const changed = applyIncomingSettingsEvent(ev);
    if (changed) {
      // Settings changes may include a new inbox-relay list — pick
      // them up live without a process restart. applySettings already
      // wrote inbox-relays.json, so we just re-read and reset.
      try { this.resetRelays(readInboxRelays()); } catch {}
      this.emit('settings-changed', {});
    }
  }

  private async handleWrap(ev: NostrEvent): Promise<void> {
    if (!this.signer || !this.ownerPubkey) return;
    const store = getMailStore();
    // Re-check seen — the queue can hold dupes if the same wrap shows up
    // on multiple relays before we process it.
    if (store.hasSeenWrap(ev.id)) return;

    try {
      const { rumor } = await unwrapGift(ev, this.signer);
      const sender = rumor.pubkey.toLowerCase();

      // PR 9: nostr-mail is kind-1301-only. Anything else (NIP-17 DMs
      // at kind 14, file messages at kind 15, etc.) is silently
      // discarded. Future panels may consume those — the mail panel
      // doesn't. Mark the wrap seen so we don't keep re-decrypting it
      // on relay re-delivery; the cost is irreversible (we lose the
      // ability to claim "kind 14 dropped" if the consumer panel ever
      // looks back), but the inbox worker has no idea what other
      // panels might care about and decryption is expensive.
      if (rumor.kind !== KIND_EMAIL) {
        store.markSeenWrap(ev.id);
        return;
      }

      // Spam-filter decision (PR 7):
      //   - Blocklisted sender → drop entirely. Mark the wrap seen so
      //     we don't re-decrypt on relay re-delivery, but never put it
      //     in the store.
      //   - Outgoing (we authored it) → inbox; bucket inference inside
      //     insertMessage overrides anything we pass anyway.
      //   - Allowlisted OR in NIP-02 contacts → inbox.
      //   - Anyone else → quarantine. The user can promote/block from
      //     the Requests tab.
      if (store.isBlocklisted(sender)) {
        store.markSeenWrap(ev.id);
        this.stats.decryptedOk++;
        return;
      }
      let bucket: 'inbox' | 'quarantine' = 'inbox';
      if (sender !== this.ownerPubkey) {
        const trusted = store.isAllowlisted(sender) || await isContact(sender);
        bucket = trusted ? 'inbox' : 'quarantine';
      }
      const inserted = store.insertMessage(rumor, ev.id, this.ownerPubkey, bucket);
      store.markSeenWrap(ev.id);
      this.stats.decryptedOk++;
      if (inserted) this.emit('mail-received', { rumorId: rumor.id, bucket: inserted.direction === 'out' ? 'inbox' : bucket });
    } catch (e: any) {
      // Decrypt failures are noisy at the protocol layer — spam wraps,
      // not-for-us misroutes, NIP-44 v1 wraps we can't handle. We
      // still mark the wrap seen so we don't re-attempt every reconnect.
      store.markSeenWrap(ev.id);
      this.stats.decryptFailed++;
      this.stats.lastError = `decrypt: ${(e?.message || e).toString().slice(0, 200)}`;
    }
  }
}

// ── Singleton ───────────────────────────────────────────────────────────

let _worker: InboxWorker | null = null;

export function getInboxWorker(): InboxWorker {
  if (!_worker) _worker = new InboxWorker();
  return _worker;
}
