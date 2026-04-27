import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { P } from '../onboard/components/palette.js';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readIdentity } from '../lib/identity.js';
import { findBin, hasBin } from '../lib/detect.js';

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

// Pure state mapping for the nostr-vpn row (A4). Three sub-states stack
// underneath the binary-present/absent split:
//
//   binary missing              → err  · "not installed"
//   binary present, no service  → warn · actionable: rerun sudo service install
//   binary present, service ok, no mesh
//                               → warn · "not connected" (peer / firewall)
//   binary present, mesh up     → ok   · tunnel IP
//
// Pre-A4, the cascade collapsed the first two warn shapes into one "not
// connected" line, so a fresh-Linux user who skipped the sudo step at
// onboard saw the same message as someone whose mesh peer was down — and
// neither was actionable. The new middle state surfaces the exact command
// the user needs to run to land the launchd / systemd unit.
//
// Pure + exported so tests can pin every branch without driving shellouts.
export interface NvpnProbe {
  binPresent:    boolean;
  serviceLoaded: boolean;
  meshIp:        string | null;
}
export function nvpnStateFor(p: NvpnProbe): {
  value: string;
  state: ServiceState;
  ok:    boolean;
} {
  if (!p.binPresent) {
    return { value: 'not installed', state: 'err', ok: false };
  }
  if (!p.serviceLoaded) {
    return {
      value: 'installed but service not running — run: sudo nvpn service install',
      state: 'warn',
      ok:    false,
    };
  }
  if (p.meshIp) {
    return { value: p.meshIp, state: 'ok', ok: true };
  }
  return { value: 'not connected', state: 'warn', ok: false };
}

// Every shellout here is on the hot path for /api/status. A single blocking
// call (notably `nvpn status --json` when its daemon socket is wedged)
// stalls the whole Node event loop and the dashboard sees a 10s+ hang.
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

// Exported so cli.tsx can call it directly for --json mode, bypassing Ink.
// Ink would otherwise write UI frames to stdout alongside the JSON payload,
// corrupting any programmatic consumer piping stdout into a parser.
export function gatherStatus(): ServiceStatus[] {
  // `-w 1` is a second belt-and-suspenders timeout — both BSD and GNU nc
  // respect it. Protects against nc variants that ignore our execSync
  // timeout (rare, but cheap insurance).
  const relayUp   = cmd('nc -z -w 1 localhost 8080', 1500) !== null;
  // Binary presence goes through findBin (absolute-path walk) so a fresh
  // Linux install where ~/.cargo/bin isn't on the Node PATH still shows
  // ✓ for installed tools. Version probes spawn the resolved absolute
  // path directly rather than relying on shell PATH lookup.
  const relayPath = findBin('nostr-rs-relay');
  const relayV    = relayPath ? cmd(`${relayPath} --version 2>/dev/null`) : null;

  const nvpnPath  = findBin('nvpn');
  const meshIp    = (() => {
    if (!nvpnPath) return null;
    try {
      // Tighter 1s cap: `nvpn status --json` talks to the nvpn daemon over
      // IPC. On a fresh install the service may be installed but not yet
      // running, which blocks the socket connect indefinitely.
      const out = cmd(`${nvpnPath} status --json`, 1000);
      return out ? JSON.parse(out)?.tunnel_ip ?? null : null;
    } catch { return null; }
  })();

  // A4: distinct "binary present, sudo service install never ran" probe.
  // Different from `meshIp` (mesh tunnel up) and from `nvpn status --json`
  // (daemon socket — answers when the daemon is running, even without a
  // supervised unit). We want the system-supervisor signal: did the
  // launchd/systemd unit actually land? `launchctl list <label>` and
  // `systemctl cat <unit>` both fail fast with non-zero on missing, so
  // either gives us the binary check we need without sudo.
  //
  // nvpn is installed as a SYSTEM service (not --user) on both platforms —
  // `sudo nvpn service install` writes /Library/LaunchDaemons/* on darwin
  // and /etc/systemd/system/* on linux. The probe still works for the
  // current user because `launchctl list` and `systemctl cat` both read
  // public unit metadata.
  const nvpnServiceLoaded = nvpnPath !== null && (
    process.platform === 'darwin'
      ? cmd('launchctl list com.nostr-vpn.nvpn', 1500) !== null
      : cmd('systemctl cat nvpn',                1500) !== null
  );

  const ngitBin   = hasBin('ngit');
  // Station-level "configured" signal is the default nostr relay the user
  // saved in identity.json — set via Config → NGIT in the dashboard. This
  // matches what the dashboard can act on; project-specific ngit remotes
  // are surfaced inside the Projects panel instead.
  const ngitRelay = (() => {
    try { return readIdentity().ngitRelay || ''; }
    catch { return ''; }
  })();

  const claudePath = findBin('claude');
  const claudeV    = claudePath ? cmd(`${claudePath} --version 2>/dev/null`) : null;

  const nakPath   = findBin('nak');
  const nakV      = nakPath ? cmd(`${nakPath} --version 2>/dev/null`) : null;

  const stacksPath = findBin('stacks');
  const stacksBin  = stacksPath !== null;
  const stacksV    = stacksPath ? cmd(`${stacksPath} --version 2>/dev/null`) : null;

  // Watchdog is a launchd interval job on macOS / systemd .timer on linux.
  // No listening socket, no PID between fires — "loaded" is the only signal
  // the OS offers us. On darwin, `launchctl list <label>` exits 0 when the
  // plist is loaded (the interval will fire whenever its schedule hits).
  // On linux, `systemctl --user is-enabled --quiet` confirms the timer is
  // scheduled. Missing / unloaded → err; loaded → ok. No warn state: the
  // "didn't fire recently" case belongs in the Logs panel's stale-log
  // banner, not the sidebar health dot.
  const watchdogLoaded = process.platform === 'darwin'
    ? cmd('launchctl list com.nostr-station.watchdog', 1500) !== null
    : cmd('systemctl --user is-enabled --quiet nostr-watchdog.timer', 1500) !== null;

  const relayBin  = relayPath !== null;
  const nvpnBin   = nvpnPath !== null;
  const claudeBin = claudePath !== null;
  const nakBin    = nakPath !== null;

  // Three-state mapping:
  //   ok   — running + configured
  //   warn — installed but not running/configured
  //   err  — not installed
  const relayState:    ServiceState = relayUp ? 'ok' : relayBin ? 'warn' : 'err';
  const watchdogState: ServiceState = watchdogLoaded ? 'ok' : 'err';
  const ngitState:     ServiceState = ngitBin && ngitRelay ? 'ok' : ngitBin ? 'warn' : 'err';
  const relayBinState: ServiceState = relayBin ? 'ok' : 'err';
  const claudeState:   ServiceState = claudeBin ? 'ok' : 'err';
  const nakState:      ServiceState = nakBin ? 'ok' : 'err';
  const stacksState:   ServiceState = stacksBin ? 'ok' : 'err';

  // nvpn: see nvpnStateFor above for the four-branch decision table.
  const nvpnRow = nvpnStateFor({
    binPresent:    nvpnBin,
    serviceLoaded: nvpnServiceLoaded,
    meshIp,
  });

  return [
    // Services — daemons or scheduled jobs with a runtime state.
    { id: 'relay',     label: 'Relay',       value: relayUp ? 'ws://localhost:8080 ✓' : relayBin ? 'installed (down)' : 'not installed', ok: relayUp,      state: relayState,    kind: 'service' },
    { id: 'vpn',       label: 'nostr-vpn',   value: nvpnRow.value,                                                                       ok: nvpnRow.ok,   state: nvpnRow.state, kind: 'service' },
    { id: 'watchdog',  label: 'watchdog',    value: watchdogLoaded ? 'scheduled · fires every 5m' : 'not installed',                     ok: watchdogLoaded, state: watchdogState, kind: 'service' },
    // Binaries — CLI tools; installed or not. `ngit` is the lone binary with
    // a warn state (installed but no default relay set — configure in Config).
    { id: 'ngit',      label: 'ngit',        value: ngitBin && ngitRelay ? `relay: ${ngitRelay.replace(/^wss?:\/\//, '')}` : ngitBin ? 'not configured' : 'not installed', ok: ngitBin && !!ngitRelay, state: ngitState,    kind: 'binary' },
    { id: 'claude',    label: 'claude-code', value: claudeV  ?? 'not installed',                                                           ok: !!claudeV,    state: claudeState,   kind: 'binary', plugins: gatherClaudePlugins() },
    { id: 'nak',       label: 'nak',         value: nakV     ?? 'not installed',                                                           ok: !!nakV,       state: nakState,      kind: 'binary' },
    { id: 'relay-bin', label: 'relay bin',   value: relayV   ?? 'not installed',                                                           ok: !!relayV,     state: relayBinState, kind: 'binary' },
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
        <Text color={P.muted}>relay logs: </Text>
        <Text>~/logs/nostr-rs-relay.log</Text>
      </Box>
    </Box>
  );
};
