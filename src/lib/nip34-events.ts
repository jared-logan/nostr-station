/**
 * Native NIP-34 / NIP-22 event builders — replaces the ngit-CLI
 * shell-outs for issue creation, comments, and status changes so the
 * published events carry nostr-station's canonical NIP-89 client tag
 * (the CLI can't emit custom tags).
 *
 * Every tag shape here mirrors ngit-cli's Rust builders EXACTLY —
 * gitworkshop.dev must render our events identically to ngit's. Each
 * tag is annotated with the ngit source file it was verified against
 * (full clone at the time of writing: ngit-cli @ nostr crate 0.44).
 *
 * Key serialization facts inherited from rust-nostr 0.44 (and visible
 * in real ngit-published events, e.g. the blip merge 1631):
 *   - TagStandard::Coordinate { relay_url: None }  → ["a", "<coord>"]
 *     (2 elements — NO relay hint; ngit's repo_ref.coordinates()
 *     builds Nip19Coordinate with `relays: vec![]`, repo_ref.rs:307-329,
 *     so `coord.relays.first()` is always None).
 *   - TagStandard::Event { relay_url, marker: Root } →
 *     ["e", "<id>", "<relay-or-''>", "root"] — the relay slot is an
 *     EMPTY STRING placeholder when no relay hint exists, because the
 *     marker still has to land in position 3.
 *   - Tag::public_key(pk)                          → ["p", "<hex>"]
 *   - TagStandard::Reference(root_commit)          → ["r", "<commit>"]
 *     (emitted even when root_commit is the empty string).
 *
 * All builders are PURE (no I/O, no identity reads); the routes fetch
 * repo metadata / root events and pass them in. Each template is
 * stamped with the canonical client tag via stampClientTag.
 */
import { stampClientTag } from './client-tag.js';

// ── Kinds (NIP-34 / NIP-22) ─────────────────────────────────────────────

/** kind 1621 — git issue (ngit: nostr Kind::GitIssue). */
export const KIND_GIT_ISSUE = 1621;
/** kind 1111 — NIP-22 comment (ngit: git_events.rs:117 `KIND_COMMENT`). */
export const KIND_GIT_COMMENT = 1111;

/**
 * Status verb → event kind. Verified against ngit's use of the nostr
 * crate kinds (issue_status.rs / pr_status.rs launch_* entry points):
 *   Kind::GitStatusOpen    = 1630  (pr_status.rs:200-206 launch_reopen/launch_ready,
 *                                   issue_status.rs:186-188 launch_reopen)
 *   Kind::GitStatusApplied = 1631  (issue_status.rs:190-192 launch_resolved —
 *                                   "resolved" for issues; the pr merge flow
 *                                   uses the same kind for "applied/merged")
 *   Kind::GitStatusClosed  = 1632  (pr_status.rs:196-198 / issue_status.rs:182-184)
 *   Kind::GitStatusDraft   = 1633  (pr_status.rs:208-217 launch_draft — patches only)
 */
export const STATUS_KIND_BY_VERB: Record<StatusVerb, number> = {
  open:     1630,
  resolved: 1631,
  closed:   1632,
  draft:    1633,
};

export type StatusVerb   = 'open' | 'draft' | 'closed' | 'resolved';
export type StatusTarget = 'patch' | 'issue';

// ── Inputs ──────────────────────────────────────────────────────────────

/** Unsigned event template — what signEventWithSavedBunker consumes. */
export interface Nip34EventTemplate {
  kind:       number;
  created_at: number;
  tags:       string[][];
  content:    string;
}

/**
 * The slice of the repo announcement the builders need — ngit's
 * RepoRef equivalent. `maintainers` must be hex pubkeys with the trust
 * anchor (announcement signer) FIRST (parseRepoAnnouncement's shape).
 */
export interface RepoRefInfo {
  /** d-tag of the 30617 coordinate. */
  identifier:  string;
  /** Hex pubkeys; trust anchor first; deduped by the builder anyway. */
  maintainers: string[];
  /** Announcement `relays` tag values — first entry is THE relay hint. */
  relays:      string[];
  /** Earliest-unique-commit (the announcement's `r …  euc` value).
   *  Empty string when unknown — ngit emits `["r", ""]` in that case. */
  euc?:        string;
}

/** Minimal reference to an existing event (root / parent of a comment). */
export interface EventRefInfo {
  id:     string;
  kind:   number;
  pubkey: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Repo coordinate `a` tags — one per maintainer, trust anchor first,
 * deduped, NO relay hint.
 *
 * ngit: repo_ref.coordinates() (repo_ref.rs:307-329) returns a
 * coordinate for the trusted maintainer plus every listed maintainer
 * with `relays: vec![]`, so `coord.relays.first().cloned()` is None at
 * every call site (issue_create.rs:53-59, pr_status.rs:152-162,
 * issue_status.rs:142-152) and the serialized tag is the bare
 * 2-element ["a", "30617:<pubkey>:<identifier>"].
 */
export function repoCoordinateTags(repo: RepoRefInfo): string[][] {
  const seen = new Set<string>();
  const tags: string[][] = [];
  for (const pk of repo.maintainers) {
    if (typeof pk !== 'string' || !HEX64.test(pk) || seen.has(pk)) continue;
    seen.add(pk);
    tags.push(['a', `30617:${pk}:${repo.identifier}`]);
  }
  return tags;
}

// ── Issue (kind 1621) ──────────────────────────────────────────────────

/**
 * Build an unsigned kind-1621 GitIssue template.
 *
 * Tag set mirrors ngit issue_create.rs:44-83, in ngit's order:
 *   1. `a` repo coordinate per maintainer       (issue_create.rs:52-59)
 *   2. ["subject", <title>]                     (issue_create.rs:61-62)
 *   3. ["t", <label>] per label                 (issue_create.rs:64-67)
 *   4. ["alt", "git issue: <title>"]            (issue_create.rs:69-73)
 *   5. ["p", <maintainer>] per maintainer       (issue_create.rs:75-78)
 *   6. canonical NIP-89 client tag (nostr-station addition — the whole
 *      reason this native path exists)
 *
 * Content is the issue body (markdown). We do NOT replicate ngit's
 * tags_from_content NIP-21 mention extraction (issue_create.rs:80-82)
 * — it only adds q/p tags when the body embeds nostr: URIs.
 */
export function buildIssueTemplate(
  repo:  RepoRefInfo,
  input: { title: string; body?: string; labels?: string[] },
): Nip34EventTemplate {
  const tags: string[][] = repoCoordinateTags(repo);
  tags.push(['subject', input.title]);
  for (const label of input.labels || []) {
    tags.push(['t', label]);
  }
  tags.push(['alt', `git issue: ${input.title}`]);
  const seenP = new Set<string>();
  for (const pk of repo.maintainers) {
    if (!HEX64.test(pk) || seenP.has(pk)) continue;
    seenP.add(pk);
    tags.push(['p', pk]);
  }
  stampClientTag(tags);
  return {
    kind:       KIND_GIT_ISSUE,
    created_at: nowSeconds(),
    tags,
    content:    input.body || '',
  };
}

// ── Comment (kind 1111, NIP-22) ────────────────────────────────────────

/**
 * Build an unsigned kind-1111 NIP-22 comment template.
 *
 * Tag set mirrors ngit comment.rs publish_comment (comment.rs:108-136),
 * in ngit's order — relay_hint is `repo_ref.relays.first()` or the
 * EMPTY STRING (comment.rs:99-103 `unwrap_or_default`):
 *   1. ["E", <root-id>, <relay-hint>, <root-pubkey>]   (comment.rs:110-116)
 *   2. ["K", "<root-kind>"]                            (comment.rs:117-118)
 *   3. ["P", <root-pubkey>, <relay-hint>]              (comment.rs:119-124)
 *   4. ["e", <parent-id>, <relay-hint>, <parent-pubkey>] (comment.rs:125-131)
 *   5. ["k", "<parent-kind>"]                          (comment.rs:132-133)
 *   6. ["p", <parent-pubkey>, <relay-hint>]            (comment.rs:135)
 *   7. canonical NIP-89 client tag (nostr-station addition)
 *
 * Note: ngit comments carry NO repo `a` coordinate and NO maintainer
 * p-tags — only the six NIP-22 threading tags (plus content mentions,
 * which we don't replicate; see buildIssueTemplate).
 *
 * For a TOP-LEVEL comment the parent IS the root (comment.rs:90-93).
 */
export function buildCommentTemplate(
  repo:  RepoRefInfo,
  input: { root: EventRefInfo; parent: EventRefInfo; body: string },
): Nip34EventTemplate {
  const relayHint = repo.relays.find((r) => typeof r === 'string' && r.length > 0) ?? '';
  const { root, parent } = input;
  const tags: string[][] = [
    ['E', root.id, relayHint, root.pubkey],
    ['K', String(root.kind)],
    ['P', root.pubkey, relayHint],
    ['e', parent.id, relayHint, parent.pubkey],
    ['k', String(parent.kind)],
    ['p', parent.pubkey, relayHint],
  ];
  stampClientTag(tags);
  return {
    kind:       KIND_GIT_COMMENT,
    created_at: nowSeconds(),
    tags,
    content:    input.body,
  };
}

/**
 * Top-level comment on an ISSUE: root == parent, root kind is 1621.
 * Mirrors ngit comment.rs launch_issue_comment (comment.rs:218-261),
 * which pins `root_kind: Kind::GitIssue` (comment.rs:251) and passes
 * `reply_to: None` for top-level → parent == root (comment.rs:90-93).
 */
export function buildIssueCommentTemplate(
  repo:  RepoRefInfo,
  input: { issueId: string; issuePubkey: string; body: string },
): Nip34EventTemplate {
  const root: EventRefInfo = {
    id:     input.issueId,
    kind:   KIND_GIT_ISSUE,
    pubkey: input.issuePubkey,
  };
  return buildCommentTemplate(repo, { root, parent: root, body: input.body });
}

// ── Status (kinds 1630-1633) ───────────────────────────────────────────

/**
 * The `alt` copy ngit stamps per (target, verb) — pr_status.rs:120-126
 * for patches, issue_status.rs:112-117 for issues. The status.ts
 * 1631-disambiguation heuristic (mapKind1631) keys off this copy, so
 * the strings must match ngit byte-for-byte.
 */
export function statusAltText(target: StatusTarget, verb: StatusVerb): string {
  if (target === 'patch') {
    switch (verb) {
      case 'open':   return 'PR reopened';            // pr_status.rs:121
      case 'closed': return 'PR closed';              // pr_status.rs:122
      case 'draft':  return 'PR marked as draft';     // pr_status.rs:123
      default:       return 'PR status updated';      // pr_status.rs:125
    }
  }
  switch (verb) {
    case 'open':     return 'issue reopened';         // issue_status.rs:113
    case 'closed':   return 'issue closed';           // issue_status.rs:114
    case 'resolved': return 'issue resolved';         // issue_status.rs:115
    default:         return 'issue status updated';   // issue_status.rs:116
  }
}

/**
 * Build an unsigned kind-163x status template.
 *
 * Tag set mirrors ngit pr_status.rs:135-167 / issue_status.rs:125-157
 * (the two are tag-for-tag identical), in ngit's order:
 *   1. ["alt", <copy>]                          (pr_status.rs:139-142)
 *   2. ["e", <root-id>, <relay-hint>, "root"]   (pr_status.rs:143-149 —
 *      TagStandard::Event with marker Root; relay_url is
 *      repo_ref.relays.first(), serialized as '' when absent)
 *   3. ["p", <pubkey>] per maintainer + the root author
 *      (pr_status.rs:129-131 builds the HashSet from maintainers +
 *      proposal.pubkey, then :151 emits Tag::public_key per entry; the
 *      HashSet order is nondeterministic in Rust — we emit maintainers
 *      in announcement order, root author appended if not already in)
 *   4. ["a", <coordinate>] per maintainer       (pr_status.rs:152-162)
 *   5. ["r", <root-commit>]                     (pr_status.rs:163-165 —
 *      TagStandard::Reference(repo_ref.root_commit); EMPTY STRING when
 *      the repo has no euc, which is what real ngit 1631s show)
 *   6. canonical NIP-89 client tag (nostr-station addition)
 *
 * Content is the optional human reason (pr_status.rs:133 — '' default).
 */
export function buildStatusTemplate(
  repo:  RepoRefInfo,
  input: {
    target:      StatusTarget;
    verb:        StatusVerb;
    rootId:      string;
    /** Root event's author — gets a p tag like ngit's. '' = unknown (omitted). */
    rootAuthor?: string;
    reason?:     string;
  },
): Nip34EventTemplate {
  const relayHint = repo.relays.find((r) => typeof r === 'string' && r.length > 0) ?? '';
  const tags: string[][] = [
    ['alt', statusAltText(input.target, input.verb)],
    ['e', input.rootId, relayHint, 'root'],
  ];
  const seenP = new Set<string>();
  const pTagPubkeys = [...repo.maintainers];
  if (input.rootAuthor && HEX64.test(input.rootAuthor)) pTagPubkeys.push(input.rootAuthor);
  for (const pk of pTagPubkeys) {
    if (!HEX64.test(pk) || seenP.has(pk)) continue;
    seenP.add(pk);
    tags.push(['p', pk]);
  }
  for (const t of repoCoordinateTags(repo)) tags.push(t);
  tags.push(['r', repo.euc ?? '']);
  stampClientTag(tags);
  return {
    kind:       STATUS_KIND_BY_VERB[input.verb],
    created_at: nowSeconds(),
    tags,
    content:    input.reason ?? '',
  };
}
