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
  nvpnRowStateFor,
  addParticipants, removeParticipants, addAdmins, removeAdmins,
  publishRoster, createInvite, importInvite, whoisPeer, readNvpnRoster,
  pauseNvpn, resumeNvpn, reloadNvpn, repairNvpnNetwork,
  pingNvpnPeer, netcheckNvpn, doctorNvpn, natDiscoverNvpn,
  setNvpnSettings, statsNvpn,
  setNvpnAlias, removeNvpnAlias,
  readNvpnRelays, addNvpnRelay, removeNvpnRelay, setNvpnRelays,
} from '../nvpn.js';
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
    await writeJson(res, 200, { ...status, row });
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

  if (url === '/api/nvpn/roster/publish' && method === 'POST') {
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
  if (url === '/api/nvpn/relays/add' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body) { await writeJson(res, 400, { ok: false, detail: 'invalid JSON body' }); return true; }
    const r = await addNvpnRelay(typeof body.url === 'string' ? body.url : '');
    await writeJson(res, r.ok ? 200 : 400, r);
    return true;
  }
  if (url === '/api/nvpn/relays/remove' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body) { await writeJson(res, 400, { ok: false, detail: 'invalid JSON body' }); return true; }
    const r = await removeNvpnRelay(typeof body.url === 'string' ? body.url : '');
    await writeJson(res, r.ok ? 200 : 400, r);
    return true;
  }
  // Bulk replace — useful for "reset to defaults" or paste-a-list flows.
  // Refuses an empty list at the lib layer to avoid stranding the node.
  if (url === '/api/nvpn/relays/set' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body) { await writeJson(res, 400, { ok: false, detail: 'invalid JSON body' }); return true; }
    const list = Array.isArray(body.relays) ? body.relays : [];
    const r = await setNvpnRelays(list);
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
    const r = await netcheckNvpn();
    await writeJson(res, r.ok ? 200 : 500, r);
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
    const body = await parseJsonBody(req);
    if (!body) { await writeJson(res, 400, { ok: false, detail: 'invalid JSON body' }); return true; }
    const reflector  = typeof body.reflector === 'string' ? body.reflector : '';
    const listenPort = typeof body.listenPort === 'number' ? body.listenPort : undefined;
    const r = await natDiscoverNvpn(reflector, listenPort);
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }
  if (url === '/api/nvpn/stats' && method === 'GET') {
    const r = await statsNvpn();
    await writeJson(res, r.ok ? 200 : 500, r);
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
