import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useTempHome } from './_home.js';

// Cache helpers below resolve `~/.config/nostr-station/projects/<id>/`
// — pin HOME to a tmpdir so the round-trip tests don't pollute the
// real user-config dir.
useTempHome();

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

// Cache is keyed by projectId now. Tests use unique ids so they don't
// collide with each other under HOME/.config/nostr-station/projects/.
function makeProjectId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

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

function cacheFileFor(projectId: string, key: string): string {
  return path.join(os.homedir(), '.config', 'nostr-station', 'projects', projectId, 'cache', `${key}.json`);
}

test('cache: setCached / getCached round-trip', () => {
  const id = makeProjectId('rt');
  setCached({ projectId: id, key: 'patches' }, { count: 3, items: ['a', 'b', 'c'] });
  const v = getCached<{ count: number; items: string[] }>({
    projectId: id, key: 'patches',
  });
  assert.deepEqual(v, { count: 3, items: ['a', 'b', 'c'] });
});

test('cache: returns null when entry is missing', () => {
  assert.equal(getCached({ projectId: makeProjectId('miss'), key: 'never-set' }), null);
});

test('cache: returns null when entry is expired', () => {
  const id = makeProjectId('exp');
  setCached({ projectId: id, key: 'stale' }, 'value');
  // Hand-edit cachedAt to simulate a 2-hour-old entry, then ask with
  // a 1-hour TTL.
  const file = cacheFileFor(id, 'stale');
  const env  = JSON.parse(fs.readFileSync(file, 'utf8'));
  env.cachedAt = Date.now() - 2 * 60 * 60 * 1000;
  fs.writeFileSync(file, JSON.stringify(env));
  assert.equal(
    getCached({ projectId: id, key: 'stale', ttlMs: 60 * 60 * 1000 }),
    null,
  );
});

test('cache: returns null when entry is corrupt', () => {
  const id = makeProjectId('corrupt');
  setCached({ projectId: id, key: 'broken' }, 'value');
  fs.writeFileSync(cacheFileFor(id, 'broken'), '{not json');
  assert.equal(getCached({ projectId: id, key: 'broken' }), null);
});

test('cache: clearCache deletes the entry', () => {
  const id = makeProjectId('clear');
  setCached({ projectId: id, key: 'gone' }, 'value');
  clearCache({ projectId: id, key: 'gone' });
  assert.equal(getCached({ projectId: id, key: 'gone' }), null);
  // Idempotent — a second clear on a missing entry is a no-op.
  clearCache({ projectId: id, key: 'gone' });
});

test('cache: writes to user-config dir, never to the project tree', () => {
  const id = makeProjectId('isolation');
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-isolation-'));
  // Pass projectPath as a migration hint — the cache must STILL land
  // in the user-config dir, not in projectDir/.nostr-station/cache/.
  setCached({ projectId: id, projectPath: projectDir, key: 'isolated' }, 'v');
  assert.equal(
    fs.existsSync(path.join(projectDir, '.nostr-station', 'cache')),
    false,
    'cache must not be written under the project tree',
  );
  assert.ok(fs.existsSync(cacheFileFor(id, 'isolated')));
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test('cache: migrates legacy <project>/.nostr-station/cache/ on first access', () => {
  const id = makeProjectId('migrate');
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-migrate-'));
  const legacyDir = path.join(projectDir, '.nostr-station', 'cache');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyDir, 'legacy.json'),
    JSON.stringify({ cachedAt: Date.now(), value: { legacy: true } }),
  );
  const v = getCached<{ legacy: boolean }>({
    projectId: id, projectPath: projectDir, key: 'legacy',
  });
  assert.deepEqual(v, { legacy: true });
  // Untracked legacy dir (no git repo here) gets auto-removed.
  assert.equal(fs.existsSync(legacyDir), false);
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test('cache: rejects unsafe keys (path traversal, special chars)', () => {
  const id = makeProjectId('safe');
  for (const bad of ['../escape', 'has/slash', 'has\\back', 'has space', '', 'a'.repeat(65)]) {
    assert.throws(
      () => setCached({ projectId: id, key: bad }, 'x'),
      /unsafe cache key/,
      `should reject ${JSON.stringify(bad)}`,
    );
  }
});

test('getCachedOrFetch: skips fetcher on cache hit, calls on miss', async () => {
  const id = makeProjectId('gof');
  let fetchCount = 0;
  const fetcher = async () => { fetchCount++; return { hello: 'world' }; };

  // First call → miss, fetcher runs.
  const a = await getCachedOrFetch({ projectId: id, key: 'gof' }, fetcher);
  assert.deepEqual(a, { hello: 'world' });
  assert.equal(fetchCount, 1);

  // Second call → hit, fetcher not invoked again.
  const b = await getCachedOrFetch({ projectId: id, key: 'gof' }, fetcher);
  assert.deepEqual(b, { hello: 'world' });
  assert.equal(fetchCount, 1);
});

test('getCachedOrFetch: fetcher rejection propagates and skips cache write', async () => {
  const id = makeProjectId('rej');
  await assert.rejects(
    () => getCachedOrFetch(
      { projectId: id, key: 'fail' },
      async () => { throw new Error('nope'); },
    ),
    /nope/,
  );
  // Nothing should have been persisted.
  assert.equal(getCached({ projectId: id, key: 'fail' }), null);
});
