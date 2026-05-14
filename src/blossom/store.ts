/**
 * Blob index + on-disk storage for the in-process Blossom server.
 *
 * SQLite carries the metadata (sha256 → size, mime, uploader); the raw
 * blob bytes live next to the DB as `<sha256>` files (mode 0600). One
 * file per blob keeps the index small + lets the OS handle paging.
 *
 * Concurrency: a single Database handle per process. WAL mode lets the
 * HTTP server's GETs proceed while a PUT is mid-write. better-sqlite3
 * is synchronous, so we don't need locking around the prepared
 * statements themselves — every call returns before the next can start.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import type { BlobRecord, BlossomStats, UploaderKind } from './types.js';

function defaultDataDir(): string {
  return path.join(os.homedir(), '.nostr-station', 'data', 'blobs');
}

export interface BlobStoreOptions {
  dataDir?:    string;
  quotaBytes?: number;
}

export class BlobStore {
  private db:        Database.Database;
  private dataDir:   string;
  private quota:     number;

  private stInsert:        Database.Statement;
  private stGetMeta:       Database.Statement;
  private stDelete:        Database.Statement;
  private stCountAll:      Database.Statement;
  private stSumSize:       Database.Statement;
  private stCountByKind:   Database.Statement;
  private stListPaged:     Database.Statement;

  constructor(opts: BlobStoreOptions = {}) {
    this.dataDir = opts.dataDir ?? defaultDataDir();
    this.quota   = opts.quotaBytes ?? Number(process.env.STATION_BLOSSOM_QUOTA_BYTES || (1024 * 1024 * 1024)); // 1 GiB

    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const dbPath = path.join(this.dataDir, 'blobs.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blobs (
        sha256          TEXT PRIMARY KEY,
        size            INTEGER NOT NULL,
        mime            TEXT    NOT NULL,
        uploader_pubkey TEXT    NOT NULL,
        uploader_kind   TEXT    NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS blobs_kind_idx ON blobs(uploader_kind);
    `);

    this.stInsert      = this.db.prepare(`
      INSERT OR REPLACE INTO blobs (sha256, size, mime, uploader_pubkey, uploader_kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.stGetMeta     = this.db.prepare(`SELECT * FROM blobs WHERE sha256 = ?`);
    this.stDelete      = this.db.prepare(`DELETE FROM blobs WHERE sha256 = ?`);
    this.stCountAll    = this.db.prepare(`SELECT COUNT(*) AS n FROM blobs`);
    this.stSumSize     = this.db.prepare(`SELECT COALESCE(SUM(size), 0) AS n FROM blobs`);
    this.stCountByKind = this.db.prepare(`SELECT uploader_kind AS k, COUNT(*) AS n FROM blobs GROUP BY uploader_kind`);
    this.stListPaged   = this.db.prepare(`SELECT * FROM blobs ORDER BY created_at DESC LIMIT ? OFFSET ?`);
  }

  // ── Read ────────────────────────────────────────────────────────────────
  get(sha256: string): BlobRecord | null {
    const row = this.stGetMeta.get(sha256) as any;
    if (!row) return null;
    return rowToRecord(row);
  }

  blobPath(sha256: string): string {
    return path.join(this.dataDir, sha256);
  }

  exists(sha256: string): boolean {
    if (!this.get(sha256)) return false;
    try { fs.statSync(this.blobPath(sha256)); return true; }
    catch { return false; }
  }

  // ── Write ───────────────────────────────────────────────────────────────
  // Atomic put: write bytes to a temp file, fsync, hash, then rename + insert.
  // Caller passes the raw body buffer — for the in-process case we accept the
  // whole buffer in memory (apps under nostr-station upload via fetch, not
  // streamed multipart, so chunks are bounded by the quota check below).
  put(body: Buffer, mime: string, uploaderPubkey: string, uploaderKind: UploaderKind): {
    ok: true; record: BlobRecord;
  } | {
    ok: false; reason: 'quota-exceeded' | 'sha-mismatch' | 'invalid-mime';
    expected?: string; got?: string;
  } {
    if (typeof mime !== 'string' || !mime) return { ok: false, reason: 'invalid-mime' };

    const totalNow = Number((this.stSumSize.get() as any).n) || 0;
    if (totalNow + body.length > this.quota) {
      return { ok: false, reason: 'quota-exceeded' };
    }

    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const target = this.blobPath(sha256);
    const tmp    = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, target);

    const createdAt = Date.now();
    this.stInsert.run(sha256, body.length, mime, uploaderPubkey, uploaderKind, createdAt);

    return {
      ok: true,
      record: {
        sha256, size: body.length, mime,
        uploaderPubkey, uploaderKind, createdAt,
      },
    };
  }

  delete(sha256: string): boolean {
    const r = this.stDelete.run(sha256);
    if (r.changes === 0) return false;
    try { fs.unlinkSync(this.blobPath(sha256)); } catch {}
    return true;
  }

  wipe(): void {
    // Iterate sha256s, unlink each, then truncate the table.
    const rows = this.db.prepare(`SELECT sha256 FROM blobs`).all() as any[];
    for (const r of rows) {
      try { fs.unlinkSync(this.blobPath(r.sha256)); } catch {}
    }
    this.db.exec(`DELETE FROM blobs`);
  }

  // ── Stats / listing ─────────────────────────────────────────────────────
  stats(): BlossomStats {
    const count = Number((this.stCountAll.get() as any).n) || 0;
    const total = Number((this.stSumSize.get()  as any).n) || 0;
    const byKind = { owner: 0, whitelist: 0, 'test-identity': 0 };
    for (const r of this.stCountByKind.all() as any[]) {
      const k = r.k as UploaderKind;
      if (k in byKind) byKind[k] = Number(r.n) || 0;
    }
    return {
      blobCount:     count,
      totalBytes:    total,
      uploadsByKind: byKind,
      quotaBytes:    this.quota,
      dataDir:       this.dataDir,
    };
  }

  list(limit: number, offset: number): BlobRecord[] {
    const safeLimit  = Math.max(1, Math.min(500, Math.floor(limit  || 50)));
    const safeOffset = Math.max(0, Math.floor(offset || 0));
    const rows = this.stListPaged.all(safeLimit, safeOffset) as any[];
    return rows.map(rowToRecord);
  }

  close(): void {
    try { this.db.close(); } catch {}
  }
}

function rowToRecord(row: any): BlobRecord {
  return {
    sha256:          row.sha256,
    size:            Number(row.size) || 0,
    mime:            row.mime,
    uploaderPubkey:  row.uploader_pubkey,
    uploaderKind:    row.uploader_kind as UploaderKind,
    createdAt:       Number(row.created_at) || 0,
  };
}
