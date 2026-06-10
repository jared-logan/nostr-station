/**
 * Sync helper module.
 *
 * The primitives that turn the Projects panel from a launcher into a
 * dashboard:
 *
 *   - getProjectGitState(project) — read-only `git status --porcelain=v2
 *     --branch` parse. Surfaces ahead/behind/dirty/diverged and a label
 *     the dashboard renders as a per-card badge, plus fetch freshness,
 *     auto-pull marks, and branch-awareness fields (defaultBranch /
 *     offDefault / detached / aheadOfDefault).
 *
 *   - refreshRemoteState(project) — the background `git fetch` (TTL'd,
 *     backoff on failure) that keeps the badge truthful, chained with
 *     an auto-pull (`merge --ff-only @{u}`) when the project is clean,
 *     strictly behind, opted in, and no project-bound PTY is alive.
 *
 *   - syncProject(project) — per-backend dispatch:
 *       local-only → no-op (it's a git repo with no remote).
 *       git        → `git fetch` then a strict ff-only merge if clean.
 *                    Diverged / dirty repos refuse silently with an
 *                    actionable message; we never force-push or rebase.
 *       ngit       → stock git pull via git-remote-nostr plus a
 *                    proposals (kind-1617) query against the user's
 *                    read relays. Proposals come back as a first-class
 *                    array on SyncResult for the count badge.
 *
 *   - mergeRemote / rescueBranch / checkoutBranch — the never-dead-end
 *     recovery set: real merge for diverged repos, park-my-work-on-a-
 *     branch when the merge conflicts, and the guarded "Back to main"
 *     switch behind the off-default branch chip.
 *
 *   - snapshotProject(project, message) — the "save snapshot"
 *     primitive: `git add -A` then `git commit -m <message>` with an
 *     ISO-timestamp fallback when message is empty. Works against all
 *     three backends (every project is locally a git repo).
 *
 * Every mutating flow above runs inside a per-project promise-chain
 * mutex (withRepoLock) so background work and user actions can't
 * interleave on the same repo.
 *
 * Hard constraints from the spec:
 *   - All git invocations go through `execFile` with a fixed argv —
 *     no shell template strings.
 *   - Binary resolution via `findBin('git')` / `findBin('ngit')` so a
 *     stripped PATH (the Mint regression that motivated `findBin`)
 *     can't drop us into the wrong binary or ENOENT.
 */
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { nip19 } from 'nostr-tools';
import { findBin } from './detect.js';
import type { Project } from './projects.js';

const execFileAsync = promisify(execFile);

// ── Public types ──────────────────────────────────────────────────────────

export type SyncBackend = 'local-only' | 'git' | 'ngit';

export type GitStateLabel =
  | 'up to date'
  | 'dirty'
  | 'diverged'
  | `${number} ahead`
  | `${number} behind`;

export interface GitState {
  ahead:    number;
  behind:   number;
  dirty:    boolean;
  diverged: boolean;
  branch:   string;
  label:    GitStateLabel;
  backend:  SyncBackend;
  // Set when `git status` itself failed (timeout, .git/index.lock held by
  // a concurrent op, etc). The other numeric/boolean fields fall back to
  // defaults but the dashboard MUST NOT treat that as "actually clean" —
  // it should leave the previous badge in place until the next successful
  // poll. Distinguishing this from "really a clean repo" was the whole
  // reason the field exists; the prior code conflated them and produced
  // a "dirty -> up to date -> dirty" flicker every time a poll raced an
  // ngit fetch.
  error?:   string;
  // Epoch ms of the last successful background `git fetch` for this
  // project (see refreshRemoteState). Absent until the first fetch
  // succeeds. Lets the dashboard render "checked Xm ago" honestly.
  fetchedAt?:  number;
  // Last background-fetch failure, if the most recent attempt failed.
  // Informational only — the ahead/behind counts still reflect the last
  // successful fetch's remote-tracking refs.
  fetchError?: string;
  // Set when the background loop fast-forwarded this repo (auto-pull).
  // The poll carries it to the dashboard so a quiet "pulled N commits"
  // notice can fire without a dedicated endpoint or push channel.
  autoPulled?: { at: number; commits: number };
  // Branch-awareness extras (git/ngit backends only). `defaultBranch`
  // resolves origin/HEAD (fallback "main"); `offDefault` means HEAD is
  // on a real branch that isn't the default; `detached` mirrors the
  // literal `(detached)` token from git status. `aheadOfDefault` is
  // computed only when offDefault — it gates the "Submit as PR" exit.
  defaultBranch?:  string;
  offDefault?:     boolean;
  detached?:       boolean;
  aheadOfDefault?: number;
}

export interface NgitProposal {
  id:        string;
  pubkey:    string;
  createdAt: number;
  title:     string;
}

export type SyncResult =
  | { ok: true;  backend: 'local-only'; message: string }
  | { ok: true;  backend: 'git';        message: string; ahead?: number; behind?: number }
  | { ok: false; backend: 'git';        message: string; ahead: number;  behind: number }
  | { ok: true;  backend: 'ngit';       message: string; proposals: NgitProposal[] }
  | { ok: false; backend: 'ngit';       message: string };

export interface SnapshotResult {
  ok:    boolean;
  sha?:  string;
  error?: string;
}

// ── Backend detection (orthogonal — no capability implies another) ────────

export function detectBackend(p: Project): SyncBackend {
  if (p.capabilities.ngit) return 'ngit';
  if (p.capabilities.git)  return 'git';
  return 'local-only';
}

// ── Parser (pure — easy to unit-test) ─────────────────────────────────────

/**
 * Parses the output of `git status --porcelain=v2 --branch` into a
 * `GitState`. Pure: takes string + backend, returns the shape. Run a
 * small empirical sweep of `--porcelain=v2 --branch` outputs to refresh
 * understanding of the line grammar:
 *
 *   # branch.oid <sha-or-(initial)>
 *   # branch.head <branch-or-(detached)>
 *   # branch.upstream <upstream>             (optional — only with tracking)
 *   # branch.ab +<ahead> -<behind>           (optional — only with upstream)
 *   1 <XY> <subm> <m1> <m2> <h1> <h2> <path>     (changed/added/staged)
 *   2 <XY> <subm> <m1> <m2> <h1> <h2> <X><score> <path><sep><origPath>
 *   u <XY> <subm> <m1> <m2> <m3> <h1> <h2> <h3> <path>   (unmerged)
 *   ? <path>                                 (untracked)
 *   ! <path>                                 (ignored — usually not shown)
 *
 * Anything not starting with `#` counts as dirty.
 */
export function parseGitState(stdout: string, backend: SyncBackend): GitState {
  let branch = '';
  let ahead  = 0;
  let behind = 0;
  let dirty  = false;

  for (const raw of stdout.split('\n')) {
    if (!raw) continue;
    if (raw.startsWith('#')) {
      if (raw.startsWith('# branch.head ')) {
        // `# branch.head (detached)` is the literal token git uses; we
        // surface the parens as-is so the dashboard can choose to render
        // it differently from a real branch name.
        branch = raw.slice('# branch.head '.length).trim();
      } else if (raw.startsWith('# branch.ab ')) {
        // `# branch.ab +N -M` — N is ahead, M is behind. Fields are
        // space-separated; whitespace tolerance covers a future format
        // tweak without false-zeroing.
        const m = raw.match(/# branch\.ab \+(-?\d+)\s+-(-?\d+)/);
        if (m) {
          ahead  = Math.max(0, parseInt(m[1], 10) || 0);
          behind = Math.max(0, parseInt(m[2], 10) || 0);
        }
      }
      continue;
    }
    // Any non-`#` line in --porcelain=v2 indicates a tracked or
    // untracked change in the working tree or index. dirty wins
    // regardless of how many distinct files we see.
    dirty = true;
  }

  // local-only projects have no remote; force ahead/behind to zero so
  // the dashboard never paints a "1 ahead" badge against nothing.
  if (backend === 'local-only') {
    ahead = 0;
    behind = 0;
  }

  const diverged = ahead > 0 && behind > 0;

  // Label priority: dirty > diverged > ahead/behind > clean.
  // Reason: an outstanding edit dominates whatever the remote relation
  // looks like — the user can't safely sync until they commit or
  // stash, so the badge should call out the local state first.
  let label: GitStateLabel;
  if (dirty)            label = 'dirty';
  else if (diverged)    label = 'diverged';
  else if (ahead  > 0)  label = `${ahead} ahead`;
  else if (behind > 0)  label = `${behind} behind`;
  else                  label = 'up to date';

  return { ahead, behind, dirty, diverged, branch, label, backend };
}

// ── Per-project repo lock ─────────────────────────────────────────────────
//
// Serializes every mutating git operation per project: background fetch,
// auto-pull, sync, merge-remote, rescue-branch, checkout, snapshot. The
// OS-level .git/index.lock only protects the index file — two of our own
// flows interleaving (a background auto-pull racing the user's Sync click)
// would still produce confusing half-results. A simple promise chain is
// enough: this is a single-user local server, fairness/starvation aren't
// concerns, and the chain self-cleans once drained.

const repoLocks = new Map<string, Promise<unknown>>();

export function isRepoLocked(projectId: string): boolean {
  return repoLocks.has(projectId);
}

export async function withRepoLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(projectId) ?? Promise.resolve();
  const run  = prev.catch(() => {}).then(fn);
  // The stored tail swallows rejections so a failed op can't wedge every
  // subsequent waiter; callers still see `run`'s own rejection.
  const tail = run.catch(() => {});
  repoLocks.set(projectId, tail);
  void tail.then(() => {
    if (repoLocks.get(projectId) === tail) repoLocks.delete(projectId);
  });
  return run;
}

// ── Active terminal-session probe ─────────────────────────────────────────
//
// Auto-pull must never move HEAD/working tree under a live TUI agent
// (Claude Code mid-rebase in a PTY). The terminal module knows which
// sessions are project-bound; it injects its predicate at load time via
// setActiveSessionProbe so sync.ts never has to import the (node-pty
// flavored) terminal module — which also keeps this trivially stubbable
// in tests. Default: no sessions, auto-pull allowed.

let activeSessionProbe: (projectId: string) => boolean = () => false;

export function setActiveSessionProbe(fn: (projectId: string) => boolean): void {
  activeSessionProbe = fn;
}

// ── Background remote refresh (fetch + optional auto-pull) ────────────────
//
// THE fix for the "In sync (a lie)" badge: getProjectGitState only reads
// `git status`, whose ahead/behind counts compare against the LAST-FETCHED
// remote-tracking refs. Nothing fetched in the background, so a push from
// another client (Shakespeare, another machine) was invisible until the
// user manually clicked Sync — by which point they'd often committed on a
// stale base and pushed into a non-fast-forward rejection.
//
// refreshRemoteState piggybacks on the dashboard's existing 30 s git-state
// poll (the route fire-and-forgets it): no standalone scheduler, no relay
// traffic while no dashboard is open, and the first page load naturally
// triggers a fetch. A per-project TTL (with exponential backoff on
// failure, so offline relays don't get hammered) bounds the cost; `force`
// bypasses the TTL for moments that must be truthful right now (popover
// open, pre-push check).
//
// For ngit remotes the fetch goes through the git-remote-nostr helper —
// read-only relay queries, NO Amber signing prompt (same property the
// pull path above has always relied on).

interface RemoteRefreshEntry {
  lastFetchAt:  number;  // last attempt (success or failure) — TTL anchor
  lastOkAt:     number;  // last success — surfaced as GitState.fetchedAt
  failures:     number;  // consecutive failures — drives backoff
  inFlight:     boolean;
  lastError?:   string;
  lastAutoPull?: { at: number; commits: number };
}

const remoteRefresh = new Map<string, RemoteRefreshEntry>();

export const REMOTE_FETCH_TTL_MS = 120_000;
const REMOTE_FETCH_BACKOFF_CAP = 4; // 120s * 2^4 = 32 min worst case

function refreshEntry(projectId: string): RemoteRefreshEntry {
  let e = remoteRefresh.get(projectId);
  if (!e) {
    e = { lastFetchAt: 0, lastOkAt: 0, failures: 0, inFlight: false };
    remoteRefresh.set(projectId, e);
  }
  return e;
}

// Lets explicit user flows (Sync button, merge-remote) that just ran their
// own successful `git fetch` mark the project fresh, so the background
// loop doesn't redundantly re-fetch seconds later.
export function noteRemoteFetched(projectId: string): void {
  const e = refreshEntry(projectId);
  e.lastFetchAt = Date.now();
  e.lastOkAt    = Date.now();
  e.failures    = 0;
  e.lastError   = undefined;
}

// Test seam: drop all cached refresh state (TTL anchors, auto-pull marks).
export function resetRemoteRefreshState(): void {
  remoteRefresh.clear();
  defaultBranchCache.clear();
}

export interface RefreshResult {
  fetched: boolean;
  error?:  string;
  autoPulled?: { at: number; commits: number };
}

export async function refreshRemoteState(
  project: Project,
  opts: { force?: boolean } = {},
): Promise<RefreshResult> {
  const backend = detectBackend(project);
  if (backend === 'local-only' || !project.path) return { fetched: false };
  const gitBin = findBin('git');
  if (!gitBin) return { fetched: false };
  if (!fs.existsSync(path.join(project.path, '.git'))) return { fetched: false };

  const entry = refreshEntry(project.id);
  if (!opts.force) {
    if (entry.inFlight) return { fetched: false };
    const ttl = REMOTE_FETCH_TTL_MS * Math.pow(2, Math.min(entry.failures, REMOTE_FETCH_BACKOFF_CAP));
    if (Date.now() - entry.lastFetchAt < ttl) return { fetched: false };
    // Background work yields to anything already holding the repo —
    // the next poll tick will retry. Forced refreshes queue instead.
    if (isRepoLocked(project.id)) return { fetched: false };
  }

  // No `origin` remote → nothing to fetch against. Treated as a quiet
  // no-op with a TTL stamp (the remote config rarely appears between
  // polls; no reason to re-probe every 30 s).
  try {
    await execFileAsync(gitBin, ['remote', 'get-url', 'origin'],
      { cwd: project.path, timeout: 5_000 });
  } catch {
    entry.lastFetchAt = Date.now();
    return { fetched: false };
  }

  // ngit remotes need the git-remote-nostr helper (ships with ngit);
  // without it `git fetch` dies with "protocol 'nostr' is not supported".
  if (backend === 'ngit' && !findBin('ngit')) {
    entry.lastFetchAt = Date.now();
    entry.lastError = 'ngit not found on PATH (provides git-remote-nostr helper)';
    return { fetched: false, error: entry.lastError };
  }

  entry.inFlight = true;
  entry.lastFetchAt = Date.now();
  try {
    return await withRepoLock(project.id, async () => {
      try {
        await execFileAsync(gitBin, ['fetch', '--prune', 'origin'], {
          cwd: project.path!,
          // Relay-backed remotes are slower than https ones.
          timeout: backend === 'ngit' ? 30_000 : 20_000,
        });
      } catch (e: any) {
        entry.failures += 1;
        entry.lastError = (e?.stderr || e?.message || 'git fetch failed').toString().slice(0, 200);
        return { fetched: false, error: entry.lastError };
      }
      entry.failures  = 0;
      entry.lastOkAt  = Date.now();
      entry.lastError = undefined;

      // Auto-pull: fast-forward while it's provably safe. Still inside
      // the same lock acquisition so nothing can dirty the tree between
      // the re-check and the merge (from our own flows; a terminal agent
      // is excluded via the probe, and a racing manual commit just makes
      // the ff-only merge fail harmlessly).
      const autoPulled = await autoFastForwardLocked(project, gitBin, entry);
      return { fetched: true, autoPulled: autoPulled ?? undefined };
    });
  } finally {
    entry.inFlight = false;
  }
}

// Pre-conditions for the shakespeare-style auto-pull, checked on a FRESH
// status read inside the lock:
//   - project hasn't opted out (autoPull !== false; absent = on),
//   - no live project-bound PTY (a TUI agent may be mid-rebase),
//   - clean tree, strictly behind (0 ahead), on a real branch with an
//     upstream (`# branch.ab` implies upstream; behind>0 implies both).
// `merge --ff-only` cannot destroy commits, so the worst a lost race can
// do is fail — which we swallow, because by definition nothing was touched.
async function autoFastForwardLocked(
  project: Project,
  gitBin: string,
  entry: RemoteRefreshEntry,
): Promise<{ at: number; commits: number } | null> {
  if (project.autoPull === false) return null;
  if (activeSessionProbe(project.id)) return null;

  let state: GitState;
  try {
    const { stdout } = await execFileAsync(gitBin, ['status', '--porcelain=v2', '--branch'],
      { cwd: project.path!, timeout: 5_000 });
    state = parseGitState(stdout, detectBackend(project));
  } catch {
    return null;
  }
  if (state.dirty || state.diverged) return null;
  if (state.ahead > 0 || state.behind === 0) return null;
  if (!state.branch || state.branch === '(detached)') return null;

  try {
    await execFileAsync(gitBin, ['merge', '--ff-only', '@{u}'],
      { cwd: project.path!, timeout: 15_000 });
  } catch {
    return null; // lost a race to a fresh local commit — nothing touched
  }
  entry.lastAutoPull = { at: Date.now(), commits: state.behind };
  return entry.lastAutoPull;
}

// ── Default-branch resolution (branch awareness) ──────────────────────────
//
// origin/HEAD almost never changes, so a long TTL keeps the 30 s poll
// cheap. The ngit set-default-branch route invalidates explicitly.

const defaultBranchCache = new Map<string, { value: string; at: number }>();
const DEFAULT_BRANCH_TTL_MS = 10 * 60_000;

export function invalidateDefaultBranchCache(repoPath: string): void {
  defaultBranchCache.delete(repoPath);
}

async function resolveDefaultBranch(gitBin: string, repoPath: string): Promise<string> {
  const hit = defaultBranchCache.get(repoPath);
  if (hit && Date.now() - hit.at < DEFAULT_BRANCH_TTL_MS) return hit.value;
  let value = 'main';
  try {
    const { stdout } = await execFileAsync(gitBin,
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { cwd: repoPath, timeout: 5_000 });
    const out = stdout.trim();
    if (out.startsWith('origin/')) value = out.slice('origin/'.length);
  } catch { /* keep "main" fallback — same convention as routes/projects-ngit.ts */ }
  defaultBranchCache.set(repoPath, { value, at: Date.now() });
  return value;
}

// ── getProjectGitState ────────────────────────────────────────────────────

const NOT_A_REPO: GitState = {
  ahead: 0, behind: 0, dirty: false, diverged: false,
  branch: '', label: 'up to date', backend: 'local-only',
};

export async function getProjectGitState(project: Project): Promise<GitState> {
  const backend = detectBackend(project);
  if (!project.path) return { ...NOT_A_REPO, backend };

  const gitBin = findBin('git');
  if (!gitBin) {
    // No git on PATH at all — return a neutral state. Dashboard renders
    // it as "up to date" rather than blowing up the card.
    return { ...NOT_A_REPO, backend };
  }

  // Cheap up-front check: if there's no `.git` directory the path simply
  // isn't a repo. We return a clean state with no `error` so the dashboard
  // renders "up to date" without blame — distinct from the catch branch
  // below, which is reserved for "git was supposed to work but didn't".
  try {
    const { existsSync } = await import('fs');
    const { join } = await import('path');
    if (!existsSync(join(project.path, '.git'))) {
      return { ...NOT_A_REPO, backend };
    }
  } catch {
    // fs import shouldn't fail at runtime; fall through and let git itself
    // be the source of truth.
  }

  try {
    const { stdout } = await execFileAsync(
      gitBin,
      ['status', '--porcelain=v2', '--branch'],
      { cwd: project.path, timeout: 5000 },
    );
    const state = parseGitState(stdout, backend);
    await attachStateExtras(state, project, gitBin);
    return state;
  } catch (e: any) {
    // Transient: timeout (5 s), index.lock held by a concurrent git op
    // (the user clicking Publish in another tab, an editor's own git
    // integration), EACCES on the .git dir, etc. We surface the
    // failure via `error` so the polling client preserves whatever badge
    // it last drew successfully instead of momentarily painting a dirty
    // repo as clean.
    const msg = (e?.stderr || e?.message || 'git status failed').toString().slice(0, 200);
    return { ...NOT_A_REPO, backend, error: msg };
  }
}

// Best-effort enrichment of a successful status read: fetch freshness +
// auto-pull mark (from the refresh cache, no extra git calls) and the
// branch-awareness fields. Failures here must never fail the state — the
// badge with slightly fewer fields beats no badge.
async function attachStateExtras(state: GitState, project: Project, gitBin: string): Promise<void> {
  const entry = remoteRefresh.get(project.id);
  if (entry) {
    if (entry.lastOkAt)     state.fetchedAt  = entry.lastOkAt;
    if (entry.lastError)    state.fetchError = entry.lastError;
    if (entry.lastAutoPull) state.autoPulled = entry.lastAutoPull;
  }

  // Branch awareness only makes sense against a remote — a local-only
  // repo on "master" has no origin/HEAD and no "home" to go back to.
  if (state.backend === 'local-only' || !project.path) return;
  try {
    state.detached      = state.branch === '(detached)';
    state.defaultBranch = await resolveDefaultBranch(gitBin, project.path);
    state.offDefault    = !!state.branch && !state.detached && state.branch !== state.defaultBranch;
    if (state.offDefault) {
      // Gates the branch popover's "Submit as PR" exit: only offer it
      // when the side branch actually has commits the default lacks.
      const { stdout } = await execFileAsync(gitBin,
        ['rev-list', '--count', `origin/${state.defaultBranch}..HEAD`],
        { cwd: project.path, timeout: 5_000 });
      state.aheadOfDefault = parseInt(stdout.trim(), 10) || 0;
    }
  } catch { /* leave the extras absent */ }
}

// ── syncProject ───────────────────────────────────────────────────────────

export interface SyncOptions {
  // Include a `git push origin HEAD` phase after the pull/merge.
  //
  // Off by default so callers that only want a read-only pull/merge stay
  // read-only. Explicit user actions (the dashboard's Sync button)
  // pass push:true to get bidirectional behavior — what users expect
  // when they reach for a "Sync" verb, and what Shakespeare's clean
  // sync popover does on every click.
  push?: boolean;
}

export async function syncProject(
  project: Project,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  // Serialized with the background fetch/auto-pull loop and every other
  // mutating flow — see withRepoLock.
  return withRepoLock(project.id, () => syncProjectUnlocked(project, opts));
}

async function syncProjectUnlocked(
  project: Project,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const backend = detectBackend(project);

  if (backend === 'local-only') {
    return {
      ok: true,
      backend: 'local-only',
      message: 'local-only project — nothing to sync',
    };
  }

  if (!project.path) {
    return backend === 'ngit'
      ? { ok: false, backend: 'ngit', message: 'project has no local path' }
      : { ok: false, backend: 'git',  message: 'project has no local path', ahead: 0, behind: 0 };
  }

  const gitBin = findBin('git');
  if (!gitBin) {
    return backend === 'ngit'
      ? { ok: false, backend: 'ngit', message: 'git not found on PATH' }
      : { ok: false, backend: 'git',  message: 'git not found on PATH', ahead: 0, behind: 0 };
  }

  if (backend === 'git') {
    // 1. fetch — never refuses, just updates remote-tracking refs.
    try {
      await execFileAsync(gitBin, ['fetch', '--all', '--prune'],
        { cwd: project.path, timeout: 30_000 });
    } catch (e: any) {
      return {
        ok: false, backend: 'git',
        message: `fetch failed: ${(e?.stderr || e?.message || 'unknown').toString().slice(0, 160)}`,
        ahead: 0, behind: 0,
      };
    }

    noteRemoteFetched(project.id);

    // 2. read state to decide whether ff-only is safe.
    const state = await getProjectGitState(project);
    if (state.dirty) {
      return {
        ok: false, backend: 'git',
        message: 'working tree has uncommitted changes — commit or stash before syncing',
        ahead:  state.ahead,
        behind: state.behind,
      };
    }
    if (state.diverged) {
      return {
        ok: false, backend: 'git',
        message: `diverged — manual merge required (${state.ahead} ahead, ${state.behind} behind)`,
        ahead:  state.ahead,
        behind: state.behind,
      };
    }
    // 3. ff-only merge if anything's behind. Skipped when behind === 0
    //    (nothing to merge); we still flow through to the optional push
    //    phase below so an "ahead only" project still gets pushed when
    //    the caller asked for bidirectional sync.
    if (state.behind > 0) {
      try {
        await execFileAsync(gitBin, ['merge', '--ff-only', '@{u}'],
          { cwd: project.path, timeout: 15_000 });
      } catch (e: any) {
        return {
          ok: false, backend: 'git',
          message: `ff-only merge failed: ${(e?.stderr || e?.message || 'unknown').toString().slice(0, 160)}`,
          ahead:  state.ahead,
          behind: state.behind,
        };
      }
    }

    // 4. Optional push phase (see SyncOptions.push). Same explicit
    //    `origin HEAD` refspec as the ngit branch so we don't depend
    //    on the local branch having upstream tracking set.
    if (opts.push && state.ahead > 0) {
      try {
        await execFileAsync(gitBin, ['push', 'origin', 'HEAD'],
          { cwd: project.path, timeout: 60_000 });
      } catch (e: any) {
        return {
          ok: false, backend: 'git',
          message: `git push failed: ${(e?.stderr || e?.message || 'unknown').toString().slice(0, 160)}`,
          ahead:  state.ahead,
          behind: 0,
        };
      }
      return {
        ok: true, backend: 'git',
        message: state.behind > 0
          ? `synced (${state.behind} pulled, ${state.ahead} pushed)`
          : `pushed ${state.ahead} commits`,
        ahead: 0, behind: 0,
      };
    }
    if (state.behind === 0) {
      return {
        ok: true, backend: 'git',
        message: state.ahead > 0 ? `up to date with remote (${state.ahead} local ahead)` : 'already up to date',
        ahead:  state.ahead,
        behind: 0,
      };
    }
    return {
      ok: true, backend: 'git',
      message: `fast-forwarded (${state.behind} commits)`,
      ahead: state.ahead, behind: 0,
    };
  }

  // ── ngit ───────────────────────────────────────────────────────────
  //
  // Two phases: local pull via stock git (git-remote-nostr handles the
  // protocol), then a kind-1617 proposals query against the project's
  // relay set. Proposals come back as a first-class array on the
  // result (NOT flattened into a generic message) so the dashboard
  // can render them as a count badge.
  //
  // Pre-fix this spawned `ngit fetch`. ngit 2.x dropped the `fetch`
  // subcommand — fetching from a nostr remote is now stock git
  // against the nostr:// origin URL, with the git-remote-nostr
  // helper (installed alongside ngit, see src/lib/ngit-installer.ts)
  // handling the relay query + grasp-server pull under the hood.
  // We still gate on findBin('ngit') because the helper relies on
  // ngit being installed; without it, git would fail with
  // "fatal: protocol 'nostr' is not supported".
  //
  // Phase 1 is `git pull --ff-only`, not just `git fetch`: the
  // dashboard's Sync icon promises to bring local up to date with
  // the remote, and a bare fetch leaves local HEAD untouched. Mirrors
  // /api/projects/:id/git/pull and the ngit-tab Pull button so all
  // three pull paths behave the same. Diverged histories surface as
  // a clear ff-only failure rather than silently leaving local stale.
  if (!findBin('ngit')) {
    return { ok: false, backend: 'ngit', message: 'ngit not found on PATH (provides git-remote-nostr helper)' };
  }
  const gitBinNgit = findBin('git');
  if (!gitBinNgit) {
    return { ok: false, backend: 'ngit', message: 'git not found on PATH' };
  }

  // Explicit `origin HEAD` (not bare `git pull`) so the command works
  // regardless of branch.<name>.merge config. Without explicit refs,
  // pull bails on a freshly-ngit-init'd branch that hasn't had upstream
  // tracking set up — that branch shows "ahead of origin/main" in git
  // status but `@{u}` is undefined.
  try {
    await execFileAsync(gitBinNgit, ['pull', '--no-rebase', '--ff-only', 'origin', 'HEAD'],
      { cwd: project.path, timeout: 30_000 });
  } catch (e: any) {
    return {
      ok: false, backend: 'ngit',
      message: `git pull --ff-only failed: ${(e?.stderr || e?.message || 'unknown').toString().slice(0, 160)}`,
    };
  }
  noteRemoteFetched(project.id);

  // Push phase — opt-in (see SyncOptions.push). Runs only when the
  // caller explicitly asked for bidirectional sync. The dashboard's
  // Sync button passes push:true; read-only callers keep the default.
  if (opts.push) {
    try {
      await execFileAsync(gitBinNgit, ['push', 'origin', 'HEAD'],
        { cwd: project.path, timeout: 60_000 });
    } catch (e: any) {
      return {
        ok: false, backend: 'ngit',
        message: `git push failed: ${(e?.stderr || e?.message || 'unknown').toString().slice(0, 160)}`,
      };
    }
  }

  // Resolve the repo coords (pubkey + d-tag) from the stored remote.
  // Proposals are queried by `a` tag = `30617:<pubkey>:<d-tag>` per
  // NIP-34. If we can't decode the remote, the pull itself succeeded,
  // so we still return ok with an empty proposals list.
  const proposals = await fetchNgitProposals(project).catch(() => [] as NgitProposal[]);
  return {
    ok: true, backend: 'ngit',
    message: opts.push ? 'synced' : 'pulled',
    proposals,
  };
}

// ── ngit proposals (kind-1617) ────────────────────────────────────────────
//
// Pulls open proposal events for the project's repo coords from the
// user's read relays via nak. Mirrors the spawn-with-stdin-ignored
// pattern used by routes/ngit.ts (project memory: every nak invocation
// MUST set stdio[0] = 'ignore' to avoid the EOF hang). Best-effort: if
// we can't determine the repo coords, return an empty array rather
// than failing the whole sync.

export async function fetchNgitProposals(project: Project): Promise<NgitProposal[]> {
  const remote = project.remotes?.ngit ?? '';
  if (!remote) return [];

  let pubkeyHex = '';
  let dTag      = '';
  let relayHints: string[] = [];

  if (remote.startsWith('naddr1')) {
    try {
      const decoded = nip19.decode(remote);
      if (decoded.type !== 'naddr' || decoded.data.kind !== 30617) return [];
      pubkeyHex  = decoded.data.pubkey;
      dTag       = decoded.data.identifier;
      relayHints = Array.isArray(decoded.data.relays) ? decoded.data.relays : [];
    } catch { return []; }
  } else if (remote.startsWith('nostr://')) {
    // Format: nostr://<npub>/<d-tag>
    const m = remote.match(/^nostr:\/\/(npub1[0-9a-z]+)\/(.+)$/);
    if (!m) return [];
    try {
      const d = nip19.decode(m[1]);
      if (d.type !== 'npub' || typeof d.data !== 'string') return [];
      pubkeyHex = d.data;
      dTag      = m[2];
    } catch { return []; }
  } else {
    return [];
  }

  // Relay budget. naddr hints first, then user read relays. Cap at 6 —
  // proposals queries shouldn't fan out wider than ngit clone does.
  const userRelays = (project.readRelays || []).filter((r): r is string => typeof r === 'string');
  const relays = [...relayHints, ...userRelays]
    .filter((r, i, a) => a.indexOf(r) === i)
    .slice(0, 6);
  if (relays.length === 0) return [];

  const aTag = `30617:${pubkeyHex}:${dTag}`;
  const nakBin = findBin('nak');
  if (!nakBin) return [];

  return new Promise<NgitProposal[]>((resolve) => {
    // `nak req -k 1617 -t a=<a-tag> --stream <relays...>` — kind-1617
    // proposals tagged against the repo coordinates. Capped at 5 s so
    // a slow relay can't stall the sync response.
    const args = ['req', '-k', '1617', '-t', `a=${aTag}`, '--stream', ...relays];
    const child = spawn(nakBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const seen     = new Map<string, NgitProposal>();
    let buf        = '';
    let resolved   = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch {}
      // Freshest first — same convention as the rest of the dashboard.
      resolve(Array.from(seen.values()).sort((a, b) => b.createdAt - a.createdAt));
    };

    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        let ev: any;
        try { ev = JSON.parse(s); } catch { continue; }
        if (!ev || ev.kind !== 1617 || typeof ev.id !== 'string') continue;
        if (seen.has(ev.id)) continue;
        // Title heuristic: NIP-34 proposals carry `name` or first line of
        // content as the headline. Fallback to the event id prefix if
        // both are absent so the dashboard never renders an empty row.
        const nameTag = Array.isArray(ev.tags)
          ? ev.tags.find((t: any[]) => t[0] === 'name')?.[1]
          : undefined;
        const title = (typeof nameTag === 'string' && nameTag)
          ? nameTag
          : (typeof ev.content === 'string' && ev.content.trim()
              ? ev.content.trim().split('\n')[0].slice(0, 80)
              : ev.id.slice(0, 8));
        seen.set(ev.id, {
          id:        String(ev.id),
          pubkey:    String(ev.pubkey || ''),
          createdAt: Number(ev.created_at || 0),
          title,
        });
      }
    });

    const timer = setTimeout(finish, 5000);
    child.on('error', finish);
    child.on('close', finish);
  });
}

// ── snapshotProject ───────────────────────────────────────────────────────

/**
 * Local-only commit primitive: `git add -A` followed by
 * `git commit -m <message>`. Empty message → ISO timestamp.
 *
 * Works across all three backends because every project is locally a
 * git repo (the ngit case still uses git for object storage; ngit only
 * adds the relay-based remote on top). Returns the new commit sha so
 * the dashboard can render a "saved at <sha>" confirmation.
 */
export async function snapshotProject(
  project: Project,
  message: string,
): Promise<SnapshotResult> {
  if (!project.path) {
    return { ok: false, error: 'project has no local path' };
  }
  const gitBin = findBin('git');
  if (!gitBin) {
    return { ok: false, error: 'git not found on PATH' };
  }
  return withRepoLock(project.id, () => snapshotLocked(project, message, gitBin));
}

async function snapshotLocked(
  project: Project,
  message: string,
  gitBin: string,
): Promise<SnapshotResult> {
  const finalMessage = (typeof message === 'string' && message.trim())
    ? message.trim()
    : `snapshot ${new Date().toISOString()}`;

  try {
    await execFileAsync(gitBin, ['add', '-A'],
      { cwd: project.path!, timeout: 15_000 });
  } catch (e: any) {
    return { ok: false, error: `git add failed: ${(e?.stderr || e?.message || 'unknown').toString().slice(0, 160)}` };
  }

  try {
    await execFileAsync(gitBin, ['commit', '-m', finalMessage],
      { cwd: project.path!, timeout: 15_000 });
  } catch (e: any) {
    // `git commit` exits 1 when there's nothing to commit — surface
    // that as a non-error to keep the dashboard's "save" UX sane: the
    // user clicked save, there were no changes, that's fine.
    const stderr = (e?.stderr || '').toString();
    const stdout = (e?.stdout || '').toString();
    if (/nothing to commit|no changes added/i.test(stderr + stdout)) {
      return { ok: true, error: 'nothing to commit' };
    }
    return { ok: false, error: `git commit failed: ${(stderr || e?.message || 'unknown').toString().slice(0, 160)}` };
  }

  // Resolve the new HEAD sha so the client can render it.
  try {
    const { stdout } = await execFileAsync(gitBin, ['rev-parse', '--short', 'HEAD'],
      { cwd: project.path!, timeout: 5000 });
    return { ok: true, sha: stdout.trim() };
  } catch {
    return { ok: true };
  }
}

// ── mergeRemote (diverged recovery, phase 1) ──────────────────────────────
//
// The Sync popover's answer to "you committed on a stale base" — the exact
// incident syncProject's strict ff-only refusal used to dead-end on. Runs
// a REAL merge (merge commit allowed):
//
//   self-heal stale MERGE_HEAD → fetch → refuse dirty → ff when possible
//   → `git merge --no-edit @{u}` → on conflict, abort cleanly and report
//   conflict:true so the UI can offer the rescue-branch flow.
//
// Identical for git and ngit backends: the merge itself is purely local,
// and the fetch is read-only on both (no Amber prompt for nostr remotes).

export interface MergeRemoteResult {
  ok:        boolean;
  // True when the merge was attempted and hit conflicts (aborted cleanly,
  // tree restored). The UI keys the rescue-branch panel off this.
  conflict?: boolean;
  message:   string;
}

export async function mergeRemote(project: Project): Promise<MergeRemoteResult> {
  if (!project.path) return { ok: false, message: 'project has no local path' };
  const gitBin = findBin('git');
  if (!gitBin) return { ok: false, message: 'git not found on PATH' };
  const backend = detectBackend(project);
  if (backend === 'local-only') return { ok: false, message: 'no remote configured' };
  if (backend === 'ngit' && !findBin('ngit')) {
    return { ok: false, message: 'ngit not found on PATH (provides git-remote-nostr helper)' };
  }

  return withRepoLock(project.id, async () => {
    const cwd = project.path!;
    const run = (args: string[], timeout: number) =>
      execFileAsync(gitBin, args, { cwd, timeout });

    // Self-heal: a crash mid-merge leaves MERGE_HEAD behind and every
    // subsequent merge refuses with "you have not concluded your merge".
    if (fs.existsSync(path.join(cwd, '.git', 'MERGE_HEAD'))) {
      try { await run(['merge', '--abort'], 15_000); } catch { /* best-effort */ }
    }

    try {
      await run(['fetch', '--prune', 'origin'], backend === 'ngit' ? 30_000 : 20_000);
      noteRemoteFetched(project.id);
    } catch (e: any) {
      return { ok: false, message: `fetch failed: ${(e?.stderr || e?.message || 'unknown').toString().slice(0, 160)}` };
    }

    let state: GitState;
    try {
      const { stdout } = await run(['status', '--porcelain=v2', '--branch'], 5_000);
      state = parseGitState(stdout, backend);
    } catch (e: any) {
      return { ok: false, message: `git status failed: ${(e?.stderr || e?.message || 'unknown').toString().slice(0, 160)}` };
    }
    if (state.dirty) {
      return { ok: false, message: 'working tree has uncommitted changes — commit them first' };
    }
    if (state.behind === 0) {
      return { ok: true, message: 'already up to date with the remote' };
    }
    if (!state.diverged) {
      // Plain behind — a fast-forward is all that's needed.
      try {
        await run(['merge', '--ff-only', '@{u}'], 15_000);
        return { ok: true, message: `fast-forwarded ${state.behind} commit${state.behind === 1 ? '' : 's'}` };
      } catch (e: any) {
        return { ok: false, message: `fast-forward failed: ${(e?.stderr || e?.message || 'unknown').toString().slice(0, 160)}` };
      }
    }

    // Diverged — attempt the real merge.
    try {
      await run(['merge', '--no-edit', '@{u}'], 30_000);
      return {
        ok: true,
        message: `combined your ${state.ahead} commit${state.ahead === 1 ? '' : 's'} with ${state.behind} from the remote`,
      };
    } catch {
      // Conflict (or any merge failure): abort so the tree is exactly as
      // before. `merge --abort` only errors when there's no merge to
      // abort — e.g. the merge failed before starting — which leaves the
      // tree untouched anyway.
      try { await run(['merge', '--abort'], 15_000); } catch { /* nothing to abort */ }
      return { ok: false, conflict: true, message: 'your changes conflict with what\'s on the remote' };
    }
  });
}

// ── rescueBranch (diverged recovery, phase 2) ─────────────────────────────
//
// The never-dead-end exit when mergeRemote reports conflicts: park the
// user's local commits on a new branch and bring the tracking branch back
// in line with its upstream. Proven step order from the Submit-PR flow
// (routes/projects-ngit.ts), generalized to both backends and to whatever
// branch diverged (reset target is `@{u}`, not origin/<default>):
//
//   git branch <name>        (pointer at HEAD — keeps the commits)
//   git reset --hard @{u}    (current branch snaps to its upstream)
//   git checkout <name>      (user lands ON their work; the off-default
//                             chip then shows the way home)
//
// `onLine` streams progress so the route can SSE it into the exec modal.

export const BRANCH_NAME_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

export interface RescueResult {
  ok:       boolean;
  message:  string;
  branch?:  string;
}

export async function rescueBranch(
  project: Project,
  branchName: string,
  onLine: (line: string, stream: 'stdout' | 'stderr') => void = () => {},
): Promise<RescueResult> {
  if (!project.path) return { ok: false, message: 'project has no local path' };
  const gitBin = findBin('git');
  if (!gitBin) return { ok: false, message: 'git not found on PATH' };
  if (!BRANCH_NAME_RE.test(branchName)) {
    return { ok: false, message: 'branch name must be 1-64 chars starting with a letter: alphanumerics + . _ -' };
  }

  return withRepoLock(project.id, async () => {
    const cwd = project.path!;
    const run = async (args: string[], timeout = 15_000) => {
      onLine(`$ git ${args.join(' ')}`, 'stdout');
      const { stdout, stderr } = await execFileAsync(gitBin, args, { cwd, timeout });
      for (const l of `${stdout}\n${stderr}`.split('\n')) if (l.trim()) onLine(l, 'stdout');
    };

    // Preconditions, checked inside the lock so nothing shifts under us.
    let state: GitState;
    try {
      const { stdout } = await execFileAsync(gitBin, ['status', '--porcelain=v2', '--branch'],
        { cwd, timeout: 5_000 });
      state = parseGitState(stdout, detectBackend(project));
    } catch (e: any) {
      return { ok: false, message: `git status failed: ${(e?.stderr || e?.message || 'unknown').toString().slice(0, 160)}` };
    }
    if (state.dirty) {
      return { ok: false, message: 'working tree has uncommitted changes — commit them first' };
    }
    if (!state.branch || state.branch === '(detached)') {
      return { ok: false, message: 'not on a branch — check out a branch first' };
    }
    try {
      await execFileAsync(gitBin, ['rev-parse', '--abbrev-ref', '@{u}'], { cwd, timeout: 5_000 });
    } catch {
      return { ok: false, message: `branch '${state.branch}' has no upstream — nothing to reset to` };
    }
    try {
      await execFileAsync(gitBin, ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`],
        { cwd, timeout: 5_000 });
      // Exit 0 → ref exists.
      return { ok: false, message: `branch '${branchName}' already exists — pick another name` };
    } catch { /* does not exist — good */ }

    try {
      await run(['branch', branchName]);
      await run(['reset', '--hard', '@{u}']);
      await run(['checkout', branchName]);
    } catch (e: any) {
      const msg = (e?.stderr || e?.message || 'unknown').toString().slice(0, 200);
      onLine(msg, 'stderr');
      return { ok: false, message: `rescue failed: ${msg}` };
    }
    return {
      ok: true,
      branch: branchName,
      message: `your work is safe on '${branchName}' — '${state.branch}' now matches the remote`,
    };
  });
}

// ── checkoutBranch (branch awareness: "Back to <default>") ───────────────
//
// Guarded branch switch for the off-default chip. Refuses on a dirty tree
// (switching with edits in flight is exactly the kind of surprise the
// chip exists to prevent) and only targets existing local branches.

export async function checkoutBranch(
  project: Project,
  branch: string,
): Promise<{ ok: boolean; message: string }> {
  if (!project.path) return { ok: false, message: 'project has no local path' };
  const gitBin = findBin('git');
  if (!gitBin) return { ok: false, message: 'git not found on PATH' };
  if (!BRANCH_NAME_RE.test(branch)) {
    return { ok: false, message: 'invalid branch name' };
  }

  return withRepoLock(project.id, async () => {
    const cwd = project.path!;
    try {
      const { stdout } = await execFileAsync(gitBin, ['status', '--porcelain=v2', '--branch'],
        { cwd, timeout: 5_000 });
      if (parseGitState(stdout, detectBackend(project)).dirty) {
        return { ok: false, message: 'working tree has uncommitted changes — commit them first' };
      }
    } catch (e: any) {
      return { ok: false, message: `git status failed: ${(e?.stderr || e?.message || 'unknown').toString().slice(0, 160)}` };
    }
    try {
      await execFileAsync(gitBin, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
        { cwd, timeout: 5_000 });
    } catch {
      return { ok: false, message: `no local branch named '${branch}'` };
    }
    try {
      await execFileAsync(gitBin, ['checkout', branch], { cwd, timeout: 15_000 });
    } catch (e: any) {
      return { ok: false, message: `checkout failed: ${(e?.stderr || e?.message || 'unknown').toString().slice(0, 160)}` };
    }
    return { ok: true, message: `switched to '${branch}'` };
  });
}
