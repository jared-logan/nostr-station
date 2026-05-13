/**
 * Projects/exec sub-routes — extracted from routes/projects.ts as part of
 * the D12 split. Owns the three "spawn a long-running process and stream
 * its output" verbs:
 *
 *   POST /api/projects/:id/stacks/deploy — SSE: npm run deploy (mkstack)
 *   POST /api/projects/:id/exec          — SSE: whitelisted read-only commands
 *   POST /api/projects/:id/nsite/deploy  — SSE: nostr-station nsite deploy --yes
 *
 * All three use the shared streamExec helper to wrap a child process in
 * the dashboard's SSE exec-modal protocol. The `exec` route is the only
 * one that takes a JSON body (`{ cmd }`); the others read project context
 * directly.
 *
 * Contract identical to handleProjects: returns true iff a response was
 * written; false lets the parent fall through.
 */
import http from 'http';
import { isStacksProject } from '../projects.js';
import type { Project } from '../projects.js';
import {
  readBody, streamExec, streamExecError,
  CLI_BIN, type CmdSpec,
} from './_shared.js';

export async function handleProjectsExec(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  project: Project,
  tail: string,
  method: string,
): Promise<boolean> {
  if (tail === 'stacks/deploy' && method === 'POST') {
    if (!project.path) {
      streamExecError(res, req, 'project has no local path');
      return true;
    }
    if (!isStacksProject(project)) {
      streamExecError(res, req, 'not a Stacks project (no stack.json found)');
      return true;
    }
    // `npm run deploy` is mkstack's deploy script — bundles, uploads
    // to Blossom, publishes Nostr metadata, returns a NostrDeploy
    // URL. We stream the output as-is; URL parsing + persisting to
    // project.nsite.url is deferred to a follow-up once we've seen
    // the exact stdout format on a real deploy. For now, the user
    // sees the live URL in the exec modal output.
    streamExec(
      { bin: 'npm', args: ['run', 'deploy'], timeoutMs: 0 },
      res, req, project.path,
      { line: `$ npm run deploy  (cwd: ${project.path})`, stream: 'stdout' },
    );
    return true;
  }

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
    streamExec(spec, res, req, project.path);
    return true;
  }

  if (tail === 'nsite/deploy' && method === 'POST') {
    const cwd = project.path || process.cwd();
    streamExec(
      // timeoutMs:0 — Blossom uploads + relay publishes for a real
      // site can legitimately span minutes; the consecutive-line
      // cap inside streamExec still guards against retry-loop
      // floods regardless.
      { bin: process.execPath, args: [CLI_BIN, 'nsite', 'deploy', '--yes'], env: { NO_COLOR: '1', TERM: 'dumb' }, timeoutMs: 0 },
      res, req, cwd,
    );
    return true;
  }

  return false;
}
