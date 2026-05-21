/**
 * Per-community state CRUD.
 *
 * Layout on disk (one dir per community, all under ~/.nostr-station/communities/):
 *
 *   <id>/
 *     community.json   — nostr-station-owned manifest (this file)
 *     config.yml       — GRAIN config (see community-yaml.ts)
 *     whitelist.yml    — pubkey allowlist (GRAIN)
 *     blacklist.yml    — pubkey + word denylist (GRAIN)
 *     data/            — LMDB databank (GRAIN's `data_dir`)
 *     grain.pid        — supervisor's record of the live PID (written
 *                        by community-process.ts, not this module)
 *
 * `community.json` is the nostr-station-owned manifest: id, name,
 * privacy mode, port, nvpn binding, admin pubkey, timestamps. GRAIN
 * itself never reads it — only the dashboard does. Splitting our
 * metadata out of GRAIN's YAML keeps a future GRAIN config-schema
 * change from silently colliding with our fields.
 *
 * No supervisor logic lives here. That stays in community-process.ts
 * so this module can be tested without spawning subprocesses (and so
 * a future migration that backfills manifests from disk doesn't have
 * to mock out the process model).
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {
  communitiesRoot,
  communityConfigPath, communityWhitelistPath, communityBlacklistPath,
  defaultGrainConfig,
  readGrainWhitelist, writeGrainWhitelist,
  atomicWriteFileSync,
  writeGrainConfig,
} from './community-yaml.js';

// =====================================================================
// Types

export type PrivacyMode = 'local' | 'private-network';

export type CommunityStatus =
  | 'stopped'      // not running, no error
  | 'running'      // process up + NIP-11 responding
  | 'restarting'   // backoff window
  | 'unhealthy'    // process up but probes failing
  | 'error';       // gave up; manual intervention required

/**
 * On-disk manifest. Written by createCommunity, mutated by other
 * helpers in this module via read-modify-write through atomicWrite.
 * `nvpnTunnelIp` and `lastError` are runtime state cached here so
 * the UI can render after a dashboard restart without re-discovering
 * everything synchronously.
 */
export interface CommunityManifest {
  id:             string;             // 12 hex chars; also the dir name
  name:           string;
  description?:   string;
  privacyMode:    PrivacyMode;
  port:           number;
  /** Present iff `privacyMode === 'private-network'`. */
  nvpnNetworkId?: string;
  /** Resolved at start-time; cached here for the UI to render fast. */
  nvpnTunnelIp?:  string;
  /** Hex pubkey for NIP-86 admin RPC. Defaults to the dashboard owner. */
  adminPubkey:    string;
  createdAt:      number;             // ms epoch
  /** Set by the supervisor on transitions; observed by the UI. */
  status?:        CommunityStatus;
  /**
   * Last fatal error message, set when status goes to 'error'.
   * Cleared on the next successful start.
   */
  lastError?:     string;
}

const MANIFEST_FILE = 'community.json';

// =====================================================================
// Path helpers

/** Absolute path of a community's own directory. */
export function communityDir(id: string): string {
  return path.join(communitiesRoot(), id);
}

/** Absolute path of a community's manifest file. */
export function communityManifestPath(id: string): string {
  return path.join(communityDir(id), MANIFEST_FILE);
}

/** Absolute path of a community's LMDB data dir (passed to GRAIN). */
export function communityDataDir(id: string): string {
  return path.join(communityDir(id), 'data');
}

// =====================================================================
// ID + port allocation

const ID_BYTES = 6;  // 12 hex chars; >7e14 keys, ample for <1k communities

/**
 * Allocate a fresh community id. Hex (not base64) so the value is
 * safe in directory names, URL paths, and shell arguments without
 * escaping. 48 bits of entropy is overkill for the expected scale
 * but the cost is two extra characters.
 */
export function newCommunityId(): string {
  return crypto.randomBytes(ID_BYTES).toString('hex');
}

/** First port in the auto-allocation range. 7777 stays reserved for
 *  the in-process dev relay. */
const FIRST_COMMUNITY_PORT = 7778;
/** Hard cap on the linear search so a misconfigured environment can't
 *  hang the create path indefinitely. */
const MAX_COMMUNITY_PORT  = 7900;

/**
 * Find a port unused by any existing community manifest AND verified
 * unbound on the host's loopback. The probe is best-effort: a port
 * that's free at allocation time can race with another bind, but
 * GRAIN's listen call would then error and the supervisor surfaces
 * that — no silent fail-over to an unexpected port.
 */
export async function allocateCommunityPort(): Promise<number> {
  const taken = new Set(listCommunities().map((c) => c.port));
  for (let port = FIRST_COMMUNITY_PORT; port <= MAX_COMMUNITY_PORT; port++) {
    if (taken.has(port)) continue;
    const ok = await isPortFree(port);
    if (ok) return port;
  }
  throw new Error(
    `No free port in [${FIRST_COMMUNITY_PORT}, ${MAX_COMMUNITY_PORT}]; ` +
    `either too many communities or stale processes — check existing manifests.`,
  );
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

// =====================================================================
// Listing + reading

/**
 * List every community on disk, sorted by createdAt ascending so the
 * UI rendering is stable across reloads. Silently skips directories
 * that don't have a parseable manifest — those are either in-flight
 * creates or hand-broken state, and the UI surfaces them separately
 * via an "orphaned dir" indicator rather than crashing the list view.
 */
export function listCommunities(): CommunityManifest[] {
  const root = communitiesRoot();
  if (!fs.existsSync(root)) return [];
  const out: CommunityManifest[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const m = readCommunityManifest(entry.name);
    if (m !== null) out.push(m);
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

export function readCommunityManifest(id: string): CommunityManifest | null {
  const file = communityManifestPath(id);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const m = JSON.parse(raw) as CommunityManifest;
    if (m.id !== id) {
      // dir name and manifest id must match; treat the dir as authoritative.
      return { ...m, id };
    }
    return m;
  } catch {
    return null;
  }
}

// =====================================================================
// Creation, mutation, deletion

export interface CreateCommunityInput {
  name:           string;
  description?:   string;
  privacyMode:    PrivacyMode;
  adminPubkey:    string;
  port?:          number;          // optional override; default = allocate
  nvpnNetworkId?: string;          // required iff privacyMode === 'private-network'
  /**
   * Initial allowlist (hex pubkeys). The admin is auto-added so the
   * owner can publish to their own community without an extra UI
   * step; callers that explicitly DON'T want that pass `{ skipAddAdmin: true }`.
   */
  memberPubkeys?: string[];
  skipAddAdmin?:  boolean;
  /**
   * Bind address overrides — used by the supervisor when it discovers
   * the nvpn tunnel IP. The create path itself defaults to loopback
   * for safety; the supervisor rewrites config.yml with the tunnel IP
   * once it's known.
   */
  bindHost?:      string;
}

/**
 * Create a fresh community directory: write manifest + initial YAML
 * stack + create the data dir. Does NOT spawn GRAIN — that's the
 * supervisor's responsibility (kept separate so this module is
 * testable without subprocesses).
 *
 * Throws if the privacy mode requires an nvpn network and none was
 * supplied. Refuses to overwrite an existing community dir; the
 * caller probes via listCommunities() / readCommunityManifest() if
 * they want create-or-update semantics.
 */
export async function createCommunity(
  input: CreateCommunityInput,
): Promise<CommunityManifest> {
  if (!input.name.trim()) {
    throw new Error('Community name must be non-empty.');
  }
  if (input.privacyMode === 'private-network' && !input.nvpnNetworkId) {
    throw new Error('private-network communities require nvpnNetworkId.');
  }
  if (input.privacyMode === 'local' && input.nvpnNetworkId) {
    throw new Error('local communities must not have nvpnNetworkId.');
  }

  const id   = newCommunityId();
  const dir  = communityDir(id);
  if (fs.existsSync(dir)) {
    throw new Error(`Community dir already exists: ${dir} (id collision)`);
  }

  const port = input.port ?? await allocateCommunityPort();
  const bindHost = input.bindHost
                ?? (input.privacyMode === 'local' ? '127.0.0.1' : '127.0.0.1');
  // Note: for private-network mode we INTENTIONALLY default to loopback
  // on create. The supervisor overwrites the bind to the actual nvpn
  // tunnel IP once it's discovered, so we never accidentally leave
  // GRAIN bound to a wider interface during the window between create
  // and supervisor start.

  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(communityDataDir(id), { recursive: true });

  const manifest: CommunityManifest = {
    id,
    name:           input.name,
    description:    input.description,
    privacyMode:    input.privacyMode,
    port,
    nvpnNetworkId:  input.nvpnNetworkId,
    adminPubkey:    input.adminPubkey,
    createdAt:      Date.now(),
    status:         'stopped',
  };
  writeCommunityManifest(manifest);

  // Initial GRAIN config — minimum viable so first spawn doesn't need
  // additional UI steps. Bind address gets rewritten by the supervisor
  // for private-network communities.
  writeGrainConfig(
    communityConfigPath(dir),
    defaultGrainConfig({ bindHostPort: `${bindHost}:${port}` }),
  );

  // Initial allowlist: admin + any explicit members. We dedupe and
  // normalize to lowercase hex; pubkey validity (64 hex chars) is
  // enforced by the caller / the API route, not here — this module
  // trusts its inputs and just persists them faithfully.
  const initial = new Set<string>();
  if (!input.skipAddAdmin) initial.add(input.adminPubkey.toLowerCase());
  for (const pk of input.memberPubkeys ?? []) initial.add(pk.toLowerCase());
  writeGrainWhitelist(
    communityWhitelistPath(dir),
    { pubkeys: Array.from(initial) },
  );

  // Don't pre-create blacklist.yml — its absence is meaningful (GRAIN
  // treats it as empty), and writing an empty file would just create
  // a no-op diff for moderators who hand-edit later.

  return manifest;
}

/** Write a manifest atomically; preserves any unknown fields. */
export function writeCommunityManifest(m: CommunityManifest): void {
  // JSON.stringify with 2-space indent so manual diffs / inspections
  // stay readable. Manifests are small — pretty-printing is cheap.
  atomicWriteFileSync(communityManifestPath(m.id), JSON.stringify(m, null, 2) + '\n');
}

/**
 * Apply a partial update to a manifest. Reads, merges, writes back.
 * Throws if the community doesn't exist — callers that want to be
 * tolerant probe via readCommunityManifest first.
 */
export function updateCommunityManifest(
  id: string,
  patch: Partial<Omit<CommunityManifest, 'id' | 'createdAt'>>,
): CommunityManifest {
  const existing = readCommunityManifest(id);
  if (!existing) throw new Error(`Community not found: ${id}`);
  const next: CommunityManifest = { ...existing, ...patch, id, createdAt: existing.createdAt };
  writeCommunityManifest(next);
  return next;
}

/**
 * Remove a community's directory recursively. Caller is responsible
 * for stopping the GRAIN process first; this module never touches
 * subprocesses (see comment at top of file).
 */
export function deleteCommunityDir(id: string): void {
  const dir = communityDir(id);
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

// =====================================================================
// Member helpers (allowlist mutations)

/**
 * Add a pubkey to a community's allowlist. Idempotent: re-adding
 * an existing member is a no-op. Returns the new pubkey list.
 */
export function addCommunityMember(id: string, pubkeyHex: string): string[] {
  const wlPath = communityWhitelistPath(communityDir(id));
  const wl     = readGrainWhitelist(wlPath);
  const pk     = pubkeyHex.toLowerCase();
  if (!wl.pubkeys.includes(pk)) {
    wl.pubkeys.push(pk);
    writeGrainWhitelist(wlPath, wl);
  }
  return wl.pubkeys;
}

/**
 * Remove a pubkey from a community's allowlist. Idempotent: removing
 * a non-member is a no-op. Returns the new pubkey list.
 */
export function removeCommunityMember(id: string, pubkeyHex: string): string[] {
  const wlPath = communityWhitelistPath(communityDir(id));
  const wl     = readGrainWhitelist(wlPath);
  const pk     = pubkeyHex.toLowerCase();
  const next   = wl.pubkeys.filter((x) => x !== pk);
  if (next.length !== wl.pubkeys.length) {
    writeGrainWhitelist(wlPath, { ...wl, pubkeys: next });
  }
  return next;
}

/** Read the current allowlist; convenience over going through community-yaml. */
export function listCommunityMembers(id: string): string[] {
  const wl = readGrainWhitelist(communityWhitelistPath(communityDir(id)));
  return [...wl.pubkeys];
}

// Re-exported so callers that hold the id can read GRAIN configs
// without learning the full directory layout convention.
export {
  communityConfigPath, communityWhitelistPath, communityBlacklistPath,
} from './community-yaml.js';
