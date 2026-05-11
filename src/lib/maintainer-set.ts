/**
 * Maintainer-set resolver — Phase 5 of the ngit-suite expansion.
 *
 * Implements the NIP-34 anti-scam rule from
 *   https://raw.githubusercontent.com/DanConwayDev/ngit-cli/master/
 *   docs/architecture/maintainer-model.md
 *
 * The threat: a kind-30617 announcement at coordinate
 *   30617:<trustedPubkey>:<identifier>
 * can list other pubkeys in its `maintainers` tag. Phase 4 trusted
 * that list verbatim, which means a malicious 30617 could claim a
 * reputable pubkey as a co-maintainer — and any status / state event
 * signed by that pubkey would silently flow through our authority
 * check.
 *
 * The fix: only TRUST a claimed maintainer M when there exists a
 * second announcement at coordinate
 *   30617:<M>:<identifier>
 * — i.e. M has signed their own 30617 under the same identifier.
 * That second announcement may also list maintainers; we walk the
 * graph breadth-first, depth-capped, and split the visited set into
 *   verified        — published their own 30617 (or the trust anchor)
 *   candidatesOnly  — listed but no 30617 of their own found
 *
 * Phase 4 (and later: state events, clone-URL union) consume the
 * `verified` set only. `candidatesOnly` is surfaced in the UI as a
 * warning chip so the user knows about the claim without trusting it.
 *
 * Per the maintainer-model doc, when CONSUMING (browsing/cloning):
 *   - relays[] / clone[] / blossoms[] are UNIONED across each
 *     verified maintainer's own 30617 — this is how a co-maintainer's
 *     server gets discovered without the trust anchor having to know
 *     about it.
 *   - name / description / web / hashtags come from the 30617 with
 *     the latest created_at across the verified set.
 */
import { queryRelays, getTags, type NostrEvent } from './nostr-query.js';
import { isValidRelayUrl, getGraspServers } from './identity.js';

const MAX_DEPTH    = 3;            // hard cap on graph walks
const MAX_VISITED  = 32;           // total cap on pubkeys explored
const RELAY_TIMEOUT_MS = 8_000;

export interface MaintainerSet {
  /** Pubkeys who have signed their own 30617 under this identifier. */
  verified:       Set<string>;
  /** Pubkeys claimed as maintainers but who have no 30617 of their own. */
  candidatesOnly: Set<string>;
  /** Union of relay URLs across every verified 30617 (`relays` tag). */
  relays:         string[];
  /** Union of clone URLs across every verified 30617 (`clone` tag). */
  clone:          string[];
  /** Union of blossom server URLs (`blossoms` tag). */
  blossoms:       string[];
  /** Union of hashtags (`t` tag) across every verified 30617. */
  hashtags:       string[];
  /**
   * Display metadata from the verified 30617 with the largest
   * created_at. Defaults to the trust anchor's own 30617 when
   * available; null when no 30617 was findable at all.
   */
  display:        null | {
    name:        string;
    description: string;
    web:         string[];
    pubkey:      string;
    publishedAt: number;
  };
  /**
   * The raw 30617 events that produced the verified set, in the same
   * iteration order as `verified`. Surfaced so the UI can render
   * gitworkshop's "Announcement events" inspector — per-maintainer
   * row with timestamp, "selected" badge for the freshest event, and
   * a Raw event JSON viewer. NOT used for any compute decisions; pure
   * passthrough.
   */
  events:         NostrEvent[];
}

// ── Pure compute (exported for tests) ────────────────────────────────────

/**
 * Build a maintainer set from an in-memory index of 30617 events.
 *
 *   trustedPubkey  — the coordinate's root pubkey. Always verified
 *                    by definition (this is the trust anchor).
 *   identifier     — the `d` tag value that scopes the coordinate.
 *   index          — map from pubkey → that pubkey's 30617 event
 *                    at coordinate (pubkey, identifier). Missing
 *                    keys mean "no announcement found" — pubkey is
 *                    candidate-only when claimed by someone else.
 *
 * Algorithm:
 *   1. Seed the verified set with the trust anchor.
 *   2. BFS over `maintainers` tag values, depth-capped at MAX_DEPTH
 *      and visit-capped at MAX_VISITED to bound a malicious graph.
 *   3. Each claimed maintainer M:
 *        - has a 30617 in `index` → mark verified, enqueue ITS
 *          maintainers list for further walking;
 *        - else → mark candidate-only, do NOT walk further from it.
 *   4. Union relays / clone / blossoms / hashtags across verified.
 *   5. Pick display metadata from the freshest verified 30617.
 */
export function buildMaintainerSet(
  trustedPubkey: string,
  identifier: string,
  index: Map<string, NostrEvent>,
): MaintainerSet {
  const verified       = new Set<string>();
  const candidatesOnly = new Set<string>();
  const queue: { pubkey: string; depth: number }[] = [];
  const enqueued       = new Set<string>();
  let visits = 0;

  const enqueue = (pubkey: string, depth: number) => {
    if (enqueued.has(pubkey) || depth > MAX_DEPTH || visits >= MAX_VISITED) return;
    enqueued.add(pubkey);
    queue.push({ pubkey, depth });
  };

  // Step 1: trust anchor.
  enqueue(trustedPubkey, 0);

  // Step 2 + 3: BFS.
  while (queue.length > 0 && visits < MAX_VISITED) {
    const { pubkey, depth } = queue.shift()!;
    visits++;
    const ev = index.get(pubkey);
    if (!ev) {
      // Trust anchor without an event is impossible by construction
      // (caller should always provide it); for nested maintainers,
      // missing = unverified.
      if (pubkey !== trustedPubkey) candidatesOnly.add(pubkey);
      continue;
    }
    verified.add(pubkey);
    // Walk THIS maintainer's claimed co-maintainers (one hop deeper).
    for (const tag of getTags(ev, 'maintainers')) {
      for (const v of tag.slice(1)) {
        if (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) && v !== pubkey) {
          enqueue(v, depth + 1);
        }
      }
    }
  }

  // Anyone still in the queue past the visit cap is unresolved —
  // surface as candidate-only so the UI can flag them rather than
  // silently dropping. Defence-in-depth against a malicious graph
  // overflowing MAX_VISITED.
  while (queue.length > 0) {
    const { pubkey } = queue.shift()!;
    if (!verified.has(pubkey)) candidatesOnly.add(pubkey);
  }

  // Step 4: union across verified 30617s.
  const relays   = new Set<string>();
  const clone    = new Set<string>();
  const blossoms = new Set<string>();
  const hashtags = new Set<string>();
  for (const pk of verified) {
    const ev = index.get(pk);
    if (!ev) continue;
    for (const t of getTags(ev, 'relays')) {
      for (const v of t.slice(1)) if (typeof v === 'string' && v) relays.add(v);
    }
    for (const t of getTags(ev, 'clone')) {
      for (const v of t.slice(1)) if (typeof v === 'string' && v) clone.add(v);
    }
    for (const t of getTags(ev, 'blossoms')) {
      for (const v of t.slice(1)) if (typeof v === 'string' && v) blossoms.add(v);
    }
    for (const t of getTags(ev, 't')) {
      const v = t[1];
      if (typeof v === 'string' && v.length > 0 && v.length <= 64) hashtags.add(v);
    }
  }

  // Step 5: display metadata from the freshest verified 30617.
  let displayEv: NostrEvent | null = null;
  for (const pk of verified) {
    const ev = index.get(pk);
    if (!ev) continue;
    if (!displayEv || ev.created_at > displayEv.created_at) displayEv = ev;
  }
  let display: MaintainerSet['display'] = null;
  if (displayEv) {
    const nameTag = displayEv.tags.find((t) => t[0] === 'name')?.[1];
    const descTag = displayEv.tags.find((t) => t[0] === 'description')?.[1];
    const web: string[] = [];
    for (const t of getTags(displayEv, 'web')) {
      for (const v of t.slice(1)) if (typeof v === 'string' && v) web.push(v);
    }
    display = {
      name:        typeof nameTag === 'string' && nameTag ? nameTag : identifier,
      description: typeof descTag === 'string' ? descTag : '',
      web,
      pubkey:      displayEv.pubkey,
      publishedAt: displayEv.created_at,
    };
  }

  // Surface the raw 30617s for verified maintainers so the UI can
  // render gitworkshop's per-event inspector. Order: trust anchor
  // first (mirrors row order in the modal), then remaining verified
  // by descending created_at so the freshest event sits near the top.
  const events: NostrEvent[] = [];
  const seenEvents = new Set<string>();
  const anchorEv = index.get(trustedPubkey);
  if (anchorEv) { events.push(anchorEv); seenEvents.add(anchorEv.id); }
  const others = Array.from(verified)
    .filter((pk) => pk !== trustedPubkey)
    .map((pk) => index.get(pk))
    .filter((ev): ev is NostrEvent => !!ev)
    .sort((a, b) => b.created_at - a.created_at);
  for (const ev of others) {
    if (seenEvents.has(ev.id)) continue;
    seenEvents.add(ev.id);
    events.push(ev);
  }

  return {
    verified,
    candidatesOnly,
    relays:   Array.from(relays),
    clone:    Array.from(clone),
    blossoms: Array.from(blossoms),
    hashtags: Array.from(hashtags),
    display,
    events,
  };
}

// ── Resolver (relay-backed) ──────────────────────────────────────────────

/**
 * Resolve the maintainer set by querying relays for the trust
 * anchor's 30617 + every claimed maintainer's 30617 at the same
 * identifier. Returns a MaintainerSet computed via
 * buildMaintainerSet.
 *
 * The query strategy: ONE relay call with `kinds=[30617]`,
 * `authors=[trustedPubkey, ...claimed]`, `tags={d: identifier}`.
 * Relays return whatever they have; missing entries naturally
 * collapse to candidate-only. Subsequent BFS hops would require
 * additional relay round-trips for the new pubkeys discovered,
 * but in practice the depth=2 case (anchor lists A, A lists B)
 * is rare enough that we accept the bounded-completeness trade.
 * If/when a real repo needs deeper walks, this becomes a loop.
 */
export async function resolveMaintainerSet(
  trustedPubkey: string,
  identifier: string,
  relayHints: string[],
): Promise<MaintainerSet> {
  const grasp = getGraspServers();
  const relays = [...relayHints, ...grasp]
    .filter(isValidRelayUrl)
    .filter((r, i, a) => a.indexOf(r) === i)
    .slice(0, 8);

  // First hop: trust anchor's 30617.
  const anchorResult = await queryRelays({
    filter: { kinds: [30617], authors: [trustedPubkey], tags: { d: identifier }, limit: 1 },
    relays,
    timeoutMs: RELAY_TIMEOUT_MS,
    stream:    false,
    acceptUntil: (evs) => evs.length >= 1,
  });
  const index = new Map<string, NostrEvent>();
  let anchor: NostrEvent | null = null;
  for (const ev of anchorResult.events) {
    if (ev.kind !== 30617) continue;
    if (ev.pubkey !== trustedPubkey) continue;
    if (!anchor || ev.created_at > anchor.created_at) anchor = ev;
  }
  if (anchor) index.set(trustedPubkey, anchor);

  // Second hop: every claimed maintainer's own 30617 at the same
  // identifier. One query with `authors=[…]` covers them all.
  const claimed: string[] = [];
  if (anchor) {
    for (const t of getTags(anchor, 'maintainers')) {
      for (const v of t.slice(1)) {
        if (typeof v === 'string'
            && /^[0-9a-f]{64}$/.test(v)
            && v !== trustedPubkey
            && !claimed.includes(v)) {
          claimed.push(v);
        }
      }
    }
  }
  if (claimed.length > 0) {
    const r = await queryRelays({
      filter: { kinds: [30617], authors: claimed, tags: { d: identifier } },
      relays,
      timeoutMs: RELAY_TIMEOUT_MS,
      stream:    true,
    });
    // Keep latest per pubkey — addressable events can have multiple
    // versions returned by different relays.
    for (const ev of r.events) {
      if (ev.kind !== 30617) continue;
      const prev = index.get(ev.pubkey);
      if (!prev || ev.created_at > prev.created_at) index.set(ev.pubkey, ev);
    }
  }

  return buildMaintainerSet(trustedPubkey, identifier, index);
}
