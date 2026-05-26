import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { P } from '../cli-ui/palette.js';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findBin, hasBin } from '../lib/detect.js';
import { HEARTBEAT_FILE } from '../lib/watchdog.js';
import { listCommunities, listCommunityMembers } from '../lib/communities.js';
import { readGrainInstalledVersion } from '../lib/grain-installer.js';

interface StatusProps { json: boolean; }

// Three-state status, plus a stable `id` for dashboard UI mapping.
// `ok` is retained for back-compat (status --json consumers); `state`
// distinguishes installed-but-down (warn) from not-installed (err).
export type ServiceState = 'ok' | 'warn' | 'err';

// `kind` lets the dashboard group entries in both the sidebar Service Health
// list and the Status panel — services (daemons / scheduled jobs with a
// running state) get colored dots; binaries (CLI tools that are installed or
// not) get ✓/✗ glyphs.
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
  // whether the recommended ones (llm-wiki today) are actually installed.
  // Populated only on the 'claude' entry.
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

// nvpn probe — separate from watchdog so each can fail cleanly. Four
// sub-states stack underneath the binary-present split:
//   binary missing                                     → err  · "not installed"
//   binary present, no daemon response within timeout  → warn · "not connected"
//   binary present, daemon.running:false               → warn · "not connected"
//   binary present + daemon running + tunnel_ip set    → ok   · tunnel IP
// `nvpn status --json` may hang indefinitely on a daemon socket that's
// listening but wedged; we cap it (a few seconds) and treat any failure
// as "not connected" rather than blocking the whole /api/status call.
// `daemon.running:false` is authoritative — when the daemon is stopped
// the CLI can still return JSON with a stale `tunnel_ip` from config,
// which would otherwise flip the dashboard green while the detail page
// (which gates on running) correctly reads stopped. Mirrors
// nvpnRowStateFor in lib/nvpn.ts so both surfaces agree.
export interface NvpnProbe {
  binPresent: boolean;
  running:    boolean;
  meshIp:     string | null;
}
export function nvpnStateFor(p: NvpnProbe): { value: string; state: ServiceState; ok: boolean } {
  if (!p.binPresent) return { value: 'not installed', state: 'err', ok: false };
  if (!p.running)    return { value: 'not connected', state: 'warn', ok: false };
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

  // In-process Blossom — same shape as the relay probe. Port comes from
  // STATION_INPROC_BLOSSOM_PORT (default 8081). Off by default: state is
  // 'warn' when unbound (user hasn't enabled in Config → Blossom), 'ok'
  // when bound. Never 'err' because the server is bundled in-process —
  // there's no "not installed" state, only "not enabled yet."
  const blossomHost = '127.0.0.1';
  const blossomPort = Number(process.env.STATION_INPROC_BLOSSOM_PORT || '8081');
  const blossomUp   = cmd(`nc -z -w 1 ${blossomHost} ${blossomPort}`, 1500) !== null;

  // nvpn probe — binary on PATH, then `nvpn status --json` to pull the
  // tunnel IP. The daemon socket can hang indefinitely when the mesh peer
  // is down, so we still cap; 4s matches the dashboard's banner probe and
  // is forgiving enough that a healthy-but-loaded daemon doesn't get
  // mis-reported as "not connected" on a transient stall.
  //
  // Two-pass on Linux: when the user-mode probe shows daemon:not-running
  // (or returns the config-snapshot fallback that means "unreachable
  // from this $HOME") AND `systemctl is-active nvpn.service` reports
  // active, re-probe via `sudo -H -n nvpn status --json`. The -H is
  // load-bearing: without it sudo preserves the dashboard user's HOME
  // and nvpn reads the user-side config (the phantom from pre-#162
  // installs) instead of /root/.config/nvpn/ where the service-installed
  // daemon actually lives. The async sibling in lib/nvpn.ts uses the
  // same pattern.
  const nvpnPath = findBin('nvpn');
  const probeNvpn = (sudo: boolean): {
    running: boolean; meshIp: string | null; statusSource: string | null;
  } | null => {
    if (!nvpnPath) return null;
    try {
      const c = sudo
        ? `sudo -H -n ${nvpnPath} status --json`
        : `${nvpnPath} status --json`;
      const out = cmd(c, 4000);
      if (!out) return null;
      const j = JSON.parse(out);
      return {
        running: !!j?.daemon?.running,
        meshIp:  (j?.tunnel_ip as string) ?? null,
        statusSource: typeof j?.status_source === 'string' ? j.status_source : null,
      };
    } catch { return null; }
  };
  const nvpnProbe = (() => {
    if (!nvpnPath) return { running: false, meshIp: null as string | null };
    let p = probeNvpn(false);
    if (process.platform === 'linux'
        && (!p || !p.running || (p.statusSource && p.statusSource !== 'daemon'))) {
      // Cheap check — `systemctl is-active` returns "active" exactly
      // when the unit's running. Skip the sudo round-trip otherwise.
      const active = cmd('systemctl is-active nvpn.service', 1500);
      if (active === 'active') {
        const rootP = probeNvpn(true);
        if (rootP) p = rootP;
      }
    }
    if (!p) return { running: false, meshIp: null };
    return { running: p.running, meshIp: p.meshIp };
  })();
  const vpnRow = nvpnStateFor({
    binPresent: !!nvpnPath,
    running:    nvpnProbe.running,
    meshIp:     nvpnProbe.meshIp,
  });

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

  // Binary presence goes through findBin (absolute-path walk) so a fresh
  // Linux install where ~/.cargo/bin isn't on the Node PATH still shows
  // ✓ for installed tools. Version probes spawn the resolved absolute
  // path directly rather than relying on shell PATH lookup.
  const ngitPath  = findBin('ngit');
  const ngitV     = ngitPath ? cmd(`${ngitPath} --version 2>/dev/null`) : null;
  const ngitBin   = ngitPath !== null;

  const claudePath = findBin('claude');
  const claudeV    = claudePath ? cmd(`${claudePath} --version 2>/dev/null`) : null;

  // OpenCode — alternative terminal-native AI to Claude Code. Same
  // "binary on PATH" model; the AI config + terminal panel already know
  // about it (see ai-providers.ts), this row just surfaces install state
  // in the dashboard the same way claude-code does.
  const opencodePath = findBin('opencode');
  const opencodeV    = opencodePath ? cmd(`${opencodePath} --version 2>/dev/null`) : null;

  const nakPath   = findBin('nak');
  const nakV      = nakPath ? cmd(`${nakPath} --version 2>/dev/null`) : null;

  const stacksPath = findBin('stacks');
  const stacksBin  = stacksPath !== null;
  const stacksV    = stacksPath ? cmd(`${stacksPath} --version 2>/dev/null`) : null;

  // grain ships without a --version flag (exits non-zero on unknown
  // args), so we can't reuse the `<bin> --version` probe the other
  // binaries share. Instead we read the marker file installGrain writes
  // at ~/.nostr-station/bin/grain.version — same source of truth the
  // Updates modal uses to decide whether to flag an upgrade. The
  // marker is absent on pre-0.7.0 installs (added in this commit's
  // upgrade-detection wire-up), so we fall back to bare "installed"
  // when the binary exists without one. After the first marker-aware
  // install / upgrade, the row reads "grain X.Y.Z" — matches the
  // ngit / nak / stacks "<bin> <version>" style consumers expect.
  const grainPath = findBin('grain');
  const grainBin  = grainPath !== null;
  const grainV    = grainBin ? readGrainInstalledVersion() : null;
  const grainValue = grainV
    ? `grain ${grainV}`
    : grainBin ? 'installed' : 'not installed';

  const claudeBin   = claudePath !== null;
  const opencodeBin = opencodePath !== null;
  const nakBin      = nakPath !== null;

  // Three-state mapping:
  //   ok   — running + configured
  //   warn — installed but not running/configured
  //   err  — not installed
  const relayState:    ServiceState = relayUp ? 'ok' : 'warn';
  const blossomState:  ServiceState = blossomUp ? 'ok' : 'warn';
  const ngitState:     ServiceState = ngitBin ? 'ok' : 'err';
  const claudeState:   ServiceState = claudeBin ? 'ok' : 'err';
  const opencodeState: ServiceState = opencodeBin ? 'ok' : 'err';
  const nakState:      ServiceState = nakBin ? 'ok' : 'err';
  const stacksState:   ServiceState = stacksBin ? 'ok' : 'err';
  const grainState:    ServiceState = grainBin ? 'ok' : 'err';

  return [
    // Services — daemons or scheduled jobs with a runtime state.
    { id: 'relay',     label: 'Relay',       value: relayUp ? `ws://${probeHost}:${probePort} ✓` : 'not running',                       ok: relayUp,      state: relayState,    kind: 'service' },
    { id: 'blossom',   label: 'Blossom',     value: blossomUp ? `http://${blossomHost}:${blossomPort} ✓` : 'not enabled',                ok: blossomUp,    state: blossomState,  kind: 'service' },
    { id: 'vpn',       label: 'nostr-vpn',   value: vpnRow.value,                                                                        ok: vpnRow.ok,    state: vpnRow.state,  kind: 'service' },
    { id: 'watchdog',  label: 'watchdog',    value: wdRow.value,                                                                         ok: wdRow.ok,     state: wdRow.state,   kind: 'service' },
    // Binaries — CLI tools; installed or not.
    { id: 'ngit',      label: 'ngit',        value: ngitV ?? 'not installed',                                                                ok: !!ngitV,      state: ngitState,    kind: 'binary' },
    { id: 'claude',    label: 'claude-code', value: claudeV  ?? 'not installed',                                                           ok: !!claudeV,    state: claudeState,   kind: 'binary', plugins: gatherClaudePlugins() },
    { id: 'opencode',  label: 'opencode',    value: opencodeV ?? (opencodeBin ? 'installed' : 'not installed'),                              ok: opencodeBin,  state: opencodeState, kind: 'binary' },
    { id: 'nak',       label: 'nak',         value: nakV     ?? 'not installed',                                                           ok: !!nakV,       state: nakState,      kind: 'binary' },
    { id: 'stacks',    label: 'Stacks',      value: stacksV  ?? (stacksBin ? 'installed' : 'not installed'),                               ok: stacksBin,    state: stacksState,   kind: 'binary' },
    { id: 'grain',     label: 'grain',       value: grainValue,                                                                            ok: grainBin,     state: grainState,    kind: 'binary' },
  ];
}

// Pure JSON serializer — also reused by cli.tsx for --json so Ink never mounts.
//
// Output shape:
//   {
//     "Relay":   { ok, value },
//     ...
//     "communities": [ { id, name, port, status, memberCount, ... }, ... ]
//   }
//
// Communities are listed as a top-level array (not a row) because they
// are zero-or-many, not the single "is this service up" pattern the
// other rows follow. `nostr-station status | jq '.communities'`
// returns a clean view; absent when none exist so the JSON stays
// terse for the solo-dev common case.
export function formatStatusJson(rows: ServiceStatus[]): string {
  const out: Record<string, unknown> =
    Object.fromEntries(rows.map(x => [x.label, { ok: x.ok, value: x.value }]));
  try {
    const cs = gatherCommunitiesStatus();
    if (cs.length > 0) out.communities = cs;
  } catch { /* communities subsystem optional — never break status */ }
  return JSON.stringify(out, null, 2);
}

/**
 * Per-community summary surfaced in `nostr-station status --json`.
 * Pure file read — never touches the supervisor, never blocks on I/O
 * beyond fs.readFileSync. Skipped silently when the communities dir
 * doesn't exist yet (the common case for solo-dev users).
 */
function gatherCommunitiesStatus(): Array<{
  id:           string;
  name:         string;
  port:         number;
  status:       string;
  privacyMode:  string;
  memberCount:  number;
}> {
  const list = listCommunities();
  return list.map((c) => ({
    id:          c.id,
    name:        c.name,
    port:        c.port,
    status:      c.status ?? 'stopped',
    privacyMode: c.privacyMode,
    memberCount: listCommunityMembers(c.id).length,
  }));
}

export const Status: React.FC<StatusProps> = ({ json }) => {
  const [rows, setRows] = useState<ServiceStatus[]>([]);

  useEffect(() => {
    const r = gatherStatus();
    setRows(r);
    // Human path: any failing row → non-zero exit so shell callers can
    // gate on `if nostr-station status; then …`. The exit code is set
    // here rather than via process.exit() so Ink finishes its render
    // first; Node uses process.exitCode when the event loop drains.
    // `--json` deliberately keeps exit 0 — the JSON payload itself is
    // the machine-readable answer; CI's status-json smoke depends on
    // exit 0 to inspect the body before classifying.
    if (json) {
      console.log(formatStatusJson(r));
      process.exit(0);
    } else if (!r.every(x => x.ok)) {
      process.exitCode = 1;
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
