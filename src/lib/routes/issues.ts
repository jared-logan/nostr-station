/**
 * Issues + NIP-22 comments — Phase 3a of the ngit-suite expansion.
 *
 * NIP-34 issues (kind 1621) with NIP-22 comment threads (kind 1111,
 * plus legacy kind 1622 surfaced inbound for back-compat).
 *
 * Endpoints:
 *   GET  /api/projects/:id/issues
 *      List kind-1621 issues for the repo. Includes comment counts.
 *
 *   GET  /api/projects/:id/issues/:eventId
 *      Single issue + threaded comment tree.
 *
 *   POST /api/projects/:id/issues             (SSE — ngit issue_create)
 *   POST /api/projects/:id/comments           (SSE — ngit comment)
 *
 * The thread tree is built from NIP-22's two-tier tag scheme:
 *   - Uppercase (K, E, A, P) — points at the THREAD ROOT (issue or
 *     patch); used to filter "all comments for this issue".
 *   - Lowercase (k, e, a, p) — points at the IMMEDIATE PARENT in
 *     the conversation tree. Top-level replies have lowercase == root.
 *
 * Comments compose recursively: a reply-to-reply still carries the
 * uppercase root reference (so server-side filtering by #E works)
 * and a lowercase pointer to the parent comment.
 *
 * The POST endpoints build the NIP-34/NIP-22 events NATIVELY (see
 * src/lib/nip34-events.ts — tag shapes verified against ngit-cli's
 * Rust source), sign via the saved bunker pairing, and publish to the
 * repo relays + GRASP servers + the user's read relays directly. The
 * old path shelled `ngit issue_create` / `ngit comment`; the native
 * path exists so every published event carries nostr-station's
 * canonical NIP-89 client tag (the CLI can't emit custom tags). The
 * response stays the same SSE stream of {line, stream} frames + a
 * final {done, code} frame the exec modal renders.
 */
import http from 'http';
import { nip19 } from 'nostr-tools';
import { getProject, type Project } from '../projects.js';
import { isValidRelayUrl, getGraspServers, getEffectiveReadRelays } from '../identity.js';
import {
  queryRelaysDirect as queryRelays,
  getCached,
  setCached,
  clearCache,
  getTagValue,
  getTags,
  type NostrEvent,
} from '../nostr-query.js';
import { signEventWithSavedBunker } from '../auth-bunker.js';
import { publishEventToRelays, fetchRepoMeta, mergeRelaySet } from './repo.js';
import {
  buildIssueTemplate,
  buildCommentTemplate,
  buildIssueCommentTemplate,
  KIND_GIT_ISSUE,
  KIND_GIT_COMMENT,
  type RepoRefInfo,
  type EventRefInfo,
  type Nip34EventTemplate,
} from '../nip34-events.js';
import { readBody, streamExecError } from './_shared.js';

const ISSUES_CACHE_TTL_MS    = 2 * 60 * 1000;   // 2 min — issues/comments mid-session
const RELAY_QUERY_TIMEOUT_MS = 10_000;
const MAX_TREE_DEPTH = 32;                       // anti-cycle on comment chains

// ── Public types ─────────────────────────────────────────────────────────

export interface IssueAuthor {
  pubkey: string;
}

export interface IssueSummary {
  id:           string;
  pubkey:       string;
  createdAt:    number;
  subject:      string;
  body:         string;           // raw markdown (frontend renders)
  labels:       string[];
  status:       'open';           // Phase 4 will compute from 163x events
  commentCount: number;
  author:       IssueAuthor;
}

export interface CommentNode {
  id:        string;
  pubkey:    string;
  createdAt: number;
  content:   string;
  kind:      number;              // 1111 or 1622 (legacy)
  parentId:  string | null;       // lowercase `e` target
  children:  CommentNode[];       // built in buildCommentTree
}

export interface IssueDetail extends IssueSummary {
  comments: CommentNode[];        // top-level (direct replies to issue); children nested
}

export interface IssuesListResult {
  issues:      IssueSummary[];
  cached:      boolean;
  diagnostics: any | null;
}

// ── Pure helpers (exported for tests) ───────────────────────────────────

/**
 * Find the NIP-22 ROOT marker. NIP-22 separates root from parent via
 * tag case: uppercase `E` is the root pointer; lowercase `e` is the
 * parent. Returns the uppercase `E` value when present.
 */
export function getRootEventId(event: NostrEvent): string | null {
  for (const t of event.tags) {
    if (t[0] === 'E' && typeof t[1] === 'string') return t[1];
  }
  return null;
}

/**
 * Find the NIP-22 PARENT marker — the lowercase `e` tag. For a
 * top-level reply this points at the same id as `E` (root == parent).
 * Returns null when there's no parent reference (which would be the
 * root itself, not a comment).
 */
export function getParentEventId(event: NostrEvent): string | null {
  for (const t of event.tags) {
    if (t[0] === 'e' && typeof t[1] === 'string') return t[1];
  }
  return null;
}

/** Extract `["t", "<label>"]` tags as a deduped string array. */
export function extractLabels(event: NostrEvent): string[] {
  const labels = new Set<string>();
  for (const t of getTags(event, 't')) {
    if (typeof t[1] === 'string' && t[1].length > 0 && t[1].length <= 64) {
      labels.add(t[1]);
    }
  }
  return Array.from(labels);
}

/**
 * Build a flat list of NIP-22 comment events into a nested tree.
 *
 *   1. Filter to events whose uppercase `E` tag points at `rootId`.
 *   2. Index by id.
 *   3. For each comment, attach to its parent (lowercase `e`) — when
 *      the parent is the root itself, surface as top-level.
 *   4. Orphan comments (parent not in the set) attach at the top
 *      level so they aren't dropped silently.
 *   5. Sort children chronologically at each level.
 *
 * Depth-capped at MAX_TREE_DEPTH so a malicious cycle can't spin
 * the loop.
 */
export function buildCommentTree(
  rootId: string,
  events: NostrEvent[],
): CommentNode[] {
  // Step 1: filter to comments anchored at this root.
  const relevant = events.filter((e) => getRootEventId(e) === rootId);

  // Step 2: build node map.
  const nodeById = new Map<string, CommentNode>();
  for (const e of relevant) {
    nodeById.set(e.id, {
      id:        e.id,
      pubkey:    e.pubkey,
      createdAt: e.created_at,
      content:   typeof e.content === 'string' ? e.content : '',
      kind:      e.kind,
      parentId:  getParentEventId(e),
      children:  [],
    });
  }

  // Step 3: link to parents (capped at MAX_TREE_DEPTH on placement
  // so a cycle in malformed input can't run forever).
  const topLevel: CommentNode[] = [];
  for (const node of nodeById.values()) {
    // Top-level reply has parent === root.
    if (node.parentId === rootId || node.parentId === null) {
      topLevel.push(node);
      continue;
    }
    const parent = nodeById.get(node.parentId);
    if (!parent) {
      // Orphan — surface at top level so user still sees it.
      topLevel.push(node);
      continue;
    }
    parent.children.push(node);
  }

  // Step 4: chronological sort recursively.
  const sortTree = (nodes: CommentNode[], depth: number): void => {
    if (depth > MAX_TREE_DEPTH) {
      // Safety net — at this depth a cycle is the only explanation.
      // Truncate to break the recursion.
      for (const n of nodes) n.children = [];
      return;
    }
    nodes.sort((a, b) => a.createdAt - b.createdAt);
    for (const n of nodes) sortTree(n.children, depth + 1);
  };
  sortTree(topLevel, 0);

  return topLevel;
}

/** Total comment count across the tree (used in issue summaries). */
export function countComments(tree: CommentNode[]): number {
  let n = 0;
  const walk = (nodes: CommentNode[]) => {
    for (const node of nodes) {
      n++;
      walk(node.children);
    }
  };
  walk(tree);
  return n;
}

export function summariseIssue(event: NostrEvent, comments: CommentNode[]): IssueSummary {
  const subject = getTagValue(event, 'subject')
    || (typeof event.content === 'string'
        ? event.content.trim().split('\n')[0].slice(0, 240)
        : '')
    || event.id.slice(0, 8);
  return {
    id:           event.id,
    pubkey:       event.pubkey,
    createdAt:    event.created_at,
    subject,
    body:         typeof event.content === 'string' ? event.content : '',
    labels:       extractLabels(event),
    status:       'open',
    commentCount: countComments(comments),
    author:       { pubkey: event.pubkey },
  };
}

// ── Coordinates resolver (mirrors routes/repo.ts + routes/patches.ts) ───

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
    // d-tag is the FINAL path segment; segments between the npub and it are
    // embedded relay hints. See the longer note in repo.ts decodeNgitRemote.
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

// ── Relay fetch (cached) ────────────────────────────────────────────────
//
// Single query for the whole inbox: kind 1621 (issues) + 1111
// (NIP-22 comments) + 1622 (legacy comments). One round-trip
// across all relays is much cheaper than three; the events split
// cheaply on the client by `kind`.

interface CachedInbox {
  events:    NostrEvent[];
  fetchedAt: number;
}

async function fetchIssuesInbox(
  project: Project,
  refresh: boolean,
): Promise<{ events: NostrEvent[]; cached: boolean; diagnostics: any | null }> {
  const coords = decodeNgitRemote(project);
  if (!coords || !project.path) return { events: [], cached: false, diagnostics: null };
  const cacheKey = { projectId: project.id, projectPath: project.path, key: 'issues-inbox' };
  if (!refresh) {
    const cached = getCached<CachedInbox>({ ...cacheKey, ttlMs: ISSUES_CACHE_TTL_MS });
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
    filter: { kinds: [1621, 1111, 1622], tags: { a: aTag } },
    relays,
    timeoutMs: RELAY_QUERY_TIMEOUT_MS,
    stream:    true,
  });
  setCached<CachedInbox>(cacheKey, { events: result.events, fetchedAt: Date.now() });
  return { events: result.events, cached: false, diagnostics: result.diagnostics };
}

/**
 * Targeted comment fetch for ONE rootId, by uppercase + lowercase `e`
 * references. NIP-22 uses `E` for the thread root and `e` for the
 * immediate parent — querying both catches every comment in the tree
 * regardless of whether the client emitted the repo `#a` tag. Always
 * fresh (no cache): the thread is per-modal-open and we want it live.
 */
async function fetchCommentsForRoot(
  project: Project,
  rootId: string,
): Promise<NostrEvent[]> {
  const coords = decodeNgitRemote(project);
  if (!coords) return [];
  const grasp = getGraspServers();
  const projRelays = (project.readRelays || []).filter((r): r is string => typeof r === 'string');
  const relays = [...coords.relayHints, ...grasp, ...projRelays]
    .filter(isValidRelayUrl)
    .filter((r, i, a) => a.indexOf(r) === i)
    .slice(0, 8);
  if (relays.length === 0) return [];

  // Two filters: #E (thread root) catches top-level replies; #e
  // (parent ref) catches comments-on-comments whose parent is the
  // root itself, plus any client that uses lowercase only.
  const [upper, lower] = await Promise.all([
    queryRelays({
      filter:    { kinds: [1111, 1622], tags: { E: rootId } },
      relays, timeoutMs: RELAY_QUERY_TIMEOUT_MS, stream: true,
    }),
    queryRelays({
      filter:    { kinds: [1111, 1622], tags: { e: rootId } },
      relays, timeoutMs: RELAY_QUERY_TIMEOUT_MS, stream: true,
    }),
  ]);
  const seen = new Set<string>();
  const events: NostrEvent[] = [];
  for (const ev of [...upper.events, ...lower.events]) {
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    events.push(ev);
  }
  return events;
}

// ── POST input validation (pure — exported for tests) ───────────────────

/**
 * Validate + normalise issue-create input. Returns null when the
 * input is malformed (caller streams a readable error before doing
 * any relay/signer work). Validation is IDENTICAL to the old
 * `buildIssueCreateArgs` ngit-argv builder: title required, 1–240
 * chars after trim; body ≤ 32 KB; labels silently filtered to
 * /^[A-Za-z0-9_-]{1,32}$/.
 */
export function parseIssueCreateInput(input: {
  title:  unknown;
  body?:  unknown;
  labels?: unknown;
}): { title: string; body: string; labels: string[] } | null {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > 240) return null;
  const body = typeof input.body === 'string' ? input.body : '';
  if (body.length > 32_000) return null;        // sanity cap for the SSE payload
  const rawLabels = Array.isArray(input.labels) ? input.labels : [];
  const labels: string[] = [];
  for (const l of rawLabels) {
    if (typeof l === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(l)) {
      labels.push(l);
    }
  }
  return { title, body, labels };
}

/**
 * Validate + normalise comment input. Same validation as the old
 * `buildCommentArgs`: eventId hex 16–64 chars; body required after
 * trim, ≤ 16 KB.
 */
export function parseCommentInput(input: {
  eventId: unknown;
  body:    unknown;
}): { eventId: string; body: string } | null {
  const eventId = typeof input.eventId === 'string' ? input.eventId.trim() : '';
  if (!/^[a-f0-9]{16,64}$/.test(eventId)) return null;
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body || body.length > 16_000) return null;
  return { eventId, body };
}

// ── Native publish machinery (shared with routes/status.ts) ─────────────

/**
 * Resolve the RepoRefInfo slice the nip34-events builders need:
 * coordinate identifier, maintainer pubkeys (anchor first), the
 * announcement's relays, and the euc. Backed by the cached 30617
 * (fetchRepoMeta); degrades to the coordinate alone when the
 * announcement isn't reachable — the event still references the repo
 * (single a/p for the trust anchor) so gitworkshop can place it.
 */
export async function resolveRepoRefInfo(project: Project): Promise<RepoRefInfo | null> {
  const coords = decodeNgitRemote(project);
  if (!coords) return null;
  let meta: { maintainers?: string[]; relays?: string[]; euc?: string | null } | null = null;
  try { meta = (await fetchRepoMeta(project, false)).repo; } catch { /* degrade below */ }
  return {
    identifier:  coords.identifier,
    maintainers: meta?.maintainers?.length ? meta.maintainers : [coords.pubkey],
    relays:      meta?.relays?.length ? meta.relays : coords.relayHints,
    euc:         typeof meta?.euc === 'string' ? meta.euc : '',
  };
}

/** Relay read set for one-off event-by-id lookups — same union the
 *  inbox queries use (remote hints + grasp + project read relays). */
function eventLookupRelays(project: Project): string[] {
  const coords = decodeNgitRemote(project);
  const grasp = getGraspServers();
  const projRelays = (project.readRelays || []).filter((r): r is string => typeof r === 'string');
  return [...(coords?.relayHints ?? []), ...grasp, ...projRelays]
    .filter(isValidRelayUrl)
    .filter((r, i, a) => a.indexOf(r) === i)
    .slice(0, 8);
}

/**
 * Fetch one event by id from the repo's relay set. `id` may be a hex
 * PREFIX (the route validators accept 16–64 chars) so match by
 * startsWith. Returns null when no relay has it.
 */
export async function fetchEventById(project: Project, id: string): Promise<NostrEvent | null> {
  const relays = eventLookupRelays(project);
  if (relays.length === 0) return null;
  try {
    const r = await queryRelays({
      filter:      { ids: [id] },
      relays,
      timeoutMs:   RELAY_QUERY_TIMEOUT_MS,
      stream:      false,
      acceptUntil: (evs) => evs.length >= 1,
    });
    return r.events.find((e) => typeof e.id === 'string' && e.id.startsWith(id)) ?? null;
  } catch { return null; }
}

/** Publish targets: repo announcement relays + GRASP servers + the
 *  user's effective read relays — same union (and the same
 *  mergeRelaySet capping policy) reannounceWithClientTag uses. */
export function nip34PublishTargets(repo: RepoRefInfo): string[] {
  const grasp = getGraspServers()
    .map((s) => /^wss?:\/\//i.test(s) ? s : `wss://${s}`)
    .filter(isValidRelayUrl);
  return mergeRelaySet([...repo.relays, ...grasp], getEffectiveReadRelays());
}

/**
 * Sign a template via the saved bunker pairing and publish it to
 * `targets`, narrating each step over an already-open SSE stream.
 * Returns the accepted-relay count (>0 = success) and the signed
 * event, or null when signing failed (error already emitted).
 */
export async function signAndPublishOverSse(
  emit:     (p: object) => void,
  template: Nip34EventTemplate,
  targets:  string[],
): Promise<{ accepted: number; signedEvent: any } | null> {
  emit({ line: 'signing — approve the request on your signer…', stream: 'stdout' });
  const signed = await signEventWithSavedBunker(template, 120_000);
  if (!signed.ok || !signed.signedEvent) {
    emit({
      line: `sign failed: ${signed.error || (signed.tried ? 'signer rejected the request' : 'no paired signer — pair Amber in Setup first')}`,
      stream: 'stderr',
    });
    return null;
  }
  emit({ line: `signed event ${signed.signedEvent.id}`, stream: 'stdout' });
  if (targets.length === 0) {
    emit({ line: 'no relays to publish to — configure GRASP servers or read relays', stream: 'stderr' });
    return { accepted: 0, signedEvent: signed.signedEvent };
  }
  emit({ line: `publishing to ${targets.length} relay${targets.length === 1 ? '' : 's'}…`, stream: 'stdout' });
  const results = await publishEventToRelays(signed.signedEvent, targets);
  for (const r of results) {
    if (r.ok) emit({ line: `✓ accepted by ${r.relay}`, stream: 'stdout' });
    else emit({ line: `✗ rejected by ${r.relay}${r.reason ? ` (${r.reason})` : ''}`, stream: 'stderr' });
  }
  const accepted = results.filter((r) => r.ok).length;
  return { accepted, signedEvent: signed.signedEvent };
}

/** Open the SSE response the exec modal expects — same headers
 *  streamExec writes. */
function openSse(res: http.ServerResponse): (p: object) => void {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
  return (p: object) => { try { res.write(`data: ${JSON.stringify(p)}\n\n`); } catch {} };
}

// ── Dispatcher ──────────────────────────────────────────────────────────

const ISSUES_LIST_ROUTE   = /^\/api\/projects\/([a-f0-9-]{10,})\/issues$/;
const ISSUES_DETAIL_ROUTE = /^\/api\/projects\/([a-f0-9-]{10,})\/issues\/([a-f0-9]{16,64})$/;
const COMMENTS_ROUTE      = /^\/api\/projects\/([a-f0-9-]{10,})\/comments$/;

export async function handleIssues(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  const u = new URL(url, 'http://localhost');
  const listMatch    = u.pathname.match(ISSUES_LIST_ROUTE);
  const detailMatch  = u.pathname.match(ISSUES_DETAIL_ROUTE);
  const commentsMatch = u.pathname.match(COMMENTS_ROUTE);
  if (!listMatch && !detailMatch && !commentsMatch) return false;

  const id = (listMatch || detailMatch || commentsMatch)![1];
  const project = getProject(id);
  if (!project) return json(res, 404, { error: 'project not found' });

  // ── List ─────────────────────────────────────────────────────────────
  if (listMatch && method === 'GET') {
    const refresh = u.searchParams.get('refresh') === '1';
    const r = await fetchIssuesInbox(project, refresh);
    const issues = r.events.filter((e) => e.kind === 1621);
    const comments = r.events.filter((e) => e.kind === 1111 || e.kind === 1622);
    const summaries: IssueSummary[] = issues
      .map((iss) => summariseIssue(iss, buildCommentTree(iss.id, comments)))
      .sort((a, b) => b.createdAt - a.createdAt);
    return json(res, 200, { issues: summaries, cached: r.cached, diagnostics: r.diagnostics });
  }

  // ── Detail ───────────────────────────────────────────────────────────
  if (detailMatch && method === 'GET') {
    const eventId = detailMatch[2];
    const inbox = await fetchIssuesInbox(project, false);
    const issue = inbox.events.find((e) => e.id === eventId && e.kind === 1621);
    if (!issue) return json(res, 404, { error: 'issue not found' });
    // Union inbox + per-issue targeted fetch so comments without the
    // repo `#a` tag still appear in the thread.
    const targeted = await fetchCommentsForRoot(project, issue.id);
    const seen = new Set<string>();
    const merged: NostrEvent[] = [];
    for (const ev of [...inbox.events, ...targeted]) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      merged.push(ev);
    }
    const comments = merged.filter((e) => e.kind === 1111 || e.kind === 1622);
    const tree = buildCommentTree(issue.id, comments);
    const detail: IssueDetail = { ...summariseIssue(issue, tree), comments: tree };
    return json(res, 200, detail);
  }

  // ── Issue create (SSE — native kind 1621 build + bunker sign) ──────
  if (listMatch && method === 'POST') {
    if (!project.path) {
      streamExecError(res, req, 'project has no local path'); return true;
    }
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const input = parseIssueCreateInput(parsed);
    if (!input) {
      streamExecError(res, req,
        'invalid issue input: title required (1–240 chars), body ≤ 32 KB, labels alphanumeric ≤ 32 chars'); return true;
    }
    const emit = openSse(res);
    try {
      emit({ line: '▸ building kind-1621 issue event', stream: 'stdout' });
      const repoRef = await resolveRepoRefInfo(project);
      if (!repoRef) {
        emit({ line: 'project has no decodable ngit remote — publish the repo first', stream: 'stderr' });
        emit({ done: true, code: 1 });
        return true;
      }
      const template = buildIssueTemplate(repoRef, input);
      const out = await signAndPublishOverSse(emit, template, nip34PublishTargets(repoRef));
      if (!out || out.accepted === 0) {
        if (out) emit({ line: 'no relay accepted the issue event', stream: 'stderr' });
        emit({ done: true, code: 1 });
        return true;
      }
      // Bust the inbox cache so the new issue shows on the next list.
      try { clearCache({ projectId: project.id, projectPath: project.path, key: 'issues-inbox' }); } catch {}
      emit({ line: `issue created: ${out.signedEvent.id}`, stream: 'stdout' });
      emit({ done: true, code: 0 });
    } catch (e: any) {
      emit({ line: `issue create failed: ${(e?.message || 'unknown error').toString().slice(0, 200)}`, stream: 'stderr' });
      emit({ done: true, code: 1 });
    } finally {
      try { res.end(); } catch {}
    }
    return true;
  }

  // ── Comment thread fetch (GET) ───────────────────────────────────────
  //
  // Returns the NIP-22 comment tree for any root event id —
  // typically a patch series root or a custom root, not just a
  // kind-1621 issue. Drives the comment thread on the patch detail
  // view (Phase 3c) where /issues/:id wouldn't apply.
  //
  // The cached inbox query filters by the repo's `#a` tag, which is
  // the well-behaved case. But NIP-22 only requires `E`/`e` references
  // to the thread root — many clients (and patch-series replies in
  // particular) emit comments with no `#a` at all. Union the cached
  // inbox with a targeted `#E:<rootId>` + `#e:<rootId>` fetch so we
  // pick them up. Matches gitworkshop's thread completeness.
  if (commentsMatch && method === 'GET') {
    const rootId = u.searchParams.get('rootId') || '';
    if (!/^[a-f0-9]{16,64}$/.test(rootId)) {
      // See patches.ts — diagnostic log on validator-reject so we can
      // catch truncations / encoding issues from a single log line.
      console.warn('[comments] REJECT rootId',
        'url=', req.url,
        'len=', rootId.length,
        'head=', rootId.slice(0, 8),
        'tail=', rootId.slice(-8),
        'raw=', JSON.stringify(rootId),
        'searchKeys=', [...u.searchParams.keys()].join(','));
      return json(res, 400, { error: 'invalid rootId', diagnostic: { len: rootId.length, head: rootId.slice(0,8), tail: rootId.slice(-8) } });
    }
    const inbox = await fetchIssuesInbox(project, false);
    const targeted = await fetchCommentsForRoot(project, rootId);
    const seen = new Set<string>();
    const merged: NostrEvent[] = [];
    for (const ev of [...inbox.events, ...targeted]) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      merged.push(ev);
    }
    const comments = merged.filter((e) => e.kind === 1111 || e.kind === 1622);
    const tree = buildCommentTree(rootId, comments);
    return json(res, 200, { rootId, comments: tree, cached: inbox.cached });
  }

  // ── Comment create (SSE — native NIP-22 kind 1111 build + sign) ─────
  //
  // NIP-22 needs the ROOT event's kind + author pubkey for the K/P
  // tags, and the PARENT's for k/p. We fetch the target event from
  // the repo relays:
  //   - target is an issue/patch (or anything non-comment) → it IS
  //     the root, and the comment is top-level (parent == root —
  //     ngit comment.rs:90-93).
  //   - target is itself a comment (1111/1622) → it's the PARENT;
  //     the root comes from its uppercase E tag (fetched for ground
  //     truth, K/P-tag fallback when the root event isn't reachable).
  // If the target can't be fetched we fail loudly rather than guess K.
  if (commentsMatch && method === 'POST') {
    if (!project.path) {
      streamExecError(res, req, 'project has no local path'); return true;
    }
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const input = parseCommentInput(parsed);
    if (!input) {
      streamExecError(res, req,
        'invalid comment input: eventId must be hex (16–64 chars), body required (≤ 16 KB)'); return true;
    }
    const emit = openSse(res);
    try {
      emit({ line: '▸ building kind-1111 comment event', stream: 'stdout' });
      const repoRef = await resolveRepoRefInfo(project);
      if (!repoRef) {
        emit({ line: 'project has no decodable ngit remote — publish the repo first', stream: 'stderr' });
        emit({ done: true, code: 1 });
        return true;
      }
      const target = await fetchEventById(project, input.eventId);
      if (!target) {
        emit({ line: `could not fetch event ${input.eventId.slice(0, 16)}… from the repo relays — cannot build NIP-22 root tags without it`, stream: 'stderr' });
        emit({ done: true, code: 1 });
        return true;
      }
      let template: Nip34EventTemplate;
      if (target.kind === KIND_GIT_COMMENT || target.kind === 1622) {
        // Reply to a comment: target is the parent; root from its E tag.
        const rootId = getRootEventId(target);
        if (!rootId) {
          emit({ line: 'target comment has no NIP-22 root (E) tag — cannot thread a reply', stream: 'stderr' });
          emit({ done: true, code: 1 });
          return true;
        }
        let root: EventRefInfo | null = null;
        const rootEvent = await fetchEventById(project, rootId);
        if (rootEvent) {
          root = { id: rootEvent.id, kind: rootEvent.kind, pubkey: rootEvent.pubkey };
        } else {
          // Fall back to the parent's own K/P root tags before failing.
          const k = getTagValue(target, 'K');
          const p = getTagValue(target, 'P');
          if (k && /^\d{1,5}$/.test(k) && p && /^[0-9a-f]{64}$/.test(p)) {
            root = { id: rootId, kind: Number(k), pubkey: p };
          }
        }
        if (!root) {
          emit({ line: `could not resolve thread root ${rootId.slice(0, 16)}… (event unreachable and parent carries no K/P tags) — refusing to guess the root kind`, stream: 'stderr' });
          emit({ done: true, code: 1 });
          return true;
        }
        template = buildCommentTemplate(repoRef, {
          root,
          parent: { id: target.id, kind: target.kind, pubkey: target.pubkey },
          body:   input.body,
        });
      } else if (target.kind === KIND_GIT_ISSUE) {
        template = buildIssueCommentTemplate(repoRef, {
          issueId: target.id, issuePubkey: target.pubkey, body: input.body,
        });
      } else {
        // Patch root / arbitrary root — top-level comment (parent == root).
        const root: EventRefInfo = { id: target.id, kind: target.kind, pubkey: target.pubkey };
        template = buildCommentTemplate(repoRef, { root, parent: root, body: input.body });
      }
      const out = await signAndPublishOverSse(emit, template, nip34PublishTargets(repoRef));
      if (!out || out.accepted === 0) {
        if (out) emit({ line: 'no relay accepted the comment event', stream: 'stderr' });
        emit({ done: true, code: 1 });
        return true;
      }
      try { clearCache({ projectId: project.id, projectPath: project.path, key: 'issues-inbox' }); } catch {}
      emit({ line: `comment posted: ${out.signedEvent.id}`, stream: 'stdout' });
      emit({ done: true, code: 0 });
    } catch (e: any) {
      emit({ line: `comment failed: ${(e?.message || 'unknown error').toString().slice(0, 200)}`, stream: 'stderr' });
      emit({ done: true, code: 1 });
    } finally {
      try { res.end(); } catch {}
    }
    return true;
  }

  return false;
}

function json(res: http.ServerResponse, status: number, body: any): boolean {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}
