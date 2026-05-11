/**
 * Patches routes — Phase 2a of the ngit-suite expansion.
 *
 * Replaces the flat kind-1617 list (sync.fetchNgitProposals → existing
 * /api/projects/:id/ngit/proposals) with a richer series-aware view
 * that maps onto how NIP-34 patches actually compose into "PRs":
 *
 *   - A series is one logical PR.
 *   - The original root patch has ["t","root"]. It's either a cover
 *     letter (markdown) or, when no cover letter is used, the first
 *     commit's patch text.
 *   - Subsequent patches in the SAME revision chain via NIP-10
 *     `e`/`reply` tags pointing to the previous patch.
 *   - A revised series begins with a NEW root-revision patch
 *     (["t","root-revision"]) whose NIP-10 reply points back to the
 *     original root (or to a previous root-revision when a series
 *     has been re-rolled multiple times). Each revision has its own
 *     chain of follower patches.
 *
 * The Proposals tab (Phase 2b) renders the output of buildPatchSeries
 * as cards with revision pills. The patch detail view (Phase 2c)
 * fetches /patches/:rootId for the metadata and lazy-loads
 * /patches/:rootId/diff?patchId= for each patch's parsed diff.
 *
 * Endpoints (all GET, JSON):
 *   /api/projects/:id/patches[?refresh=1]
 *      Series index — newest activity first.
 *   /api/projects/:id/patches/:rootId
 *      One series with all revisions + per-patch metadata.
 *   /api/projects/:id/patches/:rootId/diff?patchId=
 *      Parsed unified diff for one patch event.
 *
 * Reuses Phase 0 (queryRelays + cache) and Phase 1a's coordinate
 * decoder. Writes go through the existing ngit CLI via Phase 4
 * endpoints (when they exist) — this module is read-only.
 */
import http from 'http';
import { nip19 } from 'nostr-tools';
// parse-diff is CommonJS with no types; the default export is a
// function. Casting through `any` is the standard pattern in this
// codebase for typeless deps (see `nak`-spawn callers).
import parseDiffRaw from 'parse-diff';
const parseDiff = parseDiffRaw as any;
import { getProject, type Project } from '../projects.js';
import { isValidRelayUrl, getGraspServers } from '../identity.js';
import {
  queryRelays,
  getCached,
  setCached,
  getTagValue,
  getTags,
  type NostrEvent,
} from '../nostr-query.js';

// ── Tunables ─────────────────────────────────────────────────────────────

const PATCHES_CACHE_TTL_MS  = 5 * 60 * 1000;   // 5 min — short because users add patches mid-session
const RELAY_QUERY_TIMEOUT_MS = 10_000;
const MAX_REVISION_CHAIN_DEPTH = 16;           // anti-cycle on root-revision walks
const MAX_FOLLOWER_PASSES = 32;                // BFS pass cap on chain assembly

// ── Public types (also the JSON wire shape) ──────────────────────────────

export interface PatchAuthor {
  pubkey: string;
  name?:  string;     // parsed from "From: " header in patch content
  email?: string;
}

export interface PatchSummary {
  id:           string;
  pubkey:       string;
  createdAt:    number;
  commit:       string | null;       // from ["commit", "<sha>"] tag
  parentCommit: string | null;       // from ["parent-commit", "<sha>"] tag
  subject:      string;
  isCoverLetter: boolean;            // true when content has no "From <sha>" header
}

export interface PatchRevision {
  rootId:    string;                 // event id of THIS revision's root
  version:   number;                 // 1 = original; 2, 3, … = re-rolls
  createdAt: number;
  patches:   PatchSummary[];         // root first, then chain in created_at order
}

export interface PatchSeries {
  rootId:           string;          // event id of the v1 root
  subject:          string;
  author:           PatchAuthor;
  createdAt:        number;          // of the v1 root
  latestRevisionAt: number;          // for sorting / activity surfacing
  patchCount:       number;          // across all revisions
  revisionCount:    number;
  revisions:        PatchRevision[]; // ordered v1 → vN
}

export interface PatchSeriesIndex {
  series:      PatchSeries[];
  cached:      boolean;
  diagnostics: any | null;
}

// ── Pure tag helpers (exported for tests) ────────────────────────────────

export function hasTagValue(event: NostrEvent, name: string, value: string): boolean {
  return getTags(event, name).some((t) => t[1] === value);
}

/**
 * Find the NIP-10 reply marker. NIP-10 has two flavours of `e` tag —
 * "root" and "reply" — distinguished by the 4th element. Returns the
 * "reply" tag if present, falling back to the last unmarked `e` tag
 * (NIP-10 deprecated positional rules). Returns null when no parent
 * is referenced.
 */
export function getReplyTag(event: NostrEvent): string[] | null {
  const eTags = getTags(event, 'e');
  if (eTags.length === 0) return null;
  // Marker form takes precedence.
  for (const t of eTags) {
    if (t[3] === 'reply') return t;
  }
  // Single unmarked `e` is unambiguously the reply target.
  if (eTags.length === 1 && !eTags[0][3]) return eTags[0];
  // Multiple unmarked `e` tags: NIP-10 positional rule — last is reply.
  const unmarked = eTags.filter((t) => !t[3]);
  if (unmarked.length > 0) return unmarked[unmarked.length - 1];
  return null;
}

// ── Subject + author extraction (pure, exported) ────────────────────────

/**
 * Parse the "From: " header out of a `git format-patch` style content
 * block. Tolerates both "Name <email>" and bare email forms. Returns
 * undefined when no header is present (cover-letter path).
 */
export function parseAuthorFromContent(content: string): { name?: string; email?: string } | undefined {
  if (typeof content !== 'string') return undefined;
  // Only scan the first ~2 KB to keep the regex bounded on long
  // patches. The "From:" header is always near the top.
  const head = content.slice(0, 2048);
  const m = head.match(/^From:\s*(.+?)\s*$/m);
  if (!m) return undefined;
  const v = m[1].trim();
  // Standard "Name <email>" form.
  const m2 = v.match(/^(.+?)\s*<([^>]+)>$/);
  if (m2) return { name: m2[1].trim(), email: m2[2].trim() };
  if (/@/.test(v)) return { email: v };
  return { name: v };
}

/**
 * Extract a one-line subject for display. Three sources, in order:
 *   1. Explicit ["subject", "<title>"] tag (some clients)
 *   2. "Subject: [PATCH ...]" line in patch content (git format-patch)
 *   3. First non-empty line of content (cover-letter case)
 *   4. event id prefix (last-resort fallback)
 *
 * Always returns a non-empty string so renderers don't need to guard.
 */
export function parseSubject(event: NostrEvent): string {
  const tagSubject = getTagValue(event, 'subject');
  if (tagSubject && tagSubject.trim()) return tagSubject.trim().slice(0, 240);
  const content = typeof event.content === 'string' ? event.content : '';
  // git format-patch line: "Subject: [PATCH n/m] actual subject"
  const m = content.match(/^Subject:\s*(?:\[PATCH[^\]]*\]\s*)?(.+?)\s*$/m);
  if (m && m[1].trim()) return m[1].trim().slice(0, 240);
  // Cover-letter: pick the first non-empty line (skip leading blank lines).
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.slice(0, 240);
  }
  return event.id.slice(0, 8);
}

export function isCoverLetter(event: NostrEvent): boolean {
  const content = typeof event.content === 'string' ? event.content : '';
  // git format-patch always starts with `From <40-hex>` on the first
  // non-blank line. Anything else (markdown, plain text) is a cover
  // letter / standalone narrative.
  return !/^From\s+[a-f0-9]{40}\b/m.test(content.slice(0, 256));
}

function summarisePatch(event: NostrEvent): PatchSummary {
  return {
    id:            event.id,
    pubkey:        event.pubkey,
    createdAt:     event.created_at,
    commit:        getTagValue(event, 'commit'),
    parentCommit:  getTagValue(event, 'parent-commit'),
    subject:       parseSubject(event),
    isCoverLetter: isCoverLetter(event),
  };
}

// ── Series-detection algorithm (pure, exported for tests) ───────────────

/**
 * Group a flat list of kind-1617 patch events into series + revisions.
 *
 *   1. Roots are events with ["t","root"].
 *   2. Revisions are events with ["t","root-revision"]; their
 *      ["e", "<id>", "...", "reply"] tag points at a previous root
 *      (or a previous root-revision in a multi-roll chain).
 *   3. Walk every root-revision's reply chain (depth-capped to
 *      MAX_REVISION_CHAIN_DEPTH) until we hit a root — that's the
 *      series's v1 origin. Revisions whose chain leads to a root
 *      we don't have (relay didn't return it) still surface, anchored
 *      to the dangling parent id so the UI can render them.
 *   4. Each root + revision has a follower chain — patches that reply
 *      (transitively) to the root and aren't themselves roots/
 *      revisions of OTHER series. BFS-collected; capped at
 *      MAX_FOLLOWER_PASSES iterations so a malicious cycle can't
 *      spin the loop.
 *   5. Orphan patches (no `t=root`, no chain to one) become their
 *      own single-revision series. Lossy but legible — better than
 *      silently dropping events.
 */
export function buildPatchSeries(events: NostrEvent[]): PatchSeries[] {
  const byId = new Map<string, NostrEvent>();
  for (const e of events) byId.set(e.id, e);

  const roots     = events.filter((e) => hasTagValue(e, 't', 'root'));
  const revisions = events.filter((e) => hasTagValue(e, 't', 'root-revision'));

  // For each revision, walk back to its v1 root (or the dangling
  // parent we don't have a copy of).
  const revisionOrigin = new Map<string, string>();   // revision-root-id → v1-root-id
  for (const rev of revisions) {
    let cursor: NostrEvent | null = rev;
    let depth = 0;
    let originId = rev.id;
    while (cursor && depth < MAX_REVISION_CHAIN_DEPTH) {
      const reply = getReplyTag(cursor);
      if (!reply || !reply[1]) break;
      const parent = byId.get(reply[1]);
      if (!parent) {
        // Parent not in our event set — best we can do is anchor to
        // the dangling id so the UI still shows the revision.
        originId = reply[1];
        cursor = null;
        break;
      }
      if (hasTagValue(parent, 't', 'root')) {
        originId = parent.id;
        break;
      }
      cursor = parent;
      depth++;
    }
    revisionOrigin.set(rev.id, originId);
  }

  // Group: original root id → all root events for that series.
  const groups = new Map<string, { original: NostrEvent | null; revs: NostrEvent[] }>();
  for (const root of roots) groups.set(root.id, { original: root, revs: [] });
  for (const rev of revisions) {
    const origId = revisionOrigin.get(rev.id) || rev.id;
    if (!groups.has(origId)) {
      // The original root is missing — placeholder so the revision
      // still surfaces. UI will note "v1 not found locally".
      groups.set(origId, { original: null, revs: [] });
    }
    groups.get(origId)!.revs.push(rev);
  }

  // Helper: BFS collect followers for a single revision-root.
  // Excludes events that are roots/revisions OF OTHER series so
  // sibling series don't bleed into each other.
  const collectChain = (root: NostrEvent, allRootIds: Set<string>): NostrEvent[] => {
    const chain: NostrEvent[] = [root];
    const inChain = new Set<string>([root.id]);
    let pass = 0;
    let added = true;
    while (added && pass < MAX_FOLLOWER_PASSES) {
      added = false;
      pass++;
      for (const e of events) {
        if (inChain.has(e.id)) continue;
        if (allRootIds.has(e.id))   continue; // a root or revision of any series
        const reply = getReplyTag(e);
        if (!reply || !reply[1]) continue;
        if (inChain.has(reply[1])) {
          chain.push(e);
          inChain.add(e.id);
          added = true;
        }
      }
    }
    // Root first (cover letter / first commit), followers in
    // creation order so the UI renders them as a stable timeline.
    return [
      root,
      ...chain.filter((e) => e !== root).sort((a, b) => a.created_at - b.created_at),
    ];
  };

  const allRootIds = new Set<string>([
    ...roots.map((r) => r.id),
    ...revisions.map((r) => r.id),
  ]);

  const seriesList: PatchSeries[] = [];
  for (const [origId, group] of groups) {
    // All roots for this series, oldest first. Use the original (if
    // present) as v1; revisions follow in created_at order.
    const orderedRoots: NostrEvent[] = [];
    if (group.original) orderedRoots.push(group.original);
    for (const r of group.revs.sort((a, b) => a.created_at - b.created_at)) {
      orderedRoots.push(r);
    }
    if (orderedRoots.length === 0) continue;

    const revs: PatchRevision[] = orderedRoots.map((root, idx) => {
      const chain = collectChain(root, allRootIds);
      return {
        rootId:    root.id,
        version:   idx + 1,
        createdAt: root.created_at,
        patches:   chain.map(summarisePatch),
      };
    });

    const v1 = orderedRoots[0];
    const latest = revs[revs.length - 1];
    const author: PatchAuthor = {
      pubkey: v1.pubkey,
      ...(parseAuthorFromContent(v1.content) || {}),
    };
    seriesList.push({
      rootId:           origId,
      subject:          parseSubject(v1),
      author,
      createdAt:        v1.created_at,
      latestRevisionAt: latest.createdAt,
      patchCount:       revs.reduce((n, r) => n + r.patches.length, 0),
      revisionCount:    revs.length,
      revisions:        revs,
    });
  }

  // Orphans — events with no `t=root`/`t=root-revision` and no chain
  // back to one. Show each as its own single-patch "series" so they
  // aren't silently swallowed.
  const claimed = new Set<string>();
  for (const s of seriesList) {
    for (const r of s.revisions) {
      for (const p of r.patches) claimed.add(p.id);
    }
  }
  for (const e of events) {
    if (claimed.has(e.id)) continue;
    if (hasTagValue(e, 't', 'root')) continue;
    if (hasTagValue(e, 't', 'root-revision')) continue;
    const summary = summarisePatch(e);
    seriesList.push({
      rootId:           e.id,
      subject:          summary.subject,
      author:           { pubkey: e.pubkey, ...(parseAuthorFromContent(e.content) || {}) },
      createdAt:        e.created_at,
      latestRevisionAt: e.created_at,
      patchCount:       1,
      revisionCount:    1,
      revisions: [{
        rootId:    e.id,
        version:   1,
        createdAt: e.created_at,
        patches:   [summary],
      }],
    });
  }

  // Newest activity first — same convention as gitworkshop's PR list.
  seriesList.sort((a, b) => b.latestRevisionAt - a.latestRevisionAt);
  return seriesList;
}

// ── Diff parsing (pure, exported) ───────────────────────────────────────

export interface DiffFile {
  from:       string | null;
  to:         string | null;
  additions:  number;
  deletions:  number;
  // Pass-through of parse-diff's chunk shape — typed loosely because
  // parse-diff has no .d.ts and we don't want to invent one here.
  chunks:     any[];
  newMode?:   string;
  oldMode?:   string;
}

export interface ParsedDiff {
  files:           DiffFile[];
  totalAdditions:  number;
  totalDeletions:  number;
  fileCount:       number;
}

export function parsePatchContent(content: string): ParsedDiff {
  if (typeof content !== 'string' || !content) {
    return { files: [], totalAdditions: 0, totalDeletions: 0, fileCount: 0 };
  }
  let files: any[];
  try { files = parseDiff(content); }
  catch { return { files: [], totalAdditions: 0, totalDeletions: 0, fileCount: 0 }; }
  const out: DiffFile[] = files.map((f) => ({
    from:      f.from ?? null,
    to:        f.to   ?? null,
    additions: Number(f.additions) || 0,
    deletions: Number(f.deletions) || 0,
    chunks:    Array.isArray(f.chunks) ? f.chunks : [],
    newMode:   f.newMode,
    oldMode:   f.oldMode,
  }));
  return {
    files: out,
    totalAdditions: out.reduce((n, f) => n + f.additions, 0),
    totalDeletions: out.reduce((n, f) => n + f.deletions, 0),
    fileCount: out.length,
  };
}

// ── Project → coordinates resolver (mirrors routes/repo.ts) ─────────────

interface RepoCoords { pubkey: string; identifier: string; relayHints: string[]; }

function decodeNgitRemote(project: Project): RepoCoords | null {
  const remote = project.remotes?.ngit ?? '';
  if (!remote) return null;
  if (remote.startsWith('naddr1')) {
    try {
      const d = nip19.decode(remote);
      if (d.type !== 'naddr' || d.data.kind !== 30617) return null;
      return {
        pubkey:     d.data.pubkey,
        identifier: d.data.identifier,
        relayHints: Array.isArray(d.data.relays) ? d.data.relays : [],
      };
    } catch { return null; }
  }
  if (remote.startsWith('nostr://')) {
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

// ── Series fetch (cached) ───────────────────────────────────────────────

interface CachedPatchIndex {
  events: NostrEvent[];        // raw events so detail/diff endpoints can re-derive
  fetchedAt: number;
}

async function fetchPatchEvents(
  project: Project,
  refresh: boolean,
): Promise<{ events: NostrEvent[]; cached: boolean; diagnostics: any | null }> {
  const coords = decodeNgitRemote(project);
  if (!coords || !project.path) {
    return { events: [], cached: false, diagnostics: null };
  }
  const cacheKey = { projectPath: project.path, key: 'patches-1617' };
  if (!refresh) {
    const cached = getCached<CachedPatchIndex>({ ...cacheKey, ttlMs: PATCHES_CACHE_TTL_MS });
    if (cached) return { events: cached.events, cached: true, diagnostics: null };
  }
  const grasp = getGraspServers();
  const projRelays = (project.readRelays || []).filter((r): r is string => typeof r === 'string');
  const relays = [...coords.relayHints, ...grasp, ...projRelays]
    .filter(isValidRelayUrl)
    .filter((r, i, a) => a.indexOf(r) === i)
    .slice(0, 8);

  const aTag = `30617:${coords.pubkey}:${coords.identifier}`;
  const result = await queryRelays({
    filter: { kinds: [1617], tags: { a: aTag } },
    relays,
    timeoutMs: RELAY_QUERY_TIMEOUT_MS,
    stream:    true,                  // patches accumulate; let the timeout cap us
  });
  setCached<CachedPatchIndex>(cacheKey, { events: result.events, fetchedAt: Date.now() });
  return { events: result.events, cached: false, diagnostics: result.diagnostics };
}

// ── Dispatcher ─────────────────────────────────────────────────────────

const PATCHES_LIST_ROUTE   = /^\/api\/projects\/([a-f0-9-]{10,})\/patches$/;
const PATCHES_DETAIL_ROUTE = /^\/api\/projects\/([a-f0-9-]{10,})\/patches\/([a-f0-9]{16,64})$/;
const PATCHES_DIFF_ROUTE   = /^\/api\/projects\/([a-f0-9-]{10,})\/patches\/([a-f0-9]{16,64})\/diff$/;

export async function handlePatches(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  if (method !== 'GET') return false;
  const u = new URL(url, 'http://localhost');
  const refresh = u.searchParams.get('refresh') === '1';

  const listMatch   = u.pathname.match(PATCHES_LIST_ROUTE);
  const detailMatch = u.pathname.match(PATCHES_DETAIL_ROUTE);
  const diffMatch   = u.pathname.match(PATCHES_DIFF_ROUTE);
  if (!listMatch && !detailMatch && !diffMatch) return false;

  const id = (listMatch || detailMatch || diffMatch)![1];
  const project = getProject(id);
  if (!project) return json(res, 404, { error: 'project not found' });

  if (listMatch) {
    const r = await fetchPatchEvents(project, refresh);
    const series = buildPatchSeries(r.events);
    return json(res, 200, { series, cached: r.cached, diagnostics: r.diagnostics });
  }

  // Detail + diff both reuse the cached event set; refresh only on
  // the list path so detail/diff are cheap.
  const r = await fetchPatchEvents(project, false);
  const eventsById = new Map(r.events.map((e) => [e.id, e]));

  if (detailMatch) {
    const rootId = detailMatch[2];
    const series = buildPatchSeries(r.events).find((s) => s.rootId === rootId);
    if (!series) return json(res, 404, { error: 'series not found' });
    // Enrich with cover-letter content for each revision's root.
    const enriched = {
      ...series,
      revisions: series.revisions.map((rev) => {
        const rootEv = eventsById.get(rev.rootId);
        return {
          ...rev,
          coverLetter: rootEv && isCoverLetter(rootEv) ? rootEv.content : null,
        };
      }),
    };
    return json(res, 200, enriched);
  }

  if (diffMatch) {
    const patchId = u.searchParams.get('patchId') || '';
    if (!/^[a-f0-9]{16,64}$/.test(patchId)) {
      return json(res, 400, { error: 'invalid patchId' });
    }
    const ev = eventsById.get(patchId);
    if (!ev) return json(res, 404, { error: 'patch not found' });
    const diff = parsePatchContent(ev.content);
    return json(res, 200, { patchId, ...diff });
  }

  return false;
}

function json(res: http.ServerResponse, status: number, body: any): boolean {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}
