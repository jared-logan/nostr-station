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
 * Build the kind-30618 repo-state tag set from the local checkout, mirroring
 * Shakespeare's `nostrPush` exactly:
 *   - ['d', identifier]
 *   - HEAD: if the existing state already pins a HEAD, preserve it verbatim;
 *     else a symbolic ref to the current branch; else the detached HEAD oid.
 *   - one [refs/heads/<b>, oid] per local branch
 *   - one [refs/tags/<t>, oid] per local tag
 *   - the canonical NIP-89 client tag (attribution; ignored by GRASP hosts,
 *     which authorize against the d/HEAD/refs/* tags only)
 *
 * Preserving the existing HEAD matters: HEAD is the repo's "default branch"
 * pointer and is owned by the announcement, not by whoever happens to push —
 * clobbering it on every push would let a contributor on a feature branch
 * silently retarget the repo's default. Pure.
 */
export function buildRepoStateTags(
  identifier: string,
  refs: LocalRefs,
  existingHeadTag: string[] | null = null,
): string[][] {
  const tags: string[][] = [['d', identifier]];

  if (existingHeadTag && existingHeadTag.length >= 2) {
    tags.push([...existingHeadTag]);
  } else if (refs.currentBranch) {
    tags.push(['HEAD', `ref: refs/heads/${refs.currentBranch}`]);
  } else if (refs.headOid) {
    tags.push(['HEAD', refs.headOid]);
  }

  for (const [name, oid] of refs.branches) {
    if (name && oid) tags.push([`refs/heads/${name}`, oid]);
  }
  for (const [name, oid] of refs.tags) {
    if (name && oid) tags.push([`refs/tags/${name}`, oid]);
  }
  tags.push([...CLIENT_TAG]);
  return tags;
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
