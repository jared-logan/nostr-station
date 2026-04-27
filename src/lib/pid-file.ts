/**
 * PID file management for the dashboard web server (B3).
 *
 * Two callers:
 *   1. `startWebServer` writes its PID once the socket is bound and removes
 *      it on graceful exit (server.close, SIGINT, SIGTERM).
 *   2. `Uninstall` reads the PID before nuking services + npm, refusing
 *      with a clear "stop the server first" message if the recorded PID
 *      is still alive — preventing orphaned handles into removed files.
 *
 * Stale-file handling: if the recorded process is dead (ESRCH), the file
 * is treated as garbage and the caller is told it's safe to proceed. Only
 * a live process or a permission-denied probe blocks uninstall.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export type PidStatus =
  | { state: 'absent' }                           // no pid file on disk
  | { state: 'unreadable'; error: string }        // file exists but we can't parse it
  | { state: 'stale'; pid: number }               // pid recorded, process is gone
  | { state: 'alive'; pid: number }               // pid recorded, process responds to signal 0
  | { state: 'unknown'; pid: number; error: string }; // EPERM or other — treat as alive in caller

export function pidFilePath(): string {
  return path.join(os.homedir(), '.config', 'nostr-station', 'chat.pid');
}

export function writePidFile(): void {
  const p = pidFilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  // mode 0o600 — pid file is harmless to read but no need to make it
  // world-readable. Matches the file-mode convention used elsewhere in
  // ~/.config/nostr-station/.
  fs.writeFileSync(p, `${process.pid}\n`, { mode: 0o600 });
}

export function removePidFile(): void {
  try { fs.unlinkSync(pidFilePath()); } catch { /* already gone — fine */ }
}

/**
 * Probe the recorded PID with signal 0. The semantics:
 *   - Returns `absent` when no file exists.
 *   - Returns `unreadable` when the file exists but isn't a positive integer.
 *   - Returns `stale` when `kill -0 <pid>` fails with ESRCH (the canonical
 *     "process has exited, file is leftover" case the user warned about —
 *     we treat this as safe-to-clear, not an error).
 *   - Returns `alive` when the signal succeeds.
 *   - Returns `unknown` for any other error (EPERM most likely — the PID
 *     belongs to another user). Caller should defensively treat this as
 *     "alive" since uninstalling out from under another user's running
 *     server is the same blast radius as uninstalling under our own.
 */
export function probePidFile(): PidStatus {
  const p = pidFilePath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { state: 'absent' };
    return { state: 'unreadable', error: e?.message ?? 'read failed' };
  }
  const pid = Number(raw.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    return { state: 'unreadable', error: `not a valid pid: ${JSON.stringify(raw.trim())}` };
  }
  try {
    process.kill(pid, 0);
    return { state: 'alive', pid };
  } catch (e: any) {
    if (e?.code === 'ESRCH') return { state: 'stale', pid };
    // EPERM and friends fall here. Don't unlink — we can't be sure the
    // process is gone, and a future probe with the right credentials may
    // distinguish alive vs gone.
    return { state: 'unknown', pid, error: e?.code ?? e?.message ?? 'kill failed' };
  }
}
