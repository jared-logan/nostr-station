import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { P } from '../cli-ui/palette.js';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readIdentity } from '../lib/identity.js';
import { findBin, hasBin } from '../lib/detect.js';
import { HEARTBEAT_FILE } from '../lib/watchdog.js';

interface StatusProps { json: boolean; }

// Three-state status, plus a stable `id` for dashboard UI mapping.
// `ok` is retained for back-compat (status --json consumers); `state`
// distinguishes installed-but-down (warn) from not-installed (err).
export type ServiceState = 'ok' | 'warn' | 'err';

// `kind` lets the dashboard group entries in both the sidebar Service Health
// list and the Status panel — services (daemons / scheduled jobs with a
// running state) get colored dots; binaries (CLI tools that are installed or
// not) get ✓/✗ glyphs, with a yellow ! reserved for the rare binary that has
// a warn-worthy mid-state (ngit installed but no default relay configured).
export type ServiceKind = 'service' | 'binary';

export interface ServiceStatus {
  id:    string;
  label: string;
  value: string;
  ok:    boolean;
  state: ServiceState;
  kind:  ServiceKind;
  // Claude Code plugins are nested under the `claude` row in the dashboard
  // Status panel — they're not real binaries on PATH so they don't warrant
  // sidebar Service Health rows of their own, but users still need to see
  // whether the ones we pitch in onboard (llm-wiki today) are actually
  // installed. Populated only on the 'claude' entry.
  plugins?: ClaudePlugin[];
}

export interface ClaudePlugin {
  id:          string;          // registry key, e.g. 'wiki@llm-wiki'
  name:        string;          // display name
  version:     string | null;   // from installed_plugins.json when installed
  installed:   boolean;
  recommended: boolean;         // we suggest this one in onboard
  installHint?: string;         // exact slash-command to run when missing
  about?:       string;         // one-line blurb for the expanded card
}

// Plugins we render even when absent, so "not installed" states carry the
// exact command the user should run. Reconciled against Claude Code's own
// ~/.claude/plugins/installed_plugins.json (key = "<name>@<marketplace>").
const RECOMMENDED_PLUGINS: ReadonlyArray<{
  id: string;
  name: string;
  installHint: string;
  about: string;
}> = [
  {
    id:          'wiki@llm-wiki',
    name:        'llm-wiki',
    installHint: '/install-plugin github:nvk/llm-wiki',
    about:       'LLM-compiled knowledge base — research, compile, and query Nostr docs in-session.',
  },
];

function gatherClaudePlugins(): ClaudePlugin[] {
  const registryPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  let installed: Record<string, Array<{ version?: string }>> = {};
  try {
    installed = JSON.parse(fs.readFileSync(registryPath, 'utf8'))?.plugins ?? {};
  } catch { /* registry missing — nothing installed, rows stay 'not installed' */ }

  const rows: ClaudePlugin[] = [];
  const seen = new Set<string>();

  // Claude Code's registry writes 'unknown' for plugins whose source lacks
  // a version tag — render it as "no version" instead of a literal "v unknown".
  const normalizeVersion = (v: string | undefined): string | null =>
    (v && v !== 'unknown') ? v : null;

  for (const rec of RECOMMENDED_PLUGINS) {
    const entry = installed[rec.id]?.[0];
    rows.push({
      id:          rec.id,
      name:        rec.name,
      version:     normalizeVersion(entry?.version),
      installed:   !!entry,
      recommended: true,
      installHint: rec.installHint,
      about:       rec.about,
    });
    seen.add(rec.id);
  }

  for (const [id, entries] of Object.entries(installed)) {
    if (seen.has(id)) continue;
    const entry = entries?.[0];
    if (!entry) continue;
    rows.push({
      id,
      name:        id.split('@')[0],
      version:     normalizeVersion(entry.version),
      installed:   true,
      recommended: false,
    });
  }

  return rows;
}

// Every shellout here is on the hot path for /api/status. A single blocking
// call stalls the whole Node event loop and the dashboard sees a 10s+ hang.
// Default 2s ceiling, SIGKILL on expiry — we'd rather report "not running"
// than make the user wait.
function cmd(c: string, timeoutMs = 2000): string | null {
  try {
    return execSync(c, {
      stdio: 'pipe',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    }).toString().trim();
  } catch { return null; }
}

// Watchdog probe — reads the heartbeat file the in-Node Watchdog writes
// on every fire. Pure + exported so tests can pin every branch without
// touching the real ~/.nostr-station path.
//   missing      → err  · "not running"
//   fresh (≤7m)  → ok   · "heartbeat Nm ago"  (5m interval + 2m slack)
//   stale (>7m)  → warn · "heartbeat Nm ago — stale"
export interface WatchdogProbe {
  exists: boolean;
  ageMs:  number | null;
}
export function watchdogStateFor(p: WatchdogProbe): { value: string; state: ServiceState; ok: boolean } {
  if (!p.exists || p.ageMs === null) {
    return { value: 'not running', state: 'err', ok: false };
  }
  const ageMin = Math.floor(p.ageMs / 60_000);
  if (p.ageMs <= 7 * 60_000) {
    return {
      value: `heartbeat ${ageMin === 0 ? 'just now' : `${ageMin}m ago`}`,
      state: 'ok',
      ok:    true,
    };
  }
  return { value: `heartbeat ${ageMin}m ago — stale`, state: 'warn', ok: false };
}

// nvpn probe — separate from watchdog so each can fail cleanly. Three
// sub-states stack underneath the binary-present split:
//   binary missing     → err  · "not installed"
//   binary present, no daemon response within 1s → warn · "not connected"
//   binary present + daemon up + tunnel_ip set    → ok   · tunnel IP
// `nvpn status --json` may hang indefinitely on a daemon socket that's
// listening but wedged; we cap it tight (1s) and treat any failure as
// "not connected" rather than blocking the whole /api/status call.
export interface NvpnProbe {
  binPresent: boolean;
  meshIp:     string | null;
}
export function nvpnStateFor(p: NvpnProbe): { value: string; state: ServiceState; ok: boolean } {
  if (!p.binPresent) return { value: 'not installed', state: 'err', ok: false };
  if (p.meshIp)      return { value: p.meshIp, state: 'ok', ok: true };
  return { value: 'not connected', state: 'warn', ok: false };
}

// Exported so cli.tsx can call it directly for --json mode, bypassing Ink.
// Ink would otherwise write UI frames to stdout alongside the JSON payload,
// corrupting any programmatic consumer piping stdout into a parser.
export function gatherStatus(): ServiceStatus[] {
  // `-w 1` is a second belt-and-suspenders timeout — both BSD and GNU nc
  // respect it. Protects against nc variants that ignore our execSync
  // timeout (rare, but cheap insurance).
  //
  // RELAY_HOST/PORT are set by the in-process relay at boot (see
  // web-server.ts maybeStartInprocRelay). When this CLI runs before the
  // dashboard has booted (e.g. `nostr-station status` from a fresh shell)
  // the env is unset; default to the relay's own defaults.
  const probeHost = process.env.RELAY_HOST || '127.0.0.1';
  const probePort = Number(process.env.RELAY_PORT || '7777');
  const relayUp   = cmd(`nc -z -w 1 ${probeHost} ${probePort}`, 1500) !== null;

  // nvpn probe — binary on PATH, then a tight 1s `nvpn status --json` to
  // pull the tunnel IP. We cap aggressively because the daemon socket can
  // hang indefinitely when nvpn is installed but the mesh peer is down.
  const nvpnPath = findBin('nvpn');
  const meshIp = (() => {
    if (!nvpnPath) return null;
    try {
      const out = cmd(`${nvpnPath} status --json`, 1000);
      return out ? JSON.parse(out)?.tunnel_ip ?? null : null;
    } catch { return null; }
  })();
  const vpnRow = nvpnStateFor({ binPresent: !!nvpnPath, meshIp });

  // Watchdog probe — file mtime tells us whether the in-Node loop has
  // fired recently. ageMs:null when missing entirely (never started),
  // numeric otherwise.
  const wdProbe = (() => {
    try {
      const mtime = fs.statSync(HEARTBEAT_FILE).mtimeMs;
      return { exists: true, ageMs: Math.max(0, Date.now() - mtime) };
    } catch {
      return { exists: false, ageMs: null };
    }
  })();
  const wdRow = watchdogStateFor(wdProbe);

  const ngitBin   = hasBin('ngit');
  // Station-level "configured" signal is the default nostr relay the user
  // saved in identity.json — set via Config → NGIT in the dashboard. This
  // matches what the dashboard can act on; project-specific ngit remotes
  // are surfaced inside the Projects panel instead.
  const ngitRelay = (() => {
    try { return readIdentity().ngitRelay || ''; }
    catch { return ''; }
  })();

  // Binary presence goes through findBin (absolute-path walk) so a fresh
  // Linux install where ~/.cargo/bin isn't on the Node PATH still shows
  // ✓ for installed tools. Version probes spawn the resolved absolute
  // path directly rather than relying on shell PATH lookup.
  const claudePath = findBin('claude');
  const claudeV    = claudePath ? cmd(`${claudePath} --version 2>/dev/null`) : null;

  const nakPath   = findBin('nak');
  const nakV      = nakPath ? cmd(`${nakPath} --version 2>/dev/null`) : null;

  const stacksPath = findBin('stacks');
  const stacksBin  = stacksPath !== null;
  const stacksV    = stacksPath ? cmd(`${stacksPath} --version 2>/dev/null`) : null;

  const claudeBin = claudePath !== null;
  const nakBin    = nakPath !== null;

  // Three-state mapping:
  //   ok   — running + configured
  //   warn — installed but not running/configured
  //   err  — not installed
  const relayState:    ServiceState = relayUp ? 'ok' : 'warn';
  const ngitState:     ServiceState = ngitBin && ngitRelay ? 'ok' : ngitBin ? 'warn' : 'err';
  const claudeState:   ServiceState = claudeBin ? 'ok' : 'err';
  const nakState:      ServiceState = nakBin ? 'ok' : 'err';
  const stacksState:   ServiceState = stacksBin ? 'ok' : 'err';

  return [
    // Services — daemons or scheduled jobs with a runtime state.
    { id: 'relay',     label: 'Relay',       value: relayUp ? `ws://${probeHost}:${probePort} ✓` : 'not running',                       ok: relayUp,      state: relayState,    kind: 'service' },
    { id: 'vpn',       label: 'nostr-vpn',   value: vpnRow.value,                                                                        ok: vpnRow.ok,    state: vpnRow.state,  kind: 'service' },
    { id: 'watchdog',  label: 'watchdog',    value: wdRow.value,                                                                         ok: wdRow.ok,     state: wdRow.state,   kind: 'service' },
    // Binaries — CLI tools; installed or not. `ngit` is the lone binary with
    // a warn state (installed but no default relay set — configure in Config).
    { id: 'ngit',      label: 'ngit',        value: ngitBin && ngitRelay ? `relay: ${ngitRelay.replace(/^wss?:\/\//, '')}` : ngitBin ? 'not configured' : 'not installed', ok: ngitBin && !!ngitRelay, state: ngitState,    kind: 'binary' },
    { id: 'claude',    label: 'claude-code', value: claudeV  ?? 'not installed',                                                           ok: !!claudeV,    state: claudeState,   kind: 'binary', plugins: gatherClaudePlugins() },
    { id: 'nak',       label: 'nak',         value: nakV     ?? 'not installed',                                                           ok: !!nakV,       state: nakState,      kind: 'binary' },
    { id: 'stacks',    label: 'Stacks',      value: stacksV  ?? (stacksBin ? 'installed' : 'not installed'),                               ok: stacksBin,    state: stacksState,   kind: 'binary' },
  ];
}

// Pure JSON serializer — also reused by cli.tsx for --json so Ink never mounts.
export function formatStatusJson(rows: ServiceStatus[]): string {
  return JSON.stringify(
    Object.fromEntries(rows.map(x => [x.label, { ok: x.ok, value: x.value }])),
    null, 2,
  );
}

export const Status: React.FC<StatusProps> = ({ json }) => {
  const [rows, setRows] = useState<ServiceStatus[]>([]);

  useEffect(() => {
    const r = gatherStatus();
    setRows(r);
    if (json) {
      console.log(formatStatusJson(r));
      process.exit(0);
    }
  }, []);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color={P.accent} bold>nostr-station status</Text>
      </Box>
      <Text color={P.accentDim}>{'─────────────────────────────'}</Text>
      {rows.map((r, i) => (
        <Box key={i}>
          <Box width={14}><Text color={P.muted}>{r.label}</Text></Box>
          <Text color={r.ok ? P.success : P.error}>{r.value}</Text>
        </Box>
      ))}
      <Text color={P.accentDim}>{'─────────────────────────────'}</Text>
      <Box marginTop={1}>
        <Text color={P.muted}>logs: </Text>
        <Text>open the dashboard Logs panel</Text>
      </Box>
    </Box>
  );
};
