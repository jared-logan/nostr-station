// Detect "split-brain" nvpn daemon state.
//
// The install wizard runs `nvpn service install` which registers a
// systemd unit, but if the user (or an earlier wizard step) also ran
// nvpn directly, a second user-mode daemon ends up running in parallel.
// The two daemons read different config files (~/.config/nvpn/ vs
// /root/.config/nvpn/) and only one has the CAP_NET_ADMIN it needs to
// create the WG interface. The CLI binds to whichever owns the per-
// user PID file for the calling user — which on nostr-station's
// runtime is always the user-mode (privilege-less) daemon. Net result:
// dashboard reports "running" against the daemon that can't actually
// route traffic, while the systemd one with the caps sits idle.
//
// We can't safely pick the "right" architecture from inside nostr-station
// (the issue documents three valid resolutions: systemd-only, user-only
// with setcap, or detect-and-consolidate). This module implements the
// last one — detect both daemons, surface the conflict, and offer a
// remediation action — without committing to either of the other two.
//
// Detection is observational (PID files + ps probe via execa). On macOS
// we only look for the user-mode daemon (systemd is Linux-only). Pure
// helpers are exported for tests; the live detector wraps them.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execa } from 'execa';

export interface DaemonProbeRecord {
  origin:    'user' | 'systemd';
  pidFile:   string;
  pid:       number | null;     // null if PID file is missing/invalid
  alive:     boolean;           // true if /proc/<pid> exists
}

export interface SplitBrainReport {
  // True when BOTH daemons are alive. The UI warning only fires on this.
  splitBrain:  boolean;
  user:        DaemonProbeRecord | null;
  systemd:     DaemonProbeRecord | null;
  // Human-readable summary suitable for a toast/banner.
  summary:     string;
}

const USER_PID_FILE     = path.join(os.homedir(), '.config', 'nvpn', 'daemon.pid');
const SYSTEMD_PID_FILE  = '/root/.config/nvpn/daemon.pid';

// Read a PID file. Returns null on any failure (missing, unreadable,
// not-a-number).
function readPidFile(p: string): number | null {
  try {
    const txt = fs.readFileSync(p, 'utf8').trim();
    const n = parseInt(txt, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

// Same idea via sudo -n — used when the file lives in a directory we
// can't read directly (e.g., /root/.config/nvpn/daemon.pid). Cheap;
// returns null if sudo isn't configured.
async function readPidFileSudo(p: string): Promise<number | null> {
  try {
    const r = await execa('sudo', ['-n', 'cat', p], { timeout: 2000 });
    const n = parseInt(String(r.stdout).trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

// /proc/<pid> existence check. Cheap, no spawn. Returns false on
// macOS/Windows where /proc doesn't exist; the user daemon is the only
// kind that matters there anyway.
function isAlive(pid: number): boolean {
  if (process.platform !== 'linux') {
    // Fallback: kill(0) sends no signal but errors if the process
    // doesn't exist. Works cross-platform; only reaches non-Linux paths.
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
  try { fs.accessSync(`/proc/${pid}`, fs.constants.F_OK); return true; }
  catch { return false; }
}

// Pure helper — combine the two probes into a SplitBrainReport. Exposed
// for tests; the live detector calls this after probing both PID files.
export function reconcile(
  user:    DaemonProbeRecord | null,
  systemd: DaemonProbeRecord | null,
): SplitBrainReport {
  const userAlive    = !!user?.alive;
  const systemdAlive = !!systemd?.alive;
  const splitBrain   = userAlive && systemdAlive;

  let summary = '';
  if (splitBrain) {
    summary = 'Two nvpn daemons are running: a user-mode one and a systemd-managed one. The user-mode daemon lacks the privileges needed to create the WG interface, so the dashboard\'s status is talking to the wrong process.';
  } else if (userAlive && !systemdAlive) {
    summary = 'Only the user-mode daemon is running.';
  } else if (!userAlive && systemdAlive) {
    summary = 'Only the systemd daemon is running.';
  } else {
    summary = 'No nvpn daemon detected.';
  }
  return { splitBrain, user, systemd, summary };
}

export async function detectSplitBrain(): Promise<SplitBrainReport> {
  // User-mode daemon — direct read from $HOME.
  const userPid = readPidFile(USER_PID_FILE);
  const user: DaemonProbeRecord | null = userPid !== null
    ? { origin: 'user', pidFile: USER_PID_FILE, pid: userPid, alive: isAlive(userPid) }
    : null;

  // Systemd daemon — root-owned PID file. Try direct read first
  // (unlikely to succeed for a non-root caller), then sudo -n.
  let systemdPid = readPidFile(SYSTEMD_PID_FILE);
  if (systemdPid === null && process.platform === 'linux') {
    systemdPid = await readPidFileSudo(SYSTEMD_PID_FILE);
  }
  const systemd: DaemonProbeRecord | null = systemdPid !== null
    ? { origin: 'systemd', pidFile: SYSTEMD_PID_FILE, pid: systemdPid, alive: isAlive(systemdPid) }
    : null;

  return reconcile(user, systemd);
}

// Stop the user-mode daemon. Idempotent — succeeds even when the PID
// file is missing or the process is already dead.
export async function stopUserModeDaemon(): Promise<{ ok: boolean; detail: string }> {
  const pid = readPidFile(USER_PID_FILE);
  if (pid === null) return { ok: true, detail: 'no user-mode daemon PID file' };
  if (!isAlive(pid)) {
    // Clean up stale PID file so the next probe doesn't keep reporting it.
    try { fs.unlinkSync(USER_PID_FILE); } catch { /* nothing to do */ }
    return { ok: true, detail: 'user-mode daemon already exited (PID file cleaned)' };
  }
  try {
    process.kill(pid, 'SIGTERM');
    // Best-effort wait for exit. We don't actively poll — a 200ms pause
    // catches the common case without making the UI feel slow.
    await new Promise(r => setTimeout(r, 200));
    if (isAlive(pid)) {
      // Persistent — escalate.
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead? */ }
    }
    return { ok: true, detail: `stopped user-mode daemon (pid ${pid})` };
  } catch (e: any) {
    return { ok: false, detail: `failed to stop user-mode daemon: ${e?.message || e}` };
  }
}
