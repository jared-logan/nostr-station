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
import { KIND_GIFT_WRAP, type NostrEvent } from './types.js';

interface RelayState {
  url:        string;
  ws:         WebSocket | null;
  subId:      string;
  retryAt:    number;
  retryDelay: number;
  isOpen:     boolean;
  events:     number;
}

const SUB_PREFIX  = 'mail-inbox-';
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
    const subId = SUB_PREFIX + Math.random().toString(36).slice(2, 10);
    const state: RelayState = {
      url, ws: null, subId,
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
      // Subscribe to kind 1059 #p=self. since=0 means "all-time backfill";
      // for users with very large inboxes that's expensive — a future
      // patch can move to a windowed since= once we track high-water
      // marks per relay.
      const req = ['REQ', state.subId, { kinds: [KIND_GIFT_WRAP], '#p': [this.ownerPubkey!] }];
      try { ws.send(JSON.stringify(req)); } catch {}
    });

    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); }
      catch { return; }
      if (!Array.isArray(msg)) return;

      if (msg[0] === 'EVENT' && msg[1] === state.subId && msg[2]) {
        const ev = msg[2] as NostrEvent;
        if (ev.kind !== KIND_GIFT_WRAP) return;
        state.events++;
        this.stats.eventsSeen++;
        this.stats.lastEventAt = Date.now();
        this.enqueueDecrypt(ev);
      }
      // EOSE is informational; we keep the subscription open to tail
      // new events. CLOSED means the relay dropped our REQ — usually
      // a NIP-42 AUTH gate. Log it and don't retry until reconnect.
      if (msg[0] === 'CLOSED' && msg[1] === state.subId) {
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

  private async handleWrap(ev: NostrEvent): Promise<void> {
    if (!this.signer || !this.ownerPubkey) return;
    const store = getMailStore();
    // Re-check seen — the queue can hold dupes if the same wrap shows up
    // on multiple relays before we process it.
    if (store.hasSeenWrap(ev.id)) return;

    try {
      const { rumor } = await unwrapGift(ev, this.signer);
      store.insertMessage(rumor, ev.id, this.ownerPubkey);
      store.markSeenWrap(ev.id);
      this.stats.decryptedOk++;
      this.emit('mail-received', { rumorId: rumor.id });
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
