import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  buildNakArgs,
  parseEventLine,
  getTag,
  getTagValue,
  getTags,
  getCached,
  setCached,
  clearCache,
  getCachedOrFetch,
  queryRelays,
} = await import('../src/lib/nostr-query.ts');

// ── buildNakArgs ──────────────────────────────────────────────────────────

test('buildNakArgs: empty filter + no relays + stream=true', () => {
  // The minimum invocation. `--stream` is appended even when relays
  // are empty so callers see exactly what would have been spawned.
  assert.deepEqual(
    buildNakArgs({}, [], true),
    ['req', '--stream'],
  );
});

test('buildNakArgs: kinds + authors + relays in stable order', () => {
  // Order asserted: kinds → authors → tags → limit → --stream → relays.
  // Same shape as the existing /api/ngit/discover invocation in
  // routes/ngit.ts so the eventual refactor is mechanical.
  assert.deepEqual(
    buildNakArgs(
      { kinds: [30617], authors: ['abc123'] },
      ['wss://relay.one', 'wss://relay.two'],
      true,
    ),
    ['req', '-k', '30617', '-a', 'abc123', '--stream', 'wss://relay.one', 'wss://relay.two'],
  );
});

test('buildNakArgs: tag filters expand into one -t per value, sorted by name', () => {
  // Multi-value tag filters (`{t: ['root','root-revision']}`) become
  // repeated `-t` flags, which is the actual nak grammar. Tag NAMES
  // are sorted so test asserts on argv stay deterministic when callers
  // build the filter object in different orders.
  assert.deepEqual(
    buildNakArgs(
      { tags: { t: ['root', 'root-revision'], a: '30617:pk:repo' } },
      ['wss://r'],
      false,
    ),
    ['req', '-t', 'a=30617:pk:repo', '-t', 't=root', '-t', 't=root-revision', 'wss://r'],
  );
});

test('buildNakArgs: limit is appended as -l <n> and floored', () => {
  assert.deepEqual(
    buildNakArgs({ kinds: [1617], limit: 10.7 }, ['wss://r'], false),
    ['req', '-k', '1617', '-l', '10', 'wss://r'],
  );
});

test('buildNakArgs: ids expand into one -i per value, after authors', () => {
  // nak grammar: `-i <id>` repeats per id. Order asserted: kinds →
  // authors → ids → tags → relays. Used by the status route's
  // rootAuthor resolution path (one query, many root ids).
  assert.deepEqual(
    buildNakArgs(
      { kinds: [1617, 1621], ids: ['a'.repeat(64), 'b'.repeat(64)] },
      ['wss://r'],
      false,
    ),
    ['req', '-k', '1617', '-k', '1621', '-i', 'a'.repeat(64), '-i', 'b'.repeat(64), 'wss://r'],
  );
});

test('buildNakArgs: stream=false omits --stream', () => {
  // One-shot query mirroring the naddr-resolution flow in
  // routes/ngit.ts:471 (single 30617 lookup with -l 1).
  assert.deepEqual(
    buildNakArgs(
      { kinds: [30617], authors: ['abc'], tags: { d: 'torchlite' }, limit: 1 },
      ['wss://r'],
      false,
    ),
    ['req', '-k', '30617', '-a', 'abc', '-t', 'd=torchlite', '-l', '1', 'wss://r'],
  );
});

// ── parseEventLine ────────────────────────────────────────────────────────

const VALID = JSON.stringify({
  id:         'a'.repeat(64),
  pubkey:     'b'.repeat(64),
  created_at: 1_700_000_000,
  kind:       30617,
  tags:       [['d', 'torchlite'], ['name', 'Torchlite'], ['clone', 'https://example.com/x.git']],
  content:    '',
  sig:        'c'.repeat(128),
});

test('parseEventLine: valid event round-trips to typed shape', () => {
  const ev = parseEventLine(VALID);
  assert.ok(ev);
  assert.equal(ev!.id,         'a'.repeat(64));
  assert.equal(ev!.kind,       30617);
  assert.equal(ev!.created_at, 1_700_000_000);
  assert.deepEqual(ev!.tags[0], ['d', 'torchlite']);
});

test('parseEventLine: trims surrounding whitespace', () => {
  // nak occasionally emits trailing whitespace before \n on slow links.
  const ev = parseEventLine(`   ${VALID}   \r`);
  assert.ok(ev);
});

test('parseEventLine: empty / whitespace-only line returns null', () => {
  assert.equal(parseEventLine(''),     null);
  assert.equal(parseEventLine('   '),  null);
  assert.equal(parseEventLine('\t\n'), null);
});

test('parseEventLine: malformed JSON returns null (no throw)', () => {
  // Failure mode is silent-null, not throw — caller increments
  // `parseFailures` rather than aborting the whole stream.
  assert.equal(parseEventLine('{not json'),                null);
  assert.equal(parseEventLine('not even an object'),       null);
  assert.equal(parseEventLine('"a string"'),               null);
  assert.equal(parseEventLine('null'),                     null);
});

test('parseEventLine: missing required field returns null', () => {
  // Each required field exercised individually so a future schema
  // tweak (e.g. allowing optional `sig`) gets deliberate test churn.
  for (const field of ['id', 'pubkey', 'kind', 'created_at', 'tags', 'content', 'sig']) {
    const obj: any = JSON.parse(VALID);
    delete obj[field];
    assert.equal(parseEventLine(JSON.stringify(obj)), null, `should reject missing ${field}`);
  }
});

test('parseEventLine: wrong-typed required field returns null', () => {
  const obj: any = JSON.parse(VALID);
  obj.kind = '30617';                  // string instead of number
  assert.equal(parseEventLine(JSON.stringify(obj)), null);
  obj.kind = 30617;
  obj.tags = 'not an array';
  assert.equal(parseEventLine(JSON.stringify(obj)), null);
});

// ── tag accessors ────────────────────────────────────────────────────────

test('getTag / getTagValue / getTags', () => {
  const ev = parseEventLine(VALID)!;
  assert.deepEqual(getTag(ev, 'd'),       ['d', 'torchlite']);
  assert.equal   (getTagValue(ev, 'd'),   'torchlite');
  assert.equal   (getTagValue(ev, 'name'), 'Torchlite');
  assert.equal   (getTag(ev, 'missing'),   null);
  assert.equal   (getTagValue(ev, 'missing'), null);
  assert.equal   (getTags(ev, 'clone').length, 1);
  assert.equal   (getTags(ev, 'missing').length, 0);
});

test('getTags: returns all matching tags in order', () => {
  // NIP-34 30617 events repeat the `clone` tag for each transport
  // URL, so getTags must surface every match — not just the first.
  const obj: any = JSON.parse(VALID);
  obj.tags = [
    ['clone', 'https://a.example/x.git'],
    ['d', 'torchlite'],
    ['clone', 'https://b.example/x.git'],
    ['clone', 'ssh://c.example/x.git'],
  ];
  const ev = parseEventLine(JSON.stringify(obj))!;
  const clones = getTags(ev, 'clone').map((t) => t[1]);
  assert.deepEqual(clones, [
    'https://a.example/x.git',
    'https://b.example/x.git',
    'ssh://c.example/x.git',
  ]);
});

// ── queryRelays: branchless paths (no nak invocation) ─────────────────────

test('queryRelays: returns empty + spawnError when nak missing', async () => {
  // Pass nakBin=null explicitly to simulate "nak not on PATH" without
  // depending on the test runner's environment.
  const r = await queryRelays({
    filter: { kinds: [1] },
    relays: ['wss://r'],
    nakBin: null,
  });
  assert.deepEqual(r.events, []);
  assert.equal(r.diagnostics.spawnError, 'nak not found on PATH');
  assert.equal(r.diagnostics.exitCode, null);
});

test('queryRelays: returns empty (no spawn) when relays list is empty', async () => {
  // With zero relays we short-circuit rather than spawning nak with no
  // targets (which would block until the timeout).
  const r = await queryRelays({
    filter: { kinds: [1] },
    relays: [],
    // Set a real-looking path so the nakBin guard doesn't trigger first.
    nakBin: '/usr/bin/nak',
  });
  assert.deepEqual(r.events, []);
  assert.equal(r.diagnostics.spawnError, null);
  assert.deepEqual(r.diagnostics.nakArgs, ['req', '-k', '1', '--stream']);
});

// ── Cache helpers ────────────────────────────────────────────────────────

function makeProjectDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nostr-station-cache-'));
}

test('cache: setCached / getCached round-trip', () => {
  const dir = makeProjectDir();
  setCached({ projectPath: dir, key: 'patches' }, { count: 3, items: ['a', 'b', 'c'] });
  const v = getCached<{ count: number; items: string[] }>({
    projectPath: dir, key: 'patches',
  });
  assert.deepEqual(v, { count: 3, items: ['a', 'b', 'c'] });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cache: returns null when entry is missing', () => {
  const dir = makeProjectDir();
  assert.equal(getCached({ projectPath: dir, key: 'never-set' }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cache: returns null when entry is expired', () => {
  const dir = makeProjectDir();
  setCached({ projectPath: dir, key: 'stale' }, 'value');
  // Hand-edit cachedAt to simulate a 2-hour-old entry, then ask with
  // a 1-hour TTL. (The default TTL would also expire it, but pinning
  // ttlMs makes the intent obvious.)
  const file = path.join(dir, '.nostr-station', 'cache', 'stale.json');
  const env  = JSON.parse(fs.readFileSync(file, 'utf8'));
  env.cachedAt = Date.now() - 2 * 60 * 60 * 1000;
  fs.writeFileSync(file, JSON.stringify(env));
  assert.equal(
    getCached({ projectPath: dir, key: 'stale', ttlMs: 60 * 60 * 1000 }),
    null,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cache: returns null when entry is corrupt', () => {
  const dir = makeProjectDir();
  setCached({ projectPath: dir, key: 'broken' }, 'value');
  const file = path.join(dir, '.nostr-station', 'cache', 'broken.json');
  fs.writeFileSync(file, '{not json');
  assert.equal(getCached({ projectPath: dir, key: 'broken' }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cache: clearCache deletes the entry', () => {
  const dir = makeProjectDir();
  setCached({ projectPath: dir, key: 'gone' }, 'value');
  clearCache({ projectPath: dir, key: 'gone' });
  assert.equal(getCached({ projectPath: dir, key: 'gone' }), null);
  // Idempotent — a second clear on a missing entry is a no-op.
  clearCache({ projectPath: dir, key: 'gone' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cache: rejects unsafe keys (path traversal, special chars)', () => {
  const dir = makeProjectDir();
  for (const bad of ['../escape', 'has/slash', 'has\\back', 'has space', '', 'a'.repeat(65)]) {
    assert.throws(
      () => setCached({ projectPath: dir, key: bad }, 'x'),
      /unsafe cache key/,
      `should reject ${JSON.stringify(bad)}`,
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('getCachedOrFetch: skips fetcher on cache hit, calls on miss', async () => {
  const dir = makeProjectDir();
  let fetchCount = 0;
  const fetcher = async () => { fetchCount++; return { hello: 'world' }; };

  // First call → miss, fetcher runs.
  const a = await getCachedOrFetch({ projectPath: dir, key: 'gof' }, fetcher);
  assert.deepEqual(a, { hello: 'world' });
  assert.equal(fetchCount, 1);

  // Second call → hit, fetcher not invoked again.
  const b = await getCachedOrFetch({ projectPath: dir, key: 'gof' }, fetcher);
  assert.deepEqual(b, { hello: 'world' });
  assert.equal(fetchCount, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('getCachedOrFetch: fetcher rejection propagates and skips cache write', async () => {
  const dir = makeProjectDir();
  await assert.rejects(
    () => getCachedOrFetch(
      { projectPath: dir, key: 'fail' },
      async () => { throw new Error('nope'); },
    ),
    /nope/,
  );
  // Nothing should have been persisted.
  assert.equal(getCached({ projectPath: dir, key: 'fail' }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
