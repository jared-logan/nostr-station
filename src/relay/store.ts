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

// Decoded kind-0 profile metadata, materialized at ingest so the
// dashboard never re-parses JSON when rendering pubkeys. Mirrors the
// shape of nostrdb's profile flatbuffer record (name, display_name,
// nip05, picture, lud16, about, banner, website) without committing
// to its on-disk format.
export interface ProfileRecord {
  pubkey:       string;
  name:         string | null;
  display_name: string | null;
  nip05:        string | null;
  picture:      string | null;
  lud16:        string | null;
  about:        string | null;
  banner:       string | null;
  website:      string | null;
  updated_at:   number;
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
  private stUpsertProfile!:      Database.Statement;
  private stGetProfile!:         Database.Statement;

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
        event_id   TEXT NOT NULL,
        tag_name   TEXT NOT NULL,
        tag_value  TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_tags_lookup ON tags(tag_name, tag_value);
      CREATE INDEX IF NOT EXISTS idx_tags_event  ON tags(event_id);

      -- Decoded kind-0 profile metadata, one row per pubkey, updated on
      -- ingest. Deliberately NOT FK'd to events.id: profiles outlive
      -- the underlying kind-0 events when those get evicted by the
      -- maxEvents cap, so the dashboard still resolves pubkeys to names
      -- for senders/authors we have history on but haven't refreshed
      -- recently.
      CREATE TABLE IF NOT EXISTS profiles (
        pubkey       TEXT PRIMARY KEY,
        name         TEXT,
        display_name TEXT,
        nip05        TEXT,
        picture      TEXT,
        lud16        TEXT,
        about        TEXT,
        banner       TEXT,
        website      TEXT,
        updated_at   INTEGER NOT NULL
      );
    `);
    this.db.pragma('foreign_keys = ON');

    this.migrate(dbPath);

    this.prepareStatements();
  }

  // One-shot migration step for databases created before the composite
  // index work. Detects the absence of tags.created_at and, if needed:
  //   1. Writes a best-effort .bak copy alongside the live db so a user
  //      who hits a corner case can recover via `mv relay.db.bak relay.db`.
  //   2. Wraps the ALTER + backfill in a single transaction so an
  //      interrupted migration leaves the old schema intact rather than
  //      a half-populated created_at column.
  // The composite indexes themselves are added via CREATE INDEX IF NOT
  // EXISTS below the migration block — safe on both fresh and migrated
  // databases.
  private migrate(dbPath: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(tags)`).all() as Array<{ name: string }>;
    const hasCreatedAt = cols.some(c => c.name === 'created_at');

    if (!hasCreatedAt) {
      try {
        const bakPath = `${dbPath}.bak`;
        if (fs.existsSync(dbPath) && !fs.existsSync(bakPath)) {
          fs.copyFileSync(dbPath, bakPath);
        }
      } catch {
        // Best-effort backup: a failed copy (e.g. disk full) should not
        // block the migration — the transaction below still gives
        // all-or-nothing semantics on the live db.
      }

      const run = this.db.transaction(() => {
        this.db.exec(`ALTER TABLE tags ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`);
        this.db.exec(`
          UPDATE tags
             SET created_at = (SELECT created_at FROM events WHERE events.id = tags.event_id)
           WHERE created_at = 0
        `);
      });
      run();
    }

    // Composite indexes — additive, idempotent. The two leading-column
    // single-column indexes (idx_events_pubkey, idx_tags_lookup) are
    // kept for queries that don't constrain the trailing columns.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_pubkey_kind_ts
        ON events(pubkey, kind, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tags_lookup_ts
        ON tags(tag_name, tag_value, created_at DESC);
    `);

    // Backfill profiles from already-stored kind-0 events. Cheap on
    // 100k-event corpora (typically a few thousand kind-0s, sub-second).
    // Skipped once profiles is non-empty so subsequent boots are no-ops.
    const profileCount = (this.db.prepare(`SELECT COUNT(*) AS n FROM profiles`).get() as { n: number }).n;
    if (profileCount === 0) {
      const kind0s = this.db.prepare(
        `SELECT pubkey, created_at, content FROM events WHERE kind = 0`,
      ).all() as Array<{ pubkey: string; created_at: number; content: string }>;
      if (kind0s.length > 0) {
        const upsert = this.db.prepare(
          `INSERT INTO profiles (pubkey, name, display_name, nip05, picture, lud16, about, banner, website, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(pubkey) DO UPDATE SET
             name=excluded.name, display_name=excluded.display_name, nip05=excluded.nip05,
             picture=excluded.picture, lud16=excluded.lud16, about=excluded.about,
             banner=excluded.banner, website=excluded.website, updated_at=excluded.updated_at
           WHERE excluded.updated_at > profiles.updated_at`,
        );
        const run = this.db.transaction(() => {
          for (const row of kind0s) {
            let raw: any;
            try { raw = JSON.parse(row.content); } catch { continue; }
            if (!raw || typeof raw !== 'object') continue;
            const s = (k: string): string | null => {
              const v = raw[k];
              return typeof v === 'string' && v.length > 0 ? v : null;
            };
            upsert.run(
              row.pubkey,
              s('name'),
              s('display_name') ?? s('displayName'),
              s('nip05'),
              s('picture'),
              s('lud16') ?? s('lud06'),
              s('about'),
              s('banner'),
              s('website'),
              row.created_at,
            );
          }
        });
        run();
      }
    }
  }

  private prepareStatements(): void {
    this.stInsertEvent = this.db.prepare(
      `INSERT INTO events (id, pubkey, created_at, kind, content, sig, tags_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stInsertTag = this.db.prepare(
      `INSERT INTO tags (event_id, tag_name, tag_value, created_at) VALUES (?, ?, ?, ?)`,
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
    // Newer kind-0 events overwrite older metadata; older ones are
    // dropped via the WHERE clause so an out-of-order replay of a stale
    // profile event can't clobber a fresh one.
    this.stUpsertProfile = this.db.prepare(
      `INSERT INTO profiles (pubkey, name, display_name, nip05, picture, lud16, about, banner, website, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pubkey) DO UPDATE SET
         name         = excluded.name,
         display_name = excluded.display_name,
         nip05        = excluded.nip05,
         picture      = excluded.picture,
         lud16        = excluded.lud16,
         about        = excluded.about,
         banner       = excluded.banner,
         website      = excluded.website,
         updated_at   = excluded.updated_at
       WHERE excluded.updated_at > profiles.updated_at`,
    );
    this.stGetProfile = this.db.prepare(
      `SELECT pubkey, name, display_name, nip05, picture, lud16, about, banner, website, updated_at
         FROM profiles WHERE pubkey = ? LIMIT 1`,
    );
  }

  // Pull display fields out of a kind-0 event's content. Defensive: any
  // parse failure or unexpected shape returns null so a malformed profile
  // event can never break ingest. Field names follow the common pattern
  // documented in NIP-24 (some clients use display_name, others
  // displayName — accept both).
  private decodeProfile(ev: NostrEvent): ProfileRecord | null {
    let raw: unknown;
    try { raw = JSON.parse(ev.content); }
    catch { return null; }
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const s = (k: string): string | null => {
      const v = o[k];
      return typeof v === 'string' && v.length > 0 ? v : null;
    };
    return {
      pubkey:       ev.pubkey,
      name:         s('name'),
      display_name: s('display_name') ?? s('displayName'),
      nip05:        s('nip05'),
      picture:      s('picture'),
      lud16:        s('lud16') ?? s('lud06'),
      about:        s('about'),
      banner:       s('banner'),
      website:      s('website'),
      updated_at:   ev.created_at,
    };
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
          this.stInsertTag.run(e.id, t[0], t[1], e.created_at);
        }
      }
      // Materialize kind-0 profiles inside the same transaction as the
      // event insert so a crash mid-insert leaves events and profiles
      // consistent. The upsert's WHERE clause discards out-of-order
      // older events automatically.
      if (e.kind === 0) {
        const p = this.decodeProfile(e);
        if (p) {
          this.stUpsertProfile.run(
            p.pubkey, p.name, p.display_name, p.nip05, p.picture,
            p.lud16, p.about, p.banner, p.website, p.updated_at,
          );
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

  // Look up a materialized profile for one pubkey. Returns null when
  // we've never ingested a kind-0 for that key — callers should fall
  // back to a truncated npub render.
  getProfile(pubkey: string): ProfileRecord | null {
    const row = this.stGetProfile.get(pubkey) as ProfileRecord | undefined;
    return row ?? null;
  }

  // Bulk variant for "give me everyone in this thread / feed at once".
  // Returns a Map keyed by pubkey so callers can do O(1) lookups while
  // rendering. Missing pubkeys are simply absent from the map.
  getProfiles(pubkeys: string[]): Map<string, ProfileRecord> {
    const out = new Map<string, ProfileRecord>();
    if (pubkeys.length === 0) return out;
    const placeholders = pubkeys.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT pubkey, name, display_name, nip05, picture, lud16, about, banner, website, updated_at
         FROM profiles WHERE pubkey IN (${placeholders})`,
    ).all(...pubkeys) as ProfileRecord[];
    for (const r of rows) out.set(r.pubkey, r);
    return out;
  }

  // Stream every event in created_at ASC order. Yields one at a time via
  // better-sqlite3's iterator so a relay with hundreds of thousands of
  // events doesn't have to fit in memory during /api/relay/database/export.
  *iterAll(): Generator<NostrEvent> {
    const stmt = this.db.prepare(
      'SELECT id, pubkey, created_at, kind, content, sig, tags_json FROM events ORDER BY created_at ASC',
    );
    for (const r of stmt.iterate() as IterableIterator<{
      id: string; pubkey: string; created_at: number;
      kind: number; content: string; sig: string; tags_json: string;
    }>) {
      yield {
        id:         r.id,
        pubkey:     r.pubkey,
        created_at: r.created_at,
        kind:       r.kind,
        content:    r.content,
        sig:        r.sig,
        tags:       JSON.parse(r.tags_json) as string[][],
      };
    }
  }

  // Empty the relay. The tags table cascades, then VACUUM reclaims pages
  // so the on-disk file shrinks alongside the row count (otherwise sqlite
  // keeps the file at high-water mark and the Relay panel's "wipe" button
  // looks like it did nothing). No service restart needed — the EventStore
  // sits inside the dashboard process, callers just keep using it.
  wipe(): void {
    this.db.exec('DELETE FROM events');
    this.db.exec('DELETE FROM profiles');
    this.db.exec('VACUUM');
  }

  close(): void {
    this.db.close();
  }
}
