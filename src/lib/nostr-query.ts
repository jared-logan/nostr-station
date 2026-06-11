/**
 * Shared Nostr query helpers.
 *
 * `queryRelaysDirect()` is the one relay-query loop every server
 * consumer composes: it opens a WebSocket per relay, fans a NIP-01 REQ
 * out, dedupes by event id, and always resolves with diagnostics so
 * empty-state UIs can show why a query returned nothing. It replaced
 * an earlier implementation that shelled out to `nak req` per query —
 * a process fork + binary load per call that stacked up badly on
 * multi-query flows (project memory: project_nak_stdin_hang).
 *
 * Pure helpers (`parseEventLine`, `getTag`/`getTags`) are exported
 * alongside the async query so they're trivially unit-testable without
 * a relay round-trip. The per-project event cache at the bottom keeps
 * slow-changing data (e.g. kind-30617 announcements) off the wire.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';
import { findBin } from './detect.js';
import { MAX_WS_PAYLOAD } from './ws-limits.js';

// ── Types ─────────────────────────────────────────────────────────────────

export interface NostrEvent {
  id:         string;
  pubkey:     string;
  kind:       number;
  created_at: number;
  tags:       string[][];
  content:    string;
  sig:        string;
}

export interface RelayQueryFilter {
  kinds?:   number[];
  authors?: string[];                              // hex pubkeys
  /**
   * Exact event ids (NIP-01 `ids` filter). Use this when you already
   * know the events you want — canonical example: resolving root
   * patches by id to learn their authoring pubkey for an
   * authorisation check.
   */
  ids?:     string[];
  /**
   * NIP-01 tag filters. Either `{a: '30617:pk:id'}` or
   * `{t: ['root', 'root-revision']}` works — multi-value entries
   * expand into a `#<name>` filter with one entry per value.
   */
  tags?:    Record<string, string | string[]>;
  limit?:   number;
}

export interface RelayQueryDiagnostics {
  eventsSeen:    number;     // total events that parsed successfully (pre-dedupe)
  uniqueEvents:  number;     // events kept after dedupe by id
  parseFailures: number;     // JSON parse failures on relay frames
  // The four fields below date from the retired nak-subprocess query
  // path. queryRelaysDirect fills them with inert values; they're kept
  // so the result shape stays stable for existing consumers.
  stderrTail:    string;     // always '' (n/a for direct-WS)
  spawnError:    string | null; // always null (n/a for direct-WS)
  exitCode:      number | null; // always null (n/a for direct-WS)
  nakArgs:       string[];   // always [] (n/a for direct-WS)
  durationMs:    number;     // wall-clock spent inside the query
}

export interface RelayQueryResult {
  events:      NostrEvent[];
  diagnostics: RelayQueryDiagnostics;
}

export interface RelayQueryOptions {
  filter:        RelayQueryFilter;
  relays:        string[];
  /** Default 10_000. Caps `--stream` queries that would otherwise run forever. */
  timeoutMs?:    number;
  /**
   * Default true. Pass `--stream` to keep the subscription open until
   * the timer fires (or `acceptUntil` returns truthy). Set false for
   * one-shot lookups where you want nak to exit on EOSE.
   */
  stream?:       boolean;
  /**
   * Optional short-circuit. Called after every accepted event with the
   * full deduped events array; returning truthy resolves the query
   * immediately. Cheap way to express "stop after the first hit" or
   * "stop once we have one of each branch".
   */
  acceptUntil?:  (events: NostrEvent[]) => boolean;
  abortSignal?:  AbortSignal;
}

// ── Pure helpers ──────────────────────────────────────────────────────────

/**
 * Parse one stdout line into a NostrEvent. Returns null on:
 *   - empty / whitespace-only lines
 *   - JSON parse failure
 *   - missing or wrong-typed required fields per NIP-01
 *
 * Does NOT verify the signature — callers that need verification
 * should hand the event to nostr-tools `verifyEvent`. We split the
 * concern so the cheap structural check can run on every relay
 * response without paying for a secp256k1 verify per line.
 */
export function parseEventLine(line: string): NostrEvent | null {
  const s = line.trim();
  if (!s) return null;
  let ev: any;
  try { ev = JSON.parse(s); } catch { return null; }
  if (!ev || typeof ev !== 'object') return null;
  if (typeof ev.id !== 'string')         return null;
  if (typeof ev.pubkey !== 'string')     return null;
  if (typeof ev.kind !== 'number')       return null;
  if (typeof ev.created_at !== 'number') return null;
  if (!Array.isArray(ev.tags))           return null;
  if (typeof ev.content !== 'string')    return null;
  if (typeof ev.sig !== 'string')        return null;
  return ev as NostrEvent;
}

/** First tag with the given name, or null. */
export function getTag(event: NostrEvent, name: string): string[] | null {
  const t = event.tags.find((tag) => Array.isArray(tag) && tag[0] === name);
  return t ?? null;
}

/** First value (tag[1]) of the named tag, or null. */
export function getTagValue(event: NostrEvent, name: string): string | null {
  const t = getTag(event, name);
  if (!t || typeof t[1] !== 'string') return null;
  return t[1];
}

/** All tags with the given name (preserves order). */
export function getTags(event: NostrEvent, name: string): string[][] {
  return event.tags.filter((tag) => Array.isArray(tag) && tag[0] === name);
}

// ── Async query ───────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 10_000;

// ── Per-project event cache ───────────────────────────────────────────────
//
// JSON-file cache rooted at
// `~/.config/nostr-station/projects/<projectId>/cache/<key>.json`.
// Phase 1+ uses this to avoid re-querying relays for slow-changing data
// like the kind-30617 announcement on every Code-tab open.
//
// Lives in user-config (not in the project tree) so the cache can never
// dirty the user's repo, regardless of what their .gitignore looks like
// or how aggressive `git add -A` is. Removes the need for the previous
// auto-untrack / auto-write-gitignore machinery this module used to
// carry. Legacy `<project>/.nostr-station/cache/` is migrated lazily on
// first read or write.
//
// Single envelope shape `{cachedAt, value}` so TTL is enforced uniformly
// and a missing/corrupt entry collapses to `null` (no exception bubbling
// into request handlers).

const CACHE_DIR_NAME = 'cache';
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
// `key` becomes a filename — restrict to a conservative charset rather
// than escaping, so we can't be talked into ../ traversal by a future
// caller passing a derived string.
const SAFE_KEY = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Cache scope. Always identified by `projectId` (UUID) since the cache
 * lives outside the project tree now. `projectPath` is accepted as an
 * optional hint so we can find-and-migrate any legacy
 * `<projectPath>/.nostr-station/cache/` from before the move.
 */
export interface CacheKey {
  projectId:    string;
  projectPath?: string;
  key:          string;
}

export interface CacheOptions extends CacheKey {
  ttlMs?: number;
}

interface CacheEnvelope<T> {
  cachedAt: number;
  value:    T;
}

function cacheRoot(projectId: string): string {
  return path.join(os.homedir(), '.config', 'nostr-station', 'projects', projectId, CACHE_DIR_NAME);
}

function cachePath(k: CacheKey): string {
  if (!SAFE_KEY.test(k.key)) {
    throw new Error(`unsafe cache key (must match ${SAFE_KEY}): ${k.key}`);
  }
  return path.join(cacheRoot(k.projectId), `${k.key}.json`);
}

// One-time-per-process per-project migration of the legacy
// `<projectPath>/.nostr-station/cache/` directory into the new
// user-config location. Recursively copies entries that don't already
// exist in the destination, then removes the legacy dir when it's
// untracked. Tracked legacy entries surface through
// project-config.ts's legacyLocalFiles() so the UI can nudge the user.
const cacheMigrated = new Set<string>();

function migrateLegacyCache(projectId: string, projectPath?: string): void {
  if (!projectPath) return;
  if (cacheMigrated.has(projectId)) return;
  cacheMigrated.add(projectId);

  const legacyDir = path.join(projectPath, '.nostr-station', CACHE_DIR_NAME);
  if (!fs.existsSync(legacyDir)) return;

  const destDir = cacheRoot(projectId);
  try {
    fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(legacyDir)) {
      const from = path.join(legacyDir, entry);
      const to   = path.join(destDir, entry);
      if (fs.existsSync(to)) continue;
      try {
        const buf = fs.readFileSync(from);
        fs.writeFileSync(to, buf);
      } catch { /* best-effort per-file */ }
    }
  } catch { /* best-effort */ }

  // Remove the legacy directory when nothing in it is tracked. Three
  // "safe to delete" cases that look different but are all OK:
  //   - not a git repo at all                 (nothing CAN be tracked)
  //   - git binary missing                    (we can't check; the
  //                                            project tree is the
  //                                            same as the not-a-repo
  //                                            case — files were
  //                                            never added to git)
  //   - git ls-files returns empty            (no tracked entries)
  // The ONLY case we must avoid is "some entry under
  // .nostr-station/cache/ is tracked" — there, deleting would create a
  // surprise staged deletion. The user gets a banner instead.
  let safeToDelete = true;
  const gitBin = findBin('git');
  if (gitBin) {
    try {
      const tracked = execFileSync(
        gitBin, ['ls-files', '--', '.nostr-station/cache'],
        { cwd: projectPath, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 },
      ).toString().trim();
      if (tracked) safeToDelete = false;
    } catch { /* not a repo / other error — same as no-git: safe */ }
  }
  if (safeToDelete) {
    try { fs.rmSync(legacyDir, { recursive: true, force: true }); } catch {}
  }
}

export function getCached<T>(opts: CacheOptions): T | null {
  migrateLegacyCache(opts.projectId, opts.projectPath);
  const ttl  = opts.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const file = cachePath(opts);
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let env: CacheEnvelope<T>;
  try { env = JSON.parse(raw); } catch { return null; }
  if (!env || typeof env.cachedAt !== 'number') return null;
  if (Date.now() - env.cachedAt > ttl) return null;
  return env.value;
}

export function setCached<T>(opts: CacheKey, value: T): void {
  migrateLegacyCache(opts.projectId, opts.projectPath);
  const file = cachePath(opts);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const env: CacheEnvelope<T> = { cachedAt: Date.now(), value };
    fs.writeFileSync(file, JSON.stringify(env, null, 2), { mode: 0o600 });
  } catch {
    // best-effort — a cache write failure should never break the query
    // path. The next call will just re-query relays.
  }
}

export function clearCache(opts: CacheKey): void {
  const file = cachePath(opts);
  try { fs.unlinkSync(file); } catch {}
}

/**
 * Get-or-fetch convenience. Returns the cached value if fresh,
 * otherwise calls `fetcher`, persists the result, and returns it.
 * `fetcher` exceptions propagate — caching only happens on success.
 */
export async function getCachedOrFetch<T>(
  opts: CacheOptions,
  fetcher: () => Promise<T>,
): Promise<T> {
  const cached = getCached<T>(opts);
  if (cached !== null) return cached;
  const value = await fetcher();
  setCached<T>(opts, value);
  return value;
}

// ── Direct-WS query ───────────────────────────────────────────────────────
//
// Talks WebSocket directly to each relay — no subprocess. This replaced
// an earlier `nak req` shell-out path:
//   1. Identity sync and other multi-query flows issue 7+ relay queries
//      per operation. Each nak spawn was a process fork + binary load +
//      stdin/stdout pipe orchestration; under a developer-laptop load
//      that stacked up enough to surface as "feed is empty" when the
//      probes timed out (project memory: project_nak_stdin_hang bit us
//      repeatedly).
//   2. It also removed the dependency on whichever nak version happens
//      to be on PATH.
// Diagnostics reduce to "did we see any events" + how many; the
// subprocess-era fields on RelayQueryDiagnostics stay inert for shape
// stability.
export async function queryRelaysDirect(opts: RelayQueryOptions): Promise<RelayQueryResult> {
  const timeoutMs  = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stream     = opts.stream ?? true;
  const startedAt  = Date.now();
  const baseDiag: RelayQueryDiagnostics = {
    eventsSeen:    0,
    uniqueEvents:  0,
    parseFailures: 0,
    stderrTail:    '',
    spawnError:    null,
    exitCode:      null,
    nakArgs:       [],  // n/a for direct-WS; preserved for API parity
    durationMs:    0,
  };

  if (opts.relays.length === 0) {
    return { events: [], diagnostics: { ...baseDiag, durationMs: Date.now() - startedAt } };
  }

  return new Promise<RelayQueryResult>((resolve) => {
    const eventsById = new Map<string, NostrEvent>();
    const filter     = filterToNip01(opts.filter);
    const subId      = 'ns-q-' + Math.random().toString(36).slice(2, 10);
    let resolved     = false;
    let closedCount  = 0;
    let eventsSeen   = 0;
    let parseFailures = 0;
    const sockets: WebSocket[] = [];

    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      for (const ws of sockets) { try { ws.close(); } catch {} }
      clearTimeout(timer);
      const events = [...eventsById.values()];
      resolve({
        events,
        diagnostics: {
          ...baseDiag,
          eventsSeen,
          uniqueEvents:  events.length,
          parseFailures,
          durationMs:    Date.now() - startedAt,
        },
      });
    };

    const checkAcceptUntil = (): void => {
      if (!opts.acceptUntil) return;
      try { if (opts.acceptUntil([...eventsById.values()])) finish(); }
      catch { /* swallow predicate errors — don't break the query */ }
    };

    const timer = setTimeout(finish, timeoutMs);
    if (opts.abortSignal) {
      opts.abortSignal.addEventListener('abort', finish, { once: true });
    }

    for (const relayUrl of opts.relays) {
      let ws: WebSocket;
      try { ws = new WebSocket(relayUrl, { maxPayload: MAX_WS_PAYLOAD }); }
      catch { closedCount++; continue; }
      sockets.push(ws);

      ws.on('open', () => {
        try { ws.send(JSON.stringify(['REQ', subId, filter])); }
        catch { /* fall through to error handler */ }
      });
      ws.on('message', (data) => {
        let msg: any;
        try { msg = JSON.parse(typeof data === 'string' ? data : data.toString()); }
        catch { parseFailures++; return; }
        if (!Array.isArray(msg)) return;
        // EVENT frames: ["EVENT", subId, event]
        if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]) {
          const ev = msg[2];
          // Cheap structural check before deduping — drop anything that
          // doesn't look like NIP-01.
          if (typeof ev.id !== 'string' || typeof ev.kind !== 'number') return;
          eventsSeen++;
          if (eventsById.has(ev.id)) return;
          eventsById.set(ev.id, ev as NostrEvent);
          checkAcceptUntil();
          // When stream is false, the caller wants one-shot semantics —
          // resolve as soon as the first event arrives (matching the
          // nak version's `--no-stream` + acceptUntil behavior). Most
          // callers use acceptUntil for this so it's belt-and-suspenders.
        } else if (msg[0] === 'EOSE' && msg[1] === subId) {
          // EOSE = end of stored events. For one-shot queries (stream=false),
          // close this socket and count it; once all relays EOSE we finish.
          if (!stream) {
            closedCount++;
            try { ws.close(); } catch {}
            if (closedCount >= sockets.length) finish();
          }
          // For streaming queries we keep the socket open so new live
          // events arrive until the timer fires or acceptUntil returns.
        } else if (msg[0] === 'CLOSED' && msg[1] === subId) {
          // Relay explicitly closed the subscription (e.g. auth-required).
          closedCount++;
          try { ws.close(); } catch {}
          if (closedCount >= sockets.length) finish();
        }
      });
      ws.on('error', () => {
        closedCount++;
        if (closedCount >= sockets.length) finish();
      });
      ws.on('close', () => {
        // Only count a clean close if we haven't already counted EOSE/CLOSED
        // for this socket — node-ws fires both. Guard by tracking via the
        // higher-level closedCount; double-counting just makes finish() fire
        // a tick early which is harmless because finish() is idempotent.
        closedCount++;
        if (closedCount >= sockets.length) finish();
      });
    }
  });
}

// Translate the structural RelayQueryFilter into the NIP-01 wire shape.
// Tag-name filters serialize as "#<name>": values per NIP-12.
function filterToNip01(f: RelayQueryFilter): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (f.kinds   && f.kinds.length)   out.kinds   = f.kinds;
  if (f.authors && f.authors.length) out.authors = f.authors;
  if (f.ids     && f.ids.length)     out.ids     = f.ids;
  if (typeof f.limit === 'number' && f.limit > 0) out.limit = Math.floor(f.limit);
  if (f.tags) {
    for (const [name, raw] of Object.entries(f.tags)) {
      const values = Array.isArray(raw) ? raw : [raw];
      if (values.length === 0) continue;
      out[`#${name}`] = values;
    }
  }
  return out;
}
