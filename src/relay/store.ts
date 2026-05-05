import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { NostrEvent, NostrFilter } from './types.js';

// SQLite-backed event store for the in-process relay.
//
// Schema is intentionally tiny: one events table plus a tags table for
// indexed tag filter queries. Replaceable / parameterized-replaceable
// semantics are enforced at insert time by deleting older versions, so
// downstream queries don't need to know about it.

export interface StoreOptions {
  // Absolute path to the sqlite file. Defaults to ~/.nostr-station/data/relay.db
  // — picked at the repo level so a user can `rm -rf ~/.nostr-station/data`
  // for a clean slate without nuking config / keychain entries.
  dbPath?: string;
  // Cap on total stored events. When exceeded, the oldest events by
  // created_at are evicted. 0 disables the cap. The default is generous
  // for a single-user dev relay.
  maxEvents?: number;
}

export const DEFAULT_DB_PATH = path.join(os.homedir(), '.nostr-station', 'data', 'relay.db');
const DEFAULT_MAX_EVENTS = 100_000;

// Replaceable event ranges per NIP-01. Inserting a newer event of the
// same (kind, pubkey) deletes the older one; for parameterized
// replaceable, the d-tag value is part of the identity.
function isReplaceable(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10_000 && kind < 20_000);
}
function isParamReplaceable(kind: number): boolean {
  return kind >= 30_000 && kind < 40_000;
}

function dTagValue(tags: string[][]): string {
  const t = tags.find(t => t[0] === 'd');
  return t?.[1] ?? '';
}

export class EventStore {
  private db: Database.Database;
  private maxEvents: number;

  // Prepared statements — all created once in the constructor and reused
  // for every read/write. better-sqlite3's Statement objects are
  // thread-safe with respect to the single-threaded event loop and
  // significantly faster than ad-hoc db.prepare() per call.
  private stInsertEvent!:        Database.Statement;
  private stInsertTag!:          Database.Statement;
  private stHasEvent!:           Database.Statement;
  private stDeleteByKindAuthor!: Database.Statement;
  private stDeleteByKindAuthorD!:Database.Statement;
  private stCount!:              Database.Statement;
  private stEvictOldest!:        Database.Statement;

  constructor(opts: StoreOptions = {}) {
    const dbPath = opts.dbPath ?? DEFAULT_DB_PATH;
    this.maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    // WAL mode lets readers and writers operate concurrently — relevant
    // for the relay because dashboard queries (e.g. recent-events panel)
    // can run alongside live ingestion without blocking each other.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id          TEXT PRIMARY KEY,
        pubkey      TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        kind        INTEGER NOT NULL,
        content     TEXT NOT NULL,
        sig         TEXT NOT NULL,
        tags_json   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
      CREATE INDEX IF NOT EXISTS idx_events_pubkey     ON events(pubkey);
      CREATE INDEX IF NOT EXISTS idx_events_kind       ON events(kind);

      CREATE TABLE IF NOT EXISTS tags (
        event_id  TEXT NOT NULL,
        tag_name  TEXT NOT NULL,
        tag_value TEXT NOT NULL,
        FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_tags_lookup ON tags(tag_name, tag_value);
      CREATE INDEX IF NOT EXISTS idx_tags_event  ON tags(event_id);
    `);
    this.db.pragma('foreign_keys = ON');

    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stInsertEvent = this.db.prepare(
      `INSERT INTO events (id, pubkey, created_at, kind, content, sig, tags_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stInsertTag = this.db.prepare(
      `INSERT INTO tags (event_id, tag_name, tag_value) VALUES (?, ?, ?)`,
    );
    this.stHasEvent = this.db.prepare(`SELECT 1 FROM events WHERE id = ? LIMIT 1`);
    this.stDeleteByKindAuthor = this.db.prepare(
      `DELETE FROM events WHERE kind = ? AND pubkey = ? AND created_at < ?`,
    );
    // Parameterized-replaceable: identity is (kind, pubkey, d-tag value).
    // We join on tags to find prior versions sharing the same d value.
    this.stDeleteByKindAuthorD = this.db.prepare(
      `DELETE FROM events
       WHERE id IN (
         SELECT e.id FROM events e
         JOIN tags t ON t.event_id = e.id AND t.tag_name = 'd' AND t.tag_value = ?
         WHERE e.kind = ? AND e.pubkey = ? AND e.created_at < ?
       )`,
    );
    this.stCount       = this.db.prepare(`SELECT COUNT(*) AS n FROM events`);
    this.stEvictOldest = this.db.prepare(
      `DELETE FROM events WHERE id IN (
         SELECT id FROM events ORDER BY created_at ASC LIMIT ?
       )`,
    );
  }

  // Returns true if the event was stored (or already existed), false on
  // a duplicate-after-replace (caller treats both as ack-OK).
  add(ev: NostrEvent): { stored: boolean; duplicate: boolean } {
    if (this.stHasEvent.get(ev.id)) return { stored: false, duplicate: true };

    const insert = this.db.transaction((e: NostrEvent) => {
      if (isReplaceable(e.kind)) {
        this.stDeleteByKindAuthor.run(e.kind, e.pubkey, e.created_at);
      } else if (isParamReplaceable(e.kind)) {
        this.stDeleteByKindAuthorD.run(dTagValue(e.tags), e.kind, e.pubkey, e.created_at);
      }
      this.stInsertEvent.run(e.id, e.pubkey, e.created_at, e.kind, e.content, e.sig, JSON.stringify(e.tags));
      for (const t of e.tags) {
        // Index only single-letter tags — those are the ones queryable
        // via #x filters per NIP-01. Long-named tags are still stored in
        // tags_json on the event row, just not in the indexed table.
        if (t[0] && t[0].length === 1 && typeof t[1] === 'string') {
          this.stInsertTag.run(e.id, t[0], t[1]);
        }
      }
    });

    insert(ev);

    if (this.maxEvents > 0) {
      const n = (this.stCount.get() as { n: number }).n;
      if (n > this.maxEvents) this.stEvictOldest.run(n - this.maxEvents);
    }

    return { stored: true, duplicate: false };
  }

  // Run a single NIP-01 filter against the store. Pure read, no mutation.
  query(f: NostrFilter): NostrEvent[] {
    const where: string[] = [];
    const params: any[]   = [];

    if (f.ids?.length) {
      where.push(`id IN (${f.ids.map(() => '?').join(',')})`);
      params.push(...f.ids);
    }
    if (f.authors?.length) {
      where.push(`pubkey IN (${f.authors.map(() => '?').join(',')})`);
      params.push(...f.authors);
    }
    if (f.kinds?.length) {
      where.push(`kind IN (${f.kinds.map(() => '?').join(',')})`);
      params.push(...f.kinds);
    }
    if (f.since !== undefined) {
      where.push(`created_at >= ?`);
      params.push(f.since);
    }
    if (f.until !== undefined) {
      where.push(`created_at <= ?`);
      params.push(f.until);
    }

    // Tag filters: each #x filter contributes an IN-subquery against the
    // tags table. ANDed across multiple #x filters per NIP-01.
    for (const key of Object.keys(f)) {
      if (!key.startsWith('#') || key.length !== 2) continue;
      const vals = f[key as `#${string}`];
      if (!Array.isArray(vals) || vals.length === 0) continue;
      where.push(
        `id IN (SELECT event_id FROM tags WHERE tag_name = ? AND tag_value IN (${vals.map(() => '?').join(',')}))`,
      );
      params.push(key.slice(1), ...vals);
    }

    const limit = Math.max(1, Math.min(f.limit ?? 500, 5000));
    const sql = `
      SELECT id, pubkey, created_at, kind, content, sig, tags_json
      FROM events
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC
      LIMIT ?
    `;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id:         string;
      pubkey:     string;
      created_at: number;
      kind:       number;
      content:    string;
      sig:        string;
      tags_json:  string;
    }>;

    return rows.map(r => ({
      id:         r.id,
      pubkey:     r.pubkey,
      created_at: r.created_at,
      kind:       r.kind,
      content:    r.content,
      sig:        r.sig,
      tags:       JSON.parse(r.tags_json) as string[][],
    }));
  }

  // Dedupe + concatenate across multiple filters within one REQ.
  // NIP-01: the union of all filter results, ordered by created_at DESC,
  // capped at the largest filter's limit.
  queryMany(filters: NostrFilter[]): NostrEvent[] {
    if (filters.length === 0) return [];
    const seen = new Set<string>();
    const out: NostrEvent[] = [];
    for (const f of filters) {
      for (const ev of this.query(f)) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        out.push(ev);
      }
    }
    out.sort((a, b) => b.created_at - a.created_at);
    return out;
  }

  count(): number {
    return (this.stCount.get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
