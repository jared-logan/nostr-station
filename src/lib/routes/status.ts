/**
 * Status + merge — Phase 4 of the ngit-suite expansion.
 *
 * NIP-34 §1.9 — kind 1630-1633 status events. The most recent
 * authorized 163x event "wins" for a given root (issue or patch):
 *
 *   1630  open
 *   1631  applied (patches) / resolved (issues)
 *   1632  closed
 *   1633  draft
 *
 * Authority rule: a 163x is authorised when its author is EITHER
 *   - the root event's author (the patch/issue submitter), OR
 *   - in the repo's maintainer set (Phase 5 hardens this; today we
 *     use the announced maintainers tag verbatim).
 *
 * Endpoints:
 *   GET  /api/projects/:id/status?rootIds=<id1,id2,…>
 *     Bulk-compute effective status for one or more root event ids.
 *     Returns { status, statusEventId, lastChangedAt } per root.
 *
 *   POST /api/projects/:id/status                 (SSE)
 *     Shells out to `ngit pr status` / `ngit issue status` based on
 *     the supplied `kind` ("patch" | "issue"). Maintainer / author
 *     authority is enforced server-side: refuses if the signer can't
 *     legitimately publish the change (cheap pre-flight before
 *     burning an Amber prompt).
 *
 *   POST /api/projects/:id/merge                  (SSE)
 *     Shells out to `ngit pr merge <patch-root-id>`. Preflight:
 *     refuses on dirty working tree (`git status --porcelain`
 *     non-empty) so a half-finished local edit can't be silently
 *     merged into.
 *
 * Computation is pure (computeEffectiveStatus, exported for tests);
 * the relay query reuses the issues-inbox cache from Phase 3 plus
 * a parallel kind-163x query.
 */
import http from 'http';
import { execFile, execFileSync, spawn } from 'child_process';
import { promisify } from 'util';
import { nip19 } from 'nostr-tools';
import { getProject, type Project } from '../projects.js';
import { isValidRelayUrl, getGraspServers } from '../identity.js';
import { findBin } from '../detect.js';
import {
  queryRelays,
  getCached,
  setCached,
  getTags,
  type NostrEvent,
  type RelayQueryFilter,
} from '../nostr-query.js';
import { readBody, streamExec, streamExecError } from './_shared.js';
import { resolveMaintainerSet } from '../maintainer-set.js';

const execFileAsync = promisify(execFile);

const STATUS_CACHE_TTL_MS    = 60 * 1000;   // 1 min — status changes faster than other data
const RELAY_QUERY_TIMEOUT_MS = 10_000;

// ── Public types ─────────────────────────────────────────────────────────

export type EffectiveStatus = 'open' | 'merged' | 'resolved' | 'closed' | 'draft';

export interface StatusComputation {
  rootId:        string;
  status:        EffectiveStatus;
  statusEventId: string | null;       // null when no 163x exists yet
  lastChangedAt: number;              // 0 when no 163x exists yet
  mergeCommit?:  string;              // only set when 1631 applied/merged a patch
}

export interface MaintainerSet {
  /** Authoring pubkey of the original event (always authorised for self). */
  rootAuthor: string;
  /** Pubkeys listed in the repo's `maintainers` tag (Phase 5 verifies). */
  maintainers: Set<string>;
}

// ── Pure helpers (exported for tests) ───────────────────────────────────

const KIND_TO_STATUS: Record<number, EffectiveStatus> = {
  1630: 'open',
  1632: 'closed',
  1633: 'draft',
};

/**
 * Map a kind-1631 event to either 'merged' or 'resolved'. NIP-34
 * uses the same kind for both, distinguished by what the event is
 * attached to: patches → merged, issues → resolved.
 *
 * Three detection signals, in priority order:
 *   1. `merge-commit` tag — gitworkshop's merge events, pre-2.x ngit
 *   2. `applied-as-commits` tag — patches applied via rebase / squash /
 *      cherry-pick without a merge commit
 *   3. `alt` tag matching /\bmerg(e|ed)\b/ — ngit 2.x's `pr merge`
 *      publishes the kind-1631 with `alt: "PR merged"` but WITHOUT
 *      either patch-specific tag above. The `r` tag in those events
 *      is even an empty string, so the alt is the only meaningful
 *      semantic signal.
 *
 * False-positive risk for the alt fallback: an issue-resolution event
 * whose `alt` happens to contain the word "merge" would misclassify.
 * No tooling we're aware of writes that — ngit's issue-status flow
 * uses different alt copy, and gitworkshop uses "Status change."
 */
function mapKind1631(event: NostrEvent): EffectiveStatus {
  for (const t of event.tags) {
    if (t[0] === 'merge-commit' || t[0] === 'applied-as-commits') return 'merged';
    if (t[0] === 'alt' && typeof t[1] === 'string' && /\bmerg(e|ed)\b/i.test(t[1])) {
      return 'merged';
    }
  }
  return 'resolved';
}

/**
 * Determine whether a given pubkey is authorised to publish a status
 * event for a given root. Three legitimate authors:
 *   1. The root event's author (closing their own issue / patch)
 *   2. A maintainer per the repo's 30617 announcement
 *
 * Phase 5 will harden (2) by requiring each claimed maintainer to
 * have published their OWN 30617 under the same coordinate chain.
 * For Phase 4 we trust the announced list verbatim.
 */
export function isAuthorisedToSetStatus(
  pubkey: string,
  rootAuthor: string,
  maintainers: Set<string>,
): boolean {
  if (pubkey === rootAuthor) return true;
  return maintainers.has(pubkey);
}

/**
 * Compute effective status for one root event from a set of
 * candidate 163x events. The most recent AUTHORISED 163x wins.
 * Unauthorised events are silently ignored — they'd otherwise let
 * anyone publish an event claiming a PR is closed.
 */
export function computeEffectiveStatus(
  rootId: string,
  rootAuthor: string,
  maintainers: Set<string>,
  statusEvents: NostrEvent[],
): StatusComputation {
  let best: NostrEvent | null = null;
  for (const ev of statusEvents) {
    if (ev.kind < 1630 || ev.kind > 1633) continue;
    // Filter to events referencing THIS root via NIP-10 `e` tag.
    // NIP-34 status events use `["e", "<root-id>", "", "root"]`.
    const refs = getTags(ev, 'e');
    if (!refs.some((t) => t[1] === rootId)) continue;
    if (!isAuthorisedToSetStatus(ev.pubkey, rootAuthor, maintainers)) continue;
    if (!best || ev.created_at > best.created_at) best = ev;
  }
  if (!best) {
    return { rootId, status: 'open', statusEventId: null, lastChangedAt: 0 };
  }
  const status: EffectiveStatus = best.kind === 1631
    ? mapKind1631(best)
    : (KIND_TO_STATUS[best.kind] || 'open');
  const result: StatusComputation = {
    rootId,
    status,
    statusEventId: best.id,
    lastChangedAt: best.created_at,
  };
  // Surface the merge commit hash when present — the UI uses it to
  // link the merged badge to the actual commit.
  for (const t of best.tags) {
    if (t[0] === 'merge-commit' && typeof t[1] === 'string') {
      result.mergeCommit = t[1];
      break;
    }
  }
  return result;
}

// ── Coordinates resolver ───────────────────────────────────────────────

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

// ── Status-event fetch (cached) ─────────────────────────────────────────

interface CachedStatus {
  events: NostrEvent[];
  fetchedAt: number;
}

const STATUS_KINDS = [1630, 1631, 1632, 1633];

/**
 * Build the relay filters we issue for a status pull. We deliberately
 * use TWO filters (union at the relay) instead of one:
 *
 *   1. `{kinds: 1630-1633, #a: <repo>}`  — the well-behaved case where
 *      a status event carries the repo announcement coordinate.
 *   2. `{kinds: 1630-1633, #e: <rootIds>}` — fallback for status events
 *      that reference the root patch via `e` only and omit `#a`. NIP-34
 *      doesn't *require* `#a` on 1630-1633, and ngit / gitworkshop have
 *      historically published 1631 (merge) events with just the `e`
 *      tag. Without this filter those merge events get dropped at the
 *      relay and the PR sticks at "open" in our dashboard while showing
 *      "merged" on gitworkshop.
 *
 * Returned as a list so callers can `Promise.all` two queryRelays calls;
 * exported so tests can assert both clauses are present.
 */
export function buildStatusRelayFilters(
  aTag: string,
  rootIds: string[],
): RelayQueryFilter[] {
  const filters: RelayQueryFilter[] = [
    { kinds: STATUS_KINDS, tags: { a: aTag } },
  ];
  if (rootIds.length > 0) {
    filters.push({ kinds: STATUS_KINDS, tags: { e: rootIds } });
  }
  return filters;
}

// Read the cached 30617's `relays` tag from disk. The cache is
// populated by routes/repo.ts via setCached<RepoMeta> at the
// `repo-30617` key — same shape, accessed read-only here. Returns
// `[]` when no cache exists yet (first-load case); status will fall
// back to grasp servers, and the next status fetch picks up the
// relays once the About / Code tab populates the cache.
function readAnnouncementRelays(project: Project): string[] {
  if (!project.path) return [];
  try {
    const cached = getCached<{ relays?: string[] }>({
      projectId:   project.id,
      projectPath: project.path,
      key:         'repo-30617',
      ttlMs:       60 * 60 * 1000,            // mirror REPO_CACHE_TTL_MS
    });
    return Array.isArray(cached?.relays) ? cached!.relays : [];
  } catch {
    return [];
  }
}

async function fetchStatusEvents(
  project: Project,
  refresh: boolean,
  rootIds: string[],
  announcementRelays: string[] = [],
): Promise<{ events: NostrEvent[]; cached: boolean; relays: string[] }> {
  const coords = decodeNgitRemote(project);
  if (!coords || !project.path) return { events: [], cached: false, relays: [] };

  // Relay set for status query. Order:
  //   1. coords.relayHints — from a naddr:// URL (often empty for nostr:// URLs)
  //   2. announcement.relays — passed in by the caller from the resolved
  //      MaintainerSet's union; falls back to the disk-cached 30617
  //      when the maintainer fetch returned empty (cold-cache case).
  //      The canonical "where to find events about this repo" list.
  //      WITHOUT this entry, projects whose ngit remote is `nostr://npub.../id`
  //      (= empty relayHints) would never query the relays the trust anchor
  //      explicitly listed — meaning a 1631 merge event published by gitworkshop
  //      to those relays gets silently missed and the PR sticks at "open".
  //   3. user GRASP servers — fallback when the announcement's relays don't
  //      reach the user's preferred infrastructure
  //   4. project read-relays — explicit per-project overrides
  const fallbackAnnouncementRelays = announcementRelays.length > 0
    ? announcementRelays
    : readAnnouncementRelays(project);
  const grasp = getGraspServers();
  const projRelays = (project.readRelays || []).filter((r): r is string => typeof r === 'string');
  const relays = [...coords.relayHints, ...fallbackAnnouncementRelays, ...grasp, ...projRelays]
    .filter(isValidRelayUrl)
    .filter((r, i, a) => a.indexOf(r) === i)
    .slice(0, 8);
  if (relays.length === 0) return { events: [], cached: false, relays: [] };

  const aTag = `30617:${coords.pubkey}:${coords.identifier}`;
  const cacheKey = { projectId: project.id, projectPath: project.path, key: 'status-163x' };

  // The per-repo (a-tag) pull is cacheable — it changes slowly and is
  // shared across all rootIds. The per-rootId (e-tag) pull is always
  // fresh: it's targeted, small, and exists specifically to catch the
  // merge events that the broad a-tag query misses.
  let aTagEvents: NostrEvent[] = [];
  let cached = false;
  if (!refresh) {
    const hit = getCached<CachedStatus>({ ...cacheKey, ttlMs: STATUS_CACHE_TTL_MS });
    if (hit) { aTagEvents = hit.events; cached = true; }
  }

  const filters = buildStatusRelayFilters(aTag, rootIds);
  const tasks: Promise<NostrEvent[]>[] = [];
  if (!cached) {
    tasks.push(queryRelays({
      filter: filters[0], relays, timeoutMs: RELAY_QUERY_TIMEOUT_MS, stream: true,
    }).then((r) => {
      aTagEvents = r.events;
      setCached<CachedStatus>(cacheKey, { events: r.events, fetchedAt: Date.now() });
      return r.events;
    }));
  }
  if (filters.length > 1) {
    tasks.push(queryRelays({
      filter: filters[1], relays, timeoutMs: RELAY_QUERY_TIMEOUT_MS, stream: true,
    }).then((r) => r.events));
  }
  const groups = await Promise.all(tasks);

  const seen = new Set<string>();
  const events: NostrEvent[] = [];
  const push = (list: NostrEvent[]) => {
    for (const ev of list) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      events.push(ev);
    }
  };
  if (cached) push(aTagEvents);
  for (const g of groups) push(g);

  return { events, cached, relays };
}

/** Fetch the 30617 announcement so we know who the maintainers are.
 *
 * Authority model — PERMISSIVE (gitworkshop parity):
 *   We honor any pubkey listed in the trust anchor's `maintainers` tag,
 *   even if that pubkey has not re-announced their own 30617. The Phase-5
 *   "verified-only" model rejected candidate-only maintainers as an
 *   anti-scam measure, but gitworkshop.dev (and other ngit consumers)
 *   accept them — which means our dashboard would silently disagree
 *   with gitworkshop's status display whenever a co-maintainer who never
 *   re-announced closed/merged a PR. Parity > anti-scam guarantee was
 *   the explicit call (see commit log). resolveMaintainerSet still
 *   surfaces `candidatesOnly` for UI warning chips.
 */
async function fetchMaintainerSet(project: Project): Promise<{
  pubkeys: Set<string>;
  relays:  string[];
}> {
  const coords = decodeNgitRemote(project);
  if (!coords) return { pubkeys: new Set(), relays: [] };
  const ms = await resolveMaintainerSet(coords.pubkey, coords.identifier, coords.relayHints);
  // Permissive union: trust anchor + verified + candidate-only.
  // The trust anchor is always authoritative by definition; verified
  // maintainers have re-announced; candidates are claimed-only and were
  // previously excluded.
  const pubkeys = new Set<string>([coords.pubkey, ...ms.verified, ...ms.candidatesOnly]);
  // ms.relays is the union of every verified maintainer's `relays` tag —
  // the canonical answer to "where do events about this repo live?".
  // Surfaced so fetchStatusEvents can target those relays even when
  // they're not in the user's grasp config.
  return { pubkeys, relays: ms.relays || [] };
}

// ── Root-author resolution ──────────────────────────────────────────────
//
// computeEffectiveStatus needs the root event's authoring pubkey so a
// PR submitter can self-close their own PR (NIP-34 explicitly authorises
// this). Previously we passed '' as rootAuthor — which silently denied
// self-closes to anyone not also in the maintainer set. Fixed by
// querying the relay for the actual root events by id.

interface CachedRootAuthors {
  authors:   Record<string, string>;  // rootId → pubkey
  fetchedAt: number;
}

const ROOT_AUTHOR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;  // 24h — root events are immutable

/**
 * Resolve rootId → pubkey for every requested root. Cached per project
 * across calls because the answer is immutable: a root event's author
 * never changes. Missing entries map to undefined; computeEffectiveStatus
 * then falls back to the maintainer-set check alone, which is the
 * conservative behaviour.
 *
 * Patches are kind 1617, issues are kind 1621. We query both kinds in
 * one shot so a mixed rootIds batch costs one round-trip.
 */
async function fetchRootAuthors(
  project: Project,
  rootIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (rootIds.length === 0 || !project.path) return result;
  const coords = decodeNgitRemote(project);
  if (!coords) return result;

  const cacheKey = { projectId: project.id, projectPath: project.path, key: 'root-authors' };
  const cached = getCached<CachedRootAuthors>({ ...cacheKey, ttlMs: ROOT_AUTHOR_CACHE_TTL_MS });
  const known = cached?.authors ?? {};
  const need: string[] = [];
  for (const rid of rootIds) {
    if (known[rid]) result.set(rid, known[rid]);
    else need.push(rid);
  }
  if (need.length === 0) return result;

  const grasp = getGraspServers();
  const projRelays = (project.readRelays || []).filter((r): r is string => typeof r === 'string');
  const relays = [...coords.relayHints, ...grasp, ...projRelays]
    .filter(isValidRelayUrl)
    .filter((r, i, a) => a.indexOf(r) === i)
    .slice(0, 8);
  if (relays.length === 0) return result;

  const r = await queryRelays({
    filter:    { kinds: [1617, 1621], ids: need },
    relays,
    timeoutMs: RELAY_QUERY_TIMEOUT_MS,
    stream:    false,
    acceptUntil: (evs) => evs.length >= need.length,
  });
  const next = { ...known };
  for (const ev of r.events) {
    if (typeof ev.id === 'string' && typeof ev.pubkey === 'string') {
      result.set(ev.id, ev.pubkey);
      next[ev.id] = ev.pubkey;
    }
  }
  setCached<CachedRootAuthors>(cacheKey, { authors: next, fetchedAt: Date.now() });
  return result;
}

/**
 * Compose `ngit pr status` / `ngit issue status` argv.
 * Accepts `kind: 'patch' | 'issue'` and `status` ∈ valid set per kind.
 * Returns null for malformed input.
 *
 * ngit 2.x normalized underscore-form subcommands (`pr_status`,
 * `issue_status`) to spaced form (`pr status`, `issue status`) —
 * same shift `pr checkout` and `pr merge` already used. The old form
 * errors with `unrecognized subcommand 'pr_status'` and `tip: a
 * similar subcommand exists: 'pr'`.
 */
export function buildStatusArgs(input: {
  kind:    unknown;
  rootId:  unknown;
  status:  unknown;
  message?: unknown;
}): string[] | null {
  const kind   = input.kind;
  const rootId = typeof input.rootId === 'string' ? input.rootId.trim() : '';
  const status = typeof input.status === 'string' ? input.status.trim() : '';
  if (!/^[a-f0-9]{16,64}$/.test(rootId)) return null;
  // Allowed status verbs differ by kind (issues can't be "applied",
  // patches can't be "resolved").
  const patchAllowed = new Set(['open', 'draft', 'closed']);
  const issueAllowed = new Set(['open', 'resolved', 'closed']);
  if (kind === 'patch') {
    if (!patchAllowed.has(status)) return null;
    const flag = '--' + status;
    return ['pr', 'status', flag, rootId];
  }
  if (kind === 'issue') {
    if (!issueAllowed.has(status)) return null;
    const flag = '--' + status;
    return ['issue', 'status', flag, rootId];
  }
  return null;
}

// ── Dispatcher ─────────────────────────────────────────────────────────

const STATUS_GET_ROUTE  = /^\/api\/projects\/([a-f0-9-]{10,})\/status$/;
const STATUS_POST_ROUTE = STATUS_GET_ROUTE;
const MERGE_ROUTE       = /^\/api\/projects\/([a-f0-9-]{10,})\/merge$/;

export async function handleStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  const u = new URL(url, 'http://localhost');
  const statusMatch = u.pathname.match(STATUS_GET_ROUTE);
  const mergeMatch  = u.pathname.match(MERGE_ROUTE);
  if (!statusMatch && !mergeMatch) return false;
  const id = (statusMatch || mergeMatch)![1];
  const project = getProject(id);
  if (!project) return json(res, 404, { error: 'project not found' });

  // ── Bulk status compute ─────────────────────────────────────────────
  if (statusMatch && method === 'GET') {
    const rootIdsParam = u.searchParams.get('rootIds') || '';
    const rootIds = rootIdsParam.split(',').map((s) => s.trim()).filter(Boolean);
    // `refresh=1` bypasses the 60s status cache. Used by the client
    // after a successful merge / status change, and by manual refresh
    // gestures, so the next paint reflects the just-published 163x.
    const refresh = u.searchParams.get('refresh') === '1';
    if (rootIds.length === 0) return json(res, 200, { results: [] });
    if (rootIds.length > 200) return json(res, 400, { error: 'too many rootIds (max 200)' });
    for (const r of rootIds) {
      if (!/^[a-f0-9]{16,64}$/.test(r)) {
        // See patches.ts/issues.ts — diagnostic log on validator-reject.
        // Multi-rootId case: log the offending one + sibling count.
        console.warn('[status] REJECT rootId',
          'url=', req.url,
          'len=', r.length,
          'head=', r.slice(0, 8),
          'tail=', r.slice(-8),
          'raw=', JSON.stringify(r),
          'siblingsCount=', rootIds.length);
        return json(res, 400, { error: 'invalid rootId', diagnostic: { len: r.length, head: r.slice(0,8), tail: r.slice(-8) } });
      }
    }
    // Wave 1: maintainer set + root-author map in parallel. We need
    // the maintainer set's relay union BEFORE the status fetch so the
    // status query can target the relays the trust anchor explicitly
    // listed (otherwise we miss 1631 events published to relays not
    // in the user's grasp config — root cause of "merged shows as
    // open" bugs on projects whose ngit URL is `nostr://...` rather
    // than naddr).
    const [maintainerSet, rootAuthors] = await Promise.all([
      fetchMaintainerSet(project),
      fetchRootAuthors(project, rootIds),
    ]);
    // Wave 2: status fetch with the maintainer-supplied relay hints.
    const statusR = await fetchStatusEvents(project, refresh, rootIds, maintainerSet.relays);
    const maintainers = maintainerSet.pubkeys;
    const results = rootIds.map((rid) =>
      // Empty string when we couldn't resolve the root — preserves
      // pre-existing fall-through behaviour (maintainer-set still
      // authorises). 64-hex pubkeys can never equal '' so this is safe.
      computeEffectiveStatus(rid, rootAuthors.get(rid) ?? '', maintainers, statusR.events)
    );
    // ?debug=1 returns the raw signal we used to compute the result —
    // relays consulted, every 163x event we saw, the maintainer set,
    // and the resolved root-author map. Pasted into a bug report this
    // collapses an entire diagnostic round-trip into one curl.
    if (u.searchParams.get('debug') === '1') {
      return json(res, 200, {
        results,
        cached: statusR.cached,
        debug: {
          coords:           decodeNgitRemote(project),
          relays:           statusR.relays,    // the EXACT list we queried
          announcement:     maintainerSet.relays,  // what the 30617 declared
          rawEventCount:    statusR.events.length,
          rawEvents:        statusR.events.map((e) => ({
            id: e.id, kind: e.kind, pubkey: e.pubkey, created_at: e.created_at,
            tags: e.tags,
          })),
          maintainers:      Array.from(maintainers),
          rootAuthors:      Object.fromEntries(rootAuthors),
        },
      });
    }
    return json(res, 200, { results, cached: statusR.cached });
  }

  // ── Status change (SSE) ─────────────────────────────────────────────
  if (statusMatch && method === 'POST') {
    if (!project.path) { streamExecError(res, req, 'project has no local path'); return true; }
    if (!findBin('ngit')) { streamExecError(res, req, 'ngit not found on PATH'); return true; }
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const args = buildStatusArgs(parsed);
    if (!args) {
      streamExecError(res, req,
        'invalid input: kind ∈ {patch,issue}, rootId hex, status ∈ {open,draft,closed,resolved}'); return true;
    }
    streamExec(
      { bin: 'ngit', args, env: { NO_COLOR: '1', TERM: 'dumb' } },
      res, req, project.path,
    );
    return true;
  }

  // ── Merge (SSE) ─────────────────────────────────────────────────────
  //
  // ngit 2.x's `pr merge` is announcement-only: it publishes a kind-1631
  // status event marking the PR as merged but does NOT actually perform
  // the git merge or push the merged refs. The empty `r: [""]` tag on
  // its published event is the smoking gun — no merge commit to
  // reference because no merge happened.
  //
  // So the merge route does the work explicitly in five phases:
  //   1. git fetch origin
  //   2. git checkout <default-branch>
  //   3. git merge --ff-only <pr-branch>
  //   4. git push origin <default-branch>
  //   5. ngit pr merge <rootId>           — announce on Nostr LAST,
  //                                          only after the actual
  //                                          merge succeeded
  //
  // Up-front validation catches everything that should fail with a
  // clear message rather than mid-flight: branch name shape, branch
  // exists locally, clean working tree, default-branch detection,
  // PR branch is not itself the default branch (no self-merge).
  if (mergeMatch && method === 'POST') {
    if (!project.path) { streamExecError(res, req, 'project has no local path'); return true; }
    if (!findBin('ngit')) { streamExecError(res, req, 'ngit not found on PATH'); return true; }
    const gitBin = findBin('git') || 'git';

    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }

    const rootId = typeof parsed.rootId === 'string' ? parsed.rootId.trim() : '';
    if (!/^[a-f0-9]{16,64}$/.test(rootId)) {
      streamExecError(res, req, 'invalid rootId'); return true;
    }

    // Branch name comes from the kind-1617 patch event's `branch-name`
    // tag (surfaced to the client via routes/patches.ts's detail
    // enrichment). Without it we don't know which local branch holds
    // the commits to integrate.
    const branchName = typeof parsed.branchName === 'string' ? parsed.branchName.trim() : '';
    if (!/^[A-Za-z][A-Za-z0-9._/-]{0,127}$/.test(branchName)) {
      streamExecError(res, req,
        'branchName required and must match the patch event\'s branch-name tag. ' +
        'If you opened this PR yourself, the dashboard should pass it automatically — try refreshing the Pull requests tab.');
      return true;
    }

    // Dirty-tree refusal. A merge into a dirty default branch would
    // either silently fail or clobber the user's WIP depending on what
    // git is in the mood for; we refuse loudly so they always know.
    try {
      const { stdout } = await execFileAsync(gitBin, ['status', '--porcelain'], {
        cwd: project.path, timeout: 5_000,
      });
      if (stdout.trim().length > 0) {
        streamExecError(res, req,
          'working tree has uncommitted changes — commit or stash before merging'); return true;
      }
    } catch (e: any) {
      streamExecError(res, req,
        `git status failed: ${(e?.stderr || e?.message || 'unknown').toString().slice(0, 160)}`); return true;
    }

    // PR branch must exist locally. For PRs the user opened via the
    // Submit PR CTA the branch will already be there; for incoming
    // PRs from contributors the user must Download first (ngit pr
    // checkout creates the branch).
    try {
      execFileSync(gitBin, ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], {
        cwd: project.path, stdio: ['ignore', 'ignore', 'ignore'], timeout: 5_000,
      });
    } catch {
      streamExecError(res, req,
        `branch '${branchName}' not found locally — click Download on the PR first (Pull requests tab) to check it out.`);
      return true;
    }

    // Default-branch detection. Same `git symbolic-ref` pattern as the
    // /ngit/proposal/new route. Falls back to 'main' if origin/HEAD
    // isn't published (rare; happens on freshly-init'd ngit repos
    // before the first push).
    let defaultBranch = 'main';
    try {
      const out = execFileSync(gitBin, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
        cwd: project.path, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
      }).toString().trim();
      if (out.startsWith('origin/')) defaultBranch = out.slice('origin/'.length);
    } catch { /* keep 'main' default */ }

    if (branchName === defaultBranch) {
      streamExecError(res, req,
        `'${branchName}' IS the default branch — nothing to merge into itself.`);
      return true;
    }

    // All pre-conditions passed. SSE-stream the five-phase flow.
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });
    const emit = (p: object) => { try { res.write(`data: ${JSON.stringify(p)}\n\n`); } catch {} };
    const env = { ...process.env, NO_COLOR: '1', TERM: 'dumb' };
    const cwd = project.path;
    let killed = false;
    req.on('close', () => { killed = true; });

    const runPhase = (label: string, bin: string, args: string[], timeoutMs = 60_000): Promise<number> =>
      new Promise((resolve) => {
        if (killed) return resolve(-1);
        emit({ line: `▸ ${label}`, stream: 'stdout' });
        const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env, cwd });
        const pipe = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
          for (const line of chunk.toString().split('\n')) {
            if (line.length) emit({ line, stream });
          }
        };
        child.stdout.on('data', pipe('stdout'));
        child.stderr.on('data', pipe('stderr'));
        child.on('error', (e) => {
          emit({ line: String(e.message || e), stream: 'stderr' });
          resolve(-1);
        });
        let resolved = false;
        const finish = (code: number) => { if (!resolved) { resolved = true; resolve(code); } };
        child.on('close', (code) => finish(code ?? -1));
        const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} finish(-2); }, timeoutMs);
        child.on('close', () => clearTimeout(timer));
      });

    try {
      // 1. Fetch so origin/<default-branch> reflects ground truth. If
      //    the default branch has advanced upstream since the user last
      //    synced, the ff-only merge in phase 3 will refuse — which is
      //    the right behavior. Sync first, retry the merge.
      const fetchCode = await runPhase('git fetch origin', 'git', ['fetch', 'origin']);
      if (fetchCode !== 0) {
        emit({ line: `git fetch failed (exit ${fetchCode}) — aborting before any state changes`, stream: 'stderr' });
        emit({ done: true, code: fetchCode });
        try { res.end(); } catch {}
        return true;
      }

      // 2. Checkout the default branch so the merge in step 3 lands
      //    there. ngit's broken pr-merge left HEAD on the PR branch;
      //    we put HEAD where it actually needs to be.
      const checkoutCode = await runPhase(
        `git checkout ${defaultBranch}`,
        'git', ['checkout', defaultBranch],
      );
      if (checkoutCode !== 0) {
        emit({ line: `git checkout ${defaultBranch} failed (exit ${checkoutCode}) — aborting before any state changes`, stream: 'stderr' });
        emit({ done: true, code: checkoutCode });
        try { res.end(); } catch {}
        return true;
      }

      // 3. ff-only merge. Refuses (and we surface) if the default
      //    branch has diverged from the PR branch's base — we don't
      //    silently fabricate merge commits the user didn't request.
      const mergeCode = await runPhase(
        `git merge --ff-only ${branchName}`,
        'git', ['merge', '--ff-only', branchName],
      );
      if (mergeCode !== 0) {
        emit({
          line: `merge failed (exit ${mergeCode}) — ${defaultBranch} likely diverged. Pull / sync first, then retry. No refs changed; you're back on ${defaultBranch}.`,
          stream: 'stderr',
        });
        emit({ done: true, code: mergeCode });
        try { res.end(); } catch {}
        return true;
      }

      // 4. Push the merged default branch to origin so the GRASP server
      //    (and every downstream consumer — gitworkshop, Shakespeare,
      //    next contributor to clone) sees the new state. Without this
      //    the merge is local-only and the dashboard's 'merged' badge
      //    is a lie.
      //
      //    Amber sign prompt fires here. 3-min timeout to accommodate
      //    the user's phone-tap round-trip + GRASP upload.
      const pushCode = await runPhase(
        `git push origin ${defaultBranch}`,
        'git', ['push', 'origin', defaultBranch],
        180_000,
      );
      if (pushCode !== 0) {
        emit({
          line: `push failed (exit ${pushCode}) — local ${defaultBranch} has the merge commit but origin doesn't. Try clicking Sync on the project card to retry the push.`,
          stream: 'stderr',
        });
        emit({ done: true, code: pushCode });
        try { res.end(); } catch {}
        return true;
      }

      // 5. Finally — announce on Nostr. We try to publish a kind-1631
      //    status event ourselves, AFTER the actual merge + push, so
      //    there's no inconsistent "announced as merged but no merge
      //    on GRASP" state (the exact bug ngit pr merge exhibits when
      //    invoked alone).
      //
      //    HOWEVER — when pushing to a nostr:// remote (phase 4),
      //    git-remote-nostr already publishes a kind-1631 itself as
      //    part of the protocol. By the time this phase runs, ngit
      //    detects the PR is already marked merged and exits 1 with
      //    "PR is already applied/merged" written to stderr. That's
      //    the happy path, not a failure: the announcement is on the
      //    network either way.
      //
      //    So this phase uses a custom inline spawn (rather than the
      //    shared runPhase helper) so we can both stream output AND
      //    detect the "already" marker in stderr. Exit 0 or "already"
      //    → emit success; anything else → propagate the exit code.
      emit({ line: `▸ ngit pr merge ${rootId}`, stream: 'stdout' });
      const announceResult: { code: number; alreadyMerged: boolean } =
        await new Promise((resolve) => {
          if (killed) return resolve({ code: -1, alreadyMerged: false });
          let alreadyMerged = false;
          const child = spawn('ngit', ['pr', 'merge', rootId], {
            stdio: ['ignore', 'pipe', 'pipe'], env, cwd,
          });
          const handle = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
            for (const line of chunk.toString().split('\n')) {
              if (!line.length) continue;
              if (/already\s+(applied|merged)/i.test(line)) alreadyMerged = true;
              emit({ line, stream });
            }
          };
          child.stdout.on('data', handle('stdout'));
          child.stderr.on('data', handle('stderr'));
          let resolved = false;
          const finish = (code: number) => {
            if (resolved) return;
            resolved = true;
            resolve({ code, alreadyMerged });
          };
          child.on('error', (e) => {
            emit({ line: String(e.message || e), stream: 'stderr' });
            finish(-1);
          });
          child.on('close', (code) => finish(code ?? -1));
          const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} finish(-2); }, 180_000);
          child.on('close', () => clearTimeout(timer));
        });

      if (announceResult.code === 0 || announceResult.alreadyMerged) {
        if (announceResult.alreadyMerged && announceResult.code !== 0) {
          // Helpful explanatory line so users reading the modal scrollback
          // understand WHY ngit said "already merged" — without it, the
          // last visible line is a scary "Error: PR is already
          // applied/merged" that we then magically treat as success.
          emit({
            line: '(merge announcement was already published by git-remote-nostr during the push — treating as success.)',
            stream: 'stdout',
          });
        }
        emit({ done: true, code: 0 });
      } else {
        emit({ done: true, code: announceResult.code });
      }
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
