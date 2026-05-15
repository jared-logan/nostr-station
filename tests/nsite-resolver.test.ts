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
  resolveAddress, normalizePath, mimeForPath, fetchBlob,
  NsiteError, DEFAULT_NSITE_RELAYS, DEFAULT_BLOSSOM_SERVERS,
} = mod;

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

test('resolveAddress: NSIT name resolved through indexer', async () => {
  // Mock fetch returns the canonical pubkey for the name.
  const mockFetch = async (url: string | URL) => {
    const u = String(url);
    assert.ok(u.includes('/titan'), `expected lookup URL to include name, got: ${u}`);
    return new Response(JSON.stringify({ pubkey: HEX }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const r = await resolveAddress('titan', 'https://names.example/lookup', mockFetch as any);
  assert.equal(r.pubkey, HEX);
  assert.equal(r.source, 'nsit');
});

test('resolveAddress: NSIT indexer URL template {name} is substituted', async () => {
  let calledUrl = '';
  const mockFetch = async (url: string | URL) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ pubkey: HEX }), { status: 200 });
  };
  await resolveAddress('alice', 'https://idx.example/v1/{name}.json', mockFetch as any);
  assert.equal(calledUrl, 'https://idx.example/v1/alice.json');
});

test('resolveAddress: NSIT 404 raises name_not_found', async () => {
  const mockFetch = async () => new Response('', { status: 404 });
  await assert.rejects(
    () => resolveAddress('nope', 'https://names.example', mockFetch as any),
    (e: any) => e instanceof NsiteError && e.code === 'name_not_found',
  );
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
