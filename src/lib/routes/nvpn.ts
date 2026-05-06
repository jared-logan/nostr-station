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
  probeNvpnStatus, startNvpn, stopNvpn, restartNvpn, installNvpnService,
  nvpnRowStateFor,
  addParticipants, removeParticipants, addAdmins, removeAdmins,
  publishRoster, createInvite, importInvite, whoisPeer, readNvpnRoster,
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

  // ── Whois ─────────────────────────────────────────────────────────
  if (url === '/api/nvpn/whois' && method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body) { await writeJson(res, 400, { ok: false, detail: 'invalid JSON body' }); return true; }
    const query = typeof body.query === 'string' ? body.query : '';
    const r = await whoisPeer(query);
    await writeJson(res, r.ok ? 200 : 500, r);
    return true;
  }

  return false;
}
