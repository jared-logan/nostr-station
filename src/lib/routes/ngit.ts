/**
 * ngit / nsite / account routes — split out of `web-server.ts` as part of
 * the route-group refactor. Pure dispatch by URL + method; the orchestrator
 * handles auth, CSRF, and DNS-rebinding checks before any of these handlers
 * see the request.
 *
 * Surface (verbatim from the pre-refactor inline blocks):
 *   GET    /api/ngit/discover            — list owner's kind-30617 repo announcements
 *   GET    /api/nsite/discover           — list owner's kind-35128 site manifests
 *   POST   /api/ngit/clone               — SSE: git clone <naddr|nostr://> ~/nostr-station/projects/<name>
 *   GET    /api/ngit/account             — signer login state (masked bunker URI)
 *   POST   /api/ngit/account/login       — SSE: ngit account login -i
 *   POST   /api/ngit/account/logout      — SSE: ngit account logout
 *
 * Returns `true` when matched and a response was written; `false` lets the
 * orchestrator continue trying its remaining route groups.
 */
import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { nip19 } from 'nostr-tools';
import { readIdentity, isValidRelayUrl, getGraspServers } from '../identity.js';
import { seedRepoGitIdentityIfMissing } from '../git-identity.js';
import { safeHttpUrl } from '../url-safety.js';
import { readBody, streamExec } from './_shared.js';

export async function handleNgit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  // ── ngit discovery (kind 30617 repo announcements) ─────────────────
  //
  // Queries the station owner's GRASP servers for kind 30617 (NIP-34
  // repo announcement) events authored by the owner's npub. Results
  // populate the Projects → Discover modal so users can import existing
  // ngit repos as nostr-station Projects.
  //
  // Security: nak is invoked via spawn() with a fixed argv array (no
  // shell), and every arg is either a literal, a bech32-decoded hex
  // pubkey, or a relay URL already validated against `isValidRelayUrl`.
  if (url === '/api/ngit/discover' && method === 'GET') {
    const ident = readIdentity();
    if (!ident.npub) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'identity not configured' }));
      return true;
    }
    // Decode via nostr-tools rather than shelling to `nak decode`, which
    // returns JSON (not raw hex) and would smuggle invalid argv into the
    // next step. nip19.decode is also faster and never spawns a process.
    let hex = '';
    if (/^[0-9a-f]{64}$/.test(ident.npub)) {
      hex = ident.npub;
    } else {
      try {
        const d = nip19.decode(ident.npub);
        if (d.type === 'npub' && typeof d.data === 'string') hex = d.data;
      } catch {}
    }
    if (!hex) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'could not decode npub to hex' }));
      return true;
    }
    // kind-30617 announcements live exclusively on GRASP servers
    // (relay.ngit.dev, git.shakespeare.diy, etc.) — they do NOT
    // propagate to general read relays like damus.io / nostr.band.
    // Both Shakespeare and gitworkshop.dev split their UI for the same
    // reason: "Nostr Git Servers" is a separate list from "Relays".
    //
    // Earlier this handler unioned readRelays + graspServers, but a
    // slow read relay (nostr.band: "connection took too long") could
    // eat the outer 10s budget before the GRASP handshakes finished —
    // empty results despite the events existing. Querying GRASPs only
    // eliminates that race and matches where the events actually live.
    // `ngitRelay` (the optional user-configured custom ngit relay)
    // still rides along for self-hosted GRASP setups.
    const graspServers = getGraspServers();
    const ngitRelay = ident.ngitRelay ? [ident.ngitRelay] : [];
    const relays = [...graspServers, ...ngitRelay]
      .filter(isValidRelayUrl)
      .filter((r, i, a) => a.indexOf(r) === i)
      .slice(0, 8);
    if (relays.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ repos: [], empty: true, queried: [] }));
      return true;
    }

    const args = ['req', '-k', '30617', '-a', hex, ...relays, '--stream'];
    const child = spawn('nak', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const repos = new Map<string, any>();
    let buf = '';
    let settled = false;
    // nak writes per-relay status to stderr ("connecting to …", "closed:
    // AUTH required", "EOSE from …"). We never used to read it, so the UI
    // had no way to tell the difference between "relay returned 0 events"
    // and "relay required AUTH and rejected the query". Capture a tail
    // and surface it in diagnostics so the empty-state has actionable info.
    let stderrTail = '';
    let eventsSeen = 0;       // raw event lines (before kind/d-tag filtering)
    let parseFailures = 0;    // JSON parse failures on stdout
    let spawnError: string | null = null;
    const finish = (status: number, body: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch {}
      const list = Array.from(repos.values()).sort((a, b) => b.published_at - a.published_at);
      // Always include diagnostics so the UI can render them whether the
      // result is empty, partial, or complete.
      const merged = {
        ...body,
        repos: body.repos ?? list,
        empty: body.empty ?? (list.length === 0),
        queried: body.queried ?? relays,
        diagnostics: {
          eventsSeen,
          uniqueRepos:   list.length,
          parseFailures,
          stderrTail:    stderrTail.trim().slice(-2000),
          spawnError,
          exitCode:      body.exitCode ?? null,
          nakArgs:       args,
        },
      };
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(merged));
    };

    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        let ev: any;
        try { ev = JSON.parse(s); } catch { parseFailures++; continue; }
        if (!ev || ev.kind !== 30617 || !Array.isArray(ev.tags)) continue;
        eventsSeen++;
        const dTag = ev.tags.find((t: any[]) => Array.isArray(t) && t[0] === 'd')?.[1];
        if (!dTag) continue;
        const key = `${ev.pubkey}:${dTag}`;
        const prev = repos.get(key);
        if (prev && prev.published_at >= (ev.created_at || 0)) continue;
        const descTag = ev.tags.find((t: any[]) => t[0] === 'description')?.[1] || '';
        const cloneTags = ev.tags
          .filter((t: any[]) => t[0] === 'clone')
          .flatMap((t: any[]) => t.slice(1).filter((x: any) => typeof x === 'string' && x));
        const webTag = ev.tags.find((t: any[]) => t[0] === 'web')?.[1] || '';
        // Compute two nostr-native identifiers for this repo:
        //   - `cloneUrl` in the form git-remote-nostr expects
        //     (`nostr://<npub>/<d-tag>`, per `ngit --help`). This is
        //     what actually works with `git clone`.
        //   - `naddr` for reference / deep-linking; it's not a valid
        //     `git clone` argument on its own.
        // NIP-34 `clone` tags typically carry https/ssh/git URLs,
        // not nostr-native identifiers — we build these ourselves.
        let naddr = '';
        let cloneUrl = '';
        try {
          naddr = nip19.naddrEncode({
            kind: 30617,
            pubkey: ev.pubkey,
            identifier: String(dTag),
            relays: relays.slice(0, 3),
          });
        } catch {}
        try {
          const npub = nip19.npubEncode(ev.pubkey);
          cloneUrl = `nostr://${npub}/${String(dTag)}`;
        } catch {}
        repos.set(key, {
          pubkey: ev.pubkey,
          name: String(dTag),
          description: String(descTag),
          clone: cloneTags,
          // Relay-authored `web` tag is rendered inside an <a href>
          // on the client. Allowlist to http(s) so `javascript:` (and
          // friends) can't ride in as clickable script payloads.
          web: safeHttpUrl(webTag),
          naddr,
          cloneUrl,
          published_at: Number(ev.created_at || 0),
        });
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Bounded so a chatty relay can't blow up memory; keep the tail
      // because that's where nak prints final status (AUTH errors, close
      // reasons) after the EOSEs.
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });

    // --stream never exits on its own; cap at 10s and return whatever
    // we've collected. Enough for typical npub inventories; pagination
    // can come later if users start publishing hundreds of repos.
    const timer = setTimeout(() => finish(200, { exitCode: null }), 10000);

    child.on('error', (e) => {
      // ENOENT when nak isn't on PATH — that's the most common silent
      // failure mode and used to come back as a generic 500 with no hint.
      // Now it lands in diagnostics.spawnError so the UI can say so.
      spawnError = String(e?.message || e);
      finish(200, { exitCode: null });
    });
    child.on('close', (code) => finish(200, { exitCode: code }));

    req.on('close', () => { try { child.kill('SIGTERM'); } catch {} });
    return true;
  }

  // ── nsite discovery (kind 35128 site manifests) ────────────────────
  //
  // Tells the dashboard whether the station owner has published an
  // nsite (a static site served via nostr) to their read relays, and
  // where to reach it on the public nsite.lol gateway.
  //
  // Two URL forms are relevant (both served by nsite.lol):
  //   - npubUrl: `https://<npub>.nsite.lol` — always resolvable from
  //     just the pubkey; used as the "predicted" URL when no event is
  //     on the read relays yet.
  //   - d-tag URL: `https://<base36(pubkey)><d-tag>.nsite.lol` — the
  //     nicer canonical URL once a 35128 site manifest exists (e.g.
  //     `…6jaredlogan.nsite.lol` for d="jaredlogan"). The 50-char
  //     prefix is the pubkey as a big-endian integer converted to
  //     base36 and left-padded to 50 chars.
  //
  // Kind queried: **35128** — the modern nsite site-manifest
  // convention (one aggregate event per site, parameterized-
  // replaceable by a d-tag slug; `path` tags map file paths to
  // blossom blob hashes). This supersedes the older per-file kind
  // 34128 convention.
  //
  // Multiple sites: one pubkey can publish any number of 35128
  // manifests under different d-tags. We collect all of them
  // (keeping the freshest per d-tag) and return them as `sites[]`.
  // `relayEvent` / `url` mirror the most recent site for simple
  // consumers that want a single headline value.
  //
  // Security: mirrors /api/ngit/discover — nak is spawned via
  // spawn() with a fixed argv (stdio 'ignore' on stdin to prevent the
  // nak-stdin-hang pitfall documented in project memory), the pubkey
  // is bech32-decoded via nostr-tools (never shelled out to nak), and
  // every relay URL is validated against isValidRelayUrl.
  if (url === '/api/nsite/discover' && method === 'GET') {
    const ident = readIdentity();
    if (!ident.npub) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        npubUrl: null, relayEvent: null, url: null, deployed: false,
      }));
      return true;
    }
    let hex = '';
    let npubBech32 = '';
    if (/^[0-9a-f]{64}$/.test(ident.npub)) {
      hex = ident.npub;
      try { npubBech32 = nip19.npubEncode(hex); } catch {}
    } else {
      try {
        const d = nip19.decode(ident.npub);
        if (d.type === 'npub' && typeof d.data === 'string') {
          hex = d.data;
          npubBech32 = ident.npub;
        }
      } catch {}
    }
    if (!hex || !npubBech32) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'could not decode npub to hex' }));
      return true;
    }
    // Public gateway convention — matches the URLs printed by
    // `nostr-station nsite publish` (see commands/Nsite.tsx). Always
    // resolvable even if no kind 34128 events are on the user's read
    // relays, so we can still show *something* while the relay query
    // runs (or fails).
    const npubUrl = `https://${npubBech32}.nsite.lol`;

    const DEFAULT_DISCOVERY_RELAYS = ['wss://relay.damus.io', 'wss://relay.nostr.band'];
    const relays = (ident.readRelays && ident.readRelays.length
      ? ident.readRelays
      : DEFAULT_DISCOVERY_RELAYS
    ).filter(isValidRelayUrl).slice(0, 8);
    if (relays.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        npubUrl, relayEvent: null, url: npubUrl, deployed: false,
      }));
      return true;
    }

    // Collects every 35128 event by d-tag (35128 is parameterized-
    // replaceable, so the freshest event per d-tag wins). Returns
    // when the relay query settles or the timeout fires.
    const collectSites = (timeoutMs: number): Promise<Map<string, any>> =>
      new Promise((resolve) => {
        const args = ['req', '-k', '35128', '-a', hex, ...relays, '--stream'];
        const child = spawn('nak', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const byDTag = new Map<string, any>();
        let buf = '';
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try { child.kill('SIGTERM'); } catch {}
          resolve(byDTag);
        };
        child.stdout.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            const s = line.trim();
            if (!s) continue;
            let ev: any;
            try { ev = JSON.parse(s); } catch { continue; }
            if (!ev || ev.kind !== 35128) continue;
            // Defense in depth — the `-a <hex>` arg should make nak
            // return only events by this author, but relays occasionally
            // return extras. Reject anything whose pubkey doesn't match
            // so we never display a stranger's nsite as the owner's.
            if (typeof ev.pubkey !== 'string' || ev.pubkey.toLowerCase() !== hex.toLowerCase()) continue;
            const dVal = Array.isArray(ev.tags)
              ? ev.tags.find((t: any[]) => Array.isArray(t) && t[0] === 'd')?.[1]
              : undefined;
            if (typeof dVal !== 'string' || !dVal) continue;
            const prev = byDTag.get(dVal);
            if (!prev || Number(ev.created_at || 0) > Number(prev.created_at || 0)) {
              byDTag.set(dVal, ev);
            }
          }
        });
        const timer = setTimeout(finish, timeoutMs);
        child.on('error', finish);
        child.on('close', finish);
        req.on('close', () => { try { child.kill('SIGTERM'); } catch {} });
      });

    const byDTag = await collectSites(8000);

    // Build canonical nsite.lol URLs. Pubkey is a 256-bit big-endian
    // integer rendered in base36 (lowercase), left-padded to 50 chars
    // so the subdomain prefix is always a fixed width — verified
    // against live examples on the gateway.
    const base36 = BigInt('0x' + hex).toString(36).padStart(50, '0');
    const sites = Array.from(byDTag.values())
      // d-tags must be DNS-safe for the subdomain. Anything exotic is
      // dropped rather than producing a broken URL.
      .filter((ev) => {
        const d = ev.tags.find((t: any[]) => t[0] === 'd')?.[1];
        return typeof d === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(d);
      })
      .map((ev) => {
        const d     = ev.tags.find((t: any[]) => t[0] === 'd')?.[1] as string;
        const title = ev.tags.find((t: any[]) => t[0] === 'title')?.[1];
        return {
          d,
          title: typeof title === 'string' && title ? title : d,
          url:   `https://${base36}${d}.nsite.lol`,
          publishedAt: Number(ev.created_at || 0),
          event: ev,
        };
      })
      // Freshest first — also the order the UI renders them.
      .sort((a, b) => b.publishedAt - a.publishedAt);

    const primary = sites[0] || null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      npubUrl,
      sites,
      deployed:   sites.length > 0,
      // Convenience mirrors of the primary (most recent) site so
      // simple consumers don't have to re-pick from `sites`.
      relayEvent: primary?.event || null,
      url:        primary?.url || npubUrl,
    }));
    return true;
  }

  // ── ngit clone (streams `git clone <naddr> <path>`) ────────────────
  //
  // Pairs with /api/ngit/discover to give Projects → Discover a clean
  // clone step. ngit repos are cloned with the stock `git` binary —
  // ngit installs a protocol helper so `git clone <naddr>` resolves
  // via nostr; there is no `ngit clone` subcommand.
  //
  // Security:
  //   - url must be a nostr://… or naddr1… value (the only forms the
  //     git-remote-nostr helper accepts); anything else is rejected.
  //   - path must resolve under the user's home directory and must
  //     not already exist.
  //   - git is spawned via spawn() with a fixed argv — no shell.
  if (url === '/api/ngit/clone' && method === 'POST') {
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const rawUrl      = String(parsed.url      || '').trim();
    const rawRepoName = String(parsed.repoName || '').trim();
    if (!rawUrl || !(rawUrl.startsWith('nostr://') || rawUrl.startsWith('naddr1'))) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'url must be a nostr:// URL or naddr1… value' }));
      return true;
    }
    // Resolving a naddr to a git-cloneable URL happens in two stages:
    //
    //  (1) Decode the naddr (pubkey hex + d-tag + optional relay hints).
    //      A bare naddr can't be handed to `git clone` directly —
    //      git-remote-nostr only accepts `nostr://<npub>/<d-tag>`.
    //
    //  (2) Fetch the kind-30617 repo announcement from the naddr's
    //      embedded relay hints (plus the user's GRASP servers as
    //      fallback). That announcement carries `clone` tags with
    //      real transport URLs — usually https://git.shakespeare.diy
    //      or https://relay.ngit.dev — which we prefer because
    //      git-remote-nostr can't always find the event via whatever
    //      relays ngit has configured globally.
    //
    // If step (2) finds clone URLs, we hand the https one to `git
    // clone`. If nothing comes back, we fall back to the reconstructed
    // `nostr://<npub>/<d-tag>` and let git-remote-nostr try its luck.
    // The client still records `remotes.ngit = <naddr or nostr://>`
    // so the ngit chip stays correct regardless of transport.
    let cloneUrl = rawUrl;
    if (rawUrl.startsWith('naddr1')) {
      let pubkeyHex = '';
      let dTag = '';
      let relayHints: string[] = [];
      try {
        const decoded = nip19.decode(rawUrl);
        if (decoded.type !== 'naddr' || decoded.data.kind !== 30617) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'naddr must reference a kind-30617 ngit repo announcement' }));
          return true;
        }
        pubkeyHex = decoded.data.pubkey;
        dTag = decoded.data.identifier;
        relayHints = Array.isArray(decoded.data.relays) ? decoded.data.relays : [];
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `could not decode naddr: ${e?.message ?? 'invalid encoding'}` }));
        return true;
      }

      // Build the relay set. naddr hints go first (the publisher told
      // us where this event lives); GRASP servers as fallback because
      // that's where kind-30617 events actually live — read relays
      // don't carry them and a slow read relay can blow our budget
      // before the GRASP handshake completes (same race the Discover
      // handler used to hit). Cap at 6 to keep nak's connection
      // fanout bounded — one slow relay shouldn't block the rest.
      const graspServers = getGraspServers();
      const relays = [...relayHints, ...graspServers]
        .filter(isValidRelayUrl)
        .filter((r, i, a) => a.indexOf(r) === i) // dedupe preserving order
        .slice(0, 6);

      // Fetch the announcement. nak requires `stdin: 'ignore'` — its
      // req subcommand otherwise blocks on stdin EOF (see memory
      // project_nak_stdin_hang).
      const httpsCloneUrl = await new Promise<string>((resolve) => {
        if (relays.length === 0) { resolve(''); return; }
        const args = ['req', '-k', '30617', '-a', pubkeyHex, '-t', `d=${dTag}`, '-l', '1', ...relays];
        const child = spawn('nak', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let chunks = '';
        let resolved = false;
        const done = (url: string) => { if (resolved) return; resolved = true; clearTimeout(timer); try { child.kill('SIGTERM'); } catch {} resolve(url); };
        const timer = setTimeout(() => done(''), 10_000);
        child.stdout.on('data', (b: Buffer) => {
          chunks += b.toString();
          const lines = chunks.split('\n');
          chunks = lines.pop() || '';
          for (const line of lines) {
            const s = line.trim();
            if (!s) continue;
            let ev: any;
            try { ev = JSON.parse(s); } catch { continue; }
            if (!ev || ev.kind !== 30617 || !Array.isArray(ev.tags)) continue;
            const cloneTags = ev.tags
              .filter((t: any[]) => t[0] === 'clone')
              .flatMap((t: any[]) => t.slice(1).filter((x: any) => typeof x === 'string' && x));
            // Prefer HTTPS — most reliable transport and doesn't
            // require git-remote-nostr to find the event again.
            const https = cloneTags.find((u: string) => /^https:\/\//i.test(u));
            if (https) { done(https); return; }
            const anyGit = cloneTags.find((u: string) => /^(git|https?|ssh):\/\//i.test(u));
            if (anyGit) { done(anyGit); return; }
          }
        });
        child.on('error', () => done(''));
        child.on('close', () => done(''));
      });

      if (httpsCloneUrl) {
        cloneUrl = httpsCloneUrl;
      } else {
        // No announcement reachable (or no clone URLs in it).
        // Fall back to nostr:// and let git-remote-nostr try — if
        // the user's ngit relay config can find the event there's
        // still a chance.
        const npub = nip19.npubEncode(pubkeyHex);
        cloneUrl = `nostr://${npub}/${dTag}`;
      }
    }
    // repoName becomes the last segment of the clone target — reject
    // any path separators, dotfile patterns, or traversal attempts.
    // Allowed characters mirror what git itself accepts for repo dir
    // names in practice: letters, digits, dot, dash, underscore.
    if (!rawRepoName
        || !/^[A-Za-z0-9._-]{1,64}$/.test(rawRepoName)
        || rawRepoName === '.' || rawRepoName === '..'
        || rawRepoName.startsWith('.')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'repoName must be a simple identifier (letters, digits, . - _)' }));
      return true;
    }
    // Server owns the full path construction — never accept a user-
    // supplied path, never use a "~"-prefixed string. HOME is read
    // from the environment (falling back to os.homedir()) and the
    // clone target is ~/nostr-station/projects/<repoName>, always absolute.
    const home = process.env.HOME || os.homedir();
    const projectsDir = path.join(home, 'nostr-station', 'projects');
    const target      = path.join(projectsDir, rawRepoName);
    try { fs.mkdirSync(projectsDir, { recursive: true, mode: 0o755 }); } catch {}
    if (fs.existsSync(target)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `target path already exists: ${target}` }));
      return true;
    }
    // Emit the fully-resolved target as an `info` frame so the client
    // can call /api/projects/detect and store the absolute path in
    // projects.json — detect does not expand "~".
    //
    // onClose hook: after a successful clone, seed repo-local git
    // identity from the configured Nostr identity if the user has
    // none set. Same fix as project-scaffold's freshenGitRepo —
    // closes the "Author identity unknown" wall the user would
    // otherwise hit on their first commit in the cloned repo.
    streamExec(
      { bin: 'git', args: ['clone', cloneUrl, target], env: { NO_COLOR: '1', TERM: 'dumb' } },
      res, req, undefined,
      { info: 'resolvedPath', value: target },
      (code) => {
        if (code !== 0) return;          // clone failed — nothing to seed
        if (!fs.existsSync(target)) return;
        try {
          const ident = readIdentity();
          seedRepoGitIdentityIfMissing(target, ident);
        } catch { /* best-effort */ }
      },
    );
    return true;
  }

  // ── ngit account (signer) status + login/logout ────────────────────
  //
  // ngit stores the signer session in global git config under
  // `nostr.bunker-uri` + `nostr.bunker-app-key`. We read the first to
  // derive a "logged in?" state for the Config panel; the app-key is
  // an ephemeral keypair only meaningful to ngit itself.
  //
  // The bunker-uri format is:
  //   bunker://<remote-pubkey-hex>?relay=wss://...&relay=...&secret=<...>
  // We mask the `secret=` query param before returning — it's a live
  // session token that a UI/clipboard/screenshot shouldn't expose.
  if (url === '/api/ngit/account' && method === 'GET') {
    let bunkerUri = '';
    try {
      bunkerUri = execSync('git config --global --get nostr.bunker-uri', { stdio: ['ignore', 'pipe', 'pipe'] })
        .toString().trim();
    } catch {}
    const loggedIn = !!bunkerUri;
    const relays: string[] = [];
    let remotePubkey = '';
    if (loggedIn) {
      try {
        const u = new URL(bunkerUri.replace(/^bunker:/, 'https:'));
        remotePubkey = u.host; // hex pubkey sits in the host slot
        for (const r of u.searchParams.getAll('relay')) relays.push(r);
      } catch {}
    }
    // Masked URI: keep scheme + remote pubkey + relay params, replace
    // secret with asterisks. Safe to echo to the client.
    const maskedUri = loggedIn
      ? bunkerUri.replace(/([?&]secret=)[^&]*/i, '$1•••')
      : '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      loggedIn,
      remotePubkey,
      relays,
      maskedUri,
    }));
    return true;
  }

  if (url === '/api/ngit/account/login' && method === 'POST') {
    // `ngit account login` is interactive — without a TTY it'll
    // typically print a nostrconnect:// URL + wait for a remote
    // signer (Amber) to connect. We stream stdout/stderr so the
    // modal can surface the URL; the user scans it with Amber and
    // the command completes on its own. `-i` forces interactive
    // mode so ngit doesn't fall back to some non-interactive
    // default that would skip the QR path.
    streamExec(
      { bin: 'ngit', args: ['account', 'login', '-i'], env: { NO_COLOR: '1', TERM: 'dumb' } },
      res, req,
    );
    return true;
  }

  if (url === '/api/ngit/account/logout' && method === 'POST') {
    streamExec(
      { bin: 'ngit', args: ['account', 'logout'], env: { NO_COLOR: '1', TERM: 'dumb' } },
      res, req,
    );
    return true;
  }

  return false;
}
