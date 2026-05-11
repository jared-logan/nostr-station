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
import { getProject, type Project } from '../projects.js';
import { findBin } from '../detect.js';
import { isValidRelayUrl, getGraspServers } from '../identity.js';
import { safeHttpUrl } from '../url-safety.js';
import {
  queryRelays,
  getCached,
  setCached,
  getTagValue,
  getTags,
  type NostrEvent,
} from '../nostr-query.js';

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
function decodeNgitRemote(project: Project): RepoCoords | null {
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
    // Per ngit, `nostr://<npub-or-nip05>/<d-tag>` is the canonical form.
    // Accept only the npub form here — NIP-05 resolution would require
    // an extra .well-known fetch we'd rather defer.
    const m = remote.match(/^nostr:\/\/(npub1[0-9a-z]+)\/(.+)$/);
    if (!m) return null;
    try {
      const d = nip19.decode(m[1]);
      if (d.type !== 'npub' || typeof d.data !== 'string') return null;
      return { pubkey: d.data, identifier: m[2], relayHints: [] };
    } catch { return null; }
  }
  return null;
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

async function readPublishState(project: Project): Promise<any> {
  const pPath = project.path;
  const isGitRepo = !!pPath && fs.existsSync(path.join(pPath, '.git'));
  const ngitRemote = project.remotes?.ngit ?? null;
  // Detected defaults for the first-publish form. `package.json` is the
  // dominant convention in shakespeare/stacks projects, so we lean on
  // its `name`, `description`, and `keywords` fields when present.
  let detectedName        = project.name;
  let detectedDescription = '';
  let suggestedHashtags: string[] = [];
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
        suggestedHashtags = pkg.keywords
          .filter((k: any): k is string => typeof k === 'string' && /^[a-z0-9-]{1,32}$/i.test(k))
          .slice(0, 8);
      }
    } catch { /* no package.json — fall back to project.name */ }
  }
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
  const suggestedGraspServer = grasp[0] ?? 'wss://relay.ngit.dev';

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
  };
}

// ── 30617 fetch (cached + diagnostics) ───────────────────────────────────

async function fetchRepoMeta(
  project: Project,
  refresh: boolean,
): Promise<{ repo: RepoMeta | null; cached: boolean; diagnostics: any | null }> {
  const coords = decodeNgitRemote(project);
  if (!coords || !project.path) return { repo: null, cached: false, diagnostics: null };

  const cacheKey = { projectPath: project.path, key: 'repo-30617' };
  if (!refresh) {
    const cached = getCached<RepoMeta>({ ...cacheKey, ttlMs: REPO_CACHE_TTL_MS });
    if (cached) return { repo: cached, cached: true, diagnostics: null };
  }

  // GRASP servers + naddr hints + project read relays. Same union as
  // the Discover handler — kind 30617 lives on GRASP servers in
  // practice; read relays alone usually return nothing.
  const grasp = getGraspServers();
  const projRelays = (project.readRelays || []).filter((r): r is string => typeof r === 'string');
  const relays = [...coords.relayHints, ...grasp, ...projRelays]
    .filter(isValidRelayUrl)
    .filter((r, i, a) => a.indexOf(r) === i)
    .slice(0, 8);

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

async function readTree(project: Project, ref: string, treePath: string): Promise<any> {
  if (!project.path) return { ref, path: treePath, entries: [] };
  // `git ls-tree -l <ref> <path>/` lists one level. Trailing slash is
  // important: without it you'd get just the entry FOR the path.
  // `-z` gives NUL terminators so filenames with spaces/newlines parse
  // safely.
  const target = treePath ? `${treePath}/` : '';
  const args = ['ls-tree', '-l', '-z', `${ref}`, target];
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
  return { ref, path: treePath, entries };
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

function extractGitError(e: any): string {
  // execFile attaches stderr to the rejection — surface it (slimmed)
  // so the client gets an actionable message instead of "command failed".
  const stderr = (e?.stderr ?? '').toString().trim();
  const message = (e?.message ?? '').toString().trim();
  return (stderr || message || 'git command failed').slice(0, 240);
}

// ── Dispatcher ──────────────────────────────────────────────────────────

const REPO_ROUTE = /^\/api\/projects\/([a-f0-9-]{10,})\/(publish-state|repo(?:\/refs|\/tree|\/blob|\/log|\/readme)?)$/;

export async function handleRepo(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  if (method !== 'GET') return false;
  // Strip query string for path matching; `URL` parsing requires a
  // base, so glue one on for parsing-only purposes.
  const u = new URL(url, 'http://localhost');
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
      return json(res, 200, {
        status: result.repo ? 'published' : 'local-only',
        repo:   result.repo,
        cached: result.cached,
        // Diagnostics on fresh queries only — cached returns are quiet.
        diagnostics: result.diagnostics,
      });
    }
    if (sub === 'repo/refs') {
      return json(res, 200, await readRefs(project));
    }
    if (sub === 'repo/tree') {
      return json(res, 200, await readTree(project, ref, treePath));
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
