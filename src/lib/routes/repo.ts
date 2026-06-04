/**
 * Repo routes — Phase 1a of the ngit-suite expansion.
 *
 * Per-project read-only views of the local git checkout AND the
 * project's NIP-34 repo announcement. Drives the new "Code" tab in
 * the project detail view (Phase 1c) and the first-publish flow
 * (Phase 1d).
 *
 * Surface (all GET, all JSON):
 *   GET /api/projects/:id/publish-state    — local-only vs published
 *                                            + suggested defaults for
 *                                            the first-publish form
 *   GET /api/projects/:id/repo             — parsed kind-30617
 *                                            announcement (or null
 *                                            for local-only)
 *   GET /api/projects/:id/repo/refs        — branches, tags, HEAD
 *   GET /api/projects/:id/repo/tree?ref=&path=
 *   GET /api/projects/:id/repo/blob?ref=&path=
 *   GET /api/projects/:id/repo/log?ref=&limit=&skip=
 *   GET /api/projects/:id/repo/readme?ref=
 *
 * Security model:
 *   - All git invocations go through `execFile` with a fixed argv —
 *     no shell.
 *   - `ref` / `path` query params validated against deliberately
 *     conservative regexes (see `isSafeRef` / `isSafePath`). The
 *     parser is paranoid enough that `git cat-file -p ref:path` can
 *     never see a leading-dash argument or a `..` segment.
 *   - Blob output is capped at MAX_BLOB_BYTES; oversize / binary
 *     content is returned with `truncated: true` instead of streaming
 *     megabytes through JSON.
 *   - 30617 query goes through Phase 0's `queryRelays` helper, which
 *     enforces stdio[0]='ignore' (project_nak_stdin_hang) and a
 *     timeout for any --stream query.
 *
 * Caching:
 *   - 30617 results cached at `<projectPath>/.nostr-station/cache/
 *     repo-30617.json` with a 1 h TTL. Pass `?refresh=1` to bypass.
 *   - Tree/blob/log are NOT cached — they're cheap local-git calls
 *     and the user expects them to reflect the current checkout.
 */
import http from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { nip19 } from 'nostr-tools';
import { CLIENT_TAG, CLIENT_NAME, isCanonicalClientTag, isStaleNostrStationClientTag } from '../client-tag.js';
import { WebSocket } from 'ws';
import { getProject, type Project } from '../projects.js';
import { MAX_WS_PAYLOAD } from '../ws-limits.js';
import { findBin } from '../detect.js';
import { isValidRelayUrl, getGraspServers, getEffectiveReadRelays, readIdentity } from '../identity.js';
import { safeHttpUrl } from '../url-safety.js';
import {
  queryRelaysDirect as queryRelays,
  getCached,
  setCached,
  clearCache,
  getTagValue,
  getTags,
  type NostrEvent,
} from '../nostr-query.js';
import { resolveMaintainerSet, type MaintainerSet } from '../maintainer-set.js';
import { signEventWithSavedBunker } from '../auth-bunker.js';
import { readBody } from './_shared.js';

const execFileAsync = promisify(execFile);

// ── Tunables ─────────────────────────────────────────────────────────────

const MAX_BLOB_BYTES   = 2 * 1024 * 1024;   // 2 MB hard cap on blob content payloads
const MAX_LOG_LIMIT    = 100;
const DEFAULT_LOG_LIMIT = 20;
const MAX_LOG_SKIP     = 10_000;
const REPO_CACHE_TTL_MS = 60 * 60 * 1000;
const RELAY_QUERY_TIMEOUT_MS = 8_000;
// README candidates probed in order. Most-common modern conventions
// first; the bare uppercase fallback covers older repos that pre-date
// the README.md convention. Case variants matter — git is case-
// sensitive on Linux/CI.
const README_CANDIDATES = [
  'README.md', 'readme.md', 'README.MD',
  'README.rst', 'README.txt', 'README',
  'Readme.md', 'readme', 'README.markdown',
];

// ── Validators (pure — exported for unit tests) ──────────────────────────

/**
 * Allowed shape for a git ref: short branch names, full refnames
 * (`refs/heads/feature/foo`), tag names, and abbreviated SHAs.
 * Excludes leading `-` so the value can never be misread as an option.
 */
export function isSafeRef(ref: string): boolean {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 255) return false;
  if (ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/')) return false;
  if (ref.includes('..') || ref.includes('//')) return false;
  return /^[A-Za-z0-9._\/-]+$/.test(ref);
}

/**
 * Allowed shape for a path inside the repo. Empty string → repo root.
 * Rejects absolute paths, leading `-`, and any `..` segment.
 */
export function isSafePath(p: string): boolean {
  if (typeof p !== 'string') return false;
  if (p.length > 1024) return false;
  if (p === '') return true;
  if (p.startsWith('/') || p.startsWith('-')) return false;
  if (p.includes('\0')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

/**
 * Detect binary content via a null-byte scan on the first 8 kB. Same
 * heuristic git itself uses to decide whether `git diff` should treat
 * a file as binary. Cheap and effective for source-vs-binary
 * classification — false positives only on contrived UTF-16 etc.,
 * which we never expect to render in the Code tab anyway.
 */
export function isLikelyBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8000);
  for (let i = 0; i < limit; i++) if (buf[i] === 0) return true;
  return false;
}

// ── 30617 metadata extraction (pure — exported for tests) ────────────────

export interface RepoMeta {
  coordinate:  string;        // 30617:<pubkey>:<identifier>
  pubkey:      string;
  identifier:  string;
  name:        string;
  description: string;
  web:         string[];
  clone:       string[];
  relays:      string[];
  maintainers: string[];      // hex pubkeys; Phase 5 will verify the trust chain
  hashtags:    string[];
  euc:         string | null;
  publishedAt: number;
}

export function parseRepoAnnouncement(event: NostrEvent): RepoMeta {
  const identifier = getTagValue(event, 'd') ?? '';
  // `web` and `clone` tags repeat per URL; allowlist `web` to http(s)
  // because the dashboard renders them as <a href> targets and a
  // relay-authored javascript: tag would otherwise ride straight in.
  // `clone` URLs are not auto-followed in the UI so we keep them raw.
  const web = getTags(event, 'web')
    .flatMap((t) => t.slice(1).filter((v): v is string => typeof v === 'string'))
    .map((u) => safeHttpUrl(u))
    .filter((u): u is string => typeof u === 'string' && u.length > 0);
  const clone = getTags(event, 'clone')
    .flatMap((t) => t.slice(1).filter((v): v is string => typeof v === 'string' && v.length > 0));
  const relays = getTags(event, 'relays')
    .flatMap((t) => t.slice(1).filter((v): v is string => typeof v === 'string' && v.length > 0));
  const rawMaintainers = getTags(event, 'maintainers')
    .flatMap((t) => t.slice(1).filter((v): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)));
  // Announcing pubkey is always the canonical FIRST entry — they signed
  // this event under their own coordinate so they're trivially trusted
  // and serve as the trust anchor for Phase 5's maintainer-set walk.
  // De-duped move-to-front: drop any explicit listing of the announcer
  // from the tail before prepending so they appear exactly once.
  const maintainers = [
    event.pubkey,
    ...rawMaintainers.filter((p, i, arr) => p !== event.pubkey && arr.indexOf(p) === i),
  ];
  const hashtags = getTags(event, 't')
    .flatMap((t) => t.slice(1).filter((v): v is string => typeof v === 'string' && v.length > 0))
    .filter((v) => v.length <= 64);
  // EUC marker: ["r", "<commit-id>", "euc"]. Find the first `r` tag
  // whose third element is "euc" — older 30617s sometimes lack the
  // marker entirely.
  let euc: string | null = null;
  for (const t of getTags(event, 'r')) {
    if (t[2] === 'euc' && typeof t[1] === 'string') { euc = t[1]; break; }
  }
  return {
    coordinate:  `30617:${event.pubkey}:${identifier}`,
    pubkey:      event.pubkey,
    identifier,
    name:        getTagValue(event, 'name') ?? identifier,
    description: getTagValue(event, 'description') ?? '',
    web,
    clone,
    relays,
    maintainers,
    hashtags,
    euc,
    publishedAt: event.created_at,
  };
}

// ── Project → ngit coordinates resolver ──────────────────────────────────

interface RepoCoords {
  pubkey:    string;          // hex
  identifier: string;         // d-tag
  relayHints: string[];
}

/**
 * Decode the project's stored ngit remote into (pubkey, d-tag) plus
 * any embedded relay hints. Returns null when the project has no
 * ngit remote or the value can't be decoded — that's the local-only /
 * unpublished state.
 */
export function decodeNgitRemote(project: Project): RepoCoords | null {
  const remote = project.remotes?.ngit ?? '';
  if (!remote) return null;
  if (remote.startsWith('naddr1')) {
    try {
      const decoded = nip19.decode(remote);
      if (decoded.type !== 'naddr' || decoded.data.kind !== 30617) return null;
      return {
        pubkey:     decoded.data.pubkey,
        identifier: decoded.data.identifier,
        relayHints: Array.isArray(decoded.data.relays) ? decoded.data.relays : [],
      };
    } catch { return null; }
  }
  if (remote.startsWith('nostr://')) {
    // ngit's nostr remote is `nostr://<npub>[/<relay-host>…]/<d-tag>` — the
    // d-tag is the FINAL path segment; any segments BETWEEN the npub and it
    // are embedded relay hints (the GRASP host the repo lives on). Taking
    // the whole post-npub path as the d-tag is wrong: for a 3-part remote
    // it yields `relay.ngit.dev/<repo>` instead of `<repo>`, forking every
    // lookup (and re-announce) onto a phantom coordinate — the exact bug
    // that produced a duplicate repo on gitworkshop. NIP-05 npub-or-nip05
    // forms aside, accept only the npub form (NIP-05 would need a fetch).
    const m = remote.match(/^nostr:\/\/(npub1[0-9a-z]+)\/(.+)$/);
    if (!m) return null;
    try {
      const d = nip19.decode(m[1]);
      if (d.type !== 'npub' || typeof d.data !== 'string') return null;
      const segs = m[2].split('/').filter(Boolean);
      if (segs.length === 0) return null;
      const identifier = segs[segs.length - 1];
      const relayHints = segs.slice(0, -1).map(h => `wss://${h.replace(/^wss?:\/\//, '')}`);
      return { pubkey: d.data, identifier, relayHints };
    } catch { return null; }
  }
  return null;
}

/**
 * Build an ngit `nostr://` remote URL. ngit's canonical remote is the
 * 3-part `nostr://<npub>/<relay-host>/<d-tag>` form (the relay/GRASP host
 * is what populates coords.relayHints on the read side). When we know a
 * relay host (from naddr hints on import, or the announcement's relays),
 * emit that full form so a re-clone/import doesn't store the bare
 * `nostr://<npub>/<d-tag>` — which zeroes relayHints and helps strand the
 * Overview read (Bug 1/Bug 4). Falls back to the 2-part form when no
 * host is known. `relayHints` may carry a `wss://` scheme which is
 * stripped — the remote path segment is a bare host.
 *
 * Pure; exported for tests.
 */
export function buildNgitRemoteUrl(npub: string, dTag: string, relayHints: string[] = []): string {
  const host = (relayHints.find((h) => typeof h === 'string' && h.trim()) || '')
    .trim()
    .replace(/^wss?:\/\//i, '')
    .replace(/\/+$/, '');
  return host ? `nostr://${npub}/${host}/${dTag}` : `nostr://${npub}/${dTag}`;
}

// ── Git invocation helpers ───────────────────────────────────────────────

async function gitRun(cwd: string, args: string[], timeoutMs = 5000): Promise<string> {
  const gitBin = findBin('git');
  if (!gitBin) throw new Error('git not found on PATH');
  const { stdout } = await execFileAsync(gitBin, args, {
    cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function gitRunBuffer(cwd: string, args: string[], timeoutMs = 5000): Promise<Buffer> {
  const gitBin = findBin('git');
  if (!gitBin) throw new Error('git not found on PATH');
  const { stdout } = await execFileAsync(gitBin, args, {
    cwd, timeout: timeoutMs, maxBuffer: MAX_BLOB_BYTES + 1024,
    encoding: 'buffer' as const,
  });
  return stdout as unknown as Buffer;
}

// ── publish-state ────────────────────────────────────────────────────────

/** The default-on, REMOVABLE discovery topic nostr-station-published repos
 *  carry (mirrors shakespeare.diy's t=shakespeare/mkstack). Lives in the
 *  form-default layer ONLY — buildRepoAnnounceTemplate never injects it — so a
 *  user who deletes the chip keeps it deleted on re-announce. */
export const STATION_TOPIC = 'nostr-station';

/** First-publish hashtag defaults: package.json-derived keywords plus the
 *  STATION_TOPIC, deduped so a project whose keywords already list it isn't
 *  doubled. */
export function computeSuggestedHashtags(pkgKeywords: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of [...pkgKeywords, STATION_TOPIC]) {
    if (typeof k !== 'string') continue;
    const v = k.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** Announce-form "Other relays" default — the user's effective read/App
 *  relays minus the GRASP servers (which are advertised separately). Deduped,
 *  valid wss/ws only. Pre-fills the field so the written `relays` tag
 *  advertises where the event is actually published (GRASP + App Relays),
 *  not just GRASP. */
export function computeSuggestedOtherRelays(appRelays: string[], grasp: string[]): string[] {
  const graspSet = new Set(grasp.filter(isValidRelayUrl));
  return appRelays
    .filter(isValidRelayUrl)
    .filter((r) => !graspSet.has(r))
    .filter((r, i, a) => a.indexOf(r) === i);
}

async function readPublishState(project: Project): Promise<any> {
  const pPath = project.path;
  const isGitRepo = !!pPath && fs.existsSync(path.join(pPath, '.git'));
  const ngitRemote = project.remotes?.ngit ?? null;
  // Detected defaults for the first-publish form. `package.json` is the
  // dominant convention in shakespeare/stacks projects, so we lean on
  // its `name`, `description`, and `keywords` fields when present.
  let detectedName        = project.name;
  let detectedDescription = '';
  let pkgKeywords: string[] = [];
  if (pPath) {
    const pkgPath = path.join(pPath, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (typeof pkg.name === 'string' && pkg.name.trim()) {
        // Strip npm scope (`@user/foo` → `foo`) — ngit `d` tags are
        // unscoped slugs by convention.
        detectedName = pkg.name.replace(/^@[^/]+\//, '').trim();
      }
      if (typeof pkg.description === 'string') {
        detectedDescription = pkg.description.trim().slice(0, 280);
      }
      if (Array.isArray(pkg.keywords)) {
        pkgKeywords = pkg.keywords
          .filter((k: any): k is string => typeof k === 'string' && /^[a-z0-9-]{1,32}$/i.test(k))
          .slice(0, 8);
      }
    } catch { /* no package.json — fall back to project.name */ }
  }
  // Default the Topics field to the package keywords + the removable
  // STATION_TOPIC so nostr-station-published repos are discoverable via
  // #nostr-station out of the box (editable; never re-injected server-side).
  const suggestedHashtags = computeSuggestedHashtags(pkgKeywords);
  let detectedBranch = 'main';
  let hasOrigin = false;
  let originUrl: string | null = null;
  if (isGitRepo && pPath) {
    try {
      detectedBranch = (await gitRun(pPath, ['symbolic-ref', '--short', 'HEAD'])).trim() || 'main';
    } catch { /* detached HEAD or empty repo — keep 'main' */ }
    try {
      originUrl = (await gitRun(pPath, ['remote', 'get-url', 'origin'])).trim() || null;
      hasOrigin = !!originUrl;
    } catch { /* no origin */ }
  }
  const grasp = getGraspServers().filter(isValidRelayUrl);
  // Singular kept for back-compat; plural is the full Config-panel grasp
  // list so the publish wizard can inherit ALL configured servers (a repo
  // announced to multiple grasp servers gets redundancy + wider discovery)
  // rather than just the first one.
  const suggestedGraspServer  = grasp[0] ?? 'wss://relay.ngit.dev';
  const suggestedGraspServers = grasp.length ? grasp : ['wss://relay.ngit.dev'];
  // "Other relays" default = the user's App/read relays minus GRASP. Combined
  // with the grasp default this makes the form's relay fields advertise the
  // full publish set (GRASP ∪ App Relays) by default — matching where the
  // event is actually pushed (handleAnnounce publishes to both).
  const suggestedOtherRelays = computeSuggestedOtherRelays(getEffectiveReadRelays(), grasp);

  // State derivation:
  //   published       → has an ngit remote (we can compute coordinates)
  //   local-only      → everything else (no `nostr.repo`, no `nostr://` origin)
  // The "pending-first-push" sub-state is detectable but not surfaced
  // in 1a — Phase 1d will distinguish it once the publish flow exists.
  const status: 'published' | 'local-only' = ngitRemote ? 'published' : 'local-only';

  return {
    status,
    isGitRepo,
    hasOrigin,
    originUrl,
    ngitRemote,
    detectedName,
    detectedDescription,
    detectedBranch,
    suggestedHashtags,
    suggestedGraspServer,
    suggestedGraspServers,
    suggestedOtherRelays,
  };
}

// ── 30617 fetch (cached + diagnostics) ───────────────────────────────────

/**
 * Merge a prioritized `primary` relay list with the user's App Relays into a
 * single deduped, capped set. App Relays get a RESERVED quota (`appReserve`)
 * so a long primary list (relayHints + grasp + projRelays) can never crowd
 * them out past the cap — they're the guaranteed home every announcement
 * publish reaches, so both the read paths and the publish path must always
 * include them. Order: kept-primary, reserved-app, then any leftover app to
 * backfill spare capacity.
 *
 * Single source of truth for "where do 30617 reads/writes go?" — used by
 * fetchRepoMeta (read), the announce prior-fetch (read), and the announce
 * publish targets. Sharing it keeps the three sets on one capping policy and
 * keeps the read set a superset of the publish targets in the relays we
 * actually control (GRASP + App Relays), rather than relying on parallel
 * edits staying in sync. Pure; exported for tests.
 */
export function mergeRelaySet(
  primary:   string[],
  appRelays: string[],
  opts: { cap?: number; appReserve?: number } = {},
): string[] {
  const cap        = opts.cap ?? 12;
  const appReserve = opts.appReserve ?? 6;
  const dedupeValid = (arr: string[]): string[] =>
    arr.filter(isValidRelayUrl).filter((r, i, a) => a.indexOf(r) === i);
  const prim = dedupeValid(primary);
  // App Relays not already present in primary (dedupe across the boundary).
  const app  = dedupeValid(appRelays).filter((r) => !prim.includes(r));
  const appKeep     = app.slice(0, Math.min(app.length, appReserve));
  const primKeep    = prim.slice(0, Math.max(0, cap - appKeep.length));
  const leftoverApp = app.slice(appKeep.length);
  return [...primKeep, ...appKeep, ...leftoverApp].slice(0, cap);
}

/** Injectable relay sources — defaults call the real identity helpers.
 *  Exists so tests can drive fetchRepoMeta against a mock relay without a
 *  populated identity.json on disk. */
export interface RepoMetaDeps {
  getGrasp?:     () => string[];
  getAppRelays?: () => string[];
}

export async function fetchRepoMeta(
  project: Project,
  refresh: boolean,
  deps:    RepoMetaDeps = {},
): Promise<{ repo: RepoMeta | null; cached: boolean; diagnostics: any | null }> {
  const coords = decodeNgitRemote(project);
  if (!coords || !project.path) return { repo: null, cached: false, diagnostics: null };

  const cacheKey = { projectId: project.id, projectPath: project.path, key: 'repo-30617' };
  if (!refresh) {
    const cached = getCached<RepoMeta>({ ...cacheKey, ttlMs: REPO_CACHE_TTL_MS });
    if (cached) return { repo: cached, cached: true, diagnostics: null };
  }

  // Read union: naddr/remote relay hints + GRASP servers + project read
  // relays + the user's App Relays. kind-30617 lives on GRASP servers in
  // practice, but for an ngit project whose remote is the bare
  // `nostr://<npub>/<d-tag>` form (no relay-host segment → empty relayHints)
  // and whose GRASP override is dead, the ONLY place the announcement is
  // reachable is the App Relays it was ALSO published to (handleAnnounce
  // publishes there). mergeRelaySet reserves App-Relay slots so they're
  // never crowded out of the cap — that's what makes a successfully-published
  // announcement readable by our own Overview.
  const grasp      = (deps.getGrasp ?? getGraspServers)();
  const appRelays  = (deps.getAppRelays ?? getEffectiveReadRelays)();
  const projRelays = (project.readRelays || []).filter((r): r is string => typeof r === 'string');
  const relays = mergeRelaySet([...coords.relayHints, ...grasp, ...projRelays], appRelays);

  const result = await queryRelays({
    filter: {
      kinds:   [30617],
      authors: [coords.pubkey],
      tags:    { d: coords.identifier },
      limit:   1,
    },
    relays,
    timeoutMs: RELAY_QUERY_TIMEOUT_MS,
    stream:    false,            // one-shot — we want EOSE termination
    // Short-circuit on the first matching event.
    acceptUntil: (evs) => evs.length >= 1,
  });

  // Pick the freshest (queryRelays already deduplicates by id but
  // multiple relays can return different versions of an addressable
  // event — keep the latest by created_at).
  let chosen: NostrEvent | null = null;
  for (const ev of result.events) {
    if (ev.kind !== 30617) continue;
    if (!chosen || ev.created_at > chosen.created_at) chosen = ev;
  }
  if (!chosen) return { repo: null, cached: false, diagnostics: result.diagnostics };

  const meta = parseRepoAnnouncement(chosen);
  setCached<RepoMeta>(cacheKey, meta);
  return { repo: meta, cached: false, diagnostics: result.diagnostics };
}

// ── refs ─────────────────────────────────────────────────────────────────

async function readRefs(project: Project): Promise<any> {
  if (!project.path) return { head: '', branches: [], tags: [] };
  let head = '';
  try {
    head = (await gitRun(project.path, ['symbolic-ref', '--short', 'HEAD'])).trim();
  } catch {
    // Detached HEAD — surface the literal token git uses.
    try {
      head = '(' + (await gitRun(project.path, ['rev-parse', '--short', 'HEAD'])).trim() + ')';
    } catch { head = ''; }
  }
  // `for-each-ref` with NUL-separated fields handles ref names with
  // unusual characters cleanly. Pin to refs/heads + refs/tags so we
  // don't surface remote-tracking refs (`origin/main`) twice.
  const fmt = '%(refname:short)%00%(objectname)';
  const parse = (out: string) => out.split('\n').filter(Boolean).map((line) => {
    const [name, sha] = line.split('\0');
    return { name: name || '', sha: sha || '' };
  });
  let branches: { name: string; sha: string }[] = [];
  let tags:     { name: string; sha: string }[] = [];
  try {
    branches = parse(await gitRun(project.path, ['for-each-ref', `--format=${fmt}`, 'refs/heads']));
  } catch {}
  try {
    tags = parse(await gitRun(project.path, ['for-each-ref', `--format=${fmt}`, 'refs/tags']));
  } catch {}
  return { head, branches, tags };
}

// ── tree ─────────────────────────────────────────────────────────────────

async function readTree(
  project: Project, ref: string, treePath: string, withLog: boolean,
): Promise<any> {
  if (!project.path) return { ref, path: treePath, entries: [] };
  // `git ls-tree -l <ref> <path>/` lists one level. Trailing slash is
  // important: without it you'd get just the entry FOR the path.
  // `-z` gives NUL terminators so filenames with spaces/newlines parse
  // safely.
  //
  // CRITICAL: when treePath is empty (= root) we must NOT append an
  // empty-string argument. `git ls-tree HEAD ""` errors with
  //   fatal: empty string is not a valid pathspec...
  // whereas `git ls-tree HEAD` lists the root tree correctly.
  const target = treePath ? `${treePath}/` : '';
  const args = target
    ? ['ls-tree', '-l', '-z', `${ref}`, target]
    : ['ls-tree', '-l', '-z', `${ref}`];
  let raw: string;
  try {
    raw = await gitRun(project.path, args);
  } catch (e: any) {
    return { ref, path: treePath, entries: [], error: extractGitError(e) };
  }
  // ls-tree -l format per record:
  //   <mode> SP <type> SP <sha> SP <size> TAB <name> NUL
  //   trees show "-" in the size column.
  const entries: any[] = [];
  for (const record of raw.split('\0')) {
    if (!record) continue;
    const tabIdx = record.indexOf('\t');
    if (tabIdx === -1) continue;
    const meta = record.slice(0, tabIdx).split(/\s+/);
    const fullName = record.slice(tabIdx + 1);
    if (meta.length < 4) continue;
    const [mode, type, sha, sizeStr] = meta;
    // Strip the leading directory portion so the UI gets just the
    // basename; the breadcrumb already conveys the parent.
    const baseName = fullName.startsWith(target) ? fullName.slice(target.length) : fullName;
    entries.push({
      name: baseName,
      type: type as 'blob' | 'tree' | 'commit',
      mode,
      sha,
      size: sizeStr === '-' ? null : Number(sizeStr),
    });
  }
  // Trees first, then alphabetical — matches every git host's
  // convention (gitworkshop, github, gitea).
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'tree' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // Phase 7: per-entry last-commit info. Bounded ONE `git log` over
  // recent history (200 commits at this path) — much cheaper than
  // one spawn per entry. The walk parses interleaved commit headers
  // and changed-file lists, building a path → first-seen-commit map.
  // Entries whose subtree appears in that history get a lastCommit;
  // older / never-touched entries return null lastCommit and the
  // client renders a blank cell.
  if (withLog) {
    try {
      const logOut = await gitRun(project.path, [
        'log',
        '-n', '200',
        '--name-only',
        '--pretty=format:NS_COMMIT\x00%H\x00%h\x00%at\x00%s',
        ref,
        '--', target || '.',
      ], 8000);
      const fileToCommit = parseLogForLastCommits(logOut);
      for (const e of entries) {
        // Match by entry's absolute repo-path; for trees, ANY file
        // under that subdir counts (we look for the first commit
        // that touches a file with the entry prefix).
        const prefix = target + e.name + (e.type === 'tree' ? '/' : '');
        const found = lookupLastCommit(fileToCommit, prefix, e.type === 'tree');
        if (found) e.lastCommit = found;
      }
    } catch { /* lastCommit annotation is best-effort */ }
  }
  return { ref, path: treePath, entries };
}

interface CommitMeta {
  sha:       string;
  abbrev:    string;
  timestamp: number;
  subject:   string;
}

/**
 * Parse `git log --name-only --pretty=format:'NS_COMMIT\x00…'` output
 * into a Map<filepath, firstCommitInHistory>. Because log iterates
 * newest-first, the FIRST time we see a path is its most recent
 * touch — that's what we record.
 */
function parseLogForLastCommits(out: string): Map<string, CommitMeta> {
  const map = new Map<string, CommitMeta>();
  let cur: CommitMeta | null = null;
  for (const rawLine of out.split('\n')) {
    const line = rawLine;
    if (!line) continue;
    if (line.startsWith('NS_COMMIT\x00')) {
      const parts = line.split('\x00');
      // parts[0] = "NS_COMMIT", parts[1..] = sha/abbrev/ts/subject
      if (parts.length < 5) { cur = null; continue; }
      cur = {
        sha:       parts[1],
        abbrev:    parts[2],
        timestamp: Number(parts[3]) || 0,
        subject:   parts[4],
      };
      continue;
    }
    if (cur && !map.has(line)) map.set(line, cur);
  }
  return map;
}

function lookupLastCommit(
  map: Map<string, CommitMeta>, prefix: string, isTree: boolean,
): CommitMeta | null {
  if (!isTree) return map.get(prefix) || null;
  // For trees, find ANY file whose path starts with the prefix and
  // return its commit. The map's iteration order is insertion order
  // (most recent first), so the first matching prefix is correct.
  for (const [filePath, meta] of map) {
    if (filePath.startsWith(prefix)) return meta;
  }
  return null;
}

// ── blob ────────────────────────────────────────────────────────────────

async function readBlob(project: Project, ref: string, blobPath: string): Promise<any> {
  if (!project.path) return { ref, path: blobPath, error: 'project has no local path' };
  // `cat-file -s ref:path` returns just the size — use it as a guard
  // before pulling the content so we never load a 200 MB binary into
  // memory just to truncate it.
  let size = 0;
  try {
    size = parseInt((await gitRun(project.path, ['cat-file', '-s', `${ref}:${blobPath}`])).trim(), 10);
  } catch (e: any) {
    return { ref, path: blobPath, error: extractGitError(e) };
  }
  if (!Number.isFinite(size)) size = 0;
  // For oversize blobs, return metadata only — the UI renders a
  // "Download · N bytes" affordance.
  if (size > MAX_BLOB_BYTES) {
    return {
      ref, path: blobPath, size,
      truncated: true, binary: true, encoding: 'base64', content: '',
    };
  }
  let buf: Buffer;
  try {
    buf = await gitRunBuffer(project.path, ['cat-file', '-p', `${ref}:${blobPath}`]);
  } catch (e: any) {
    return { ref, path: blobPath, error: extractGitError(e) };
  }
  const binary = isLikelyBinary(buf);
  return {
    ref,
    path: blobPath,
    size,
    truncated: false,
    binary,
    encoding: binary ? 'base64' : 'utf8',
    content:  binary ? buf.toString('base64') : buf.toString('utf8'),
  };
}

// ── log ──────────────────────────────────────────────────────────────────

async function readLog(project: Project, ref: string, limit: number, skip: number): Promise<any> {
  if (!project.path) return { ref, commits: [], hasMore: false };
  // Format: <sha>\0<short>\0<author>\0<email>\0<unix-ts>\0<subject>\n
  // NUL between fields keeps the parser robust to subjects with
  // commas/colons/quotes; \n between commits works because the
  // subject excludes its own trailing newline by convention.
  const fmt = '%H%x00%h%x00%an%x00%ae%x00%at%x00%s';
  // Fetch one extra to detect hasMore without a second roundtrip.
  const args = ['log', `--pretty=format:${fmt}`, `--max-count=${limit + 1}`, `--skip=${skip}`, ref];
  let raw: string;
  try {
    raw = await gitRun(project.path, args, 8000);
  } catch (e: any) {
    return { ref, commits: [], hasMore: false, error: extractGitError(e) };
  }
  const lines = raw.split('\n').filter(Boolean);
  const hasMore = lines.length > limit;
  const trimmed = hasMore ? lines.slice(0, limit) : lines;
  const commits = trimmed.map((line) => {
    const [sha, abbrev, author, email, ts, subject] = line.split('\0');
    return {
      sha:       sha       || '',
      abbrev:    abbrev    || '',
      author:    author    || '',
      email:     email     || '',
      timestamp: Number(ts) || 0,
      subject:   subject   || '',
    };
  });
  return { ref, commits, hasMore };
}

// ── readme ───────────────────────────────────────────────────────────────

async function readReadme(project: Project, ref: string): Promise<any> {
  if (!project.path) return { found: false, path: null, content: null, size: null };
  // Try each candidate via cat-file. cheaper than ls-tree + filter +
  // cat-file because we stop on the first hit.
  for (const candidate of README_CANDIDATES) {
    try {
      const sizeOut = await gitRun(project.path, ['cat-file', '-s', `${ref}:${candidate}`]);
      const size = parseInt(sizeOut.trim(), 10);
      if (!Number.isFinite(size) || size <= 0) continue;
      if (size > MAX_BLOB_BYTES) {
        return { found: true, path: candidate, content: null, size, truncated: true };
      }
      const buf = await gitRunBuffer(project.path, ['cat-file', '-p', `${ref}:${candidate}`]);
      if (isLikelyBinary(buf)) continue;   // README that's binary? unlikely — skip
      return { found: true, path: candidate, content: buf.toString('utf8'), size };
    } catch { /* not present at this name — try the next */ }
  }
  return { found: false, path: null, content: null, size: null };
}

// ── error message helper ────────────────────────────────────────────────

// Sets aren't JSON-serialisable; convert to arrays for the wire shape.
// Keep field names identical to MaintainerSet for the parts that are
// already arrays so the consumer doesn't fork its schema by route.
function serialiseMaintainerSet(ms: MaintainerSet): any {
  return {
    verified:       Array.from(ms.verified),
    candidatesOnly: Array.from(ms.candidatesOnly),
    relays:         ms.relays,
    clone:          ms.clone,
    blossoms:       ms.blossoms,
    hashtags:       ms.hashtags,
    display:        ms.display,
    // Raw 30617 events per verified maintainer — drives the
    // Announcement events inspector modal (per-event timestamp,
    // "selected" badge for the display source, raw-JSON viewer).
    events:         ms.events,
  };
}

function extractGitError(e: any): string {
  // execFile attaches stderr to the rejection — surface it (slimmed)
  // so the client gets an actionable message instead of "command failed".
  const stderr = (e?.stderr ?? '').toString().trim();
  const message = (e?.message ?? '').toString().trim();
  return (stderr || message || 'git command failed').slice(0, 240);
}

// ── Announce (Edit Repository) — Phase 3b ─────────────────────────────
//
// POST /api/projects/:id/announce republishes the kind-30617 with the
// user's edits. The reason we build + sign + publish ourselves instead
// of shelling `ngit init` for everything:
//
//   - ngit init covers the standard fields (name, description, web,
//     hashtag, grasp-server, relay, clone, other-maintainers, EUC) but
//     does NOT accept arbitrary custom tags. Custom-tag forward-compat
//     (e.g. `["client", "nostr-station"]`) is a stated requirement.
//   - Building the event ourselves also means a single Amber-sign
//     instead of ngit's multi-step (which would risk a race if we
//     re-published a second time to add custom tags).
//
// The signing path uses the existing signEventWithSavedBunker — same
// Amber pairing the dashboard uses for setup/verify. Publish to the
// union of: announcement's own relay list, user's grasp servers, and
// the user's read-relays. After a successful publish (≥1 relay OK'd)
// we invalidate the cached repo-30617 so the next GET /repo refetches.

interface AnnounceInput {
  identifier:        string;             // d-tag — fixed for a given coordinate
  name?:             string;
  description?:      string;
  web?:              string[];
  clone?:            string[];
  relays?:           string[];           // includes GRASP + other relays — server doesn't split
  blossoms?:         string[];
  hashtags?:         string[];
  maintainers?:      string[];           // OTHER maintainers (hex pubkeys); anchor is auto-added
  euc?:              string | null;      // earliest-unique-commit
  customTags?:       string[][];         // forward-compat ['name', ...vals]; preserved verbatim
  requiredRelays?:   string[];           // in-use GRASP servers ALWAYS advertised in `relays` (guard rail)
}

/** Union the form's relay list with the relays that MUST be advertised
 *  (the in-use GRASP servers) — form order preserved, required relays not
 *  already present appended. Guarantees a published announcement never omits
 *  its grasp (which would break `nostr://` clones) WITHOUT forcing App Relays
 *  back in if the user removed them — only GRASP is guaranteed; App Relays
 *  stay a form-level default. Deduped; pure. */
export function mergeRelaysTagValues(formRelays: string[], required: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of [...formRelays, ...required]) {
    if (typeof r !== 'string') continue;
    const v = r.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Build the unsigned 30617 event template from form input + the prior
 * announcement (used to preserve tags the form doesn't surface, like
 * future tag types nostr-station hasn't learned about yet). Pure — no
 * I/O. Exported for tests.
 *
 * Tag order roughly matches ngit init's output:
 *   d, r euc, name, description, clone…, web…, relays…, t…, maintainers,
 *   alt, blossoms…, then any custom tags (with client=nostr-station
 *   auto-injected if not already present).
 */
export function buildRepoAnnounceTemplate(
  input:        AnnounceInput,
  prior:        NostrEvent | null,
  signerPubkey: string,
): { kind: number; created_at: number; tags: string[][]; content: string } {
  const tags: string[][] = [];
  tags.push(['d', input.identifier]);
  if (input.euc) tags.push(['r', input.euc, 'euc']);
  if (input.name)        tags.push(['name', input.name]);
  if (input.description) tags.push(['description', input.description]);
  // Web/clone/relays/blossoms: single tag with all values (NIP-34 convention).
  if (input.clone?.length) {
    tags.push(['clone', ...input.clone]);
  }
  if (input.web?.length) {
    tags.push(['web', ...input.web]);
  }
  // Always advertise the in-use GRASP servers (requiredRelays) in the
  // `relays` tag — an announcement that omits its grasp can't be cloned via
  // nostr://. Unioned with the form's relays (form first, preserving order
  // AND the user's choice to include/exclude App Relays). We deliberately do
  // NOT force App Relays in here — that's a form-level default only, so a
  // removed App Relay stays removed on re-announce (anti-sticky, same
  // principle as the client tag).
  const relaysTag = mergeRelaysTagValues(input.relays || [], input.requiredRelays || []);
  if (relaysTag.length) {
    tags.push(['relays', ...relaysTag]);
  }
  // Hashtags emit ONE `t` tag per value (matches how relays index them).
  for (const t of input.hashtags || []) {
    if (typeof t === 'string' && t.length > 0 && t.length <= 64) tags.push(['t', t]);
  }
  // Maintainers: only the OTHER ones — the signer is the trust anchor by
  // construction and including their own pubkey here would be redundant.
  const others = (input.maintainers || []).filter(
    (p) => typeof p === 'string' && /^[0-9a-f]{64}$/.test(p) && p !== signerPubkey,
  );
  if (others.length > 0) tags.push(['maintainers', ...others]);
  // Stable display string for clients that don't render the event raw.
  tags.push(['alt', `git repository: ${input.name || input.identifier}`]);
  if (input.blossoms?.length) {
    tags.push(['blossoms', ...input.blossoms]);
  }
  // Custom tags pass through verbatim. We also auto-inject
  // ['client', 'nostr-station'] when no client tag is already set,
  // mirroring how shakespeare.diy / gitworkshop tag their announcements.
  // Don't preserve tag types we already emit above (avoids duplicates).
  const emittedTagNames = new Set(['d', 'r', 'name', 'description', 'clone', 'web', 'relays', 't', 'maintainers', 'alt', 'blossoms']);
  const customs: string[][] = [];
  const seenCustomKey = new Set<string>();
  // (1) form-supplied custom tags first
  for (const t of input.customTags || []) {
    if (!Array.isArray(t) || typeof t[0] !== 'string' || !t[0]) continue;
    if (emittedTagNames.has(t[0])) continue;
    const key = JSON.stringify(t);
    if (seenCustomKey.has(key)) continue;
    seenCustomKey.add(key);
    customs.push(t.map(v => typeof v === 'string' ? v : ''));
  }
  // (2) preserve any unknown-to-us tags from the prior announcement
  if (prior && Array.isArray(prior.tags)) {
    for (const t of prior.tags) {
      if (!Array.isArray(t) || typeof t[0] !== 'string') continue;
      if (emittedTagNames.has(t[0])) continue;
      // Never carry forward OUR OWN stale (bare 2-element) client tag — it's
      // the sticky form that, once published, kept overriding the canonical
      // injection below and so never upgraded to the NIP-89 4-element link.
      // Step (3) re-injects the canonical tag. A DIFFERENT client's tag (e.g.
      // shakespeare.diy / gitworkshop) is still preserved verbatim.
      if (isStaleNostrStationClientTag(t)) continue;
      const key = JSON.stringify(t);
      if (seenCustomKey.has(key)) continue;
      // Only preserve if the form didn't supply the same tag name — form
      // wins. Detected by checking if any customs entry has same name.
      if (customs.some((c) => c[0] === t[0])) continue;
      seenCustomKey.add(key);
      customs.push(t.map(v => typeof v === 'string' ? v : ''));
    }
  }
  // (3) NIP-89 client marker. nostr-station's OWN client tag must always be
  // the canonical 4-element CLIENT_TAG (links the announcement to our
  // kind-31990 handler, same tag the Client panel's kind-1s carry):
  //   - no client tag at all          → inject the canonical tag;
  //   - our tag but not canonical      → REPLACE it with the canonical tag
  //                                      (upgrades a bare ["client",name]);
  //   - a different client's tag       → leave it untouched (forward compat).
  const clientIdx = customs.findIndex((c) => c[0] === 'client');
  if (clientIdx === -1) {
    customs.push([...CLIENT_TAG]);
  } else if (customs[clientIdx][1] === CLIENT_NAME && !isCanonicalClientTag(customs[clientIdx])) {
    customs[clientIdx] = [...CLIENT_TAG];
  }
  for (const c of customs) tags.push(c);

  return {
    kind:       30617,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content:    '',
  };
}

// In-flight announce guard. A single user "Announce" / "Save changes" action
// must produce exactly ONE signed 30617 (it's a replaceable event). Without
// this, a double-click, a client retry, or two near-simultaneous POSTs each
// run their own prior-fetch → sign → publish, and because the prior-fetch can
// race to different carry-through (euc / unknown tags) the resulting events
// get DIFFERENT ids and all survive on relays — the "2–3 30617s at the same
// created_at" symptom. Keyed by coordinate so distinct repos don't block each
// other; a concurrent second request for the same coordinate gets 409.
//
// This guards CONCURRENCY only, by design — a deliberate, sequential
// re-announce is a legitimate replaceable update (relays keep the freshest by
// created_at) and is intentionally NOT deduped here.
const announceInFlight = new Set<string>();

interface RelayPublishResult { relay: string; ok: boolean; reason?: string }

/**
 * Publish a signed event to a set of relays in parallel. Each relay
 * gets a 6s budget; we resolve as soon as an OK / NOTICE comes back
 * (or the timeout fires). Returns per-relay results so the client can
 * show which relays accepted vs. rejected.
 */
export async function publishEventToRelays(
  event:    any,
  relays:   string[],
  timeoutMs: number = 6000,
): Promise<RelayPublishResult[]> {
  const tasks = relays.map((url) => new Promise<RelayPublishResult>((resolve) => {
    let settled = false;
    let ws: WebSocket;
    const finish = (r: RelayPublishResult) => {
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

async function handleAnnounce(
  req:     http.IncomingMessage,
  res:     http.ServerResponse,
  project: Project,
): Promise<boolean> {
  let body: any;
  try { body = JSON.parse(await readBody(req)); }
  catch { return json(res, 400, { error: 'bad json' }); }

  // Resolve coordinate from the existing 30617 — the d-tag identifier
  // is part of the coordinate and must NOT be editable (changing it
  // forks the repo to a new coordinate).
  const coords = decodeNgitRemote(project);
  if (!coords) return json(res, 400, { error: 'project has no ngit remote — cannot announce' });

  // Sanitise input. Strings are trimmed; arrays are filtered to strings
  // of reasonable shape. Anything outside the schema falls through as
  // undefined (so the builder uses its own defaults / preserves).
  const trim = (v: any) => typeof v === 'string' ? v.trim() : undefined;
  const strArr = (v: any): string[] => Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(s => s.trim())
    : [];
  const hexArr = (v: any): string[] => Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x.toLowerCase()))
       .map(s => s.toLowerCase())
    : [];
  const tagArr = (v: any): string[][] => Array.isArray(v)
    ? v.filter((t): t is any[] => Array.isArray(t) && t.length >= 1 && typeof t[0] === 'string' && t[0].length > 0)
       .map(t => t.map((x: any) => typeof x === 'string' ? x : ''))
    : [];

  const input: AnnounceInput = {
    identifier:  coords.identifier,
    name:        trim(body.name),
    description: typeof body.description === 'string' ? body.description : undefined,  // preserve newlines
    web:         strArr(body.web).filter(u => /^https?:\/\//i.test(u)),
    clone:       strArr(body.clone),
    relays:      strArr(body.relays).filter(u => /^wss?:\/\//i.test(u)),
    blossoms:    strArr(body.blossoms).filter(u => /^https?:\/\//i.test(u)),
    hashtags:    strArr(body.hashtags).map(s => s.replace(/^#/, '')),
    maintainers: hexArr(body.maintainers),
    euc:         typeof body.euc === 'string' && /^[0-9a-f]{40}$/.test(body.euc.toLowerCase())
                 ? body.euc.toLowerCase()
                 : null,
    customTags:  tagArr(body.customTags),
    // Guard rail: the in-use GRASP servers are ALWAYS advertised in the
    // `relays` tag (normalized to wss://) so a re-announce can never drop the
    // grasp the repo is hosted on — which would break nostr:// clones.
    requiredRelays: getGraspServers()
      .map(s => /^wss?:\/\//i.test(s) ? s : `wss://${s}`)
      .filter(isValidRelayUrl),
  };

  // Owner-only guard: the signed-in pubkey must equal the trust anchor
  // pubkey for this coordinate (a different pubkey re-publishing 30617
  // under someone else's `d`-tag would just fork the repo, which is
  // never what the Edit form intends).
  const ident = readIdentity();
  let ownerHex = '';
  try { ownerHex = ident.npub ? (nip19.decode(ident.npub).data as string) : ''; }
  catch { ownerHex = ''; }
  if (!ownerHex || ownerHex !== coords.pubkey) {
    return json(res, 403, { error: 'only the trust anchor can edit this announcement' });
  }

  // Idempotency: refuse a concurrent announce for the same coordinate so a
  // single user action can never fan out into multiple 30617s (see
  // announceInFlight above). Released in the finally at the end of the flow.
  const coordKey = `${coords.pubkey}:${coords.identifier}`;
  if (announceInFlight.has(coordKey)) {
    return json(res, 409, { error: 'an announce for this repository is already in progress — please wait for it to finish' });
  }
  announceInFlight.add(coordKey);
  try {

  // Pull the prior raw 30617 so we can carry through any tags the form
  // doesn't surface (forward compat). Direct relay query — fetchRepoMeta
  // caches the parsed shape, not the raw event. Failing to find it is
  // non-fatal: we just lose the carry-through and emit the form's tags
  // as-is.
  // Same read set as fetchRepoMeta (incl. App Relays) so the prior-fetch
  // can't miss an announcement that lives only on App Relays — otherwise the
  // carry-through (euc / unknown tags) would be silently dropped on republish.
  const projRelays = (project.readRelays || []).filter((r): r is string => typeof r === 'string');
  const priorRelays = mergeRelaySet(
    [...coords.relayHints, ...getGraspServers(), ...projRelays],
    getEffectiveReadRelays(),
  );
  let priorEvent: NostrEvent | null = null;
  if (priorRelays.length > 0) {
    try {
      const r = await queryRelays({
        filter: { kinds: [30617], authors: [coords.pubkey], tags: { d: coords.identifier }, limit: 1 },
        relays: priorRelays,
        timeoutMs: RELAY_QUERY_TIMEOUT_MS,
        stream: false,
        acceptUntil: (evs) => evs.length >= 1,
      });
      for (const ev of r.events) {
        if (ev.kind !== 30617) continue;
        if (!priorEvent || ev.created_at > priorEvent.created_at) priorEvent = ev;
      }
    } catch { /* prior fetch failed — proceed without carry-through */ }
  }

  // Recover the EUC (earliest-unique-commit) when the form didn't supply
  // one. The EUC anchors a repo's identity across re-announcements:
  // gitworkshop and other NIP-34 clients GROUP announcements by it, so an
  // announcement missing the `["r", <root-commit>, "euc"]` tag shows up as
  // a SEPARATE repo instead of replacing/merging with the prior one. The
  // resurrection path (deleted announcement → synthRepoPrefill) can't know
  // the EUC client-side and sends none, which is what surfaced as two
  // duplicate repos on gitworkshop. Recover it here:
  //   (1) carry the prior announcement's euc when we found a prior event;
  //   (2) else derive it from the local repo's root commit — the same
  //       value `ngit init` stamps (`git rev-list --max-parents=0`).
  if (!input.euc) {
    if (priorEvent && Array.isArray(priorEvent.tags)) {
      for (const t of priorEvent.tags) {
        if (Array.isArray(t) && t[0] === 'r' && t[2] === 'euc' && typeof t[1] === 'string'
            && /^[0-9a-f]{40}$/.test(t[1].toLowerCase())) {
          input.euc = t[1].toLowerCase();
          break;
        }
      }
    }
    if (!input.euc && project.path) {
      try {
        // A repo can have multiple root commits (merged unrelated
        // histories); rev-list emits newest-first, so the EARLIEST root —
        // the EUC by convention — is last.
        const roots = (await gitRun(project.path, ['rev-list', '--max-parents=0', 'HEAD']))
          .split(/\s+/).map(s => s.trim().toLowerCase()).filter(s => /^[0-9a-f]{40}$/.test(s));
        if (roots.length > 0) input.euc = roots[roots.length - 1];
      } catch { /* no git / detached HEAD — emit without euc */ }
    }
  }

  const template = buildRepoAnnounceTemplate(input, priorEvent, ownerHex);

  // Sign via the persisted Amber pairing.
  const signed = await signEventWithSavedBunker(template, 60_000);
  if (!signed.ok || !signed.signedEvent) {
    return json(res, signed.tried ? 502 : 400, {
      error: signed.error || 'sign failed',
      tried: signed.tried,
    });
  }

  // Publish to the union of: the input's own relay list, the user's grasp
  // servers, AND their App Relays. GRASP relays can reject or drop a plain
  // kind-30617 publish (auth/rate-limit), so with no general public relay
  // in the set, every target could fail → a 502 even though signing
  // succeeded. The App Relays give the event reliable, broadly-queryable
  // homes (damus/nos.lol/primal/…) so discovery works and a grasp rejection
  // isn't fatal. Built with the SAME mergeRelaySet as the read paths so the
  // read set stays a superset of these publish targets (GRASP + App Relays)
  // by construction — and so the App Relays are never crowded out of the cap.
  const publishTargets = mergeRelaySet(
    [...(input.relays || []), ...getGraspServers().map(s => /^wss?:/i.test(s) ? s : `wss://${s}`)],
    getEffectiveReadRelays(),
  );

  const results = publishTargets.length > 0
    ? await publishEventToRelays(signed.signedEvent, publishTargets)
    : [];
  const accepted = results.filter(r => r.ok).length;

  // Invalidate the repo-30617 cache so the next GET /repo refetches.
  // Even if zero relays accepted, the user might be retrying — bust the
  // cache so a stale 30617 doesn't haunt them.
  if (project.path) {
    try { clearCache({ projectId: project.id, projectPath: project.path, key: 'repo-30617' }); } catch {}
  }

  return json(res, accepted > 0 ? 200 : 502, {
    ok:           accepted > 0,
    signedEvent:  signed.signedEvent,
    publish:      results,
    accepted,
    targets:      publishTargets.length,
  });

  } finally {
    announceInFlight.delete(coordKey);
  }
}

// ── Dispatcher ──────────────────────────────────────────────────────────

const REPO_ROUTE = /^\/api\/projects\/([a-f0-9-]{10,})\/(publish-state|repo(?:\/refs|\/tree|\/blob|\/log|\/readme)?)$/;
const ANNOUNCE_ROUTE = /^\/api\/projects\/([a-f0-9-]{10,})\/announce$/;

export async function handleRepo(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  // Strip query string for path matching; `URL` parsing requires a
  // base, so glue one on for parsing-only purposes.
  const u = new URL(url, 'http://localhost');
  // POST /announce — Phase 3b Edit Repository submission.
  if (method === 'POST') {
    const am = u.pathname.match(ANNOUNCE_ROUTE);
    if (!am) return false;
    const project = getProject(am[1]);
    if (!project) return json(res, 404, { error: 'project not found' });
    return handleAnnounce(req, res, project);
  }
  if (method !== 'GET') return false;
  const m = u.pathname.match(REPO_ROUTE);
  if (!m) return false;
  const [, id, sub] = m;
  const project = getProject(id);
  if (!project) {
    return json(res, 404, { error: 'project not found' });
  }

  // Centralised query-param parsing.
  const ref = (u.searchParams.get('ref') || '').trim() || 'HEAD';
  const treePath = (u.searchParams.get('path') || '').trim();
  const refresh = u.searchParams.get('refresh') === '1';
  if (sub !== 'publish-state' && !isSafeRef(ref)) {
    return json(res, 400, { error: 'invalid ref' });
  }
  if ((sub === 'repo/tree' || sub === 'repo/blob') && !isSafePath(treePath)) {
    return json(res, 400, { error: 'invalid path' });
  }

  try {
    if (sub === 'publish-state') {
      return json(res, 200, await readPublishState(project));
    }
    if (sub === 'repo') {
      const result = await fetchRepoMeta(project, refresh);
      // Phase 5: resolve verified vs candidate-only maintainers in
      // parallel with the basic /repo lookup. resolveMaintainerSet
      // queries the trust anchor + every claimed maintainer's own
      // 30617, then applies the NIP-34 anti-scam rule.
      let maintainerSet: ReturnType<typeof serialiseMaintainerSet> | null = null;
      const coords = decodeNgitRemote(project);
      if (coords) {
        try {
          const ms = await resolveMaintainerSet(coords.pubkey, coords.identifier, coords.relayHints);
          maintainerSet = serialiseMaintainerSet(ms);
        } catch { /* leave maintainerSet null on failure — UI falls back to repo.maintainers */ }
      }
      return json(res, 200, {
        status: result.repo ? 'published' : 'local-only',
        repo:   result.repo,
        // True when the project has an ngit remote (decodable coordinate)
        // even if no 30617 resolved on relays. Lets the UI distinguish
        // "never announced" (no remote) from "announcement missing/deleted
        // or not yet propagated" (remote present, repo null) — the latter
        // gets a 'Re-announce' affordance instead of a misleading
        // 'run ngit init' hint.
        hasRemote: !!coords,
        maintainerSet,
        cached: result.cached,
        // Diagnostics on fresh queries only — cached returns are quiet.
        diagnostics: result.diagnostics,
      });
    }
    if (sub === 'repo/refs') {
      return json(res, 200, await readRefs(project));
    }
    if (sub === 'repo/tree') {
      const withLog = u.searchParams.get('withLog') === '1';
      return json(res, 200, await readTree(project, ref, treePath, withLog));
    }
    if (sub === 'repo/blob') {
      if (!treePath) return json(res, 400, { error: 'path required' });
      return json(res, 200, await readBlob(project, ref, treePath));
    }
    if (sub === 'repo/log') {
      const limit = clampInt(u.searchParams.get('limit'), DEFAULT_LOG_LIMIT, 1, MAX_LOG_LIMIT);
      const skip  = clampInt(u.searchParams.get('skip'),  0,                 0, MAX_LOG_SKIP);
      return json(res, 200, await readLog(project, ref, limit, skip));
    }
    if (sub === 'repo/readme') {
      return json(res, 200, await readReadme(project, ref));
    }
  } catch (e: any) {
    return json(res, 500, { error: extractGitError(e) });
  }
  return false;
}

// ── tiny response helpers ────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, body: any): boolean {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

export function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
