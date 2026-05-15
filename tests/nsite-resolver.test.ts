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
  unionRelays,
  NsiteError, DEFAULT_NSITE_RELAYS, DEFAULT_BLOSSOM_SERVERS,
  DEFAULT_NSIT_INDEXER_PUBKEY, DEFAULT_NSIT_INDEXER_RELAYS,
} = mod;

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
  // nsite. Subdomain is base36(pubkey_bytes) + project_name.
  const url = 'https://10vy5d0umw8izp3bcmh0btzl6k2szvsu8zestncxpsstb6l8e6nostr-station.nsite.lol/';
  const r = await resolveAddress(url, null);
  assert.equal(r.pubkey, '291c75d937a45f66a1209f8ea6611df7448c59b3526520c66ca2cdcd37f1bfbe');
  assert.equal(r.source, 'npub');
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
