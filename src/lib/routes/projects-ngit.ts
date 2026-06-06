/**
 * Projects/ngit sub-routes — extracted from routes/projects.ts as part of
 * the D12 split. The parent route module owns URL parsing and project
 * resolution; this module handles the `ngit/*` tail.
 *
 * Surface (verbatim from the pre-split inline blocks):
 *   GET    /api/projects/:id/ngit/status        — bunker domain + ngit remote
 *   GET    /api/projects/:id/ngit/proposals     — kind-1617 list
 *   POST   /api/projects/:id/ngit/push          — SSE: git push origin HEAD
 *   POST   /api/projects/:id/ngit/grasp-push    — SSE: publish state + push to every GRASP host
 *   POST   /api/projects/:id/ngit/sync          — SSE: pull (ff-only) + GRASP push
 *   POST   /api/projects/:id/ngit/send          — SSE: ngit send --defaults
 *   POST   /api/projects/:id/ngit/download      — SSE: ngit pr checkout <id>
 *   POST   /api/projects/:id/ngit/init          — SSE: ngit init (signer-gated)
 *   POST   /api/projects/:id/ngit/proposal/new  — SSE: one-click PR submit
 *                                                 (branch + optional reset + send)
 *
 * Contract identical to handleProjects: returns true iff a response was
 * written; false lets the parent fall through to the next route group.
 *
 * All routes assume `project` has already been resolved and the request
 * has passed auth + CSRF + DNS-rebinding checks upstream.
 */
import http from 'http';
import { execFileSync, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { fetchNgitProposals } from '../sync.js';
import { isValidRelayUrl, getGraspServers, getEffectiveReadRelays } from '../identity.js';
import { findBin } from '../detect.js';
import { queryRelaysDirect, getTags, type NostrEvent } from '../nostr-query.js';
import { signEventWithSavedBunker } from '../auth-bunker.js';
import { decodeNgitRemote, publishEventToRelays, mergeRelaySet } from './repo.js';
import {
  selectGraspCloneUrls,
  buildRepoStateTags,
  repoStateTagsEqual,
  readLocalRefs,
} from '../grasp-push.js';
import type { Project } from '../projects.js';
import { readBody, streamExec, streamExecError } from './_shared.js';

const execFileAsync = promisify(execFile);

export async function handleProjectsNgit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  project: Project,
  tail: string,
  method: string,
): Promise<boolean> {
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
    // ngit 2.x dropped `ngit push` — pushing is now stock `git push`
    // against the nostr:// origin URL, with git-remote-nostr (the
    // protocol helper installed alongside ngit) doing the signing
    // + relay publishing. Same shape as /git/push above; this
    // endpoint stays distinct because the ngit-tab Push button
    // wires to it specifically.
    // 3-min timeout — Amber sign round-trip + grasp-server upload
    // for a busy repo can take a while; the line-cap still kills
    // any retry-loop well under that.
    streamExec(
      { bin: 'git', args: ['push', 'origin', 'HEAD'], timeoutMs: 180_000 },
      res, req, project.path,
    );
    return true;
  }

  if (tail === 'ngit/grasp-push' && method === 'POST') {
    // Direct per-host push — "land it on every GRASP server, like Shakespeare".
    // Publishes the announcement + signed state to the relays, then pushes the
    // pack to every clone URL itself, so no single git host is left "behind
    // signed". See src/lib/grasp-push.ts for the why + the mirrored algorithm.
    return handleGraspPush(req, res, project);
  }

  if (tail === 'ngit/sync' && method === 'POST') {
    // Bidirectional sync à la Shakespeare's clean ngit popover:
    // pull (fetch + ff-merge) then push, in one SSE stream.
    // Two separate child processes share one response so the user
    // sees both phases scrolling in the same modal — and so a
    // failure in phase 1 cleanly skips phase 2 with a clear marker.
    //
    // Phase 1 must be a real `git pull --ff-only`, not just `git
    // fetch`: a bare fetch updates origin/* refs but leaves local
    // HEAD where it was, so phase 2's push immediately fails
    // non-fast-forward whenever the remote has advanced.
    //
    // Kept distinct from /api/projects/:id/sync (the card-grid
    // icon) which is intentionally pull-only + ff-merge + proposals
    // query. That endpoint stays as-is; this one is the verb users
    // reach for when they want "pull + push, just do the thing".
    if (!project.path) { res.writeHead(400); res.end('project has no local path'); return true; }
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });
    const emit = (p: object) => { try { res.write(`data: ${JSON.stringify(p)}\n\n`); } catch {} };
    const env = { ...process.env, NO_COLOR: '1', TERM: 'dumb' };
    const cwd = project.path;
    let killed = false;
    const onClientClose = () => { killed = true; };
    req.on('close', onClientClose);

    // ngit 2.x dropped both `ngit fetch` and `ngit push` — the 2.x
    // model is stock git via the git-remote-nostr helper. So both
    // phases here spawn `git` against the nostr:// origin URL
    // (configured by `ngit init`), and the helper handles the
    // protocol-specific work transparently.
    const runPhase = (label: string, bin: string, args: string[]): Promise<number> =>
      new Promise((resolve) => {
        if (killed) return resolve(-1);
        emit({ line: `▸ ${label}`, stream: 'stdout' });
        const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env, cwd });
        const pipe = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
          for (const line of chunk.toString().split('\n')) {
            if (line.length) emit({ line, stream });
          }
        };
        child.stdout.on('data', pipe('stdout'));
        child.stderr.on('data', pipe('stderr'));
        child.on('error', (e) => {
          emit({ line: String(e.message || e), stream: 'stderr' });
          resolve(-1);
        });
        child.on('close', (code) => resolve(code ?? -1));
        // Honour client-disconnect during the phase, not just between phases.
        req.on('close', () => { try { child.kill(); } catch {} });
      });

    try {
      const pullCode = await runPhase(
        'git pull --no-rebase --ff-only origin HEAD',
        'git', ['pull', '--no-rebase', '--ff-only', 'origin', 'HEAD'],
      );
      if (pullCode !== 0) {
        emit({ line: `pull failed (exit ${pullCode}) — skipping push`, stream: 'stderr' });
        emit({ done: true, code: pullCode });
        try { res.end(); } catch {}
        return true;
      }
      // Phase 2: GRASP direct push so the sync lands on EVERY server, not just
      // one. Replaces `git push origin HEAD` via git-remote-nostr (which could
      // leave a host "behind signed") with the same delivery the Push/Publish
      // buttons use — pull + push, both landing everywhere.
      const coords = decodeNgitRemote(project);
      if (!coords) {
        emit({ line: 'pulled; project has no ngit remote so there is nothing to push', stream: 'stderr' });
        emit({ done: true, code: 0 });
        try { res.end(); } catch {}
        return true;
      }
      const log = (line: string, stream: 'stdout' | 'stderr' = 'stdout') => emit({ line, stream });
      const coordKey = `${coords.pubkey}:${coords.identifier}`;
      if (graspPushInFlight.has(coordKey)) {
        emit({ line: 'another GRASP push is already in progress — pulled, skipping push', stream: 'stderr' });
        emit({ done: true, code: 0 });
        try { res.end(); } catch {}
        return true;
      }
      graspPushInFlight.add(coordKey);
      let outcome: GraspDeliveryOutcome;
      try {
        outcome = await runGraspDelivery(cwd, coords, project, log);
      } finally {
        graspPushInFlight.delete(coordKey);
      }
      emit({ done: true, code: outcome.status === 'failed' ? 1 : 0, warn: outcome.status === 'partial' });
    } finally {
      try { res.end(); } catch {}
    }
    return true;
  }
  if (tail === 'ngit/send' && method === 'POST') {
    // Opens a proposal (kind-1617 + patch events) from the current
    // branch by spawning `ngit send --defaults`. ngit pulls the
    // branch state and signing identity from the local repo +
    // Amber session; --defaults lets it pick subject/description
    // from the commit message non-interactively (vs. the
    // --interactive flag which would prompt for values via stdin
    // and stall in the SSE modal). The frontend gates the button
    // on (ngit cap + non-default branch + ahead count > 0) so the
    // SSE modal only opens with something to actually send.
    //
    // Pre-fix this called bare `ngit send`, which on ngit 2.x
    // errors with "ngit send requires additional arguments" — the
    // CLI requires either <SINCE_OR_RANGE>, --defaults, or
    // --interactive. --defaults is the headless-friendly choice;
    // future commits can layer a UI for picking SINCE_OR_RANGE
    // when users want PR boundaries narrower than HEAD.
    //
    // Streaming output here is essential — `ngit send` triggers
    // Amber sign prompts on the user's phone, and the modal is
    // how the user knows to look at their device.
    if (!project.path) { res.writeHead(400); res.end('project has no local path'); return true; }
    streamExec(
      { bin: 'ngit', args: ['send', '--defaults'], env: { NO_COLOR: '1', TERM: 'dumb' } },
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
    // Pre-flight signer check. ngit init publishes a signed kind-30617
    // event, so it needs an active NIP-46 session (or an nsec — which
    // we don't store). Reading the same git-config slot /api/ngit/account
    // checks lets us refuse the spawn upfront instead of letting ngit
    // print "logged in as …" then fail downstream on something else,
    // or worse, retry-loop a missing-signer prompt against a closed
    // stdin (the original OOM symptom). The line-cap from streamExec
    // catches the retry-loop too, but failing here gives a much clearer
    // error than the bounded-message frame would.
    let bunkerUri = '';
    try {
      bunkerUri = execFileSync('git', ['config', '--global', '--get', 'nostr.bunker-uri'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString().trim();
    } catch { /* not logged in — bunkerUri stays empty */ }
    if (!bunkerUri) {
      streamExecError(res, req,
        'ngit account not paired — open Config → ngit and click Connect Amber first, ' +
        'then retry Initialize ngit.',
      );
      return true;
    }
    // ngit 2.x dropped the `--relay <url>` argv we used to pass and
    // replaced it with `--name <NAME> [--description <D>]
    // [--grasp-server <URL>...] [--defaults]`. GRASP servers (git+nostr
    // storage protocol) are a separate concept from announcement relays
    // — a regular Nostr relay isn't necessarily grasp-capable, and the
    // pre-fix invocation of `--relay wss://relay.ditto.pub` produced
    // "missing required fields" against ngit 2.4. The new contract:
    //
    //   { name?: string,                  — defaults to project.name
    //     description?: string,           — optional, single line
    //     graspServers?: string[] }       — empty/omitted → --defaults
    //
    // Each grasp-server URL is validated with isValidRelayUrl (same
    // ws/wss check that protected the old --relay arg). Anything that
    // fails validation is rejected with 400; spawn() is shell-free
    // but the pre-spawn check keeps user-typed garbage out of logs
    // and the SSE stream.
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }

    const name = (typeof parsed.name === 'string' && parsed.name.trim())
      ? parsed.name.trim()
      : project.name;
    // Repo identifier follows ngit's expectation: short, no spaces,
    // safe for filesystem paths and URL slugs alike. project.name is
    // already validated upstream but the user can override here.
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'name must be 1-64 chars: alphanumerics, dot, dash, underscore' }));
      return true;
    }
    const description = typeof parsed.description === 'string'
      ? parsed.description.trim().slice(0, 280)        // keep it tweet-length; ngit allows arbitrary
      : '';
    const graspServersRaw: string[] = Array.isArray(parsed.graspServers)
      ? parsed.graspServers.filter((x: unknown): x is string => typeof x === 'string')
      : [];
    const graspServers = graspServersRaw.map(s => s.trim()).filter(Boolean);
    for (const url of graspServers) {
      if (!isValidRelayUrl(url)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `grasp-server must be a ws:// or wss:// URL: ${url}` }));
        return true;
      }
    }

    // NOTE (NIP-89 client tag): `ngit init` is an external CLI and writes
    // the FIRST kind-30617 with its own tag set — it does NOT carry
    // nostr-station's 4-element CLIENT_TAG. We can't inject a tag into the
    // CLI's output. The canonical tag is applied on the first re-announce /
    // Edit Repository save: buildRepoAnnounceTemplate now injects CLIENT_TAG
    // when absent (and upgrades a stale bare one), so a single re-announce
    // after init links the announcement to our handler. We deliberately do
    // NOT auto-republish here — that would emit a second 30617 per init and
    // reintroduce the duplicate-event problem (Bug 3).
    //
    // argv assembly: always pass --name. If user provided grasp
    // servers, pass each as --grasp-server <url>; otherwise
    // --defaults so ngit picks a sensible grasp on its own.
    // --description is appended only when non-empty so we don't
    // hand ngit a literal empty string.
    const args: string[] = ['init', '--name', name];
    if (description) args.push('--description', description);
    if (graspServers.length > 0) {
      for (const url of graspServers) args.push('--grasp-server', url);
    } else {
      args.push('--defaults');
    }
    streamExec(
      { bin: 'ngit', args, env: { NO_COLOR: '1', TERM: 'dumb' } },
      res, req, project.path,
    );
    return true;
  }

  // ── New-proposal one-click flow ─────────────────────────────────
  //
  // The "I want to send a PR" verb. Wraps the multi-step git dance
  // (create branch, optional reset of default, checkout, ngit send)
  // in one SSE stream so contributors never need to drop to a
  // terminal. Driven from the Pull-requests tab's "Submit your local
  // commits as a PR" CTA card (app.js renderProposalsTab).
  //
  // Body:
  //   { branchName: string,
  //     resetMain?: boolean }
  //
  // resetMain=true moves the default branch back to origin/HEAD after
  // the feature branch is created. Off by default — that's the safer
  // choice (user keeps local main mirroring origin OR keeps the
  // commits on main too, depending on whether they reset). On, it
  // matches the GitHub mental model of "branch off upstream, send PR."
  //
  // Validation up-front so we never leave the repo in a half-applied
  // state: clean working tree, on the default branch, ahead > 0,
  // branch name is safe + doesn't already exist.
  if (tail === 'ngit/proposal/new' && method === 'POST') {
    if (!project.path) { res.writeHead(400); res.end('project has no local path'); return true; }
    if (!project.remotes.ngit) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'project has no ngit remote — run ngit init first' }));
      return true;
    }
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }

    const branchName = typeof parsed.branchName === 'string' ? parsed.branchName.trim() : '';
    // Strict branch-name rules: alphanumerics + dot/dash/underscore,
    // no slashes (git allows them but they complicate UI; we can
    // relax later), 1-64 chars, must start with a letter so refs
    // like "-foo" can't slip through and get misread as a flag.
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(branchName)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'branchName must be 1-64 chars starting with a letter: alphanumerics + . _ -' }));
      return true;
    }
    const resetMain = parsed.resetMain === true;

    // Resolve default branch via symbolic-ref. Falls back to "main"
    // if origin/HEAD isn't set (rare but possible for freshly-init'd
    // ngit repos where the symbolic ref wasn't published).
    let defaultBranch = 'main';
    try {
      const out = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
        cwd: project.path, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
      }).toString().trim();
      if (out.startsWith('origin/')) defaultBranch = out.slice('origin/'.length);
    } catch { /* keep "main" default */ }

    // Current branch + dirty check + ahead count. Done up-front so
    // any pre-condition failure errors cleanly before we touch refs.
    let currentBranch = '';
    try {
      currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: project.path, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
      }).toString().trim();
    } catch (e: any) {
      streamExecError(res, req, `git rev-parse failed: ${(e?.message ?? '').slice(0, 160)}`);
      return true;
    }
    if (currentBranch !== defaultBranch) {
      streamExecError(res, req,
        `you're on '${currentBranch}', not the default branch '${defaultBranch}'. ` +
        `Use the Settings → ngit signer + sync → Send as proposal button instead.`);
      return true;
    }

    try {
      const dirty = execFileSync('git', ['status', '--porcelain'], {
        cwd: project.path, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
      }).toString().trim();
      if (dirty.length > 0) {
        streamExecError(res, req,
          'working tree has uncommitted changes — commit (Snapshot) or stash before submitting a PR');
        return true;
      }
    } catch (e: any) {
      streamExecError(res, req, `git status failed: ${(e?.message ?? '').slice(0, 160)}`);
      return true;
    }

    // Branch must not already exist locally — otherwise `git branch`
    // would error and the user would see a confusing partial failure.
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], {
        cwd: project.path, stdio: ['ignore', 'ignore', 'ignore'], timeout: 5_000,
      });
      // Exit 0 → branch exists.
      streamExecError(res, req, `branch '${branchName}' already exists locally — pick another name or delete it first`);
      return true;
    } catch { /* exit non-zero → branch does not exist, good */ }

    // Ahead count vs origin/<default>. ngit send needs commits to
    // propose; without any, the proposal would be empty.
    let ahead = 0;
    try {
      const out = execFileSync('git', ['rev-list', '--count', `origin/${defaultBranch}..HEAD`], {
        cwd: project.path, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
      }).toString().trim();
      ahead = parseInt(out, 10) || 0;
    } catch { /* leave 0 — the check below catches it */ }
    if (ahead < 1) {
      streamExecError(res, req,
        `no local commits ahead of origin/${defaultBranch} — make a snapshot or commit first`);
      return true;
    }

    // All pre-conditions passed. SSE stream the multi-phase flow.
    // Mirrors the runPhase pattern from /ngit/sync above.
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });
    const emit = (p: object) => { try { res.write(`data: ${JSON.stringify(p)}\n\n`); } catch {} };
    const env = { ...process.env, NO_COLOR: '1', TERM: 'dumb' };
    const cwd = project.path;
    let killed = false;
    req.on('close', () => { killed = true; });

    const runPhase = (label: string, bin: string, args: string[], timeoutMs = 30_000): Promise<number> =>
      new Promise((resolve) => {
        if (killed) return resolve(-1);
        emit({ line: `▸ ${label}`, stream: 'stdout' });
        const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env, cwd });
        const pipe = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
          for (const line of chunk.toString().split('\n')) {
            if (line.length) emit({ line, stream });
          }
        };
        child.stdout.on('data', pipe('stdout'));
        child.stderr.on('data', pipe('stderr'));
        child.on('error', (e) => {
          emit({ line: String(e.message || e), stream: 'stderr' });
          resolve(-1);
        });
        child.on('close', (code) => resolve(code ?? -1));
        const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} resolve(-2); }, timeoutMs);
        child.on('close', () => clearTimeout(timer));
      });

    try {
      // 1. Create the feature branch at current HEAD (still on default
      //    branch at this point — the branch is a pointer-only op).
      const branchCode = await runPhase(`git branch ${branchName}`, 'git', ['branch', branchName]);
      if (branchCode !== 0) {
        emit({ line: `branch create failed (exit ${branchCode}) — aborting`, stream: 'stderr' });
        emit({ done: true, code: branchCode });
        try { res.end(); } catch {}
        return true;
      }

      // 2. Optionally move default branch back to origin's HEAD. The
      //    new feature branch retains the commits (its pointer was
      //    set in step 1 before this reset).
      if (resetMain) {
        const resetCode = await runPhase(
          `git reset --hard origin/${defaultBranch}`,
          'git', ['reset', '--hard', `origin/${defaultBranch}`],
        );
        if (resetCode !== 0) {
          emit({ line: `default-branch reset failed (exit ${resetCode}); branch '${branchName}' was created — switching to it`, stream: 'stderr' });
          // Continue: we still want to be on the feature branch.
        }
      }

      // 3. Switch to the feature branch. ngit send picks up the
      //    current branch's state, so this matters for step 4.
      const coCode = await runPhase(`git checkout ${branchName}`, 'git', ['checkout', branchName]);
      if (coCode !== 0) {
        emit({ line: `checkout failed (exit ${coCode}) — branch exists but you're still on ${defaultBranch}`, stream: 'stderr' });
        emit({ done: true, code: coCode });
        try { res.end(); } catch {}
        return true;
      }

      // 4. Open the proposal. Same invocation as the Settings → Send
      //    button (ngit send --defaults). Amber sign prompt fires
      //    during this step; we use a generous 3-min timeout to
      //    accommodate Amber's user-confirm round-trip + grasp
      //    server upload.
      const sendCode = await runPhase(
        'ngit send --defaults',
        'ngit', ['send', '--defaults'],
        180_000,
      );
      emit({ done: true, code: sendCode });
    } finally {
      try { res.end(); } catch {}
    }
    return true;
  }

  return false;
}

// ── GRASP direct per-host push ───────────────────────────────────────────
//
// Mirrors Shakespeare's `nostrPush` (gitlab.com/soapbox-pub/shakespeare,
// src/lib/git.ts): publish the announcement (30617) + signed state (30618) to
// the relays, THEN push the pack to every clone URL. The order is load-bearing
// — a GRASP server authorizes the git push by checking the refs against a
// signed 30618 it received from the repo's pubkey, so the state has to be out
// before the pack lands.

const GRASP_PUSH_HOST_TIMEOUT_MS = 60_000;   // per-host git push budget (Shakespeare uses 60s)
const GRASP_SIGN_TIMEOUT_MS      = 60_000;   // Amber/bunker round-trip for the 30618
const RELAY_QUERY_TIMEOUT_MS     = 8_000;

// One push per coordinate at a time — a double-click shouldn't fan out into
// two concurrent state signings + pack pushes racing each other.
const graspPushInFlight = new Set<string>();

/** Run git, capturing stdout/stderr without throwing. `GIT_TERMINAL_PROMPT=0`
 *  makes an auth-required host fail fast instead of hanging on a credential
 *  prompt the SSE stream can't answer. */
async function runGitCapture(
  cwd: string, args: string[], timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const gitBin = findBin('git') || 'git';
  try {
    const { stdout, stderr } = await execFileAsync(gitBin, args, {
      cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', NO_COLOR: '1', TERM: 'dumb' },
    });
    return { code: 0, stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (e: any) {
    return {
      code:   typeof e?.code === 'number' ? e.code : 1,
      stdout: (e?.stdout ?? '').toString(),
      stderr: (e?.stderr ?? e?.message ?? '').toString(),
    };
  }
}

const hostOf = (url: string): string => {
  try { return new URL(url).host; } catch { return url; }
};

type GraspDeliveryStatus = 'ok' | 'partial' | 'failed';

interface GraspDeliveryOutcome {
  status: GraspDeliveryStatus;
  landed: number;       // hosts that accepted the pack
  total:  number;       // clone URLs we tried
}

/**
 * The reusable Shakespeare-`nostrPush` core: resolve the announcement + state,
 * publish the signed state to the relays, then push the current branch to every
 * GRASP git host, and advance the upstream tracking ref on success. Emits
 * progress via `log` and returns an outcome — it does NOT own the SSE framing,
 * so both the dedicated Push and the Sync push-phase can drive it onto their
 * own stream. Caller is responsible for the in-flight guard.
 */
async function runGraspDelivery(
  repoPath: string,
  coords: { pubkey: string; identifier: string; relayHints: string[] },
  project: Project,
  log: (line: string, stream?: 'stdout' | 'stderr') => void,
): Promise<GraspDeliveryOutcome> {
  const fail = (): GraspDeliveryOutcome => ({ status: 'failed', landed: 0, total: 0 });
  try {
    const projRelays = (project.readRelays || []).filter((r): r is string => typeof r === 'string');
    const grasp      = getGraspServers().map(s => /^wss?:\/\//i.test(s) ? s : `wss://${s}`);
    // Same merge policy the announce/read paths use, so the state lands where
    // the repo is read from — including each GRASP server's own relay, which
    // is what authorizes the subsequent push to that server's git host.
    const relays = mergeRelaySet([...coords.relayHints, ...grasp, ...projRelays], getEffectiveReadRelays());

    // Fetch the raw 30617 (to republish + read its clone URLs) and the current
    // 30618 (to preserve HEAD + skip a needless re-sign when refs are unchanged).
    const queryOne = async (kind: number): Promise<NostrEvent | null> => {
      try {
        const r = await queryRelaysDirect({
          filter: { kinds: [kind], authors: [coords.pubkey], tags: { d: coords.identifier }, limit: 1 },
          relays, timeoutMs: RELAY_QUERY_TIMEOUT_MS, stream: false,
          acceptUntil: (evs) => evs.length >= 1,
        });
        let chosen: NostrEvent | null = null;
        for (const ev of r.events) {
          if (ev.kind !== kind) continue;
          if (!chosen || ev.created_at > chosen.created_at) chosen = ev;
        }
        return chosen;
      } catch { return null; }
    };

    log(`Resolving ${coords.identifier} across ${relays.length} relay(s)…`);
    const repoEvent = await queryOne(30617);
    if (!repoEvent) {
      log('No repository announcement (kind 30617) found on the relays.', 'stderr');
      log('Announce the repository first (Edit Repository → Save changes), then retry.', 'stderr');
      return fail();
    }
    const statePrior = await queryOne(30618);

    const cloneTags = getTags(repoEvent, 'clone')
      .flatMap(t => t.slice(1).filter((v): v is string => typeof v === 'string'));
    const cloneUrls = selectGraspCloneUrls(cloneTags);
    if (cloneUrls.length === 0) {
      log('The announcement lists no https:// clone URLs — nothing to push to.', 'stderr');
      return fail();
    }
    log(`GRASP git hosts: ${cloneUrls.map(hostOf).join(', ')}`);

    // Build the new state from the local checkout (preserving an existing HEAD).
    const gitStdout = async (args: string[]): Promise<string> => {
      const r = await runGitCapture(repoPath, args, 5_000);
      if (r.code !== 0) throw new Error(r.stderr || `git ${args[0]} failed`);
      return r.stdout;
    };
    const refs = await readLocalRefs(gitStdout);
    if (!refs.currentBranch) {
      log('HEAD is detached — check out a branch before pushing. Aborting.', 'stderr');
      return fail();
    }
    const existingHeadTag = statePrior?.tags.find(t => t[0] === 'HEAD') ?? null;
    const newStateTags = buildRepoStateTags(coords.identifier, refs, existingHeadTag);

    // (a) Republish the announcement as-is (no new signature) — best effort.
    await publishEventToRelays(repoEvent, relays).catch(() => []);

    // (b) Resolve the state event: reuse the published one when refs are
    //     unchanged (no Amber prompt), else sign a fresh 30618.
    let stateEvent: NostrEvent;
    if (statePrior && repoStateTagsEqual(statePrior.tags, newStateTags)) {
      log('Local refs already match the published state — reusing the signed state event.');
      stateEvent = statePrior;
    } else {
      log('Signing repo state (kind 30618) — approve on your signer if prompted…');
      const signed = await signEventWithSavedBunker(
        { kind: 30618, content: '', tags: newStateTags, created_at: Math.floor(Date.now() / 1000) },
        GRASP_SIGN_TIMEOUT_MS,
      );
      if (!signed.ok || !signed.signedEvent) {
        log(`Could not sign the state event: ${signed.error || (signed.tried ? 'signer rejected' : 'no paired signer')}`, 'stderr');
        log('Without a signed state, GRASP hosts will not authorize the push. Aborting.', 'stderr');
        return fail();
      }
      stateEvent = signed.signedEvent;
    }

    const stateResults = await publishEventToRelays(stateEvent, relays);
    const stateAccepted = stateResults.filter(r => r.ok).length;
    for (const r of stateResults) {
      log(`  state → ${r.relay}: ${r.ok ? 'accepted' : `rejected${r.reason ? ` (${r.reason})` : ''}`}`,
          r.ok ? 'stdout' : 'stderr');
    }
    if (stateAccepted === 0) {
      log('No relay accepted the signed state — GRASP hosts will reject the push. Aborting.', 'stderr');
      return fail();
    }

    // (c) Push the pack to every GRASP git host, in parallel. Current branch
    //     only, non-force — exactly what Shakespeare's nostrPush delivers
    //     (`--tags`/`--all`/force are intentionally NOT used). A non-ff host
    //     rejects rather than clobbers, which is the safe default.
    const branch = refs.currentBranch;
    log(`Pushing ${branch} to ${cloneUrls.length} host(s)…`);
    const pushResults = await Promise.all(cloneUrls.map(async (url) => {
      const host = hostOf(url);
      const r = await runGitCapture(
        repoPath,
        ['push', url, `refs/heads/${branch}:refs/heads/${branch}`],
        GRASP_PUSH_HOST_TIMEOUT_MS,
      );
      const ok = r.code === 0;
      const detail = (r.stderr || r.stdout)
        .split('\n').map(s => s.trim()).filter(Boolean).slice(-2).join(' · ');
      log(`  ${host}: ${ok ? 'pushed' : 'FAILED'}${detail ? ` — ${detail}` : ''}`, ok ? 'stdout' : 'stderr');
      return { host, ok };
    }));

    const landed = pushResults.filter(r => r.ok).length;

    // Mirror `git push origin HEAD`'s side effect: advance the branch's
    // upstream tracking ref so the dashboard's ahead/behind badge reflects the
    // push. We pushed to the clone URLs directly (not the `origin` remote), so
    // git won't update refs/remotes/origin/<branch> for us — and without this
    // the card would still read "Push N commits" after a clean push. Done only
    // when at least one host accepted (the canonical remote is now at HEAD),
    // and best-effort: a branch with no upstream has no ab count to fix.
    if (landed > 0 && refs.headOid) {
      try {
        const upstreamRef = (await gitStdout(['rev-parse', '--symbolic-full-name', `${branch}@{upstream}`])).trim();
        if (/^refs\/remotes\//.test(upstreamRef)) {
          await runGitCapture(repoPath, ['update-ref', upstreamRef, refs.headOid], 5_000);
        }
      } catch { /* no upstream tracking configured — ahead/behind isn't shown anyway */ }
    }
    log('');
    log(`Done: ${landed}/${cloneUrls.length} GRASP host(s) up to date · state on ${stateAccepted}/${relays.length} relay(s).`,
        landed === cloneUrls.length ? 'stdout' : 'stderr');
    if (landed > 0 && landed < cloneUrls.length) {
      log('Some hosts did not accept the push — re-run to retry the laggards.', 'stderr');
    }
    return {
      status: landed === 0 ? 'failed' : (landed < cloneUrls.length ? 'partial' : 'ok'),
      landed,
      total: cloneUrls.length,
    };
  } catch (e: any) {
    log(`GRASP push error: ${(e?.message || String(e)).slice(0, 240)}`, 'stderr');
    return fail();
  }
}

async function handleGraspPush(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  project: Project,
): Promise<boolean> {
  if (!project.path) { res.writeHead(400); res.end('project has no local path'); return true; }
  const coords = decodeNgitRemote(project);
  if (!coords) { res.writeHead(400); res.end('project has no ngit remote — announce it first'); return true; }

  const coordKey = `${coords.pubkey}:${coords.identifier}`;
  if (graspPushInFlight.has(coordKey)) {
    res.writeHead(409); res.end('a GRASP push for this repository is already in progress'); return true;
  }
  graspPushInFlight.add(coordKey);

  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
  const emit = (p: object) => { try { res.write(`data: ${JSON.stringify(p)}\n\n`); } catch {} };
  const log  = (line: string, stream: 'stdout' | 'stderr' = 'stdout') => emit({ line, stream });

  try {
    const outcome = await runGraspDelivery(project.path, coords, project, log);
    // Full success → 0; partial → 0 + warn (so the modal flags "needs action"
    // without crying failure); total failure → 1.
    emit({ done: true, code: outcome.status === 'failed' ? 1 : 0, warn: outcome.status === 'partial' });
  } finally {
    try { res.end(); } catch {}
    graspPushInFlight.delete(coordKey);
  }
  return true;
}
