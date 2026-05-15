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
import {
  DEFAULT_CONTENT_RELAYS,
  DEFAULT_BLOSSOM_SERVERS,
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
    contentRelays:     DEFAULT_CONTENT_RELAYS.slice(),
    discoveryRelays:   PROFILE_DISCOVERY_RELAYS.slice(),
    blossomServers:    DEFAULT_BLOSSOM_SERVERS.slice(),
    nsitIndexerPubkey: DEFAULT_NSIT_INDEXER_PUBKEY,
    nsitIndexerRelays: DEFAULT_NSIT_INDEXER_RELAYS.slice(),
  };
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
  return {
    contentRelays:     wss.length   ? wss   : fallback.contentRelays,
    discoveryRelays:   disc.length  ? disc  : fallback.discoveryRelays,
    blossomServers:    blobs.length ? blobs : fallback.blossomServers,
    nsitIndexerPubkey: pk,
    nsitIndexerRelays: nsit.length  ? nsit  : fallback.nsitIndexerRelays,
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

  if (typeof input.nsitIndexerPubkey === 'string') {
    const v = input.nsitIndexerPubkey.trim();
    if (v === '' || v.toLowerCase() === 'disabled' || HEX64.test(v)) {
      merged.nsitIndexerPubkey = v.toLowerCase();
    } else {
      throw new Error(`indexer pubkey must be 64-hex, empty, or "disabled" — got ${JSON.stringify(v).slice(0, 80)}`);
    }
  }

  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  return merged;
}

export function nsiteConfigPath(): string { return configPath(); }
