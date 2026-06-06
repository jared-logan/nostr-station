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

export type GraspSync = 'in-sync' | 'out-of-sync' | 'unreachable' | 'unknown';

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
 * Classify a single GRASP git host against the signed state for a branch:
 *   - hostOid === null            → unreachable (ls-remote failed / no such ref)
 *   - signedOid === null          → unknown (repo has no signed state yet)
 *   - oids equal                  → in-sync ("signed")
 *   - oids differ                 → out-of-sync ("behind signed")
 * Pure.
 */
export function compareServerRef(hostOid: string | null, signedOid: string | null): GraspSync {
  if (hostOid === null)   return 'unreachable';
  if (signedOid === null) return 'unknown';
  return hostOid.toLowerCase() === signedOid.toLowerCase() ? 'in-sync' : 'out-of-sync';
}
