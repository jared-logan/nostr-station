/**
 * nostr-station web dashboard server.
 *
 * Serves the control-center UI at /, and a small JSON+SSE API at /api/*:
 *   GET  /api/config         — AI provider + model + context presence
 *   POST /api/chat           — SSE streaming chat (proxies to provider)
 *   GET  /api/status         — gatherStatus() results (shared w/ `status --json`)
 *
 * Bound to 127.0.0.1 only. No auth — local user is the trust boundary.
 */

import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { nip19 } from 'nostr-tools';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { getKeychain } from './keychain.js';
import {
  serveStatic, serveVendorXterm, WEB_DIR, HTML_SECURITY_HEADERS,
} from './web-server-static.js';
import { runSetupVerify } from './setup-verify.js';
// Most terminal helpers moved alongside their HTTP routes + the WS
// upgrade handler — see routes/terminal.ts. We still need `loadPty`
// for the warm-up at server-listen time and `destroyAllSessions` to
// clean up on `server.close`.
import {
  loadPty, destroyAllSessions as destroyAllTerminals,
} from './terminal.js';
// AI provider registry / multi-provider config / context-builder all
// moved alongside their route handler — see routes/ai.ts. The legacy
// `/api/config/set` flow below still uses the in-file PROVIDERS map
// declared further down and the keychain slot `ai-api-key`; that
// surface goes away when the Chat pane fully switches to /api/ai/chat.
import { migrateIfNeeded } from './ai-config.js';
import { gatherStatus } from '../commands/Status.js';
import { DEFAULT_DB_PATH } from '../relay/store.js';
import type { Relay } from '../relay/index.js';
import { LogBuffer, type LogLine } from './log-buffer.js';
import { nvpnRelayHealth } from './nvpn-relay-health.js';
import { getTool, installTool, TOOLS } from './tools.js';
import { Watchdog } from './watchdog.js';
import { installNostrVpn } from './nvpn-installer.js';
import {
  probeNvpnStatus, probeNvpnServiceStatus, startNvpnLogTail, vpnBannerRunningFor,
  nvpnEvents, memoizeWithSwr,
} from './nvpn.js';
import { installNak } from './nak-installer.js';
import { installNgit } from './ngit-installer.js';
import { installGrain } from './grain-installer.js';
import { hexToNpub, npubToHex } from './identity.js';
import {
  readIdentity, setSetupComplete, isNsec,
  setInprocBlossomEnabled, setWatchdogEnabled,
} from './identity.js';
import {
  issueChallenge, consumeChallenge, createSession,
  deleteSession, extractBearer, verifyNip98, authStatus,
  isPublicApi, requireSession, expectedDashboardUrl,
  loadSessions, persistSessions, issueDownloadToken,
} from './auth.js';
import {
  startUpdatePoller, stopUpdatePoller, getUpdateStatus,
  refreshUpdateStatus, streamApplyUpdate,
} from './update-check.js';
import { gatherToolUpdates } from './tool-updates.js';
import {
  startNostrConnect, getBunkerSession, consumeBunkerSession,
  signWithBunkerUrl, silentBunkerSign,
  startSetupAmber, getSetupAmberSession, consumeSetupAmberSession,
  signEventWithSavedBunker,
} from './auth-bunker.js';
import { writePidFile, removePidFile } from './pid-file.js';
import {
  readBody, streamExec, streamExecError,
  CLI_BIN, CLI_SPAWN,
  getActiveChatProjectId,
  setInprocRelayPort,
  setInprocBlossomPort,
  setWhitelistRef,
  type CmdSpec,
} from './routes/_shared.js';
import { setLocalStore } from './inproc-store-ref.js';
import { readStationContext, stationContextPath } from './ai-context.js';
import { atomicWriteText } from './atomic-write.js';
import { handleImgProxy } from './img-proxy.js';
import { signProxyUrl } from './img-proxy-sign.js';
import { seedStationContext, USER_REGION_BEGIN, USER_REGION_END } from './editor.js';
import { handleProjects } from './routes/projects.js';
import { handleBlossomConfig } from './routes/blossom-config.js';
import type { BlossomServer } from '../blossom/index.js';
import { readProjects } from './projects.js';
import { listAllTestPubkeys } from './test-identities.js';
import { handleIdentity } from './routes/identity.js';
import { handleClient } from './routes/client.js';
import { handleApps } from './routes/apps.js';
import { handleNgit } from './routes/ngit.js';
import { handleRepo } from './routes/repo.js';
import { handlePatches } from './routes/patches.js';
import { handleIssues } from './routes/issues.js';
import { handleStatus } from './routes/status.js';
import { runScratchGc } from './scratch-gc.js';
import { handleAi } from './routes/ai.js';
import { handleTerminal, mountTerminalWebSocket } from './routes/terminal.js';
import { mountRelayProxyWebSocket } from './routes/relay-proxy.js';
import { handleNvpn } from './routes/nvpn.js';
import { handleCommunities } from './routes/communities.js';
import {
  attachDashboardBindingFilter, isLoopbackAddress, allowDashboardConnection,
  trustedDevicePubkeys, meshHostMatches, meshUrlMatches,
} from './dashboard-binding.js';
import { readMobileAccessConfig, writeMobileAccessConfig, dashboardBindHost } from './mobile-access.js';
import { readTrustedDevices, addTrustedDevice, removeTrustedDevice } from './trusted-devices.js';
import {
  readCommunitiesFeatureConfig, writeCommunitiesFeatureConfig, isCommunitiesUsable,
} from './communities-feature.js';
import { handleTemplates } from './routes/templates.js';
import { handleMail, setMailBlossomAccessor } from './routes/mail.js';
import { getInboxWorker } from './mail/inbox.js';
import { handleNsite, handleNsiteSubdomain } from './routes/nsite.js';

// Static-asset + vendor + security-headers wiring lives in
// ./web-server-static.ts. We re-import the four names the orchestrator
// still needs (the two route helpers + WEB_DIR/HTML_SECURITY_HEADERS
// used by the /setup SPA fallback further down).

// The legacy /api/config + /api/chat surface (loadProviderConfig +
// proxyChat + getContextStatus + contextExists) moved to ./legacy-chat.ts.
// Re-exported below to preserve external imports (Chat.tsx pulls
// `contextExists` directly from this module).
export { contextExists, getContextStatus, type ContextStatus } from './legacy-chat.js';
import {
  loadProviderConfig, proxyChat, getContextStatus,
} from './legacy-chat.js';

// ── Relay-adjacent helpers ────────────────────────────────────────────────────

// Derive the npub for a keychain-stored nsec, best-effort. Used by
// /api/relay-config to label whitelist entries by role (the station
// owner's own npub comes straight from identity.json; watchdog and seed
// are recoverable only by reading + decoding the keychain entry). Returns
// null on any failure — the consumer treats null as "role not configured
// on this station", not "keychain backend broken".
async function deriveKeychainNpub(slot: 'watchdog-nsec' | 'seed-nsec'): Promise<string | null> {
  try {
    const nsec = await getKeychain().retrieve(slot);
    if (!nsec) return null;
    const decoded = nip19.decode(nsec);
    if (decoded.type !== 'nsec') return null;
    const pubHex = getPublicKey(decoded.data as Uint8Array);
    return nip19.npubEncode(pubHex);
  } catch { return null; }
}

// Format a LogLine for the Logs panel SSE wire. Pre-deletion the panel
// consumed plain `tail -f` strings, so the client just appends as text;
// we prefix with [LEVEL] iso-time to keep the warn/err classification
// (app.js:4727 'classify') working.
function formatLogLine(line: LogLine): string {
  const iso = new Date(line.ts).toISOString();
  const prefix = line.level === 'error' ? '[ERROR]'
              : line.level === 'warn'  ? '[WARN]'
              : '[INFO]';
  return `${iso} ${prefix} ${line.text}`;
}

// ── Server ────────────────────────────────────────────────────────────────────

// In-process Nostr relay handle. Started by maybeStartInprocRelay() unless
// the user explicitly opts out with STATION_INPROC_RELAY=0. Kept here so
// the dashboard's shutdown path can stop it cleanly + the Relay panel's
// control endpoints can mutate its state. `import type` keeps the relay
// module out of runtime load until maybeStartInprocRelay's dynamic import
// actually fires (preserving the STATION_INPROC_RELAY=0 fast path).
let inprocRelay: Relay | null = null;

// In-process Blossom server (Phase C). Off by default — gated on
// STATION_INPROC_BLOSSOM=1 OR the user clicking "Enable Blossom" in
// the dashboard Status panel. Lifecycle mirrors inprocRelay above.
let inprocBlossom: BlossomServer | null = null;

// Per-channel log ring buffers for the Logs panel. The relay buffer is
// fed by Relay.onLog hooks (see maybeStartInprocRelay below). The
// watchdog buffer is fed by the in-Node Watchdog (Phase 2.1). The vpn
// buffer stays unfed for now; /api/logs/vpn returns a "pending" frame
// until Phase 2.2 lands the installer.
const logBuffers = {
  relay:    new LogBuffer(),
  watchdog: new LogBuffer(),
  vpn:      new LogBuffer(),
} as const;

// Per-relay health aggregator — listens on the vpn LogBuffer and tracks
// publish-failure patterns (rate-limited, 5xx, WoT-reject, timeout). The
// /api/nvpn/relays/health route reads its snapshot to surface relay-by-
// relay status in the dashboard's Relays tab. Singleton lives in
// nvpn-relay-health.ts so the route handler can reach it without
// dependency injection; we just attach to the vpn buffer here so it
// sees every line that flows through the tailer.
nvpnRelayHealth().attach(logBuffers.vpn);

// In-Node watchdog — heartbeats every 5 min through the local relay.
// Started after maybeStartInprocRelay (it depends on the Relay handle
// for whitelist registration + publishLocal). STATION_DISABLE_WATCHDOG=1
// opts out for tests / minimal deployments.
let watchdog: Watchdog | null = null;

// nvpn daemon log tailer. Started best-effort once at server boot; pumps
// the daemon's own log file into logBuffers.vpn so /api/logs/vpn streams
// real lines instead of the static "tail it manually" hint that used to
// land in the Logs panel. Cleaned up on server.close so the polling
// timer doesn't keep the event loop alive across hot-restarts.
let nvpnLogTailer: { stop: () => void } | null = null;

// Cache /api/status with stale-while-revalidate semantics. gatherStatus()
// is the dashboard's hot path — the Status panel polls every 3-5s, and
// several other dashboard panels call it on render. Each call shells
// out to nc, nvpn (up to 4s on a wedged daemon socket — the nvpn CLI
// doesn't fast-fail), and ~4 binary `--version` probes.
//
// With SWR: the first /api/status request after boot blocks once
// (~4 s worst case if nvpn is wedged). Every subsequent request is
// instant from cache; after the TTL elapses, callers still get the
// cached value immediately while a background refresh updates it.
// Plain TTL caching would re-block every TTL window — meaningful on
// a healthy daemon (~ms), brutal on a wedged one (~4 s).
//
// 3 s TTL stays — short enough that user-driven state changes
// (start/stop relay, connect/disconnect nvpn) feel responsive on the
// next panel refresh once the background fetch resolves.
const cachedGatherStatus = memoizeWithSwr(async () => gatherStatus(), 3_000);

// State-change → cache-invalidate wiring. Without this, the SWR cache's
// TTL window (3 s) is the floor on how long a user waits to see the
// effect of an action they just took (Stop nvpn → Status row says
// "running" for up to 3 s). With invalidate on action, the next read
// re-fetches immediately and reflects the new state.
//
// nvpn action helpers already emit `state-changed` on nvpnEvents (see
// nvpn.ts); probeNvpnStatus + probeNvpnServiceStatus auto-invalidate on
// the same event. /api/status surfaces nvpn state via gatherStatus, so
// it needs the same wiring — otherwise the dashboard's Status panel
// keeps showing the pre-action world for a TTL slice. Relay and
// watchdog actions invalidate inline at their endpoints below
// (search for `cachedGatherStatus.invalidate` in this file).
nvpnEvents.on('state-changed', () => { cachedGatherStatus.invalidate(); });

function shouldStartInprocRelay(): boolean {
  return process.env.STATION_INPROC_RELAY !== '0';
}

// runSetupVerify (Phase 4 user-journey verification) moved to
// ./setup-verify.ts. Imported at the top of this file.

async function maybeStartInprocRelay(): Promise<void> {
  if (!shouldStartInprocRelay()) return;
  if (inprocRelay) return;
  // Lazy import — nothing in the rest of web-server.ts references the
  // relay module, so we keep it out of the load graph entirely when the
  // relay isn't started.
  const { Relay } = await import('../relay/index.js');
  const port = Number(process.env.STATION_INPROC_RELAY_PORT || '7777');
  // Owner-pubkey resolver for the relay's write-gating. Re-reads
  // identity.json on every EVENT publish so the user can rotate their
  // npub (e.g. via `/api/identity/set`) without restarting the relay.
  // Returns null when no owner is configured yet (fresh install / mid-
  // wizard) — the relay then accepts only whitelisted publishers, which
  // is the correct lock-down state.
  const r = new Relay({
    port, host: '127.0.0.1',
    getOwnerHex: () => {
      try {
        const ident = readIdentity();
        return ident.npub ? npubToHex(ident.npub).toLowerCase() : null;
      } catch { return null; }
    },
    // Pipe relay-emitted log lines into the channel buffer that backs
    // /api/logs/relay (1.8). Connection open/close, EVENT accept/reject/
    // duplicate, REQ subscriptions, and AUTH outcomes all land here.
    onLog: (level, text) => logBuffers.relay.push(level, text),
  });
  await r.start();
  inprocRelay = r;
  // Bridge the running port + whitelist handle through routes/_shared
  // so project-scaffold and test-identities (Phase B) can consume
  // without importing the relay layer.
  setInprocRelayPort(port);
  setLocalStore(r.store);
  setWhitelistRef({
    add:    (hex) => r.whitelist.add(hex),
    remove: (hex) => r.whitelist.remove(hex),
    has:    (hex) => r.whitelist.has(hex),
  });
  // Publish the relay address via env so gatherStatus probes the right
  // port, and any descendant tooling (e.g. nak commands) sees the same
  // source of truth.
  process.env.RELAY_HOST = '127.0.0.1';
  process.env.RELAY_PORT = String(port);
  process.stderr.write(`[relay] in-process relay listening on ws://127.0.0.1:${port}\n`);
  logBuffers.relay.info(`relay listening on ws://127.0.0.1:${port}`);
  await maybeStartWatchdog();
  await ensureSeedPubkeyWhitelisted();
}

// ── In-process Blossom (Phase C) ─────────────────────────────────────────
//
// Off by default. Two opt-in paths:
//   - STATION_INPROC_BLOSSOM=1 at boot
//   - POST /api/blossom/start from the dashboard
// Either path constructs a BlossomServer pointed at the same data dir
// (~/.nostr-station/data/blobs) and a port from STATION_INPROC_BLOSSOM_PORT
// (default 8081). Auth predicates read live state at request time so a
// freshly-added whitelist entry takes effect without a Blossom restart.

function shouldStartInprocBlossom(): boolean {
  // Env-var override takes precedence (useful for dev / CI / containers
  // that want to force the server on regardless of UI state). Otherwise
  // fall through to the persisted user preference in identity.json —
  // set when the user clicks Enable in Config → Blossom or the
  // Dashboard card. Matches how nvpn / app-relays remember their state.
  if (process.env.STATION_INPROC_BLOSSOM === '1') return true;
  try { return readIdentity().inprocBlossomEnabled === true; }
  catch { return false; }
}

async function startInprocBlossom(): Promise<void> {
  if (inprocBlossom) return;
  const { BlossomServer } = await import('../blossom/index.js');
  const port = Number(process.env.STATION_INPROC_BLOSSOM_PORT || '8081');
  const server = new BlossomServer({
    port, host: '127.0.0.1',
    predicates: {
      isOwner: (hex) => {
        try {
          const ident = readIdentity();
          if (!ident.npub) return false;
          return npubToHex(ident.npub).toLowerCase() === hex.toLowerCase();
        } catch { return false; }
      },
      isWhitelisted: (hex) => {
        if (!inprocRelay) return false;
        try { return inprocRelay.whitelist.has(hex.toLowerCase()); }
        catch { return false; }
      },
      // Test-identity classification walks every project's
      // test-identities.json on each call so freshly-added keys are
      // recognized without a Blossom restart. The list is single-digit
      // bounded in any real install, so the per-request cost is in the
      // noise.
      isTestIdentity: (hex) => {
        try {
          const list = listAllTestPubkeys(readProjects());
          return list.some(e => e.pubkey.toLowerCase() === hex.toLowerCase());
        } catch { return false; }
      },
    },
    onLog: (level, text) => logBuffers.relay.push(level, `[blossom] ${text}`),
  });
  await server.start();
  inprocBlossom = server;
  setInprocBlossomPort(port);
  process.stderr.write(`[blossom] in-process blossom listening on http://127.0.0.1:${port}\n`);
}

async function stopInprocBlossom(): Promise<void> {
  if (!inprocBlossom) return;
  await inprocBlossom.stop();
  inprocBlossom = null;
  setInprocBlossomPort(null);
}

async function maybeStartInprocBlossom(): Promise<void> {
  if (!shouldStartInprocBlossom()) return;
  await startInprocBlossom();
}

// User-initiated enable/disable. Wraps the pure lifecycle start/stop with
// the two side effects that matter for UX consistency:
//   1. Persist the on/off preference to identity.json so the choice
//      survives the next station restart (same pattern as appRelaysEnabled).
//   2. Invalidate the /api/status SWR cache so the sidebar Health row
//      reflects the new state on the next poll without waiting out the
//      cache TTL (3s). The relay action route does the same — see line
//      ~984 for the analogous invalidate after a relay start/stop.
async function enableInprocBlossomUserInitiated(): Promise<void> {
  await startInprocBlossom();
  try { setInprocBlossomEnabled(true); } catch {}
  cachedGatherStatus.invalidate();
}

async function disableInprocBlossomUserInitiated(): Promise<void> {
  await stopInprocBlossom();
  try { setInprocBlossomEnabled(false); } catch {}
  cachedGatherStatus.invalidate();
}

async function maybeStartWatchdog(): Promise<void> {
  if (process.env.STATION_DISABLE_WATCHDOG === '1') return;
  if (watchdog || !inprocRelay) return;
  // Persisted opt-out — Config → Watchdog flips this. Boot honors it so
  // a disabled watchdog stays disabled across restarts. The user-
  // initiated POST /api/watchdog/start path skips this gate via
  // startWatchdogUserInitiated below.
  if (readIdentity().watchdogEnabled === false) return;
  const wd = new Watchdog({
    relay: inprocRelay,
    onLog: (level, text) => logBuffers.watchdog.push(level, text),
  });
  try {
    await wd.start();
    watchdog = wd;
  } catch (e: any) {
    logBuffers.watchdog.error(`watchdog start failed: ${e?.message || e}`);
  }
}

// Same as maybeStartWatchdog but ignores the persisted opt-out — used by
// the explicit Enable button so flipping on via UI starts the worker AND
// persists the flag in one round-trip. Mirrors how the Blossom enable
// flow is split into boot-time vs. user-initiated paths.
async function startWatchdogUserInitiated(): Promise<void> {
  try { setWatchdogEnabled(true); } catch {}
  if (process.env.STATION_DISABLE_WATCHDOG === '1') return;
  if (watchdog || !inprocRelay) return;
  const wd = new Watchdog({
    relay: inprocRelay,
    onLog: (level, text) => logBuffers.watchdog.push(level, text),
  });
  await wd.start();
  watchdog = wd;
}

function stopWatchdogUserInitiated(): void {
  if (watchdog) {
    watchdog.stop();
    watchdog = null;
  }
  try { setWatchdogEnabled(false); } catch {}
}

// Ensure the `seed-nsec` keychain slot exists and its pubkey is registered
// in the relay's whitelist. The seed CLI (src/commands/Seed.tsx) runs as a
// subprocess of this server and can't reach into the in-process relay's
// in-memory whitelist itself, so we pre-register here. Mirrors the
// watchdog's auto-whitelist pattern (src/lib/watchdog.ts: relay.whitelist.add).
// First call generates + stores the nsec; subsequent calls reuse it.
async function ensureSeedPubkeyWhitelisted(): Promise<void> {
  if (!inprocRelay) return;
  try {
    const kc = getKeychain();
    let stored = await kc.retrieve('seed-nsec');
    if (!stored || !stored.startsWith('nsec')) {
      const fresh = generateSecretKey();
      stored = nip19.nsecEncode(fresh);
      await kc.store('seed-nsec', stored);
    }
    const decoded = nip19.decode(stored);
    if (decoded.type !== 'nsec') return;
    const pubHex = getPublicKey(decoded.data as Uint8Array);
    const added = inprocRelay.whitelist.add(pubHex);
    if (added) logBuffers.relay.info(`whitelist: added seed pubkey ${nip19.npubEncode(pubHex)}`);
  } catch (e: any) {
    logBuffers.relay.warn(`seed pubkey whitelist registration failed: ${e?.message || e}`);
  }
}

export async function startWebServer(port: number): Promise<http.Server> {
  // Sessions are in-memory authoritative, but a one-click "Update" exits
  // the process with code 75 so the wrapper script (bin/nostr-station.sh)
  // can respawn it on the new build. To make that round-trip invisible
  // to the user, we snapshot live sessions to ~/.config/nostr-station/
  // sessions.json on the way down and restore them on the way up. The
  // snapshot is single-use (deleted at load time) so a kill -9 can't
  // replay tokens later.
  loadSessions();

  // Deferred warm-up tasks. Everything here used to run BEFORE
  // `server.listen()` with `await` — a fresh Linux box with no seeded
  // GNOME keyring would hang on `secret-tool lookup` inside
  // loadProviderConfig (waits for an unlock prompt that never comes),
  // leaving the server unbound and `curl localhost:3000` refused.
  //
  // Run these AFTER the socket is bound so the dashboard starts no matter
  // what the keychain / node-pty / ai-config state is. Per-request handlers
  // already re-load loadProviderConfig(), so missing the warm-up costs at
  // most one cold-path lookup on the first chat request.
  const warmUp = () => {
    loadProviderConfig().catch(() => {});
    loadPty().catch(() => {});
    // Idempotent: writes the slim Nori-persona seed when missing,
    // leaves any existing file (and its user-region edits) alone.
    try { seedStationContext(); }
    catch (e: any) { process.stderr.write(`[context] seed skipped: ${e?.message || e}\n`); }
    migrateIfNeeded()
      .then(r => {
        if (r.migrated) {
          const bits: string[] = [];
          if (r.from) bits.push(`chat ← ${r.from.provider}`);
          if (r.terminalEnabled?.length) bits.push(`terminal ← ${r.terminalEnabled.join(',')}`);
          process.stderr.write(`[ai-config] migrated (${bits.join('; ') || 'empty'})\n`);
        }
      })
      .catch(e => process.stderr.write(`[ai-config] migration failed: ${e?.message || e}\n`));
    // Phase 6-tidy: GC stale scratch checkouts from
    // ~/.nostr-station/scratch/. Best-effort, runs once per server
    // boot; never throws (any per-entry error is captured in the
    // returned summary and logged). 7-day TTL by default — see
    // src/lib/scratch-gc.ts.
    try {
      const gc = runScratchGc();
      if (gc.removed.length > 0 || gc.errors.length > 0) {
        process.stderr.write(
          `[scratch-gc] removed=${gc.removed.length} projects-removed=${gc.projectsRemoved.length} errors=${gc.errors.length}\n`,
        );
      }
    } catch (e: any) {
      process.stderr.write(`[scratch-gc] skipped: ${e?.message || e}\n`);
    }
  };

  // Loopback host:port variants we accept for Host / Origin / Referer.
  // Anything else in these headers is either a misconfigured proxy or an
  // active attack (DNS rebinding, cross-origin page trying to talk to us).
  const allowedHosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  const isLoopbackUrl = (u: string | undefined | null): boolean => {
    if (!u) return false;
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'ws:') return false;
      if (parsed.port !== String(port)) return false;
      const h = parsed.hostname;
      return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
    } catch { return false; }
  };
  // Re-verify a non-loopback remote socket maps to a trusted mesh device
  // pubkey — the authoritative gate (dashboard-binding's connection filter can
  // race the HTTP parse) that lets the loopback Host/Origin checks relax for
  // Mobile-Access (mesh tunnel) connections. Shared by the HTTP request handler
  // (H1/H2) AND the terminal WebSocket upgrade so the two can never drift. Fail
  // closed: loopback short-circuits to false, any error → not trusted.
  const computeMeshTrusted = async (remoteAddr: string | undefined | null): Promise<boolean> => {
    if (!remoteAddr || isLoopbackAddress(remoteAddr)) return false;
    try {
      const peers = ((await probeNvpnStatus()).raw as Record<string, unknown> | null)?.peers ?? null;
      return allowDashboardConnection({
        remoteAddress: remoteAddr, nvpnPeers: peers, trusted: trustedDevicePubkeys(),
      }).ok;
    } catch { return false; }
  };
  // Per-nsite-origin host pattern: <16hex>.nsite.localhost:<port>.
  //
  // Why this exists: nsites used to render inside an iframe served from the
  // dashboard's same origin under /nsite-content/<siteId>/ + a sandbox
  // without `allow-same-origin`. That gave the iframe an opaque (`null`)
  // origin, which broke:
  //   - ES module CORS (fixed in #118 with ACAO `*`)
  //   - `crypto.subtle` (secure-context-only → bundles fell back to esm.sh)
  //   - localStorage / IndexedDB (throw in null origin)
  //   - WebSocket `Origin: null` (some relays reject)
  //   - cross-frame navigation back to the same URL (SOP blocks "null →
  //     localhost" loads even though the URLs are identical)
  //
  // Titan Browser sidesteps all of these by giving each nsite its OWN
  // origin via a custom `nsite-content://` scheme. We approximate it on
  // the web by serving each nsite from its own *.nsite.localhost
  // subdomain. Browsers resolve *.localhost to 127.0.0.1 per RFC 6761
  // and treat it as a Secure Context, so:
  //   - Each siteId is a real, distinct browser origin.
  //   - `crypto.subtle` is defined → bundles don't fall back to esm.sh.
  //   - `localStorage` / IDB have their own per-origin bucket.
  //   - WebSocket sends `Origin: http://<siteId>.nsite.localhost:<port>`
  //     (a real origin, not `null`).
  //   - The iframe can keep `allow-same-origin` in its sandbox because
  //     SOP still isolates it from the dashboard (subdomain ≠ root).
  //
  // The Host header is required to match this regex exactly — siteIds
  // are 16 hex chars (8 bytes from randomBytes), the literal
  // `nsite.localhost` suffix, and the same port we listen on. Anything
  // else falls through to the regular allowedHosts gate.
  const NSITE_HOST = new RegExp(`^([0-9a-f]{16})\\.nsite\\.localhost:${port}$`);
  const parseNsiteHost = (host: string): string | null => {
    const m = host.match(NSITE_HOST);
    return m ? m[1] : null;
  };

  return new Promise<http.Server>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url    = (req.url || '/').split('?')[0];
      // The inline route checks below (e.g. `if (url === '/api/auth/status')`)
      // expect `url` to be path-only. But the EXTRACTED route handlers
      // (handleRepo / handlePatches / handleIssues / handleStatus / etc.)
      // do `new URL(url, 'http://localhost').searchParams.get(...)` and
      // need the query string preserved. Pass `fullUrl` to those handlers
      // so query params survive — without this, every query-dependent
      // endpoint (e.g. /patches/.../diff?patchId=, /comments?rootId=,
      // /status?rootIds=) silently sees empty strings for its params,
      // which manifests as "invalid X" 400s for valid input.
      const fullUrl = req.url || '/';
      const method = req.method || 'GET';

      // ── H1: Reject non-loopback Host headers ──────────────────────────
      // Without this check, a DNS-rebinding attacker (evil.com resolving to
      // 127.0.0.1:<port>) can reach the dispatcher and have NIP-98 events
      // signed against a forged `u` tag. Since the dashboard only ever
      // listens on loopback, any other Host value is either a
      // misconfiguration or an attack — either way, refuse.
      // nostr-station binds to loopback and expects no reverse proxy. We do
      // NOT honor `x-forwarded-host`, `x-forwarded-for`, `x-forwarded-proto`,
      // or RFC 7239 `forwarded` anywhere — the rebinding defense and every
      // security-relevant URL (NIP-98 `u`-tag at auth.ts:481) are derived
      // from the bound port, never from these attacker-controlled headers.
      // If reverse-proxy support is added later, re-audit before reading any
      // of them.
      const hostHeader = String(req.headers['host'] || '').toLowerCase();

      // ── Mesh-trust: is this request from a trusted mesh peer? ──────────
      // The dashboard binds to 0.0.0.0 in Mobile Access mode; the
      // connection-time pubkey filter (dashboard-binding.ts) destroys
      // untrusted non-loopback sockets. But the async filter can race the
      // HTTP parse, so we make the HTTP layer AUTHORITATIVE here: re-verify
      // the remote IP maps to a trusted device pubkey (same verdict logic),
      // and only then relax the loopback Host/Origin gates — pinned to the
      // ACTUAL local interface address so a trusted peer still can't inject
      // a foreign Host (rebinding) or cross-origin Origin (CSRF). Fail
      // closed: any error → not trusted → loopback-only (view-only).
      const remoteAddr = req.socket.remoteAddress;
      const localAddr  = req.socket.localAddress;
      const meshTrusted = await computeMeshTrusted(remoteAddr);
      const meshHostOk = meshTrusted && meshHostMatches(hostHeader, localAddr, port);

      // ── H1a: Nsite per-origin subdomain dispatch ──────────────────────
      // *.nsite.localhost subdomains resolve to 127.0.0.1 client-side
      // (RFC 6761) and reach our loopback socket the same as `localhost`,
      // so they're loopback-safe. They get a deliberately narrow surface:
      // ONLY nsite content paths are served (file lookup against the
      // siteId frozen in the Host header). The dashboard API (`/api/*`),
      // auth endpoints, terminal/WS upgrade, project tooling, etc. are
      // 404'd on this origin so a compromised or hostile nsite payload
      // (rendered in a sibling browser context) can't probe them.
      //
      // The Bearer auth gate also doesn't apply here — the nsite origin
      // has its own (empty) localStorage and never has the dashboard's
      // session token. Permissive on read is intentional: blobs are
      // content-addressed Blossom bytes anyone can already fetch from
      // upstream.
      const nsiteSid = parseNsiteHost(hostHeader);
      if (nsiteSid) {
        // Refuse anything that looks like a probe of the dashboard's
        // private surface from the nsite origin.
        if (url.startsWith('/api/') ||
            url.startsWith('/.well-known/') ||
            url === '/__terminal' ||
            url.startsWith('/__')) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not exposed on nsite subdomain');
          return;
        }
        // Path-only URL → file lookup inside the snapshot keyed by sid.
        await handleNsiteSubdomain(req, res, nsiteSid, url);
        return;
      }

      if (!allowedHosts.has(hostHeader) && !meshHostOk) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('bad host');
        return;
      }

      // ── H2: CSRF — require loopback Origin/Referer on mutations ───────
      // `localhostExempt` (auth.ts) deliberately drops session checks for
      // localhost during the wizard and when the user sets requireAuth:false.
      // That window is exploitable from any tab open in the same browser
      // unless we also verify the request actually came from our own origin.
      // Applies to all state-changing methods; missing both headers is
      // treated as hostile (browsers always send at least Referer on a
      // form/fetch POST to a different origin; CLI clients can opt in by
      // passing -H "Origin: http://127.0.0.1:<port>").
      const isMutation = method === 'POST' || method === 'PATCH' || method === 'DELETE'
                       || method === 'PUT';
      if (isMutation) {
        const origin  = typeof req.headers.origin  === 'string' ? req.headers.origin  : '';
        const referer = typeof req.headers.referer === 'string' ? req.headers.referer : '';
        // Loopback OR a trusted-mesh same-origin (Origin/Referer pinned to
        // the local interface). A cross-origin page (e.g. DNS-rebinding from
        // evil.com) fails this even on a trusted connection — its Origin
        // won't equal the tunnel-IP interface.
        const ok = isLoopbackUrl(origin) || isLoopbackUrl(referer)
                || (meshTrusted && (meshUrlMatches(origin, localAddr, port) || meshUrlMatches(referer, localAddr, port)));
        if (!ok) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('bad origin');
          return;
        }
      }

      // Token-fallback paths (EventSource, WebSocket upgrade handshake,
      // `<a download>`) carry the session token in the query string because
      // browsers can't set Authorization on those APIs. That's safe on
      // loopback, but only IF the request also originates from our origin —
      // otherwise a cross-origin EventSource to /api/logs?token=… would
      // happily stream subprocess output into an attacker page.
      if (method === 'GET' && /[?&]token=[a-f0-9]{64}(?:&|$)/.test(req.url || '')) {
        const origin  = typeof req.headers.origin  === 'string' ? req.headers.origin  : '';
        const referer = typeof req.headers.referer === 'string' ? req.headers.referer : '';
        const ok = isLoopbackUrl(origin) || isLoopbackUrl(referer)
                || (meshTrusted && (meshUrlMatches(origin, localAddr, port) || meshUrlMatches(referer, localAddr, port)));
        if (!ok) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('bad origin');
          return;
        }
      }

      // ── Auth endpoints (public) ──────────────────────────────────────
      if (url === '/api/auth/status' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(authStatus(req)));
        return;
      }

      if (url === '/api/auth/challenge' && method === 'POST') {
        // Return the URL the server will require in the signed event's `u`
        // tag so NIP-07 clients sign against the canonical loopback origin,
        // not whichever hostname the browser happens to be visiting
        // (`localhost` vs `127.0.0.1` vs `[::1]` all map to the same socket).
        const c = issueChallenge();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...c, expectedUrl: expectedDashboardUrl(req, port) }));
        return;
      }

      if (url === '/api/auth/verify' && method === 'POST') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'bad json' })); return; }
        const challenge = String(parsed.challenge || '');
        const event     = parsed.event;

        if (!consumeChallenge(challenge)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'challenge unknown or expired' }));
          return;
        }
        const r = verifyNip98({
          challenge, event,
          expectedUrl: expectedDashboardUrl(req, port),
        });
        if (!r.ok) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: r.error || 'verification failed' }));
          return;
        }
        const ua = String(req.headers['user-agent'] || '').slice(0, 200);
        const sess = createSession(r.npub!, ua);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          token: sess.token, expiresAt: sess.expiresAt, npub: sess.npub,
        }));
        return;
      }

      if (url === '/api/auth/bunker-connect' && method === 'POST') {
        // Tries silent re-auth first (saved bunker client from a previous
        // sign-in). If that succeeds, Amber gives the user a push-and-tap
        // approval flow and we return a session token directly — no QR,
        // no "delete old bunker" shuffle. If there's no saved client, or
        // the saved one is dead (user revoked, bunker offline, relays
        // changed), we fall through to the QR flow. silentBunkerSign()
        // clears stale saved state on its own, so a one-time failure
        // doesn't get stuck retrying.
        const { challenge } = issueChallenge();

        const silent = await silentBunkerSign(challenge, expectedDashboardUrl(req, port));
        if (silent.ok && silent.signedEvent) {
          const verify = verifyNip98({
            challenge, event: silent.signedEvent,
            expectedUrl: expectedDashboardUrl(req, port),
          });
          if (verify.ok) {
            const ua = String(req.headers['user-agent'] || '').slice(0, 200);
            const sess = createSession(verify.npub!, ua);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              mode: 'silent-ok',
              token: sess.token, expiresAt: sess.expiresAt, npub: sess.npub,
            }));
            return;
          }
          // Signed event failed verification — fall through to QR. This
          // is a near-impossible path (the bunker returned a validly
          // shaped event that still doesn't match our challenge / url),
          // but we'd rather give the user a working QR than a 401 dead end.
        }

        const start = await startNostrConnect(challenge, expectedDashboardUrl(req, port));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mode: 'qr', ...start, challenge }));
        return;
      }

      const bunkerPollMatch = url.match(/^\/api\/auth\/bunker-session\/([0-9a-f]{64})$/);
      if (bunkerPollMatch && method === 'GET') {
        const eph = bunkerPollMatch[1];
        const s   = getBunkerSession(eph);
        if (!s) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: 'unknown session' }));
          return;
        }
        if (s.status === 'waiting') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'waiting', expiresAt: s.expiresAt }));
          return;
        }
        if (s.status !== 'ok' || !s.signedEvent || !s.challenge) {
          consumeBunkerSession(eph);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: s.status, error: s.error }));
          return;
        }
        // Success path — validate the signed event, then issue a session.
        const verify = verifyNip98({
          challenge:   s.challenge,
          event:       s.signedEvent,
          expectedUrl: expectedDashboardUrl(req, port),
        });
        consumeBunkerSession(eph);
        if (!verify.ok) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: verify.error || 'verification failed' }));
          return;
        }
        const ua = String(req.headers['user-agent'] || '').slice(0, 200);
        const sess = createSession(verify.npub!, ua);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          token: sess.token, expiresAt: sess.expiresAt, npub: sess.npub,
        }));
        return;
      }

      if (url === '/api/auth/bunker-url' && method === 'POST') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'bad json' })); return; }
        const bunkerUrl = String(parsed.bunkerUrl || '').trim();
        if (!/^bunker:\/\//i.test(bunkerUrl)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bunker URL must start with bunker://' }));
          return;
        }
        const { challenge } = issueChallenge();
        const bunkerRes = await signWithBunkerUrl(bunkerUrl, challenge, expectedDashboardUrl(req, port));
        if (!bunkerRes.ok) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: bunkerRes.error || 'bunker sign failed' }));
          return;
        }
        const verify = verifyNip98({
          challenge, event: bunkerRes.signedEvent,
          expectedUrl: expectedDashboardUrl(req, port),
        });
        if (!verify.ok) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: verify.error || 'verification failed' }));
          return;
        }
        const ua = String(req.headers['user-agent'] || '').slice(0, 200);
        const sess = createSession(verify.npub!, ua);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          token: sess.token, expiresAt: sess.expiresAt, npub: sess.npub,
        }));
        return;
      }

      if (url === '/api/auth/logout' && method === 'POST') {
        const token = extractBearer(req);
        if (token) deleteSession(token);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /api/auth/download-token — mint a short-lived single-use
      // token for <a target="_blank"> / <a download> URLs (currently
      // just mail attachments). The dashboard's session token is too
      // long-lived to safely embed in URLs that enter browser history.
      // See auth.ts issueDownloadToken / consumeDownloadToken.
      //
      // When the dashboard is in the localhost-exempt mode (wizard
      // phase OR requireAuth:false), requireSession() returns a
      // synthetic session token of 'localhost-exempt' that doesn't
      // live in the sessions Map. In that mode the user's downloads
      // also don't need a token — the localhost-exempt path will
      // re-authorize them on arrival. Return mode:'unauthenticated'
      // so the client opens the URL bare.
      if (url === '/api/auth/download-token' && method === 'POST') {
        const session = requireSession(req, res);
        if (!session) return;
        if (session.token === 'localhost-exempt') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ mode: 'unauthenticated' }));
          return;
        }
        const tok = extractBearer(req);
        const dt  = tok ? issueDownloadToken(tok) : null;
        if (!dt) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'session no longer valid' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(dt));
        return;
      }

      if (url === '/api/auth/session' && method === 'GET') {
        const sess = requireSession(req, res);
        if (!sess) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          npub: sess.npub, createdAt: sess.createdAt, expiresAt: sess.expiresAt,
        }));
        return;
      }

      // ── One-click update (driven by bin/nostr-station.sh wrapper) ────
      // GET /api/update-status returns the cached poll result so the UI
      // can render the "Update available" pill without hitting GitHub
      // itself. POST /api/update streams the fast-forward + npm install
      // + build via SSE, then exits with code 75 so the wrapper respawns.
      // POST /api/update-status/refresh kicks an immediate re-poll
      // (used right after the user clicks the pill in case it's stale).
      if (url === '/api/update-status' && method === 'GET') {
        if (!requireSession(req, res)) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getUpdateStatus()));
        return;
      }
      if (url === '/api/update-status/refresh' && method === 'POST') {
        if (!requireSession(req, res)) return;
        void refreshUpdateStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url === '/api/update' && method === 'POST') {
        if (!requireSession(req, res)) return;
        streamApplyUpdate(req, res);
        return;
      }

      // GET /api/tools/updates returns the per-pinned-binary update list
      // (nak / ngit / nvpn). The browser's Updates module merges this
      // with /api/update-status so the modal renders self-update commits
      // and tool upgrades side-by-side, behind one Install button.
      // Probes are sub-second on a normal box (three spawn-and-parse
      // operations in parallel); no caching for now — called once per
      // pill check, not on a hot path.
      if (url === '/api/tools/updates' && method === 'GET') {
        if (!requireSession(req, res)) return;
        try {
          const tools = await gatherToolUpdates();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ tools }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ tools: [], error: String(e?.message || e) }));
        }
        return;
      }

      // ── Gate everything else under /api/* ────────────────────────────
      // Public paths (auth endpoints above) are already handled via early
      // returns. Any other /api/* path requires a valid session token, or
      // the identity.json requireAuth:false localhost exemption.
      //
      // Bootstrap exemption: /api/identity/set is accepted without auth
      // only when no station owner is configured yet. This lets the auth
      // screen set up an npub before anyone can sign in. Once an owner
      // exists, all identity writes require a valid session.
      if (url.startsWith('/api/') && !isPublicApi(url)) {
        const bootstrap = url === '/api/identity/set'
          && method === 'POST'
          && !readIdentity().npub;
        if (!bootstrap && !requireSession(req, res)) return;
      }

      // API routes first — they take precedence over static.
      if (url === '/api/config' && method === 'GET') {
        const { meta } = await loadProviderConfig();
        const scope = /[?&]scope=global(?:&|$)/.test(req.url || '') ? 'global' : 'active';
        const ctx = getContextStatus(scope);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          provider:       meta.provider,
          model:          meta.model,
          baseUrl:        meta.baseUrl,
          configured:     meta.configured,
          reason:         meta.reason,
          hasContext:     ctx.hasContext,
          contextSource:  ctx.source,
          contextProject: ctx.projectName ?? null,
          hasContextFile: ctx.hasContextFile,
        }));
        return;
      }

      // ── Station context (user-editable always-on overlay) ──────────────
      // The Config panel reads this to render the editor textarea, and
      // writes back when the user saves. Content is the full file body
      // including the persona/seed text — `readStationContext()` (used
      // by the chat path) splices only the user-region into prompts.
      if (url === '/api/station-context' && method === 'GET') {
        const filePath = stationContextPath();
        let raw = '';
        let exists = false;
        try {
          raw = fs.readFileSync(filePath, 'utf8');
          exists = true;
        } catch { /* file may not be seeded yet; return empty */ }
        const hasMarkers = raw.includes(USER_REGION_BEGIN) && raw.includes(USER_REGION_END);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          path:           filePath,
          content:        raw,
          exists,
          hasMarkers,
          userRegionBegin: USER_REGION_BEGIN,
          userRegionEnd:   USER_REGION_END,
          // Effective overlay actually injected into prompts. null when
          // there are no user notes — the Config UI uses this to label
          // "no notes yet" vs "X bytes spliced in".
          effectiveOverlay: readStationContext(),
        }));
        return;
      }

      if (url === '/api/station-context' && method === 'PUT') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad json' }));
          return;
        }
        const content = typeof parsed.content === 'string' ? parsed.content : null;
        if (content === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'content (string) required' }));
          return;
        }
        // 256 KB cap matches the read_file tool — large enough for any
        // realistic note set, small enough to refuse runaway pastes.
        if (content.length > 256 * 1024) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'content too large (>256KB)' }));
          return;
        }
        const filePath = stationContextPath();
        try {
          atomicWriteText(filePath, content, { mode: 0o644 });
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message || 'write failed' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: filePath, bytes: Buffer.byteLength(content) }));
        return;
      }

      if (url === '/api/chat' && method === 'POST') {
        const { cfg, meta } = await loadProviderConfig();
        if (!cfg) {
          res.writeHead(200, {
            'Content-Type':  'text/event-stream',
            'Cache-Control': 'no-cache',
          });
          res.write(`data: ${JSON.stringify({ error: meta.reason || 'AI provider not configured' })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        await proxyChat(req, res, cfg);
        return;
      }

      // Image proxy — fetches an external https URL server-side and
      // streams the bytes back through the dashboard origin. The
      // dashboard's CSP after this PR is `img-src 'self' data:`, so
      // every external avatar / inline image must route through here.
      // See src/lib/img-proxy.ts for size limits / content-type
      // allowlist / cache behavior.
      if (url === '/api/img-proxy' && method === 'GET') {
        await handleImgProxy(req, res);
        return;
      }

      // Session-authed batch signer for proxy URLs that the browser
      // discovers at render time — primarily markdown image hrefs
      // extracted from kind-30023 articles, README files, comment
      // bodies, etc. The dashboard pre-signs profile pictures /
      // banners at JSON-emission time, so
      // this endpoint exists for the residual surface where the URL
      // isn't known until the browser parses content. Session-gated
      // because the auth middleware ran above (`/api/img-proxy/sign`
      // is NOT in PUBLIC_API_PREFIXES). XSS-in-session can still call
      // this — see src/lib/img-proxy-sign.ts threat-model comment for
      // the documented residual.
      if (url === '/api/img-proxy/sign' && method === 'POST') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'bad json' })); return; }
        const inputs: unknown = parsed?.urls;
        if (!Array.isArray(inputs)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'urls: array required' }));
          return;
        }
        // Cap per-call so a misbehaving client can't ask us to sign
        // thousands of URLs in one shot. Real markdown renders carry
        // a handful of images per body; 64 covers worst-case README
        // pages comfortably.
        if (inputs.length > 64) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'too many urls (max 64)' }));
          return;
        }
        const signed: Record<string, string | null> = {};
        for (const raw of inputs) {
          if (typeof raw !== 'string') continue;
          signed[raw] = signProxyUrl(raw);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ signed }));
        return;
      }

      if (url === '/api/status' && method === 'GET') {
        const rows = await cachedGatherStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows));
        return;
      }

      // ── Relay config (read-only stub) ─────────────────────────────────
      // The Config panel does a Promise.all over seven endpoints at boot
      // (app.js:4910). One 404 collapses the entire panel to "failed to
      // load", so this stub exists to unblock Config UI rendering even
      // before the real settings store / NIP-42 / whitelist enforcement
      // land. Fields:
      //   name/url/dataDir/configPath — describe the in-process relay
      //   auth/dmAuth — placeholder false; real toggles wire up in 1.7
      //   whitelist — empty array; populated by 1.6 once the store exists
      //   knownRoles — owner npub from identity.json, plus best-effort
      //     watchdog/seed npubs derived from keychain nsec slots so the
      //     whitelist editor can label entries by role.
      // ── Relay whitelist add/remove ────────────────────────────────────
      // Mutates the in-process relay's whitelist, persisted next to
      // relay.db. The Relay panel posts npub strings (app.js:1980, 2003);
      // we decode to hex for storage so the relay's handleEvent gating
      // path (1.6c) compares apples to apples — sigs verify against hex
      // pubkeys, not bech32. `already`/`absent` short-circuit responses
      // mirror the original endpoint shape so the panel's toast copy
      // ("npub already on whitelist") still works.
      if (url === '/api/relay/whitelist/add' && method === 'POST') {
        if (!inprocRelay) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'relay is not running' }));
          return;
        }
        let body: { npub?: string };
        try { body = JSON.parse(await readBody(req)); }
        catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
          return;
        }
        const input = String(body?.npub || '').trim();
        let hex: string;
        try {
          hex = input.startsWith('npub') ? npubToHex(input) : input;
          if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('not a valid pubkey');
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e?.message || 'invalid pubkey') }));
          return;
        }
        const added = inprocRelay.whitelist.add(hex);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, hex, already: !added }));
        return;
      }

      if (url === '/api/relay/whitelist/remove' && method === 'POST') {
        if (!inprocRelay) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'relay is not running' }));
          return;
        }
        let body: { npub?: string };
        try { body = JSON.parse(await readBody(req)); }
        catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
          return;
        }
        const input = String(body?.npub || '').trim();
        let hex: string;
        try {
          hex = input.startsWith('npub') ? npubToHex(input) : input;
          if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('not a valid pubkey');
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e?.message || 'invalid pubkey') }));
          return;
        }
        const removed = inprocRelay.whitelist.remove(hex);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, hex, absent: !removed }));
        return;
      }

      // ── Relay lifecycle ───────────────────────────────────────────────
      // start/stop/restart the in-process relay from the Relay panel
      // (app.js:1925). Pre-architectural-simplification this drove
      // launchctl/systemctl on a separate nostr-rs-relay daemon; now it
      // operates on the in-process Relay handle directly. STATION_INPROC_RELAY=0
      // is an opt-out: maybeStartInprocRelay no-ops in that case, so a
      // user who explicitly disabled the embedded relay sees a successful
      // {up:false} response rather than a confusing error.
      const relayActionMatch = url.match(/^\/api\/relay\/(start|stop|restart)$/);
      if (relayActionMatch && method === 'POST') {
        const action = relayActionMatch[1];
        try {
          if (action === 'stop' || action === 'restart') {
            if (inprocRelay) {
              await inprocRelay.stop();
              inprocRelay = null;
              setInprocRelayPort(null);
              setWhitelistRef(null);
              setLocalStore(null);
            }
          }
          if (action === 'start' || action === 'restart') {
            await maybeStartInprocRelay();
          }
          // Drop the /api/status cache so the next Status panel poll
          // sees the post-action world (relay row flips immediately).
          cachedGatherStatus.invalidate();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, action, up: inprocRelay !== null }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, action, error: String(e?.message || e) }));
        }
        return;
      }

      // ── Relay sqlite DB export ────────────────────────────────────────
      // Dumps every event in the store as one JSON object per line into
      // ~/nostr-exports/relay-events-<stamp>.jsonl. Drives Relay panel's
      // export button (app.js:2069). Streams via EventStore.iterAll() so
      // a large store doesn't blow up memory; sync write loop is fine
      // here because better-sqlite3 is sync anyway and the route blocks
      // until done. Pre-deletion this shelled to `nak req`; the new path
      // hits the store directly and removes the nak-on-PATH dependency.
      if (url === '/api/relay/database/export' && method === 'POST') {
        if (!inprocRelay) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'relay is not running' }));
          return;
        }
        try {
          const exportDir = path.join(os.homedir(), 'nostr-exports');
          fs.mkdirSync(exportDir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const filePath = path.join(exportDir, `relay-events-${stamp}.jsonl`);
          const fd = fs.openSync(filePath, 'w');
          let count = 0;
          try {
            for (const ev of inprocRelay.store.iterAll()) {
              fs.writeSync(fd, JSON.stringify(ev) + '\n');
              count++;
            }
          } finally {
            fs.closeSync(fd);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, file: filePath, count }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
        }
        return;
      }

      // ── Relay sqlite DB wipe ──────────────────────────────────────────
      // Empties the relay's event store. Triggered by Relay panel's
      // danger-zone wipe button (app.js:2038). No service restart needed:
      // EventStore lives inside the dashboard process, the relay just
      // keeps serving once the table is empty. VACUUM (in EventStore.wipe)
      // shrinks the on-disk file so /api/relay/database/stats reports the
      // expected zero immediately.
      if (url === '/api/relay/database/wipe' && method === 'POST') {
        if (!inprocRelay) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'relay is not running' }));
          return;
        }
        try {
          inprocRelay.store.wipe();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
        }
        return;
      }

      // ── Relay content search (FTS5) ───────────────────────────────────
      // GET /api/relay/search?q=<text>&kinds=1,7&limit=50
      //
      // Surfaces EventStore.search() to the Relay panel's search box.
      // Returns matching events ordered by FTS rank. The relay must be
      // running — search has no meaning offline since the corpus lives
      // in the local DB. Errors from malformed FTS5 syntax come back as
      // 400 so the UI can hint at proper quoting.
      if (url.startsWith('/api/relay/search') && method === 'GET') {
        if (!inprocRelay) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'relay is not running' }));
          return;
        }
        const u = new URL(url, 'http://localhost');
        const q = (u.searchParams.get('q') || '').trim();
        if (!q) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ events: [], total: 0 }));
          return;
        }
        const kinds = (u.searchParams.get('kinds') || '')
          .split(',').map(s => parseInt(s, 10)).filter(n => Number.isFinite(n));
        const limit = Math.max(1, Math.min(parseInt(u.searchParams.get('limit') || '50', 10) || 50, 200));
        try {
          const events = inprocRelay.store.search(q, {
            kinds: kinds.length ? kinds : undefined,
            limit,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ events, total: events.length }));
        } catch (e: any) {
          // FTS5 throws on malformed MATCH expressions ("syntax error
          // near …") — pass that back so the user can adjust their query.
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
        }
        return;
      }

      // ── Relay sqlite DB stats ─────────────────────────────────────────
      // Used by the Relay panel's database section (app.js:1908). Sums the
      // sqlite main file plus its WAL/SHM sidecars so a relay under active
      // write load reports honestly. `exists:false` lets the UI show
      // "empty" instead of "0 B" when nothing's been stored yet.
      if (url === '/api/relay/database/stats' && method === 'GET') {
        const dbPath = DEFAULT_DB_PATH;
        let sizeBytes = 0;
        let exists = false;
        for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
          try {
            const st = fs.statSync(p);
            sizeBytes += st.size;
            if (p === dbPath) exists = true;
          } catch { /* missing sidecar — fine */ }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sizeBytes, exists, path: dbPath }));
        return;
      }

      if (url === '/api/relay-config' && method === 'GET') {
        const ident = readIdentity();
        const host = process.env.RELAY_HOST || '127.0.0.1';
        const port = process.env.RELAY_PORT || '7777';
        const [watchdogNpub, seedNpub] = await Promise.all([
          deriveKeychainNpub('watchdog-nsec'),
          deriveKeychainNpub('seed-nsec'),
        ]);
        // Whitelist is presented as npubs because that's what the Relay
        // panel renders. Storage is hex (matches sig verification); we
        // bech32-encode on the way out only.
        const whitelist = inprocRelay
          ? inprocRelay.whitelist.list().map(hex => hexToNpub(hex))
          : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          name:       'nostr-station',
          url:        `ws://${host}:${port}`,
          // Write gating is always on in this build: only the station
          // owner and whitelisted pubkeys can publish. The Config panel's
          // auth/dmAuth toggles are kept here for back-compat with the
          // existing render code, but they reflect the real (immutable)
          // state — not user-mutable settings. dmAuth is reserved for a
          // future read-gating layer; today reads are open to all.
          auth:       true,
          dmAuth:     false,
          gating:     {
            policy:        'owner+whitelist',
            mutable:       false,
            reason:        'in-process relay: NIP-42 write gating is always on',
            ownerKnown:    !!ident.npub,
            whitelistSize: whitelist.length,
          },
          whitelist,
          dataDir:    path.join(os.homedir(), '.nostr-station', 'data'),
          configPath: 'in-process — no config file',
          knownRoles: {
            station:  ident.npub || null,
            watchdog: watchdogNpub,
            seed:     seedNpub,
          },
        }));
        return;
      }

      // Accept POSTs to /api/relay-config but treat the toggles as
      // immutable: write gating is always on (1.6c) and there's no
      // dmAuth implementation to enable yet. Returns the same shape as
      // GET so the Config panel's saveRelayFlag (app.js:5683) gets a
      // 200 response and re-renders against truth instead of erroring.
      if (url === '/api/relay-config' && method === 'POST') {
        // Drain body so the client doesn't see a stalled connection;
        // we deliberately ignore its contents.
        try { await readBody(req); } catch { /* fine */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok:      true,
          auth:    true,
          dmAuth:  false,
          mutable: false,
          message: 'write gating is always on — manage access via the whitelist',
        }));
        return;
      }


      // ── nvpn installer ────────────────────────────────────────────────
      // Wizard renderVpn (app.js:7141) drives this endpoint. NDJSON wire
      // format — one JSON line per progress event. The installer itself
      // is in src/lib/nvpn-installer.ts; this handler just streams its
      // progress callbacks back to the browser.
      if (url === '/api/setup/nvpn/install' && method === 'POST') {
        // The Updates modal re-uses this endpoint when nvpn is already
        // installed but a newer version is pinned; `?force=1` tells the
        // installer to skip its "already installed" short-circuit.
        const force = new URL(fullUrl, 'http://localhost').searchParams.get('force') === '1';
        res.writeHead(200, {
          'Content-Type':      'application/x-ndjson',
          'Cache-Control':     'no-cache',
          'Connection':        'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        try {
          const result = await installNostrVpn((s) => {
            try { res.write(JSON.stringify({ type: 'progress', step: s }) + '\n'); } catch {}
          }, { force });
          res.write(JSON.stringify({
            type:   'done',
            ok:     result.ok,
            warn:   !!result.warn,
            detail: result.detail ?? '',
          }) + '\n');
        } catch (e: any) {
          res.write(JSON.stringify({
            type:   'done',
            ok:     false,
            detail: String(e?.message ?? e),
          }) + '\n');
        }
        res.end();
        return;
      }

      // ── Watchdog lifecycle + status ───────────────────────────────────
      // The in-Node watchdog publishes a kind-1 heartbeat to the local
      // relay on a recurring interval. Endpoints let the dashboard /
      // CLI start, stop, or inspect it explicitly — separate from the
      // relay's lifecycle (1.3) because some users may want the relay
      // up without the watchdog (or vice versa).
      if (url === '/api/watchdog/status' && method === 'GET') {
        // `enabled` reflects the persisted opt-in flag from identity.json
        // — distinct from `running`, which is the live timer state. The
        // Config panel renders Enable / Disable based on `enabled`; the
        // dashboard card uses `running` for the liveness pill.
        const enabled = readIdentity().watchdogEnabled !== false;
        const base = watchdog ? watchdog.status() : {
          running: false, lastHeartbeatAt: null, npub: null, intervalMs: 0,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...base, enabled }));
        return;
      }
      if (url === '/api/watchdog/start' && method === 'POST') {
        try {
          await startWatchdogUserInitiated();
          cachedGatherStatus.invalidate();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, status: watchdog?.status() ?? null }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
        }
        return;
      }
      if (url === '/api/watchdog/stop' && method === 'POST') {
        stopWatchdogUserInitiated();
        cachedGatherStatus.invalidate();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── Status panel install button ───────────────────────────────────
      // POST /api/exec/install/<slug> — drives the Status row "Install"
      // CTA (app.js:1255). Most slugs flow through installTool() from
      // src/lib/tools.ts (npm-global / manual installers). `nak` and
      // `ngit` each have their own GitHub-release-binary installer
      // (src/lib/{nak,ngit}-installer.ts) — both used to be cargo
      // entries, but install.sh deliberately doesn't ship Rust, so the
      // prereq check rejected every fresh-install user. Bigger flows
      // (nvpn) keep their own dedicated setup endpoint
      // (/api/setup/nvpn/install above).
      const installMatch = url.match(/^\/api\/exec\/install\/([a-z][a-z0-9-]*)$/);
      if (installMatch && method === 'POST') {
        const slug = installMatch[1];
        // ?force=1 (set by the Updates modal when re-installing a
        // pinned-binary tool to a newer version) bypasses the installer's
        // "already installed — skipping" short-circuit. Only honoured by
        // the nak / ngit branches below; installTool()-driven slugs
        // (npm-global, curl|bash) don't have an "already installed"
        // optimization to skip.
        const force = new URL(fullUrl, 'http://localhost').searchParams.get('force') === '1';
        res.writeHead(200, {
          'Content-Type':  'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection':    'keep-alive',
        });
        const emit = (p: object) => { try { res.write(`data: ${JSON.stringify(p)}\n\n`); } catch {} };

        // Custom installer slugs first.
        if (slug === 'nak') {
          try {
            const result = await installNak((line) => emit({ line, stream: 'stdout' }), { force });
            if (!result.ok && result.detail) {
              emit({ line: result.detail, stream: result.warn ? 'stdout' : 'stderr' });
            }
            // `warn:true` distinguishes the soft-fail case (download verified
            // but sudo cred cache empty, so the binary was NOT actually
            // installed) from a clean success. The Updates modal and the
            // Status-panel install both used to treat warn as a green
            // "install finished" — leaving the user with the pre-update
            // binary on PATH and the update pill coming right back.
            // `shadowPath` carries the PATH-shadow case's offending path
            // so the Updates modal can offer a one-click remove+retry.
            const isWarn = !result.ok && !!result.warn;
            emit({
              done: true,
              code: result.ok ? 0 : (isWarn ? 0 : 1),
              warn: isWarn,
              ...(result.shadowPath ? { shadowPath: result.shadowPath } : {}),
            });
          } catch (e: any) {
            emit({ line: String(e?.message || e), stream: 'stderr' });
            emit({ done: true, code: -1 });
          }
          // A newly-installed binary changes findBin(slug)'s answer, which
          // gatherStatus surfaces as the row's "installed" state. Drop the
          // SWR cache so the dashboard's post-install refreshHealth() poll
          // sees the new world instead of the pre-install snapshot.
          cachedGatherStatus.invalidate();
          try { res.end(); } catch {}
          return;
        }

        if (slug === 'ngit') {
          try {
            const result = await installNgit((line) => emit({ line, stream: 'stdout' }), { force });
            if (!result.ok && result.detail) {
              emit({ line: result.detail, stream: result.warn ? 'stdout' : 'stderr' });
            }
            // See nak branch above — warn flag + shadowPath drive the
            // Updates modal's warn rendering and one-click retry button.
            const isWarn = !result.ok && !!result.warn;
            emit({
              done: true,
              code: result.ok ? 0 : (isWarn ? 0 : 1),
              warn: isWarn,
              ...(result.shadowPath ? { shadowPath: result.shadowPath } : {}),
            });
          } catch (e: any) {
            emit({ line: String(e?.message || e), stream: 'stderr' });
            emit({ done: true, code: -1 });
          }
          cachedGatherStatus.invalidate();
          try { res.end(); } catch {}
          return;
        }

        if (slug === 'grain') {
          try {
            const result = await installGrain((line) => emit({ line, stream: 'stdout' }), { force });
            if (!result.ok && result.detail) {
              emit({ line: result.detail, stream: result.warn ? 'stdout' : 'stderr' });
            }
            emit({ done: true, code: result.ok ? 0 : (result.warn ? 0 : 1) });
          } catch (e: any) {
            emit({ line: String(e?.message || e), stream: 'stderr' });
            emit({ done: true, code: -1 });
          }
          cachedGatherStatus.invalidate();
          try { res.end(); } catch {}
          return;
        }

        const tool = getTool(slug);
        if (!tool) {
          const supported = ['nak', 'ngit', 'grain', ...Object.keys(TOOLS)].sort();
          emit({
            line:   `'${slug}' is not a known optional tool. Supported: ${supported.join(', ')}.`,
            stream: 'stderr',
          });
          emit({ done: true, code: 1 });
          try { res.end(); } catch {}
          return;
        }
        try {
          const result = await installTool(tool, (line) => emit({ line, stream: 'stdout' }));
          if (!result.ok && result.detail) {
            emit({ line: result.detail, stream: 'stderr' });
          }
          emit({ done: true, code: result.ok ? 0 : 1 });
        } catch (e: any) {
          emit({ line: String(e?.message || e), stream: 'stderr' });
          emit({ done: true, code: -1 });
        }
        cachedGatherStatus.invalidate();
        try { res.end(); } catch {}
        return;
      }

      // POST /api/exec/remove-shadow — backs the Updates modal's
      // "Remove shadow and retry" button. When verifyVersionOnPath
      // detects that PATH resolves to an older nak/ngit at e.g.
      // ~/.cargo/bin instead of the /usr/local/bin install target,
      // it returns the shadow path; the user can then one-click that
      // file out of existence (via this endpoint) and re-run the
      // install loop without leaving the modal.
      //
      // STRICT validation — this endpoint deletes a file in the
      // user's home directory. We refuse to touch anything that
      // isn't:
      //   1. Named exactly `<slug>` (no traversal, no rename tricks)
      //   2. Inside one of the user-owned shadow dirs from
      //      detect.ts:augmentedBinDirs (~/.cargo/bin, ~/.local/bin,
      //      ~/.opencode/bin, ~/.nostr-station/bin, /opt/homebrew/bin).
      //      System dirs (/usr/local/bin, /usr/bin, /bin) are NEVER
      //      removable — that's where our installer writes, and we
      //      don't want a malformed request to nuke our own binary.
      //   3. A regular file or symlink (not a dir, not a special).
      //   4. Not equal to the installer's destFile.
      if (url === '/api/exec/remove-shadow' && method === 'POST') {
        if (!requireSession(req, res)) return;
        // Slug → install destination. Mirrors the consts in
        // {nak,ngit}-installer.ts; kept here so the endpoint is a
        // self-contained validation surface.
        const DEST_FILES: Record<string, string> = {
          nak:  '/usr/local/bin/nak',
          ngit: '/usr/local/bin/ngit',
        };
        const home = os.homedir();
        const ALLOWED_DIRS = [
          path.join(home, '.cargo', 'bin'),
          path.join(home, '.local', 'bin'),
          path.join(home, '.opencode', 'bin'),
          path.join(home, '.nostr-station', 'bin'),
          '/opt/homebrew/bin',
        ];
        const reject = (status: number, error: string) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error }));
        };
        let body = '';
        try {
          for await (const chunk of req) body += chunk;
        } catch { return reject(400, 'request body read failed'); }
        let parsed: { slug?: string; path?: string };
        try { parsed = JSON.parse(body || '{}'); }
        catch { return reject(400, 'invalid JSON body'); }
        const slug = String(parsed.slug || '');
        const rawPath = String(parsed.path || '');
        if (!slug || !rawPath) return reject(400, 'slug and path are required');
        const destFile = DEST_FILES[slug];
        if (!destFile) return reject(400, `unsupported slug: ${slug}`);
        // Normalise — collapses `..`, resolves to absolute. After
        // this any traversal trickery in `path` is moot.
        const resolved = path.resolve(rawPath);
        if (path.basename(resolved) !== slug) {
          return reject(400, `path basename does not match slug (${slug})`);
        }
        if (resolved === destFile) {
          return reject(400, `refusing to remove the install destination ${destFile}`);
        }
        if (!ALLOWED_DIRS.includes(path.dirname(resolved))) {
          return reject(400, `path is not in an allowed shadow dir: ${path.dirname(resolved)}`);
        }
        // lstat (NOT stat) — we want to act on the symlink itself if
        // the shadow happens to be a symlink, not chase it to whatever
        // it points at. unlinkSync on a symlink removes the link;
        // on a regular file removes the file. Either is what we want.
        let st: fs.Stats;
        try { st = fs.lstatSync(resolved); }
        catch (e: any) { return reject(404, `path does not exist: ${(e?.message || '').slice(0, 120)}`); }
        if (!st.isFile() && !st.isSymbolicLink()) {
          return reject(400, 'path is not a regular file or symlink');
        }
        try { fs.unlinkSync(resolved); }
        catch (e: any) { return reject(500, `unlink failed: ${(e?.message || '').slice(0, 120)}`); }
        // Removing the shadow changes what findBin('<slug>') returns —
        // the cached status snapshot is now stale.
        cachedGatherStatus.invalidate();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, removed: resolved }));
        return;
      }

      // ── Logs panel SSE ────────────────────────────────────────────────
      // Single endpoint for all three channels (relay/watchdog/vpn). The
      // panel opens an EventSource per active tab and reconnects on tab
      // change (app.js:4864). Output frames per the original wire shape:
      //   data: { status: ServiceHealth }   — emitted on connect
      //   data: { lines: [LogLine, ...] }   — replay of buffered history,
      //                                       then one frame per new line
      //   data: { error: <string> }         — replaced by graceful close
      // EventSource cannot set Authorization, so the auth gate accepts
      // ?token=<bearer> via the existing extractBearer path; the per-route
      // guard above has already vetted the token by the time we land here.
      const logsMatch = url.match(/^\/api\/logs\/(relay|watchdog|vpn)$/);
      if (logsMatch && method === 'GET') {
        const channel = logsMatch[1] as 'relay' | 'watchdog' | 'vpn';
        const buf = logBuffers[channel];

        res.writeHead(200, {
          'Content-Type':  'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection':    'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        // Status frame matches the shape Logs panel's renderBanner /
        // renderMeta consume (app.js:4868). Per channel:
        //   relay     — running + log-buffer-backed
        //   watchdog  — running iff the in-Node watchdog is alive,
        //               carries watchdogNpub for the meta strip
        //   vpn       — pending until Phase 2.2 installer lands
        // vpn — probe the daemon directly so the banner reflects daemon
        // state, not just "is the tunnel up". Going through gatherStatus
        // collapsed everything below `state==='ok'` to running:false,
        // which flipped the banner to "stopped" whenever a healthy
        // daemon's status socket stalled briefly. probeNvpnStatus keeps
        // running and tunnelIp separate; vpnBannerRunningFor cross-checks
        // probeNvpnServiceStatus (systemd/launchd) when the direct probe
        // errored, so a slow socket on a healthy daemon doesn't lie
        // about whether the process is alive. The service probe is only
        // run on the failure path, so the happy case stays one shell-out.
        // The vpn LogBuffer is fed by startNvpnLogTail at boot — once
        // the daemon is up and writing to its log file, the panel
        // streams real lines. Until then a banner explains the gap.
        const computeVpnStatus = async () => {
          const direct = await probeNvpnStatus();
          const installed = direct.installed;
          const service = (installed && direct.error)
            ? await probeNvpnServiceStatus()
            : null;
          const running = vpnBannerRunningFor(direct, service);
          return {
            service:    'vpn',
            installed,
            running,
            logExists:  installed,
            logPath:    installed
              ? 'nvpn daemon log (auto-tailed)'
              : '(not installed)',
            stale:      false,
            logMtimeMs: Date.now(),
            note:       installed
              ? (running
                  ? (direct.tunnelIp ? `tunnel: ${direct.tunnelIp}` : 'running, no tunnel ip')
                  : 'not connected')
              : 'install via the setup wizard\'s vpn step',
            // Hint for the Logs panel renderMeta — shown as a copy-able
            // identity strip alongside the buffer. Mirrors the watchdog
            // tab's npub field.
            tunnelIp:   running ? direct.tunnelIp : null,
          };
        };

        const status = await (async () => {
          if (channel === 'relay') {
            return {
              service:    'relay',
              installed:  true,
              running:    !!inprocRelay,
              logExists:  true,
              logPath:    '(in-memory ring buffer)',
              stale:      false,
              logMtimeMs: Date.now(),
            };
          }
          if (channel === 'watchdog') {
            const s = watchdog?.status();
            return {
              service:        'watchdog',
              installed:      true,
              running:        !!s?.running,
              logExists:      true,
              logPath:        '(in-memory ring buffer)',
              stale:          false,
              logMtimeMs:     s?.lastHeartbeatAt ?? Date.now(),
              watchdogNpub:   s?.npub ?? null,
            };
          }
          return computeVpnStatus();
        })();
        res.write(`data: ${JSON.stringify({ status })}\n\n`);

        // Push fresh status frames when nvpn lifecycle events fire so the
        // Logs panel reflects Stop / Start / Restart immediately. Without
        // this, the meta strip stayed on its connect-time snapshot ("nvpn
        // Running …") even after a successful Stop click. We're already
        // open — the client doesn't need to reconnect or re-render the
        // history. Other channels (relay, watchdog) don't have an
        // equivalent emitter today; they fall through with no change.
        //
        // Trailing 200ms debounce: a Restart click fires state-changed
        // twice (once after the inner stop, once after the inner start)
        // within ~50–150ms. Pre-debounce, that produced two SSE frames
        // and the meta strip flickered "running → stopped → running".
        // Coalesce so the user sees one frame reflecting the post-restart
        // state. State actually durable for >200ms still fires normally.
        let onVpnStateChanged: (() => void) | null = null;
        let vpnStatePushTimer: NodeJS.Timeout | null = null;
        if (channel === 'vpn') {
          const SSE_COALESCE_MS = 200;
          const pushFreshFrame = async () => {
            if (res.writableEnded) return;
            try {
              const fresh = await computeVpnStatus();
              if (res.writableEnded) return;
              res.write(`data: ${JSON.stringify({ status: fresh })}\n\n`);
            } catch { /* probe failed — keep the stream alive, drop frame */ }
          };
          onVpnStateChanged = () => {
            if (res.writableEnded) return;
            if (vpnStatePushTimer) clearTimeout(vpnStatePushTimer);
            vpnStatePushTimer = setTimeout(() => {
              vpnStatePushTimer = null;
              void pushFreshFrame();
            }, SSE_COALESCE_MS);
          };
          nvpnEvents.on('state-changed', onVpnStateChanged);
        }

        // Replay the ring on connect so the user sees recent history
        // immediately, not just whatever happens after the panel opened.
        const initial = buf.drain();
        if (initial.length > 0) {
          res.write(`data: ${JSON.stringify({ lines: initial.map(formatLogLine) })}\n\n`);
        }

        // Live tail — push every new line as a single-line `lines` frame
        // so client code paths (history vs live) share one branch.
        const unsubscribe = buf.subscribe((line: LogLine) => {
          if (res.writableEnded) return;
          try {
            res.write(`data: ${JSON.stringify({ lines: [formatLogLine(line)] })}\n\n`);
          } catch { /* socket gone — close handler unsubs */ }
        });

        // 15s heartbeat keeps proxies / browsers from idling the
        // connection out when nothing's happening on the channel.
        const heartbeat = setInterval(() => {
          if (res.writableEnded) return;
          try { res.write(': heartbeat\n\n'); } catch {}
        }, 15_000);

        const cleanup = () => {
          clearInterval(heartbeat);
          unsubscribe();
          if (vpnStatePushTimer) { clearTimeout(vpnStatePushTimer); vpnStatePushTimer = null; }
          if (onVpnStateChanged) nvpnEvents.off('state-changed', onVpnStateChanged);
        };
        req.on('close', cleanup);
        res.on('close', cleanup);
        return;
      }

      // ── Repo views (extracted to routes/repo.ts) ──────────────────────
      // Per-project read-only views of the local git checkout + the
      // project's NIP-34 30617 announcement. Drives the Code tab.
      // Matched BEFORE handleProjects because the URL shape overlaps
      // (`/api/projects/:id/repo/...`) and we want repo.ts to win.
      if (await handleRepo(req, res, fullUrl, method)) return;

      // ── Patches views (extracted to routes/patches.ts) ────────────────
      // NIP-34 patch series (kind 1617) grouped into PR-shaped series
      // with revision threading. Drives the Proposals tab + per-patch
      // detail view. Same precedence rationale as handleRepo.
      if (await handlePatches(req, res, fullUrl, method)) return;

      // ── Issues + NIP-22 comments (extracted to routes/issues.ts) ─────
      // Kind 1621 issues with kind 1111 (and legacy 1622) comment trees,
      // plus SSE POSTs to ngit issue_create / ngit comment. Drives the
      // Issues tab + comment threading on both issues and patches.
      if (await handleIssues(req, res, fullUrl, method)) return;

      // ── Status + merge (extracted to routes/status.ts) ────────────────
      // Effective-status compute over kind 1630-1633 events, plus
      // SSE POSTs to ngit pr / issue subcommands (pr merge, pr status, etc).
      // Merge enforces a dirty-tree refusal before spawning ngit.
      if (await handleStatus(req, res, fullUrl, method)) return;

      // ── Projects + Chat project context (extracted to routes/projects.ts) ──
      if (await handleProjects(req, res, fullUrl, method)) return;

      // ── Blossom config + control (routes/blossom-config.ts) ───────────
      if (await handleBlossomConfig(req, res, fullUrl, method, {
        getServer: () => inprocBlossom,
        // User-initiated start/stop persist the preference + invalidate
        // the /api/status cache so the dashboard's three Blossom-aware
        // surfaces (Config section, Dashboard card, sidebar Health row)
        // all reflect the new state on the very next poll instead of
        // waiting out the SWR TTL.
        start:     enableInprocBlossomUserInitiated,
        stop:      disableInprocBlossomUserInitiated,
      })) return;

      // ── Identity (extracted to routes/identity.ts) ─────────────────────
      // Covers /api/identity/config, /api/identity/set, /api/identity/relays/{add,remove},
      // /api/identity/profile/preview, /api/identity/profile, /api/identity/profile/sync.
      if (await handleIdentity(req, res, fullUrl, method)) return;

      // ── Nostr client API (routes/client.ts) ────────────────────────────
      // Native Nostr read/post surface. The live consumer is the Relay
      // config panel's "Sync from Nostr" button (POST /api/client/sync-
      // relays — mirrors the owner's NIP-65 list into Your Relays). Reads
      // from identity.readRelays; signs via the persisted bunker pairing.
      // Auto-stamps ["client","nostr-station"].
      if (await handleClient(req, res, fullUrl, method)) return;

      // ── App Center (routes/apps.ts) ────────────────────────────────────
      // Manage the owner's NIP-89 handler events (kind 31990): list, build,
      // sign (bunker/project/NIP-07), publish, Blossom image upload, delete.
      // Auto-stamps the same ["client","nostr-station",…] tag as the Client
      // panel so published apps link back to nostr-station.
      if (await handleApps(req, res, fullUrl, method)) return;

      // ── nsite browser (routes/nsite.ts) ────────────────────────────────
      // Read side of NIP-5A v1: resolves npub/NIP-05/NSIT addresses, fetches
      // kind:34128 file events from owner relays, serves SHA256-verified
      // blobs from the author's Blossom servers into the #nsite panel's
      // sandboxed iframe. Snapshot cache + LRU blob cache; no disk
      // persistence in v1.
      if (await handleNsite(req, res, fullUrl, method)) return;

      // Setup wizard completion — called once from the Done stage. Flips
      // setupComplete=true (ending the localhost exemption on this box
      // when npub is set + requireAuth is on) and issues a fresh session
      // token for the stored npub so the dashboard unlocks without a
      // separate sign-in round trip.
      //
      // Safe to expose without a NIP-98 signature because:
      //   - setupComplete !== true means we're still inside the wizard's
      //     localhostExempt window, i.e. only something on 127.0.0.1 can
      //     reach this endpoint in the first place.
      //   - Once setupComplete flips true, this branch rejects further
      //     calls — a second-session upgrade requires real auth.
      // ── Amber QR pairing (first-run /setup) ──────────────────────────
      //
      // The hero step of the user-journey spec: a single full-screen QR
      // representing a NIP-46 nostrconnect:// URI. The user scans in
      // Amber, taps approve once, and the bunker handshake captures
      // their npub + saves a bunker client for future signing — all
      // without ever asking them to paste an npub.
      //
      // Two endpoints:
      //   POST /api/setup/amber/start
      //     Generates the URI + QR SVG, returns the session id for
      //     polling. Background task races the bunker connect against
      //     CONNECT_TIMEOUT_MS.
      //   GET  /api/setup/amber/session/:eph
      //     Polls session state. On status='ok' returns the captured
      //     npub; identity.json is already written by the time the
      //     wizard sees this response.
      if (url === '/api/setup/amber/start' && method === 'POST') {
        // Once setup is complete, this endpoint stops responding —
        // it's only meaningful during the first-run window. Subsequent
        // pairings (e.g. user wants to switch Amber accounts) go
        // through /api/auth/bunker-connect instead.
        const ident = readIdentity();
        if (ident.setupComplete === true) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'setup already complete' }));
          return;
        }
        const start = await startSetupAmber(expectedDashboardUrl(req, port));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...start }));
        return;
      }

      const setupAmberPollMatch = url.match(/^\/api\/setup\/amber\/session\/([0-9a-f]{64})$/);
      if (setupAmberPollMatch && method === 'GET') {
        const eph = setupAmberPollMatch[1];
        const s   = getSetupAmberSession(eph);
        if (!s) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', error: 'unknown session' }));
          return;
        }
        if (s.status === 'waiting') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'waiting', expiresAt: s.expiresAt }));
          return;
        }
        // Terminal state — consume the session entry. The wizard
        // displays the result and moves to the next stage.
        consumeSetupAmberSession(eph);
        if (s.status !== 'ok') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: s.status, error: s.error }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', npub: s.userNpub }));
        return;
      }

      // ── Live verification (Phase 4 of the user journey) ──────────────
      //
      // Generates a kind-1 test event, asks Amber to sign it (second
      // and last phone tap during onboarding), publishes to the
      // in-process relay over the public ws:// URL, reads it back via
      // a REQ subscription, and returns a step-by-step result. This
      // is the trust-earning moment — the user sees the full pipeline
      // work end-to-end before being asked to do anything real.
      if (url === '/api/setup/verify' && method === 'POST') {
        const ident = readIdentity();
        if (!ident.npub) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'identity not paired — finish Amber pairing first' }));
          return;
        }
        if (ident.setupComplete === true) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'setup already complete' }));
          return;
        }
        try {
          const result = await runSetupVerify();
          res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
        }
        return;
      }

      if (url === '/api/setup/complete' && method === 'POST') {
        const ident = readIdentity();
        if (!ident.npub) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'identity not set' }));
          return;
        }
        if (ident.setupComplete === true) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'setup already complete — sign in normally' }));
          return;
        }
        setSetupComplete(true);
        const ua = String(req.headers['user-agent'] || '');
        const sess = createSession(ident.npub, ua);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          token:     sess.token,
          npub:      sess.npub,
          expiresAt: sess.expiresAt,
        }));
        return;
      }

      // Keychain set — AI API key.
      //
      // We use the keychain lib directly rather than shelling out to
      // `nostr-station keychain set ai-api-key` because the CLI command
      // runs in an interactive Ink prompt and can't accept a value via
      // stdin or argv. The underlying keychain backend already stores
      // values through execa with array args (no shell interpolation);
      // calling store() here is the same code path, minus the TUI.
      //
      // The key value never touches process.argv, env, or logs — it's
      // only passed to keychain.store() which forwards it as an argv
      // arg to `security` / `secret-tool`.
      if (url === '/api/keychain/set' && method === 'POST') {
        let parsed: any = {};
        try { parsed = JSON.parse(await readBody(req)); }
        catch { res.writeHead(400); res.end('bad json'); return; }
        const key = typeof parsed.key === 'string' ? parsed.key : '';
        if (!key || key.length < 4) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'key is empty or too short' }));
          return;
        }
        // Reject obvious nsec paste — the AI key slot is for provider keys.
        if (isNsec(key)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'nsec detected — this slot is for AI provider keys only' }));
          return;
        }
        try {
          await getKeychain().store('ai-api-key', key);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) }));
        }
        return;
      }

      // ── ngit / nsite / account (extracted to routes/ngit.ts) ──────────
      // Covers /api/ngit/discover, /api/nsite/discover, /api/ngit/clone,
      // /api/ngit/account[/login|/logout].
      if (await handleNgit(req, res, fullUrl, method)) return;

      // ── nvpn runtime control (extracted to routes/nvpn.ts) ────────────
      // Covers /api/nvpn/status, /api/nvpn/{start,stop,restart},
      // /api/nvpn/install-service. Drives the Status panel's start/stop
      // buttons and the Logs panel's nostr-vpn meta strip.
      if (await handleNvpn(req, res, fullUrl, method)) return;

      // ── Communities (routes/communities.ts) ────────────────────────────
      // /api/communities/* — list/create/start/stop/restart/delete +
      // member CRUD + SSE log tail. Backs the Communities sidebar
      // panel; mirrors the section-handler shape used by every other
      // /api section above.
      // ── Communities feature gate ────────────────────────────────────
      // Experimental opt-in flag. The /api/communities/* routes are
      // gated behind explicit user opt-in + first-use acknowledgement.
      // The /api/communities-feature endpoint is the management surface
      // for the gate itself — always available so the Config panel can
      // read state and flip the toggle.
      if (url === '/api/communities-feature' && method === 'GET') {
        if (!requireSession(req, res)) return;
        const cfg = readCommunitiesFeatureConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok:               true,
          enabled:          cfg.enabled,
          acknowledged:     cfg.acknowledgedAt !== null,
          acknowledgedAt:   cfg.acknowledgedAt,
          usable:           cfg.enabled && cfg.acknowledgedAt !== null,
        }));
        return;
      }
      if (url === '/api/communities-feature' && method === 'POST') {
        if (!requireSession(req, res)) return;
        let raw: any;
        try { raw = JSON.parse(await readBody(req)); }
        catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
          return;
        }
        const patch: any = {};
        if (typeof raw?.enabled === 'boolean') patch.enabled = raw.enabled;
        if (raw?.acknowledge === true) patch.acknowledgedAt = Date.now();
        const saved = writeCommunitiesFeatureConfig(patch);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok:             true,
          enabled:        saved.enabled,
          acknowledged:   saved.acknowledgedAt !== null,
          acknowledgedAt: saved.acknowledgedAt,
          usable:         saved.enabled && saved.acknowledgedAt !== null,
        }));
        return;
      }

      // Gate the actual /api/communities/* routes behind opt-in.
      // Read endpoints (GET /api/communities, GET /api/communities/joined)
      // return empty results with featureEnabled: false rather than
      // 403. Reason: the dashboard fetches these unconditionally when
      // the panel mounts (the panel can be reached via #communities
      // URL hash even with the sidebar entry hidden) and a 403
      // surfaces as a noisy toast every navigation. Empty-list +
      // flag lets the panel render its disabled-state copy cleanly.
      const urlPath = url.split('?', 1)[0];
      const isReadOnlyCommunitiesPath =
        method === 'GET' &&
        (urlPath === '/api/communities' || urlPath === '/api/communities/joined');
      if (isReadOnlyCommunitiesPath && !isCommunitiesUsable()) {
        if (!requireSession(req, res)) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (urlPath === '/api/communities/joined') {
          res.end(JSON.stringify({ ok: true, joined: [], featureEnabled: false }));
        } else {
          res.end(JSON.stringify({ ok: true, communities: [], featureEnabled: false }));
        }
        return;
      }
      // Every other /api/communities/* path: 403 with the feature-gate
      // reason. The UI never reaches these in the disabled state (the
      // panel's gate check below prevents wizard / member / ban
      // endpoints from being called), but the API layer enforces it
      // anyway in case a script bypasses the UI.
      if (urlPath.startsWith('/api/communities') && !isCommunitiesUsable()) {
        if (!requireSession(req, res)) return;
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok:    false,
          error: 'Communities is an experimental feature. Enable it from Config and acknowledge the warning before use.',
        }));
        return;
      }

      if (await handleCommunities(req, res, fullUrl, method)) return;

      // ── Mobile Access (toggle) ──────────────────────────────────────────
      // Tiny route, small enough to inline rather than splitting into a
      // dedicated module. Reads the persisted toggle state (GET) or
      // writes a new state (POST). Always returns the live bind host
      // alongside so the UI can show "currently bound to 127.0.0.1,
      // saved-but-unapplied: 0.0.0.0" if the user toggled but hasn't
      // restarted yet.
      if (url === '/api/mobile-access' && method === 'GET') {
        if (!requireSession(req, res)) return;
        const cfg = readMobileAccessConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok:           true,
          enabled:      cfg.enabled,
          updatedAt:    cfg.updatedAt ?? null,
          currentBind:  dashboardBindHost(),
          needsRestart: (cfg.enabled ? '0.0.0.0' : '127.0.0.1') !== dashboardBindHost(),
        }));
        return;
      }
      if (url === '/api/mobile-access' && method === 'POST') {
        if (!requireSession(req, res)) return;
        let raw: any;
        try { raw = JSON.parse(await readBody(req)); }
        catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
          return;
        }
        if (typeof raw?.enabled !== 'boolean') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '`enabled` (boolean) required' }));
          return;
        }
        const saved = writeMobileAccessConfig({ enabled: raw.enabled });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok:           true,
          enabled:      saved.enabled,
          updatedAt:    saved.updatedAt ?? null,
          currentBind:  dashboardBindHost(),
          // After a write, the bind on disk and the live bind will
          // disagree until the user restarts (unless the toggle was
          // a no-op). The UI surfaces this as "Restart to apply".
          needsRestart: (saved.enabled ? '0.0.0.0' : '127.0.0.1') !== dashboardBindHost(),
        }));
        return;
      }

      // ── Trusted devices (mesh dashboard allowlist) ─────────────────────
      // Pubkeys (besides the owner's) allowed to reach the dashboard over a
      // non-loopback interface. Consumed by dashboard-binding's connection
      // gate; the mesh-origin gate + Bearer auth still apply on top.
      if (url === '/api/trusted-devices' && method === 'GET') {
        if (!requireSession(req, res)) return;
        const cfg = readTrustedDevices();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, pubkeys: cfg.pubkeys, updatedAt: cfg.updatedAt ?? null }));
        return;
      }
      if ((url === '/api/trusted-devices/add' || url === '/api/trusted-devices/remove') && method === 'POST') {
        if (!requireSession(req, res)) return;
        let raw: any;
        try { raw = JSON.parse(await readBody(req)); }
        catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, detail: 'invalid JSON body', pubkeys: readTrustedDevices().pubkeys }));
          return;
        }
        const pubkey = typeof raw?.pubkey === 'string' ? raw.pubkey : '';
        const r = url.endsWith('/add') ? addTrustedDevice(pubkey) : removeTrustedDevice(pubkey);
        // Always 200 — {ok} carries success; a bad pubkey shows inline in the
        // UI rather than as a generic error toast.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
        return;
      }

      // ── Mail (routes/mail.ts) ──────────────────────────────────────────
      // NIP-17 mail panel: read-only inbox + thread view. Send + compose
      // + inbox-relay management arrive in follow-up PRs.
      if (await handleMail(req, res, fullUrl, method)) return;

      // ── AI provider system (extracted to routes/ai.ts)
      // Covers /api/ai/providers, /api/ai/config,
      // /api/ai/providers/:id/key (POST/DELETE),
      // /api/ai/providers/:id/models, and /api/ai/chat.
      if (await handleAi(req, res, fullUrl, method)) return;

      // ── Project templates registry (routes/templates.ts)
      // Covers /api/templates GET/POST and /api/templates/:id
      // GET/PATCH/DELETE + /api/templates/:id/reset.
      if (await handleTemplates(req, res, fullUrl, method)) return;

      // ── Terminal HTTP surface (extracted to routes/terminal.ts) ───────
      // Covers /api/terminal/capability, /api/terminal, /api/terminal/create,
      // and DELETE /api/terminal/:id. The matching WebSocket upgrade is
      // wired below via mountTerminalWebSocket() so it shares this
      // request handler's allowedHosts / isLoopbackUrl primitives.
      if (await handleTerminal(req, res, fullUrl, method)) return;

      // Static fallback — vendor libs first (fast path, strict whitelist),
      // then the regular src/web tree.
      if (method === 'GET' && serveVendorXterm(req, res)) return;
      if (method === 'GET' && serveStatic(req, res)) return;

      // SPA routes — served from index.html. The client router picks up
      // the path from location and renders the wizard/panel accordingly.
      // Listed explicitly (not a catch-all) so typos still 404.
      if (method === 'GET' && url === '/setup') {
        // Already paired — bounce to the dashboard. Without this guard a
        // refresh on /setup keeps the wizard SPA mounted, which both
        // confuses the user and offers no working path forward (the
        // /api/setup/* endpoints all 409 once setupComplete flips true).
        if (readIdentity().setupComplete === true) {
          res.writeHead(302, { Location: '/' });
          res.end();
          return;
        }
        const indexPath = path.join(WEB_DIR, 'index.html');
        if (fs.existsSync(indexPath)) {
          res.writeHead(200, {
            'Content-Type': 'text/html',
            'Cache-Control': 'no-cache',
            ...HTML_SECURITY_HEADERS,
          });
          fs.createReadStream(indexPath).pipe(res);
          return;
        }
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });

    // ── Terminal WebSocket upgrade (extracted to routes/terminal.ts) ──
    // Mounted as a closure-receiving function so the WS layer reuses this
    // request handler's H1 (DNS rebinding) + H2 (CSRF) primitives — including
    // the mesh-trust relaxation, so the terminal connects over Mobile Access
    // (nvpn tunnel) exactly where the dashboard's HTTP API already does. See
    // the route module for the full URL grammar + control-frame protocol.
    mountTerminalWebSocket(server, {
      allowedHosts, isLoopbackUrl, port,
      meshHostMatches, meshUrlMatches, computeMeshTrusted,
    });

    // ── Relay-proxy WebSocket (extracted to routes/relay-proxy.ts) ────
    // Browser-side stats/following lookups used to open wss:// connections
    // directly; they now route through this proxy so the dashboard's CSP
    // connect-src can drop `wss:`. Same H1 + H2 + auth gates as terminal.
    mountRelayProxyWebSocket(server, { allowedHosts, isLoopbackUrl });

    // PID file management (B3): write once we're bound, drop on graceful
    // exit. The file lets `nostr-station uninstall` refuse to nuke services
    // out from under a running dashboard — see src/lib/pid-file.ts for the
    // stale-PID handling story.
    let pidWritten = false;
    const dropPid = () => {
      if (!pidWritten) return;
      pidWritten = false;
      removePidFile();
    };

    server.on('close', () => {
      destroyAllTerminals();
      // Stop the watchdog before the relay it depends on.
      watchdog?.stop();
      watchdog = null;
      // Stop the in-process relay alongside the dashboard. Errors are
      // swallowed because a half-stopped relay during shutdown is no
      // worse than a dropped log line.
      void inprocRelay?.stop().catch(() => {});
      setInprocRelayPort(null);
      setLocalStore(null);
      void inprocBlossom?.stop().catch(() => {});
      setInprocBlossomPort(null);
      inprocRelay = null;
      // nvpn log tailer is independent of the daemon — it just polls a
      // file. Stop it so the polling timer doesn't keep Node alive.
      nvpnLogTailer?.stop();
      nvpnLogTailer = null;
      // Stop the GitHub update poller so the interval doesn't keep
      // Node alive past close (the unref above is best-effort).
      stopUpdatePoller();
      // Mail inbox worker holds long-lived WebSockets to public relays;
      // close them so they don't keep Node alive past server.close.
      try { getInboxWorker().stop(); } catch {}
      // Snapshot live sessions so a one-click update restart drops
      // the user back in authenticated. Best-effort; failure here
      // just means the user logs in again post-restart.
      persistSessions();
      dropPid();
    });

    // EADDRINUSE retry budget — only used when this process was spawned
    // by the update flow's self-respawn path (src/lib/update-check.ts).
    // The parent process exits a few hundred ms after spawning us, so the
    // first 1–2 listen attempts can hit EADDRINUSE while the kernel
    // finishes releasing the listening socket. Short backoff covers it
    // without delaying the unsupervised launch case noticeably.
    // When the env is absent (fresh boot, user-initiated start) we keep
    // the original single-attempt behavior so a legitimately-held port
    // surfaces immediately as "another dashboard is running" in Chat.tsx.
    const respawning      = process.env.NOSTR_STATION_RESPAWN === '1';
    let listenRetriesLeft = respawning ? 10 : 0;

    // Dashboard binding peer filter — gates non-loopback inbound
    // connections by pubkey via the nvpn peer roster. No-op while
    // the dashboard binds to loopback only (the default); becomes
    // functionally active when Mobile Access binds to a non-loopback
    // interface. See dashboard-binding.ts for the security rationale.
    attachDashboardBindingFilter(server);

    server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE' && listenRetriesLeft > 0) {
        listenRetriesLeft--;
        setTimeout(() => server.listen(port, dashboardBindHost()), 500);
        return;
      }
      if (e.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use — check: lsof -i :${port}`));
      } else {
        reject(e);
      }
    });

    // Signal handlers — Ink's own SIGINT handler tears down the TUI but
    // doesn't fire `server.close`, so we mirror cleanup here. Use `once`
    // so a second Ctrl-C still terminates fast (default behavior); we
    // re-raise the signal after our cleanup so node uses its default
    // exit-on-signal semantics.
    const onSignal = (sig: NodeJS.Signals) => {
      dropPid();
      // Best-effort graceful close; don't await.
      try { server.close(); } catch {}
      // Re-raise so the parent process / Ink propagates exit-on-signal
      // semantics correctly. Without re-raising, a SIGTERM that arrived
      // mid-run-up could be silently absorbed.
      process.kill(process.pid, sig);
    };
    process.once('SIGINT',  onSignal);
    process.once('SIGTERM', onSignal);
    // `beforeExit` fires when the event loop drains naturally (rare for a
    // server but covers oddball test paths). Not registered as `exit`
    // because `exit` only allows synchronous work, and removePidFile is
    // already sync — but `beforeExit` is friendlier to debugging stacks.
    process.once('beforeExit', dropPid);

    server.listen(port, dashboardBindHost(), () => {
      try {
        writePidFile();
        pidWritten = true;
      } catch (e) {
        // PID file is advisory — failure to write must not block the
        // dashboard from coming up. Surface to stderr for the post-mortem.
        process.stderr.write(`[pid-file] write failed: ${(e as Error).message}\n`);
      }
      // Kick off best-effort warm-ups now that the socket is bound. If any
      // of them hang (secret-tool unlock prompt, node-pty prebuilt probe,
      // ai-config migration) the dashboard is still up and serving.
      warmUp();
      // Background GitHub update poller (~once every 30 min after a
      // startup delay). One unauthenticated `compare` request per
      // poll; cached server-side so the dashboard never blocks on it
      // and the UI just reads from cache.
      startUpdatePoller();
      // In-process Blossom (Phase C). Off by default — gated on
      // STATION_INPROC_BLOSSOM=1 at boot. Fire-and-forget so its own
      // EADDRINUSE on 8081 doesn't block the dashboard or the relay.
      void maybeStartInprocBlossom().catch(e => {
        process.stderr.write(`[blossom] startup failed: ${e?.message || e}\n`);
      });

      // In-process relay (gated on STATION_INPROC_RELAY=1). Started after
      // the dashboard binds so a relay-port collision doesn't prevent
      // the dashboard from coming up — the relay will surface its own
      // EADDRINUSE in stderr if 7777 is taken.
      void maybeStartInprocRelay()
        .then(() => {
          // Pre-warm the SWR caches in the background. The first
          // /api/status / Logs-SSE request would otherwise pay the
          // cold probe cost (nc + nvpn + ~5 binary --version probes,
          // ~1-4 s wall-clock on a wedged nvpn daemon). Kicking them
          // off here means the dashboard's first poll usually rides
          // an already-resolved cache. The three caches are
          // independent — if any of them hangs (e.g. nvpn wedged),
          // the other two still warm in parallel.
          //
          // Fire-and-forget: rejection paths inside the caches just
          // leave the slot empty so the user's first request takes
          // the cold hit (same as before this commit), they don't
          // crash startup.
          void cachedGatherStatus();
          void probeNvpnStatus();
          void probeNvpnServiceStatus();
        })
        .catch(e => {
          process.stderr.write(`[relay] failed to start: ${(e as Error).message}\n`);
        });
      // nvpn daemon log tailer — best-effort. Sits idle until the daemon
      // log file appears, then pumps lines into logBuffers.vpn so the
      // Logs panel's nostr-vpn tab streams real output. Single instance
      // per server lifetime; the tailer's own poll loop is cheap and
      // cancels on `stop()` from the close handler below.
      if (process.env.STATION_DISABLE_NVPN_TAIL !== '1') {
        try { nvpnLogTailer = startNvpnLogTail(logBuffers.vpn); }
        catch (e: any) {
          process.stderr.write(`[nvpn] log tailer failed to start: ${e?.message || e}\n`);
        }
      }

      // Communities supervisor — reconcile any GRAIN children that
      // survived a dashboard hard-kill, then re-supervise our own
      // orphans. Best-effort: a missing communities subsystem (no
      // dir on disk yet for solo-dev users) just yields an empty
      // result and we move on. Never blocks dashboard startup.
      void (async () => {
        try {
          const mod = await import('./community-process.js');
          const results = await mod.reconcileOrphanedCommunities();
          for (const r of results) {
            if (r.outcome === 'respawned') {
              process.stderr.write(`[communities] re-supervised ${r.id} (pid ${r.pid ?? '?'})\n`);
            } else if (r.outcome === 'pid-not-ours' && r.note) {
              process.stderr.write(`[communities] ${r.id}: ${r.note}\n`);
            }
          }
        } catch (e: any) {
          process.stderr.write(`[communities] reconcile failed: ${e?.message || e}\n`);
        }
      })();

      // Wire the in-process Blossom handle through to the mail route so
      // /api/mail/attachment can upload without going through the public
      // HTTP layer (we're inside the dashboard's authenticated session
      // already; the BUD-02 NIP-98 ceremony is unnecessary here).
      setMailBlossomAccessor(() => inprocBlossom);

      // Mail inbox worker (NIP-17/1301). Three gates, all must pass:
      //   - STATION_DISABLE_MAIL!=1 (env override for headless / CI)
      //   - identity.mailEnabled !== false (PR 11 user preference)
      //   - worker.start() decides internally if a saved bunker exists
      // Worker.start() no-ops on missing-bunker; we don't probe here.
      if (process.env.STATION_DISABLE_MAIL !== '1' && readIdentity().mailEnabled !== false) {
        try { getInboxWorker().start(); }
        catch (e: any) {
          process.stderr.write(`[mail] inbox worker failed to start: ${e?.message || e}\n`);
        }
      }

      resolve(server);
    });
  });
}
