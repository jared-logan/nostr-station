/**
 * Projects routes — split out of `web-server.ts` as part of the route-group
 * refactor. Pure dispatch by URL + method; the orchestrator handles auth,
 * CSRF, and DNS-rebinding checks before any of these handlers see the
 * request.
 *
 * Surface (verbatim from the pre-refactor inline blocks):
 *   GET    /api/projects                       — annotated registry
 *   POST   /api/projects                       — createProject
 *   POST   /api/projects/detect                — detectPath
 *   GET    /api/stacks/config                  — sanitized Stacks config
 *   POST   /api/projects/new/check             — collision pre-flight
 *   POST   /api/projects/new                   — scaffold new project (SSE)
 *   GET    /api/projects/:id                   — single project
 *   PATCH  /api/projects/:id                   — updateProject
 *   DELETE /api/projects/:id                   — unregister only
 *   POST   /api/projects/:id/purge             — rm -rf + unregister
 *   GET    /api/projects/:id/git/status
 *   GET    /api/projects/:id/git/log
 *   POST   /api/projects/:id/git/pull          — SSE
 *   POST   /api/projects/:id/git/push          — SSE
 *   POST   /api/projects/:id/stacks/deploy     — SSE
 *   GET    /api/projects/:id/ngit/status
 *   GET    /api/projects/:id/ngit/proposals    — kind-1617 list
 *   POST   /api/projects/:id/ngit/push         — SSE
 *   POST   /api/projects/:id/ngit/init         — SSE
 *   POST   /api/projects/:id/ngit/download     — SSE: ngit pr checkout <id>
 *   POST   /api/projects/:id/ngit/send         — SSE: ngit send (current branch)
 *   POST   /api/projects/:id/exec              — SSE
 *   POST   /api/projects/:id/nsite/deploy      — SSE
 *   GET    /api/projects/:id/git-state         — sync.getProjectGitState
 *   POST   /api/projects/:id/sync              — sync.syncProject
 *   POST   /api/projects/:id/snapshot          — sync.snapshotProject
 *   POST   /api/chat/context                   — set active project
 *   GET    /api/chat/context[/:id]             — read active context
 *
 * Returns `true` when the request was matched and a response was written;
 * `false` lets the orchestrator continue trying its remaining route groups.
 */
import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  readProjects, getProject, createProject, updateProject, deleteProject,
  detectPath, projectGitStatus, projectGitLog, resolveProjectContext,
  isStacksProject, validateProjectPath,
} from '../projects.js';
import { checkCollision, scaffoldProject } from '../project-scaffold.js';
import { isValidRelayUrl } from '../identity.js';
import {
  getProjectGitState, syncProject, snapshotProject, fetchNgitProposals,
} from '../sync.js';
import {
  readBody, streamExec, streamExecError, setActiveChatProjectId,
  CLI_BIN, type CmdSpec,
} from './_shared.js';

export async function handleProjects(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  // ── Projects ───────────────────────────────────────────────────────
  if (url === '/api/projects' && method === 'GET') {
    // Annotate each project with two derived flags:
    //   - stacksProject — has stack.json (gates Dork/dev/deploy).
    //   - pathMissing   — path was recorded but the dir no longer
    //                     exists on disk (user deleted the folder
    //                     outside nostr-station, or scaffold
    //                     failed between mkdir and register). The
    //                     UI uses this to paint the card red and
    //                     guide the user toward Remove.
    // Both are cheap fs checks — list size is single-digit on any
    // install we've seen.
    const annotated = readProjects().map(p => ({
      ...p,
      stacksProject: isStacksProject(p),
      pathMissing:   !!p.path && !fs.existsSync(p.path),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(annotated));
    return true;
  }
  if (url === '/api/projects' && method === 'POST') {
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const r = createProject(parsed);
    if (!r.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: r.error }));
      return true;
    }
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r.project));
    return true;
  }
  if (url === '/api/projects/detect' && method === 'POST') {
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const p = String(parsed.path || '').trim();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(detectPath(p)));
    return true;
  }

  // New-project scaffold flow — two endpoints. /check is a cheap
  // synchronous pre-flight the client uses to decide whether to open
  // the collision modal ("directory exists — adopt it instead?") or
  // proceed to the streaming scaffold. /new itself runs long (npm
  // install inside mkstack) so it emits SSE in the same frame shape
  // as /api/exec/install/* — openExecModal can render it directly.
  // Sanitized read of Stacks's config — exposes which providers
  // have a configured key (id only — never the key itself) so the
  // Config panel's Stacks AI section can show "configured" status
  // without the user needing to leave the dashboard. Stacks stores
  // its config at ~/Library/Preferences/stacks/config.json on macOS;
  // path differs on linux but stacks resolves it itself when the
  // user runs stacks configure.
  if (url === '/api/stacks/config' && method === 'GET') {
    const candidates = [
      path.join(os.homedir(), 'Library', 'Preferences', 'stacks', 'config.json'),
      path.join(os.homedir(), '.config', 'stacks', 'config.json'),
    ];
    let cfg: any = null;
    let foundAt: string | null = null;
    for (const p of candidates) {
      try {
        const raw = fs.readFileSync(p, 'utf8');
        cfg = JSON.parse(raw);
        foundAt = p;
        break;
      } catch { /* try next */ }
    }
    const providers = cfg && cfg.providers && typeof cfg.providers === 'object'
      ? Object.keys(cfg.providers)
      : [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      configured: providers.length > 0,
      providers,                  // ids only — no keys, no baseURLs
      configPath: foundAt,
      recentModels: Array.isArray(cfg?.recentModels) ? cfg.recentModels : [],
    }));
    return true;
  }

  if (url === '/api/projects/new/check' && method === 'POST') {
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const report = checkCollision(String(parsed.name || ''));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(report));
    return true;
  }
  if (url === '/api/projects/new' && method === 'POST') {
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad json' }));
      return true;
    }
    const name = String(parsed.name || '');

    // Two source types here: 'local-only' (plain git init) and
    // 'git-url' (git clone + freshen). ngit clones go through the
    // dedicated /api/ngit/clone path because they validate the
    // nostr:// / naddr1 URL format and use the existing Scan flow.
    // Default to local-only on unknown / missing source so we never
    // accidentally shell out to something unexpected.
    const src = parsed.source;
    let source: import('../project-scaffold.js').ScaffoldSource = { type: 'local-only' };
    if (src && typeof src === 'object') {
      if (src.type === 'git-url' && typeof src.url === 'string') {
        source = { type: 'git-url', url: src.url };
      } else if (src.type === 'local-only') {
        source = { type: 'local-only' };
      }
    }
    // Identity: station-default unless the client explicitly opts
    // the project into a project-specific npub + optional bunker.
    // scaffoldProject + projects.validateInput own the validation
    // (nsec rejection, bunker URL format); we just shape the object.
    let identity: import('../project-scaffold.js').ScaffoldIdentity = {
      useDefault: true, npub: null, bunkerUrl: null,
    };
    const rawIdent = parsed.identity;
    if (rawIdent && typeof rawIdent === 'object' && rawIdent.useDefault === false) {
      identity = {
        useDefault: false,
        npub:       typeof rawIdent.npub === 'string'      ? rawIdent.npub.trim()      : null,
        bunkerUrl:  typeof rawIdent.bunkerUrl === 'string' ? rawIdent.bunkerUrl.trim() : null,
      };
    }
    await scaffoldProject(name, source, res, identity);
    return true;
  }

  const projMatch = url.match(/^\/api\/projects\/([a-f0-9-]{10,})(?:\/(.*))?$/);
  if (projMatch) {
    const id = projMatch[1];
    const tail = projMatch[2] || '';
    const project = getProject(id);
    if (!project) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'project not found' }));
      return true;
    }

    if (tail === '' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...project, stacksProject: isStacksProject(project) }));
      return true;
    }
    if (tail === '' && method === 'PATCH') {
      let parsed: any = {};
      try { parsed = JSON.parse(await readBody(req)); }
      catch { res.writeHead(400); res.end('bad json'); return true; }
      const r = updateProject(id, parsed);
      if (!r.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: r.error }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.project));
      return true;
    }
    if (tail === '' && method === 'DELETE') {
      const r = deleteProject(id);
      res.writeHead(r.ok ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: r.ok }));
      return true;
    }

    // Hard delete: rm -rf the project path, then unregister. POST
    // (not DELETE) because the operation is irreversible and the
    // UI path uses a type-to-confirm dialog. Safety guardrails are
    // delegated to `validateProjectPath` (src/lib/projects.ts):
    //   - path must be absolute
    //   - path must be inside the projects root (HOME by default, or
    //     STATION_PROJECTS_ROOT when set) after symlink + `..` collapse
    //   - path must not BE the projects root itself
    // Failures surface as 4xx with a message; the rm itself is
    // best-effort — even if it partially fails, we unregister so
    // the user isn't stuck with a broken card pointing at a
    // now-partial path.
    if (tail === 'purge' && method === 'POST') {
      const target = project.path || '';
      if (!target) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'project has no local path to delete' }));
        return true;
      }
      let normalizedTarget: string;
      try {
        normalizedTarget = validateProjectPath(target);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: `refusing to delete ${target}: ${(e as Error).message}`,
        }));
        return true;
      }
      let rmError: string | null = null;
      try {
        fs.rmSync(normalizedTarget, { recursive: true, force: true });
      } catch (e: any) {
        rmError = e?.message || 'rm failed';
      }
      const r = deleteProject(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok:          r.ok,
        unregistered: r.ok,
        removedPath:  rmError ? null : normalizedTarget,
        rmError,
      }));
      return true;
    }

    if (tail === 'git/status' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(projectGitStatus(project.path || '')));
      return true;
    }
    if (tail === 'git/log' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(projectGitLog(project.path || '')));
      return true;
    }
    if (tail === 'git/pull' && method === 'POST') {
      if (!project.path) { res.writeHead(400); res.end('project has no local path'); return true; }
      streamExec({ bin: 'git', args: ['pull', '--no-rebase', '--ff-only'] }, res, req, project.path);
      return true;
    }
    if (tail === 'git/push' && method === 'POST') {
      if (!project.path) { res.writeHead(400); res.end('project has no local path'); return true; }
      // Route based on which capabilities are enabled.
      // git + ngit → nostr-station publish --yes (handles both remotes)
      // git only   → git push origin HEAD
      // ngit only  → ngit push
      let spec: CmdSpec;
      if (project.capabilities.git && project.capabilities.ngit) {
        spec = { bin: process.execPath, args: [CLI_BIN, 'publish', '--yes'], env: { NO_COLOR: '1', TERM: 'dumb' } };
      } else if (project.capabilities.git) {
        // Preflight: if the repo has no `origin` remote, git push would
        // fail with a cryptic "fatal: 'origin' does not appear…". Surface
        // a readable error through the existing SSE modal instead.
        try {
          execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: project.path, stdio: 'pipe' });
        } catch {
          streamExecError(res, req, "No git remote named 'origin' — add one in project Settings.");
          return true;
        }
        spec = { bin: 'git', args: ['push', 'origin', 'HEAD'] };
      } else if (project.capabilities.ngit) {
        spec = { bin: 'ngit', args: ['push'] };
      } else {
        res.writeHead(400); res.end('no push-capable capability enabled'); return true;
      }
      streamExec(spec, res, req, project.path);
      return true;
    }

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
        { bin: 'npm', args: ['run', 'deploy'] },
        res, req, project.path,
        { line: `$ npm run deploy  (cwd: ${project.path})`, stream: 'stdout' },
      );
      return true;
    }

    if (tail === 'ngit/status' && method === 'GET') {
      // Mask bunker URL to domain-only for display.
      const bunker = project.identity.bunkerUrl;
      let bunkerDomain: string | null = null;
      if (bunker) {
        try { bunkerDomain = new URL(bunker.replace(/^bunker:/, 'https:')).host; }
        catch { bunkerDomain = 'bunker'; }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        remote: project.remotes.ngit,
        bunkerDomain,
        useDefault: project.identity.useDefault,
      }));
      return true;
    }
    if (tail === 'ngit/proposals' && method === 'GET') {
      // Same kind-1617 query that the sync flow runs, exposed on its
      // own URL so the project drawer's Proposals tab can refresh
      // independently — opening the tab shouldn't trigger a fetch +
      // fast-forward, just the relay query. Returns an empty array
      // when the project has no ngit remote (rather than 400) so the
      // tab can render a friendly empty state without branching on
      // HTTP status.
      const proposals = await fetchNgitProposals(project).catch(() => []);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ proposals }));
      return true;
    }
    if (tail === 'ngit/push' && method === 'POST') {
      if (!project.path) { res.writeHead(400); res.end('project has no local path'); return true; }
      streamExec({ bin: 'ngit', args: ['push'] }, res, req, project.path);
      return true;
    }

    if (tail === 'ngit/send' && method === 'POST') {
      // Opens a proposal (kind-1617 + patch events) from the current
      // branch by spawning `ngit send`. ngit pulls the branch state
      // and signing identity from the local repo + Amber session;
      // there are no user-supplied args to validate. The frontend
      // gates the button on (ngit cap + non-default branch + ahead
      // count > 0) so the SSE modal only opens with something to
      // actually send. Streaming output here is essential — `ngit
      // send` triggers Amber sign prompts on the user's phone, and
      // the modal is how the user knows to look at their device.
      if (!project.path) { res.writeHead(400); res.end('project has no local path'); return true; }
      streamExec(
        { bin: 'ngit', args: ['send'], env: { NO_COLOR: '1', TERM: 'dumb' } },
        res, req, project.path,
      );
      return true;
    }
    if (tail === 'ngit/download' && method === 'POST') {
      // Wraps `ngit pr checkout <event-id>` for the Proposals tab's
      // Download button. The event id arrives in a JSON body and is
      // validated as 64 lowercase hex chars before being handed to
      // ngit as a fixed argv element — same defense-in-depth pattern
      // as the relay validation in ngit/init below. spawn is shell-
      // free, so this is belt-and-suspenders, but it also keeps
      // garbage out of logs and the SSE stream.
      if (!project.path) { res.writeHead(400); res.end('project has no local path'); return true; }
      let parsed: any = {};
      try { parsed = JSON.parse(await readBody(req)); }
      catch { res.writeHead(400); res.end('bad json'); return true; }
      const rawId = String(parsed.proposalId || '').trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(rawId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'proposalId must be a 64-char hex event id' }));
        return true;
      }
      streamExec(
        { bin: 'ngit', args: ['pr', 'checkout', rawId], env: { NO_COLOR: '1', TERM: 'dumb' } },
        res, req, project.path,
      );
      return true;
    }
    if (tail === 'ngit/init' && method === 'POST') {
      if (!project.path) { res.writeHead(400); res.end('project has no local path'); return true; }
      // Relay URL arrives in a JSON body and is validated strictly before
      // being handed to ngit as a fixed argv element. The validator
      // rejects whitespace and any non-ws(s):// scheme, so there's no
      // path for a user string to reach the shell.
      let parsed: any = {};
      try { parsed = JSON.parse(await readBody(req)); }
      catch { res.writeHead(400); res.end('bad json'); return true; }
      const raw = String(parsed.relay || '').trim();
      if (!raw || !isValidRelayUrl(raw)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'relay must be a ws:// or wss:// URL' }));
        return true;
      }
      streamExec(
        { bin: 'ngit', args: ['init', '--relay', raw], env: { NO_COLOR: '1', TERM: 'dumb' } },
        res, req, project.path,
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
        { bin: process.execPath, args: [CLI_BIN, 'nsite', 'deploy', '--yes'], env: { NO_COLOR: '1', TERM: 'dumb' } },
        res, req, cwd,
      );
      return true;
    }

    // ── Sync surface (Item 2) ────────────────────────────────────────
    //
    // Three endpoints back the dashboard's git-state badge + Sync /
    // Save-snapshot buttons. All three share the same precondition:
    //   - project must have a local path (else 400 — the sync helpers
    //     already handle missing paths gracefully but the API contract
    //     should refuse early so the dashboard renders an actionable
    //     error rather than a silent ok).
    //   - validateProjectPath must accept the path (defense-in-depth
    //     against a project row whose stored path was recorded before
    //     B2 landed; we never want git/ngit invoked outside HOME).
    //
    // The 404 for unknown :id is handled by the project lookup at the
    // top of the projMatch block — control never reaches here without
    // a real Project in scope.
    if (tail === 'git-state' && method === 'GET') {
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
      const state = await getProjectGitState(project);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state));
      return true;
    }

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
      const result = await syncProject(project);
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

    res.writeHead(404); res.end('unknown project endpoint');
    return true;
  }

  // ── Chat project context ───────────────────────────────────────────
  if (url === '/api/chat/context' && method === 'POST') {
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const projectId = parsed.projectId ? String(parsed.projectId) : null;
    const project   = projectId ? getProject(projectId) : null;
    if (projectId && !project) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'project not found' }));
      return true;
    }
    setActiveChatProjectId(projectId);
    const { source } = resolveProjectContext(project);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      projectId,
      projectName: project?.name || null,
      source,
    }));
    return true;
  }
  const chatCtxMatch = url.match(/^\/api\/chat\/context(?:\/([a-f0-9-]{10,}))?$/);
  if (chatCtxMatch && method === 'GET') {
    const pid = chatCtxMatch[1];
    const project = pid ? getProject(pid) : null;
    if (pid && !project) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'project not found' }));
      return true;
    }
    const { content, source } = resolveProjectContext(project);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      projectId: pid || null,
      projectName: project?.name || null,
      content, source,
    }));
    return true;
  }

  return false;
}
