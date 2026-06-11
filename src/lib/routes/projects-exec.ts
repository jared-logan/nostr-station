/**
 * Projects/exec sub-routes — extracted from routes/projects.ts as part of
 * the D12 split. Owns the "spawn a long-running process and stream its
 * output" verb:
 *
 *   POST /api/projects/:id/exec — SSE: whitelisted read-only commands
 *
 * (nsite/deploy moved to projects-nsite-deploy.ts — the native in-process
 * pipeline replaced the old `nostr-station nsite deploy --yes` shell-out.)
 *
 * Uses the shared streamExec helper to wrap a child process in the
 * dashboard's SSE exec-modal protocol.
 *
 * Contract identical to handleProjects: returns true iff a response was
 * written; false lets the parent fall through.
 */
import http from 'http';
import { projectEnvContract } from '../projects.js';
import type { Project } from '../projects.js';
import {
  readBody, streamExec,
  type CmdSpec,
} from './_shared.js';

export async function handleProjectsExec(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  project: Project,
  tail: string,
  method: string,
): Promise<boolean> {
  if (tail === 'exec' && method === 'POST') {
    // Whitelisted read-only commands scoped to the project's cwd.
    // Extend the switch below — NEVER interpolate body.cmd into argv.
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const cmd = String(parsed.cmd || '');
    if (!project.path) { res.writeHead(400); res.end('project has no local path'); return true; }
    let spec: CmdSpec | null = null;
    if (cmd === 'git-status')     spec = { bin: 'git', args: ['status'] };
    // Patch view for the Proposals tab — `git log -p -5` shows the
    // last 5 commits as full diffs. After `ngit pr checkout`, HEAD
    // sits on the proposal branch so the user sees its commits.
    // We don't pin against the default branch (no portable way to
    // detect "main" vs "master" vs project-specific) — a fixed N
    // is enough for the cheap-review-then-open-in-editor flow.
    if (cmd === 'git-log-patch') spec = { bin: 'git', args: ['log', '-p', '-5'] };
    if (!spec) { res.writeHead(400); res.end('unknown exec cmd'); return true; }
    spec.env = { ...(spec.env || {}), ...projectEnvContract(project) };
    streamExec(spec, res, req, project.path);
    return true;
  }

  // nsite/deploy is handled natively by projects-nsite-deploy.ts (the
  // in-process pipeline), dispatched ahead of this module in projects.ts.

  return false;
}
