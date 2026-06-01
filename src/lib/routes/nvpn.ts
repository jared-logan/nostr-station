/**
 * nvpn (nostr-vpn) runtime routes — the API surface behind the dashboard's
 * Start/Stop buttons, the Logs panel's nostr-vpn tab, and (Feature 1) the
 * Peers / invite-share / roster-publish controls. Goal: cover every nvpn
 * action a normal user runs so the terminal is rarely needed.
 *
 * Surface:
 *   GET  /api/nvpn/status            — full status JSON + derived row state
 *   POST /api/nvpn/start             — `nvpn start --daemon`
 *   POST /api/nvpn/stop              — `nvpn stop`
 *   POST /api/nvpn/restart           — stop + start (best-effort stop)
 *   POST /api/nvpn/install-service   — best-effort `sudo -n nvpn service install`
 *
 *   POST /api/nvpn/peers/add         — `add-participant`    body: { participants[], publish? }
 *   POST /api/nvpn/peers/remove      — `remove-participant` same body
 *   POST /api/nvpn/admins/add        — `add-admin`          same body
 *   POST /api/nvpn/admins/remove     — `remove-admin`       same body
 *   POST /api/nvpn/roster/publish    — `publish-roster`
 *   POST /api/nvpn/invite/create     — `create-invite`; also returns SVG QR
 *   POST /api/nvpn/invite/import     — `import-invite`      body: { invite }
 *   POST /api/nvpn/whois             — `whois <q>`          body: { query }
 *
 * Auth + rebinding gate is enforced by web-server.ts's umbrella before any
 * handler in here sees the request.
 *
 * Returns `true` when matched + responded; `false` lets the orchestrator
 * keep trying its remaining route groups.
 */
import http from 'http';
// @ts-expect-error — qrcode ships no types, CJS default export carries toString
import QRCode from 'qrcode';
import {
  probeNvpnStatus, startNvpn, stopNvpn, restartNvpn,
  installNvpnService, enableNvpnService, disableNvpnService, uninstallNvpnService,
  uninstallNvpnCli, probeNvpnServiceStatus,
  nvpnRowStateFor, nvpnHealthSummary,
  addParticipants, removeParticipants, addAdmins, removeAdmins,
  publishRoster, createInvite, importInvite, whoisPeer, readNvpnRoster, readNvpnNetworks,
  joinNvpnNetwork, repairNvpnNetworkConfig,
  readNvpnNodeIdentity,
  pauseNvpn, resumeNvpn, reloadNvpn, repairNvpnNetwork, resetNvpnPeerState,
  pingNvpnPeer, netcheckNvpn, doctorNvpn, natDiscoverNvpn,
  setNvpnSettings, statsNvpn,
  setNvpnAlias, removeNvpnAlias,
  readNvpnRelays, addNvpnRelay, removeNvpnRelay, setNvpnRelays,
  readNvpnFipsPeerEndpoints,
  resolveDaemonConfigPath, readNodeNpubFromPath, adoptIdentity,
  RECOMMENDED_NVPN_RELAYS,
} from '../nvpn.js';
import { diagnoseNvpnNetwork } from '../nvpn-diagnostics.js';
import { npubToHex } from '../identity.js';
import { nvpnRelayHealth } from '../nvpn-relay-health.js';
import { detectContainer, natWarningFor, isPrivateEndpoint } from '../container-detect.js';
import { detectSplitBrain, stopUserModeDaemon } from '../nvpn-split-brain.js';
import { listJoinRequests, approveJoinRequest, denyJoinRequest } from '../nvpn-join-requests.js';
import { sudoState, warmSudoCache, buildSudoersInstallCommand } from '../nvpn-sudo.js';
import { readBody } from './_shared.js';

async function writeJson(
  res: http.ServerResponse, status: number, body: unknown,
): Promise<void> {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function parseJsonBody(req: http.IncomingMessage): Promise<any | null> {
  try { return JSON.parse(await readBody(req) || '{}'); }
  catch { return null; }
}

// Same QR styling as the Amber-pairing wizard so the invite modal feels
// like one continuous design language. Renders to SVG (no client lib
// needed) — falls back to '' on render failure rather than 500ing the
// whole response.
async function renderInviteQr(text: string): Promise<string> {
  try {
    return await QRCode.toString(text, {
      type:   'svg',
      margin: 1,
      width:  256,
      color:  { dark: '#e8e6dc', light: '#0b0d10' },
      errorCorrectionLevel: 'M',
    });
  } catch { return ''; }
}

export async function handleNvpn(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  if (!url.startsWith('/api/nvpn/')) return false;

  // ── Status / lifecycle ────────────────────────────────────────────
  if (url === '/api/nvpn/status' && method === 'GET') {
    const status = await probeNvpnStatus();
    const row = nvpnRowStateFor({
      installed: status.installed,
      running:   status.running,
      tunnelIp:  status.tunnelIp,
    });
    // Reality check — daemon-claimed state isn't enough on its own
    // (cf. issue #56). Roll up the raw health[], STUN result, and any
    // recent publish errors from the relay aggregator into a small
    // surface the UI can render directly.
    const health = nvpnHealthSummary({
      installed: status.installed,
      running:   status.running,
      tunnelIp:  status.tunnelIp,
      raw:       status.raw,
    });
    // 4.x silent-fallback gate. When the CLI couldn't reach the daemon
    // it returns HTTP-200 with status_source: "config" and every live
    // field nulled — that's the snapshot landmine we hit during the PR
    // #154 walkthrough. Surface it as an explicit warning so the
    // dashboard can render a banner ("daemon unreachable, showing
    // stale config snapshot") instead of painting "everything zero"
    // with no signal. Lib layer already force-flipped `running` to
    // false in this mode; the banner is the user-visible side.
    const stale = (status.statusSource && status.statusSource !== 'daemon')
      ? {
          reason: 'config-snapshot',
          source: status.statusSource,
          detail: 'nvpn CLI fell back to a config-derived snapshot — the daemon is unreachable from the dashboard process. '
                + 'Common cause: $HOME / --config dir mismatch between the dashboard user and the daemon. '
                + 'Restart nvpn or check that ~/.config/nvpn/daemon.pid exists.',
        }
      : null;
    // Identity: 4.x dropped `npub` / `pubkey` from status JSON; the
    // local node's pubkey only lives in config.toml. The helper is
    // leak-safe — it returns ONLY `[nostr] public_key`, never the
    // secret_key or wireguard private key that sit next to it.
    const identity = readNvpnNodeIdentity();
    await writeJson(res, 200, { ...status, row, health, stale, identity });
    return true;
  }

  // Container / NAT detection — surfaces a "this deployment may need
  // port-forwarding" callout for users running nostr-station inside
  // Docker, OrbStack, LXC, etc. Pure read (no daemon spawn beyond the
  // single status probe), and the data rarely changes — UI can call
  // this once on dashboard load and again on refresh.
  if (url === '/api/nvpn/deployment-context' && method === 'GET') {
    const status = await probeNvpnStatus();
    const raw = status.raw as Record<string, any> | null;
    // Same endpoint-extraction logic as nvpnHealthSummary — nvpn has
    // shipped this field under a few names. Stay schema-flexible.
    const publicEndpoint =
      (raw && typeof raw.public_endpoint === 'string' && raw.public_endpoint) ||
      (raw && typeof raw.external_endpoint === 'string' && raw.external_endpoint) ||
      (raw && raw.nat && typeof raw.nat.public_endpoint === 'string' && raw.nat.public_endpoint) ||
      (raw && typeof raw.endpoint === 'string' && raw.endpoint) ||
      null;
    const container = detectContainer();
    const warning = natWarningFor({ container, publicEndpoint });
    await writeJson(res, 200, { container, publicEndpoint, warning });
    return true;
  }

  // Connectivity diagnosis — explains *why* a node is offline. Pure read
  // (one status probe + config.toml reads), so it's cheap to call on every
  // panel refresh. Assembles the signals the analyzer needs: active vs
  // daemon-reported network id, our pubkey (for the deterministic mesh-IP
  // check), configured networks, live tunnel IP, roster / online counts,
  // advertised endpoint reachability, and configured FIPS relay peers.
  if (url === '/api/nvpn/network-diagnosis' && method === 'GET') {
    const status = await probeNvpnStatus();
    const raw = status.raw as Record<string, any> | null;

    const roster   = readNvpnRoster();
    const networks = readNvpnNetworks();
    const fips     = readNvpnFipsPeerEndpoints();
    const identity = readNvpnNodeIdentity();
    const container = detectContainer();

    // Decode our npub → hex for the IPAM hash. Tolerate a hex-shaped or
    // missing value rather than throwing.
    let pubkeyHex: string | null = null;
    if (identity.npub) {
      if (/^[0-9a-f]{64}$/i.test(identity.npub)) pubkeyHex = identity.npub.toLowerCase();
      else { try { pubkeyHex = npubToHex(identity.npub).toLowerCase(); } catch { pubkeyHex = null; } }
    }

    // Advertised endpoint — raw.endpoint first (what this node tells peers
    // to dial), then the STUN-discovered variants.
    const endpoint =
      (raw && typeof raw.endpoint === 'string' && raw.endpoint) ||
      (raw && typeof raw.public_endpoint === 'string' && raw.public_endpoint) ||
      (raw && typeof raw.external_endpoint === 'string' && raw.external_endpoint) ||
      (raw && raw.nat && typeof raw.nat.public_endpoint === 'string' && raw.nat.public_endpoint) ||
      null;

    // Online peer count from live status. peers may be an array or a
    // pubkey-keyed object; count entries flagged connected/online/up.
    let onlineCount = 0;
    const peers = raw?.peers;
    const peerList = Array.isArray(peers) ? peers : (peers && typeof peers === 'object' ? Object.values(peers) : []);
    for (const p of peerList as any[]) {
      if (p && typeof p === 'object' && (p.connected ?? p.online ?? p.up)) onlineCount++;
    }

    // Outbound join request age, when the daemon surfaces one. Field name
    // varies / may be absent — extract defensively and only when we can
    // derive an age, so a missing field just means "no pending-join finding."
    let pendingJoinAgeSecs: number | null = null;
    const jr = (raw && (raw.outbound_join_request || raw.join_request || raw.pending_join)) as any;
    if (jr && typeof jr === 'object') {
      if (typeof jr.age_secs === 'number') pendingJoinAgeSecs = jr.age_secs;
      else {
        const tsStr = jr.created_at || jr.ts || jr.requested_at;
        const tsMs = typeof tsStr === 'string' ? Date.parse(tsStr) : (typeof tsStr === 'number' ? tsStr * 1000 : NaN);
        if (Number.isFinite(tsMs)) pendingJoinAgeSecs = Math.max(0, Math.round((Date.now() - tsMs) / 1000));
      }
    }

    // Identity split: the dashboard manages `identity.npub` (user-side
    // config), but the daemon may run a different identity entirely (a
    // root --service that minted its own keypair). Resolve the daemon's
    // real config path from its live cmdline and read its identity — all
    // from live evidence, nothing hardcoded. Best-effort: null when we
    // can't read it (e.g. empty sudo cred cache) → no split finding.
    const managedNpub = identity.npub;
    const daemonPid = (raw && raw.daemon && typeof raw.daemon.pid === 'number') ? raw.daemon.pid : null;
    const daemonCfg = await resolveDaemonConfigPath(daemonPid);
    let daemonNpub: string | null = null;
    if (daemonCfg.path) {
      // Only treat it as the "daemon identity" when it's a *different*
      // file than the managed config — otherwise it's the same node.
      if (daemonCfg.path !== identity.configPath) {
        daemonNpub = await readNodeNpubFromPath(daemonCfg.path);
      }
    }

    const diagnosis = diagnoseNvpnNetwork({
      running:                status.running,
      activeNetworkId:        roster.networkId,
      daemonNetworkId:        raw && typeof raw.network_id === 'string' ? raw.network_id : null,
      pubkeyHex,
      configuredNetworks:     networks.map(n => ({ networkId: n.networkId, active: n.active })),
      liveTunnelIp:           status.tunnelIp,
      rosterParticipantCount: roster.participants.length,
      rosterAdminCount:       roster.admins.length,
      onlineCount,
      endpoint,
      endpointIsPrivate:      isPrivateEndpoint(endpoint),
      fipsPeerEndpointCount:  Object.keys(fips.endpoints).length,
      pendingJoinAgeSecs,
      containerKind:          container ? container.kind : null,
      managedNpub,
      daemonNpub,
    });
    await writeJson(res, 200, {
      ...diagnosis,
      // Echo the raw signals so the UI can show the underlying values
      // alongside the findings (active vs daemon network, expected vs live
      // IP) without a second round-trip.
      context: {
        activeNetworkId: roster.networkId,
        daemonNetworkId: raw && typeof raw.network_id === 'string' ? raw.network_id : null,
        liveTunnelIp:    status.tunnelIp,
        endpoint,
        endpointIsPrivate: isPrivateEndpoint(endpoint),
        rosterParticipantCount: roster.participants.length,
        rosterAdminCount: roster.admins.length,
        onlineCount,
        fipsPeerEndpointCount: Object.keys(fips.endpoints).length,
        running: status.running,
        managedNpub,
        daemonNpub,
        daemonConfigPath: daemonCfg.path,
        managedConfigPath: identity.configPath,
      },
    });
    return true;
  }

  if (url === '/api/nvpn/start' && method === 'POST') {
    const r = await startNvpn();
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }

  if (url === '/api/nvpn/stop' && method === 'POST') {
    const r = await stopNvpn();
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }

  if (url === '/api/nvpn/restart' && method === 'POST') {
    const r = await restartNvpn();
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }

  if (url === '/api/nvpn/install-service' && method === 'POST') {
    const r = await installNvpnService();
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }

  // Split-brain detection (#58). Surfaces when both a user-mode and
  // systemd-managed nvpn daemon are running — the install wizard's
  // current behaviour leaves both processes alive, and CLI invocations
  // from nostr-station hit the user-mode daemon (which lacks caps).
  if (url === '/api/nvpn/split-brain' && method === 'GET') {
    const r = await detectSplitBrain();
    await writeJson(res, 200, r);
    return true;
  }
  // Consolidate to the systemd-managed daemon by stopping the user-mode
  // one. Idempotent — if no user daemon is running, returns ok with a
  // "nothing to do" detail.
  if (url === '/api/nvpn/split-brain/consolidate' && method === 'POST') {
    const r = await stopUserModeDaemon();
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }

  // Reachability test (v0). Returns the data the UI needs to walk the
  // user through a manual external probe: published endpoint, suggested
  // commands, host-side verification recipe. Server-side hairpin probe
  // intentionally deferred — it confirms only that the daemon is locally
  // reachable, not that the public path works.
  if (url === '/api/nvpn/reachability-recipe' && method === 'GET') {
    const status = await probeNvpnStatus();
    const raw = status.raw as Record<string, any> | null;
    const endpoint =
      (raw && typeof raw.public_endpoint === 'string' && raw.public_endpoint) ||
      (raw && typeof raw.external_endpoint === 'string' && raw.external_endpoint) ||
      (raw && raw.nat && typeof raw.nat.public_endpoint === 'string' && raw.nat.public_endpoint) ||
      (raw && typeof raw.endpoint === 'string' && raw.endpoint) ||
      null;
    const listenPort =
      (raw && typeof raw.listen_port === 'number' && raw.listen_port) ||
      (raw && typeof raw.port === 'number' && raw.port) ||
      null;
    await writeJson(res, 200, {
      endpoint,
      listenPort,
      probeCommand: endpoint
        ? `nc -u ${endpoint.split(':')[0]} ${endpoint.split(':')[1] || listenPort || 51820}`
        : null,
      hostVerifyCommand: listenPort
        ? `sudo tcpdump -i any -n udp port ${listenPort}`
        : `sudo tcpdump -i any -n udp port 51820`,
      instructions: [
        'On the nostr-station host, run the host-verify command in a terminal.',
        'From any network outside your LAN (your phone on cell data, a cloud shell, a friend\'s machine), run the probe command. Type a few characters, press Enter, repeat.',
        'Watch the host-verify output: if the probe packets land (you see lines mentioning your source IP), the data plane is reachable end-to-end.',
        'If no packets land, the chain is broken at one of: home router (UDP port-forward), container runtime (host → container forward), or host firewall. See docs/nvpn-deployment.md for fixes.',
      ],
    });
    return true;
  }

  // ── Service lifecycle (Feature 2) ─────────────────────────────────
  // Status is unprivileged — supports the meta strip's pill display.
  // Enable / disable / uninstall need sudo for system-supervisor paths
  // (/etc/systemd/system or /Library/LaunchDaemons); we route through
  // sudo -n and surface a clear hint when the cred cache is empty.
  if (url === '/api/nvpn/service/status' && method === 'GET') {
    const r = await probeNvpnServiceStatus();
    await writeJson(res, 200, r);
    return true;
  }
  // ── Admin unlock (sudo cred-cache warming) ────────────────────────
  // Privileged ops below all run `sudo -n`, which needs a warm cred
  // cache. The dashboard has no TTY to answer a sudo prompt, so we let
  // the user "unlock" once: their password is piped straight to
  // `sudo -S -v` and never stored/logged. status reports whether the
  // cache is currently usable.
  if (url === '/api/nvpn/sudo/status' && method === 'GET') {
    await writeJson(res, 200, {
      ...(await sudoState()),
      permanentCmd: buildSudoersInstallCommand(),
    });
    return true;
  }
  if (url === '/api/nvpn/sudo/unlock' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body || typeof body.password !== 'string') {
      await writeJson(res, 400, { ok: false, detail: 'password required' });
      return true;
    }
    const r = await warmSudoCache(body.password);
    // body.password drops out of scope here; never echoed back. Always
    // 200 — the {ok} flag carries success/failure so the client can show
    // an inline "incorrect password" without a generic red error toast.
    await writeJson(res, 200, r);
    return true;
  }
  if (url === '/api/nvpn/service/enable' && method === 'POST') {
    const r = await enableNvpnService();
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }
  if (url === '/api/nvpn/service/disable' && method === 'POST') {
    const r = await disableNvpnService();
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }
  if (url === '/api/nvpn/service/uninstall' && method === 'POST') {
    const r = await uninstallNvpnService();
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }
  if (url === '/api/nvpn/cli/uninstall' && method === 'POST') {
    const r = await uninstallNvpnCli();
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }

  // ── Roster read (config.toml) ─────────────────────────────────────
  // Live peers come from `nvpn status --json` — that's the connected
  // set. The roster (configured participants + admins) only lives in
  // ~/.config/nvpn/config.toml. We read it directly so the dashboard
  // can show "Alice is invited but offline" instead of just "no peers."
  if (url === '/api/nvpn/roster' && method === 'GET') {
    const roster = readNvpnRoster();
    await writeJson(res, 200, roster);
    return true;
  }

  // ── Configured networks ──────────────────────────────────────────
  // Returns every `[[networks]]` block in config.toml so the dashboard
  // can show "X also configured" alongside the active network. The
  // active one is always index 0; inactive networks stay saved until
  // re-activated (POST /networks/join re-adds + activates by id, or the
  // native app reorders the blocks).
  if (url === '/api/nvpn/networks' && method === 'GET') {
    const networks = readNvpnNetworks();
    await writeJson(res, 200, { networks });
    return true;
  }

  // Join a network by id, no invite required — mirrors the native nvpn
  // app's "manual join." Adds a `[[networks]]` block for the id and makes
  // it active (config.toml edit), then reloads the daemon best-effort so
  // it starts converging on the admin-signed roster. 400 on bad/duplicate
  // input so the UI can distinguish it from a write failure (500-ish).
  if (url === '/api/nvpn/networks/join' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body) { await writeJson(res, 400, { ok: false, detail: 'invalid JSON body' }); return true; }
    const networkId = typeof body.networkId === 'string' ? body.networkId : '';
    const r = joinNvpnNetwork(networkId);
    if (r.ok && r.detail !== 'already the active network') {
      // A new active network needs the daemon to re-read config. reload
      // is best-effort; the UI nudges the user to restart if needed.
      await reloadNvpn().catch(() => null);
    }
    await writeJson(res, r.ok ? 200 : 400, r);
    return true;
  }

  // Repair a forked / non-canonical network config. Preview-first:
  // body `{ apply: false }` (default) returns the plan without writing;
  // `{ apply: true }` backs up config.toml, writes the de-forked +
  // re-pinned config atomically, and reports the backup path. We never
  // reload/restart here — a network-identity change needs a full restart
  // (brief interface drop), which the UI prompts for explicitly.
  if (url === '/api/nvpn/networks/repair' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body) { await writeJson(res, 400, { ok: false, detail: 'invalid JSON body' }); return true; }
    const apply = body.apply === true;
    // Decode our npub → hex so the planner can compute the correct
    // deterministic IP for the re-pin. Tolerate hex-shaped / missing.
    const identity = readNvpnNodeIdentity();
    let pubkeyHex: string | null = null;
    if (identity.npub) {
      if (/^[0-9a-f]{64}$/i.test(identity.npub)) pubkeyHex = identity.npub.toLowerCase();
      else { try { pubkeyHex = npubToHex(identity.npub).toLowerCase(); } catch { pubkeyHex = null; } }
    }
    const r = repairNvpnNetworkConfig({ apply, pubkeyHex });
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }

  // Adopt identity: make the running daemon use the dashboard-managed
  // identity + config instead of a separate (auto-minted) one. Preview-
  // first: `{ apply: false }` (default) returns the plan with no write;
  // `{ apply: true }` backs up the daemon's config, sudo-copies the managed
  // config onto the daemon's resolved --config path, and restarts. The
  // daemon pid comes from the live status probe (config-path resolution
  // keys off it). 200 on ok/preview, 500 on a write/sudo failure.
  if (url === '/api/nvpn/identity/adopt' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body) { await writeJson(res, 400, { ok: false, detail: 'invalid JSON body' }); return true; }
    const apply = body.apply === true;
    const status = await probeNvpnStatus();
    const raw = status.raw as Record<string, any> | null;
    const daemonPid = (raw && raw.daemon && typeof raw.daemon.pid === 'number') ? raw.daemon.pid : null;
    const r = await adoptIdentity({ apply, daemonPid });
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }

  // ── Join requests (#62) ───────────────────────────────────────────
  // nvpn protocol supports peer-initiated join-requests: a device that
  // imports an admin's invite can submit a request, and the admin
  // approves to add to the roster. CLI surface varies across nvpn
  // versions; the bridge tries a few naming variants and reports
  // `supported: false` when none match.
  if (url === '/api/nvpn/join-requests' && method === 'GET') {
    const r = await listJoinRequests();
    await writeJson(res, 200, r);
    return true;
  }
  if (url === '/api/nvpn/join-requests/approve' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body) { await writeJson(res, 400, { ok: false, detail: 'invalid JSON body' }); return true; }
    const p = typeof body.participant === 'string' ? body.participant : '';
    const r = await approveJoinRequest(p);
    await writeJson(res, r.ok ? 200 : 400, r);
    return true;
  }
  if (url === '/api/nvpn/join-requests/deny' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body) { await writeJson(res, 400, { ok: false, detail: 'invalid JSON body' }); return true; }
    const p = typeof body.participant === 'string' ? body.participant : '';
    const r = await denyJoinRequest(p);
    await writeJson(res, r.ok ? 200 : 400, r);
    return true;
  }

  // ── Roster mutations ──────────────────────────────────────────────
  // Each route accepts `{ participants: string[], publish?: boolean }`.
  // `publish` defaults to true so single-click "Add peer" actually
  // broadcasts the roster — the alternative ("local only") is a power
  // user surface and the UI exposes it as a checkbox when needed.
  const rosterRoute: Record<string, (parts: string[], publish: boolean) => Promise<unknown>> = {
    '/api/nvpn/peers/add':      addParticipants,
    '/api/nvpn/peers/remove':   removeParticipants,
    '/api/nvpn/admins/add':     addAdmins,
    '/api/nvpn/admins/remove':  removeAdmins,
  };
  if (rosterRoute[url] && method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body) { await writeJson(res, 400, { ok: false, detail: 'invalid JSON body' }); return true; }
    const participants = Array.isArray(body.participants) ? body.participants : [];
    const publish = body.publish !== false; // default-on
    const r = await rosterRoute[url](participants, publish) as { ok: boolean };
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }

  // Recover from runaway discovery: stop → clear the daemon's
  // recent-peers cache → start. Restarts the daemon (brief tunnel blip),
  // so the UI gates it behind a confirm.
  if (url === '/api/nvpn/peers/reset' && method === 'POST') {
    const r = await resetNvpnPeerState();
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }

  if (url === '/api/nvpn/roster/publish' && method === 'POST') {
    // PR #154 fenced this behind 501 on the premise that --publish on
    // each mutation made a standalone republish redundant. Live VM
    // validation proved that wrong — mutations regularly report
    // `published_recipients: 0` (relay timeouts, WoT/POW gates), and
    // users had no retry-publish path. publishRoster() now triggers a
    // republish by re-adding an existing admin with --publish (a no-op
    // mutation that exercises the publish path), so the dashboard
    // gets back its "publish now" action. Response includes
    // `publishedRecipients` so the UI can show recipient count
    // honestly (yellow on 0, green on ≥1).
    const r = await publishRoster();
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }

  // ── Discovery relays ──────────────────────────────────────────────
  // Read goes straight from config.toml so it works while the daemon
  // is down; mutations go through `nvpn set --relay` so persistence +
  // reload semantics stay consistent with every other settings change.
  if (url === '/api/nvpn/relays' && method === 'GET') {
    const r = readNvpnRelays();
    await writeJson(res, 200, r);
    return true;
  }
  // Curated "good defaults" the dashboard offers as a one-click recovery
  // when the configured relays are flaking. Lives in nvpn.ts so the
  // server is the single source of truth — UI fetches and previews.
  if (url === '/api/nvpn/relays/recommended' && method === 'GET') {
    await writeJson(res, 200, { relays: [...RECOMMENDED_NVPN_RELAYS] });
    return true;
  }
  // Per-relay health snapshot. Surfaces what the in-process health
  // aggregator has seen from the vpn LogBuffer over its sliding window
  // (~5min). The UI joins this against /api/nvpn/relays so URLs with no
  // recent events render as "no data" rather than as broken.
  if (url === '/api/nvpn/relays/health' && method === 'GET') {
    const snapshot = nvpnRelayHealth().snapshot();
    await writeJson(res, 200, { health: snapshot, windowMs: 5 * 60 * 1000 });
    return true;
  }
  // Relay mutations. nvpn 4.x removed the bulk `nvpn set --relay` CLI, so
  // these edit config.toml's active `[[networks]] relays = […]` directly
  // (same approach the native app takes) and then reload the daemon
  // best-effort so the running process re-reads the set. 400 on bad input
  // (invalid URL, no networks block, refusing to empty the list) keeps it
  // distinct from a write failure.
  if (url === '/api/nvpn/relays/add' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body) { await writeJson(res, 400, { ok: false, detail: 'invalid JSON body' }); return true; }
    const u = typeof body.url === 'string' ? body.url : '';
    const r = await addNvpnRelay(u);
    if (r.ok) await reloadNvpn().catch(() => null);
    await writeJson(res, r.ok ? 200 : 400, r);
    return true;
  }
  if (url === '/api/nvpn/relays/remove' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body) { await writeJson(res, 400, { ok: false, detail: 'invalid JSON body' }); return true; }
    const u = typeof body.url === 'string' ? body.url : '';
    const r = await removeNvpnRelay(u);
    if (r.ok) await reloadNvpn().catch(() => null);
    await writeJson(res, r.ok ? 200 : 400, r);
    return true;
  }
  if (url === '/api/nvpn/relays/set' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body) { await writeJson(res, 400, { ok: false, detail: 'invalid JSON body' }); return true; }
    const relays = Array.isArray(body.relays) ? body.relays : [];
    const r = await setNvpnRelays(relays);
    if (r.ok) await reloadNvpn().catch(() => null);
    await writeJson(res, r.ok ? 200 : 400, r);
    return true;
  }

  // ── Invites ───────────────────────────────────────────────────────
  if (url === '/api/nvpn/invite/create' && method === 'POST') {
    const r = await createInvite();
    if (!r.ok) { await writeJson(res, 500, r); return true; }
    // Render the QR alongside the invite string so the client gets a
    // single round-trip per "Share network" click — keeps the modal
    // snappy and avoids a second API call from inside the modal open.
    const qrSvg = r.invite ? await renderInviteQr(r.invite) : '';
    await writeJson(res, 200, { ...r, qrSvg });
    return true;
  }

  if (url === '/api/nvpn/invite/import' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body) { await writeJson(res, 400, { ok: false, detail: 'invalid JSON body' }); return true; }
    const invite = typeof body.invite === 'string' ? body.invite : '';
    const r = await importInvite(invite);
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }

  // ── Aliases (config.toml [peer_aliases] mutation) ─────────────────
  // nvpn has no CLI flag for aliases; we own the file mutation. Each
  // route follows up with `nvpn reload` so the daemon picks up the
  // new label without a restart. Validation is shared with the lib
  // helpers (isValidParticipant + ALIAS_VALUE_RE).
  if (url === '/api/nvpn/aliases/set' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body) { await writeJson(res, 400, { ok: false, detail: 'invalid JSON body' }); return true; }
    const participant = typeof body.participant === 'string' ? body.participant : '';
    const alias       = typeof body.alias === 'string' ? body.alias : '';
    const r = setNvpnAlias(participant, alias);
    if (r.ok) {
      // Best-effort reload — alias display works either way (we read
      // config.toml directly), but `nvpn reload` is required if any
      // tooling consumes aliases through the daemon socket.
      await reloadNvpn().catch(() => null);
    }
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }
  if (url === '/api/nvpn/aliases/remove' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body) { await writeJson(res, 400, { ok: false, detail: 'invalid JSON body' }); return true; }
    const participant = typeof body.participant === 'string' ? body.participant : '';
    const r = removeNvpnAlias(participant);
    if (r.ok) await reloadNvpn().catch(() => null);
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }

  // ── Whois ─────────────────────────────────────────────────────────
  if (url === '/api/nvpn/whois' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body) { await writeJson(res, 400, { ok: false, detail: 'invalid JSON body' }); return true; }
    const query = typeof body.query === 'string' ? body.query : '';
    const r = await whoisPeer(query);
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }

  // ── Pause / resume / reload / repair (Feature 3) ──────────────────
  // Less destructive than stop. pause flips the data plane off without
  // killing the daemon; resume turns it back on. reload re-reads
  // config + roster. repair-network fixes orphaned routes/iface state
  // left behind by a crash.
  if (url === '/api/nvpn/pause' && method === 'POST') {
    const r = await pauseNvpn();
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }
  if (url === '/api/nvpn/resume' && method === 'POST') {
    const r = await resumeNvpn();
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }
  if (url === '/api/nvpn/reload' && method === 'POST') {
    const r = await reloadNvpn();
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }
  if (url === '/api/nvpn/repair-network' && method === 'POST') {
    const r = await repairNvpnNetwork();
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }

  // ── Diagnostics ───────────────────────────────────────────────────
  if (url === '/api/nvpn/ping' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body) { await writeJson(res, 400, { ok: false, detail: 'invalid JSON body' }); return true; }
    const target = typeof body.target === 'string' ? body.target : '';
    const r = await pingNvpnPeer(target, {
      count:       typeof body.count === 'number' ? body.count : undefined,
      timeoutSecs: typeof body.timeoutSecs === 'number' ? body.timeoutSecs : undefined,
    });
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }
  if (url === '/api/nvpn/netcheck' && method === 'GET') {
    // 501: `nvpn netcheck` removed in 4.x — folded into `doctor`.
    const r = await netcheckNvpn();
    await writeJson(res, r.ok ? 200 : 501, r);
    return true;
  }
  if (url === '/api/nvpn/doctor' && method === 'POST') {
    const body = await parseJsonBody(req) || {};
    const r = await doctorNvpn({ writeBundle: !!body.bundle });
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }
  // nat-discover is intentionally not surfaced as a button in the
  // dashboard's Diagnostics block — it's a power-user probe (you have
  // to know what reflector to point at) and nvpn already runs NAT
  // discovery automatically against the daemon's stun_servers list.
  // Route stays here so curl + tooling can drive it.
  if (url === '/api/nvpn/nat-discover' && method === 'POST') {
    // 501: `nvpn nat-discover` removed in 4.x — STUN runs in-daemon.
    const body = await parseJsonBody(req);
    if (!body) { await writeJson(res, 400, { ok: false, detail: 'invalid JSON body' }); return true; }
    const reflector  = typeof body.reflector === 'string' ? body.reflector : '';
    const listenPort = typeof body.listenPort === 'number' ? body.listenPort : undefined;
    const r = await natDiscoverNvpn(reflector, listenPort);
    await writeJson(res, r.ok ? 200 : 501, r);
    return true;
  }
  if (url === '/api/nvpn/stats' && method === 'GET') {
    // 501: `nvpn stats` removed in 4.x along with relay-for-others.
    const r = await statsNvpn();
    await writeJson(res, r.ok ? 200 : 501, r);
    return true;
  }

  // ── `nvpn set` ────────────────────────────────────────────────────
  // Curated allowlist applied inside setNvpnSettings — unknown keys
  // are silently dropped. Settings that affect the data plane (e.g.
  // listen-port) require a `reload` or restart to take effect; the UI
  // surfaces the hint after a successful save.
  if (url === '/api/nvpn/set' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body || typeof body !== 'object') {
      await writeJson(res, 400, { ok: false, detail: 'invalid JSON body' }); return true;
    }
    const r = await setNvpnSettings(body);
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }

  return false;
}
