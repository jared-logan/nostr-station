/**
 * Per-project dev-server registry — tracks which Vite/Next/etc. dev
 * server is running for which project and on what port.
 *
 * Why this exists: the live-preview iframe in the chat panel used to
 * hardcode `localhost:5173`. With multi-project chat sessions a user can
 * have project A and project B both wanting their own preview, so we
 * allocate ports per-project and remember the mapping so the iframe URL
 * + the spawned `npm run dev -- --port <n>` command line up.
 *
 * Allocation is **sticky**: once project X gets port 5174, it keeps that
 * port for the lifetime of the process. Vite's HMR clients cache the port
 * across page reloads, and the user's bookmarks/browser tabs can keep
 * working without rewriting URLs. The mapping is in-memory only — on
 * server restart we re-allocate, which is fine because the PTYs that
 * hosted the dev servers died with the server anyway.
 *
 * "Running" tracking is bookkeeping-only: when a stacks-dev PTY starts
 * for project X we bind {projectId → sessionId}; when that PTY exits
 * (terminal closed, vite crashed, parent reaped), we release. We never
 * probe the port socket — if the user starts vite some other way (bare
 * shell, IDE), the registry won't notice, and that's intentional. The
 * dashboard only takes responsibility for processes it spawned.
 */

const ALLOCATION_BASE = 5173;
// Ports that other parts of the station are likely to bind. We skip them
// during allocation to avoid the dev server fighting another long-running
// process for the same socket. Add to this list when a new station-level
// service picks a fixed port.
const RESERVED_PORTS = new Set<number>([
  3000,  // Web UI default
  7777,  // In-process relay
  8080,  // Relay (per terminal.ts:311 comment)
]);

interface Entry {
  projectId: string;
  port:      number;
  sessionId: string | null;  // null = allocated but no PTY currently running
  startedAt: number | null;
}

const byProject = new Map<string, Entry>();
const bySession = new Map<string, string>();  // sessionId → projectId

function pickFreePort(): number {
  const used = new Set<number>();
  for (const e of byProject.values()) used.add(e.port);
  let p = ALLOCATION_BASE;
  while (used.has(p) || RESERVED_PORTS.has(p)) p += 1;
  return p;
}

/** Return the port assigned to this project, allocating one if needed. */
export function allocatePort(projectId: string): number {
  const existing = byProject.get(projectId);
  if (existing) return existing.port;
  const entry: Entry = {
    projectId,
    port: pickFreePort(),
    sessionId: null,
    startedAt: null,
  };
  byProject.set(projectId, entry);
  return entry.port;
}

/** Mark a PTY as the dev server for a project. Caller is responsible
 *  for having called `allocatePort(projectId)` first (or the PTY's port
 *  arg won't match the registry). */
export function bindSession(projectId: string, sessionId: string): void {
  const entry = byProject.get(projectId);
  if (!entry) return;
  // If another session was already bound (e.g. user spawned two terminals
  // for the same project), the newer one wins — the old PTY is still
  // running but presumably the user wanted to replace it. Vite on the
  // older PTY will lose the port and start logging EADDRINUSE; the user
  // sees it in their terminal and acts. Tracking only the most recent
  // session keeps releaseSession's symmetry simple.
  if (entry.sessionId && entry.sessionId !== sessionId) {
    bySession.delete(entry.sessionId);
  }
  entry.sessionId = sessionId;
  entry.startedAt = Date.now();
  bySession.set(sessionId, projectId);
}

/** Called from the PTY's onExit hook. Releases the running flag but
 *  keeps the port allocation so a restart reuses the same port. */
export function releaseSession(sessionId: string): void {
  const projectId = bySession.get(sessionId);
  if (!projectId) return;
  bySession.delete(sessionId);
  const entry = byProject.get(projectId);
  if (entry && entry.sessionId === sessionId) {
    entry.sessionId = null;
    entry.startedAt = null;
  }
}

/** Drop a project's allocation entirely — used when a project is
 *  deleted/unregistered so its port goes back into the free pool. */
export function forgetProject(projectId: string): void {
  const entry = byProject.get(projectId);
  if (!entry) return;
  if (entry.sessionId) bySession.delete(entry.sessionId);
  byProject.delete(projectId);
}

export interface DevServerState {
  projectId: string;
  port:      number;
  running:   boolean;
  sessionId: string | null;
  startedAt: number | null;
  url:       string;
}

export function getState(projectId: string): DevServerState | null {
  const entry = byProject.get(projectId);
  if (!entry) return null;
  return {
    projectId,
    port:      entry.port,
    running:   entry.sessionId !== null,
    sessionId: entry.sessionId,
    startedAt: entry.startedAt,
    url:       `http://localhost:${entry.port}`,
  };
}

/** Lookup the projectId currently bound to a PTY session — used by
 *  terminal.ts's onExit hook to know which project to release. */
export function projectForSession(sessionId: string): string | null {
  return bySession.get(sessionId) || null;
}
