// Per-relay health aggregator.
//
// nvpn publishes presence/signaling events to a configured set of Nostr
// relays. The dashboard's Relays tab currently lists configured URLs but
// gives no signal about which are actually accepting publishes — so a
// rate-limiting or down relay silently breaks the mesh and the user has
// to grep daemon.log to figure out why.
//
// This module wires a small parser into the vpn LogBuffer. Each line is
// matched against a handful of known relay-error patterns (rate-limited,
// 5xx, 403, WoT rejection, connect/recv timeout). Successful matches
// update a per-URL summary that the /api/nvpn/relays/health route reads.
//
// Design notes:
//
//   * Sliding-window. We keep a bounded list of recent events (default
//     5 minutes) and compute counts from that, so a relay that was bad
//     yesterday but recovered today doesn't stay red forever.
//   * Stateless parser. Each regex matches independently; we don't try
//     to follow multi-line context. nvpn's log lines are self-contained
//     enough that this works in practice.
//   * Pure helpers (classifyLine, extractRelayUrl) are exported so unit
//     tests can pin behavior on representative log samples.

import type { LogBuffer, LogLine } from './log-buffer.js';

export type RelayErrorKind =
  | 'rate_limited'
  | 'http_5xx'
  | 'http_4xx'
  | 'wot_reject'
  | 'timeout'
  | 'connect_failed'
  | 'other';

export type RelayEventKind = 'publish_ok' | RelayErrorKind;

export interface RelayEvent {
  ts:   number;
  url:  string;
  kind: RelayEventKind;
  text: string;
}

export interface RelayHealth {
  url:        string;
  okCount:    number;          // publishes succeeded in window
  errCount:   number;          // any error in window
  lastError:  { kind: RelayErrorKind; text: string; ts: number } | null;
  lastEventAt: number | null;
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

// Best-effort URL extraction. nvpn log lines that reference a relay
// typically include the full wss:// URL (sometimes with a trailing slash,
// sometimes wrapped in punctuation). This regex pulls the first match;
// we trim trailing `/`, `,`, `:` and other punctuation that shouldn't be
// part of the URL itself.
const URL_RE = /\b(wss?:\/\/[a-zA-Z0-9._\-]+(?::\d+)?(?:\/[^\s,"'<>)]*)?)/;

export function extractRelayUrl(text: string): string | null {
  const m = URL_RE.exec(text);
  if (!m) return null;
  return m[1].replace(/[/.,:;]+$/, '');
}

// Classify a single log line. Returns null when the line doesn't look
// like a relay-related event we care about.
export function classifyLine(text: string): RelayEventKind | null {
  const lower = text.toLowerCase();
  // Rate-limit takes priority over other "publish failed" matches because
  // it's the single most common diagnosis users hit.
  if (lower.includes('rate-limited') || lower.includes('noting too much')) return 'rate_limited';
  if (/\b5\d\d\b/.test(text) && /gateway|server error|timeout|bad gateway/i.test(text)) return 'http_5xx';
  if (/\b403\b/.test(text) && /forbidden/i.test(text)) return 'http_4xx';
  if (/policy violated|not in our web of trust|web.of.trust|\bWoT\b/i.test(text)) return 'wot_reject';
  if (/timeout on connect|impossible to connect: timeout|connect.*timed? ?out/i.test(text)) return 'connect_failed';
  if (/recv message response timeout|relay not connected|response timeout/i.test(text)) return 'timeout';
  // Successful publish — nvpn doesn't have a uniform "publish ok" line
  // shape, so we only count an explicit positive signal when present.
  if (/event published to|published event|publish ok/i.test(text)) return 'publish_ok';
  return null;
}

export class RelayHealthAggregator {
  private events:    RelayEvent[]      = [];
  private unsub:     (() => void) | null = null;
  private windowMs:  number;

  constructor(windowMs: number = DEFAULT_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  // Attach to a LogBuffer. Returns an unsubscribe fn so the caller can
  // detach in tests / on shutdown. Idempotent — calling attach twice
  // replaces the prior subscription.
  attach(buffer: LogBuffer): () => void {
    if (this.unsub) this.unsub();
    this.unsub = buffer.subscribe((line) => this.consume(line));
    return () => {
      if (this.unsub) this.unsub();
      this.unsub = null;
    };
  }

  // Public for tests + for the LogBuffer subscription callback.
  consume(line: LogLine): void {
    const kind = classifyLine(line.text);
    if (!kind) return;
    const url = extractRelayUrl(line.text);
    if (!url) return;
    this.events.push({ ts: line.ts, url, kind, text: line.text });
    this.gc(line.ts);
  }

  // Drop events older than the window. Called on every consume so the
  // event list never grows unboundedly under a chatty daemon.
  private gc(now: number): void {
    const cutoff = now - this.windowMs;
    // Most-recent-first; events list is already in chronological order
    // so a single shift loop is enough.
    while (this.events.length > 0 && this.events[0].ts < cutoff) {
      this.events.shift();
    }
  }

  // Snapshot the current per-URL health. URLs with no events in the
  // window are omitted — the caller (route handler) merges this against
  // the configured relay list so URLs without recent activity show as
  // "no data" rather than "broken".
  snapshot(now: number = Date.now()): RelayHealth[] {
    this.gc(now);
    const byUrl = new Map<string, RelayHealth>();
    for (const ev of this.events) {
      let cur = byUrl.get(ev.url);
      if (!cur) {
        cur = { url: ev.url, okCount: 0, errCount: 0, lastError: null, lastEventAt: null };
        byUrl.set(ev.url, cur);
      }
      cur.lastEventAt = ev.ts;
      if (ev.kind === 'publish_ok') {
        cur.okCount += 1;
      } else {
        cur.errCount += 1;
        cur.lastError = { kind: ev.kind, text: ev.text, ts: ev.ts };
      }
    }
    return [...byUrl.values()];
  }

  // Test/ops helper.
  clear(): void { this.events = []; }
}

// Process-wide singleton. web-server.ts calls attach() at boot; the
// route handler in routes/nvpn.ts reads via snapshot(). Tests should
// avoid this and use a fresh RelayHealthAggregator instance.
let _singleton: RelayHealthAggregator | null = null;
export function nvpnRelayHealth(): RelayHealthAggregator {
  if (!_singleton) _singleton = new RelayHealthAggregator();
  return _singleton;
}
