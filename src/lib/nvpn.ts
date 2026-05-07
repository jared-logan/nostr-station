// nvpn (nostr-vpn) runtime control + log tail.
//
// Companion to nvpn-installer.ts, which only handles the one-time install.
// Everything here is about driving an already-installed binary from the
// dashboard so the user never has to drop into a terminal:
//
//   probeNvpnStatus()   — single source of truth for the Status panel,
//                         the Logs banner, and any /api/nvpn/* read.
//   startNvpn() / stopNvpn() / restartNvpn() — control surface for the
//                         Status row buttons.
//   installNvpnService() — best-effort `sudo -n nvpn service install`
//                         retry from the UI; mirrors the installer's
//                         optional last step.
//   startNvpnLogTail()  — singleton tailer that pumps the daemon log
//                         file into a LogBuffer so /api/logs/vpn shows
//                         live lines instead of the static "tail it
//                         yourself" hint.
//
// Every shell-out uses execa with a fixed argv array — no string
// concatenation into /bin/sh -c — and a tight timeout. The Status panel
// hits this on a 5s tick; a wedged nvpn daemon socket must not block the
// dashboard event loop.

import { execa } from 'execa';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { findBin } from './detect.js';
import type { LogBuffer } from './log-buffer.js';

// ── Lifecycle pub/sub ────────────────────────────────────────────────────
//
// Action helpers (startNvpn / stopNvpn / restartNvpn) emit `state-changed`
// after the daemon transitions, so the Logs-panel SSE can push a fresh
// status frame without forcing the user to refresh. Without this, a
// successful Stop button click left "Running" + tunnel IP visible until
// the next page load. Listeners must tolerate bursts (restart fires twice
// — once for stop, once for start) and slow consequences (probeNvpnStatus
// can take a couple of seconds; the daemon may still be tearing down).
export const nvpnEvents = new EventEmitter();

// ── Status ────────────────────────────────────────────────────────────────

// Schema-flexible — upstream `nvpn status --json` shape has shifted across
// releases. We only depend on `daemon.running` (bool) and `daemon.log_file`
// (string) for control flow; everything else is passed through to the UI
// untouched so a forward-compatible field doesn't require a code change.
export interface NvpnStatusJson {
  daemon?: {
    running?:    boolean;
    log_file?:   string | null;
    pid?:        number | null;
    started_at?: string | null;
    [k: string]: unknown;
  };
  tunnel_ip?:    string | null;
  npub?:         string | null;
  pubkey?:       string | null;
  peers?:        unknown;
  [k: string]:   unknown;
}

export interface NvpnStatus {
  installed:    boolean;
  binPath:      string | null;
  running:      boolean;
  tunnelIp:     string | null;
  raw:          NvpnStatusJson | null;
  error:        string | null;
  fetchedAt:    number;
}

// `nvpn status --json` walks the relay set + collects session state, so a
// healthy daemon under modest load can take a couple of seconds. Tighter
// budgets (we ran with 1.5s previously) caused the dashboard to flap the
// "stopped" banner whenever the probe stalled briefly, even with the
// daemon clearly running per systemd. 4s gives the daemon room and stays
// well under the 5s status tick.
const STATUS_TIMEOUT_MS = 4_000;
const CONTROL_TIMEOUT_MS = 20_000;

export async function probeNvpnStatus(): Promise<NvpnStatus> {
  const binPath = findBin('nvpn');
  const fetchedAt = Date.now();
  if (!binPath) {
    return {
      installed: false, binPath: null, running: false,
      tunnelIp: null, raw: null, error: null, fetchedAt,
    };
  }
  let raw: NvpnStatusJson | null = null;
  let error: string | null = null;
  try {
    const { stdout } = await execa(binPath, ['status', '--json'], {
      timeout: STATUS_TIMEOUT_MS, stdio: 'pipe',
    });
    try { raw = JSON.parse(stdout); }
    catch (e: any) { error = `unparseable status JSON: ${(e?.message || '').slice(0, 120)}`; }
  } catch (e: any) {
    // execa surfaces both timeout and non-zero exit via thrown errors. We
    // collapse both to a short single-line string for the UI. NB: a probe
    // failure leaves `running: false` because we never saw a daemon.running
    // payload — but consumers must NOT read that as "daemon stopped" on its
    // own. A wedged or slow socket on a healthy daemon hits this same
    // branch; the banner code in web-server.ts cross-checks
    // probeNvpnServiceStatus() before flipping the user-facing pill.
    error = (e?.shortMessage || e?.message || String(e)).slice(0, 240);
  }
  const running  = !!raw?.daemon?.running;
  const tunnelIp = (raw?.tunnel_ip as string) ?? null;
  return { installed: true, binPath, running, tunnelIp, raw, error, fetchedAt };
}

// ── Control ───────────────────────────────────────────────────────────────

export interface ControlResult {
  ok:     boolean;
  detail: string;
}

function summarizeError(e: any): string {
  const stderr = e?.stderr?.toString?.() || '';
  const msg    = e?.shortMessage || e?.message || String(e);
  return (stderr.trim() || msg).slice(0, 240);
}

export async function startNvpn(): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    await execa(binPath, ['start', '--daemon'], { timeout: CONTROL_TIMEOUT_MS, stdio: 'pipe' });
    return { ok: true, detail: 'nvpn daemon started' };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  } finally {
    // Emit even on failure — the daemon may have partially transitioned
    // (e.g. socket bound but config rejected) and the SSE consumer wants
    // to see the new probe result regardless.
    nvpnEvents.emit('state-changed');
  }
}

export async function stopNvpn(): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    await execa(binPath, ['stop'], { timeout: CONTROL_TIMEOUT_MS, stdio: 'pipe' });
    return { ok: true, detail: 'nvpn daemon stopped' };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  } finally {
    nvpnEvents.emit('state-changed');
  }
}

export async function restartNvpn(): Promise<ControlResult> {
  const stop = await stopNvpn();
  // Best-effort stop — proceed to start either way. If the daemon was
  // already down `nvpn stop` exits non-zero, but a fresh start is still
  // the right outcome from a UI button labelled "restart."
  const start = await startNvpn();
  if (!start.ok) return { ok: false, detail: start.detail };
  return { ok: true, detail: stop.ok ? 'restarted' : `started (stop hint: ${stop.detail})` };
}

// ── System service lifecycle ─────────────────────────────────────────────
//
// `nvpn service install` writes a systemd unit (linux) or launchd plist
// (darwin) so the daemon survives reboot. install / enable / disable /
// uninstall all need root for the system paths involved (/etc/systemd/
// system, /Library/LaunchDaemons), so each shells through `sudo -n`.
// Empty cred cache → fails fast with a clear stderr we surface in the
// toast hint, mirroring the install pattern.
//
// `service status --json` is unprivileged — the dashboard polls it as
// the source of truth for the meta strip's four-pill display
// (installed / enabled at boot / loaded / running).

const SERVICE_STATUS_TIMEOUT_MS = 4_000;
const SERVICE_OP_TIMEOUT_MS     = 30_000;

export interface NvpnServiceStatus {
  supported:     boolean;
  installed:     boolean;
  // `disabled` is a system-supervisor concept: the unit is installed
  // but won't auto-start at boot. Inverse of "enabled at boot."
  disabled:      boolean;
  loaded:        boolean;
  running:       boolean;
  pid:           number | null;
  label:         string | null;
  plistPath:     string | null;
  binaryPath:    string | null;
  binaryVersion: string | null;
  raw:           Record<string, unknown> | null;
  error:         string | null;
}

export async function probeNvpnServiceStatus(): Promise<NvpnServiceStatus> {
  const binPath = findBin('nvpn');
  if (!binPath) {
    return {
      supported: false, installed: false, disabled: false, loaded: false, running: false,
      pid: null, label: null, plistPath: null, binaryPath: null, binaryVersion: null,
      raw: null, error: 'nvpn binary not installed',
    };
  }
  try {
    const { stdout } = await execa(binPath, ['service', 'status', '--json'], {
      timeout: SERVICE_STATUS_TIMEOUT_MS, stdio: 'pipe',
    });
    let raw: Record<string, unknown> | null = null;
    try { raw = JSON.parse(stdout); }
    catch { return svcErrorResponse('unparseable service status JSON'); }
    return {
      supported:     !!raw?.supported,
      installed:     !!raw?.installed,
      disabled:      !!raw?.disabled,
      loaded:        !!raw?.loaded,
      running:       !!raw?.running,
      pid:           typeof raw?.pid === 'number' ? raw.pid : null,
      label:         typeof raw?.label === 'string' ? raw.label : null,
      plistPath:     typeof raw?.plist_path === 'string' ? raw.plist_path : null,
      binaryPath:    typeof raw?.binary_path === 'string' ? raw.binary_path : null,
      binaryVersion: typeof raw?.binary_version === 'string' ? raw.binary_version : null,
      raw,
      error:         null,
    };
  } catch (e: any) {
    return svcErrorResponse(summarizeError(e));
  }
}

function svcErrorResponse(error: string): NvpnServiceStatus {
  return {
    supported: false, installed: false, disabled: false, loaded: false, running: false,
    pid: null, label: null, plistPath: null, binaryPath: null, binaryVersion: null,
    raw: null, error,
  };
}

// `sudo -n` so it fails fast on an empty cred cache. The dashboard runs
// without a TTY for prompting; the user has to have run a sudo command
// in the same shell session shortly beforehand for this to succeed.
async function runServiceOp(
  op: 'install' | 'enable' | 'disable' | 'uninstall',
): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    await execa('sudo', ['-n', binPath, 'service', op], {
      timeout: SERVICE_OP_TIMEOUT_MS, stdio: 'pipe',
    });
    return { ok: true, detail: `service ${op} ok` };
  } catch (e: any) {
    const stderr = (e?.stderr?.toString?.() || '').trim();
    const needsPassword = /password is required|sudo:.*required/i.test(stderr);
    if (needsPassword) {
      return {
        ok: false,
        detail: `sudo cred cache empty — run \`sudo ${binPath} service ${op}\` manually, ` +
                `then refresh the dashboard.`,
      };
    }
    return { ok: false, detail: summarizeError(e) };
  }
}

export const installNvpnService = (): Promise<ControlResult> => runServiceOp('install');
export const enableNvpnService  = (): Promise<ControlResult> => runServiceOp('enable');
export const disableNvpnService = (): Promise<ControlResult> => runServiceOp('disable');
export const uninstallNvpnService = (): Promise<ControlResult> => runServiceOp('uninstall');

// `nvpn uninstall-cli` removes the binary itself from PATH (mirror of
// nvpn install-cli, which the installer runs to drop nvpn into
// /usr/local/bin or /opt/homebrew/bin). May or may not need sudo
// depending on the install location; we try sudo -n first and fall
// back to a non-sudo invocation when the path is user-writable.
export async function uninstallNvpnCli(): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  // Try without sudo first — most setups have nvpn in ~/.cargo/bin
  // (user-writable) which doesn't need root.
  try {
    await execa(binPath, ['uninstall-cli'], { timeout: 15_000, stdio: 'pipe' });
    return { ok: true, detail: 'cli removed from PATH' };
  } catch { /* try with sudo */ }
  try {
    await execa('sudo', ['-n', binPath, 'uninstall-cli'], { timeout: 15_000, stdio: 'pipe' });
    return { ok: true, detail: 'cli removed from PATH (via sudo)' };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  }
}

// ── Configured roster (config.toml) ──────────────────────────────────────
//
// `nvpn status --json` reports LIVE peer state (connected, latency, etc.)
// but not the configured roster — the user-managed list of npubs that
// belong to the network. The roster lives in nvpn's config file as a
// TOML `[[networks]]` block. We read it directly so the dashboard can
// render "configured but disconnected" peers (the common case during
// onboarding) instead of waiting for everyone to come online.
//
// We avoid a TOML dep — the keys we care about (`network_id`,
// `participants`, `admins`) are flat string + array-of-strings entries
// inside a single section; a tight regex over the first `[[networks]]`
// section is sufficient and resilient to TOML field reordering.

export interface NvpnRoster {
  found:        boolean;
  configPath:   string | null;
  networkId:    string | null;
  participants: string[];
  admins:       string[];
  // Per-node `[peer_aliases]` table — local metadata, not synced over
  // the mesh. Keys are npubs (or hex), values are user-chosen labels
  // ("alice", "laptop", "vps-frankfurt"). Each station owner manages
  // their own; one user's "giraffe" might be another's "alice."
  aliases:      Record<string, string>;
}

function nvpnConfigCandidates(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.config', 'nvpn', 'config.toml'),
    path.join(home, 'Library', 'Application Support', 'nvpn', 'config.toml'),
  ];
}

function findNvpnConfigPath(): string | null {
  for (const p of nvpnConfigCandidates()) {
    try { fs.accessSync(p, fs.constants.R_OK); return p; }
    catch { /* try next */ }
  }
  return null;
}

// Extract the first `[[networks]]` block — the active network for our
// purposes. nvpn supports multi-network configs; we surface the first
// for the dashboard, which is what `nvpn add-participant` (no flag)
// also targets.
export function extractFirstNetworksSection(toml: string): string {
  const idx = toml.indexOf('[[networks]]');
  if (idx < 0) return toml;
  const after = toml.slice(idx + '[[networks]]'.length);
  // Stop at the next top-level table heading so we don't bleed into
  // [peer_aliases], [nat], [nostr], etc.
  const m = after.search(/^\s*\[(?:\[)?/m);
  return m >= 0 ? after.slice(0, m) : after;
}

// Extract the `[peer_aliases]` table (key/value pairs of npub → label).
// Returns the section body (without the header) so the caller can
// parse keys with `extractAliasMap`. Empty string when the section
// isn't present.
//
// Implemented as two-step search instead of a single regex because the
// /m flag makes `$` match end-of-LINE, which cuts the body too short
// for multi-line tables. The single-character search bounds at the
// next `[` at line start (next section header), or end of file.
export function extractPeerAliasesSection(toml: string): string {
  const header = toml.match(/^\s*\[peer_aliases\][^\S\r\n]*\r?\n?/m);
  if (!header || header.index === undefined) return '';
  const rest = toml.slice(header.index + header[0].length);
  const nextHeader = rest.search(/^\s*\[(?:\[)?/m);
  return nextHeader >= 0 ? rest.slice(0, nextHeader) : rest;
}

// Parse a `[peer_aliases]` body into a Record. nvpn's TOML uses bare
// keys (npubs are valid bare-key chars per TOML spec) and quoted
// string values, so a per-line `<key> = "<value>"` regex is enough.
// Lines that don't match (comments, blanks, future fields) are
// skipped silently.
export function extractAliasMap(sectionBody: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^\s*([A-Za-z0-9_\-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/gm;
  for (const m of sectionBody.matchAll(re)) {
    const key   = m[1];
    const value = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    if (key && value) out[key] = value;
  }
  return out;
}

export function extractTomlList(section: string, key: string): string[] {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm');
  const m = section.match(re);
  if (!m) return [];
  const out: string[] = [];
  for (const sm of m[1].matchAll(/"([^"]+)"/g)) out.push(sm[1]);
  return out;
}

export function extractTomlString(section: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm');
  const m = section.match(re);
  return m ? m[1] : null;
}

export function readNvpnRoster(): NvpnRoster {
  const configPath = findNvpnConfigPath();
  if (!configPath) {
    return { found: false, configPath: null, networkId: null, participants: [], admins: [], aliases: {} };
  }
  let toml = '';
  try { toml = fs.readFileSync(configPath, 'utf8'); }
  catch {
    return { found: false, configPath, networkId: null, participants: [], admins: [], aliases: {} };
  }
  const section = extractFirstNetworksSection(toml);
  const aliasBody = extractPeerAliasesSection(toml);
  return {
    found:        true,
    configPath,
    networkId:    extractTomlString(section, 'network_id'),
    participants: extractTomlList(section, 'participants'),
    admins:       extractTomlList(section, 'admins'),
    aliases:      extractAliasMap(aliasBody),
  };
}

// ── Discovery relays (Nostr presence/signaling) ──────────────────────
//
// nvpn discovers peers by publishing/subscribing to presence events on a
// configured set of Nostr relays. Out-of-the-box defaults
// (relay.snort.social, temp.iris.to, …) flake intermittently with 504
// Gateway Timeouts and the dashboard had no surface for swapping them
// without hand-editing TOML. This block pairs read-from-disk + write-via-
// CLI: we parse the current list straight out of config.toml so the UI
// can render even when the daemon is down, and we mutate via
// `nvpn set --relay <url>` so persistence + reload semantics match
// every other settings change.
//
// Storage location is the `[[networks]]` block's `relays = […]` entry —
// same scoping as participants/admins. We try [nostr] as a fallback for
// older configs that put the relay set at the top level; if neither
// matches we return [] and let the user populate via the UI (the very
// first `nvpn set --relay` call will create the entry correctly).

export interface NvpnRelays {
  found:      boolean;
  configPath: string | null;
  relays:     string[];
}

// Pure helper — extract the relay list from the parsed sections of a
// config.toml. Tries the [[networks]] section first (current schema),
// then a [nostr] section (legacy). Exported for unit tests.
export function extractNvpnRelays(toml: string): string[] {
  const networksSection = extractFirstNetworksSection(toml);
  const fromNetworks = extractTomlList(networksSection, 'relays');
  if (fromNetworks.length > 0) return fromNetworks;
  // Legacy fallback — older configs put `relays = [...]` directly under
  // a top-level `[nostr]` table. Slice that section out the same way
  // extractPeerAliasesSection does, then run extractTomlList against it.
  const nostrHdr = toml.match(/^\s*\[nostr\][^\S\r\n]*\r?\n?/m);
  if (!nostrHdr || nostrHdr.index === undefined) return [];
  const rest = toml.slice(nostrHdr.index + nostrHdr[0].length);
  const next = rest.search(/^\s*\[(?:\[)?/m);
  const body = next >= 0 ? rest.slice(0, next) : rest;
  return extractTomlList(body, 'relays');
}

export function readNvpnRelays(): NvpnRelays {
  const configPath = findNvpnConfigPath();
  if (!configPath) return { found: false, configPath: null, relays: [] };
  let toml = '';
  try { toml = fs.readFileSync(configPath, 'utf8'); }
  catch { return { found: false, configPath, relays: [] }; }
  return { found: true, configPath, relays: extractNvpnRelays(toml) };
}

// Validation: wss://… or ws://… up to a reasonable max length. We keep
// the regex tight on protocol and host shape but defer the deeper
// "is this a real relay" question to nvpn itself — a bad URL gets
// surfaced on the next netcheck/probe rather than blocked client-side.
const RELAY_URL_RE = /^wss?:\/\/[A-Za-z0-9.\-_:[\]/?&=%~+]+$/;
const RELAY_URL_MAX = 256;
export function isValidRelayUrl(s: unknown): s is string {
  return typeof s === 'string'
    && s.length > 0
    && s.length <= RELAY_URL_MAX
    && RELAY_URL_RE.test(s);
}

// Build the argv for `nvpn set` given a desired full relay list.
// Pure + exported so tests can pin the shape without a binary on PATH.
// `nvpn set --relay <url>` is repeatable (same shape as --participant
// in add-participant), and a single `nvpn set` call rewrites the
// list to exactly the args provided. Empty list → caller should not
// invoke (nvpn would refuse / the user would lose connectivity); we
// guard that at the route layer with a clear error.
export function buildSetRelaysArgs(relays: string[]): string[] {
  const args: string[] = ['set'];
  for (const r of relays) { args.push('--relay', r); }
  args.push('--json');
  return args;
}

export interface NvpnRelaysResult extends ControlResult {
  relays?: string[];
  raw?:    Record<string, unknown> | null;
}

// Replace the entire relay list. Single `nvpn set` invocation; the
// daemon picks up the new set on the next reload (we follow with
// `nvpn reload` best-effort, mirroring the alias mutation path).
//
// Refuses empty input — clearing the relay set would strand the
// node (presence won't publish, peers won't be discovered). The
// caller wanting to reset should remove relays one at a time and
// stop before the last.
export async function setNvpnRelays(relays: string[]): Promise<NvpnRelaysResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  const cleaned = relays.map(s => String(s).trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return { ok: false, detail: 'refusing to clear the entire relay list — keep at least one' };
  }
  const bad = cleaned.filter(r => !isValidRelayUrl(r));
  if (bad.length > 0) {
    return {
      ok: false,
      detail: `invalid relay URL${bad.length > 1 ? 's' : ''}: ${bad.slice(0, 3).join(', ')}` +
              (bad.length > 3 ? ` (+${bad.length - 3} more)` : ''),
    };
  }
  // De-dup while preserving order — nvpn would probably accept dupes
  // but the visible state should match what the user intended.
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const r of cleaned) { if (!seen.has(r)) { seen.add(r); unique.push(r); } }

  try {
    const { stdout } = await execa(binPath, buildSetRelaysArgs(unique), {
      timeout: 10_000, stdio: 'pipe',
    });
    let raw: Record<string, unknown> | null = null;
    try { raw = JSON.parse(stdout); } catch { /* nvpn may return non-JSON for `set`; treat as best-effort */ }
    // Best-effort reload so the running daemon picks up the new set
    // without a Stop/Start cycle.
    await reloadNvpn().catch(() => null);
    return { ok: true, detail: `relay list updated (${unique.length})`, relays: unique, raw };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  }
}

export async function addNvpnRelay(url: string): Promise<NvpnRelaysResult> {
  if (!isValidRelayUrl(url)) {
    return { ok: false, detail: 'invalid relay URL — must be ws:// or wss://' };
  }
  const current = readNvpnRelays();
  if (current.relays.includes(url)) {
    return { ok: true, detail: 'relay already in list', relays: current.relays };
  }
  return setNvpnRelays([...current.relays, url]);
}

export async function removeNvpnRelay(url: string): Promise<NvpnRelaysResult> {
  const current = readNvpnRelays();
  if (!current.relays.includes(url)) {
    return { ok: true, detail: 'relay was not in list', relays: current.relays };
  }
  const next = current.relays.filter(r => r !== url);
  if (next.length === 0) {
    return { ok: false, detail: 'refusing to remove the last relay — add a replacement first' };
  }
  return setNvpnRelays(next);
}

// ── Alias mutation (config.toml [peer_aliases] table) ──────────────
//
// nvpn has no CLI command for aliases — the `[peer_aliases]` table is
// edited directly. We do the safest thing we can without a TOML lib:
//   1. Read current contents.
//   2. Rebuild the [peer_aliases] section line by line from the current
//      alias map plus the requested mutation. Other sections of the file
//      are preserved verbatim.
//   3. Write atomically (temp file + rename) so a crash mid-write can't
//      truncate the user's config.
//   4. Caller (route handler) follows up with `nvpn reload` so the
//      daemon picks up the new label without a restart.
//
// Validation contract: alias values are restricted to printable ASCII
// (letters, digits, dash, underscore, space, dot) up to 64 chars.
// That covers the realistic naming use cases without opening surface
// for confusable Unicode or TOML-escape exploits.

const ALIAS_MAX_LEN = 64;
const ALIAS_VALUE_RE = /^[A-Za-z0-9 _\-.]{1,64}$/;

export function isValidAliasValue(v: string): boolean {
  return typeof v === 'string' && ALIAS_VALUE_RE.test(v);
}

// Rebuild a TOML doc with an updated [peer_aliases] table. Pure for
// testability — caller handles the actual fs read/write. `next` is
// the desired complete alias map (the route handler computes this
// by merging the current state with the requested mutation).
export function rebuildTomlWithAliases(
  toml: string,
  next: Record<string, string>,
): string {
  // Build the replacement section body. Empty map → keep the header
  // but write zero entries; we'd rather have an empty `[peer_aliases]`
  // table than special-case header insertion later.
  const bodyLines: string[] = [];
  const keys = Object.keys(next).sort();
  for (const k of keys) {
    const v = next[k];
    // Defensive escape for backslash + quote even though our validator
    // rules these out — config.toml may have been hand-edited.
    const escaped = v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    bodyLines.push(`${k} = "${escaped}"`);
  }
  const newBody = bodyLines.length > 0 ? bodyLines.join('\n') + '\n' : '';
  const newSection = `[peer_aliases]\n${newBody}`;

  // Replace existing section if present, otherwise append at end of
  // file (prefix with a blank line for readability).
  const sectionRe = /^\s*\[peer_aliases\][\s\S]*?(?=^\s*\[(?:\[)?|$(?![\r\n]))/m;
  if (sectionRe.test(toml)) {
    return toml.replace(sectionRe, newSection);
  }
  // Ensure trailing newline before appending.
  const sep = toml.endsWith('\n') ? '\n' : '\n\n';
  return toml + sep + newSection;
}

interface AliasWriteResult {
  ok:       boolean;
  detail:   string;
  aliases?: Record<string, string>;
}

// Apply a mutation (set or remove one alias) to the current config.
// Returns the new alias map. Atomic write — temp file + rename — so a
// concurrent reader never sees a half-rewritten file.
function mutateAliases(
  mutator: (current: Record<string, string>) => Record<string, string>,
): AliasWriteResult {
  const configPath = findNvpnConfigPath();
  if (!configPath) return { ok: false, detail: 'no nvpn config.toml found — run `nvpn init` first' };
  let toml = '';
  try { toml = fs.readFileSync(configPath, 'utf8'); }
  catch (e: any) { return { ok: false, detail: `read failed: ${(e?.message || '').slice(0, 160)}` }; }
  const current = extractAliasMap(extractPeerAliasesSection(toml));
  const next    = mutator({ ...current });
  if (JSON.stringify(next) === JSON.stringify(current)) {
    return { ok: true, detail: 'no change', aliases: current };
  }
  const updated = rebuildTomlWithAliases(toml, next);
  // Atomic write: tmp file in the same dir → rename. Same dir matters
  // because rename across filesystems isn't atomic.
  const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, updated, { mode: 0o600 });
    fs.renameSync(tmp, configPath);
  } catch (e: any) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { ok: false, detail: `write failed: ${(e?.message || '').slice(0, 160)}` };
  }
  return { ok: true, detail: 'aliases updated', aliases: next };
}

export function setNvpnAlias(participant: string, alias: string): AliasWriteResult {
  if (!isValidParticipant(participant)) {
    return { ok: false, detail: 'invalid participant pubkey' };
  }
  if (!isValidAliasValue(alias)) {
    return {
      ok: false,
      detail: `alias must be 1–${ALIAS_MAX_LEN} chars, letters/digits/space/-_./ only`,
    };
  }
  return mutateAliases(map => ({ ...map, [participant]: alias }));
}

export function removeNvpnAlias(participant: string): AliasWriteResult {
  if (!isValidParticipant(participant)) {
    return { ok: false, detail: 'invalid participant pubkey' };
  }
  return mutateAliases(map => {
    const out = { ...map };
    delete out[participant];
    return out;
  });
}

// ── Roster + invites + whois ─────────────────────────────────────────────
//
// nvpn 0.3.x organises peers into a network roster: a set of `participants`
// (regular peers) plus a subset marked `admins`. Roster mutations are local
// until you pass `--publish`, which broadcasts the admin-signed roster
// over Nostr. The dashboard treats `publish` as a per-call flag — the UI
// defaults to publish-on-add (matches expected mental model: "I added a
// peer, of course they should now see me") but exposes it as a checkbox
// for power users staging changes locally.

const ROSTER_TIMEOUT_MS = 20_000;
const INVITE_TIMEOUT_MS = 10_000;
// whois may walk Nostr relays for peer metadata when --discover-secs is
// non-zero. We cap aggressively because the dashboard's a synchronous
// click; users can re-run if the daemon needs more time.
const WHOIS_TIMEOUT_MS = 6_000;

// Accepts both bech32 (npub1…) and lowercase hex (64 chars). nvpn itself
// is more forgiving (accepts mixed-case hex too) but the dashboard
// validates strictly so we never ship "Invalid public key" stack traces
// from the binary into the toast UI.
const NPUB_RE = /^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/;
const HEX_RE  = /^[0-9a-f]{64}$/i;
export function isValidParticipant(s: string): boolean {
  if (!s || typeof s !== 'string') return false;
  return NPUB_RE.test(s) || HEX_RE.test(s);
}

// Schema-flexible parser for `--json` output. Most roster commands emit
// `{ network_id, participants[], admins[], changed[], published_recipients,
// published, relays[] }`. Surface the whole thing back to the UI; only
// the `published` flag drives our toast wording.
export interface RosterMutationResult extends ControlResult {
  raw?:                   Record<string, unknown> | null;
  published?:             boolean;
  publishedRecipients?:   number;
  changed?:               string[];
}

async function runRosterCommand(
  cmd: 'add-participant' | 'remove-participant' | 'add-admin' | 'remove-admin',
  participants: string[],
  publish: boolean,
): Promise<RosterMutationResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  const cleaned = participants.map(s => String(s).trim()).filter(Boolean);
  if (cleaned.length === 0) return { ok: false, detail: 'no participants provided' };
  const bad = cleaned.filter(p => !isValidParticipant(p));
  if (bad.length > 0) {
    return {
      ok: false,
      detail: `invalid participant${bad.length > 1 ? 's' : ''}: ${bad.slice(0, 3).join(', ')}` +
              (bad.length > 3 ? ` (+${bad.length - 3} more)` : ''),
    };
  }
  // Argv shape: nvpn <cmd> --participant <p1> --participant <p2> [--publish] --json
  const args: string[] = [cmd];
  for (const p of cleaned) { args.push('--participant', p); }
  if (publish) args.push('--publish');
  args.push('--json');

  try {
    const { stdout } = await execa(binPath, args, {
      timeout: ROSTER_TIMEOUT_MS, stdio: 'pipe',
    });
    let raw: Record<string, unknown> | null = null;
    try { raw = JSON.parse(stdout); } catch { /* keep raw=null, surface ok with no metadata */ }
    const published          = !!(raw?.published);
    const publishedRecipients = typeof raw?.published_recipients === 'number'
      ? raw.published_recipients : undefined;
    const changed = Array.isArray(raw?.changed)
      ? (raw.changed as unknown[]).filter(x => typeof x === 'string') as string[]
      : undefined;
    const detail = published
      ? `roster updated and published${publishedRecipients ? ` to ${publishedRecipients} recipient${publishedRecipients === 1 ? '' : 's'}` : ''}`
      : 'roster updated locally (not published)';
    return { ok: true, detail, raw, published, publishedRecipients, changed };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  }
}

export function addParticipants(participants: string[], publish: boolean): Promise<RosterMutationResult> {
  return runRosterCommand('add-participant', participants, publish);
}
export function removeParticipants(participants: string[], publish: boolean): Promise<RosterMutationResult> {
  return runRosterCommand('remove-participant', participants, publish);
}
export function addAdmins(participants: string[], publish: boolean): Promise<RosterMutationResult> {
  return runRosterCommand('add-admin', participants, publish);
}
export function removeAdmins(participants: string[], publish: boolean): Promise<RosterMutationResult> {
  return runRosterCommand('remove-admin', participants, publish);
}

export interface PublishRosterResult extends ControlResult {
  raw?: Record<string, unknown> | null;
}
export async function publishRoster(): Promise<PublishRosterResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    const { stdout } = await execa(binPath, ['publish-roster', '--json'], {
      timeout: ROSTER_TIMEOUT_MS, stdio: 'pipe',
    });
    let raw: Record<string, unknown> | null = null;
    try { raw = JSON.parse(stdout); } catch { /* keep null */ }
    return { ok: true, detail: 'roster published', raw };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  }
}

export interface InviteResult extends ControlResult {
  invite?:    string;
  networkId?: string;
  raw?:       Record<string, unknown> | null;
}
export async function createInvite(): Promise<InviteResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    const { stdout } = await execa(binPath, ['create-invite', '--json'], {
      timeout: INVITE_TIMEOUT_MS, stdio: 'pipe',
    });
    let raw: Record<string, unknown> | null = null;
    try { raw = JSON.parse(stdout); } catch { /* nothing */ }
    const invite    = typeof raw?.invite === 'string' ? (raw.invite as string) : undefined;
    const networkId = typeof raw?.network_id === 'string' ? (raw.network_id as string) : undefined;
    if (!invite) return { ok: false, detail: 'create-invite returned no invite string', raw };
    return { ok: true, detail: 'invite created', invite, networkId, raw };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  }
}

export async function importInvite(invite: string): Promise<InviteResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  const trimmed = String(invite || '').trim();
  // Light client-side validation. nvpn will reject malformed strings, but
  // we'd rather fail fast with a sensible toast than render a Rust panic
  // backtrace from the binary.
  if (!/^nvpn:\/\/invite\//.test(trimmed)) {
    return { ok: false, detail: 'invite must start with nvpn://invite/' };
  }
  try {
    const { stdout } = await execa(binPath, ['import-invite', trimmed, '--json'], {
      timeout: INVITE_TIMEOUT_MS, stdio: 'pipe',
    });
    let raw: Record<string, unknown> | null = null;
    try { raw = JSON.parse(stdout); } catch { /* nothing */ }
    const networkId = typeof raw?.network_id === 'string' ? (raw.network_id as string) : undefined;
    return { ok: true, detail: 'invite imported', networkId, raw };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  }
}

export interface WhoisResult extends ControlResult {
  raw?: Record<string, unknown> | null;
}
export async function whoisPeer(query: string): Promise<WhoisResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  const trimmed = String(query || '').trim();
  if (!trimmed) return { ok: false, detail: 'empty query' };
  // discover-secs 0 keeps the call snappy when run from a click; the
  // local roster + cached peer state is usually enough to resolve.
  try {
    const { stdout } = await execa(
      binPath, ['whois', trimmed, '--discover-secs', '0', '--json'],
      { timeout: WHOIS_TIMEOUT_MS, stdio: 'pipe' },
    );
    let raw: Record<string, unknown> | null = null;
    try { raw = JSON.parse(stdout); } catch { /* nothing */ }
    return { ok: true, detail: 'whois ok', raw };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  }
}

// ── Lifecycle: pause / resume / reload (Feature 3) ───────────────────────
//
// Less destructive than stop. `pause` flips the data plane off without
// killing the daemon (faster resume; daemon stays in the relay's
// presence list). `reload` re-reads config + roster after an out-of-band
// edit. All three are unprivileged.

export async function pauseNvpn(): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    await execa(binPath, ['pause'], { timeout: CONTROL_TIMEOUT_MS, stdio: 'pipe' });
    return { ok: true, detail: 'nvpn paused' };
  } catch (e: any) { return { ok: false, detail: summarizeError(e) }; }
}

export async function resumeNvpn(): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    await execa(binPath, ['resume'], { timeout: CONTROL_TIMEOUT_MS, stdio: 'pipe' });
    return { ok: true, detail: 'nvpn resumed' };
  } catch (e: any) { return { ok: false, detail: summarizeError(e) }; }
}

export async function reloadNvpn(): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    await execa(binPath, ['reload'], { timeout: CONTROL_TIMEOUT_MS, stdio: 'pipe' });
    return { ok: true, detail: 'nvpn config reloaded' };
  } catch (e: any) { return { ok: false, detail: summarizeError(e) }; }
}

export async function repairNvpnNetwork(): Promise<ControlResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    await execa(binPath, ['repair-network'], { timeout: CONTROL_TIMEOUT_MS, stdio: 'pipe' });
    return { ok: true, detail: 'network state repaired' };
  } catch (e: any) { return { ok: false, detail: summarizeError(e) }; }
}

// ── Diagnostics: ping / netcheck / doctor / nat-discover ─────────────────

export interface PingOptions {
  count?:       number;
  timeoutSecs?: number;
}
export interface PingResult extends ControlResult {
  output?: string;
}
export async function pingNvpnPeer(target: string, opts: PingOptions = {}): Promise<PingResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  const trimmed = String(target || '').trim();
  if (!trimmed) return { ok: false, detail: 'empty ping target' };
  // ping is plain text output (not JSON) — mirror the binary's wire
  // format and return it verbatim. Caller renders inline.
  const count       = clampInt(opts.count, 1, 10, 3);
  const timeoutSecs = clampInt(opts.timeoutSecs, 1, 30, 2);
  // Total cap = (count * timeoutSecs) + 2s slack. nvpn's ping respects
  // its --timeout-secs per-attempt; we add a hard ceiling so a wedged
  // socket doesn't block the dashboard click.
  const totalCap = (count * timeoutSecs * 1000) + 2_000;
  try {
    const { stdout, stderr } = await execa(
      binPath,
      ['ping', trimmed, '--count', String(count), '--timeout-secs', String(timeoutSecs)],
      { timeout: totalCap, stdio: 'pipe' },
    );
    return { ok: true, detail: 'ping ok', output: (stdout || stderr || '').slice(0, 4000) };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e), output: (e?.stdout || '').slice(0, 4000) };
  }
}

export interface DiagResult extends ControlResult {
  raw?: Record<string, unknown> | null;
}

const NETCHECK_TIMEOUT_MS = 8_000;
const DOCTOR_TIMEOUT_MS   = 30_000;

export async function netcheckNvpn(): Promise<DiagResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    const { stdout } = await execa(binPath, ['netcheck', '--json'], {
      timeout: NETCHECK_TIMEOUT_MS, stdio: 'pipe',
    });
    let raw: Record<string, unknown> | null = null;
    try { raw = JSON.parse(stdout); } catch { /* keep null */ }
    return { ok: true, detail: 'netcheck ok', raw };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  }
}

export interface DoctorOptions {
  writeBundle?: boolean;
}
export interface DoctorResult extends DiagResult {
  bundlePath?: string;
}
export async function doctorNvpn(opts: DoctorOptions = {}): Promise<DoctorResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  const args = ['doctor', '--json'];
  let bundlePath: string | undefined;
  if (opts.writeBundle) {
    // Drop the bundle alongside the install log so post-mortems have
    // one place to look. Stamp + extension match nvpn's expected output.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    bundlePath = path.join(os.homedir(), 'logs', `nvpn-doctor-${stamp}.tgz`);
    try { fs.mkdirSync(path.dirname(bundlePath), { recursive: true }); } catch { /* fine */ }
    args.push('--write-bundle', bundlePath);
  }
  try {
    const { stdout } = await execa(binPath, args, {
      timeout: DOCTOR_TIMEOUT_MS, stdio: 'pipe',
    });
    let raw: Record<string, unknown> | null = null;
    try { raw = JSON.parse(stdout); } catch { /* keep null */ }
    return { ok: true, detail: 'doctor ok', raw, bundlePath };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e), bundlePath };
  }
}

export async function natDiscoverNvpn(reflector: string, listenPort?: number): Promise<DiagResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  const trimmed = String(reflector || '').trim();
  // host:port — port range 1–65535. We don't try to validate the host
  // beyond non-empty; nvpn will surface a clearer error than ours.
  if (!/^[A-Za-z0-9.\-:[\]]+:\d{1,5}$/.test(trimmed)) {
    return { ok: false, detail: 'reflector must be host:port' };
  }
  const args = ['nat-discover', '--reflector', trimmed, '--json'];
  if (typeof listenPort === 'number' && listenPort > 0 && listenPort < 65536) {
    args.push('--listen-port', String(listenPort));
  }
  try {
    const { stdout } = await execa(binPath, args, {
      timeout: 8_000, stdio: 'pipe',
    });
    let raw: Record<string, unknown> | null = null;
    try { raw = JSON.parse(stdout); } catch { /* keep null */ }
    return { ok: true, detail: 'nat-discover ok', raw };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  }
}

// ── Settings (`nvpn set`) ────────────────────────────────────────────────
//
// `nvpn set` accepts a wide range of `--<key> <value>` pairs. The
// dashboard exposes a curated subset matching what users routinely tune
// (node name, listen port, autoconnect, advertise-exit-node, advertised
// routes). Unknown keys pass through unchanged so an upstream addition
// doesn't require a code change here.

const SETTABLE_KEYS = new Set([
  'node-name',
  'listen-port',
  'tunnel-ip',
  'endpoint',
  'magic-dns-suffix',
  'exit-node',
  'advertise-exit-node',
  'advertise-routes',
  'autoconnect',
  'relay-for-others',
  'provide-nat-assist',
  'network-id',
]);

export interface SetResult extends ControlResult {
  raw?: Record<string, unknown> | null;
}
export async function setNvpnSettings(input: Record<string, unknown>): Promise<SetResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  const args: string[] = ['set'];
  let added = 0;
  for (const [key, value] of Object.entries(input || {})) {
    if (!SETTABLE_KEYS.has(key)) continue;
    if (value === undefined || value === null || value === '') continue;
    args.push(`--${key}`, String(value));
    added++;
  }
  if (added === 0) return { ok: false, detail: 'no settable fields in payload' };
  args.push('--json');
  try {
    const { stdout } = await execa(binPath, args, { timeout: 10_000, stdio: 'pipe' });
    let raw: Record<string, unknown> | null = null;
    try { raw = JSON.parse(stdout); } catch { /* keep null */ }
    return { ok: true, detail: `${added} field${added === 1 ? '' : 's'} updated`, raw };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  }
}

// ── Stats (`nvpn stats`) ─────────────────────────────────────────────────
// Surfaces relay-operator counters from the local state file. Useful
// for users who flip on `relay-for-others` and want to see traffic
// they're forwarding.
export async function statsNvpn(): Promise<DiagResult> {
  const binPath = findBin('nvpn');
  if (!binPath) return { ok: false, detail: 'nvpn binary not installed' };
  try {
    const { stdout } = await execa(binPath, ['stats', '--json'], { timeout: 4_000, stdio: 'pipe' });
    let raw: Record<string, unknown> | null = null;
    try { raw = JSON.parse(stdout); } catch { /* keep null */ }
    return { ok: true, detail: 'stats ok', raw };
  } catch (e: any) {
    return { ok: false, detail: summarizeError(e) };
  }
}

// ── Pure helpers (testable) ─────────────────────────────────────────────

export function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  // null + undefined coerce to 0 / NaN respectively under `Number()`, but
  // semantically they're "no value" — treat as fallback so callers don't
  // accidentally write a clamped 0/lo when the input was missing entirely.
  if (v === null || v === undefined) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

// True iff `key` is on the curated `nvpn set` allowlist. Exported for
// route-handler validation: callers sanitize their request body before
// calling setNvpnSettings so the rejection happens at the API boundary.
export function isSettableNvpnKey(key: string): boolean {
  return SETTABLE_KEYS.has(key);
}

// ── Log tail ─────────────────────────────────────────────────────────────
//
// The log file path comes from `nvpn status --json` (`daemon.log_file`).
// Across releases nvpn has logged to multiple locations (~/.config/nvpn/,
// ~/Library/Application Support/nvpn/, /var/log/...), so we never hardcode
// a path — the daemon tells us where it's writing.
//
// Implementation: poll-based incremental read. fs.watch is unreliable on
// macOS for files on certain filesystems, and on Linux it can miss writes
// when the inode is rotated. A 1s poll that compares size and reads the
// delta is simpler, matches the existing watchdog probe cadence, and
// degrades gracefully when the file rotates (we re-open from offset 0).

interface TailerHandle {
  stop: () => void;
}

const POLL_INTERVAL_MS = 1000;
const LOG_PATH_RECHECK_MS = 15_000;

export function startNvpnLogTail(buffer: LogBuffer): TailerHandle {
  let stopped = false;
  let currentPath: string | null = null;
  let offset = 0;
  let pollTimer: NodeJS.Timeout | null = null;
  let pathTimer: NodeJS.Timeout | null = null;

  const resolveLogPath = async (): Promise<string | null> => {
    const s = await probeNvpnStatus();
    if (!s.installed) return null;
    const fromStatus = s.raw?.daemon?.log_file;
    if (typeof fromStatus === 'string' && fromStatus.length > 0) return fromStatus;
    // Common fallbacks if the daemon doesn't report a path. Read order
    // matches what we see in practice across macOS / Linux installs.
    const home = os.homedir();
    const candidates = [
      path.join(home, '.config', 'nvpn', 'daemon.log'),
      path.join(home, 'Library', 'Application Support', 'nvpn', 'daemon.log'),
      '/var/log/nvpn.log',
    ];
    for (const c of candidates) {
      try { fs.accessSync(c, fs.constants.R_OK); return c; }
      catch { /* try next */ }
    }
    return null;
  };

  const onLines = (chunk: string): void => {
    const lines = chunk.split('\n');
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (!line) continue;
      // nvpn doesn't emit a level prefix consistently. Heuristic match
      // mirrors LogsPanel.classify() so the dashboard's coloring works
      // without a wire-protocol change.
      const level: 'info' | 'warn' | 'error' =
        /\b(error|err|panic|fail)\b/i.test(line) ? 'error'
      : /\b(warn|warning)\b/i.test(line)         ? 'warn'
      :                                            'info';
      buffer.push(level, line);
    }
  };

  const poll = async (): Promise<void> => {
    if (stopped) return;
    if (!currentPath) {
      schedulePoll();
      return;
    }
    try {
      const st = fs.statSync(currentPath);
      // File rotated / truncated — start over from byte 0.
      if (st.size < offset) offset = 0;
      if (st.size > offset) {
        const stream = fs.createReadStream(currentPath, {
          start: offset, end: st.size - 1, encoding: 'utf8',
        });
        let buf = '';
        await new Promise<void>((resolve) => {
          stream.on('data', (d: string | Buffer) => {
            buf += typeof d === 'string' ? d : d.toString('utf8');
          });
          stream.on('end',   () => resolve());
          stream.on('error', () => resolve());
        });
        offset = st.size;
        // Only emit complete lines — keep the trailing partial for the
        // next poll. (Most real log writes end in \n, so this is a
        // correctness-against-pathological-streams measure.)
        const idx = buf.lastIndexOf('\n');
        const complete = idx >= 0 ? buf.slice(0, idx + 1) : '';
        if (complete) onLines(complete);
      }
    } catch { /* file disappeared — try again next tick */ }
    schedulePoll();
  };

  const schedulePoll = (): void => {
    if (stopped) return;
    pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
  };

  const refreshPath = async (): Promise<void> => {
    if (stopped) return;
    const p = await resolveLogPath();
    if (p && p !== currentPath) {
      currentPath = p;
      // Seek to end so the user doesn't get a flood of historical lines
      // every time the daemon's log path changes.
      try { offset = fs.statSync(p).size; } catch { offset = 0; }
      buffer.info(`tailing ${p}`);
    }
    pathTimer = setTimeout(refreshPath, LOG_PATH_RECHECK_MS);
  };

  refreshPath();
  schedulePoll();

  return {
    stop() {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (pathTimer) clearTimeout(pathTimer);
    },
  };
}

// ── Pure helpers (testable) ──────────────────────────────────────────────

export interface NvpnRowProbe {
  installed:    boolean;
  running:      boolean;
  tunnelIp:     string | null;
  serviceLoaded?: boolean | null;
}

export interface NvpnRowState {
  state:  'ok' | 'warn' | 'err';
  value:  string;
  ok:     boolean;
}

// Maps the runtime probe to the Status row display string. Mirrors
// nvpnStateFor in commands/Status.tsx but takes the richer probe shape
// the new control surface produces. Pure + exported for unit tests so
// every branch can be pinned without spawning processes.
export function nvpnRowStateFor(p: NvpnRowProbe): NvpnRowState {
  if (!p.installed)   return { state: 'err',  value: 'not installed', ok: false };
  if (!p.running)     return { state: 'warn', value: 'not connected', ok: false };
  if (p.tunnelIp)     return { state: 'ok',   value: p.tunnelIp,      ok: true  };
  return { state: 'warn', value: 'running, no tunnel ip',             ok: false };
}

// ── Banner running decision ─────────────────────────────────────────────
//
// The Logs panel banner needs a single boolean — "should we tell the user
// the daemon is stopped and offer them a Start button?" — but a brief
// stall on `nvpn status --json` is not enough evidence to claim the
// daemon is down. Systemd / launchd already know whether the process is
// running; we cross-check against that signal whenever the direct probe
// errored out (timeout, broken socket, transient nvpn crash mid-call).
//
// Decision table (D = direct probe, S = service probe):
//   D.running:true                       → running:true   (happy path)
//   D.running:false, no D.error          → running:false  (daemon really stopped)
//   D.running:false, D.error, S.running  → running:true   (probe stalled, process alive)
//   D.running:false, D.error, !S.running → running:false  (process down)
//
// Pure + exported for tests. Caller passes the same NvpnStatus shape
// probeNvpnStatus emits and (optionally) a NvpnServiceStatus from
// probeNvpnServiceStatus; passing `null` for the service skips the
// fallback and is equivalent to "no second opinion available."
export function vpnBannerRunningFor(
  direct: Pick<NvpnStatus, 'installed' | 'running' | 'error'>,
  service: Pick<NvpnServiceStatus, 'running'> | null,
): boolean {
  if (!direct.installed) return false;
  if (direct.running)    return true;
  // direct probe says not-running. If it errored, the answer is unknown
  // until we consult the service supervisor.
  if (direct.error && service && service.running) return true;
  return false;
}
