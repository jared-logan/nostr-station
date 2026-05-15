/**
 * SQLite-backed persistence for decrypted mail.
 *
 * Lives at ~/.nostr-station/data/mail.db, separate from the relay store
 * — the relay db churns through public events and gets wiped on `rm -rf
 * ~/.nostr-station/data/relay.db` for a clean dev slate, which we don't
 * want to apply to the user's private mail. Co-locating in the same
 * data dir keeps backups simple.
 *
 * Schema:
 *
 *   messages
 *     id           rumor id (NIP-01 event hash of the unsigned rumor)
 *     counterparty hex pubkey of the OTHER party in the thread —
 *                  recipient for outgoing, sender for incoming
 *     direction    'in' | 'out'
 *     kind         rumor kind — 14 for DMs, 15 for file messages
 *     subject      from the ["subject", …] tag, or empty
 *     body         rumor content
 *     tags_json    full rumor.tags array as JSON
 *     created_at   rumor's created_at, in seconds
 *     read         0/1 — local-only flag
 *     wrap_id      id of the gift wrap we decoded from
 *     received_at  unix ms when we stored this row
 *
 *   seen_wraps
 *     wrap_id      id of a kind-1059 we've already processed; avoids
 *                  re-decrypting on relay re-delivery
 *     received_at  unix ms
 *
 * The store does not retain seal or wrap ciphertext beyond the wrap_id
 * — decryption is one-way, and re-displaying decrypted text doesn't
 * benefit from keeping the ciphertext around.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { KIND_DM_RUMOR, KIND_FILE_RUMOR, type Rumor } from './types.js';

export interface StoredMessage {
  id:           string;
  counterparty: string;
  direction:    'in' | 'out';
  kind:         number;
  subject:      string;
  body:         string;
  tags:         string[][];
  created_at:   number;
  read:         boolean;
  wrap_id:      string;
}

export interface ThreadSummary {
  counterparty:    string;
  last_subject:    string;
  last_preview:    string;
  last_created_at: number;
  unread:          number;
  total:           number;
}

// 'inbox'      — messages from trusted senders (contacts, allowlisted,
//                or our own outgoing mail).
// 'quarantine' — incoming wraps from senders we don't know yet. Shown
//                in the Requests tab so the user can accept / block.
export type MessageBucket = 'inbox' | 'quarantine';

const DEFAULT_DB_PATH = path.join(os.homedir(), '.nostr-station', 'data', 'mail.db');

export class MailStore {
  private db: Database.Database;

  // Prepared statements. Created once in the constructor; reused for
  // every read/write — same model as relay/store.ts.
  private stInsertMessage!: Database.Statement;
  private stHasMessage!:    Database.Statement;
  private stHasSeenWrap!:   Database.Statement;
  private stInsertSeenWrap!:Database.Statement;
  private stMarkRead!:      Database.Statement;
  private stMessagesByCounterparty!: Database.Statement;
  private stCountUnreadByCounterparty!: Database.Statement;
  private stThreadSummary!: Database.Statement;
  // Spam-protection statements (PR 7).
  private stThreadSummaryByStatus!:   Database.Statement;
  private stUpdateStatusByCounter!:   Database.Statement;
  private stDeleteByCounterparty!:    Database.Statement;
  private stIsAllowlisted!:           Database.Statement;
  private stIsBlocklisted!:           Database.Statement;
  private stAddAllow!:                Database.Statement;
  private stRemoveAllow!:             Database.Statement;
  private stAddBlock!:                Database.Statement;
  private stRemoveBlock!:             Database.Statement;
  private stListAllow!:               Database.Statement;
  private stListBlock!:               Database.Statement;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id           TEXT PRIMARY KEY,
        counterparty TEXT NOT NULL,
        direction    TEXT NOT NULL,
        kind         INTEGER NOT NULL,
        subject      TEXT NOT NULL DEFAULT '',
        body         TEXT NOT NULL DEFAULT '',
        tags_json    TEXT NOT NULL DEFAULT '[]',
        created_at   INTEGER NOT NULL,
        read         INTEGER NOT NULL DEFAULT 0,
        wrap_id      TEXT NOT NULL,
        received_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_thread
        ON messages(counterparty, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_created_at
        ON messages(created_at DESC);

      CREATE TABLE IF NOT EXISTS seen_wraps (
        wrap_id     TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL
      );

      -- Spam protection (PR 7).
      -- Allowlist + blocklist of pubkeys. Allowlist routes incoming
      -- mail straight to the inbox bucket; blocklist drops it before
      -- it ever hits the store.
      CREATE TABLE IF NOT EXISTS mail_allowlist (
        pubkey   TEXT PRIMARY KEY,
        added_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mail_blocklist (
        pubkey   TEXT PRIMARY KEY,
        added_at INTEGER NOT NULL
      );
    `);

    // Spam protection (PR 7): backfill a `status` column on messages so
    // every row maps to either 'inbox' or 'quarantine'. Rows that
    // pre-date this column are treated as 'inbox' — pre-spam-bucket
    // mail keeps showing where the user already saw it.
    const cols = this.db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'status')) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'inbox'`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_status_thread
                  ON messages(status, counterparty, created_at DESC)`);

    this.prepare();
  }

  private prepare(): void {
    this.stInsertMessage = this.db.prepare(
      `INSERT OR IGNORE INTO messages
         (id, counterparty, direction, kind, subject, body, tags_json,
          created_at, read, wrap_id, received_at, status)
       VALUES
         (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    );
    this.stHasMessage  = this.db.prepare(`SELECT 1 FROM messages WHERE id = ? LIMIT 1`);
    this.stHasSeenWrap = this.db.prepare(`SELECT 1 FROM seen_wraps WHERE wrap_id = ? LIMIT 1`);
    this.stInsertSeenWrap = this.db.prepare(
      `INSERT OR IGNORE INTO seen_wraps (wrap_id, received_at) VALUES (?, ?)`,
    );
    this.stMarkRead = this.db.prepare(`UPDATE messages SET read = 1 WHERE id = ?`);
    this.stMessagesByCounterparty = this.db.prepare(
      `SELECT id, counterparty, direction, kind, subject, body, tags_json,
              created_at, read, wrap_id
         FROM messages
        WHERE counterparty = ?
        ORDER BY created_at ASC`,
    );
    this.stCountUnreadByCounterparty = this.db.prepare(
      `SELECT COUNT(*) AS n FROM messages
        WHERE counterparty = ? AND direction = 'in' AND read = 0`,
    );
    // Thread summary filtered by bucket. The Inbox tab passes
    // 'inbox'; the Requests tab passes 'quarantine'. We always show
    // the LAST message (subject + preview) from the same bucket so
    // moving a thread to quarantine doesn't leak the inbox preview
    // (and vice versa).
    this.stThreadSummaryByStatus = this.db.prepare(
      `SELECT counterparty,
              (SELECT subject FROM messages m2
                WHERE m2.counterparty = m.counterparty AND m2.status = m.status
                ORDER BY m2.created_at DESC LIMIT 1) AS last_subject,
              (SELECT body    FROM messages m2
                WHERE m2.counterparty = m.counterparty AND m2.status = m.status
                ORDER BY m2.created_at DESC LIMIT 1) AS last_preview,
              MAX(created_at) AS last_created_at,
              SUM(CASE WHEN direction = 'in' AND read = 0 THEN 1 ELSE 0 END) AS unread,
              COUNT(*) AS total
         FROM messages m
        WHERE status = ?
        GROUP BY counterparty
        ORDER BY last_created_at DESC`,
    );
    // Back-compat alias for callers that haven't been updated yet.
    // Returns all buckets combined (legacy behaviour pre-PR-7).
    this.stThreadSummary = this.db.prepare(
      `SELECT counterparty,
              (SELECT subject FROM messages m2
                WHERE m2.counterparty = m.counterparty
                ORDER BY m2.created_at DESC LIMIT 1) AS last_subject,
              (SELECT body    FROM messages m2
                WHERE m2.counterparty = m.counterparty
                ORDER BY m2.created_at DESC LIMIT 1) AS last_preview,
              MAX(created_at) AS last_created_at,
              SUM(CASE WHEN direction = 'in' AND read = 0 THEN 1 ELSE 0 END) AS unread,
              COUNT(*) AS total
         FROM messages m
        GROUP BY counterparty
        ORDER BY last_created_at DESC`,
    );

    // PR 7: spam-protection statements.
    this.stUpdateStatusByCounter = this.db.prepare(
      `UPDATE messages SET status = ? WHERE counterparty = ?`,
    );
    this.stDeleteByCounterparty = this.db.prepare(
      `DELETE FROM messages WHERE counterparty = ?`,
    );
    this.stIsAllowlisted = this.db.prepare(
      `SELECT 1 FROM mail_allowlist WHERE pubkey = ? LIMIT 1`,
    );
    this.stIsBlocklisted = this.db.prepare(
      `SELECT 1 FROM mail_blocklist WHERE pubkey = ? LIMIT 1`,
    );
    this.stAddAllow = this.db.prepare(
      `INSERT OR IGNORE INTO mail_allowlist (pubkey, added_at) VALUES (?, ?)`,
    );
    this.stRemoveAllow = this.db.prepare(`DELETE FROM mail_allowlist WHERE pubkey = ?`);
    this.stAddBlock = this.db.prepare(
      `INSERT OR IGNORE INTO mail_blocklist (pubkey, added_at) VALUES (?, ?)`,
    );
    this.stRemoveBlock = this.db.prepare(`DELETE FROM mail_blocklist WHERE pubkey = ?`);
    this.stListAllow = this.db.prepare(`SELECT pubkey, added_at FROM mail_allowlist ORDER BY added_at DESC`);
    this.stListBlock = this.db.prepare(`SELECT pubkey, added_at FROM mail_blocklist ORDER BY added_at DESC`);
  }

  // ── Wrap dedup ──────────────────────────────────────────────────────────

  hasSeenWrap(wrapId: string): boolean {
    return !!this.stHasSeenWrap.get(wrapId);
  }

  markSeenWrap(wrapId: string): void {
    this.stInsertSeenWrap.run(wrapId, Date.now());
  }

  // ── Message insert ─────────────────────────────────────────────────────

  /**
   * Persist a decrypted rumor. Idempotent on rumor.id — re-inserting the
   * same id is a no-op so concurrent decrypts (or relay replays) don't
   * surface duplicate rows in the UI.
   *
   * `ownPubkey` is the station owner's hex pubkey; it drives direction
   * inference. counterparty is read from the rumor's first `p` tag
   * (recipient) for outgoing messages, and from the rumor's own pubkey
   * for incoming.
   *
   * `bucket` selects which list the message lands in — defaults to
   * 'inbox' (back-compat for callers that pre-date PR 7). The inbox
   * worker decides the bucket based on contacts + allowlist; outgoing
   * mail always goes to 'inbox'.
   */
  insertMessage(
    rumor:     Rumor,
    wrapId:    string,
    ownPubkey: string,
    bucket:    MessageBucket = 'inbox',
  ): StoredMessage | null {
    if (rumor.kind !== KIND_DM_RUMOR && rumor.kind !== KIND_FILE_RUMOR) {
      // Out of scope for the mail panel — silently drop. (NIP-17 also
      // allows kind 7 reactions on threads; we'll surface those in a
      // later patch as inline emoji on individual messages.)
      return null;
    }
    if (this.stHasMessage.get(rumor.id)) {
      return null;  // duplicate insert, e.g. self-wrap delivered twice
    }

    const own       = ownPubkey.toLowerCase();
    const direction: 'in' | 'out' = rumor.pubkey.toLowerCase() === own ? 'out' : 'in';

    // counterparty: for outgoing, the recipient (first p tag that isn't
    // us). For incoming, the rumor signer. NIP-17 specifies one primary
    // recipient + an optional set of `p` tags for group threads; for the
    // MVP we only support 1-to-1.
    let counterparty: string;
    if (direction === 'out') {
      const recipientTag = rumor.tags.find(
        t => t[0] === 'p' && typeof t[1] === 'string' && t[1].toLowerCase() !== own,
      );
      // Defensive: an "out" message with no other recipient means we
      // sent to ourselves. Group under the self pubkey so the row
      // doesn't get lost — the UI can dedupe a "Me → Me" thread.
      counterparty = recipientTag?.[1]?.toLowerCase() ?? own;
    } else {
      counterparty = rumor.pubkey.toLowerCase();
    }

    const subject = (rumor.tags.find(t => t[0] === 'subject')?.[1] ?? '').toString();
    const body    = typeof rumor.content === 'string' ? rumor.content : '';
    // Outgoing mail always lands in inbox — the user pressed Send, so
    // their own thread should never be marked as a Request even when
    // the recipient is a stranger.
    const finalBucket: MessageBucket = direction === 'out' ? 'inbox' : bucket;

    this.stInsertMessage.run(
      rumor.id, counterparty, direction, rumor.kind, subject, body,
      JSON.stringify(rumor.tags), rumor.created_at, wrapId, Date.now(), finalBucket,
    );

    return {
      id:           rumor.id,
      counterparty,
      direction,
      kind:         rumor.kind,
      subject,
      body,
      tags:         rumor.tags,
      created_at:   rumor.created_at,
      read:         false,
      wrap_id:      wrapId,
    };
  }

  // ── Read APIs ──────────────────────────────────────────────────────────

  threadSummaries(bucket?: MessageBucket): ThreadSummary[] {
    const rows = (bucket
      ? this.stThreadSummaryByStatus.all(bucket)
      : this.stThreadSummary.all()) as Array<{
      counterparty: string; last_subject: string | null; last_preview: string | null;
      last_created_at: number; unread: number | null; total: number;
    }>;
    return rows.map(r => ({
      counterparty:    r.counterparty,
      last_subject:    r.last_subject ?? '',
      last_preview:    (r.last_preview ?? '').slice(0, 240),
      last_created_at: r.last_created_at,
      unread:          Number(r.unread ?? 0),
      total:           Number(r.total),
    }));
  }

  // ── Spam protection: allowlist / blocklist / bucket moves ──────────────

  isAllowlisted(hex: string): boolean {
    return !!this.stIsAllowlisted.get(hex.toLowerCase());
  }
  isBlocklisted(hex: string): boolean {
    return !!this.stIsBlocklisted.get(hex.toLowerCase());
  }
  allowlist(): Array<{ pubkey: string; added_at: number }> {
    return this.stListAllow.all() as Array<{ pubkey: string; added_at: number }>;
  }
  blocklist(): Array<{ pubkey: string; added_at: number }> {
    return this.stListBlock.all() as Array<{ pubkey: string; added_at: number }>;
  }
  /**
   * Promote a counterparty's quarantined thread into the inbox AND add
   * the pubkey to the allowlist so future mail from them lands directly
   * in inbox. Idempotent; safe to call on an already-allowlisted
   * counterparty.
   */
  acceptCounterparty(hex: string): { allowed: boolean; movedRows: number } {
    const k = hex.toLowerCase();
    this.stAddAllow.run(k, Date.now());
    // Re-bucket existing quarantined rows.
    const result = this.stUpdateStatusByCounter.run('inbox', k);
    return { allowed: true, movedRows: result.changes };
  }
  /**
   * Add a pubkey to the blocklist + delete every message from them.
   * The inbox worker consults the blocklist on unwrap so future wraps
   * are dropped before they ever land in the store.
   */
  blockCounterparty(hex: string): { blocked: boolean; deletedRows: number } {
    const k = hex.toLowerCase();
    this.stAddBlock.run(k, Date.now());
    this.stRemoveAllow.run(k);  // can't be both allow + block
    const result = this.stDeleteByCounterparty.run(k);
    return { blocked: true, deletedRows: result.changes };
  }
  unblockCounterparty(hex: string): void {
    this.stRemoveBlock.run(hex.toLowerCase());
  }
  unallowCounterparty(hex: string): void {
    this.stRemoveAllow.run(hex.toLowerCase());
  }

  messagesForThread(counterparty: string): StoredMessage[] {
    const rows = this.stMessagesByCounterparty.all(counterparty.toLowerCase()) as Array<{
      id: string; counterparty: string; direction: 'in' | 'out'; kind: number;
      subject: string; body: string; tags_json: string; created_at: number;
      read: number; wrap_id: string;
    }>;
    return rows.map(r => ({
      id:           r.id,
      counterparty: r.counterparty,
      direction:    r.direction,
      kind:         r.kind,
      subject:      r.subject,
      body:         r.body,
      tags:         safeParseTags(r.tags_json),
      created_at:   r.created_at,
      read:         !!r.read,
      wrap_id:      r.wrap_id,
    }));
  }

  countUnreadFor(counterparty: string): number {
    const row = this.stCountUnreadByCounterparty.get(counterparty.toLowerCase()) as { n: number };
    return row?.n ?? 0;
  }

  markRead(ids: string[]): void {
    const txn = this.db.transaction((batch: string[]) => {
      for (const id of batch) this.stMarkRead.run(id);
    });
    txn(ids);
  }

  close(): void {
    try { this.db.close(); } catch {}
  }
}

function safeParseTags(json: string): string[][] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t: any) => Array.isArray(t)).map((t: any[]) => t.map(String));
  } catch {
    return [];
  }
}

// ── Singleton accessor ─────────────────────────────────────────────────────
// One MailStore per process — better-sqlite3 doesn't share connections
// across modules cheaply, and the dashboard never needs more than one.

let _store: MailStore | null = null;

export function getMailStore(): MailStore {
  if (!_store) _store = new MailStore();
  return _store;
}

// Test seam — lets tests inject a temp-dir store without touching the
// user's real mail database.
export function setMailStoreForTesting(store: MailStore | null): void {
  _store = store;
}
