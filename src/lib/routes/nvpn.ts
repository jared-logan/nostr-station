/**
 * nvpn (nostr-vpn) runtime routes — the API surface behind the dashboard's
 * Start/Stop buttons and the Logs panel's nostr-vpn tab. Pre-extension this
 * was a one-line "tail it yourself in a terminal" hint; everything here
 * exists so the user never has to drop into a terminal for normal nvpn
 * operation.
 *
 * Surface:
 *   GET  /api/nvpn/status            — full status JSON, binary path,
 *                                      derived row state for the Status panel.
 *   POST /api/nvpn/start             — `nvpn start --daemon`
 *   POST /api/nvpn/stop              — `nvpn stop`
 *   POST /api/nvpn/restart           — stop + start (best-effort stop)
 *   POST /api/nvpn/install-service   — best-effort `sudo -n nvpn service install`
 *
 * Auth + rebinding gate is enforced by web-server.ts's umbrella before any
 * handler in here sees the request.
 *
 * Returns `true` when matched + responded; `false` lets the orchestrator
 * keep trying its remaining route groups.
 */
import http from 'http';
import {
  probeNvpnStatus, startNvpn, stopNvpn, restartNvpn, installNvpnService,
  nvpnRowStateFor,
} from '../nvpn.js';

async function writeJson(
  res: http.ServerResponse, status: number, body: unknown,
): Promise<void> {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function handleNvpn(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  if (!url.startsWith('/api/nvpn/')) return false;

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

  return false;
}
