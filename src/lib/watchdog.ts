// In-Node watchdog. The pre-deletion watchdog was a bash script wrapped
// in launchd / systemd that polled the relay every 5 minutes and
// published a heartbeat event. The new architecture is a single Node
// process, so the watchdog moves inside that process: a setInterval
// signs and publishes a kind-1 heartbeat to the in-process relay,
// nothing more.
//
// The watchdog gets its own keypair (kept in the OS keychain under the
// 'watchdog-nsec' slot — same convention the legacy version used).
// Generated on first start, reused thereafter so the pubkey identifies
// the watchdog stably across restarts. Auto-registered into the relay's
// whitelist on each start so the relay's NIP-42 write gating doesn't
// reject the heartbeat.

import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { getKeychain } from './keychain.js';
import type { Relay } from '../relay/index.js';
import type { NostrEvent } from '../relay/types.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const HEARTBEAT_KIND      = 1;
const HEARTBEAT_TAG       = ['client', 'nostr-station-watchdog'];

export interface WatchdogOptions {
  relay:        Relay;
  onLog?:       (level: 'info' | 'warn' | 'error', text: string) => void;
  intervalMs?:  number;            // override for tests
  // Test-only: skip the firing scheduler so unit tests can drive
  // heartbeat() manually without setInterval racing them.
  manualTick?:  boolean;
}

export interface WatchdogStatus {
  running:           boolean;
  lastHeartbeatAt:   number | null;   // ms epoch
  npub:              string | null;   // null until start() resolves
  intervalMs:        number;
}

export class Watchdog {
  private relay:           Relay;
  private onLog?:          WatchdogOptions['onLog'];
  private intervalMs:      number;
  private manualTick:      boolean;
  private timer:           NodeJS.Timeout | null = null;
  private secretKey:       Uint8Array | null     = null;
  private pubkeyHex:       string | null         = null;
  private npub:            string | null         = null;
  private lastHeartbeatAt: number | null         = null;

  constructor(opts: WatchdogOptions) {
    this.relay      = opts.relay;
    this.onLog      = opts.onLog;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.manualTick = !!opts.manualTick;
  }

  // Idempotent — calling start on an already-running watchdog is a no-op.
  // Returns once the keypair is loaded / generated and (optionally) the
  // first heartbeat has fired, so the caller can return a meaningful
  // {running:true, npub} status from /api/watchdog/start without races.
  async start(): Promise<void> {
    if (this.timer || this.secretKey) return;

    // Load or generate the watchdog keypair. The legacy launchd/systemd
    // watchdog seeded this slot via a bash script during onboard; the
    // new in-Node version handles it here so a fresh install gets a
    // working watchdog with no extra setup.
    const kc = getKeychain();
    let stored = await kc.retrieve('watchdog-nsec');
    if (!stored) {
      const fresh = generateSecretKey();
      const nsec  = nip19.nsecEncode(fresh);
      await kc.store('watchdog-nsec', nsec);
      stored = nsec;
      this.log('info', 'generated new watchdog-nsec in keychain');
    }
    const decoded = nip19.decode(stored);
    if (decoded.type !== 'nsec') {
      throw new Error(`watchdog-nsec slot does not hold an nsec (type=${decoded.type})`);
    }
    this.secretKey = decoded.data as Uint8Array;
    this.pubkeyHex = getPublicKey(this.secretKey);
    this.npub      = nip19.npubEncode(this.pubkeyHex);

    // Auto-register the watchdog's pubkey in the relay's whitelist so
    // its heartbeats clear the NIP-42 write gate. Idempotent — add()
    // returns false if already present.
    const added = this.relay.whitelist.add(this.pubkeyHex);
    if (added) this.log('info', `whitelist: added watchdog pubkey ${this.npub}`);

    // Fire one heartbeat immediately so the user sees activity right
    // away, then schedule. Errors are logged but don't abort start —
    // the relay might be momentarily unreachable mid-restart, the
    // recurring tick will recover.
    try { await this.heartbeat(); }
    catch (e: any) { this.log('error', `initial heartbeat failed: ${e?.message || e}`); }

    if (!this.manualTick) {
      this.timer = setInterval(() => {
        this.heartbeat().catch(e => this.log('error', `heartbeat failed: ${e?.message || e}`));
      }, this.intervalMs);
      this.log('info', `watchdog running — heartbeat every ${this.intervalMs / 1000}s`);
    }
  }

  // Idempotent. Stops the scheduler but does NOT clear keys — restart()
  // is just stop()+start() and shouldn't have to round-trip to keychain.
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log('info', 'watchdog stopped');
    }
  }

  status(): WatchdogStatus {
    return {
      running:         !!this.timer,
      lastHeartbeatAt: this.lastHeartbeatAt,
      npub:            this.npub,
      intervalMs:      this.intervalMs,
    };
  }

  // Public for tests + the optional /api/watchdog/heartbeat manual-fire
  // endpoint (not currently wired). Sign + publish one kind-1 event,
  // updating lastHeartbeatAt on success.
  async heartbeat(): Promise<NostrEvent> {
    if (!this.secretKey || !this.pubkeyHex) {
      throw new Error('watchdog not started');
    }
    const ev = finalizeEvent({
      kind:       HEARTBEAT_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags:       [HEARTBEAT_TAG],
      content:    `nostr-station watchdog heartbeat @ ${new Date().toISOString()}`,
    }, this.secretKey) as unknown as NostrEvent;

    // Direct add — bypasses the wire-protocol round-trip but still goes
    // through the EventStore (so REQ subscribers see it) via the
    // relay's publishLocal helper. Avoids opening a WebSocket every 5
    // minutes just to talk to ourselves.
    this.relay.publishLocal(ev);
    this.lastHeartbeatAt = Date.now();
    this.log('info', `heartbeat published — id ${ev.id.slice(0, 8)}…`);
    return ev;
  }

  private log(level: 'info' | 'warn' | 'error', text: string): void {
    try { this.onLog?.(level, text); } catch { /* never poison the watchdog */ }
  }
}
