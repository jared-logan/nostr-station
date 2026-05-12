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
} from '../project-config.js';
import {
  syncProject, snapshotProject,
} from '../sync.js';
import { handleProjectsNgit } from './projects-ngit.js';
import { handleProjectsGit }  from './projects-git.js';
import {
  readBody, streamExec, streamExecError, setActiveChatProjectId,
  getAutoSyncRef,
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
      // If autoSync changed (or any other field — cheap to always
      // call), reconcile the manager so the toggle takes effect
      // inside this response, not on the next interval tick.
      try { getAutoSyncRef()?.reconcile(id); } catch {}
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

    if (tail.startsWith('git/') || tail === 'git-identity' || tail === 'git-state' || tail === 'git-init') {
      if (await handleProjectsGit(req, res, project, tail, method)) return true;
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
        { bin: 'npm', args: ['run', 'deploy'], timeoutMs: 0 },
        res, req, project.path,
        { line: `$ npm run deploy  (cwd: ${project.path})`, stream: 'stdout' },
      );
      return true;
    }

    if (tail.startsWith('ngit/')) {
      if (await handleProjectsNgit(req, res, project, tail, method)) return true;
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
        // systemPrompt: string → write; null → remove file; undefined → ignore.
        if (parsed.systemPrompt === null) {
          const p = path.join(project.path, '.nostr-station', 'system-prompt.md');
          try { fs.unlinkSync(p); } catch {}
        } else if (typeof parsed.systemPrompt === 'string') {
          writeSystemPromptOverride(project, parsed.systemPrompt);
        }
        if (parsed.projectContext === null) {
          const p = path.join(project.path, '.nostr-station', 'project-context.md');
          try { fs.unlinkSync(p); } catch {}
        } else if (typeof parsed.projectContext === 'string') {
          writeProjectContextOverlay(project, parsed.projectContext);
        }
        if (parsed.permissions === null) {
          const p = path.join(project.path, '.nostr-station', 'permissions.json');
          try { fs.unlinkSync(p); } catch {}
        } else if (parsed.permissions && typeof parsed.permissions === 'object'
                   && (parsed.permissions.mode === 'read-only'
                       || parsed.permissions.mode === 'auto-edit'
                       || parsed.permissions.mode === 'yolo')) {
          writeProjectPermissions(project, { mode: parsed.permissions.mode });
        }
        if (parsed.chat === null) {
          const p = path.join(project.path, '.nostr-station', 'chat.json');
          try { fs.unlinkSync(p); } catch {}
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
