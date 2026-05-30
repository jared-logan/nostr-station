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
 *   POST   /api/projects/:id/ngit/sync         — SSE: ngit fetch + ff-merge + ngit push
 *   POST   /api/projects/:id/exec              — SSE
 *   POST   /api/projects/:id/nsite/deploy      — SSE
 *   GET    /api/projects/:id/git-state         — sync.getProjectGitState
 *   GET    /api/projects/:id/git-identity      — resolved repo-local identity + source
 *   PUT    /api/projects/:id/git-identity      — set repo-local override
 *   DELETE /api/projects/:id/git-identity      — clear repo-local override
 *   GET    /api/projects/:id/dev-server        — allocate-or-read port + running flag
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
import {
  readProjects, getProject, createProject, updateProject, deleteProject,
  detectPath, resolveProjectContext,
  isStacksProject, hasDevScript, validateProjectPath,
} from '../projects.js';
import { checkCollision, scaffoldProject } from '../project-scaffold.js';
import { getTemplate } from '../templates.js';
import {
  ensureConfigDir, readProjectAiConfig,
  writeSystemPromptOverride, writeProjectContextOverlay,
  writeProjectPermissions, writeProjectChatOverride,
  deleteSystemPromptOverride, deleteProjectContextOverlay,
  deleteProjectPermissions, deleteProjectChatOverride,
} from '../project-config.js';
import {
  allocatePort as allocateDevServerPort,
  getState as getDevServerState,
  forgetProject as forgetDevServerProject,
} from '../dev-server-registry.js';
import { handleProjectsNgit } from './projects-ngit.js';
import { handleProjectsGit }  from './projects-git.js';
import { handleProjectsSync } from './projects-sync.js';
import { handleProjectsExec } from './projects-exec.js';
import { handleProjectsNsiteDeploy } from './projects-nsite-deploy.js';
import { handleTestIdentities } from './test-identities.js';
import { promote } from '../promote.js';
import {
  readBody, setActiveChatProjectId,
} from './_shared.js';

export async function handleProjects(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  // Strip the query string before path matching. The legacy projMatch
  // regex below pins to `$` so a URL like `/api/projects/:id/git/diff
  // ?path=…` would otherwise fail to match and fall through as
  // "unknown project endpoint" — same trick repo.ts uses for its own
  // routes. The downstream handlers that need query params re-parse
  // `req.url` directly, so this strip is purely about dispatch.
  const qIdx = url.indexOf('?');
  if (qIdx >= 0) url = url.slice(0, qIdx);
  // ── Projects ───────────────────────────────────────────────────────
  if (url === '/api/projects' && method === 'GET') {
    // Annotate each project with derived flags:
    //   - stacksProject — has stack.json (gates Dork/dev/deploy).
    //   - previewable   — has package.json with a `dev` script. Gates
    //                     the chat panel's live-preview pane. Wider
    //                     net than stacksProject so shakespeare.diy
    //                     clones (vite.config.ts + package.json, no
    //                     stack.json) get the iframe too.
    //   - pathMissing   — path was recorded but the dir no longer
    //                     exists on disk (user deleted the folder
    //                     outside nostr-station, or scaffold
    //                     failed between mkdir and register). The
    //                     UI uses this to paint the card red and
    //                     guide the user toward Remove.
    // All cheap fs checks — list size is single-digit on any install
    // we've seen.
    const annotated = readProjects().map(p => ({
      ...p,
      stacksProject: isStacksProject(p),
      previewable:   hasDevScript(p),
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

    // Three input shapes here, resolved in priority order:
    //   1. `templateId` — registry lookup → use that template's source.
    //   2. `source: { type: 'git-url', url }` — explicit clone URL.
    //   3. `source: { type: 'local-only' }` (or anything unrecognized)
    //      — plain `git init` blank-canvas project.
    //
    // ngit clones go through the dedicated /api/ngit/clone path because
    // they validate the nostr:// / naddr1 URL format and use the
    // existing Scan flow. Default to local-only on unknown / missing
    // input so we never accidentally shell out to something unexpected.
    const templateId = typeof parsed.templateId === 'string' ? parsed.templateId : null;
    let source: import('../project-scaffold.js').ScaffoldSource = { type: 'local-only' };
    if (templateId) {
      const t = getTemplate(templateId);
      if (!t) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `template "${templateId}" not found` }));
        return true;
      }
      source = t.source;
    } else {
      const src = parsed.source;
      if (src && typeof src === 'object') {
        if (src.type === 'git-url' && typeof src.url === 'string') {
          source = { type: 'git-url', url: src.url };
        } else if (src.type === 'local-only') {
          source = { type: 'local-only' };
        }
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
    await scaffoldProject(name, source, res, identity, templateId);
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
      res.end(JSON.stringify({
        ...project,
        stacksProject: isStacksProject(project),
        previewable:   hasDevScript(project),
      }));
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
      if (r.ok) forgetDevServerProject(id);
      res.writeHead(r.ok ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: r.ok }));
      return true;
    }

    // Dev server status — what port we'd spawn vite on for this project
    // and whether a station-managed PTY currently holds it. Allocating on
    // GET means the iframe URL is ready before the user clicks Start, so
    // a single fetch can decide what to render (preview vs. empty state).
    // Returns 200 with `previewable: false` when the project has no
    // `npm run dev` script — callers should hide the preview pane
    // entirely in that case rather than offer a Start button that would
    // immediately fail.
    if (tail === 'dev-server' && method === 'GET') {
      const previewable = hasDevScript(project);
      if (!previewable) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ previewable: false, running: false, port: null, url: null }));
        return true;
      }
      const port = allocateDevServerPort(id);
      const state = getDevServerState(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        previewable: true,
        running:   state?.running ?? false,
        port,
        url:       `http://localhost:${port}`,
        sessionId: state?.sessionId ?? null,
        startedAt: state?.startedAt ?? null,
      }));
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
      if (r.ok) forgetDevServerProject(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok:          r.ok,
        unregistered: r.ok,
        removedPath:  rmError ? null : normalizedTarget,
        rmError,
      }));
      return true;
    }

    if (tail.startsWith('git/') || tail === 'git-identity' || tail === 'git-state' || tail === 'git-init') {
      if (await handleProjectsGit(req, res, project, tail, method)) return true;
    }

    // Native nsite deploy (in-process pipeline over SSE). Must run before
    // handleProjectsExec so the old CLI shell-out can't claim the route.
    if (tail === 'nsite/deploy') {
      if (await handleProjectsNsiteDeploy(req, res, project, tail, method)) return true;
    }

    if (tail === 'stacks/deploy' || tail === 'exec') {
      if (await handleProjectsExec(req, res, project, tail, method)) return true;
    }

    if (tail.startsWith('ngit/')) {
      if (await handleProjectsNgit(req, res, project, tail, method)) return true;
    }

    if (tail.startsWith('test-identities')) {
      if (await handleTestIdentities(req, res, project, tail, method)) return true;
    }

    // ── Promote — local-to-prod deploy journey (Phase E) ──────────────
    if (tail === 'promote' && method === 'POST') {
      let parsed: any = {};
      try { parsed = JSON.parse(await readBody(req)); } catch {}
      const result = await promote(project, {
        apply: !!parsed.apply,
        since: typeof parsed.since === 'number' ? parsed.since : undefined,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
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
    // Per-project git identity. Source attribution ('local' / 'global'
    // / 'unset') lets the Settings UI render "inherited from global"
    // vs. "set per-project" without an extra round-trip.
    if (tail === 'sync' || tail === 'snapshot' || tail === 'save') {
      if (await handleProjectsSync(req, res, project, tail, method)) return true;
    }

    // ── Per-project AI configuration bundle ─────────────────────────
    //
    // Read returns the merged view: each field is null when the project
    // doesn't override that layer (caller falls through to global →
    // built-in resolution server-side at chat time). Write accepts a
    // partial bundle and persists each present field. Nulls explicitly
    // clear the override (the file is removed).
    if (tail === 'ai-config' && method === 'GET') {
      if (!project.path) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'project has no local path' }));
        return true;
      }
      const bundle = readProjectAiConfig(project);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(bundle));
      return true;
    }
    if (tail === 'ai-config' && method === 'PUT') {
      if (!project.path) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'project has no local path' }));
        return true;
      }
      let parsed: any = {};
      try { parsed = JSON.parse(await readBody(req)); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad json' }));
        return true;
      }
      try {
        ensureConfigDir(project);
        // For each field: string → write; null → clear; undefined → ignore.
        // The delete helpers know whether their target file lives in the
        // shareable `<project>/.nostr-station/` dir or the per-user
        // `~/.config/nostr-station/projects/<id>/` dir, so the route
        // doesn't have to know that distinction.
        if (parsed.systemPrompt === null) {
          deleteSystemPromptOverride(project);
        } else if (typeof parsed.systemPrompt === 'string') {
          writeSystemPromptOverride(project, parsed.systemPrompt);
        }
        if (parsed.projectContext === null) {
          deleteProjectContextOverlay(project);
        } else if (typeof parsed.projectContext === 'string') {
          writeProjectContextOverlay(project, parsed.projectContext);
        }
        if (parsed.permissions === null) {
          deleteProjectPermissions(project);
        } else if (parsed.permissions && typeof parsed.permissions === 'object'
                   && (parsed.permissions.mode === 'read-only'
                       || parsed.permissions.mode === 'auto-edit'
                       || parsed.permissions.mode === 'yolo')) {
          writeProjectPermissions(project, { mode: parsed.permissions.mode });
        }
        if (parsed.chat === null) {
          deleteProjectChatOverride(project);
        } else if (parsed.chat && typeof parsed.chat === 'object') {
          const ch: { provider?: string; model?: string } = {};
          if (typeof parsed.chat.provider === 'string') ch.provider = parsed.chat.provider;
          if (typeof parsed.chat.model    === 'string') ch.model    = parsed.chat.model;
          writeProjectChatOverride(project, ch);
        }
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e?.message || 'write failed' }));
        return true;
      }
      const bundle = readProjectAiConfig(project);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(bundle));
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
