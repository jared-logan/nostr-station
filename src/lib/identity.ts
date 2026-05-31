/**
 * User identity + backup-relay list persisted at
 * ~/.config/nostr-station/identity.json.
 *
 * Only the npub (public) and a list of read relays are stored. nsec is
 * never accepted — the API layer rejects any input starting with "nsec"
 * before it reaches the lib.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { atomicWriteJson } from './atomic-write.js';

export interface Identity {
  npub:       string;       // bech32 "npub1..." or 64-char hex
  readRelays: string[];     // ws:// or wss:// URLs — the user's "Your Relays" list
  // Per-relay write list, paired with readRelays to model NIP-65's
  // per-`r`-tag read/write marker. Semantics when emitting a kind:10002:
  //   url in both readRelays and writeRelays  → ["r", url]                    (unmarked, both)
  //   url in readRelays only                  → ["r", url, "read"]
  //   url in writeRelays only                 → ["r", url, "write"]
  // Default (legacy installs / undefined) treats every readRelays entry
  // as both read and write — matches the pre-Item-2 behavior where
  // there was no write-relay concept. The `relays publish` flow uses
  // this distinction to mark inbox-only and outbox-only relays
  // explicitly when emitting the user's NIP-65 event.
  writeRelays?: string[];
  // User's preferred GRASP servers (git+nostr storage hosts). Pre-populates
  // the per-project Initialize ngit form — same model shakespeare.diy uses
  // (Settings → Nostr → Nostr Git Servers configures globally; per-project
  // init picks from the global list with custom-add still available).
  // Stored URLs are validated as ws:// or wss:// (NIP-34 transport). When
  // absent, the project init form falls back to the hardcoded defaults
  // (relay.ngit.dev + git.shakespeare.diy).
  //
  // Pre-2.x there was a separate `ngitRelay` field — a single default relay
  // ngit 1.x prompted for on every push/clone. ngit 2.x replaced that with
  // GRASP servers + git-remote-nostr, so the field became redundant.
  // readIdentity() migrates legacy values into this list on first read.
  graspServers?: string[];
  // Whether to include nostr-station's curated App Relays (DEFAULT_READ_RELAYS
  // — relay.damus.io / relay.nostr.band / nos.lol) in /client read paths
  // alongside the user's "Your Relays" list. Default true so a brand-new
  // user gets a working feed without configuring anything. Toggled from
  // Config → Client Relays. Mirrors Ditto's "App Relays" enable switch.
  appRelaysEnabled?: boolean;
  // Persisted on/off state for the in-process Blossom server. The user
  // toggles this via Config → Blossom or the Dashboard card; on next
  // station boot, the in-process server is started iff this is true
  // (or STATION_INPROC_BLOSSOM=1 is set as an env override). Default
  // false / undefined — Blossom stays off until explicitly enabled, so
  // installs that never touch blob storage pay no boot cost.
  inprocBlossomEnabled?: boolean;
  // PR 11: persisted on/off for the Mail inbox worker. Default ON
  // (undefined treated as true) — Mail "just works" out of the box.
  // The user can opt out via Config → Mail. STATION_DISABLE_MAIL=1 as
  // an env override still wins so headless / CI installs can pin off
  // without touching identity.json.
  mailEnabled?: boolean;
  // Persisted on/off for the in-Node watchdog (kind-1 heartbeat to the
  // local relay every 5 min). Default ON — preserves the auto-start
  // behavior pre-toggle so existing installs don't silently lose
  // monitoring on upgrade. Flipped via Config → Watchdog (Enable /
  // Disable buttons; same shape as Blossom). STATION_DISABLE_WATCHDOG=1
  // still wins independently so headless / CI installs can pin off.
  watchdogEnabled?: boolean;
  // Opt-out of dashboard auth for localhost requests (127.0.0.1, ::1). Default
  // true — manual override only, not surfaced in the UI yet.
  requireAuth?: boolean;
  // Tri-state — written by the web setup wizard at /setup:
  //   - false : wizard is in progress (localhost stays exempt so the
  //             remaining stages can hit otherwise-gated endpoints)
  //   - true  : wizard completed; normal auth applies
  //   - undefined : legacy (pre-6.5 TUI onboard, hand-edited json).
  //             Treated as "complete" — we don't want existing users
  //             stuck in exempt mode after an upgrade.
  setupComplete?: boolean;
}

export const DEFAULT_READ_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.ditto.pub',
];

// Default GRASP server picks for a brand-new install. NIP-34 mentions
// GRASP as infrastructure but doesn't enumerate servers, and ngit-cli's
// README is silent too. These two are the public servers we've verified
// in the wild — relay.ngit.dev (operated by ngit's author) and
// git.shakespeare.diy (shakespeare.diy team). Hardcoding more would
// be guessing; users can add custom URLs via Config → ngit.
export const DEFAULT_GRASP_SERVERS = [
  'wss://relay.ngit.dev',
  'wss://git.shakespeare.diy',
];

function configDir(): string {
  return path.join(os.homedir(), '.config', 'nostr-station');
}
function configPath(): string {
  return path.join(configDir(), 'identity.json');
}

export function identityExists(): boolean {
  return fs.existsSync(configPath());
}

export function readIdentity(): Identity {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    const ident: Identity = {
      npub:       typeof parsed.npub === 'string' ? parsed.npub : '',
      // readRelays is now the user's "Your Relays" list — distinct from
      // the curated App Relays (DEFAULT_READ_RELAYS). Before this field
      // was split, an empty list silently fell back to defaults; now we
      // preserve an empty list as "user explicitly cleared their list"
      // and rely on App Relays (toggleable) to keep the feed working.
      // Legacy reads where readRelays is missing still default to the
      // curated set so existing installs don't suddenly lose their feed.
      readRelays: Array.isArray(parsed.readRelays)
                    ? parsed.readRelays.filter((x: any) => typeof x === 'string')
                    : DEFAULT_READ_RELAYS.slice(),
      // writeRelays is the optional NIP-65 outbox-marker companion to
      // readRelays. Pre-NIP-65 installs leave this field absent; the
      // kind:10002 builder treats absent as "every readRelays entry is
      // also a write relay" so legacy users get sensible unmarked
      // (both-mode) tags when they first publish.
      writeRelays: Array.isArray(parsed.writeRelays)
                    ? parsed.writeRelays.filter((x: any): x is string => typeof x === 'string' && x.length > 0)
                    : undefined,
      graspServers: Array.isArray(parsed.graspServers)
        ? parsed.graspServers.filter((x: any): x is string => typeof x === 'string' && x.length > 0)
        : undefined,
      // App Relays default ON so new + upgrading users get the curated
      // baseline. Explicit false (user toggled it off) is the only way
      // to disable them. Anything truthy normalises to true.
      appRelaysEnabled: parsed.appRelaysEnabled === false ? false : true,
      // In-process Blossom enable bit — default off (undefined → false).
      // Boolean true persists across restarts; the env-var override
      // STATION_INPROC_BLOSSOM=1 still wins independent of this.
      inprocBlossomEnabled: parsed.inprocBlossomEnabled === true ? true : undefined,
      // Mail-worker enable bit. Default ON for new + upgrading users
      // so nostr-mail "just works"; only `false` explicitly turns it
      // off. Mirrors appRelaysEnabled's polarity (default-on, opt-out
      // shape) rather than inprocBlossomEnabled's default-off shape —
      // Mail is core like the social Client panel, not opt-in like
      // hosting blob storage.
      mailEnabled: parsed.mailEnabled === false ? false : true,
      // Watchdog enable bit — same default-on polarity as mail. Only
      // explicit false flips it off; any other shape (undefined, true,
      // truthy) reads as on.
      watchdogEnabled: parsed.watchdogEnabled === false ? false : true,
      requireAuth: parsed.requireAuth === false ? false : undefined,
      setupComplete: typeof parsed.setupComplete === 'boolean' ? parsed.setupComplete : undefined,
    };
    // Legacy migration: ngit 1.x stored a single default relay in
    // `ngitRelay`; 2.x folds that into the GRASP server list. Port any
    // stored value into graspServers (deduped, validated) and persist
    // the cleaned record so subsequent reads stop seeing the legacy
    // field. Idempotent — once migrated, parsed.ngitRelay is undefined.
    if (typeof parsed.ngitRelay === 'string' && parsed.ngitRelay && isValidRelayUrl(parsed.ngitRelay)) {
      const current = Array.isArray(ident.graspServers) ? ident.graspServers : DEFAULT_GRASP_SERVERS.slice();
      if (!current.includes(parsed.ngitRelay)) {
        ident.graspServers = [...current, parsed.ngitRelay];
      } else {
        ident.graspServers = current;
      }
      try { writeIdentity(ident); } catch {}
    } else if (parsed.ngitRelay !== undefined) {
      // Empty / invalid legacy field — drop it without changing graspServers.
      try { writeIdentity(ident); } catch {}
    }
    return ident;
  } catch {
    return { npub: '', readRelays: DEFAULT_READ_RELAYS.slice(), appRelaysEnabled: true, mailEnabled: true, watchdogEnabled: true };
  }
}

// Returns the union of (App Relays, Your Relays) that /client + other
// public-relay consumers should query. Deduped, capped at 12 to keep
// fan-out bounded. When App Relays are disabled and the user's list is
// empty, returns an empty array — callers surface the empty state via
// the existing `unavailable('no-read-relays')` branch.
//
// This is the single source of truth for "where do public-facing reads
// go?" — every /client route uses it; the rest of the dashboard still
// calls `readIdentity().readRelays` directly for backwards compatibility
// with code paths that pre-date App Relays.
export function getEffectiveReadRelays(): string[] {
  const ident = readIdentity();
  const seen = new Set<string>();
  const out: string[] = [];
  const appOn = ident.appRelaysEnabled !== false;
  if (appOn) {
    for (const r of DEFAULT_READ_RELAYS) {
      if (!seen.has(r)) { seen.add(r); out.push(r); }
    }
  }
  for (const r of ident.readRelays || []) {
    if (typeof r !== 'string') continue;
    if (!isValidRelayUrl(r)) continue;
    if (!seen.has(r)) { seen.add(r); out.push(r); }
  }
  return out.slice(0, 12);
}

// Flip the App Relays enable bit. Mirrors addReadRelay / removeReadRelay
// in surface shape (returns the new state). Persisted to identity.json
// so the choice survives a restart.
// Same shape as setAppRelaysEnabled but for the in-process Blossom
// server's persisted on/off state. Called from /api/blossom/{start,stop}
// so the choice survives a restart — analogous to how nvpn / app-relays
// persistence works. Returning the new value lets callers update local
// state without re-reading identity.json.
export function setInprocBlossomEnabled(enabled: boolean): { ok: true; inprocBlossomEnabled: boolean } {
  const ident = readIdentity();
  if (enabled) ident.inprocBlossomEnabled = true;
  else delete ident.inprocBlossomEnabled;  // keep the on-disk JSON sparse
  writeIdentity(ident);
  return { ok: true, inprocBlossomEnabled: !!enabled };
}

export function setMailEnabled(enabled: boolean): { ok: true; mailEnabled: boolean } {
  const ident = readIdentity();
  ident.mailEnabled = !!enabled;
  writeIdentity(ident);
  return { ok: true, mailEnabled: ident.mailEnabled };
}

export function setWatchdogEnabled(enabled: boolean): { ok: true; watchdogEnabled: boolean } {
  const ident = readIdentity();
  ident.watchdogEnabled = !!enabled;
  writeIdentity(ident);
  return { ok: true, watchdogEnabled: ident.watchdogEnabled };
}

export function setAppRelaysEnabled(enabled: boolean): { ok: true; appRelaysEnabled: boolean } {
  const ident = readIdentity();
  ident.appRelaysEnabled = !!enabled;
  writeIdentity(ident);
  return { ok: true, appRelaysEnabled: ident.appRelaysEnabled };
}

export function writeIdentity(ident: Identity): void {
  atomicWriteJson(configPath(), ident, { mode: 0o600 });
}

// ── Validators ────────────────────────────────────────────────────────────

export function isNpubOrHex(s: string): boolean {
  return /^npub1[a-z0-9]{58,}$/.test(s) || /^[0-9a-f]{64}$/.test(s);
}

// ── npub <-> hex pubkey converters ────────────────────────────────────────
// Bech32 encode/decode round-trip. Lifted from the deleted relay-config
// module since the dashboard's identity routes still need them.

import { nip19 } from 'nostr-tools';

export function hexToNpub(hex: string): string {
  return nip19.npubEncode(hex);
}

export function npubToHex(npub: string): string {
  const decoded = nip19.decode(npub);
  if (decoded.type !== 'npub') throw new Error(`expected npub, got ${decoded.type}`);
  return decoded.data;
}

export function isNsec(s: string): boolean {
  // Reject both bech32 nsec and plain 64-hex-labeled-as-nsec variants.
  return s.startsWith('nsec');
}

export function isValidRelayUrl(s: string): boolean {
  return /^wss?:\/\/[^\s]+$/.test(s);
}

// ── Relay list helpers ────────────────────────────────────────────────────

export function addReadRelay(url: string): { ok: boolean; error?: string; relays?: string[] } {
  if (!isValidRelayUrl(url)) return { ok: false, error: 'url must start with ws:// or wss://' };
  const ident = readIdentity();
  if (ident.readRelays.includes(url)) return { ok: true, relays: ident.readRelays };
  ident.readRelays.push(url);
  writeIdentity(ident);
  return { ok: true, relays: ident.readRelays };
}

export function removeReadRelay(url: string): { ok: boolean; relays: string[] } {
  const ident = readIdentity();
  ident.readRelays = ident.readRelays.filter(r => r !== url);
  writeIdentity(ident);
  return { ok: true, relays: ident.readRelays };
}

// Replace the entire readRelays list in one write. Used by "sync from Nostr"
// to mirror the owner's NIP-65 (kind 10002) list exactly. Validates and
// dedupes (case-insensitive, first-seen casing wins) so the persisted list
// stays clean regardless of what the caller passes.
export function setReadRelays(urls: string[]): { ok: true; relays: string[] } {
  const ident = readIdentity();
  const seen = new Set<string>();
  const next: string[] = [];
  for (const raw of urls) {
    const url = String(raw || '').trim();
    if (!isValidRelayUrl(url)) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(url);
  }
  ident.readRelays = next;
  writeIdentity(ident);
  return { ok: true, relays: next };
}

// ── Grasp server list helpers ─────────────────────────────────────────────

// Returns the user's configured grasp servers, falling back to
// DEFAULT_GRASP_SERVERS when the field is absent (legacy entries) or
// empty. The init form treats this as the source of truth for what
// to pre-check; an empty list means "user explicitly cleared it",
// at which point we still hand back the hardcoded defaults so the
// form never renders blank — they just won't be persisted unless the
// user re-adds them.
export function getGraspServers(): string[] {
  const ident = readIdentity();
  if (Array.isArray(ident.graspServers) && ident.graspServers.length > 0) {
    return ident.graspServers.slice();
  }
  return DEFAULT_GRASP_SERVERS.slice();
}

export function addGraspServer(url: string): { ok: boolean; error?: string; graspServers?: string[] } {
  const trimmed = url.trim();
  if (!isValidRelayUrl(trimmed)) return { ok: false, error: 'url must start with ws:// or wss://' };
  const ident = readIdentity();
  // Persist explicitly when the user adds — once they touch the list,
  // we stop falling back to DEFAULT_GRASP_SERVERS for reads and return
  // exactly what's stored. addGraspServer with an empty stored list
  // seeds it with the existing defaults + the new URL so the user
  // doesn't accidentally end up with a single-entry list when they
  // intended "the defaults plus mine".
  const current = Array.isArray(ident.graspServers) ? ident.graspServers : DEFAULT_GRASP_SERVERS.slice();
  if (current.includes(trimmed)) {
    ident.graspServers = current;
    writeIdentity(ident);
    return { ok: true, graspServers: current };
  }
  ident.graspServers = [...current, trimmed];
  writeIdentity(ident);
  return { ok: true, graspServers: ident.graspServers };
}

export function removeGraspServer(url: string): { ok: boolean; graspServers: string[] } {
  const ident = readIdentity();
  // Same fallback semantics as add — user touching the list anchors
  // a stored copy. Removing from a defaults-only state seeds the
  // stored list with defaults minus the removed entry, so the next
  // read returns the user's exact choice rather than re-adding it.
  const current = Array.isArray(ident.graspServers) ? ident.graspServers : DEFAULT_GRASP_SERVERS.slice();
  ident.graspServers = current.filter(s => s !== url);
  writeIdentity(ident);
  return { ok: true, graspServers: ident.graspServers };
}

export function setNpub(npub: string): { ok: boolean; error?: string; npub?: string } {
  if (isNsec(npub)) return { ok: false, error: 'nsec detected. nostr-station never stores private keys — paste your npub only.' };
  if (!isNpubOrHex(npub)) return { ok: false, error: 'not a valid npub or 64-char hex' };
  const ident = readIdentity();
  ident.npub = npub;
  writeIdentity(ident);
  return { ok: true, npub };
}

// First-time ownership claim — atomic check-and-set for the bootstrap
// path. The dashboard's /api/identity/set route hits this when no owner
// is configured yet. Without the in-flight flag two concurrent requests
// (both passing CSRF — only possible from the user's own browser today
// but defense-in-depth) could each read `!npub`, both write, and the
// last write wins. The check-then-write window is microseconds but
// real; this closes it without needing OS-level locking.
let _bootstrapInFlight = false;
export function bootstrapIdentity(npub: string): { ok: boolean; error?: string; npub?: string } {
  if (_bootstrapInFlight) return { ok: false, error: 'bootstrap already in progress' };
  _bootstrapInFlight = true;
  try {
    if (readIdentity().npub) {
      return { ok: false, error: 'station already configured' };
    }
    return setNpub(npub);
  } finally {
    _bootstrapInFlight = false;
  }
}

export function setSetupComplete(complete: boolean): void {
  const ident = readIdentity();
  ident.setupComplete = complete;
  writeIdentity(ident);
}
