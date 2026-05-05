// Host-side launcher: thin wrapper over `docker compose` so end users
// never type docker commands themselves. The `nostr-station` binary
// runs in two modes — host-launcher (this module) and in-container
// dashboard process (Chat / web-server). They share the same dist/cli.js
// but dispatch via different subcommands (bare/start/stop/logs/...
// here; `serve` inside the container).
//
// Design rules:
//   - No Ink / React in this module — it runs from a non-interactive
//     bare invocation and sometimes streams logs straight to stdout.
//   - Resolve absolute paths up front. The user's PATH may not include
//     ~/.nostr-station/, and we don't want to depend on cwd.
//   - Every error path returns `{ ok: false, detail }` with one
//     actionable sentence. Never throw across the public surface.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';

export interface LauncherResult {
  ok:     boolean;
  detail: string;
}

// Where install.sh laid down the compose assets. End users always hit
// this path; only dev (running from a repo checkout) falls through to
// the repo-local lookup below.
const HOME_COMPOSE = path.join(os.homedir(), '.nostr-station', 'compose', 'docker-compose.yml');

/**
 * Returns the absolute path to the docker-compose.yml the launcher
 * should drive. Prefers the install-managed location; falls back to a
 * repo-local docker-compose.yml when running from a dev checkout (so
 * `npm run dev -- start` works without a prior install.sh).
 *
 * Returns null if neither path exists. Caller MUST handle null with a
 * "run install.sh first" message — silently picking a wrong path would
 * launch against unexpected assets.
 */
export function composeFilePath(): string | null {
  if (fs.existsSync(HOME_COMPOSE)) return HOME_COMPOSE;

  // Dev fallback: this module is at src/lib/launcher.ts (when running
  // via tsx) or dist/lib/launcher.js (when running compiled). In both
  // cases the repo root is two levels up.
  const here = new URL(import.meta.url).pathname;
  const repoCompose = path.resolve(path.dirname(here), '..', '..', 'docker-compose.yml');
  if (fs.existsSync(repoCompose)) return repoCompose;

  return null;
}

/**
 * Verifies docker is installed and the daemon is reachable. Two failure
 * modes are distinguished because they need different fixes:
 *   - binary missing: install Docker Desktop / OrbStack
 *   - daemon down: start the Docker app
 */
export function isDockerInstalled(): LauncherResult {
  const which = spawnSync('command', ['-v', 'docker'], { shell: true, stdio: 'pipe' });
  if (which.status !== 0) {
    return {
      ok: false,
      detail: 'docker not found on PATH. Install Docker Desktop (macOS/Windows) or OrbStack (macOS) and re-run.',
    };
  }
  // `docker info` exits non-zero when the daemon is unreachable. Cap at
  // 5s so a wedged socket doesn't hang the launcher.
  const info = spawnSync('docker', ['info'], { stdio: 'pipe', timeout: 5000 });
  if (info.status !== 0) {
    return {
      ok: false,
      detail: 'docker found but the daemon is not responding — start Docker Desktop / OrbStack and re-run.',
    };
  }
  return { ok: true, detail: 'docker ready' };
}

/**
 * Builds the `docker compose -f <path> <verb> <args...>` argv against
 * the resolved compose file path. Caller passes only the verb and
 * verb-specific args; never the `-f` flag.
 *
 * Exposed for tests. Production callers should use `runComposeCmd`.
 */
export function buildComposeArgv(composePath: string, verb: string, extraArgs: readonly string[] = []): string[] {
  return ['compose', '-f', composePath, verb, ...extraArgs];
}

/**
 * Runs `docker compose <verb> <args>` against the resolved compose
 * path. Streams stdio to the parent by default — `nostr-station logs`
 * needs the live tail; `start` needs the build/pull progress visible.
 *
 * Returns the spawned child's exit code. Does not throw on non-zero
 * exit — caller decides how to surface the failure.
 */
export function runComposeCmd(
  verb: string,
  extraArgs: readonly string[] = [],
  opts: SpawnOptions = {},
): LauncherResult & { exitCode: number | null } {
  const composePath = composeFilePath();
  if (!composePath) {
    return {
      ok: false,
      exitCode: null,
      detail: `compose assets not found at ${HOME_COMPOSE} — run install.sh first.`,
    };
  }
  const docker = isDockerInstalled();
  if (!docker.ok) return { ...docker, exitCode: null };

  const argv = buildComposeArgv(composePath, verb, extraArgs);
  const result = spawnSync('docker', argv, { stdio: 'inherit', ...opts });
  if (result.error) {
    return {
      ok: false,
      exitCode: null,
      detail: `docker compose ${verb} failed to spawn: ${result.error.message.slice(0, 120)}`,
    };
  }
  return {
    ok: result.status === 0,
    exitCode: result.status,
    detail: result.status === 0 ? `${verb} ok` : `docker compose ${verb} exited ${result.status}`,
  };
}

/**
 * Polls http://127.0.0.1:<port>/api/status until it answers 200 or the
 * timeout expires. Used after `start` so the browser-open lands on a
 * live dashboard, not a connection-refused page.
 *
 * Returns true on success, false on timeout. Does not throw.
 */
export async function waitForDashboard(port: number, timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await pingOnce(port);
    if (ok) return true;
    await sleep(500);
  }
  return false;
}

function pingOnce(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/status', timeout: 1000 },
      res => {
        // Drain to free the socket; we only care about the status code.
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Fire-and-forget browser open. Mirrors Chat.tsx's tryOpenBrowser —
 * extracted here so the launcher path doesn't pull React/Ink. Failures
 * are silent because xdg-open on a headless box may legitimately have
 * no launcher and we'd rather print the URL than crash.
 *
 * Returns true if a launcher was handed the URL (not whether the
 * browser actually opened — we can't observe that).
 */
export function tryOpenBrowser(url: string): boolean {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => { /* missing opener → silent */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
