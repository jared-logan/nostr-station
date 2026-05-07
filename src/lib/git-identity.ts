// Auto-seed git identity for nostr-station-managed projects from the
// configured Nostr identity. Closes the "fresh VM trips on `git
// commit`" gap that Shakespeare doesn't have because it uses
// isomorphic-git in the browser (no system git involved).
//
// Scope: REPO-LOCAL config only — never touches `--global`. The
// trade-off is deliberate: auto-seeding global config would change
// every git operation on the user's machine forever after, even on
// repos that have nothing to do with nostr-station. Repo-local
// keeps the blast radius to projects nostr-station scaffolded or
// cloned itself, which is exactly the population that hit the
// "Author identity unknown" wall in real-world testing. Users with
// their own global identity preference are unaffected (repo-local
// config always wins anyway, but checking global first means we
// don't write a redundant copy).
//
// Values derived from identity.json's npub. We don't fetch kind-0
// metadata for a real name + nip-05 because (a) it requires a relay
// query that slows scaffold / clone, and (b) the goal is "git
// commit doesn't refuse" — synthetic identity is good enough to
// unblock that. Users who care override per-repo (`git config
// user.email "real@email.com"`) after; the auto-seed is idempotent
// so a re-run won't overwrite their choice.
//
// Email format: `<short-npub>@nostr.local` — `.local` is reserved
// per RFC 6762 so it can never be a real domain, and the npub
// prefix uniquely identifies the user without needing nip-05.

import { execFileSync } from 'child_process';
import type { Identity } from './identity.js';

export interface SeedResult {
  seeded: boolean;
  reason: string;        // human-readable status, surfaced in scaffold logs
}

// Pure function — derives a deterministic git identity from an npub.
// Exposed for testing; runtime callers go through
// seedRepoGitIdentityIfMissing.
export function deriveGitIdentity(npub: string): { name: string; email: string } {
  const trimmed = (npub || '').trim();
  if (!trimmed) {
    // Identity.json must always have an npub (setup wizard enforces),
    // but defensive default for the edge case.
    return { name: 'nostr-station user', email: 'noreply@nostr.local' };
  }
  // Truncate the npub to the bech32 body's first 12 chars after the
  // prefix — same shorthand the dashboard uses for npub display.
  // Long enough to be unique in practice, short enough to read in
  // `git log --pretty=full`.
  const short = trimmed.startsWith('npub1') && trimmed.length > 17
    ? trimmed.slice(0, 17)         // 'npub1' + 12 chars
    : trimmed.slice(0, 16);
  return {
    name:  short,
    email: `${short}@nostr.local`,
  };
}

// Check whether a repo has user.name + user.email available — checking
// repo-local first, then global. Returns true if BOTH are set somewhere
// reachable from the repo. We need both because git's `commit` errors
// when either is missing, regardless of the other.
function hasGitIdentity(repoPath: string): boolean {
  // `git config user.name` falls back through repo-local → global →
  // system, exit 0 if found at any layer, exit 1 if not. So one
  // command per field is enough.
  const probe = (key: string): boolean => {
    try {
      execFileSync('git', ['config', key], {
        cwd: repoPath, stdio: 'pipe', timeout: 1500,
      });
      return true;
    } catch { return false; }
  };
  return probe('user.name') && probe('user.email');
}

// Set the repo-local user.name + user.email if neither is currently
// available (locally or globally). Idempotent: if the user already has
// an identity from any layer, we don't write. Best-effort: failures
// during the writes are surfaced via `seeded: false` but never thrown
// — the worst case is the same "please tell me who you are" message
// the user would have seen pre-fix.
//
// The npub-derived identity makes commits attributable to the user
// in the local sense (they own this machine + this npub), without
// implying we know their real name or email — both fields use the
// `@nostr.local` domain, which is reserved and cannot resolve.
export function seedRepoGitIdentityIfMissing(
  repoPath: string,
  identity: Identity,
): SeedResult {
  if (hasGitIdentity(repoPath)) {
    return { seeded: false, reason: 'git identity already configured' };
  }
  if (!identity?.npub) {
    return { seeded: false, reason: 'no Nostr identity to derive from' };
  }
  const { name, email } = deriveGitIdentity(identity.npub);
  try {
    execFileSync('git', ['config', 'user.name', name], {
      cwd: repoPath, stdio: 'pipe', timeout: 1500,
    });
    execFileSync('git', ['config', 'user.email', email], {
      cwd: repoPath, stdio: 'pipe', timeout: 1500,
    });
  } catch (e: any) {
    return { seeded: false, reason: `git config write failed: ${(e?.message || 'unknown').slice(0, 120)}` };
  }
  return { seeded: true, reason: `seeded repo-local identity from npub (${name})` };
}
