import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { P } from '../cli-ui/palette.js';
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

// Container-mode probes the host OS doesn't apply to. The relay lives in a
// sibling container reachable via Docker DNS (RELAY_HOST).
//
// Pure + exported so tests can drive the row shape without spawning anything.
export interface ContainerStatusInputs {
  relayUp:        boolean;
  relayHost:      string;
  relayPort:      number;
  // Per-tool `--version` output (or null when the binary isn't on PATH /
  // the probe failed). Injected so tests can pin both the present and
  // absent cases without spawning real binaries. Populated in gatherStatus()
  // by shelling `<tool> --version` against the runtime image's PATH.
  binaries?: {
    ngit:   string | null;
    claude: string | null;
    nak:    string | null;
    stacks: string | null;
  };
}

// Compress a multi-line `--version` blob into a single readable line for
// the status row. Most tools print "<name> <semver> [extra]" on the first
// line; the rest is build-info noise users don't need in the panel.
function firstLine(s: string): string {
  return s.split('\n')[0]?.trim() ?? '';
}

function binaryRow(
  id: 'ngit' | 'claude' | 'nak' | 'stacks',
  label: string,
  versionOutput: string | null,
  extras: Partial<ServiceStatus> = {},
): ServiceStatus {
  if (versionOutput && versionOutput.trim()) {
    return {
      id, label, kind: 'binary',
      value: firstLine(versionOutput),
      ok: true, state: 'ok',
      ...extras,
    };
  }
  return {
    id, label, kind: 'binary',
    value: 'not installed in image — rebuild Dockerfile.station',
    ok: false, state: 'warn',
    ...extras,
  };
}

export function gatherStatusContainer(p: ContainerStatusInputs): ServiceStatus[] {
  const relayUrl = `ws://${p.relayHost}:${p.relayPort}`;
  const relayState: ServiceState = p.relayUp ? 'ok' : 'warn';
  const relayValue = p.relayUp
    ? `${relayUrl} ✓`
    : `managed by docker compose — bring up via \`docker compose up relay\``;

  const bins = p.binaries ?? { ngit: null, claude: null, nak: null, stacks: null };

  return [
    { id: 'relay',     label: 'Relay',       value: relayValue,                            ok: p.relayUp,           state: relayState,    kind: 'service' },
    binaryRow('ngit',   'ngit',        bins.ngit),
    binaryRow('claude', 'claude-code', bins.claude, { plugins: gatherClaudePlugins() }),
    binaryRow('nak',    'nak',         bins.nak),
    binaryRow('stacks', 'Stacks',      bins.stacks),
  ];
}

// Exported so cli.tsx can call it directly for --json mode, bypassing Ink.
// Ink would otherwise write UI frames to stdout alongside the JSON payload,
// corrupting any programmatic consumer piping stdout into a parser.
export function gatherStatus(): ServiceStatus[] {
  // Container mode: skip host-OS probes entirely (systemctl/launchctl can't
  // tell us anything useful here) and report on the docker-compose-managed
  // services via env-driven probes.
  if (process.env.STATION_MODE === 'container') {
    const relayHost = process.env.RELAY_HOST || 'localhost';
    const relayPort = Number(process.env.RELAY_PORT || '8080');
    const relayUp   = cmd(`nc -z -w 1 ${relayHost} ${relayPort}`, 1500) !== null;
    // Probe each baked-in dev tool. Dockerfile.station puts them at
    // /usr/local/bin (cargo binary, sha256-verified prebuilt, npm globals);
    // null here means the build skipped a stage or someone bind-mounted
    // over the install — actionable signal for the dashboard, not silence.
    const binaries = {
      ngit:   cmd('ngit --version',   1500),
      claude: cmd('claude --version', 1500),
      nak:    cmd('nak --version',    1500),
      stacks: cmd('stacks --version', 1500),
    };
    return gatherStatusContainer({
      relayUp, relayHost, relayPort, binaries,
    });
  }

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
        <Text color={P.muted}>relay logs: </Text>
        <Text>~/logs/nostr-rs-relay.log</Text>
      </Box>
    </Box>
  );
};
