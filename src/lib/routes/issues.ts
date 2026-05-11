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
 * The CLI binding (POST endpoints) shells `ngit issue_create` and
 * `ngit comment` through the existing streamExec/SSE machinery —
 * same signing path Phase 1d's publish wizard uses, so anyone with
 * Amber paired can write issues + comments without re-pairing.
 */
import http from 'http';
import { nip19 } from 'nostr-tools';
import { getProject, type Project } from '../projects.js';
import { isValidRelayUrl, getGraspServers } from '../identity.js';
import { findBin } from '../detect.js';
import {
  queryRelays,
  getCached,
  setCached,
  getTagValue,
  getTags,
  type NostrEvent,
} from '../nostr-query.js';
import { readBody, streamExec, streamExecError } from './_shared.js';

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
  const cacheKey = { projectPath: project.path, key: 'issues-inbox' };
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

// ── POST handlers ───────────────────────────────────────────────────────

/**
 * Compose the ngit-CLI argv for issue creation. Returns null when
 * the input is malformed (caller responds 400 before spawning).
 *
 * The flag names mirror ngit's `issue_create` subcommand. We pass
 * --title / --body / --label flags explicitly so the spawn doesn't
 * try to open an interactive editor (no TTY in our SSE pipe).
 */
export function buildIssueCreateArgs(input: {
  title:  unknown;
  body?:  unknown;
  labels?: unknown;
}): string[] | null {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > 240) return null;
  const body = typeof input.body === 'string' ? input.body : '';
  if (body.length > 32_000) return null;        // sanity cap for the SSE payload
  const labels = Array.isArray(input.labels) ? input.labels : [];
  const args: string[] = ['issue_create', '--title', title];
  if (body) args.push('--body', body);
  for (const l of labels) {
    if (typeof l === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(l)) {
      args.push('--label', l);
    }
  }
  return args;
}

/**
 * Compose argv for `ngit comment`. The CLI's exact flag names may
 * differ between ngit versions; the shape here matches the upstream
 * subcommand definition (target event id + a body flag). The
 * version probe (Phase 0) can be wired up at startup to gate the
 * UI button if the installed ngit doesn't support `comment` yet.
 */
export function buildCommentArgs(input: {
  eventId: unknown;
  body:    unknown;
}): string[] | null {
  const eventId = typeof input.eventId === 'string' ? input.eventId.trim() : '';
  if (!/^[a-f0-9]{16,64}$/.test(eventId)) return null;
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body || body.length > 16_000) return null;
  return ['comment', '--on', eventId, '--message', body];
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
    const r = await fetchIssuesInbox(project, false);
    const issue = r.events.find((e) => e.id === eventId && e.kind === 1621);
    if (!issue) return json(res, 404, { error: 'issue not found' });
    const comments = r.events.filter((e) => e.kind === 1111 || e.kind === 1622);
    const tree = buildCommentTree(issue.id, comments);
    const detail: IssueDetail = { ...summariseIssue(issue, tree), comments: tree };
    return json(res, 200, detail);
  }

  // ── Issue create (SSE) ──────────────────────────────────────────────
  if (listMatch && method === 'POST') {
    if (!project.path) {
      streamExecError(res, req, 'project has no local path'); return true;
    }
    if (!findBin('ngit')) {
      streamExecError(res, req, 'ngit not found on PATH'); return true;
    }
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const args = buildIssueCreateArgs(parsed);
    if (!args) {
      streamExecError(res, req,
        'invalid issue input: title required (1–240 chars), body ≤ 32 KB, labels alphanumeric ≤ 32 chars'); return true;
    }
    streamExec(
      { bin: 'ngit', args, env: { NO_COLOR: '1', TERM: 'dumb' } },
      res, req, project.path,
    );
    return true;
  }

  // ── Comment thread fetch (GET) ───────────────────────────────────────
  //
  // Returns the NIP-22 comment tree for any root event id —
  // typically a patch series root or a custom root, not just a
  // kind-1621 issue. Drives the comment thread on the patch detail
  // view (Phase 3c) where /issues/:id wouldn't apply.
  if (commentsMatch && method === 'GET') {
    const rootId = u.searchParams.get('rootId') || '';
    if (!/^[a-f0-9]{16,64}$/.test(rootId)) {
      return json(res, 400, { error: 'invalid rootId' });
    }
    const r = await fetchIssuesInbox(project, false);
    const comments = r.events.filter((e) => e.kind === 1111 || e.kind === 1622);
    const tree = buildCommentTree(rootId, comments);
    return json(res, 200, { rootId, comments: tree, cached: r.cached });
  }

  // ── Comment create (SSE) ─────────────────────────────────────────────
  if (commentsMatch && method === 'POST') {
    if (!project.path) {
      streamExecError(res, req, 'project has no local path'); return true;
    }
    if (!findBin('ngit')) {
      streamExecError(res, req, 'ngit not found on PATH'); return true;
    }
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const args = buildCommentArgs(parsed);
    if (!args) {
      streamExecError(res, req,
        'invalid comment input: eventId must be hex (16–64 chars), body required (≤ 16 KB)'); return true;
    }
    streamExec(
      { bin: 'ngit', args, env: { NO_COLOR: '1', TERM: 'dumb' } },
      res, req, project.path,
    );
    return true;
  }

  return false;
}

function json(res: http.ServerResponse, status: number, body: any): boolean {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}
