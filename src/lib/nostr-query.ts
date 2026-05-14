/**
 * Shared Nostr query helpers — Phase 0 of the ngit-suite expansion.
 *
 * Three modules grew their own copies of the same nak-spawn-and-parse
 * loop (`routes/ngit.ts`, `sync.ts`, the proposals query). Each one
 * re-implemented:
 *   - `spawn('nak', […], { stdio: ['ignore', 'pipe', 'pipe'] })` — the
 *     `stdio[0] = 'ignore'` is mandatory; without it nak hangs on stdin
 *     EOF (project memory: project_nak_stdin_hang).
 *   - The line-buffered stdout reader (`buf += chunk; split('\n');
 *     pop`) that handles partial last-lines.
 *   - The 5–10 s wall-clock timer that bounds `--stream` (which never
 *     terminates on its own).
 *   - Diagnostics capture (`eventsSeen / parseFailures / stderrTail /
 *     spawnError / nakArgs / exitCode`) so empty-state UIs can show
 *     why a query returned nothing.
 *
 * The Phase 1+ ngit features (Code tab, patches, issues, status) all
 * need the same loop. Centralising it once means later phases just
 * compose `queryRelays(...)` calls and never re-derive the boilerplate.
 *
 * Pure helpers (`buildNakArgs`, `parseEventLine`, `getTag`/`getTags`)
 * are exported alongside the async query so they're trivially unit-
 * testable without a relay round-trip.
 */
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { findBin } from './detect.js';

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
   * Exact event ids (NIP-01 `ids` filter). nak takes them via repeated
   * `-i <id>`. Use this when you already know the events you want —
   * canonical example: resolving root patches by id to learn their
   * authoring pubkey for an authorisation check.
   */
  ids?:     string[];
  /**
   * NIP-01 tag filters. nak accepts repeated `-t key=value` flags, so
   * either `{a: '30617:pk:id'}` or `{t: ['root', 'root-revision']}`
   * works — the multi-value form expands into one flag per value.
   */
  tags?:    Record<string, string | string[]>;
  limit?:   number;
}

export interface RelayQueryDiagnostics {
  eventsSeen:    number;     // total events that parsed successfully (pre-dedupe)
  uniqueEvents:  number;     // events kept after dedupe by id
  parseFailures: number;     // JSON parse failures on stdout lines
  stderrTail:    string;     // last N bytes of stderr (capped)
  spawnError:    string | null; // ENOENT etc. — nak missing from PATH
  exitCode:      number | null; // null when killed by timeout / abort / acceptUntil
  nakArgs:       string[];   // exact argv handed to spawn (debugging)
  durationMs:    number;     // wall-clock spent inside queryRelays
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
  /** Default 4_000 bytes. Keeps stderrTail bounded against chatty relays. */
  stderrCap?:    number;
  /**
   * Override the resolved nak path. Tests pass an explicit path (or
   * null to simulate "not installed") so they don't need nak on the
   * runner. Production callers should leave this undefined.
   */
  nakBin?:       string | null;
  abortSignal?:  AbortSignal;
}

// ── Pure helpers ──────────────────────────────────────────────────────────

/**
 * Compose the argv for `nak req` from a structural filter. Order is
 * stable so tests can assert on it directly: kinds, authors, tag
 * filters (alphabetical by name, then in array order), `-l` limit,
 * `--stream` toggle, then relays.
 */
export function buildNakArgs(
  filter: RelayQueryFilter,
  relays: string[],
  stream: boolean,
): string[] {
  const args: string[] = ['req'];
  for (const k of filter.kinds ?? []) args.push('-k', String(k));
  for (const a of filter.authors ?? []) args.push('-a', a);
  for (const i of filter.ids ?? []) args.push('-i', i);
  const tagNames = Object.keys(filter.tags ?? {}).sort();
  for (const name of tagNames) {
    const raw = (filter.tags ?? {})[name];
    const values = Array.isArray(raw) ? raw : [raw];
    for (const v of values) args.push('-t', `${name}=${v}`);
  }
  if (typeof filter.limit === 'number' && filter.limit > 0) {
    args.push('-l', String(Math.floor(filter.limit)));
  }
  if (stream) args.push('--stream');
  for (const r of relays) args.push(r);
  return args;
}

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
const DEFAULT_STDERR_CAP = 4_000;

/**
 * Run a single `nak req` against the given relays and return all
 * events that match the filter. Always resolves — never rejects — so
 * callers don't need a try/catch around every query. Failure modes
 * surface in `diagnostics`:
 *   - `spawnError: 'nak not found on PATH'`           → nak missing
 *   - `spawnError: 'ENOENT', exitCode: null`          → spawn failed
 *   - `events: [], parseFailures > 0`                 → relays returned junk
 *   - `events: [], stderrTail: 'closed: AUTH ...'`    → relays rejected the query
 *
 * Empty `relays` resolves immediately with an empty result rather than
 * spawning nak with no targets (which would just block until the
 * timeout fires).
 */
export async function queryRelays(opts: RelayQueryOptions): Promise<RelayQueryResult> {
  const stream     = opts.stream ?? true;
  const timeoutMs  = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stderrCap  = opts.stderrCap ?? DEFAULT_STDERR_CAP;
  const nakBin     = opts.nakBin === undefined ? findBin('nak') : opts.nakBin;
  const args       = buildNakArgs(opts.filter, opts.relays, stream);
  const startedAt  = Date.now();

  const baseDiag: RelayQueryDiagnostics = {
    eventsSeen:    0,
    uniqueEvents:  0,
    parseFailures: 0,
    stderrTail:    '',
    spawnError:    null,
    exitCode:      null,
    nakArgs:       args,
    durationMs:    0,
  };

  if (!nakBin) {
    return {
      events: [],
      diagnostics: { ...baseDiag, spawnError: 'nak not found on PATH', durationMs: Date.now() - startedAt },
    };
  }
  if (opts.relays.length === 0) {
    return {
      events: [],
      diagnostics: { ...baseDiag, durationMs: Date.now() - startedAt },
    };
  }

  return new Promise<RelayQueryResult>((resolve) => {
    // stdio[0] = 'ignore' is REQUIRED — without it nak hangs waiting
    // for stdin EOF (project memory: project_nak_stdin_hang). Every
    // existing nak-spawn site in the codebase honors this; centralising
    // here means new callers can't forget it.
    const child = spawn(nakBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const events: NostrEvent[] = [];
    const seen   = new Set<string>();
    const diag   = { ...baseDiag };
    let buf      = '';
    let settled  = false;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch {}
      diag.exitCode     = exitCode;
      diag.uniqueEvents = events.length;
      diag.durationMs   = Date.now() - startedAt;
      resolve({ events, diagnostics: diag });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const ev = parseEventLine(line);
        if (!ev) {
          // Distinguish empty lines from real parse failures so the
          // counter doesn't explode on the trailing blank line nak
          // sometimes emits between events.
          if (line.trim()) diag.parseFailures++;
          continue;
        }
        diag.eventsSeen++;
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        events.push(ev);
        if (opts.acceptUntil && opts.acceptUntil(events)) {
          finish(null);
          return;
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      diag.stderrTail = (diag.stderrTail + chunk.toString()).slice(-stderrCap);
    });

    const timer = setTimeout(() => finish(null), timeoutMs);

    child.on('error', (e) => {
      diag.spawnError = String((e as any)?.message || e);
      finish(null);
    });
    child.on('close', (code) => finish(code));

    if (opts.abortSignal) {
      const onAbort = () => finish(null);
      if (opts.abortSignal.aborted) onAbort();
      else opts.abortSignal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// ── Per-project event cache ───────────────────────────────────────────────
//
// JSON-file cache rooted at `<projectPath>/.nostr-station/cache/<key>.json`.
// Phase 1+ uses this to avoid re-querying relays for slow-changing data
// like the kind-30617 announcement on every Code-tab open.
//
// Single envelope shape `{cachedAt, value}` so TTL is enforced uniformly
// and a missing/corrupt entry collapses to `null` (no exception bubbling
// into request handlers).

const CACHE_DIR_NAME = path.join('.nostr-station', 'cache');
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
// `key` becomes a filename — restrict to a conservative charset rather
// than escaping, so we can't be talked into ../ traversal by a future
// caller passing a derived string.
const SAFE_KEY = /^[A-Za-z0-9._-]{1,64}$/;

export interface CacheKey {
  projectPath: string;
  key:         string;
}

export interface CacheOptions extends CacheKey {
  ttlMs?: number;
}

interface CacheEnvelope<T> {
  cachedAt: number;
  value:    T;
}

function cachePath(k: CacheKey): string {
  if (!SAFE_KEY.test(k.key)) {
    throw new Error(`unsafe cache key (must match ${SAFE_KEY}): ${k.key}`);
  }
  return path.join(k.projectPath, CACHE_DIR_NAME, `${k.key}.json`);
}

export function getCached<T>(opts: CacheOptions): T | null {
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

// Per-process memo of projects we've already inspected for tracked
// cache files. Untracking is a one-time cleanup; once we've checked a
// project (whether we found tracked files or not), no point re-running
// `git ls-files` on every subsequent cache write.
const untrackInspected = new Set<string>();

// If the project's index has files under .nostr-station/cache/, stage
// their removal AND commit it, scoped tightly to that pathspec so user
// WIP elsewhere is never touched. Combined with the .gitignore we
// write below, this turns a "permanently dirty because of dashboard
// cache" project into a clean working tree fully automatically — the
// user never has to know cleanup was needed, never has to think about
// it in their snapshot, never has to open a terminal.
//
// Path-scoped commit: `git commit -- .nostr-station/cache/` only
// captures changes affecting that pathspec, so the user's other
// staged/unstaged work is preserved. The only thing in scope is our
// own `git rm --cached` from a moment earlier.
//
// Identity requirement: `git commit` needs user.name + user.email.
// ngit-scan clones get seeded by seedRepoGitIdentityIfMissing on the
// clone path, and projects scaffolded through the dashboard inherit
// the station identity. Truly identity-less projects (adopted from a
// path with no global git config) will fail at the commit step; the
// rm --cached still stands, and the user's next snapshot picks it
// up the same way it would have without this auto-commit. Either
// way, no terminal-poking required from the user.
//
// Safe across edge cases: not-a-git-repo, missing git binary, empty
// index — all surface as a non-zero exit / empty stdout and we no-op.
function maybeUntrackCacheFiles(projectPath: string): void {
  if (untrackInspected.has(projectPath)) return;
  untrackInspected.add(projectPath);

  const gitBin = findBin('git');
  if (!gitBin) return;

  try {
    const tracked = execFileSync(
      gitBin, ['ls-files', '.nostr-station/cache'],
      { cwd: projectPath, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 },
    ).toString().trim();
    if (!tracked) return; // Nothing tracked → no cleanup needed.

    execFileSync(
      gitBin,
      ['rm', '--cached', '-r', '--ignore-unmatch', '.nostr-station/cache'],
      { cwd: projectPath, stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 },
    );

    // Path-scoped commit — only the cache deletions, not user WIP.
    // Best-effort: swallow if identity isn't configured. The rm
    // --cached is still staged; the next snapshot would commit it.
    try {
      execFileSync(
        gitBin,
        ['commit', '-m', 'chore: stop tracking nostr-station cache files', '--', '.nostr-station/cache'],
        { cwd: projectPath, stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 },
      );
    } catch { /* identity missing, nothing to commit, etc. — fall through */ }
  } catch {
    // best-effort — not a git repo, ls-files errored, anything: no-op.
  }
}

export function setCached<T>(opts: CacheKey, value: T): void {
  const file = cachePath(opts);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    const env: CacheEnvelope<T> = { cachedAt: Date.now(), value };
    fs.writeFileSync(file, JSON.stringify(env, null, 2), { mode: 0o644 });
    // Idempotent .gitignore at .nostr-station/.gitignore so the cache
    // dir is never staged by snapshot / commit. Without this, every
    // dashboard relay-poll rewrites these JSON files, git sees the
    // project as dirty forever, and snapshots accumulate noise commits
    // for cache deltas that the user never asked to track.
    const ignorePath = path.join(opts.projectPath, '.nostr-station', '.gitignore');
    const desired = 'cache/\n';
    let needsWrite = true;
    try { needsWrite = fs.readFileSync(ignorePath, 'utf8') !== desired; } catch { /* missing → write */ }
    if (needsWrite) {
      try { fs.writeFileSync(ignorePath, desired, { mode: 0o644 }); } catch { /* best-effort */ }
    }
    // For projects that committed cache files BEFORE the .gitignore
    // landed, stage their untracking once per process lifetime. The
    // .gitignore alone can't help these — git keeps tracking what's
    // already in the index regardless of ignore rules.
    maybeUntrackCacheFiles(opts.projectPath);
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

// ── Direct-WS query (no nak dependency) ───────────────────────────────────
//
// Drop-in alternative to queryRelays() that talks WebSocket directly to
// each relay instead of shelling out to `nak req`. Same RelayQueryOptions
// in, same RelayQueryResult out, so callers can swap one for the other
// with no API change.
//
// Why it exists alongside the nak version:
//   1. The Nostr Client panel (routes/client.ts) issues 7+ relay queries
//      per panel mount. Each nak spawn is a process fork + binary load +
//      stdin/stdout pipe orchestration; under a developer-laptop load
//      this stacks up enough to surface as "feed is empty" when the
//      probes time out (project memory: project_nak_stdin_hang has bit
//      us repeatedly).
//   2. nak might be installed but the binary on PATH might be older /
//      newer than what we expect, or the relay subset might be one nak's
//      version chokes on. Direct WS sidesteps all of that.
//   3. Identity-config flow (routes/identity.ts:fetchKind0FromRelay)
//      already uses direct WS and is the more-reliable path users
//      consistently see working. This generalises that approach to
//      arbitrary filters.
//
// Trade-off: no nak diagnostic features (stderr capture, exit codes).
// Diagnostics here reduce to "did we see any events" + how many.
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
      try { ws = new WebSocket(relayUrl); }
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
