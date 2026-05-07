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
// unblock that. Users who care override via Config → Git Identity
// (where they can pick from nip-05, npub-synthetic, or a custom
// name+email) — the seed is idempotent so a re-run after a manual
// override is a no-op.
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

export interface GitIdentity {
  name:  string;
  email: string;
}

export interface ResolvedGitIdentity extends GitIdentity {
  // Where the values came from: 'local' wins over 'global' wins over
  // 'unset'. The dashboard surfaces this in the project Settings row
  // so users see why their commits will be attributed the way they
  // are without having to drop to the terminal and run
  // `git config --show-origin user.email`.
  source: 'local' | 'global' | 'unset';
}

// Pure function — derives a deterministic npub-synthetic git identity.
// Exposed for testing + reuse by the Config-panel "Use my Nostr
// identity" preset.
export function deriveGitIdentity(npub: string): GitIdentity {
  const trimmed = (npub || '').trim();
  if (!trimmed) {
    return { name: 'nostr-station user', email: 'noreply@nostr.local' };
  }
  // Truncate the npub to its prefix + 12 body chars — same shorthand
  // the dashboard uses for npub display. Long enough to be unique in
  // practice, short enough to read in `git log --pretty=full`.
  const short = trimmed.startsWith('npub1') && trimmed.length > 17
    ? trimmed.slice(0, 17)
    : trimmed.slice(0, 16);
  return { name: short, email: `${short}@nostr.local` };
}

// Check whether a repo has user.name + user.email available — checking
// repo-local first, then global. Returns true if BOTH are set
// somewhere reachable from the repo. We need both because git's
// `commit` errors when either is missing, regardless of the other.
function hasGitIdentity(repoPath: string): boolean {
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
// available (locally or globally). Idempotent: if the user already
// has an identity from any layer, we don't write. Best-effort:
// failures during the writes are surfaced via `seeded: false` but
// never thrown — the worst case is the same "please tell me who you
// are" message the user would have seen pre-fix.
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

// ── Read / write helpers used by the dashboard's UI ────────────────────────
//
// These are the API helpers the Config panel + project Settings row
// call into. Kept as pure-ish functions (they shell out to `git
// config` but otherwise have no side effects) so the route handlers
// stay focused on HTTP concerns and these helpers stay testable.

// Read the global git identity. Returns blanks (NOT null) for
// missing fields so the UI can render an empty form without
// branching. A non-existent `~/.gitconfig` returns blanks too.
export function readGlobalGitIdentity(): GitIdentity {
  const read = (key: string): string => {
    try {
      return execFileSync('git', ['config', '--global', key], {
        stdio: 'pipe', timeout: 1500,
      }).toString().trim();
    } catch { return ''; }
  };
  return { name: read('user.name'), email: read('user.email') };
}

// Validate a name + email pair before writing. Empty values are
// rejected (use the unset/clear path instead). Email format is
// RFC-flexible (we don't enforce a strict regex — git itself
// doesn't), but we trim + check there's at least one `@` so a
// malformed value can't silently land.
function validateGitIdentity(input: { name?: string; email?: string }): { ok: true; name: string; email: string } | { ok: false; error: string } {
  const name  = (input.name  ?? '').trim();
  const email = (input.email ?? '').trim();
  if (!name)  return { ok: false, error: 'name is required' };
  if (!email) return { ok: false, error: 'email is required' };
  if (!email.includes('@')) return { ok: false, error: 'email must contain @' };
  // Disallow newlines and control chars in either field — git config
  // would either refuse or store something the user couldn't visually
  // verify.
  if (/[\r\n\t]/.test(name) || /[\r\n\t]/.test(email)) {
    return { ok: false, error: 'name and email must not contain control characters' };
  }
  return { ok: true, name, email };
}

export function writeGlobalGitIdentity(input: { name?: string; email?: string }): { ok: true } | { ok: false; error: string } {
  const v = validateGitIdentity(input);
  if (!v.ok) return v;
  try {
    execFileSync('git', ['config', '--global', 'user.name', v.name], {
      stdio: 'pipe', timeout: 1500,
    });
    execFileSync('git', ['config', '--global', 'user.email', v.email], {
      stdio: 'pipe', timeout: 1500,
    });
  } catch (e: any) {
    return { ok: false, error: `git config write failed: ${(e?.message || 'unknown').slice(0, 200)}` };
  }
  return { ok: true };
}

// Read the resolved identity for a specific repo, with source
// attribution. Resolution order: repo-local config → global config
// → 'unset'. The source field tells the UI where to render an
// "inherited from global" note vs. "set per-project."
export function readProjectGitIdentity(repoPath: string): ResolvedGitIdentity {
  // Probe local first explicitly so we know whether to label as 'local'
  // or 'global'. `git config --show-origin user.name` would tell us
  // too, but parsing its output is fragile — this probe pattern is
  // simpler.
  const readLocal = (key: string): string | null => {
    try {
      return execFileSync('git', ['config', '--local', key], {
        cwd: repoPath, stdio: 'pipe', timeout: 1500,
      }).toString().trim();
    } catch { return null; }
  };
  const readAny = (key: string): string => {
    try {
      return execFileSync('git', ['config', key], {
        cwd: repoPath, stdio: 'pipe', timeout: 1500,
      }).toString().trim();
    } catch { return ''; }
  };

  const localName  = readLocal('user.name');
  const localEmail = readLocal('user.email');
  if (localName !== null && localEmail !== null && localName && localEmail) {
    return { name: localName, email: localEmail, source: 'local' };
  }
  const anyName  = readAny('user.name');
  const anyEmail = readAny('user.email');
  if (anyName && anyEmail) {
    return { name: anyName, email: anyEmail, source: 'global' };
  }
  return { name: '', email: '', source: 'unset' };
}

export function writeProjectGitIdentity(repoPath: string, input: { name?: string; email?: string }): { ok: true } | { ok: false; error: string } {
  const v = validateGitIdentity(input);
  if (!v.ok) return v;
  try {
    execFileSync('git', ['config', '--local', 'user.name', v.name], {
      cwd: repoPath, stdio: 'pipe', timeout: 1500,
    });
    execFileSync('git', ['config', '--local', 'user.email', v.email], {
      cwd: repoPath, stdio: 'pipe', timeout: 1500,
    });
  } catch (e: any) {
    return { ok: false, error: `git config write failed: ${(e?.message || 'unknown').slice(0, 200)}` };
  }
  return { ok: true };
}

// Clear the repo-local override so the project inherits global. If
// the local config didn't have user.name / user.email set,
// `--unset` exits non-zero — we treat that as success because the
// post-state is what the caller asked for ("no local override").
export function clearProjectGitIdentity(repoPath: string): { ok: true } {
  for (const key of ['user.name', 'user.email']) {
    try {
      execFileSync('git', ['config', '--local', '--unset', key], {
        cwd: repoPath, stdio: 'pipe', timeout: 1500,
      });
    } catch { /* already unset — desired post-state */ }
  }
  return { ok: true };
}
