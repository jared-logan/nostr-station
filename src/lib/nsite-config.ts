/**
 * nsite panel user config — persistent JSON at
 * ~/.config/nostr-station/nsite.json. Mirrors the surface Titan Browser
 * exposes in its Settings tab (relays / discovery relays / Blossom
 * servers / indexer pubkey) so a user who has Titan working knows where
 * the equivalent knobs live here.
 *
 * Precedence at request time, highest → lowest:
 *   1. Env vars (NSITE_NSIT_INDEXER_PUBKEY, NSITE_NSIT_RELAYS) —
 *      shell-driven overrides for ops / debugging. Set "disabled" on
 *      the indexer pubkey env var to refuse NSIT lookups regardless of
 *      the config file.
 *   2. nsite.json on disk — what the Config panel reads/writes.
 *   3. Hardcoded defaults exported by nsite-resolver.ts (Titan-mirrored).
 *
 * Read paths are tolerant: a malformed JSON file or missing fields fall
 * back to defaults rather than 500ing the resolve endpoint.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { atomicWriteJson } from './atomic-write.js';
import {
  DEFAULT_CONTENT_RELAYS,
  DEFAULT_BLOSSOM_SERVERS,
  DEFAULT_DEPLOY_BLOSSOM_SERVERS,
  DEFAULT_DEPLOY_RELAYS,
  DEFAULT_NSIT_INDEXER_PUBKEY,
  DEFAULT_NSIT_INDEXER_RELAYS,
  PROFILE_DISCOVERY_RELAYS,
} from './nsite-resolver.js';

export interface NsiteConfig {
  /** Always-on content fallback set. Unioned with owner read + author outbox. */
  contentRelays:        string[];
  /** Profile-discovery relays for bootstrapping NIP-65 outbox lookups. */
  discoveryRelays:      string[];
  /** Default Blossom servers tried when the author's kind:10063 list 404s. */
  blossomServers:       string[];
  /** 64-hex pubkey whose kind:35129 events we trust for NSIT name resolution. */
  nsitIndexerPubkey:    string;
  /** Relays the NSIT indexer publishes to. */
  nsitIndexerRelays:    string[];

  // ── nsite DEPLOY (publish-side) ───────────────────────────────────────
  // Separate from the browsing fields above. These govern where THIS
  // station publishes its OWN nsites: the Blossom servers it uploads
  // file blobs to and the relays it publishes the kind:35128 manifest to.
  // Each pairs an app-default list (toggleable) with the user's own list,
  // mirroring the Station Relays "App Relays / Your Relays" model. The
  // effective target set is computed by effectiveDeployBlossomServers() /
  // effectiveDeployRelays() below.

  /** User's own Blossom upload targets ("Your Blossom Servers"). May be a
   *  kind:10063 list synced in from Nostr or hand-edited. */
  deployBlossomServers:    string[];
  /** When true (default), DEFAULT_DEPLOY_BLOSSOM_SERVERS are unioned in. */
  deployBlossomAppEnabled: boolean;
  /** User's own manifest-publish relays ("Your Relays" for deploy). */
  deployRelays:            string[];
  /** When true (default), DEFAULT_DEPLOY_RELAYS are unioned in. */
  deployRelayAppEnabled:   boolean;
  /** Author pubkeys (64-hex) the user has explicitly allowed to load external
   *  HTTPS resources (esm.sh modules, nostr.build images, fonts, fetch
   *  endpoints). When an nsite's resolved pubkey is in this list, the
   *  served-content CSP gets `https:` added to script/img/connect/font/
   *  style/media-src directives. Other nsites stay strict-by-default.
   *  Persisted to nsite.json so the choice is once-per-nsite-ever.
   *  The blast radius of a trusted nsite is still contained by the
   *  per-origin iframe model (subdomain ≠ dashboard, SOP isolates) — see
   *  routes/nsite.ts:handleNsiteSubdomain for the host gate that keeps
   *  the dashboard /api/* surface invisible from nsite origins. */
  trustedExternalNsites: string[];
  /** Saved bookmarks. Browser-style: starred sites the user wants
   *  quick access to. Each entry remembers the resolve input the user
   *  originally typed (so re-resolving picks the same path — gateway
   *  URLs decoded to nsite://name don't round-trip via NSIT lookup,
   *  see PR #126's originalAddr fix), plus a display label and a
   *  timestamp for sort order. Dedupe key is pubkey + name, so two
   *  sites at the same author pubkey but different v2-named manifests
   *  remain distinct bookmarks. */
  bookmarks: Bookmark[];
}

/** Persistent bookmark entry. Stored in nsite.json's bookmarks array.
 *  The shape mirrors what /api/nsite/resolve returns so the bookmark
 *  list can render without an extra fetch. */
export interface Bookmark {
  /** 64-hex author pubkey. Primary identity. */
  pubkey:    string;
  /** Optional v2-named manifest name (the `d` tag value). Empty for
   *  root manifests / v1 / npub-only bookmarks. Part of the dedupe key
   *  with pubkey. */
  name:      string;
  /** What the user originally typed — `nsite://titan`, an `npub1…`,
   *  a gateway URL, etc. Re-resolving via this string is what makes
   *  bookmarks click-to-open correctly across all input shapes. */
  addr:      string;
  /** Display label for the bookmark list. Usually the canonical
   *  display form (`nsite://titan`) the resolver returned. */
  display:   string;
  /** Unix seconds when bookmarked. Used for sort order in the list. */
  addedAt:   number;
}

function configDir(): string {
  return path.join(os.homedir(), '.config', 'nostr-station');
}
function configPath(): string {
  return path.join(configDir(), 'nsite.json');
}

const HEX64 = /^[0-9a-f]{64}$/i;

export function defaultNsiteConfig(): NsiteConfig {
  return {
    contentRelays:         DEFAULT_CONTENT_RELAYS.slice(),
    discoveryRelays:       PROFILE_DISCOVERY_RELAYS.slice(),
    blossomServers:        DEFAULT_BLOSSOM_SERVERS.slice(),
    nsitIndexerPubkey:     DEFAULT_NSIT_INDEXER_PUBKEY,
    nsitIndexerRelays:     DEFAULT_NSIT_INDEXER_RELAYS.slice(),
    trustedExternalNsites: [],
    bookmarks:             [],
    // Deploy: user lists start empty (app defaults carry the load until
    // the user adds or syncs their own). App toggles default ON so deploy
    // works out of the box.
    deployBlossomServers:    [],
    deployBlossomAppEnabled: true,
    deployRelays:            [],
    deployRelayAppEnabled:   true,
  };
}

/** Effective Blossom upload targets for a deploy: the user's own list,
 *  unioned with the app defaults when the app toggle is on. De-duped,
 *  app defaults last so a user's preferred server is tried first.
 *  Falls back to app defaults if the union is empty (toggle off + no
 *  user list) so a deploy never silently has zero targets. */
export function effectiveDeployBlossomServers(cfg: NsiteConfig): string[] {
  const out = dedupeUrls([
    ...cfg.deployBlossomServers,
    ...(cfg.deployBlossomAppEnabled ? DEFAULT_DEPLOY_BLOSSOM_SERVERS : []),
  ]);
  return out.length ? out : DEFAULT_DEPLOY_BLOSSOM_SERVERS.slice();
}

/** Effective manifest-publish relays for a deploy. Same union semantics
 *  as effectiveDeployBlossomServers. */
export function effectiveDeployRelays(cfg: NsiteConfig): string[] {
  const out = dedupeUrls([
    ...cfg.deployRelays,
    ...(cfg.deployRelayAppEnabled ? DEFAULT_DEPLOY_RELAYS : []),
  ]);
  return out.length ? out : DEFAULT_DEPLOY_RELAYS.slice();
}

function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const k = u.trim().replace(/\/+$/, '').toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(u.trim().replace(/\/+$/, ''));
  }
  return out;
}

/** Sanitize a Bookmark off the wire / off disk. Drops obviously
 *  malformed entries (bad pubkey, missing addr) rather than throwing —
 *  consistent with how the other arrays in this config behave. */
function sanitizeBookmark(raw: any): Bookmark | null {
  if (!raw || typeof raw !== 'object') return null;
  const pubkey = typeof raw.pubkey === 'string' ? raw.pubkey.trim().toLowerCase() : '';
  if (!HEX64.test(pubkey)) return null;
  const addr = typeof raw.addr === 'string' ? raw.addr.trim() : '';
  if (!addr) return null;
  const name    = typeof raw.name === 'string'    ? raw.name.trim()    : '';
  const display = typeof raw.display === 'string' ? raw.display.trim() : addr;
  const addedAt = Number.isFinite(raw.addedAt) ? Math.floor(raw.addedAt) : Math.floor(Date.now() / 1000);
  return { pubkey, name, addr, display, addedAt };
}

/**
 * Read the on-disk config, filling missing fields from defaults. Never
 * throws — a corrupt file just returns the defaults, so a typo can't
 * brick the resolve endpoint.
 */
export function readNsiteConfig(): NsiteConfig {
  const fallback = defaultNsiteConfig();
  let raw: any = {};
  try { raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')); }
  catch { return fallback; }
  const sanitizeUrls = (xs: unknown, scheme: RegExp): string[] => Array.isArray(xs)
    ? xs.filter((s: any): s is string => typeof s === 'string' && scheme.test(s.trim()))
        .map(s => s.trim().replace(/\/+$/, ''))
    : [];
  const wss   = sanitizeUrls(raw.contentRelays,     /^wss?:\/\//i);
  const disc  = sanitizeUrls(raw.discoveryRelays,   /^wss?:\/\//i);
  const blobs = sanitizeUrls(raw.blossomServers,    /^https?:\/\//i);
  const nsit  = sanitizeUrls(raw.nsitIndexerRelays, /^wss?:\/\//i);
  const pk    = typeof raw.nsitIndexerPubkey === 'string' && HEX64.test(raw.nsitIndexerPubkey.trim())
              ? raw.nsitIndexerPubkey.trim().toLowerCase()
              : fallback.nsitIndexerPubkey;
  // Trusted-pubkey list: filter to valid 64-hex entries (lowercased,
  // deduplicated). Forgive bad rows — a typo shouldn't lock the user
  // out of every other allowed nsite.
  const trustedSeen = new Set<string>();
  const trusted: string[] = Array.isArray(raw.trustedExternalNsites)
    ? raw.trustedExternalNsites
        .filter((s: any): s is string => typeof s === 'string' && HEX64.test(s.trim()))
        .map((s: string) => s.trim().toLowerCase())
        .filter((s: string) => trustedSeen.has(s) ? false : (trustedSeen.add(s), true))
    : [];
  // Bookmarks: dedupe on pubkey+name (so two named manifests at the
  // same author stay distinct, but the same bookmark added twice
  // collapses to one). Bad rows drop. Sort by addedAt desc so the
  // most-recent bookmark shows first in the panel list.
  const bmSeen = new Set<string>();
  const bookmarks: Bookmark[] = Array.isArray(raw.bookmarks)
    ? raw.bookmarks
        .map(sanitizeBookmark)
        .filter((b: Bookmark | null): b is Bookmark => !!b)
        .filter((b: Bookmark) => {
          const k = `${b.pubkey}|${b.name}`;
          if (bmSeen.has(k)) return false;
          bmSeen.add(k); return true;
        })
        .sort((a: Bookmark, b: Bookmark) => b.addedAt - a.addedAt)
    : [];
  // Deploy lists are forgiving like the others, but DON'T fall back to a
  // non-empty default when absent: an empty user list is a valid, meaningful
  // state (it means "rely on the app defaults via the toggle"). The app
  // toggles default ON unless explicitly stored false.
  const deployBlobs = sanitizeUrls(raw.deployBlossomServers, /^https?:\/\//i);
  const deployRel   = sanitizeUrls(raw.deployRelays,         /^wss?:\/\//i);
  return {
    contentRelays:         wss.length   ? wss   : fallback.contentRelays,
    discoveryRelays:       disc.length  ? disc  : fallback.discoveryRelays,
    blossomServers:        blobs.length ? blobs : fallback.blossomServers,
    nsitIndexerPubkey:     pk,
    nsitIndexerRelays:     nsit.length  ? nsit  : fallback.nsitIndexerRelays,
    trustedExternalNsites: trusted,
    bookmarks,
    deployBlossomServers:    deployBlobs,
    deployBlossomAppEnabled: raw.deployBlossomAppEnabled === false ? false : true,
    deployRelays:            deployRel,
    deployRelayAppEnabled:   raw.deployRelayAppEnabled === false ? false : true,
  };
}

/**
 * Persist the config. Validates input the same way readNsiteConfig
 * sanitizes — relay URLs must parse, pubkey must be 64-hex (or
 * "disabled" literal). Throws on a bad pubkey since that's the only
 * field where silently falling back would obscure a real input error
 * (the relay arrays are forgiving by design — bad rows just drop).
 */
export function writeNsiteConfig(input: Partial<NsiteConfig>): NsiteConfig {
  const current = readNsiteConfig();
  const merged: NsiteConfig = { ...current };

  const cleanWss = (xs: unknown): string[] | undefined => Array.isArray(xs)
    ? xs.map(s => typeof s === 'string' ? s.trim().replace(/\/+$/, '') : '')
        .filter(s => /^wss?:\/\//i.test(s))
    : undefined;
  const cleanHttp = (xs: unknown): string[] | undefined => Array.isArray(xs)
    ? xs.map(s => typeof s === 'string' ? s.trim().replace(/\/+$/, '') : '')
        .filter(s => /^https?:\/\//i.test(s))
    : undefined;

  const c1 = cleanWss(input.contentRelays);       if (c1 !== undefined) merged.contentRelays     = c1;
  const c2 = cleanWss(input.discoveryRelays);     if (c2 !== undefined) merged.discoveryRelays   = c2;
  const c3 = cleanHttp(input.blossomServers);     if (c3 !== undefined) merged.blossomServers    = c3;
  const c4 = cleanWss(input.nsitIndexerRelays);   if (c4 !== undefined) merged.nsitIndexerRelays = c4;

  // Deploy lists + toggles. cleanHttp/cleanWss return [] (defined) for an
  // empty input array, so the user can deliberately clear their list.
  const d1 = cleanHttp(input.deployBlossomServers); if (d1 !== undefined) merged.deployBlossomServers = d1;
  const d2 = cleanWss(input.deployRelays);          if (d2 !== undefined) merged.deployRelays         = d2;
  if (typeof input.deployBlossomAppEnabled === 'boolean') merged.deployBlossomAppEnabled = input.deployBlossomAppEnabled;
  if (typeof input.deployRelayAppEnabled   === 'boolean') merged.deployRelayAppEnabled   = input.deployRelayAppEnabled;

  if (typeof input.nsitIndexerPubkey === 'string') {
    const v = input.nsitIndexerPubkey.trim();
    if (v === '' || v.toLowerCase() === 'disabled' || HEX64.test(v)) {
      merged.nsitIndexerPubkey = v.toLowerCase();
    } else {
      throw new Error(`indexer pubkey must be 64-hex, empty, or "disabled" — got ${JSON.stringify(v).slice(0, 80)}`);
    }
  }

  if (Array.isArray(input.trustedExternalNsites)) {
    // Same posture as readNsiteConfig: drop bad rows, dedup, lowercase.
    // Throwing on the array as a whole would lock the user out of saving
    // good entries just because one is malformed.
    const seen = new Set<string>();
    merged.trustedExternalNsites = input.trustedExternalNsites
      .filter((s: any): s is string => typeof s === 'string' && HEX64.test(s.trim()))
      .map((s: string) => s.trim().toLowerCase())
      .filter((s: string) => seen.has(s) ? false : (seen.add(s), true));
  }

  if (Array.isArray(input.bookmarks)) {
    // Same shape — sanitize each entry, dedupe on pubkey+name, preserve
    // existing-or-passed addedAt so the sort order on next read stays
    // stable across writes.
    const seen = new Set<string>();
    merged.bookmarks = input.bookmarks
      .map(sanitizeBookmark)
      .filter((b: Bookmark | null): b is Bookmark => !!b)
      .filter((b: Bookmark) => {
        const k = `${b.pubkey}|${b.name}`;
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });
  }

  atomicWriteJson(configPath(), merged, { mode: 0o600 });
  return merged;
}

export function nsiteConfigPath(): string { return configPath(); }
