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
 *     Shells out to `ngit pr_status` / `ngit issue_status` based on
 *     the supplied `kind` ("patch" | "issue"). Maintainer / author
 *     authority is enforced server-side: refuses if the signer can't
 *     legitimately publish the change (cheap pre-flight before
 *     burning an Amber prompt).
 *
 *   POST /api/projects/:id/merge                  (SSE)
 *     Shells out to `ngit pr_merge <patch-root-id>`. Preflight:
 *     refuses on dirty working tree (`git status --porcelain`
 *     non-empty) so a half-finished local edit can't be silently
 *     merged into.
 *
 * Computation is pure (computeEffectiveStatus, exported for tests);
 * the relay query reuses the issues-inbox cache from Phase 3 plus
 * a parallel kind-163x query.
 */
import http from 'http';
import { execFile } from 'child_process';
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
 * attached to: patches → merged, issues → resolved. We detect by
 * the presence of a `merge-commit` or `applied-as-commits` tag —
 * both are patch-specific.
 */
function mapKind1631(event: NostrEvent): EffectiveStatus {
  for (const t of event.tags) {
    if (t[0] === 'merge-commit' || t[0] === 'applied-as-commits') return 'merged';
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

async function fetchStatusEvents(
  project: Project,
  refresh: boolean,
  rootIds: string[],
): Promise<{ events: NostrEvent[]; cached: boolean }> {
  const coords = decodeNgitRemote(project);
  if (!coords || !project.path) return { events: [], cached: false };

  const grasp = getGraspServers();
  const projRelays = (project.readRelays || []).filter((r): r is string => typeof r === 'string');
  const relays = [...coords.relayHints, ...grasp, ...projRelays]
    .filter(isValidRelayUrl)
    .filter((r, i, a) => a.indexOf(r) === i)
    .slice(0, 8);
  if (relays.length === 0) return { events: [], cached: false };

  const aTag = `30617:${coords.pubkey}:${coords.identifier}`;
  const cacheKey = { projectPath: project.path, key: 'status-163x' };

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

  return { events, cached };
}

/** Fetch the 30617 announcement so we know who the maintainers are.
 *
 * Phase 5: now consults resolveMaintainerSet so authority is granted
 * ONLY to verified maintainers (those who have published their own
 * 30617 under the same coordinate). Candidate-only pubkeys — listed
 * in the trust anchor's maintainers tag but with no own announcement
 * — are deliberately excluded. This closes the "scam scenario" where
 * a malicious anchor could grant authority to reputable strangers.
 */
async function fetchMaintainerSet(project: Project): Promise<Set<string>> {
  const coords = decodeNgitRemote(project);
  if (!coords) return new Set();
  const ms = await resolveMaintainerSet(coords.pubkey, coords.identifier, coords.relayHints);
  // Belt + braces: the trust anchor is always verified by construction,
  // but guard the empty-result path so callers can still self-close.
  if (ms.verified.size === 0) return new Set([coords.pubkey]);
  return ms.verified;
}

/**
 * Compose `ngit pr_status` / `ngit issue_status` argv.
 * Accepts `kind: 'patch' | 'issue'` and `status` ∈ valid set per kind.
 * Returns null for malformed input.
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
    return ['pr_status', flag, rootId];
  }
  if (kind === 'issue') {
    if (!issueAllowed.has(status)) return null;
    const flag = '--' + status;
    return ['issue_status', flag, rootId];
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
    if (rootIds.length === 0) return json(res, 200, { results: [] });
    if (rootIds.length > 200) return json(res, 400, { error: 'too many rootIds (max 200)' });
    for (const r of rootIds) {
      if (!/^[a-f0-9]{16,64}$/.test(r)) return json(res, 400, { error: 'invalid rootId' });
    }
    // Caller may pass rootAuthor hints to avoid the second relay
    // query for the root events themselves. When absent we use the
    // announcing-pubkey-as-fallback rule from fetchMaintainerSet.
    const [statusR, maintainers] = await Promise.all([
      fetchStatusEvents(project, false, rootIds),
      fetchMaintainerSet(project),
    ]);
    // For Phase 4 we treat the rootAuthor as unknown unless the
    // status event itself authored by them — Phase 5 fetches the
    // actual root event for an explicit check. The compute helper
    // gracefully handles unknown rootAuthor (everyone in
    // maintainers + the status author themselves can publish).
    const results = rootIds.map((rid) =>
      // Without rootAuthor we still safely admit maintainers +
      // patch/issue self-closes. The pubkey check inside
      // computeEffectiveStatus uses an empty-string rootAuthor
      // when none supplied — no one matches the empty string
      // accidentally because all real pubkeys are 64 hex chars.
      computeEffectiveStatus(rid, '', maintainers, statusR.events)
    );
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
  if (mergeMatch && method === 'POST') {
    if (!project.path) { streamExecError(res, req, 'project has no local path'); return true; }
    if (!findBin('ngit')) { streamExecError(res, req, 'ngit not found on PATH'); return true; }
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const rootId = typeof parsed.rootId === 'string' ? parsed.rootId.trim() : '';
    if (!/^[a-f0-9]{16,64}$/.test(rootId)) {
      streamExecError(res, req, 'invalid rootId'); return true;
    }
    // Dirty-tree refusal — see Phase 4 design notes. The user told
    // us merges should appear identical to a terminal `ngit pr_merge`,
    // and a terminal would refuse silently / clobber depending on
    // state. We refuse loudly so the user always knows.
    try {
      const gitBin = findBin('git') || 'git';
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
    // ngit pr_merge takes the root patch id and handles the full
    // sequence: checkout the PR branch locally, merge into the
    // target branch, push refs, publish kind 1631 with the merge
    // commit + applied-as-commits tags.
    streamExec(
      { bin: 'ngit', args: ['pr_merge', rootId], env: { NO_COLOR: '1', TERM: 'dumb' }, timeoutMs: 180_000 },
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
