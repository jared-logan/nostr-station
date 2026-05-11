/**
 * Scratch-checkout garbage collector — Phase 6-tidy.
 *
 * The Phase 6 Discover→Browse flow drops temporary clones into
 * ~/.nostr-station/scratch/<name>-<hash>/. Without cleanup these
 * accumulate over time, eating disk space for repos the user
 * looked at once and never returned to.
 *
 * Policy:
 *   - Anything under the scratch root older than SCRATCH_TTL_MS
 *     (default 7 days, measured by mtime on the subdir) is removed.
 *   - If a Project record points at the removed scratch path, the
 *     record is deleted too — keeps projects.json consistent so
 *     the dashboard doesn't surface broken pathMissing entries.
 *   - Run once at startWebServer startup. Best-effort: any error
 *     is logged and swallowed so a transient filesystem hiccup
 *     can't prevent the server from booting.
 *   - Active scratch projects (mtime fresh) are untouched.
 *
 * The user can promote a scratch checkout to a real project via
 * POST /api/projects/:id/save before the TTL fires; once moved
 * out of the scratch root, GC no longer touches it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readProjects, deleteProject } from './projects.js';

const SCRATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;     // 7 days

function scratchRoot(): string {
  return path.join(process.env.HOME || os.homedir(), '.nostr-station', 'scratch');
}

export interface ScratchGcResult {
  scanned: number;
  removed: string[];        // absolute paths
  projectsRemoved: string[]; // project ids whose record was deleted
  errors:  string[];        // best-effort: keep going on per-entry failure
}

/**
 * Walk the scratch root, remove subdirs older than the TTL, and
 * delete any project records pointing at the removed paths. Pure
 * filesystem + project-registry side effects; never throws —
 * returns a summary the caller can log.
 */
export function runScratchGc(opts?: { ttlMs?: number; now?: number }): ScratchGcResult {
  const ttl   = opts?.ttlMs ?? SCRATCH_TTL_MS;
  const now   = opts?.now   ?? Date.now();
  const root  = scratchRoot();
  const result: ScratchGcResult = {
    scanned: 0, removed: [], projectsRemoved: [], errors: [],
  };
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return result; }      // scratch root doesn't exist yet — nothing to do

  // Index projects by path so we can drop matching records when the
  // directory is removed. Cheap — projects.json is small.
  const projectsByPath = new Map<string, string>();   // path → project id
  for (const p of readProjects()) {
    if (typeof p.path === 'string' && p.path) projectsByPath.set(p.path, p.id);
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    result.scanned++;
    const full = path.join(root, e.name);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(full).mtimeMs; }
    catch (err: any) {
      result.errors.push(`stat ${e.name}: ${err?.message ?? 'unknown'}`);
      continue;
    }
    if (now - mtimeMs < ttl) continue;          // fresh — leave alone

    try {
      fs.rmSync(full, { recursive: true, force: true });
      result.removed.push(full);
    } catch (err: any) {
      result.errors.push(`rm ${full}: ${err?.message ?? 'unknown'}`);
      continue;
    }
    // Drop the matching project record so projects.json doesn't
    // accumulate dangling pathMissing entries. deleteProject is a
    // record-only operation here; the filesystem half is already done.
    const pid = projectsByPath.get(full);
    if (pid) {
      try {
        const r = deleteProject(pid);
        if (r.ok) result.projectsRemoved.push(pid);
      } catch (err: any) {
        result.errors.push(`deleteProject ${pid}: ${err?.message ?? 'unknown'}`);
      }
    }
  }
  return result;
}
