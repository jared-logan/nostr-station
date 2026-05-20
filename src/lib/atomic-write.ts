/**
 * Atomic config/state file writes.
 *
 * Naive `fs.writeFileSync(finalPath, …)` is non-atomic: a kill -9 (or
 * an OOM-killer hit) during the write leaves the target truncated,
 * and the next read of that file crashes the process or silently
 * loses state. This module is the single shared pattern: write to a
 * randomized tmp neighbor, set mode, rename. POSIX `rename(2)` is
 * atomic — either the file is fully there or fully isn't, never
 * half-written.
 *
 * Use for: identity.json, projects.json, bunker-client.json,
 * nsite.json, keychain-encrypted secrets, per-project config files,
 * the user-editable station-context overlay. NOT needed for the
 * relay's better-sqlite3 store (SQLite handles its own atomicity)
 * or for one-off log / export files where partial writes are fine.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface AtomicWriteOpts {
  /** File mode for the final file (default 0o600). */
  mode?:    number;
  /** Mode for any directories `mkdir -p` creates (default 0o700). */
  dirMode?: number;
}

/**
 * Atomically write `content` to `filePath`. Creates parent
 * directories with `dirMode` if missing. The temp file's name
 * includes a random suffix so concurrent writers don't collide on
 * each other's tmp file.
 *
 * Implementation note: writeFileSync's `mode` option only applies
 * on file CREATE, not OVERWRITE — for safety we always chmod the
 * tmp file before renaming. The rename inherits the tmp's mode.
 */
export function atomicWriteText(filePath: string, content: string, opts: AtomicWriteOpts = {}): void {
  const mode    = opts.mode    ?? 0o600;
  const dirMode = opts.dirMode ?? 0o700;
  const dir     = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: dirMode });
  const tmp = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { mode });
    // Defensive: mode flag on writeFileSync only applies on create.
    // Force the bit pattern in case the file existed via a prior
    // partial run or the OS umask widened it.
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    // Best-effort cleanup of the orphan tmp.
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

/**
 * Atomically write `data` as pretty-printed JSON. Trailing newline
 * matches the convention used by every existing config writer in
 * the codebase (see `nsite-config.ts` for the explicit case).
 */
export function atomicWriteJson(filePath: string, data: unknown, opts: AtomicWriteOpts = {}): void {
  atomicWriteText(filePath, JSON.stringify(data, null, 2) + '\n', opts);
}
