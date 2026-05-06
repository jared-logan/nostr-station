// Per-project auto-sync scheduler.
//
// Mirrors shakespeare.diy's Automatic Sync toggle: when the user flips
// it on for a project, we run `syncProject` (which for ngit means
// `ngit fetch` + ff-merge + proposals refresh) on a fixed interval.
// Pull-only by design — auto-firing `ngit push` would spam Amber
// sign prompts on the user's phone every interval, which is the
// opposite of "friendly".
//
// State lives on the Project record (`Project.autoSync: boolean`) so
// it survives dashboard restarts. start() reads every project once at
// boot; reconcile(id) is the post-PATCH hook so a toggle takes effect
// immediately without waiting for the next tick.
//
// Concurrency: per-project boolean `running` flag — if a sync is still
// in flight when the next tick fires, we skip rather than queue. A
// 30s relay query can occasionally drift past the interval boundary;
// queueing would create a thundering herd of stale syncs after a
// network outage.

import { readProjects, getProject, type Project } from './projects.js';
import { syncProject as defaultSyncProject } from './sync.js';

export const AUTO_SYNC_INTERVAL_MS = 5 * 60_000;

type SyncFn = (project: Project) => Promise<unknown>;

export interface AutoSyncOptions {
  intervalMs?: number;
  syncFn?:     SyncFn;        // Injectable for tests — defaults to sync.syncProject.
  onLog?:      (line: string) => void;
}

export class AutoSyncManager {
  private intervalMs: number;
  private syncFn:     SyncFn;
  private onLog:      (line: string) => void;

  // Per-project armed timers. Key = project id.
  private timers = new Map<string, NodeJS.Timeout>();
  // Projects with a sync currently in flight. Used by the concurrency
  // guard inside the tick handler.
  private running = new Set<string>();
  private started = false;

  constructor(opts: AutoSyncOptions = {}) {
    this.intervalMs = opts.intervalMs ?? AUTO_SYNC_INTERVAL_MS;
    this.syncFn     = opts.syncFn     ?? (defaultSyncProject as SyncFn);
    this.onLog      = opts.onLog      ?? ((line) => console.log(`[auto-sync] ${line}`));
  }

  // Boot-time scan. Reads every project, arms an interval for each
  // one where `autoSync === true`. Idempotent — calling twice is a
  // no-op for already-armed projects (reconcile handles dedup).
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const p of readProjects()) {
      if (p.autoSync) this.arm(p);
    }
    this.onLog(`started — armed ${this.timers.size} project(s)`);
  }

  // Reconcile a single project's armed state against its persisted
  // autoSync flag. Called from the PATCH route handler so a toggle
  // takes effect within a request/response cycle, not on the next
  // hourly tick. Calling with an unknown id disarms (deleted project
  // → ensure no orphan timer survives).
  reconcile(projectId: string): void {
    const p = getProject(projectId);
    if (!p) {
      this.disarm(projectId);
      return;
    }
    const armed = this.timers.has(projectId);
    if (p.autoSync && !armed) this.arm(p);
    else if (!p.autoSync && armed) this.disarm(projectId);
    // Already in the correct state — nothing to do.
  }

  // Test + shutdown helper. Clears every armed timer; in-flight syncs
  // run to completion since they were already kicked off.
  stop(): void {
    for (const id of Array.from(this.timers.keys())) this.disarm(id);
    this.started = false;
  }

  // Number of currently armed projects — exposed for status surfaces
  // and tests, not for general use.
  armedCount(): number {
    return this.timers.size;
  }

  // ── internals ────────────────────────────────────────────────────

  private arm(project: Project): void {
    if (this.timers.has(project.id)) return;
    const timer = setInterval(() => this.tick(project.id), this.intervalMs);
    // Allow the Node event loop to exit when only auto-sync timers
    // remain — this is a periodic background task, not a foreground
    // hold. Without unref() the dashboard process sits forever after
    // an interactive Ctrl+C.
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(project.id, timer);
    this.onLog(`armed ${project.id} (${project.name})`);
  }

  private disarm(projectId: string): void {
    const timer = this.timers.get(projectId);
    if (!timer) return;
    clearInterval(timer);
    this.timers.delete(projectId);
    this.onLog(`disarmed ${projectId}`);
  }

  // One tick = one sync attempt for one project. Re-reads the project
  // record so a stale name/path doesn't wedge the run, and so a flag
  // change between the timer arm and the tick (rare but possible) is
  // honoured before we spawn anything.
  private async tick(projectId: string): Promise<void> {
    if (this.running.has(projectId)) {
      this.onLog(`skip ${projectId} — previous sync still running`);
      return;
    }
    const project = getProject(projectId);
    if (!project) { this.disarm(projectId); return; }
    if (!project.autoSync) { this.disarm(projectId); return; }
    this.running.add(projectId);
    try {
      await this.syncFn(project);
      this.onLog(`ok ${projectId}`);
    } catch (e: any) {
      // Don't disarm on failure — a transient relay error shouldn't
      // turn auto-sync off. The UI can report stale state via the
      // existing /git-state endpoint; user action is the only path
      // that flips the persisted flag.
      this.onLog(`fail ${projectId}: ${(e?.message || e || 'unknown').toString().slice(0, 160)}`);
    } finally {
      this.running.delete(projectId);
    }
  }
}
