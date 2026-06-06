/**
 * GRASP server sync state — the read-side counterpart to grasp-push.ts.
 *
 * gitworkshop.dev shows, next to a repo's branch selector, an "N/M servers
 * serving the Nostr state" badge: each GRASP server is "signed" when its git
 * host actually holds the commit the signed NIP-34 state (30618) points at,
 * and "behind signed" when it doesn't. nostr-station never computed this, so a
 * host left behind by a partial push (the bug grasp-push.ts fixes) was
 * invisible here.
 *
 * The comparison is: the authoritative signed `30618` oid for a branch vs. the
 * oid each GRASP git host actually advertises (`git ls-remote`). Match →
 * in-sync; differ → out-of-sync; no answer → unreachable. The functions here
 * are pure (parse + compare) so the route just supplies ls-remote output and
 * the signed state; ancestry-based behind/ahead is intentionally out of scope
 * for this first cut (see the "differs" label).
 */

export type GraspSync =
  | 'in-sync'      // host holds the signed commit ("signed")
  | 'behind'       // host's commit is an ancestor of the signed commit
  | 'ahead'        // signed commit is an ancestor of the host's commit
  | 'diverged'     // neither is an ancestor of the other
  | 'differs'      // host differs but ancestry can't be determined locally
  | 'missing'      // ls-remote 404 / wrong path — "no git data"
  | 'unreachable'  // ls-remote network failure
  | 'unknown';     // repo has no signed state (30618) yet

/** Ancestry of one oid relative to another, from `git merge-base --is-ancestor`:
 *  'yes' (is an ancestor), 'no' (both valid, not an ancestor), 'unknown' (an
 *  oid isn't a local object so the relation can't be computed). */
export type Ancestry = 'yes' | 'no' | 'unknown';

/** A ref whose oid is not agreed across the signed state + reachable servers. */
export interface RefDivergence {
  ref:     string;                                  // full ref name (refs/heads/x, refs/tags/y)
  signed:  string | null;                           // short oid the signed state pins (null = absent)
  servers: { host: string; has: string | null }[]; // short oid each server holds (null = absent)
}

/**
 * Parse `git ls-remote <url> [<ref>]` output into a ref→oid map. Lines are
 * `<oid>\t<refname>`. Peeled tag rows (`refs/tags/x^{}`) are dropped so the tag
 * ref maps to the tag object, matching what the announcement's state records.
 * Pure.
 */
export function parseLsRemote(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([0-9a-f]{40})\s+(.+)$/i);
    if (!m) continue;
    const ref = m[2].trim();
    if (ref.endsWith('^{}')) continue;       // peeled tag — skip
    if (!map.has(ref)) map.set(ref, m[1].toLowerCase());
  }
  return map;
}

/**
 * The oid a signed 30618 state pins for a full ref name (e.g.
 * `refs/heads/main`). Returns null when the state doesn't carry that ref.
 * Pure.
 */
export function stateOidForRef(stateTags: string[][], ref: string): string | null {
  for (const t of stateTags) {
    if (Array.isArray(t) && t[0] === ref && typeof t[1] === 'string'
        && /^[0-9a-f]{40}$/i.test(t[1])) {
      return t[1].toLowerCase();
    }
  }
  return null;
}

/**
 * The default branch a 30618 advertises via its symbolic HEAD tag
 * (`['HEAD', 'ref: refs/heads/<branch>']`). Returns null for a detached/oid
 * HEAD or when absent. Pure.
 */
export function defaultBranchFromState(stateTags: string[][]): string | null {
  for (const t of stateTags) {
    if (Array.isArray(t) && t[0] === 'HEAD' && typeof t[1] === 'string') {
      const m = t[1].match(/^ref:\s*refs\/heads\/(.+)$/);
      if (m) return m[1].trim();
    }
  }
  return null;
}

/**
 * Coarse classification of a REACHABLE host against the signed state for a
 * branch (reachability + the 404 case are handled by the caller → 'unreachable'
 * / 'missing'):
 *   - signedOid === null → unknown (repo has no signed state yet)
 *   - oids equal         → in-sync ("signed")
 *   - otherwise          → differs (the caller refines to behind/ahead/diverged
 *                          via ancestry when both commits are available locally)
 * Pure.
 */
export function compareServerRef(hostOid: string | null, signedOid: string | null): GraspSync {
  if (signedOid === null) return 'unknown';
  if (hostOid === null)   return 'differs';
  return hostOid.toLowerCase() === signedOid.toLowerCase() ? 'in-sync' : 'differs';
}

/**
 * Refine a 'differs' host into behind / ahead / diverged using two ancestry
 * probes against the signed commit:
 *   - hostIsAncestorOfSigned 'yes' → behind (host older)
 *   - signedIsAncestorOfHost 'yes' → ahead  (host newer)
 *   - both 'no'                     → diverged
 *   - any 'unknown' (an oid not present locally) → 'differs' (best we can say)
 * Pure.
 */
export function classifyDrift(hostIsAncestorOfSigned: Ancestry, signedIsAncestorOfHost: Ancestry): GraspSync {
  if (hostIsAncestorOfSigned === 'yes') return 'behind';
  if (signedIsAncestorOfHost === 'yes') return 'ahead';
  if (hostIsAncestorOfSigned === 'no' && signedIsAncestorOfHost === 'no') return 'diverged';
  return 'differs';
}

/**
 * Classify why an `ls-remote` failed from git's stderr/message:
 *   - a 404 / "repository not found" / "not found" → 'missing'
 *     (wrong path or the repo was never pushed to this host — gitworkshop's
 *     "no git data — wrong path or 404")
 *   - anything else (timeout, DNS, connection refused, TLS) → 'unreachable'
 * Pure.
 */
export function classifyLsRemoteFailure(message: string): 'missing' | 'unreachable' {
  const m = (message || '').toLowerCase();
  if (/\b404\b|not found|repository not found|does not exist|no such repos/.test(m)) {
    return 'missing';
  }
  return 'unreachable';
}

/** All concrete refs (refs/heads/*, refs/tags/*) a signed 30618 pins, as a
 *  ref→oid map. Skips the symbolic HEAD and the `d` tag. Pure. */
export function stateRefMap(stateTags: string[][]): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of stateTags) {
    if (!Array.isArray(t) || typeof t[0] !== 'string' || typeof t[1] !== 'string') continue;
    if (!t[0].startsWith('refs/')) continue;
    if (!/^[0-9a-f]{40}$/i.test(t[1])) continue;
    map.set(t[0], t[1].toLowerCase());
  }
  return map;
}

/**
 * Refs — OTHER than the displayed branch — whose oid isn't agreed across the
 * signed state and the reachable servers. Drives gitworkshop's "N other ref
 * differs across servers" rollup. A ref "differs" when the distinct non-null
 * oids among {signed} ∪ {reachable servers that carry it} number more than one.
 * Servers that failed (`map: null`) are ignored. Pure; sorted by ref name.
 */
export function otherRefDivergence(
  servers: { host: string; map: Map<string, string> | null }[],
  signedRefs: Map<string, string>,
  branchRef: string,
): RefDivergence[] {
  const refs = new Set<string>();
  for (const k of signedRefs.keys()) refs.add(k);
  for (const s of servers) if (s.map) for (const k of s.map.keys()) refs.add(k);
  refs.delete(branchRef);
  refs.delete('HEAD');

  const short = (oid: string | null) => (oid ? oid.slice(0, 8) : null);
  const out: RefDivergence[] = [];
  for (const ref of [...refs].sort()) {
    if (!ref.startsWith('refs/')) continue;
    const signed = signedRefs.get(ref) ?? null;
    const perServer = servers.map((s) => ({ host: s.host, has: s.map ? (s.map.get(ref) ?? null) : null }));
    const distinct = new Set<string>();
    if (signed) distinct.add(signed);
    for (const ps of perServer) if (ps.has) distinct.add(ps.has);
    if (distinct.size > 1) {
      out.push({ ref, signed: short(signed), servers: perServer.map((ps) => ({ host: ps.host, has: short(ps.has) })) });
    }
  }
  return out;
}
