// `nostr-station relay` CLI subcommands. Plain stdout/stderr, no Ink —
// these are I/O-heavy batch operations, not interactive flows. The
// dashboard's existing /api/relay/database/export route covers the GUI
// path; this module covers the CLI path (offline export, scripted
// imports) and the import direction which has no UI yet.

import fs    from 'node:fs';
import path  from 'node:path';
import readline from 'node:readline';
import { EventStore, DEFAULT_DB_PATH } from '../relay/store.js';
import { probePidFile } from '../lib/pid-file.js';
import type { NostrEvent } from '../relay/types.js';

// The relay's default LRU cap. Kept in sync with DEFAULT_MAX_EVENTS in
// store.ts — duplicated here only to compute the user-facing warning
// "this import will exceed the cap, earlier events will be evicted by
// later ones."
const RELAY_DEFAULT_MAX_EVENTS = 100_000;

interface RelayCommandOpts {
  action:  string;
  args:    string[];
}

export async function runRelayCommand(opts: RelayCommandOpts): Promise<number> {
  switch (opts.action) {
    case 'export': return doExport(opts.args);
    case 'import': return doImport(opts.args);
    default:
      printRelayHelp();
      return opts.action === 'help' ? 0 : 1;
  }
}

function printRelayHelp(): void {
  process.stdout.write(`
  nostr-station relay — relay event database operations

  USAGE
    nostr-station relay export <path>           Stream every event in the
                                                store as JSONL to <path>.
                                                One JSON object per line.

    nostr-station relay import <path>           Read JSONL from <path> and
                                                ingest each event through
                                                the normal relay write path
                                                (signature check, dedupe,
                                                replaceable handling).

    nostr-station relay import <path> --dry-run Count what would happen
                                                without writing.

    nostr-station relay import <path> --no-verify
                                                Skip signature verification.
                                                Use only for re-imports of
                                                exports from a trusted relay.

  NOTES
    - JSONL is the lingua franca for nak, Haven, strfry. Files exported
      here can be imported by any of them and vice versa.
    - The relay's default cap is ${RELAY_DEFAULT_MAX_EVENTS.toLocaleString()} events. Imports that would
      exceed the cap warn first; the live relay's LRU eviction kicks in
      mid-import and silently drops earlier events to make room.
    - Operates directly on ~/.nostr-station/data/relay.db. If the
      dashboard is running, the live relay continues to serve while the
      import runs (SQLite WAL keeps both processes happy).
`);
}

async function doExport(args: string[]): Promise<number> {
  const out = args[0];
  if (!out) {
    process.stderr.write('relay export: missing output path\n');
    process.stderr.write('usage: nostr-station relay export <path>\n');
    return 1;
  }

  // Refuse to clobber. The export route in web-server.ts auto-names
  // files into ~/nostr-exports; the CLI takes an explicit path, so the
  // user is in control of the name — declining to overwrite avoids a
  // silent data loss on an accidental re-run.
  if (fs.existsSync(out)) {
    process.stderr.write(`relay export: refusing to overwrite existing file: ${out}\n`);
    return 1;
  }

  const absOut = path.resolve(out);
  fs.mkdirSync(path.dirname(absOut), { recursive: true });

  const store = new EventStore({ dbPath: DEFAULT_DB_PATH });
  try {
    const total = store.count();
    process.stderr.write(`exporting ${total.toLocaleString()} events to ${absOut}\n`);
    const fd = fs.openSync(absOut, 'w');
    let written = 0;
    const reportEvery = 5_000;
    try {
      for (const ev of store.iterAll()) {
        fs.writeSync(fd, JSON.stringify(ev) + '\n');
        written++;
        if (written % reportEvery === 0) {
          process.stderr.write(`  ${written.toLocaleString()} / ${total.toLocaleString()}\n`);
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    process.stderr.write(`exported ${written.toLocaleString()} events\n`);
    return 0;
  } finally {
    store.close();
  }
}

async function doImport(args: string[]): Promise<number> {
  const file    = args.find(a => !a.startsWith('--'));
  const dryRun  = args.includes('--dry-run');
  const verify  = !args.includes('--no-verify');

  if (!file) {
    process.stderr.write('relay import: missing input path\n');
    process.stderr.write('usage: nostr-station relay import <path> [--dry-run] [--no-verify]\n');
    return 1;
  }

  if (!fs.existsSync(file)) {
    process.stderr.write(`relay import: file not found: ${file}\n`);
    return 1;
  }

  // LRU-eviction warning. We can read the file size cheaply (lines ≈
  // events for JSONL) and the current store count to estimate whether
  // the import will hit the cap mid-stream. Doesn't block — informs.
  const incomingEstimate = await countLines(file);
  const store = new EventStore({ dbPath: DEFAULT_DB_PATH });

  try {
    const currentCount = store.count();
    const cap = RELAY_DEFAULT_MAX_EVENTS;
    const projected = currentCount + incomingEstimate;
    if (projected > cap) {
      process.stderr.write(
        `warning: import (~${incomingEstimate.toLocaleString()} events) plus current store ` +
        `(${currentCount.toLocaleString()}) will exceed the ${cap.toLocaleString()} LRU cap.\n` +
        `         Earlier-imported events will be evicted as later ones are added.\n` +
        `         If preserving full history matters, raise the cap before importing.\n`,
      );
    }

    // Detect a running dashboard. The CLI import is safe alongside it
    // (WAL serializes the writes), but we tell the user so they aren't
    // surprised by events appearing in the live dashboard mid-run.
    const pid = probePidFile();
    if (pid.state === 'alive') {
      process.stderr.write(
        `note: dashboard is running (pid ${pid.pid}); imported events will appear in the live relay.\n`,
      );
    }

    if (dryRun) process.stderr.write('dry-run: no writes will be performed\n');
    process.stderr.write(`importing from ${file}${verify ? '' : ' (signature verification disabled)'}\n`);

    const events = readJsonl(file);
    const result = store.bulkAdd(events, {
      verify,
      dryRun,
      progressEvery: 1_000,
      onProgress: (c) => {
        process.stderr.write(
          `  stored=${c.stored.toLocaleString()} duplicate=${c.duplicate.toLocaleString()} ` +
          `invalid=${c.invalid.toLocaleString()} errors=${c.errors.toLocaleString()}\n`,
        );
      },
    });

    process.stderr.write('\n');
    process.stderr.write(`${dryRun ? 'would-import' : 'import'} complete:\n`);
    process.stderr.write(`  stored:    ${result.stored.toLocaleString()}\n`);
    process.stderr.write(`  duplicate: ${result.duplicate.toLocaleString()}\n`);
    process.stderr.write(`  invalid:   ${result.invalid.toLocaleString()}\n`);
    process.stderr.write(`  errors:    ${result.errors.toLocaleString()}\n`);

    // Surface up to 10 rejected events so the user knows what was wrong
    // without flooding their terminal on a fully-bad file.
    if (result.errorDetails.length > 0) {
      process.stderr.write('\nfirst rejections:\n');
      for (const e of result.errorDetails.slice(0, 10)) {
        process.stderr.write(`  ${e.id.slice(0, 16)}…  ${e.reason}\n`);
      }
      if (result.errorDetails.length > 10) {
        process.stderr.write(`  (… ${result.errorDetails.length - 10} more)\n`);
      }
    }

    // Non-zero exit on any rejections so scripts can detect a partial
    // import. The plan's acceptance criterion: "Importing a JSONL with
    // 10 invalid signatures into a 100-event valid set results in 100
    // events added, 10 reported as rejected, exit code non-zero."
    return (result.invalid + result.errors) > 0 ? 2 : 0;
  } finally {
    store.close();
  }
}

// Cheap line counter that handles large files without loading them.
// Streams in 64 KB chunks counting LF bytes — close enough for the
// "should we warn about the LRU cap" decision.
function countLines(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let count = 0;
    const stream = fs.createReadStream(file, { highWaterMark: 64 * 1024 });
    stream.on('data', (buf: Buffer | string) => {
      const b = typeof buf === 'string' ? Buffer.from(buf) : buf;
      for (let i = 0; i < b.length; i++) if (b[i] === 0x0a) count++;
    });
    stream.on('end',   () => resolve(count));
    stream.on('error', reject);
  });
}

// JSONL → NostrEvent generator. Blank lines are tolerated (some
// exporters append a trailing newline that creates an empty final
// line); malformed lines surface as a thrown error so the caller can
// abort rather than silently skip. The bulkAdd path is line-oriented
// streaming — we never hold the whole file in memory.
function* readJsonl(file: string): Generator<NostrEvent> {
  const text  = fs.readFileSync(file, 'utf-8');
  const lines = text.split('\n');
  let lineNo  = 0;
  for (const line of lines) {
    lineNo++;
    const t = line.trim();
    if (!t) continue;
    let parsed: any;
    try { parsed = JSON.parse(t); }
    catch (e: any) {
      throw new Error(`relay import: malformed JSON at line ${lineNo}: ${e.message}`);
    }
    yield parsed as NostrEvent;
  }
}
