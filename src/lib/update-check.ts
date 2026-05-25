/**
 * One-click self-update for nostr-station.
 *
 * The dashboard runs out of a `git clone` at the install root (see
 * install.sh — defaults to ~/nostr-station). This module:
 *
 *   1. Periodically asks GitHub if `origin/main` has advanced past the
 *      currently-checked-out SHA, using the compare API (one cheap HTTP
 *      call per poll, cached). Result drives the "Update available" pill.
 *
 *   2. On user click, fast-forwards the working tree, reruns
 *      `npm ci` + `npm run build`, and exits with code 75 so the
 *      `bin/nostr-station.sh` wrapper respawns into the new build.
 *      Any failure mid-flow rolls the checkout back to the pre-update
 *      SHA so the wrapper boots into a known-good state. `npm ci`
 *      (not `npm install`) is intentional — it strictly respects the
 *      committed lockfile and never writes back to it, which means
 *      consecutive updates don't leave the working tree dirty.
 *
 * Polling cadence is deliberately low (every 30 minutes after a short
 * startup delay) so an idle dashboard does ~50 GitHub requests/day —
 * comfortably under the 60/hour unauthenticated rate limit, and
 * imperceptible to the user.
 */

import { spawn, execFile, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { persistSessions } from './auth.js';

const execFileP = promisify(execFile);

const REPO_OWNER = 'jared-logan';
const REPO_NAME  = 'nostr-station';
const BRANCH     = 'main';

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 min
const STARTUP_DELAY_MS = 60 * 1000;      // 1 min after boot
const REQUEST_TIMEOUT_MS = 8_000;

// Exit code the wrapper script (bin/nostr-station.sh) interprets as
// "rebuild done, restart me." Anything else propagates to the user.
export const UPDATE_RESTART_EXIT_CODE = 75;

// ── Install root resolution ─────────────────────────────────────────────────

// dist/lib/update-check.js → install root is two levels up. In dev mode the
// module is hosted from src/lib/update-check.ts; same relative position.
function installRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

function isGitCheckout(root: string): boolean {
  try { return fs.statSync(path.join(root, '.git')).isDirectory(); }
  catch { return false; }
}

// ── Status cache ────────────────────────────────────────────────────────────

export interface UpdateStatus {
  // True only when this install was cloned from git AND the repo has a
  // remote we can compare against. npm-registry installs (hypothetical
  // future) would be supported:false → pill stays hidden.
  supported:    boolean;
  // Whether origin/main is ahead of the local checkout.
  available:    boolean;
  currentSha:   string | null;
  latestSha:    string | null;
  // Commits we're behind, capped at whatever GitHub returned.
  behindBy:     number;
  // Short messages of the commits we'd pull, latest first. Empty when
  // either supported:false, available:false, or the network is down.
  commits:      Array<{ sha: string; message: string; url: string }>;
  // ms-since-epoch of the last successful poll. null until we've
  // managed at least one. Drives "checked X minutes ago" if we ever
  // want to surface it.
  lastCheckedAt: number | null;
  // Last poll error, surfaced to the UI for debugging. Null when the
  // most recent poll succeeded.
  lastError:    string | null;
  // True while applyUpdate() is running. UI disables the button.
  applying:     boolean;
}

const status: UpdateStatus = {
  supported:     false,
  available:     false,
  currentSha:    null,
  latestSha:     null,
  behindBy:      0,
  commits:       [],
  lastCheckedAt: null,
  lastError:     null,
  applying:      false,
};

export function getUpdateStatus(): UpdateStatus {
  // Shallow clone so callers can JSON.stringify without us worrying
  // about a poll racing the serialization.
  return { ...status, commits: status.commits.slice() };
}

// ── Git helpers ─────────────────────────────────────────────────────────────

async function gitSha(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], { cwd: root });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch { return null; }
}

async function gitIsClean(root: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP(
      'git', ['status', '--porcelain', '--untracked-files=no'],
      { cwd: root },
    );
    return stdout.trim().length === 0;
  } catch { return false; }
}

// ── GitHub compare ──────────────────────────────────────────────────────────

interface GhCompareResult {
  status:    string;        // "ahead" | "behind" | "identical" | "diverged"
  ahead_by:  number;
  behind_by: number;
  base_commit?: { sha: string };
  merge_base_commit?: { sha: string };
  commits?: Array<{ sha: string; commit: { message: string }; html_url: string }>;
}

function ghCompare(currentSha: string): Promise<GhCompareResult> {
  return new Promise((resolve, reject) => {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/compare/${currentSha}...${BRANCH}`;
    const req = https.get(url, {
      headers: {
        'User-Agent':            'nostr-station-update-check',
        'Accept':                'application/vnd.github+json',
        'X-GitHub-Api-Version':  '2022-11-28',
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          // 404 typically means the base SHA isn't on origin yet (the
          // user committed locally and hasn't pushed). Surface a clear
          // message rather than the raw HTTP code.
          if (res.statusCode === 404) {
            return reject(new Error('local commit not found on origin (did you commit but not push?)'));
          }
          if (res.statusCode === 403 || res.statusCode === 429) {
            return reject(new Error('GitHub rate limit hit — retrying later'));
          }
          return reject(new Error(`GitHub returned HTTP ${res.statusCode}`));
        }
        try { resolve(JSON.parse(body)); }
        catch (e: any) { reject(new Error(`bad GitHub response: ${e?.message || e}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('GitHub request timed out')); });
    req.on('error', reject);
  });
}

// ── Poller ──────────────────────────────────────────────────────────────────

let pollTimer: NodeJS.Timeout | null = null;

async function pollOnce(): Promise<void> {
  const root = installRoot();
  if (!isGitCheckout(root)) {
    status.supported     = false;
    status.lastCheckedAt = Date.now();
    return;
  }
  status.supported = true;
  const current = await gitSha(root);
  if (!current) {
    status.lastError     = 'could not read current git SHA';
    status.lastCheckedAt = Date.now();
    return;
  }
  status.currentSha = current;

  try {
    const cmp = ghCompare(current);
    const result = await cmp;
    // GitHub's compare API takes `<base>...<head>` and reports `status`
    // and `ahead_by` / `behind_by` from the head's perspective:
    //   status === "ahead"  → head has commits not in base
    //   ahead_by            → how many such commits there are
    //   status === "behind" → base has commits not in head (we don't
    //                         care; that'd mean local diverged ahead
    //                         of origin)
    // We pass currentSha as base and `main` as head, so "ahead" /
    // "diverged" with ahead_by > 0 is exactly the case where the user
    // has updates to pull.
    const hasUpdates = result.status === 'ahead' || result.status === 'diverged';
    const newCount   = result.ahead_by ?? 0;
    status.available = hasUpdates && newCount > 0;
    // We surface this as "behindBy" in the UI because that's how it
    // reads to the user ("you're N commits behind origin/main") even
    // though GitHub's response calls it ahead_by.
    status.behindBy  = newCount;
    status.commits   = (result.commits ?? [])
      .slice(-10)
      .reverse()
      .map(c => ({
        sha:     c.sha,
        message: (c.commit?.message || '').split('\n')[0].slice(0, 200),
        url:     c.html_url,
      }));
    // The compare API doesn't give us origin/main's head SHA directly,
    // but the last entry of `commits` IS the head. Fall back to null
    // when we're already up to date.
    status.latestSha =
      (result.commits && result.commits.length > 0)
        ? result.commits[result.commits.length - 1].sha
        : current;
    status.lastError     = null;
    status.lastCheckedAt = Date.now();
  } catch (e: any) {
    status.lastError     = String(e?.message || e).slice(0, 200);
    status.lastCheckedAt = Date.now();
  }
}

export function startUpdatePoller(): void {
  if (pollTimer) return;
  // Defer the first check so we don't compete with startup work
  // (npm install, in-process relay boot, etc.) on a fresh install.
  const kick = () => {
    void pollOnce();
    pollTimer = setInterval(() => { void pollOnce(); }, POLL_INTERVAL_MS);
    if (pollTimer && typeof (pollTimer as any).unref === 'function') {
      (pollTimer as any).unref();
    }
  };
  const startTimer = setTimeout(kick, STARTUP_DELAY_MS);
  if (typeof (startTimer as any).unref === 'function') {
    (startTimer as any).unref();
  }
}

export function stopUpdatePoller(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Apply update (SSE-streamed) ─────────────────────────────────────────────

type SseEmit = (event: { line?: string; stream?: 'stdout' | 'stderr'; phase?: string; done?: boolean; ok?: boolean; restart?: boolean; error?: string }) => void;

function runStep(
  step: { bin: string; args: string[]; env?: Record<string, string> },
  cwd: string,
  emit: SseEmit,
): Promise<number> {
  return new Promise((resolve) => {
    emit({ phase: 'step', line: `$ ${step.bin} ${step.args.join(' ')}`, stream: 'stdout' });
    let child: ChildProcess;
    try {
      child = spawn(step.bin, step.args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CI: '1', ...(step.env ?? {}) },
      });
    } catch (e: any) {
      emit({ line: `failed to spawn ${step.bin}: ${e?.message || e}`, stream: 'stderr' });
      return resolve(-1);
    }

    const onData = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        if (line.length > 0) emit({ line, stream });
      }
    };
    child.stdout?.on('data', onData('stdout'));
    child.stderr?.on('data', onData('stderr'));
    child.on('error', (e) => {
      emit({ line: String(e.message || e), stream: 'stderr' });
      resolve(-1);
    });
    child.on('close', (code) => { resolve(code ?? -1); });
  });
}

export async function applyUpdate(emit: SseEmit): Promise<void> {
  if (status.applying) {
    emit({ done: true, ok: false, error: 'update already in progress' });
    return;
  }
  const root = installRoot();
  if (!isGitCheckout(root)) {
    emit({ done: true, ok: false, error: 'install is not a git checkout — cannot self-update' });
    return;
  }
  status.applying = true;

  try {
    if (!(await gitIsClean(root))) {
      emit({
        line: 'aborting: local changes detected in the install directory.',
        stream: 'stderr',
      });
      emit({
        line: 'commit, stash, or revert them before updating, then click Update again.',
        stream: 'stderr',
      });
      emit({ done: true, ok: false, error: 'working tree not clean' });
      return;
    }

    const beforeSha = await gitSha(root);
    if (!beforeSha) {
      emit({ done: true, ok: false, error: 'could not read current git SHA' });
      return;
    }

    emit({ phase: 'fetch' });
    let code = await runStep({ bin: 'git', args: ['fetch', 'origin', BRANCH, '--quiet'] }, root, emit);
    if (code !== 0) {
      emit({ done: true, ok: false, error: 'git fetch failed (network?)' });
      return;
    }

    emit({ phase: 'pull' });
    code = await runStep({ bin: 'git', args: ['merge', '--ff-only', `origin/${BRANCH}`] }, root, emit);
    if (code !== 0) {
      emit({ done: true, ok: false, error: 'fast-forward merge failed — local commits or conflicts' });
      return;
    }

    const afterSha = await gitSha(root);
    if (afterSha === beforeSha) {
      emit({ line: 'already up to date — nothing to install.', stream: 'stdout' });
      // Refresh the cached status so the pill clears without waiting
      // for the next poll cycle.
      void pollOnce();
      emit({ done: true, ok: true, restart: false });
      return;
    }

    // `npm ci` (not `npm install`) — strictly installs what's in the
    // committed lockfile and NEVER writes back to package-lock.json.
    // `npm install` can subtly nudge the lockfile (npm-version drift,
    // platform-specific optional deps, registry metadata refresh)
    // which would leave the working tree "dirty" after every update
    // and block the next one with our clean-tree refusal. `npm ci`
    // also wipes node_modules first — a few seconds slower than the
    // incremental install but reproducible by construction.
    emit({ phase: 'install' });
    code = await runStep({ bin: 'npm', args: ['ci', '--silent', '--no-audit', '--no-fund'] }, root, emit);
    if (code !== 0) {
      await rollback(root, beforeSha, emit);
      emit({ done: true, ok: false, error: 'npm ci failed — rolled back' });
      return;
    }

    emit({ phase: 'build' });
    // STATION_SKIP_DITTO=1 keeps the in-app update fast (matches the
    // install.sh path). Building Ditto from source takes 3-5 min and
    // would freeze the dashboard for the duration of every update;
    // the Client panel's "Build Ditto now" handler runs the same
    // script on demand the first time a user opens the panel.
    code = await runStep({ bin: 'npm', args: ['run', 'build', '--silent'], env: { STATION_SKIP_DITTO: '1' } }, root, emit);
    if (code !== 0) {
      await rollback(root, beforeSha, emit);
      // Best-effort: re-run npm ci so the rolled-back tree has the
      // deps that match the now-checked-out lockfile. Failure here
      // just means the next start might need a manual `npm ci`.
      await runStep({ bin: 'npm', args: ['ci', '--silent', '--no-audit', '--no-fund'] }, root, emit);
      emit({ done: true, ok: false, error: 'build failed — rolled back' });
      return;
    }

    // Success: tell the client to start polling for a fresh server,
    // then exit with the magic code so the wrapper respawns. The
    // 200ms delay gives the SSE response a chance to flush.
    emit({ phase: 'restart', line: 'update complete — restarting…', stream: 'stdout' });
    emit({ done: true, ok: true, restart: true });
    // Refresh status so post-restart the pill is cleared.
    status.available = false;
    status.behindBy  = 0;
    status.commits   = [];
    // Persist sessions BEFORE exiting so the reload after restart
    // lands the user back in authenticated.
    persistSessions();
    setTimeout(() => {
      scheduleRespawnAndExit();
    }, 300);
  } finally {
    status.applying = false;
  }
}

async function rollback(root: string, sha: string, emit: SseEmit): Promise<void> {
  emit({ phase: 'rollback', line: `rolling back to ${sha.slice(0, 7)}`, stream: 'stderr' });
  await runStep({ bin: 'git', args: ['reset', '--hard', sha] }, root, emit);
}

/**
 * Hand the next process generation a fresh dashboard, then exit.
 *
 * The original implementation only did `process.exit(75)` and relied on
 * `bin/nostr-station.sh` to respawn node. That works for users on the
 * shipped launcher but silently strands anyone running the dashboard via
 * `npm run dev`, `node dist/cli.js` directly, a foreground orb shell, or
 * a systemd unit without `Restart=on-failure` — the process exits, the
 * supervisor (if any) sees the non-zero code and quits, and `localhost:3000`
 * stays dead until the user manually restarts.
 *
 * The launcher script now exports `NOSTR_STATION_LAUNCHER=1`, so when
 * that env is present we preserve the exit-75 path verbatim — same
 * well-tested behavior. When absent we self-spawn a detached child
 * carrying the same argv, then exit cleanly. The child inherits stdio
 * so the user keeps the same terminal experience; `detached: true +
 * unref()` decouples it from our event loop so we can exit immediately.
 * `NOSTR_STATION_RESPAWN=1` is set on the child so `startWebServer` (in
 * web-server.ts) knows to retry briefly on EADDRINUSE while the parent
 * releases the port.
 *
 * If `spawn()` itself throws synchronously (rare: ENOENT on argv0, etc.),
 * we fall back to exit 75 so a launcher — if one IS present and just
 * didn't set the env — still gets the original signal.
 */
function scheduleRespawnAndExit(): void {
  if (process.env.NOSTR_STATION_LAUNCHER === '1') {
    process.exit(UPDATE_RESTART_EXIT_CODE);
    return;
  }
  try {
    // process.execArgv carries loader hooks (e.g. tsx's --import /
    // --require pair when the user is running via `npm run dev`). Without
    // forwarding it, a respawned child can't import `.ts` / `.tsx` files
    // and crashes on the first import — silently stranding the user.
    // For built `dist/cli.js` deployments execArgv is typically empty,
    // so this branch is a no-op there.
    const args = [...process.execArgv, ...process.argv.slice(1)];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'inherit',
      cwd: process.cwd(),
      env: { ...process.env, NOSTR_STATION_RESPAWN: '1' },
    });
    child.unref();
    // Clean exit so a stale supervisor (or none at all) doesn't try to
    // respawn a second copy on top of the child we just spawned.
    process.exit(0);
  } catch (e) {
    process.stderr.write(
      `[update] self-respawn spawn() failed: ${(e as Error).message}\n` +
      `[update] falling back to exit ${UPDATE_RESTART_EXIT_CODE} — start the dashboard manually if no supervisor is configured\n`,
    );
    process.exit(UPDATE_RESTART_EXIT_CODE);
  }
}

// ── SSE wrapper ─────────────────────────────────────────────────────────────

export function streamApplyUpdate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
  const emit: SseEmit = (event) => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
  };
  let closed = false;
  const onClose = () => { closed = true; };
  req.on('close', onClose);
  req.on('error', onClose);

  void applyUpdate((event) => {
    if (closed) return;
    emit(event);
    if (event.done) {
      try { res.end(); } catch {}
    }
  });
}

// Exposed for the API: kick a poll right after the user clicks the pill
// (so a stale "Update available" disappears immediately if they were
// already on latest).
export function refreshUpdateStatus(): Promise<void> {
  return pollOnce();
}
