/**
 * Projects/sync sub-routes — extracted from routes/projects.ts as part of
 * the D12 split. Owns the three "move data around" verbs:
 *
 *   POST /api/projects/:id/sync     — sync.syncProject (fetch + ff-merge)
 *   POST /api/projects/:id/snapshot — sync.snapshotProject (autosave commit)
 *   POST /api/projects/:id/save     — promote a scratch checkout to a path
 *
 * The first two are thin wrappers around sync.ts helpers; `save` is the
 * Phase 6-tidy move-then-update flow (atomic rename when on one filesystem,
 * copy+rm on EXDEV, best-effort rollback if the record update fails after
 * the directory has already moved).
 *
 * Contract identical to handleProjects: returns true iff a response was
 * written; false lets the parent fall through.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import {
  updateProject, validateProjectPath,
} from '../projects.js';
import type { Project } from '../projects.js';
import { syncProject, snapshotProject } from '../sync.js';
import { readBody } from './_shared.js';

export async function handleProjectsSync(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  project: Project,
  tail: string,
  method: string,
): Promise<boolean> {
  if (tail === 'sync' && method === 'POST') {
    if (!project.path) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'project has no local path' }));
      return true;
    }
    try { validateProjectPath(project.path); }
    catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (e as Error).message }));
      return true;
    }
    // push:true — the dashboard's Sync button is an explicit user
    // action, and users expect bidirectional sync (pull + push) like
    // Shakespeare. AutoSyncManager calls syncProject without this opt
    // to preserve its read-only contract (unattended schedules must
    // never push WIP commits without consent).
    const result = await syncProject(project, { push: true });
    // syncProject's own SyncResult shape carries both ok/error
    // semantics AND the per-backend payload (proposals[] for ngit,
    // ahead/behind for git). 200 even on ok:false — the body is
    // the actionable signal, not the HTTP status, mirroring the
    // existing /api/projects PATCH error contract.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }

  if (tail === 'snapshot' && method === 'POST') {
    if (!project.path) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'project has no local path' }));
      return true;
    }
    try { validateProjectPath(project.path); }
    catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (e as Error).message }));
      return true;
    }
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const message = typeof parsed.message === 'string' ? parsed.message : '';
    const result = await snapshotProject(project, message);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }

  // ── save (Phase 6-tidy: promote a scratch checkout to a real path) ──
  //
  // Moves the project's directory from ~/.nostr-station/scratch/ to
  // a user-chosen path under HOME, then updates project.path. Falls
  // back to copy + delete on cross-filesystem moves. The target
  // path is validated by validateProjectPath, which enforces the
  // same rules as createProject (resolves under STATION_PROJECTS_ROOT
  // / HOME, no `..` traversal, no symlink escape).
  //
  // Atomic where possible (rename within a single filesystem) and
  // self-healing where it can: on a partial failure (rename succeeded
  // but the record update failed) we attempt to move the directory
  // back to its original location so the project record + filesystem
  // stay in sync.
  if (tail === 'save' && method === 'POST') {
    if (!project.path) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'project has no local path' }));
      return true;
    }
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const raw = typeof parsed.targetPath === 'string' ? parsed.targetPath.trim() : '';
    if (!raw) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'targetPath required' }));
      return true;
    }
    let target: string;
    try { target = validateProjectPath(raw); }
    catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (e as Error).message }));
      return true;
    }
    if (target === project.path) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'target path is the same as current path' }));
      return true;
    }
    if (fs.existsSync(target)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `target path already exists: ${target}` }));
      return true;
    }
    try { fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 }); } catch {}
    // Try rename first (atomic within a filesystem). On EXDEV the
    // source and target are on different filesystems; fall back to
    // a recursive copy + remove of the original.
    try {
      fs.renameSync(project.path, target);
    } catch (e: any) {
      if (e?.code === 'EXDEV') {
        try {
          fs.cpSync(project.path, target, { recursive: true });
          fs.rmSync(project.path, { recursive: true, force: true });
        } catch (e2: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `copy across filesystems failed: ${e2?.message ?? 'unknown'}` }));
          return true;
        }
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `move failed: ${e?.message ?? 'unknown'}` }));
        return true;
      }
    }
    const r = updateProject(project.id, { path: target });
    if (!r.ok) {
      // The directory was moved but the record update failed.
      // Best-effort rollback: try to move it back so the project
      // record + filesystem don't drift apart.
      try { fs.renameSync(target, project.path); } catch {}
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: r.error }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, project: r.project }));
    return true;
  }

  return false;
}
