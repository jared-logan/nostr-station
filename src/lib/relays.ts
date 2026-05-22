/**
 * NIP-65 relay-list control plane.
 *
 * Three concerns, behind one module:
 *
 *   1. Local editing of identity.json's readRelays / writeRelays. Pure
 *      filesystem; no network. add/remove/list helpers consumed by both
 *      the CLI (`nostr-station relays …`) and a future dashboard editor.
 *
 *   2. Pulling the operator's published kind:10002 (NIP-65) from the
 *      network and diffing it against the local lists. Returns a
 *      structured diff so callers can render it and gate the apply
 *      step behind a confirm. Never modifies identity.json on its own.
 *
 *   3. Publishing a new kind:10002 from the current local lists.
 *      Builds the event template, hands it to the saved bunker for
 *      signing, broadcasts the signed event to the union of read +
 *      write relays, returns per-relay OK/FAIL/TIMEOUT. Never signs
 *      or sends without the caller already taking an explicit confirm.
 *
 * The CLI and dashboard both depend on a confirm having happened before
 * they call publishNip65 — this module trusts its caller on that point
 * but provides everything needed to render the preview that drives it.
 */
import WebSocket from 'ws';
import {
  readIdentity, writeIdentity, isValidRelayUrl,
  DEFAULT_READ_RELAYS, npubToHex,
} from './identity.js';
import { MAX_WS_PAYLOAD } from './ws-limits.js';
import type { Identity } from './identity.js';

// ── Local list model ──────────────────────────────────────────────────────

export type RelayMode = 'both' | 'read' | 'write';

export interface RelayEntry {
  url:  string;
  mode: RelayMode;
}

// Bootstrap relays the `pull` flow falls back to when the local list is
// empty (a brand-new install before the user has touched anything). A
// tiny subset of DEFAULT_READ_RELAYS — picked for reliability over
// completeness so a first-time pull has a real chance of finding the
// operator's kind:10002 even with zero configuration.
export const BOOTSTRAP_RELAYS: string[] = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
];

// Convert (readRelays, writeRelays) → unified RelayEntry[] for display
// or for `r`-tag emission. Read-only urls get mode "read"; write-only
// get "write"; urls present in both (or in readRelays when writeRelays
// is undefined — the legacy default) get "both".
//
// Stable order: insertion order of readRelays first, then any
// write-only urls appended. Keeps the rendered list deterministic so a
// diff against a freshly-pulled kind:10002 doesn't show false moves.
export function listRelays(): RelayEntry[] {
  const ident = readIdentity();
  return mergeRelayLists(ident.readRelays || [], ident.writeRelays);
}

export function mergeRelayLists(
  readRelays:  string[],
  writeRelays: string[] | undefined,
): RelayEntry[] {
  const out: RelayEntry[] = [];
  const writeSet = writeRelays === undefined ? null : new Set(writeRelays);
  // null writeSet means "legacy install — every read relay is also a
  // write relay" so the kind:10002 ends up with unmarked r-tags. Once
  // the user edits markers explicitly (CLI flags / dashboard toggles),
  // writeRelays becomes a real array and this branch stops applying.
  for (const url of readRelays) {
    if (writeSet === null) out.push({ url, mode: 'both' });
    else if (writeSet.has(url)) out.push({ url, mode: 'both' });
    else out.push({ url, mode: 'read' });
  }
  if (writeSet !== null) {
    for (const url of writeRelays!) {
      if (!readRelays.includes(url)) out.push({ url, mode: 'write' });
    }
  }
  return out;
}

// Add a relay to identity.json. `mode` selects which list(s) it goes
// into. Default = 'both' (the unmarked NIP-65 default — every modern
// client emits unmarked tags unless the user explicitly picks a side).
// Returns the new merged list so the caller can render the resulting
// state without re-reading.
export function addRelayLocal(
  url:   string,
  mode:  RelayMode = 'both',
): { ok: boolean; error?: string; relays?: RelayEntry[] } {
  const trimmed = url.trim();
  if (!isValidRelayUrl(trimmed)) {
    return { ok: false, error: 'url must start with ws:// or wss://' };
  }
  const ident = readIdentity();

  // Snapshot current state. For a legacy install (writeRelays
  // undefined), materialise it from readRelays so the explicit marker
  // we're about to set actually sticks — without this step a `relays
  // add <url> --read` on a legacy install would be silently promoted
  // back to "both" on the next read (since the loader still treats
  // undefined writeRelays as "every read relay is also a write relay").
  const readArr  = (ident.readRelays || []).slice();
  const writeArr = materialiseWriteRelays(ident);

  const wantsRead  = mode === 'read'  || mode === 'both';
  const wantsWrite = mode === 'write' || mode === 'both';

  if (wantsRead  && !readArr.includes(trimmed))  readArr.push(trimmed);
  if (wantsWrite && !writeArr.includes(trimmed)) writeArr.push(trimmed);

  ident.readRelays  = readArr;
  ident.writeRelays = writeArr;
  writeIdentity(ident);

  return { ok: true, relays: mergeRelayLists(ident.readRelays, ident.writeRelays) };
}

// Remove a relay from BOTH readRelays and writeRelays. The CLI's
// `relays remove` is binary — to drop only the read side or only the
// write side, the user runs `relays add <url> --write` (or --read)
// which materialises the marker.
export function removeRelayLocal(url: string): { ok: boolean; relays: RelayEntry[]; removed: boolean } {
  const ident   = readIdentity();
  const before  = (ident.readRelays?.length || 0) + (materialiseWriteRelays(ident).length);
  ident.readRelays  = (ident.readRelays  || []).filter(u => u !== url);
  ident.writeRelays = materialiseWriteRelays(ident).filter(u => u !== url);
  const after  = ident.readRelays.length + ident.writeRelays.length;
  writeIdentity(ident);
  return {
    ok:      true,
    removed: after < before,
    relays:  mergeRelayLists(ident.readRelays, ident.writeRelays),
  };
}

// Promote a legacy identity.json (writeRelays undefined) into the
// explicit-marker model by mirroring readRelays into writeRelays.
// Returns the resolved writeRelays array regardless of whether the
// caller has yet decided to persist it.
function materialiseWriteRelays(ident: Identity): string[] {
  if (Array.isArray(ident.writeRelays)) return ident.writeRelays.slice();
  return (ident.readRelays || []).slice();
}

// ── NIP-65 pull (fetch + parse) ──────────────────────────────────────────

export interface ParsedNip65 {
  readRelays:  string[];
  writeRelays: string[];
  createdAt:   number;
  eventId:     string;
}

export interface PullResult {
  ok:        boolean;
  parsed?:   ParsedNip65;
  // Diff vs. the current local lists. Computed eagerly so callers don't
  // have to re-load identity.json between fetch and confirm.
  diff?:     RelayDiff;
  // Per-relay reachability — populated even on success so the user can
  // see which bootstrap relays answered.
  relayResults: Array<{ relay: string; ok: boolean; reason?: string }>;
  error?:    string;
}

export interface RelayDiff {
  added:   RelayEntry[];   // present in incoming, absent locally
  removed: RelayEntry[];   // present locally, absent in incoming
  changed: Array<{ url: string; from: RelayMode; to: RelayMode }>;
  unchanged: number;
}

// Pull the operator's kind:10002 from a relay set. Pure-WebSocket REQ;
// no dependency on the `nak` binary. Each relay gets one shot with a
// per-relay timeout; we resolve as soon as we have ANY valid kind:10002
// for the operator's pubkey (the events are replaceable — only the
// newest matters), but keep listening on the rest of the relays until
// they all settle so the per-relay results are accurate.
//
// On a fetch failure (no events found, all relays errored, malformed
// event) the result includes the per-relay results and an error
// message; the caller MUST NOT touch identity.json based on this
// outcome. Preserve-on-failure is the explicit contract.
export async function pullNip65(opts: {
  npub:           string;
  relays?:        string[];      // defaults to BOOTSTRAP_RELAYS when omitted
  timeoutMs?:     number;
}): Promise<PullResult> {
  const timeoutMs = opts.timeoutMs ?? 6_000;

  let pubkeyHex: string;
  try {
    pubkeyHex = opts.npub.startsWith('npub1') ? npubToHex(opts.npub) : opts.npub;
  } catch (e: any) {
    return { ok: false, relayResults: [], error: `bad npub: ${e?.message || e}` };
  }
  if (!/^[0-9a-f]{64}$/i.test(pubkeyHex)) {
    return { ok: false, relayResults: [], error: 'npub did not decode to a 64-char hex pubkey' };
  }

  // Empty-list fallback. The bootstrap set is intentionally small — we
  // don't want to fan out to every default read relay for one event,
  // and the bootstrap relays are picked for high uptime.
  const relays = (opts.relays && opts.relays.length > 0) ? opts.relays : BOOTSTRAP_RELAYS;

  // Each relay races: open WS, send REQ for kind:10002 by author, take
  // the first EVENT (or any EOSE / error / timeout) and resolve.
  const tasks = relays.map(url => fetchKind10002FromOne(url, pubkeyHex, timeoutMs));
  const settled = await Promise.all(tasks);

  const relayResults = settled.map(s => ({ relay: s.url, ok: s.ok, reason: s.reason }));

  // Pick the newest valid kind:10002 across all relays — relayed copies
  // may have drifted between updates.
  let newest: { event: KindEvent; relay: string } | null = null;
  for (const s of settled) {
    if (!s.event) continue;
    if (!newest || s.event.created_at > newest.event.created_at) {
      newest = { event: s.event, relay: s.url };
    }
  }

  if (!newest) {
    return {
      ok: false,
      relayResults,
      error: 'no kind:10002 event found across the queried relays',
    };
  }

  // Parse `r` tags into read/write lists. Tags look like
  //   ["r", "<wss-url>"]            → both
  //   ["r", "<wss-url>", "read"]    → read only
  //   ["r", "<wss-url>", "write"]   → write only
  const readRelays:  string[] = [];
  const writeRelays: string[] = [];
  for (const t of newest.event.tags) {
    if (!Array.isArray(t) || t[0] !== 'r' || typeof t[1] !== 'string') continue;
    const url = t[1].trim();
    if (!isValidRelayUrl(url)) continue;
    const marker = typeof t[2] === 'string' ? t[2].trim().toLowerCase() : '';
    if (marker === 'read') {
      if (!readRelays.includes(url)) readRelays.push(url);
    } else if (marker === 'write') {
      if (!writeRelays.includes(url)) writeRelays.push(url);
    } else {
      if (!readRelays.includes(url))  readRelays.push(url);
      if (!writeRelays.includes(url)) writeRelays.push(url);
    }
  }

  if (readRelays.length === 0 && writeRelays.length === 0) {
    return {
      ok: false,
      relayResults,
      error: 'kind:10002 event found but contained no valid r tags',
    };
  }

  const ident = readIdentity();
  const localRead  = ident.readRelays || [];
  const localWrite = ident.writeRelays;
  const diff = diffRelays(
    mergeRelayLists(localRead, localWrite),
    mergeRelayLists(readRelays, writeRelays),
  );

  return {
    ok: true,
    parsed: {
      readRelays,
      writeRelays,
      createdAt: newest.event.created_at,
      eventId:   newest.event.id,
    },
    diff,
    relayResults,
  };
}

// Apply a parsed NIP-65 result to identity.json. Separated from
// pullNip65 so the caller can show the diff and gate the write on a
// confirm. Never publishes — pure local-state mutation.
export function applyNip65Pull(parsed: ParsedNip65): RelayEntry[] {
  const ident = readIdentity();
  ident.readRelays  = parsed.readRelays.slice();
  ident.writeRelays = parsed.writeRelays.slice();
  writeIdentity(ident);
  return mergeRelayLists(ident.readRelays, ident.writeRelays);
}

// Diff two RelayEntry lists. Used both for the pull preview and for the
// dashboard "unpublished changes" indicator (current local vs. last-
// published). Mode changes (e.g. read → both) surface as `changed`
// rather than a remove+add pair so the renderer can show a single line.
export function diffRelays(current: RelayEntry[], incoming: RelayEntry[]): RelayDiff {
  const cur = new Map(current.map(r => [r.url, r.mode]));
  const inc = new Map(incoming.map(r => [r.url, r.mode]));
  const added:   RelayEntry[] = [];
  const removed: RelayEntry[] = [];
  const changed: Array<{ url: string; from: RelayMode; to: RelayMode }> = [];
  let unchanged = 0;
  for (const [url, mode] of inc) {
    const c = cur.get(url);
    if (c === undefined) added.push({ url, mode });
    else if (c !== mode) changed.push({ url, from: c, to: mode });
    else unchanged++;
  }
  for (const [url, mode] of cur) {
    if (!inc.has(url)) removed.push({ url, mode });
  }
  return { added, removed, changed, unchanged };
}

// ── NIP-65 publish ────────────────────────────────────────────────────────

export interface PublishTemplate {
  kind:       10002;
  created_at: number;
  tags:       string[][];
  content:    string;
}

// Build the kind:10002 event template from the current
// (readRelays, writeRelays) state. The template is what we hand to the
// bunker for signing; the bunker fills in id, pubkey, sig. Surfaced as
// a separate step so the confirm dialog can show the exact tags that
// will be signed before any network or bunker activity happens.
export function buildNip65Template(opts?: { now?: number }): PublishTemplate {
  const entries = listRelays();
  const tags: string[][] = [];
  for (const e of entries) {
    if (e.mode === 'both')  tags.push(['r', e.url]);
    if (e.mode === 'read')  tags.push(['r', e.url, 'read']);
    if (e.mode === 'write') tags.push(['r', e.url, 'write']);
  }
  return {
    kind:       10002,
    created_at: Math.floor((opts?.now ?? Date.now()) / 1000),
    tags,
    content:    '',
  };
}

export interface PublishResult {
  ok:           boolean;
  signedEvent?: KindEvent;
  // One entry per relay we attempted, in the same order as the input.
  // `ok: true` means the relay returned OK=true; `false` means it
  // returned OK=false, errored on the socket, or timed out. `reason`
  // is the relay-supplied message or our timeout/error string.
  relayResults: Array<{ relay: string; ok: boolean; reason?: string }>;
  error?:       string;
}

// Publish the current local relay list as a new kind:10002 event.
//
// Steps:
//   1. Build the event template from listRelays().
//   2. Sign via the saved bunker. If signing fails (no bunker, timeout,
//      user rejection on phone), return ok=false with no events sent.
//   3. Broadcast the signed event to the union of read + write relays.
//   4. Collect per-relay OK/FAIL/TIMEOUT into relayResults.
//
// This function NEVER writes identity.json. The local state is the
// input. If the publish fails, identity.json is unchanged; if the
// publish succeeds, the caller may want to record a "last published"
// timestamp somewhere, but that's its decision.
export async function publishNip65(opts?: {
  signEvent?: (template: PublishTemplate) => Promise<{ ok: boolean; signedEvent?: any; error?: string }>;
  publish?:   (event: KindEvent, relays: string[], timeoutMs?: number) => Promise<Array<{ relay: string; ok: boolean; reason?: string }>>;
  timeoutMs?: number;
}): Promise<PublishResult> {
  const template = buildNip65Template();
  if (template.tags.length === 0) {
    return {
      ok: false,
      relayResults: [],
      error: 'no relays configured; add at least one before publishing',
    };
  }

  // Default signer: the saved-bunker path used by other identity-event
  // flows. Injected here so unit tests can substitute a deterministic
  // signer without spinning up a bunker.
  const signFn = opts?.signEvent ?? defaultSignEvent;
  const pubFn  = opts?.publish   ?? defaultPublishEvent;

  const signed = await signFn(template);
  if (!signed.ok || !signed.signedEvent) {
    return { ok: false, relayResults: [], error: signed.error || 'signing failed' };
  }

  // Broadcast to the union of read + write relays — both inbox and
  // outbox relays should carry the operator's current preference so
  // any peer querying the relay-of-the-moment sees a fresh kind:10002.
  const entries = listRelays();
  const targetUrls = Array.from(new Set(entries.map(e => e.url)));
  if (targetUrls.length === 0) {
    return { ok: false, signedEvent: signed.signedEvent, relayResults: [], error: 'no target relays' };
  }

  const relayResults = await pubFn(signed.signedEvent as KindEvent, targetUrls, opts?.timeoutMs);
  // "Success" = at least one relay acked OK. A 0/n result still
  // surfaces as ok=false so the CLI/dashboard reports the failure
  // clearly; relayResults always carries the per-relay detail.
  const anyOk = relayResults.some(r => r.ok);
  return { ok: anyOk, signedEvent: signed.signedEvent, relayResults };
}

// ── Internal helpers ──────────────────────────────────────────────────────

interface KindEvent {
  id:         string;
  pubkey:     string;
  kind:       number;
  created_at: number;
  tags:       string[][];
  content:    string;
  sig:        string;
}

// Pure-WebSocket fetch of kind:10002 for one author from one relay.
// Resolves either with the parsed event (if seen), or with { event: null }
// after EOSE / error / timeout — never throws. The caller aggregates
// across relays and picks the newest event.
function fetchKind10002FromOne(
  url:       string,
  pubkeyHex: string,
  timeoutMs: number,
): Promise<{ url: string; ok: boolean; event: KindEvent | null; reason?: string }> {
  return new Promise(resolve => {
    let settled = false;
    let event: KindEvent | null = null;
    let ws: WebSocket;
    const subId = 'nip65-' + Math.random().toString(36).slice(2, 10);

    const finish = (ok: boolean, reason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch {}
      resolve({ url, ok: ok || !!event, event, reason });
    };

    try {
      ws = new WebSocket(url, { maxPayload: MAX_WS_PAYLOAD });
    } catch (e: any) {
      resolve({ url, ok: false, event: null, reason: e?.message || 'invalid url' });
      return;
    }

    const timer = setTimeout(() => finish(!!event, event ? undefined : 'timeout'), timeoutMs);

    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify([
          'REQ', subId,
          { authors: [pubkeyHex], kinds: [10002], limit: 1 },
        ]));
      } catch (e: any) {
        finish(false, e?.message || 'send failed');
      }
    });
    ws.addEventListener('message', (m: any) => {
      try {
        const data = typeof m.data === 'string' ? m.data : m.data.toString();
        const msg  = JSON.parse(data);
        if (!Array.isArray(msg) || typeof msg[0] !== 'string') return;
        if (msg[0] === 'EVENT' && msg[1] === subId && msg[2] && typeof msg[2] === 'object') {
          const e = msg[2] as KindEvent;
          if (e.kind === 10002 && e.pubkey === pubkeyHex) {
            if (!event || e.created_at > event.created_at) event = e;
          }
        } else if (msg[0] === 'EOSE' && msg[1] === subId) {
          finish(true);
        } else if (msg[0] === 'CLOSED' && msg[1] === subId) {
          finish(true, typeof msg[2] === 'string' ? msg[2] : 'closed');
        }
      } catch { /* not JSON / not array */ }
    });
    ws.addEventListener('error', (e: any) => finish(false, e?.message || 'ws error'));
    ws.addEventListener('close', () => finish(true));
  });
}

// Default signer — lazy-imports auth-bunker so the relays module doesn't
// drag in the bunker dependency graph during unit tests that inject
// their own signer.
async function defaultSignEvent(
  template: PublishTemplate,
): Promise<{ ok: boolean; signedEvent?: any; error?: string }> {
  const { signEventWithSavedBunker } = await import('./auth-bunker.js');
  const result = await signEventWithSavedBunker(template);
  return { ok: result.ok, signedEvent: result.signedEvent, error: result.error };
}

// Default publish path — pure-WebSocket EVENT broadcast with per-relay
// OK / failure capture. Mirrors `publishEventToRelays` from routes/repo.ts
// without dragging in the route-handler module's transitive imports.
async function defaultPublishEvent(
  event:     KindEvent,
  relays:    string[],
  timeoutMs: number = 6000,
): Promise<Array<{ relay: string; ok: boolean; reason?: string }>> {
  const tasks = relays.map(url => new Promise<{ relay: string; ok: boolean; reason?: string }>(resolve => {
    let settled = false;
    let ws: WebSocket;
    const finish = (r: { relay: string; ok: boolean; reason?: string }) => {
      if (settled) return;
      settled = true;
      try { ws?.close(); } catch {}
      clearTimeout(timer);
      resolve(r);
    };
    try { ws = new WebSocket(url, { maxPayload: MAX_WS_PAYLOAD }); }
    catch (e: any) { resolve({ relay: url, ok: false, reason: e?.message || 'invalid url' }); return; }
    const timer = setTimeout(() => finish({ relay: url, ok: false, reason: 'timeout' }), timeoutMs);
    ws.addEventListener('open', () => {
      try { ws.send(JSON.stringify(['EVENT', event])); }
      catch (e: any) { finish({ relay: url, ok: false, reason: e?.message || 'send failed' }); }
    });
    ws.addEventListener('message', (m: any) => {
      try {
        const msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString());
        if (Array.isArray(msg) && msg[0] === 'OK' && msg[1] === event.id) {
          finish({ relay: url, ok: msg[2] === true, reason: typeof msg[3] === 'string' ? msg[3] : undefined });
        }
      } catch { /* not JSON / not array */ }
    });
    ws.addEventListener('error', (e: any) => finish({ relay: url, ok: false, reason: e?.message || 'ws error' }));
    ws.addEventListener('close', () => finish({ relay: url, ok: false, reason: 'closed before OK' }));
  }));
  return Promise.all(tasks);
}

// Re-export so tests + CLI can reference the bootstrap set without
// duplicating it.
export { DEFAULT_READ_RELAYS };
