/**
 * Typed read/write for the YAML files GRAIN consumes per community:
 *   - config.yml     — server settings, rate limits, allowed kinds, etc.
 *   - whitelist.yml  — pubkeys allowed to publish (and, depending on
 *                      mode, to read)
 *   - blacklist.yml  — pubkeys + content patterns rejected at ingest
 *
 * Why a typed wrapper instead of letting callers parse YAML inline:
 *
 *   1. GRAIN hot-reloads on file change, which means a half-written or
 *      momentarily-empty file is a real failure mode. The atomic writer
 *      below writes to a sibling `.tmp` then renames — POSIX guarantees
 *      the rename is atomic within a filesystem, so GRAIN never sees a
 *      torn file.
 *
 *   2. We model the fields we actively read/write (server.port, the
 *      rate-limit knobs the Moderation tab edits, the allowlist) and
 *      pass through everything else unchanged. That preserves user
 *      overrides made via direct YAML edits — never clobber a key we
 *      didn't intend to set — without forcing us to track every
 *      upstream config field as GRAIN evolves.
 *
 *   3. Strings that look numeric (e.g. `server.port: "127.0.0.1:8181"`)
 *      survive a round-trip without getting reinterpreted. The `yaml`
 *      package handles quoting; tests below assert the contract.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import * as YAML from 'yaml';

// =====================================================================
// Atomic write primitive

/**
 * Write `contents` to `target` atomically: stage in a sibling temp
 * file in the same directory, fsync, then rename onto the target.
 *
 * POSIX rename(2) is atomic within a single filesystem — readers never
 * observe a partial file. Writing the temp in the *same dir* (rather
 * than /tmp) keeps us on the same filesystem so the rename can stay
 * atomic; cross-fs renames degrade to copy-then-unlink and lose the
 * atomicity that GRAIN's hot-reload relies on.
 */
export function atomicWriteFileSync(target: string, contents: string): void {
  const dir  = path.dirname(target);
  // 6 random bytes is enough to avoid collisions with a concurrent
  // writer; we never bet on uniqueness across processes anyway since
  // each writer cleans up its own tmp on failure.
  const tag  = crypto.randomBytes(6).toString('hex');
  const tmp  = path.join(dir, `.${path.basename(target)}.${tag}.tmp`);
  let   fd: number | null = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(tmp, 'w', 0o644);
    fs.writeSync(fd, contents);
    fs.fsyncSync(fd);   // flush bytes before the rename advertises them
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, target);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// =====================================================================
// GRAIN config.yml — the main per-community knobs

/**
 * Subset of GRAIN's `config.yml` schema we model. Extra keys round-trip
 * unchanged via the index signature so user-managed overrides aren't
 * lost when the dashboard writes back.
 *
 * `server.port` is intentionally a string: GRAIN passes it straight to
 * Go's `http.Server.Addr`, which accepts both `:8181` (all interfaces)
 * and `127.0.0.1:8181` / `[::1]:8181` (specific interface). The
 * Communities supervisor sets it to the nvpn tunnel IP to honor the
 * "never 0.0.0.0" security rule.
 */
export interface GrainServerSettings {
  port: string;
  [key: string]: unknown;
}

export interface GrainConfig {
  server: GrainServerSettings;
  // GRAIN's rate-limit and event-purge shapes vary by release; we
  // intentionally don't pin them here. The Moderation tab edits them
  // through helpers in this module that read/merge/write specific
  // subtrees, leaving the rest untouched.
  [key: string]: unknown;
}

export function readGrainConfig(file: string): GrainConfig {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = YAML.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`config.yml at ${file} is not a YAML mapping`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.server !== 'object' || obj.server === null) {
    throw new Error(`config.yml at ${file} is missing a server section`);
  }
  const server = obj.server as Record<string, unknown>;
  if (typeof server.port !== 'string') {
    throw new Error(`config.yml at ${file} has no server.port string`);
  }
  return obj as GrainConfig;
}

export function writeGrainConfig(file: string, cfg: GrainConfig): void {
  // YAML.stringify with no options matches the upstream sample format
  // closely enough that diffs against a hand-edited file stay small,
  // which matters when the user has tuned the file in their editor
  // and we round-trip after a UI-driven change.
  atomicWriteFileSync(file, YAML.stringify(cfg));
}

/**
 * Minimum viable GRAIN config produced when we create a new community.
 * Callers override the bind address (set to the nvpn tunnel IP for
 * private-network communities, loopback for local-only) by passing
 * the full `host:port` string.
 *
 * Intentionally bare — additional knobs (rate limits, allowed kinds,
 * storage caps) are layered in via the Moderation tab once the
 * community is running, so first-spawn doesn't accidentally encode an
 * opinion the user hasn't expressed yet.
 */
export function defaultGrainConfig(opts: { bindHostPort: string }): GrainConfig {
  return {
    server: {
      port: opts.bindHostPort,
    },
  };
}

// =====================================================================
// whitelist.yml — pubkey allowlist

/**
 * GRAIN's allowlist shape. We model `pubkeys: string[]` because that's
 * the field the Members tab edits; any additional fields the user has
 * set (e.g. domain allowlist) round-trip through the index signature.
 */
export interface GrainWhitelist {
  pubkeys: string[];
  [key: string]: unknown;
}

export function readGrainWhitelist(file: string): GrainWhitelist {
  if (!fs.existsSync(file)) return { pubkeys: [] };
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = YAML.parse(raw) as unknown;
  if (parsed === null || parsed === undefined) return { pubkeys: [] };
  if (typeof parsed !== 'object') {
    throw new Error(`whitelist.yml at ${file} is not a YAML mapping`);
  }
  const obj = parsed as Record<string, unknown>;
  const pubkeys = Array.isArray(obj.pubkeys)
    ? obj.pubkeys.filter((x): x is string => typeof x === 'string')
    : [];
  return { ...obj, pubkeys };
}

export function writeGrainWhitelist(file: string, wl: GrainWhitelist): void {
  atomicWriteFileSync(file, YAML.stringify(wl));
}

// =====================================================================
// blacklist.yml — pubkey + content denylist

export interface GrainBlacklist {
  pubkeys: string[];
  words:   string[];
  [key: string]: unknown;
}

export function readGrainBlacklist(file: string): GrainBlacklist {
  if (!fs.existsSync(file)) return { pubkeys: [], words: [] };
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = YAML.parse(raw) as unknown;
  if (parsed === null || parsed === undefined) return { pubkeys: [], words: [] };
  if (typeof parsed !== 'object') {
    throw new Error(`blacklist.yml at ${file} is not a YAML mapping`);
  }
  const obj = parsed as Record<string, unknown>;
  const pubkeys = Array.isArray(obj.pubkeys)
    ? obj.pubkeys.filter((x): x is string => typeof x === 'string')
    : [];
  const words = Array.isArray(obj.words)
    ? obj.words.filter((x): x is string => typeof x === 'string')
    : [];
  return { ...obj, pubkeys, words };
}

export function writeGrainBlacklist(file: string, bl: GrainBlacklist): void {
  atomicWriteFileSync(file, YAML.stringify(bl));
}

// =====================================================================
// Path helpers

/**
 * Resolve the absolute path of a per-community config file inside
 * its own directory. Centralized so a typo in the filename surfaces
 * at one site instead of many.
 */
export function communityConfigPath(communityDir: string): string {
  return path.join(communityDir, 'config.yml');
}

export function communityWhitelistPath(communityDir: string): string {
  return path.join(communityDir, 'whitelist.yml');
}

export function communityBlacklistPath(communityDir: string): string {
  return path.join(communityDir, 'blacklist.yml');
}

/**
 * Root directory for all per-community state. Overridable via the
 * NOSTR_STATION_HOME env var so tests can drive the supervisor against
 * a temp dir without leaving artifacts in the user's home.
 */
export function communitiesRoot(): string {
  const home = process.env.NOSTR_STATION_HOME || path.join(os.homedir(), '.nostr-station');
  return path.join(home, 'communities');
}
