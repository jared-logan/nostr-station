/**
 * Projects/ngit sub-routes — extracted from routes/projects.ts as part of
 * the D12 split. The parent route module owns URL parsing and project
 * resolution; this module handles the `ngit/*` tail.
 *
 * Surface (verbatim from the pre-split inline blocks):
 *   GET    /api/projects/:id/ngit/status        — bunker domain + ngit remote
 *   GET    /api/projects/:id/ngit/proposals     — kind-1617 list
 *   POST   /api/projects/:id/ngit/push          — SSE: git push origin HEAD
 *   POST   /api/projects/:id/ngit/sync          — SSE: pull (ff-only) + push
 *   POST   /api/projects/:id/ngit/send          — SSE: ngit send --defaults
 *   POST   /api/projects/:id/ngit/download      — SSE: ngit pr checkout <id>
 *   POST   /api/projects/:id/ngit/init          — SSE: ngit init (signer-gated)
 *
 * Contract identical to handleProjects: returns true iff a response was
 * written; false lets the parent fall through to the next route group.
 *
 * All routes assume `project` has already been resolved and the request
 * has passed auth + CSRF + DNS-rebinding checks upstream.
 */
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fetchNgitProposals } from '../sync.js';
import { isValidRelayUrl } from '../identity.js';
import type { Project } from '../projects.js';
import { readBody, streamExec, streamExecError } from './_shared.js';

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
      const pushCode = await runPhase('git push origin HEAD', 'git', ['push', 'origin', 'HEAD']);
      emit({ done: true, code: pushCode });
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

  return false;
}
