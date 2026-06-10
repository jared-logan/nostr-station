/**
 * Projects/git sub-routes — extracted from routes/projects.ts as part of
 * the D12 split. Owns everything in the "plain git" surface plus the
 * repo-local identity + state + init helpers (`git-identity`, `git-state`,
 * `git-init` tails).
 *
 * Surface (verbatim from the pre-split inline blocks):
 *   GET    /api/projects/:id/git/status
 *   GET    /api/projects/:id/git/log
 *   POST   /api/projects/:id/git/pull           — SSE
 *   POST   /api/projects/:id/git/push           — SSE (publish or git push)
 *   GET    /api/projects/:id/git-identity       — resolved repo-local identity + source
 *   PUT    /api/projects/:id/git-identity       — set repo-local override
 *   DELETE /api/projects/:id/git-identity       — clear repo-local override
 *   GET    /api/projects/:id/git-state          — sync.getProjectGitState
 *                                                 (?fetch=1 forces a fresh remote fetch first;
 *                                                 default fire-and-forgets a TTL'd background one)
 *   POST   /api/projects/:id/git/merge-remote   — JSON: sync.mergeRemote (diverged recovery)
 *   POST   /api/projects/:id/git/rescue-branch  — SSE: sync.rescueBranch (park work on a branch)
 *   POST   /api/projects/:id/git/checkout       — JSON: sync.checkoutBranch (guarded switch)
 *   POST   /api/projects/:id/git-init           — SSE: init + seed identity + add -A + commit
 *
 * Contract identical to handleProjects: returns true iff a response was
 * written; false lets the parent fall through.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import {
  projectGitStatus, projectGitLog, projectGitDiff, validateProjectPath,
} from '../projects.js';
import type { Project } from '../projects.js';
import {
  readProjectGitIdentity, writeProjectGitIdentity, clearProjectGitIdentity,
  seedRepoGitIdentityIfMissing,
} from '../git-identity.js';
import { readIdentity } from '../identity.js';
import {
  getProjectGitState, refreshRemoteState,
  mergeRemote, rescueBranch, checkoutBranch, BRANCH_NAME_RE,
} from '../sync.js';
import {
  readBody, streamExec, streamExecError,
  CLI_BIN, type CmdSpec,
} from './_shared.js';

export async function handleProjectsGit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  project: Project,
  tail: string,
  method: string,
): Promise<boolean> {
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
  if (tail === 'git/diff' && method === 'GET') {
    // Per-file diff for the Code-tab Changes view. Query parameter `path`
    // is repo-relative; projectGitDiff validates and refuses traversal.
    if (!project.path) { res.writeHead(400); res.end('project has no local path'); return true; }
    const url = new URL(req.url ?? '', 'http://internal');
    const qPath = url.searchParams.get('path') ?? '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(projectGitDiff(project.path, qPath)));
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
    // ngit only  → git push origin HEAD via git-remote-nostr
    //
    // ngit 2.x dropped the `ngit push` subcommand entirely — pushing
    // is now stock git against a nostr:// remote URL, with the
    // git-remote-nostr helper (installed alongside the ngit binary)
    // handling the actual signing + relay publishing under the hood.
    // ngit init configures `origin` to the nostr URL, so the same
    // `git push origin HEAD` works across git, ngit, and combined
    // projects — only the helper / endpoint at the other end differs.
    let spec: CmdSpec;
    if (project.capabilities.git && project.capabilities.ngit) {
      spec = { bin: process.execPath, args: [CLI_BIN, 'publish', '--yes'], env: { NO_COLOR: '1', TERM: 'dumb' } };
    } else if (project.capabilities.git || project.capabilities.ngit) {
      // Preflight: if the repo has no `origin` remote, git push would
      // fail with a cryptic "fatal: 'origin' does not appear…". Surface
      // a readable error through the existing SSE modal instead.
      try {
        execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: project.path, stdio: 'pipe' });
      } catch {
        const hint = project.capabilities.ngit
          ? "No git remote named 'origin' — run `ngit init` from the project's ngit tab to configure one."
          : "No git remote named 'origin' — add one in project Settings.";
        streamExecError(res, req, hint);
        return true;
      }
      spec = { bin: 'git', args: ['push', 'origin', 'HEAD'] };
    } else {
      res.writeHead(400); res.end('no push-capable capability enabled'); return true;
    }
    streamExec(spec, res, req, project.path);
    return true;
  }

  if (tail === 'git-identity' && method === 'GET') {
    if (!project.path) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'project has no local path' }));
      return true;
    }
    const resolved = readProjectGitIdentity(project.path);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(resolved));
    return true;
  }
  if (tail === 'git-identity' && method === 'PUT') {
    if (!project.path) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'project has no local path' }));
      return true;
    }
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const r = writeProjectGitIdentity(project.path, {
      name:  typeof parsed.name  === 'string' ? parsed.name  : '',
      email: typeof parsed.email === 'string' ? parsed.email : '',
    });
    res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
    return true;
  }
  if (tail === 'git-identity' && method === 'DELETE') {
    // Clears the repo-local override so the project inherits the
    // global identity (or hits the "Author identity unknown" wall
    // again if global is also empty — explicit user choice).
    if (!project.path) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'project has no local path' }));
      return true;
    }
    const r = clearProjectGitIdentity(project.path);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
    return true;
  }

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
    // The badge-truthfulness hook. Default: fire-and-forget a TTL'd
    // background fetch so the NEXT poll carries fresh ahead/behind —
    // zero added latency on the 30 s polling hot path. `?fetch=1`
    // (popover open, pre-push check) blocks on a forced fetch so the
    // response is truthful at the moment the user is about to act.
    const url = new URL(req.url ?? '', 'http://internal');
    if (url.searchParams.get('fetch') === '1') {
      await refreshRemoteState(project, { force: true }).catch(() => {});
    } else {
      void refreshRemoteState(project).catch(() => {});
    }
    const state = await getProjectGitState(project);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state));
    return true;
  }

  // ── Diverged recovery + branch awareness (never-dead-end sync) ─────
  if (tail === 'git/merge-remote' && method === 'POST') {
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
    // 200 even on ok:false — the body is the actionable signal (incl.
    // conflict:true), mirroring the /sync endpoint's contract.
    const result = await mergeRemote(project);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }

  if (tail === 'git/rescue-branch' && method === 'POST') {
    if (!project.path) { streamExecError(res, req, 'project has no local path'); return true; }
    try { validateProjectPath(project.path); }
    catch (e) { streamExecError(res, req, (e as Error).message); return true; }
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const branchName = typeof parsed.branchName === 'string' ? parsed.branchName.trim() : '';
    if (!BRANCH_NAME_RE.test(branchName)) {
      streamExecError(res, req, 'branch name must be 1-64 chars starting with a letter: alphanumerics + . _ -');
      return true;
    }
    // SSE so the exec modal shows each git step as it runs, matching
    // every other multi-phase write flow.
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });
    const emit = (p: object) => { try { res.write(`data: ${JSON.stringify(p)}\n\n`); } catch {} };
    const r = await rescueBranch(project, branchName, (line, stream) => emit({ line, stream }));
    if (!r.ok) emit({ line: r.message, stream: 'stderr' });
    else       emit({ line: r.message, stream: 'stdout' });
    emit({ done: true, code: r.ok ? 0 : 1 });
    try { res.end(); } catch {}
    return true;
  }

  if (tail === 'git/checkout' && method === 'POST') {
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
    const branch = typeof parsed.branch === 'string' ? parsed.branch.trim() : '';
    const result = await checkoutBranch(project, branch);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }

  // ── git-init (Phase 1e: initial-commit assist) ────────────────────
  //
  // For projects where the directory isn't a git repo yet — typically
  // a user-created dir adopted as a Project but never `git init`-ed.
  // The Phase 1d publish wizard used to disable itself with a
  // pointer at Settings, but Settings only edits the project record
  // (name/path/capabilities), not the directory itself. This
  // endpoint closes the loop:
  //
  //     git init
  //     <seed user.name / user.email from station identity if missing>
  //     git add -A
  //     git commit -m '<message>' (default: "initial commit")
  //
  // SSE stream so the publish panel can render the same exec-modal
  // feedback as every other write flow. Each command runs
  // sequentially; if any step exits non-zero the chain stops and
  // the `done` frame carries that exit code. No shell — every
  // spawn uses execFile-equivalent argv.
  if (tail === 'git-init' && method === 'POST') {
    if (!project.path) {
      streamExecError(res, req, 'project has no local path');
      return true;
    }
    try { validateProjectPath(project.path); }
    catch (e) { streamExecError(res, req, (e as Error).message); return true; }
    // Idempotent: a directory that's already a git repo doesn't
    // need re-initialising. We still run add+commit so the user can
    // use this endpoint to make a first commit on a repo they
    // already created manually.
    const alreadyRepo = fs.existsSync(path.join(project.path, '.git'));
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); } catch { /* body optional */ }
    const message = typeof parsed?.message === 'string' && parsed.message.trim()
      ? parsed.message.trim().slice(0, 240)
      : 'initial commit';

    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });
    const emit = (payload: any) => {
      try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {}
    };

    // Spawn helper — same shape as streamExec's internals, but
    // sequenced. Resolves with the exit code so the chain can
    // short-circuit on non-zero.
    const runStep = (_label: string, args: string[]): Promise<number> => new Promise((resolveStep) => {
      emit({ line: `$ git ${args.join(' ')}`, stream: 'stdout' });
      const child = spawn('git', args, {
        cwd: project.path!,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
      });
      const pushChunk = (buf: Buffer, stream: 'stdout' | 'stderr') => {
        for (const line of buf.toString().split('\n')) {
          if (line.length) emit({ line, stream });
        }
      };
      child.stdout.on('data', (b) => pushChunk(b, 'stdout'));
      child.stderr.on('data', (b) => pushChunk(b, 'stderr'));
      child.on('error', (e) => {
        emit({ line: `[${_label}] spawn error: ${e?.message ?? 'unknown'}`, stream: 'stderr' });
        resolveStep(-1);
      });
      child.on('close', (code) => resolveStep(code ?? 0));
    });

    (async () => {
      let code = 0;
      // Step 1: init (skipped when already a repo).
      if (!alreadyRepo) {
        code = await runStep('init', ['init']);
        if (code !== 0) { emit({ done: true, code }); try { res.end(); } catch {} return; }
      } else {
        emit({ line: '[skip] .git already present', stream: 'stdout' });
      }
      // Step 2: seed git identity if missing. Without user.name +
      // user.email `git commit` exits non-zero with a confusing
      // message; this matches what /api/ngit/clone does after a
      // successful clone, so the user never hits the "Author
      // identity unknown" wall on first commit.
      try {
        seedRepoGitIdentityIfMissing(project.path!, readIdentity());
        emit({ line: '[seeded git user identity from station defaults]', stream: 'stdout' });
      } catch (e: any) {
        emit({ line: `[git identity seed warning: ${e?.message ?? 'unknown'}]`, stream: 'stderr' });
      }
      // Step 3: add -A.
      code = await runStep('add', ['add', '-A']);
      if (code !== 0) { emit({ done: true, code }); try { res.end(); } catch {} return; }
      // Step 4: commit. `git commit` exits 1 with no error message
      // when there's nothing to commit — treat that as success
      // (the repo is initialised, just empty).
      code = await runStep('commit', ['commit', '-m', message]);
      if (code !== 0) {
        // Probe to distinguish "no changes" (benign) from real error.
        emit({ line: '[no changes to commit — empty repo initialised]', stream: 'stdout' });
        code = 0;
      }
      emit({ done: true, code });
      try { res.end(); } catch {}
    })();

    req.on('close', () => { /* response already streaming; nothing to clean up here */ });
    return true;
  }

  return false;
}
