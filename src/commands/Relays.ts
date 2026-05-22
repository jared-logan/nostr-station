// `nostr-station relays` CLI — edits, pulls, and publishes the
// operator's NIP-65 (kind:10002) relay list. Plain stdout/stderr; no
// Ink. Pull and publish print a preview and require explicit confirm
// before they touch identity.json or the network. The plan's "manual-
// only" and "explicit confirm in-station before any signing" rules are
// enforced here.

import readline from 'node:readline';
import {
  listRelays, addRelayLocal, removeRelayLocal, mergeRelayLists,
  pullNip65, applyNip65Pull, buildNip65Template, publishNip65,
  BOOTSTRAP_RELAYS,
} from '../lib/relays.js';
import { readIdentity } from '../lib/identity.js';
import type { RelayMode, RelayEntry } from '../lib/relays.js';

interface RelaysCommandOpts {
  action: string;
  args:   string[];
}

export async function runRelaysCommand(opts: RelaysCommandOpts): Promise<number> {
  switch (opts.action) {
    case 'list':    return doList();
    case 'add':     return doAdd(opts.args);
    case 'remove':  return doRemove(opts.args);
    case 'pull':    return doPull(opts.args);
    case 'publish': return doPublish(opts.args);
    default:
      printRelaysHelp();
      return opts.action === 'help' ? 0 : 1;
  }
}

function printRelaysHelp(): void {
  process.stdout.write(`
  nostr-station relays — manage your published NIP-65 (kind:10002) relay list

  USAGE
    nostr-station relays list                       Show the current local lists.

    nostr-station relays add <wss://url>            Add a relay marked as both
                                                    read and write (NIP-65 default).
    nostr-station relays add <wss://url> --read     Mark read-only (inbox).
    nostr-station relays add <wss://url> --write    Mark write-only (outbox).

    nostr-station relays remove <wss://url>         Remove from both read + write lists.

    nostr-station relays pull                       Fetch the operator's published
                                                    kind:10002, show a diff, and
                                                    apply it on confirm. Refuses
                                                    to modify identity.json on a
                                                    network failure or empty result.
    nostr-station relays pull --yes                 Skip the confirm prompt.

    nostr-station relays publish                    Build a kind:10002 from the
                                                    current local lists, show
                                                    the event, sign via the
                                                    saved bunker on confirm, and
                                                    broadcast. Reports per-relay
                                                    OK / FAILED / TIMEOUT.
    nostr-station relays publish --yes              Skip the confirm prompt
                                                    (the bunker prompt on
                                                    Amber still applies).

  NOTES
    - Local edits NEVER auto-publish. Use \`relays publish\` to push.
    - Pulls NEVER auto-run. There is no on-start or periodic sync.
    - All commands operate on ~/.config/nostr-station/identity.json.
`);
}

// ── list ──────────────────────────────────────────────────────────────────

function doList(): number {
  const entries = listRelays();
  if (entries.length === 0) {
    process.stdout.write('(no relays configured)\n');
    return 0;
  }
  // Two-column display: mode column, then url. read = "R", write = "W",
  // both = "RW". Padding tuned for the longest mode label.
  for (const e of entries) {
    const mark = e.mode === 'both' ? 'RW' : e.mode === 'read' ? 'R ' : ' W';
    process.stdout.write(`  ${mark}  ${e.url}\n`);
  }
  return 0;
}

// ── add ───────────────────────────────────────────────────────────────────

function doAdd(args: string[]): number {
  const url   = args.find(a => !a.startsWith('--'));
  const read  = args.includes('--read');
  const write = args.includes('--write');

  if (!url) {
    process.stderr.write('relays add: missing url\n');
    process.stderr.write('usage: nostr-station relays add <wss://url> [--read] [--write]\n');
    return 1;
  }

  // No flags → both. Both flags → both. Single flag → that side only.
  let mode: RelayMode;
  if (read && write)       mode = 'both';
  else if (read)           mode = 'read';
  else if (write)          mode = 'write';
  else                     mode = 'both';

  const result = addRelayLocal(url, mode);
  if (!result.ok) {
    process.stderr.write(`relays add: ${result.error}\n`);
    return 1;
  }
  process.stdout.write(`added ${url} (${labelMode(mode)})\n`);
  return 0;
}

// ── remove ────────────────────────────────────────────────────────────────

function doRemove(args: string[]): number {
  const url = args.find(a => !a.startsWith('--'));
  if (!url) {
    process.stderr.write('relays remove: missing url\n');
    process.stderr.write('usage: nostr-station relays remove <wss://url>\n');
    return 1;
  }
  const result = removeRelayLocal(url);
  if (!result.removed) {
    process.stderr.write(`relays remove: not in the list: ${url}\n`);
    return 1;
  }
  process.stdout.write(`removed ${url}\n`);
  return 0;
}

// ── pull ──────────────────────────────────────────────────────────────────

async function doPull(args: string[]): Promise<number> {
  const yes = args.includes('--yes');
  const ident = readIdentity();
  if (!ident.npub) {
    process.stderr.write('relays pull: no npub configured; run setup first\n');
    return 1;
  }

  // Use the user's current readRelays if non-empty, otherwise bootstrap.
  // Falls back to the bootstrap set on a brand-new install. Matches
  // the plan's spec: "Bootstrap relays — use a small hardcoded fallback
  // list … for the pull if the current relay list is empty."
  const queryRelays = (ident.readRelays && ident.readRelays.length > 0)
                        ? ident.readRelays
                        : BOOTSTRAP_RELAYS;

  process.stderr.write(`fetching kind:10002 for ${shortNpub(ident.npub)} from ${queryRelays.length} relay${queryRelays.length === 1 ? '' : 's'}…\n`);
  const result = await pullNip65({ npub: ident.npub, relays: queryRelays });

  process.stderr.write('\nper-relay results:\n');
  for (const r of result.relayResults) {
    process.stderr.write(`  ${r.ok ? 'OK     ' : 'FAILED '}  ${r.relay}${r.reason ? `  (${r.reason})` : ''}\n`);
  }
  process.stderr.write('\n');

  if (!result.ok || !result.parsed || !result.diff) {
    process.stderr.write(`relays pull: ${result.error || 'fetch failed'}\n`);
    process.stderr.write('(identity.json unchanged)\n');
    return 2;
  }

  // Show the diff. The acceptance criterion is "diff preview before
  // commit", so this output IS the preview — terse but complete.
  const { diff } = result;
  process.stderr.write(`found kind:10002 (id ${result.parsed.eventId.slice(0, 16)}…, created_at ${result.parsed.createdAt})\n\n`);
  printDiff(diff);

  const totalChanges = diff.added.length + diff.removed.length + diff.changed.length;
  if (totalChanges === 0) {
    process.stderr.write('local list already matches the published kind:10002 — nothing to apply.\n');
    return 0;
  }

  if (!yes) {
    const ok = await confirm(`apply these changes to identity.json? [y/N] `);
    if (!ok) {
      process.stderr.write('cancelled (identity.json unchanged)\n');
      return 0;
    }
  }

  applyNip65Pull(result.parsed);
  process.stderr.write(`applied. identity.json now has ${result.parsed.readRelays.length} read relay${result.parsed.readRelays.length === 1 ? '' : 's'} and ${result.parsed.writeRelays.length} write relay${result.parsed.writeRelays.length === 1 ? '' : 's'}.\n`);
  return 0;
}

// ── publish ───────────────────────────────────────────────────────────────

async function doPublish(args: string[]): Promise<number> {
  const yes = args.includes('--yes');

  const ident = readIdentity();
  if (!ident.npub) {
    process.stderr.write('relays publish: no npub configured; run setup first\n');
    return 1;
  }

  const entries = listRelays();
  if (entries.length === 0) {
    process.stderr.write('relays publish: no relays configured. Add some with `relays add` first.\n');
    return 1;
  }

  // Show the exact event template. Acceptance criterion: "Show the
  // full event template (kind, tags, content, created_at, would-be
  // relay set) and require the operator to type / click confirm.
  // Amber's own prompt is a second layer, not the first."
  const template = buildNip65Template();
  process.stderr.write('event to publish:\n');
  process.stderr.write(`  kind:       ${template.kind}\n`);
  process.stderr.write(`  created_at: ${template.created_at}\n`);
  process.stderr.write(`  content:    ${JSON.stringify(template.content)}\n`);
  process.stderr.write(`  tags:       (${template.tags.length})\n`);
  for (const t of template.tags) {
    process.stderr.write(`    ${JSON.stringify(t)}\n`);
  }
  const broadcast = Array.from(new Set(entries.map(e => e.url)));
  process.stderr.write(`\nbroadcast targets: ${broadcast.length}\n`);
  for (const url of broadcast) process.stderr.write(`  ${url}\n`);
  process.stderr.write('\n');

  if (!yes) {
    const ok = await confirm(`sign via bunker and broadcast? [y/N] `);
    if (!ok) {
      process.stderr.write('cancelled (no events sent)\n');
      return 0;
    }
  }

  process.stderr.write('signing via saved bunker…\n');
  const result = await publishNip65();
  if (!result.ok && !result.signedEvent) {
    process.stderr.write(`relays publish: ${result.error || 'signing failed'}\n`);
    return 2;
  }

  process.stderr.write('\nper-relay results:\n');
  let okCount = 0;
  let failCount = 0;
  for (const r of result.relayResults) {
    if (r.ok) okCount++; else failCount++;
    process.stderr.write(`  ${r.ok ? 'OK     ' : 'FAILED '}  ${r.relay}${r.reason ? `  (${r.reason})` : ''}\n`);
  }
  process.stderr.write(`\n${okCount} of ${result.relayResults.length} relays accepted the event.\n`);
  if (result.signedEvent) {
    process.stderr.write(`event id: ${result.signedEvent.id}\n`);
  }

  // Partial-success exit code: any failure → 2, full success → 0. Same
  // convention as `relay import` from Item 1, so a script can tell.
  return failCount > 0 ? 2 : 0;
}

// ── helpers ───────────────────────────────────────────────────────────────

function labelMode(mode: RelayMode): string {
  return mode === 'both' ? 'read+write' : mode === 'read' ? 'read' : 'write';
}

function shortNpub(npub: string): string {
  if (npub.startsWith('npub1')) return npub.slice(0, 12) + '…' + npub.slice(-4);
  return npub.slice(0, 8) + '…' + npub.slice(-4);
}

function printDiff(diff: { added: RelayEntry[]; removed: RelayEntry[]; changed: Array<{ url: string; from: RelayMode; to: RelayMode }>; unchanged: number }): void {
  const lines: string[] = [];
  for (const a of diff.added)   lines.push(`  + ${labelMode(a.mode).padEnd(10)}  ${a.url}`);
  for (const r of diff.removed) lines.push(`  - ${labelMode(r.mode).padEnd(10)}  ${r.url}`);
  for (const c of diff.changed) lines.push(`  ~ ${labelMode(c.from)} → ${labelMode(c.to).padEnd(10)}  ${c.url}`);
  if (lines.length === 0) {
    process.stderr.write('(no changes)\n');
    return;
  }
  process.stderr.write('changes:\n');
  for (const l of lines) process.stderr.write(l + '\n');
  if (diff.unchanged > 0) process.stderr.write(`  (${diff.unchanged} unchanged)\n`);
}

function confirm(prompt: string): Promise<boolean> {
  return new Promise(resolve => {
    if (!process.stdin.isTTY) {
      // Non-interactive: refuse rather than auto-yes. Acceptance
      // criterion: "Declining the confirmation prompt leaves
      // identity.json unchanged." A no-TTY context (CI, pipe) reads
      // as declining.
      process.stderr.write('relays: no TTY for confirm; pass --yes to skip the prompt\n');
      resolve(false);
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
