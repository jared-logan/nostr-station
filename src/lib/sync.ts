/**
 * Sync helper module.
 *
 * Three primitives that turn the Projects panel from a launcher into a
 * dashboard:
 *
 *   - getProjectGitState(project) — read-only `git status --porcelain=v2
 *     --branch` parse. Surfaces ahead/behind/dirty/diverged and a label
 *     the dashboard renders as a per-card badge.
 *
 *   - syncProject(project) — per-backend dispatch:
 *       local-only → no-op (it's a git repo with no remote).
 *       git        → `git fetch` then a strict ff-only merge if clean.
 *                    Diverged / dirty repos refuse silently with an
 *                    actionable message; we never force-push or rebase.
 *       ngit       → `ngit fetch` plus a proposals (kind-1617) query
 *                    against the user's read relays. Proposals come
 *                    back as a first-class array on SyncResult so the
 *                    dashboard can surface them as a count badge.
 *
 *   - snapshotProject(project, message) — the new "save snapshot"
 *     primitive: `git add -A` then `git commit -m <message>` with an
 *     ISO-timestamp fallback when message is empty. Works against all
 *     three backends (every project is locally a git repo).
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

  try {
    const { stdout } = await execFileAsync(
      gitBin,
      ['status', '--porcelain=v2', '--branch'],
      { cwd: project.path, timeout: 5000 },
    );
    return parseGitState(stdout, backend);
  } catch {
    // Not a git repo, path missing, etc. Same neutral state — the
    // pathMissing pill on the project card already surfaces the issue.
    return { ...NOT_A_REPO, backend };
  }
}

// ── syncProject ───────────────────────────────────────────────────────────

export async function syncProject(project: Project): Promise<SyncResult> {
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
    if (state.behind === 0) {
      return {
        ok: true, backend: 'git',
        message: state.ahead > 0 ? `up to date with remote (${state.ahead} local ahead)` : 'already up to date',
        ahead:  state.ahead,
        behind: 0,
      };
    }

    // 3. ff-only merge — the only safe sync that doesn't rewrite
    // history or fabricate merge commits without consent.
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
    return {
      ok: true, backend: 'git',
      message: `fast-forwarded (${state.behind} commits)`,
      ahead: state.ahead, behind: 0,
    };
  }

  // ── ngit ───────────────────────────────────────────────────────────
  //
  // Two phases: local fetch via stock git (ngit-remote-nostr handles
  // the protocol), then a kind-1617 proposals query against the
  // project's relay set. Proposals come back as a first-class array
  // on the result (NOT flattened into a generic message) so the
  // dashboard can render them as a count badge.
  //
  // Pre-fix this spawned `ngit fetch`. ngit 2.x dropped the `fetch`
  // subcommand — fetching from a nostr remote is now stock git
  // against the nostr:// origin URL, with the git-remote-nostr
  // helper (installed alongside ngit, see src/lib/ngit-installer.ts)
  // handling the relay query + grasp-server pull under the hood.
  // We still gate on findBin('ngit') because the helper relies on
  // ngit being installed; without it, git would fail with
  // "fatal: protocol 'nostr' is not supported".
  if (!findBin('ngit')) {
    return { ok: false, backend: 'ngit', message: 'ngit not found on PATH (provides git-remote-nostr helper)' };
  }
  const gitBinNgit = findBin('git');
  if (!gitBinNgit) {
    return { ok: false, backend: 'ngit', message: 'git not found on PATH' };
  }

  try {
    await execFileAsync(gitBinNgit, ['fetch', 'origin'],
      { cwd: project.path, timeout: 30_000 });
  } catch (e: any) {
    return {
      ok: false, backend: 'ngit',
      message: `git fetch origin failed: ${(e?.stderr || e?.message || 'unknown').toString().slice(0, 160)}`,
    };
  }

  // Resolve the repo coords (pubkey + d-tag) from the stored remote.
  // Proposals are queried by `a` tag = `30617:<pubkey>:<d-tag>` per
  // NIP-34. If we can't decode the remote, the fetch itself succeeded,
  // so we still return ok with an empty proposals list.
  const proposals = await fetchNgitProposals(project).catch(() => [] as NgitProposal[]);
  return { ok: true, backend: 'ngit', message: 'fetched', proposals };
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

  const finalMessage = (typeof message === 'string' && message.trim())
    ? message.trim()
    : `snapshot ${new Date().toISOString()}`;

  try {
    await execFileAsync(gitBin, ['add', '-A'],
      { cwd: project.path, timeout: 15_000 });
  } catch (e: any) {
    return { ok: false, error: `git add failed: ${(e?.stderr || e?.message || 'unknown').toString().slice(0, 160)}` };
  }

  try {
    await execFileAsync(gitBin, ['commit', '-m', finalMessage],
      { cwd: project.path, timeout: 15_000 });
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
      { cwd: project.path, timeout: 5000 });
    return { ok: true, sha: stdout.trim() };
  } catch {
    return { ok: true };
  }
}
