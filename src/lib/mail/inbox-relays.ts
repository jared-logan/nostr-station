/**
 * Inbox relay (NIP-17 kind 10050) configuration.
 *
 * The user's "Where can people deliver mail to me?" list. Stored locally
 * in identity-mail.json (separate from identity.json's general read-relay
 * list so changing one doesn't accidentally clobber the other), and
 * mirrored to the network as a kind 10050 event so other NIP-17 clients
 * know where to send wraps for this pubkey.
 *
 * Defaults to a small curated set of public NIP-17 relays — these are
 * the relays the broader NIP-17 ecosystem already uses, so a fresh
 * nostr-station user can receive mail from any compliant client without
 * configuring anything.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Curated public defaults. Ordered most-reliable-first; the inbox worker
// will subscribe to all of them in parallel. Sources: NIP-17-aware
// clients (0xchat, Coracle, NostrMail) advertise these as their default
// inbox relay list.
export const DEFAULT_INBOX_RELAYS: string[] = [
  'wss://inbox.nostr.wine',
  'wss://relay.0xchat.com',
  'wss://auth.nostr1.com',
];

// Persistence lives in its own file rather than embedding in identity.json
// — the inbox list is conceptually a mail-only setting and the existing
// identity module already does enough work. One-file-one-feature keeps
// migrations local.
function configPath(): string {
  return path.join(os.homedir(), '.config', 'nostr-station', 'mail-inbox-relays.json');
}

export function readInboxRelays(): string[] {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.relays)) {
      const safe = parsed.relays
        .filter((s: any): s is string => typeof s === 'string' && /^wss?:\/\//.test(s));
      if (safe.length > 0) return safe.slice(0, 12);
    }
  } catch { /* fall through */ }
  return DEFAULT_INBOX_RELAYS.slice();
}

export function writeInboxRelays(relays: string[]): string[] {
  const safe = relays
    .filter(s => typeof s === 'string' && /^wss?:\/\//.test(s))
    .slice(0, 12);
  fs.mkdirSync(path.dirname(configPath()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath(), JSON.stringify({ relays: safe }, null, 2), { mode: 0o600 });
  return safe;
}
