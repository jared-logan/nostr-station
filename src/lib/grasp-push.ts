/**
 * GRASP direct per-host push — the "land it everywhere, like Shakespeare" path.
 *
 * Background. nostr-station's normal ngit push shells `git push origin HEAD`
 * against a `nostr://` remote and lets `git-remote-nostr` fan out. That helper
 * publishes the signed NIP-34 state event to the relays but can deliver the
 * git *pack* to only ONE of several GRASP git hosts (the others end up "behind
 * signed" in gitworkshop). Shakespeare's web client avoids this by doing the
 * fan-out itself: it publishes the announcement (30617) + signed state (30618)
 * to the relays, then pushes the pack to EVERY clone URL independently.
 *
 * This module reimplements that algorithm for nostr-station's Node stack. The
 * GRASP authorization model makes this possible without any HTTP auth
 * handshake: a GRASP server is a relay AND a git host at the same domain, and
 * it authorizes a git push by checking the pushed refs against a signed 30618
 * it received from the repo's pubkey. So the order is load-bearing — publish
 * the signed state FIRST, then push the pack to each host.
 *
 * The functions here are deliberately I/O-light and dependency-injected so the
 * orchestration (relay queries, signing, git spawning) stays in the route and
 * the ref/tag logic stays unit-testable. Mirrors Shakespeare's `nostrPush`
 * (src/lib/git.ts) tag-for-tag, plus nostr-station's canonical NIP-89 client
 * tag (the only divergence — GRASP hosts only read the d/HEAD/refs/* tags, so
 * an extra attribution tag is inert for push authorization).
 */

import { CLIENT_TAG } from './client-tag.js';

/** A git ref as a [shortName, objectId] pair. */
export type RefPair = [name: string, oid: string];

export interface LocalRefs {
  /** `git symbolic-ref --short HEAD`, or '' when HEAD is detached. */
  currentBranch: string;
  /** `git rev-parse HEAD` — used for the HEAD tag when detached. */
  headOid: string;
  /** refs/heads/* as [shortName, oid]. */
  branches: RefPair[];
  /** refs/tags/* as [shortName, oid]. */
  tags: RefPair[];
}

/**
 * Keep only the clone URLs we can actually `git push` to over HTTPS — the
 * GRASP git endpoints. Shakespeare pushes to every clone URL that parses as a
 * URL; we narrow to https:// because that's the transport `git` speaks to a
 * GRASP host (the `nostr://` forms are the helper's job, not ours). Deduped by
 * normalized href, order preserved. Pure.
 */
export function selectGraspCloneUrls(clone: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of clone) {
    if (typeof raw !== 'string') continue;
    const v = raw.trim();
    if (!v || !/^https:\/\//i.test(v)) continue;
    let href: string;
    try { href = new URL(v).href; } catch { continue; }
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(v);
  }
  return out;
}

/**
 * Build the kind-30618 repo-state tag set, announcing exactly the refs that
 * are — or will be, after this push — actually on the git hosts. nostr-station
 * pushes only the CURRENT branch's pack, so the deliverable set is:
 *
 *   {current branch, at its local oid}  ∪  {every branch the PRIOR state
 *   announced, kept at the prior oid}
 *
 * and the prior state's tags verbatim (we never deliver tags). This diverges
 * from Shakespeare's "announce every local branch" on purpose: agentic TUIs
 * (Claude Code, OpenCode) spin up throwaway `claude/*` branches constantly,
 * and announcing those local-only scratch branches — which were never pushed —
 * makes every one of them read as "differs / missing on git server" on the
 * sync badge. Forever. Announcing only what we deliver keeps the badge honest
 * with zero user-facing changes (Push/Sync behave identically).
 *
 * Why prior oids for non-current branches and NOT local oids: a contributor on
 * a feature branch may have local `main` ahead of the host's `main` (committed
 * locally, pushed only the feature). Announcing local `main`'s oid would pin a
 * commit the host doesn't have → drift. The host still holds the PRIOR oid for
 * every branch we didn't just push, so that's what we announce.
 *
 * Tag layout:
 *   - ['d', identifier]
 *   - HEAD: the prior state's HEAD if it still resolves within the announced
 *     branches (see validPreservedHead); else a symbolic ref to the current
 *     branch; else the detached HEAD oid. HEAD is the repo's default-branch
 *     pointer — owned by the announcement, not by whoever pushes — so we
 *     preserve it across pushes rather than retarget it to the pusher's branch.
 *   - one [refs/heads/<b>, oid] per announced branch
 *   - one [refs/tags/<t>, oid] per announced tag
 *   - the canonical NIP-89 client tag (attribution; ignored by GRASP hosts,
 *     which authorize against the d/HEAD/refs/* tags only)
 *
 * `priorStateTags` is the prior kind-30618's tags (null on the very first
 * publish, before any state exists — then we fall back to announcing every
 * local ref, the safe bootstrap, since nothing is yet established as scratch).
 * Pure; exported for tests.
 */
export function buildRepoStateTags(
  identifier: string,
  refs: LocalRefs,
  priorStateTags: string[][] | null = null,
): string[][] {
  // Parse the prior state into HEAD + announced branch/tag oid maps.
  let priorHead: string[] | null = null;
  const priorBranches = new Map<string, string>();
  const priorTags = new Map<string, string>();
  for (const t of priorStateTags ?? []) {
    if (!Array.isArray(t) || t.length < 2 || typeof t[0] !== 'string') continue;
    if (t[0] === 'HEAD') priorHead = t;
    else if (t[0].startsWith('refs/heads/')) priorBranches.set(t[0].slice('refs/heads/'.length), t[1]);
    else if (t[0].startsWith('refs/tags/'))  priorTags.set(t[0].slice('refs/tags/'.length), t[1]);
  }

  // Announced branch set: prior branches (at prior oids) with the current
  // branch upserted to its local oid. No prior state → announce every local
  // branch (bootstrap). Insertion order: prior branches first (stable across
  // pushes), then the current branch if it's new.
  const announceBranches = new Map<string, string>();
  if (priorStateTags) {
    for (const [name, oid] of priorBranches) announceBranches.set(name, oid);
    const localCurrent = refs.branches.find(([n]) => n === refs.currentBranch);
    const currentOid = localCurrent ? localCurrent[1] : refs.headOid;
    if (refs.currentBranch && currentOid) announceBranches.set(refs.currentBranch, currentOid);
  } else {
    for (const [name, oid] of refs.branches) if (name && oid) announceBranches.set(name, oid);
  }

  // Announced tag set: prior tags verbatim (we never deliver tags, so a local
  // tag never pushed must not be announced). No prior → all local tags.
  const announceTags = new Map<string, string>();
  if (priorStateTags) {
    for (const [name, oid] of priorTags) announceTags.set(name, oid);
  } else {
    for (const [name, oid] of refs.tags) if (name && oid) announceTags.set(name, oid);
  }

  const tags: string[][] = [['d', identifier]];

  const preserved = validPreservedHead(priorHead, announceBranches, announceTags);
  if (preserved) {
    tags.push(preserved);
  } else if (refs.currentBranch) {
    tags.push(['HEAD', `ref: refs/heads/${refs.currentBranch}`]);
  } else if (refs.headOid) {
    tags.push(['HEAD', refs.headOid]);
  }

  for (const [name, oid] of announceBranches) if (name && oid) tags.push([`refs/heads/${name}`, oid]);
  for (const [name, oid] of announceTags)     if (name && oid) tags.push([`refs/tags/${name}`, oid]);
  tags.push([...CLIENT_TAG]);
  return tags;
}

/**
 * A prior state's HEAD tag is preservable only while it still points at
 * something the new state ANNOUNCES:
 *   - symbolic ('ref: refs/heads/X') → X must be among the announced branches
 *     (a renamed/deleted/no-longer-announced default must not ride forever);
 *   - detached oid → must equal an announced branch/tag tip. An ancestor
 *     commit can't be verified without git access, and a NIP-34 repo HEAD
 *     pinned to a non-tip is not a state ngit/gitworkshop ever produce — so
 *     fall back to the current branch rather than risk announcing a
 *     rebased-away commit.
 * Returns a fresh copy of the tag when valid, null when the caller should
 * fall back. Pure; exported for tests.
 */
export function validPreservedHead(
  head: string[] | null,
  announceBranches: Map<string, string>,
  announceTags: Map<string, string>,
): string[] | null {
  if (!head || head.length < 2 || head[0] !== 'HEAD' || typeof head[1] !== 'string') return null;
  const v = head[1];
  const SYMBOLIC = 'ref: refs/heads/';
  if (v.startsWith(SYMBOLIC)) {
    return announceBranches.has(v.slice(SYMBOLIC.length)) ? [...head] : null;
  }
  const tipOids = new Set<string>([...announceBranches.values(), ...announceTags.values()]);
  return tipOids.has(v) ? [...head] : null;
}

/**
 * Order-insensitive equality of two tag sets. Used to skip a fresh signing
 * round-trip (an Amber prompt) when the local refs already match the published
 * state — same optimization Shakespeare makes with `areTagsEqual`. Client tags
 * are excluded from the comparison: they're attribution, not state, so a
 * published 30618 that predates (or differs only in) the client tag is still
 * reusable — re-signing just to stamp it would cost a needless prompt. Pure.
 */
export function repoStateTagsEqual(a: string[][], b: string[][]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const norm = (tags: string[][]) =>
    tags.filter((t) => t[0] !== 'client').map((t) => JSON.stringify(t)).sort();
  const na = norm(a);
  const nb = norm(b);
  return na.length === nb.length && na.every((v, i) => v === nb[i]);
}

/**
 * Read the local refs needed to build a 30618 state event. `run` executes a
 * git invocation in the repo and returns stdout (injected so this is testable
 * and so the caller controls the git binary / cwd / timeout). The branch and
 * tag readers use NUL-separated for-each-ref so unusual ref names survive.
 *
 * `objectname` (not `objectname:short` / peeled) is intentional: it's the oid
 * the ref points at directly, matching what isomorphic-git's `resolveRef`
 * returns for the same ref — so an annotated tag records its tag-object oid,
 * exactly like Shakespeare.
 */
export async function readLocalRefs(
  run: (args: string[]) => Promise<string>,
): Promise<LocalRefs> {
  let currentBranch = '';
  try {
    currentBranch = (await run(['symbolic-ref', '--short', 'HEAD'])).trim();
  } catch {
    currentBranch = ''; // detached HEAD
  }

  let headOid = '';
  try {
    headOid = (await run(['rev-parse', 'HEAD'])).trim();
  } catch {
    headOid = '';
  }

  const readRefs = async (prefix: string): Promise<RefPair[]> => {
    let out = '';
    try {
      out = await run(['for-each-ref', '--format=%(refname:short)%00%(objectname)', prefix]);
    } catch {
      return [];
    }
    return out
      .split('\n')
      .filter(Boolean)
      .map((line): RefPair | null => {
        const [name, oid] = line.split('\0');
        if (!name || !oid) return null;
        return [name.trim(), oid.trim()];
      })
      .filter((p): p is RefPair => p !== null);
  };

  return {
    currentBranch,
    headOid,
    branches: await readRefs('refs/heads'),
    tags:     await readRefs('refs/tags'),
  };
}
