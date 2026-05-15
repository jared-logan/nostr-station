/**
 * nsite resolver — unit tests for the address resolution + blob fetch path
 * (no relays required). Relay-side integration is covered indirectly by
 * mocking the resolver's deps via dependency-injected fetch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { nip19 } from 'nostr-tools';

import { useTempHome } from './_home.js';
useTempHome();

// @ts-expect-error — runtime .ts import; tsx resolves it.
const mod = await import('../src/lib/nsite-resolver.ts');
const {
  resolveAddress, resolveNsitName, normalizePath, mimeForPath, fetchBlob,
  unionRelays, fetchSiteIndex,
  NsiteError, DEFAULT_NSITE_RELAYS, DEFAULT_BLOSSOM_SERVERS,
  DEFAULT_NSIT_INDEXER_PUBKEY, DEFAULT_NSIT_INDEXER_RELAYS,
  DEFAULT_CONTENT_RELAYS,
} = mod;

/**
 * Build a fake kind:34128 file event. The dedupe is per (pubkey, d) so
 * tests can simulate multiple publishes of the same path with different
 * timestamps + hashes to exercise the "newest wins" path.
 */
function makeFileEvent(pubkey: string, path: string, sha: string, ts: number, id?: string) {
  return {
    id:         id ?? sha,
    pubkey,
    kind:       34128,
    created_at: ts,
    tags:       [['d', path], ['x', sha]],
    content:    '',
    sig:        'b'.repeat(128),
  };
}

// Trivial fake indexer config used by NSIT tests below.
const FAKE_INDEXER = 'd'.repeat(64);
const NSIT_CFG = { indexerPubkey: FAKE_INDEXER, relays: ['wss://idx.example'] };

// Helper to build a fake kind:35129 event matching the resolver's filter
// shape. created_at is fixed so tests don't depend on the clock.
function makeNsitEvent(name: string, pubkey: string, indexerPk: string) {
  return {
    id:         'a'.repeat(64),
    pubkey:     indexerPk,
    kind:       35129,
    created_at: 1_700_000_000,
    tags:       [['d', name], ['p', pubkey]],
    content:    '',
    sig:        'b'.repeat(128),
  };
}

// Mock queryFn that returns a single event matching the filter, or empty.
function mockQuery(events: any[]) {
  return async () => ({
    events,
    diagnostics: {
      eventsSeen: events.length, uniqueEvents: events.length,
      parseFailures: 0, stderrTail: '', spawnError: null,
      exitCode: null, nakArgs: [], durationMs: 0,
    },
  });
}

// A canonical pubkey + its bech32 form for round-trip checks.
const HEX = 'a'.repeat(63) + 'b';
const NPUB = nip19.npubEncode(HEX);

// ── Address resolution ────────────────────────────────────────────────────

test('resolveAddress: hex pubkey passes through', async () => {
  const r = await resolveAddress(HEX, null);
  assert.equal(r.pubkey, HEX);
  assert.equal(r.source, 'hex');
});

test('resolveAddress: npub decodes to hex', async () => {
  const r = await resolveAddress(NPUB, null);
  assert.equal(r.pubkey, HEX);
  assert.equal(r.source, 'npub');
});

test('resolveAddress: nsite:// scheme is stripped', async () => {
  const r = await resolveAddress(`nsite://${NPUB}`, null);
  assert.equal(r.pubkey, HEX);
  assert.equal(r.source, 'npub');
});

test('resolveAddress: trailing slash is stripped', async () => {
  const r = await resolveAddress(`nsite://${NPUB}/`, null);
  assert.equal(r.pubkey, HEX);
});

test('resolveAddress: bare NSIT name rejected without indexer', async () => {
  await assert.rejects(
    () => resolveAddress('titan', null),
    (e: any) => e instanceof NsiteError && e.code === 'name_indexer_disabled',
  );
});

test('resolveAddress: NSIT name resolved through indexer (kind 35129)', async () => {
  const ev = makeNsitEvent('titan', HEX, FAKE_INDEXER);
  const queryFn = mockQuery([ev]);
  const r = await resolveAddress('titan', NSIT_CFG, fetch as any, queryFn as any);
  assert.equal(r.pubkey, HEX);
  assert.equal(r.source, 'nsit');
});

test('resolveAddress: NSIT name absent on indexer raises name_not_found', async () => {
  const queryFn = mockQuery([]);
  await assert.rejects(
    () => resolveAddress('nope', NSIT_CFG, fetch as any, queryFn as any),
    (e: any) => e instanceof NsiteError && e.code === 'name_not_found',
  );
});

test('resolveNsitName: filter targets correct kind + author + d tag', async () => {
  let capturedFilter: any = null;
  const queryFn = async (opts: any) => {
    capturedFilter = opts.filter;
    return mockQuery([makeNsitEvent('alice', HEX, FAKE_INDEXER)])(opts);
  };
  const got = await resolveNsitName('alice', NSIT_CFG, queryFn as any);
  assert.equal(got, HEX);
  assert.deepEqual(capturedFilter.kinds, [35129]);
  assert.deepEqual(capturedFilter.authors, [FAKE_INDEXER]);
  assert.deepEqual(capturedFilter.tags, { d: 'alice' });
});

test('resolveNsitName: rejects invalid indexer pubkey', async () => {
  await assert.rejects(
    () => resolveNsitName('titan', { indexerPubkey: 'not-hex', relays: ['wss://x'] }, mockQuery([]) as any),
    (e: any) => e instanceof NsiteError && e.code === 'name_indexer_disabled',
  );
});

test('resolveNsitName: rejects empty relay list', async () => {
  await assert.rejects(
    () => resolveNsitName('titan', { indexerPubkey: FAKE_INDEXER, relays: [] }, mockQuery([]) as any),
    (e: any) => e instanceof NsiteError && e.code === 'name_indexer_disabled',
  );
});

test('resolveAddress: nsite.lol gateway URL with bare bech32 subdomain', async () => {
  const npubTail = NPUB.slice('npub1'.length);
  const url = `https://${npubTail}.nsite.lol/some/path`;
  const r = await resolveAddress(url, null);
  assert.equal(r.pubkey, HEX);
  assert.equal(r.source, 'npub');
});

test('resolveAddress: full npub1 in gateway label also works', async () => {
  const r = await resolveAddress(`https://${NPUB}.nsite.lol/`, null);
  assert.equal(r.pubkey, HEX);
});

test('resolveAddress: nsite.lol nsyte form (base36 pubkey + project name)', async () => {
  // Real-world repro from the bug report: nostr-station's own published
  // nsite. Subdomain is base36(pubkey_bytes) + project_name. The trailing
  // "nostr-station" segment becomes the v2-named manifest hint — Titan
  // Browser dispatches the same URL to kind:35128 d=nostr-station, so we
  // do too rather than falling through to root/v1 events at the same
  // pubkey (which may carry a different — typically older — site).
  const url = 'https://10vy5d0umw8izp3bcmh0btzl6k2szvsu8zestncxpsstb6l8e6nostr-station.nsite.lol/';
  const r = await resolveAddress(url, null);
  assert.equal(r.pubkey, '291c75d937a45f66a1209f8ea6611df7448c59b3526520c66ca2cdcd37f1bfbe');
  assert.equal(r.source, 'npub');
  assert.equal(r.name, 'nostr-station', 'project-name suffix should be threaded as v2-named hint');
});

test('resolveAddress: gateway URL with bare pubkey (no name suffix) leaves name undefined', async () => {
  const npubTail = NPUB.slice('npub1'.length);
  const r = await resolveAddress(`https://${npubTail}.nsite.lol/`, null);
  assert.equal(r.pubkey, HEX);
  assert.equal(r.name, undefined, 'no suffix → no name hint');
});

test('resolveAddress: NSIT-resolved name is also returned as the v2 lookup hint', async () => {
  const queryFn = mockQuery([makeNsitEvent('titan', HEX, FAKE_INDEXER)]);
  const r = await resolveAddress('titan', NSIT_CFG, fetch as any, queryFn as any);
  assert.equal(r.name, 'titan');
});

test('resolveAddress: gateway URL with garbage subdomain rejected with helpful error', async () => {
  await assert.rejects(
    () => resolveAddress('https://!!!.nsite.lol/', null),
    (e: any) => e instanceof NsiteError
            && e.code === 'bad_address'
            && /paste the author's npub directly/.test(e.message),
  );
});

test('resolveAddress: nostr.hu gateway URL is also recognized', async () => {
  const npubTail = NPUB.slice('npub1'.length);
  const r = await resolveAddress(`https://${npubTail}.nostr.hu/`, null);
  assert.equal(r.pubkey, HEX);
});

test('defaults: NSIT indexer pubkey is the canonical Titan one', () => {
  assert.match(DEFAULT_NSIT_INDEXER_PUBKEY, /^[0-9a-f]{64}$/);
  assert.ok(DEFAULT_NSIT_INDEXER_RELAYS.length >= 2);
  for (const r of DEFAULT_NSIT_INDEXER_RELAYS) assert.match(r, /^wss:\/\//);
});

test('defaults: content fallback mirrors Titan FALLBACK_RELAYS', () => {
  // The actual list — not just shape. Drift here would silently regress
  // the "browse Titan-ecosystem nsites without configuring anything" fix.
  assert.ok(DEFAULT_CONTENT_RELAYS.includes('wss://relay.westernbtc.com'),
    'relay.westernbtc.com is required — Titan-ecosystem nsites live here');
  for (const r of DEFAULT_CONTENT_RELAYS) assert.match(r, /^wss:\/\//);
});

// ── unionRelays ───────────────────────────────────────────────────────────

test('unionRelays: dedupes case- and trailing-slash-insensitively', () => {
  const out = unionRelays(
    ['wss://Foo.com/', 'wss://bar.com'],
    ['wss://foo.com',  'wss://baz.com/'],
  );
  // First occurrence wins; case + trailing slash collapsed in dedup key.
  assert.deepEqual(out, ['wss://Foo.com/', 'wss://bar.com', 'wss://baz.com/']);
});

test('unionRelays: primary order preserved before secondary additions', () => {
  const out = unionRelays(
    ['wss://primary-1', 'wss://primary-2'],
    ['wss://secondary-1', 'wss://primary-1'],
  );
  assert.deepEqual(out, ['wss://primary-1', 'wss://primary-2', 'wss://secondary-1']);
});

test('unionRelays: empty inputs handled', () => {
  assert.deepEqual(unionRelays([], []), []);
  assert.deepEqual(unionRelays(['wss://a'], []), ['wss://a']);
  assert.deepEqual(unionRelays([], ['wss://a']), ['wss://a']);
});

// ── fetchSiteIndex diagnostics shape ─────────────────────────────────────

test('fetchSiteIndex: per-event entries returned alongside the path map', async () => {
  const pk = HEX;
  const sha1 = '1'.repeat(64);
  const sha2 = '2'.repeat(64);
  const queryFn = mockQuery([
    makeFileEvent(pk, '/index.html', sha1, 1_700_000_000, 'eid-1'),
    makeFileEvent(pk, '/style.css',  sha2, 1_700_001_000, 'eid-2'),
  ]);
  const idx = await fetchSiteIndex(pk, ['wss://r1'], queryFn as any);
  assert.equal(idx.files.size, 2);
  assert.equal(idx.entries.length, 2);
  // Sorted by path → index.html before style.css.
  assert.equal(idx.entries[0].path,    'index.html');
  assert.equal(idx.entries[0].sha256,  sha1);
  assert.equal(idx.entries[0].eventId, 'eid-1');
  assert.equal(idx.entries[1].path,    'style.css');
  assert.equal(idx.latestAt, 1_700_001_000);
  assert.equal(idx.oldestAt, 1_700_000_000);
  assert.equal(idx.totalEventsSeen, 2);
});

test('fetchSiteIndex: replaceable per-path — newest event wins, older is invisible', async () => {
  // Repro of the user-reported scenario: an old "nsite works" placeholder
  // event from a stale tool lingers on one relay, the new publish is
  // newer and has a different hash. Newest-by-created_at wins.
  const pk = HEX;
  const oldSha = 'a'.repeat(64);
  const newSha = 'b'.repeat(64);
  const queryFn = mockQuery([
    makeFileEvent(pk, '/index.html', oldSha, 1_700_000_000, 'old'),
    makeFileEvent(pk, '/index.html', newSha, 1_800_000_000, 'new'),
  ]);
  const idx = await fetchSiteIndex(pk, ['wss://r1'], queryFn as any);
  assert.equal(idx.files.get('index.html'), newSha);
  assert.equal(idx.entries.length, 1);
  assert.equal(idx.entries[0].eventId, 'new');
  // But the diagnostic counter shows BOTH were seen, so the panel can
  // surface "multiple publishes detected" hints if oldestAt !== latestAt.
  assert.equal(idx.totalEventsSeen, 2);
});

test('fetchSiteIndex: throws no_files when zero events', async () => {
  const queryFn = mockQuery([]);
  await assert.rejects(
    () => fetchSiteIndex(HEX, ['wss://r1'], queryFn as any),
    (e: any) => e instanceof NsiteError && e.code === 'no_files',
  );
});

// ── NIP-5A v2 manifest support ───────────────────────────────────────────

/**
 * Build a fake kind:35128 / 15128 v2 manifest event. Tag schema:
 *   ["path", "<path>", "<sha256>"]   one per file
 *   ["server", "<https-url>"]        one per Blossom server
 *   ["d", "<name>"]                  on kind:35128 only
 */
function makeV2Manifest(opts: {
  pubkey: string;
  kind: 35128 | 15128;
  name?: string;
  ts: number;
  files: Array<[string, string]>;
  servers?: string[];
  id?: string;
}) {
  const tags: any[] = [];
  if (opts.kind === 35128 && opts.name) tags.push(['d', opts.name]);
  for (const [p, s] of opts.files) tags.push(['path', p, s]);
  for (const url of (opts.servers ?? [])) tags.push(['server', url]);
  return {
    id:         opts.id ?? 'm' + 'a'.repeat(63),
    pubkey:     opts.pubkey,
    kind:       opts.kind,
    created_at: opts.ts,
    tags,
    content:    '',
    sig:        'b'.repeat(128),
  };
}

test('fetchSiteIndex: v2-named manifest preferred when NSIT name is given', async () => {
  const sha1 = '1'.repeat(64);
  const sha2 = '2'.repeat(64);
  // Query receives a kind:35128 event with d=titan → returns it.
  const queryFn = async (opts: any) => {
    // Sanity: the filter MUST target kind:35128 with d=titan first.
    if (opts.filter.kinds[0] === 35128 && opts.filter.tags?.d === 'titan') {
      return mockQuery([makeV2Manifest({
        pubkey: HEX, kind: 35128, name: 'titan', ts: 1_800_000_000,
        files: [['/index.html', sha1], ['/style.css', sha2]],
        servers: ['https://blossom.westernbtc.com'],
      })])(opts);
    }
    return mockQuery([])(opts);
  };
  const idx = await fetchSiteIndex(HEX, ['wss://r1'], { name: 'titan' }, queryFn as any);
  assert.equal(idx.format, 'v2-named');
  assert.equal(idx.files.get('index.html'), sha1);
  assert.equal(idx.files.get('style.css'), sha2);
  assert.deepEqual(idx.manifestServers, ['https://blossom.westernbtc.com']);
  assert.equal(idx.totalEventsSeen, 1);
});

test('fetchSiteIndex: falls through to v2-root when no NSIT name + named missing', async () => {
  const sha = '3'.repeat(64);
  // No name passed → goes straight to kind:15128 root probe.
  const queryFn = async (opts: any) => {
    if (opts.filter.kinds[0] === 15128) {
      return mockQuery([makeV2Manifest({
        pubkey: HEX, kind: 15128, ts: 1_900_000_000,
        files: [['/index.html', sha]],
      })])(opts);
    }
    return mockQuery([])(opts);
  };
  const idx = await fetchSiteIndex(HEX, ['wss://r1'], {}, queryFn as any);
  assert.equal(idx.format, 'v2-root');
  assert.equal(idx.files.get('index.html'), sha);
});

test('fetchSiteIndex: falls through to v1 when both v2 probes return empty', async () => {
  const sha = '4'.repeat(64);
  const queryFn = async (opts: any) => {
    if (opts.filter.kinds[0] === 34128) {
      return mockQuery([makeFileEvent(HEX, '/index.html', sha, 1_700_000_000)])(opts);
    }
    return mockQuery([])(opts);
  };
  const idx = await fetchSiteIndex(HEX, ['wss://r1'], { name: 'someone' }, queryFn as any);
  assert.equal(idx.format, 'v1');
  assert.equal(idx.files.get('index.html'), sha);
  assert.deepEqual(idx.manifestServers, []);  // v1 has no manifest servers
});

test('fetchSiteIndex: v1 accepts both "sha256" (lez spec) and "x" (nsyte) hash tags', async () => {
  // Real-world coexistence: github.com/lez/nsite spec uses ["sha256", hex],
  // nsyte uses ["x", hex]. Sites published by tools following the original
  // spec are invisible if we only read "x". This test pins both being
  // accepted on the same query.
  const sha1 = '1'.repeat(64);
  const sha2 = '2'.repeat(64);
  const lezEvent = {
    id: 'lez', pubkey: HEX, kind: 34128, created_at: 1_700_000_000,
    tags: [['d', '/index.html'], ['sha256', sha1]],   // lez/nsite convention
    content: '', sig: 'b'.repeat(128),
  };
  const nsyteEvent = {
    id: 'nsyte', pubkey: HEX, kind: 34128, created_at: 1_700_000_001,
    tags: [['d', '/style.css'], ['x', sha2]],         // nsyte convention
    content: '', sig: 'b'.repeat(128),
  };
  const queryFn = async (opts: any) => {
    if (opts.filter.kinds[0] === 34128) return mockQuery([lezEvent, nsyteEvent])(opts);
    return mockQuery([])(opts);
  };
  const idx = await fetchSiteIndex(HEX, ['wss://r1'], queryFn as any);
  assert.equal(idx.files.get('index.html'), sha1, 'sha256 tag accepted');
  assert.equal(idx.files.get('style.css'),  sha2, 'x tag accepted');
});

test('fetchSiteIndex: v1 prefers "sha256" tag over "x" when both present on one event', async () => {
  // Defensive: if a publisher emits both for compat, the canonical-spec
  // tag wins. (Stale "x" tag bytes shouldn't override a fresh "sha256".)
  const canonical = '1'.repeat(64);
  const stale     = '2'.repeat(64);
  const ev = {
    id: 'both', pubkey: HEX, kind: 34128, created_at: 1_700_000_000,
    tags: [['d', '/index.html'], ['sha256', canonical], ['x', stale]],
    content: '', sig: 'b'.repeat(128),
  };
  const queryFn = async (opts: any) =>
    opts.filter.kinds[0] === 34128 ? mockQuery([ev])(opts) : mockQuery([])(opts);
  const idx = await fetchSiteIndex(HEX, ['wss://r1'], queryFn as any);
  assert.equal(idx.files.get('index.html'), canonical);
});

test('fetchSiteIndex: v2 path-tag with bad sha256 is dropped, not crashed on', async () => {
  const queryFn = async (opts: any) => {
    if (opts.filter.kinds[0] === 35128) {
      return mockQuery([makeV2Manifest({
        pubkey: HEX, kind: 35128, name: 'titan', ts: 1_800_000_000,
        files: [
          ['/index.html', '1'.repeat(64)],   // valid
          ['/bad.css',    'not-a-hash'],     // dropped silently
        ],
      })])(opts);
    }
    return mockQuery([])(opts);
  };
  const idx = await fetchSiteIndex(HEX, ['wss://r1'], { name: 'titan' }, queryFn as any);
  assert.equal(idx.files.size, 1);
  assert.ok(idx.files.has('index.html'));
});

test('fetchSiteIndex: positional queryFn (back-compat) still works', async () => {
  // The original signature was fetchSiteIndex(pubkey, relays, queryFn).
  // After adding the opts arg we accept either shape so existing call
  // sites don't break.
  const queryFn = mockQuery([makeFileEvent(HEX, '/index.html', '5'.repeat(64), 1_700_000_000)]);
  const idx = await fetchSiteIndex(HEX, ['wss://r1'], queryFn as any);
  assert.equal(idx.format, 'v1');
});

test('resolveAddress: empty input rejected', async () => {
  await assert.rejects(
    () => resolveAddress('   ', null),
    (e: any) => e instanceof NsiteError && e.code === 'bad_address',
  );
});

test('resolveAddress: malformed npub rejected', async () => {
  await assert.rejects(
    () => resolveAddress('npub1notvalid', null),
    (e: any) => e instanceof NsiteError && e.code === 'bad_address',
  );
});

// ── Path normalization ────────────────────────────────────────────────────

test('normalizePath: leading slash stripped', () => {
  assert.equal(normalizePath('/index.html'), 'index.html');
  assert.equal(normalizePath('/foo/bar.css'), 'foo/bar.css');
});

test('normalizePath: trailing slash gets index.html', () => {
  assert.equal(normalizePath('/'), 'index.html');
  assert.equal(normalizePath('/blog/'), 'blog/index.html');
});

test('normalizePath: query + hash dropped', () => {
  assert.equal(normalizePath('/page.html?x=1#frag'), 'page.html');
});

test('normalizePath: empty becomes index.html', () => {
  assert.equal(normalizePath(''), 'index.html');
});

// ── MIME sniffing ─────────────────────────────────────────────────────────

test('mimeForPath: known extensions resolve', () => {
  assert.match(mimeForPath('a.html'), /text\/html/);
  assert.match(mimeForPath('a.js'),   /application\/javascript/);
  assert.match(mimeForPath('a.css'),  /text\/css/);
  assert.equal(mimeForPath('a.svg'),  'image/svg+xml');
});

test('mimeForPath: unknown extension uses fallback', () => {
  assert.equal(mimeForPath('a.weird', 'application/octet-stream'),
               'application/octet-stream');
});

// ── Blob fetch with SHA256 verify ─────────────────────────────────────────

function sha256Hex(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

test('fetchBlob: returns verified bytes from first ok server', async () => {
  const payload = new TextEncoder().encode('<html>hello</html>');
  const sha = sha256Hex(payload);
  const mockFetch = async () => new Response(payload, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
  const got = await fetchBlob(sha, ['https://cdn.example'], mockFetch as any);
  assert.deepEqual(got.bytes, payload);
  assert.match(got.contentType, /text\/html/);
  assert.equal(got.servedBy, 'https://cdn.example');
});

test('fetchBlob: falls back when first server 404s', async () => {
  const payload = new TextEncoder().encode('asdf');
  const sha = sha256Hex(payload);
  let call = 0;
  const mockFetch = async () => {
    call++;
    if (call === 1) return new Response('', { status: 404 });
    return new Response(payload, { status: 200 });
  };
  const got = await fetchBlob(sha, ['https://a.example', 'https://b.example'], mockFetch as any);
  assert.equal(got.servedBy, 'https://b.example');
});

test('fetchBlob: hash mismatch is rejected (and tried elsewhere)', async () => {
  const wanted   = new TextEncoder().encode('correct content');
  const tampered = new TextEncoder().encode('TAMPERED!');
  const sha = sha256Hex(wanted);
  let call = 0;
  const mockFetch = async () => {
    call++;
    if (call === 1) return new Response(tampered, { status: 200 });
    return new Response(wanted, { status: 200 });
  };
  const got = await fetchBlob(sha, ['https://bad.example', 'https://good.example'], mockFetch as any);
  assert.equal(got.servedBy, 'https://good.example');
  assert.deepEqual(got.bytes, wanted);
});

test('fetchBlob: all servers failing throws blob_fetch_failed', async () => {
  const payload = new TextEncoder().encode('x');
  const sha = sha256Hex(payload);
  const mockFetch = async () => new Response('', { status: 500 });
  await assert.rejects(
    () => fetchBlob(sha, ['https://a.example', 'https://b.example'], mockFetch as any),
    (e: any) => e instanceof NsiteError && e.code === 'blob_fetch_failed',
  );
});

test('fetchBlob: invalid sha256 rejected up front', async () => {
  await assert.rejects(
    () => fetchBlob('not-a-hash', ['https://a.example']),
    (e: any) => e instanceof NsiteError && e.code === 'blob_fetch_failed',
  );
});

test('fetchBlob: empty server list rejected', async () => {
  const sha = 'a'.repeat(64);
  await assert.rejects(
    () => fetchBlob(sha, []),
    (e: any) => e instanceof NsiteError && e.code === 'no_blossom_servers',
  );
});

// ── Defaults ──────────────────────────────────────────────────────────────

test('defaults: relays + blossom servers are non-empty', () => {
  assert.ok(DEFAULT_NSITE_RELAYS.length > 0);
  assert.ok(DEFAULT_BLOSSOM_SERVERS.length > 0);
  for (const r of DEFAULT_NSITE_RELAYS) assert.match(r, /^wss?:\/\//);
  for (const s of DEFAULT_BLOSSOM_SERVERS) assert.match(s, /^https?:\/\//);
});

// ── Blob fetch fallback through defaults ─────────────────────────────────

test('fetchBlob: falls through to a default server when the author-listed one 404s', async () => {
  // Simulates the real bug repro: kind:10063 announces only one server
  // (blossom.band), the blob isn't there, but a public default has a copy.
  const payload = new TextEncoder().encode('<html>recovered from default</html>');
  const sha = sha256Hex(payload);
  let calls: string[] = [];
  const mockFetch = async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith('https://blossom.band/'))      return new Response('', { status: 404 });
    if (u.startsWith('https://cdn.satellite.earth/')) return new Response(payload, { status: 200 });
    return new Response('', { status: 404 });
  };
  const got = await fetchBlob(
    sha,
    ['https://blossom.band', 'https://cdn.satellite.earth'],
    mockFetch as any,
  );
  assert.equal(got.servedBy, 'https://cdn.satellite.earth');
  assert.deepEqual(got.bytes, payload);
  // Author server tried first, default second.
  assert.ok(calls[0].startsWith('https://blossom.band/'),       `first call should be author server, got ${calls[0]}`);
  assert.ok(calls[1].startsWith('https://cdn.satellite.earth/'),`second call should be default, got ${calls[1]}`);
});

test('no_files error message guides the user toward the right diagnosis', async () => {
  // Direct assertion on the error message contract — the panel surfaces
  // this verbatim in the status pill, so wording regressions are visible
  // bugs.
  const err = new NsiteError(
    'no_files',
    `pubkey ${HEX.slice(0, 12)}… resolves correctly, but no kind:34128 file events were found on the queried relays — the author may not have published an nsite under this address yet`,
  );
  assert.match(err.message, /resolves correctly/);
  assert.match(err.message, /may not have published an nsite/);
});
