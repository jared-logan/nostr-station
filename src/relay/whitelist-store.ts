import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Persisted set of pubkeys (hex) allowed to publish events to the
// in-process relay. The station owner is implicitly allowed and is NOT
// stored here — the gating layer in src/relay/index.ts:handleEvent
// reads identity.json for that, so rotating the owner key doesn't
// require a whitelist edit.
//
// On-disk shape: a single JSON file, intentionally human-editable:
//
//   { "pubkeys": ["64-hex...", ...], "updatedAt": 1730000000000 }
//
// Atomic write via temp + rename so a partial write can't leave the
// store in a half-flushed state. Lives next to relay.db so a clean
// `rm -rf ~/.nostr-station/data` resets relay state in one shot.

interface Schema {
  pubkeys:   string[];
  updatedAt: number;
}

const DEFAULT_PATH = path.join(os.homedir(), '.nostr-station', 'data', 'whitelist.json');

export class WhitelistStore {
  private filePath: string;
  private set:      Set<string>;

  constructor(filePath: string = DEFAULT_PATH) {
    this.filePath = filePath;
    this.set      = new Set();
    this.load();
  }

  // List as a sorted hex array. Sorted output keeps Config-panel renders
  // stable across reloads — the UI currently dedupes by string, not by
  // npub canonicalization, so a deterministic order avoids visual jitter.
  list(): string[] {
    return [...this.set].sort();
  }

  has(hexPubkey: string): boolean {
    return this.set.has(hexPubkey.toLowerCase());
  }

  // Add returns true if the entry was new. Caller can use this to surface
  // "already present" without throwing — which matches the original
  // /api/relay/whitelist/add response shape ({ ok, hex, already? }).
  add(hexPubkey: string): boolean {
    const k = hexPubkey.toLowerCase();
    if (this.set.has(k)) return false;
    this.set.add(k);
    this.save();
    return true;
  }

  // Remove returns true if the entry was present. Mirrors add().
  remove(hexPubkey: string): boolean {
    const k = hexPubkey.toLowerCase();
    if (!this.set.has(k)) return false;
    this.set.delete(k);
    this.save();
    return true;
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Schema>;
      if (Array.isArray(parsed.pubkeys)) {
        for (const p of parsed.pubkeys) {
          if (typeof p === 'string' && /^[0-9a-f]{64}$/i.test(p)) {
            this.set.add(p.toLowerCase());
          }
        }
      }
    } catch { /* missing file or bad JSON — start empty */ }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const data: Schema = { pubkeys: this.list(), updatedAt: Date.now() };
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }
}
