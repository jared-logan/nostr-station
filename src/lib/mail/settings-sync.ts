/**
 * NIP-78 settings sync.
 *
 * The user's mail prefs (custom folders, inbox-relay list, etc.) ride
 * on a parameterized-replaceable kind 30078 event with d-tag value
 * "nostr-mail:settings". The content field is a JSON blob; we keep
 * the schema versioned so future migrations are explicit.
 *
 * NIP-78 events are NOT gift-wrapped — they're public, but they only
 * carry preferences a user might reasonably share (which folders they
 * use, which relays receive their mail). No message content, no
 * recipient lists, no signatures. Same posture other clients take
 * with NIP-65 relay lists and NIP-51 lists.
 *
 * The inbox worker subscribes to {kinds:[30078], authors:[me],
 * "#d":["nostr-mail:settings"]} and applies the newest settings on
 * receive. Writes go out via publishSettings(); the worker also picks
 * up our own writes so the local view stays consistent across panels.
 */

import type { NostrEvent } from './types.js';
import { KIND_APP_DATA, APP_DATA_D_SETTINGS, DEFAULT_FOLDERS } from './types.js';
import { signEventWithSavedBunker } from '../auth-bunker.js';
import { publishEventToRelays } from '../routes/repo.js';
import {
  readInboxRelays, writeInboxRelays, DEFAULT_INBOX_RELAYS,
} from './inbox-relays.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Schema version. Bump when the shape changes; older clients that
// don't recognise the version skip the update instead of clobbering
// fields they can't represent.
const SCHEMA_VERSION = 1;

export interface MailSettings {
  // Schema version of THIS settings document. Always 1 for now.
  version:        number;
  // Custom folder identifiers the user has defined IN ADDITION TO the
  // four defaults (inbox/sent/archive/trash). Order matters — the UI
  // renders them in this order beneath the defaults.
  customFolders:  string[];
  // Inbox-relay list. Mirrors what readInboxRelays() returns; kept in
  // settings so it syncs across devices. The local kind-10050 event
  // is still the source of truth for *receiving*; this copy lets a
  // new device's first boot pick up the configured set without an
  // extra round-trip.
  inboxRelays:    string[];
  // Timestamp of the source event. Last-write-wins ordered by this
  // value; applies/updates flow through applySettings() so a slow
  // relay can't roll back to an older settings document.
  updated_at:     number;
}

const LOCAL_CACHE_PATH = path.join(os.homedir(), '.config', 'nostr-station', 'mail-settings.json');

// ── Local cache ─────────────────────────────────────────────────────────
// Mirrors the most recently observed settings so the dashboard's first
// paint doesn't need to wait on a relay round-trip. Persists across
// restarts; the on-relay event is canonical.

export function readLocalSettings(): MailSettings {
  try {
    const raw = fs.readFileSync(LOCAL_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeSettings(parsed);
  } catch {
    // No cache yet — return defaults populated from disk-backed
    // inbox-relay list so new installs reflect what readInboxRelays
    // already shows.
    return {
      version:       SCHEMA_VERSION,
      customFolders: [],
      inboxRelays:   readInboxRelays(),
      updated_at:    0,
    };
  }
}

function writeLocalSettings(s: MailSettings): void {
  fs.mkdirSync(path.dirname(LOCAL_CACHE_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(LOCAL_CACHE_PATH, JSON.stringify(s, null, 2), { mode: 0o600 });
}

// ── Applying ───────────────────────────────────────────────────────────

/**
 * Merge a remote settings document into the local cache. Returns the
 * resulting settings (whether we accepted the update or kept the
 * existing). Last-write-wins on `updated_at`; ties go to the
 * incoming version so a re-publish at the same timestamp settles
 * deterministically.
 *
 * Side effects: when the inbox-relay list changes we also rewrite the
 * on-disk inbox-relays.json so the existing readInboxRelays() consumers
 * (worker + routes) pick up the change without knowing about settings
 * sync.
 */
export function applySettings(incoming: Partial<MailSettings> & { updated_at: number }): {
  changed: boolean;
  settings: MailSettings;
} {
  const cur = readLocalSettings();
  if (incoming.updated_at < cur.updated_at) {
    return { changed: false, settings: cur };
  }
  const next = normalizeSettings({ ...cur, ...incoming });
  // Detect if anything user-visible actually changed before we touch disk
  // (avoids needless fs writes on every relay re-delivery of the same
  // event).
  const same = JSON.stringify(stripUpdatedAt(cur)) === JSON.stringify(stripUpdatedAt(next));
  if (same) {
    return { changed: false, settings: cur };
  }
  writeLocalSettings(next);
  // Side-channel: mirror inbox relays into inbox-relays.json so existing
  // consumers pick up the change.
  if (JSON.stringify(next.inboxRelays) !== JSON.stringify(cur.inboxRelays)) {
    try { writeInboxRelays(next.inboxRelays); } catch { /* best-effort */ }
  }
  return { changed: true, settings: next };
}

function stripUpdatedAt(s: MailSettings): Omit<MailSettings, 'updated_at'> {
  const { updated_at: _, ...rest } = s;
  return rest;
}

function normalizeSettings(raw: any): MailSettings {
  const out: MailSettings = {
    version:       typeof raw?.version === 'number' ? raw.version : SCHEMA_VERSION,
    customFolders: Array.isArray(raw?.customFolders)
      ? raw.customFolders
          .filter((s: any): s is string => typeof s === 'string' && /^[a-z0-9_-]{1,32}$/i.test(s))
          .filter((s: string) => !(DEFAULT_FOLDERS as readonly string[]).includes(s))
      : [],
    inboxRelays:   Array.isArray(raw?.inboxRelays)
      ? raw.inboxRelays
          .filter((s: any): s is string => typeof s === 'string' && /^wss?:\/\//.test(s))
          .slice(0, 12)
      : DEFAULT_INBOX_RELAYS.slice(),
    updated_at:    typeof raw?.updated_at === 'number' ? raw.updated_at : 0,
  };
  // Empty inbox-relays list is invalid (the worker has nothing to subscribe
  // to) — fall back to defaults so the user can recover by editing the UI.
  if (out.inboxRelays.length === 0) out.inboxRelays = DEFAULT_INBOX_RELAYS.slice();
  return out;
}

// ── Publishing ─────────────────────────────────────────────────────────

/**
 * Merge `patch` into the current settings, bump updated_at to now,
 * sign + publish a kind 30078 event, and update the local cache. The
 * `patch` is partial — only fields the caller wants to change. The
 * `applySettings` path is reused on the publish side so the local
 * cache always reflects exactly what we sent on the wire.
 */
export async function publishSettings(patch: Partial<MailSettings>): Promise<{
  ok: boolean; settings: MailSettings; results?: any[]; error?: string;
}> {
  const cur = readLocalSettings();
  const updated_at = Math.max(cur.updated_at, Math.floor(Date.now() / 1000)) + 1;
  const next = normalizeSettings({ ...cur, ...patch, updated_at });

  const template = {
    kind:       KIND_APP_DATA,
    created_at: next.updated_at,
    tags:       [['d', APP_DATA_D_SETTINGS]],
    content:    JSON.stringify(next),
  };
  const signed = await signEventWithSavedBunker(template);
  if (!signed.ok || !signed.signedEvent) {
    // Apply locally even if the bunker is unavailable — the user
    // expects "save" to actually save, even when sync is degraded.
    applySettings(next);
    return { ok: false, settings: next, error: signed.error || 'bunker signature unavailable' };
  }

  // Persist locally first, then publish. If publish partially fails
  // the user's local view is still updated and we can re-broadcast
  // later via the same call.
  applySettings(next);
  const targets = readInboxRelays();
  const results = await publishEventToRelays(signed.signedEvent as NostrEvent, targets);
  const okCount = results.filter(r => r.ok).length;
  return { ok: okCount > 0, settings: next, results };
}

/**
 * Pull settings out of a kind 30078 event and apply locally.
 * Returns true when the local state changed.
 */
export function applyIncomingSettingsEvent(event: NostrEvent): boolean {
  if (event.kind !== KIND_APP_DATA) return false;
  const dTag = event.tags.find(t => t[0] === 'd' && typeof t[1] === 'string')?.[1];
  if (dTag !== APP_DATA_D_SETTINGS) return false;
  let parsed: any;
  try { parsed = JSON.parse(event.content); }
  catch { return false; }
  parsed.updated_at = event.created_at;
  return applySettings(parsed).changed;
}
