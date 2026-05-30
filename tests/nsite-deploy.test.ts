import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { useTempHome, resetTempHome } from './_home.js';

const HOME = useTempHome();

const {
  pubkeyToBase36,
  slugifyTitle,
  nsiteUrl,
  resolveBuildDir,
  walkBuildDir,
  withSpaFallbacks,
  buildManifestTemplate,
  refreshAnnounceWebTag,
  deployFiles,
  mimeForPath,
  DEFAULT_NSITE_GATEWAY,
  // @ts-expect-error — runtime import of .ts
} = await import('../src/lib/nsite-deploy.ts');

beforeEach(() => resetTempHome(HOME));

// ── base36 pubkey encoding ──────────────────────────────────────────────────

test('pubkeyToBase36: always 50 lowercase chars', () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const b36 = pubkeyToBase36(pk);
  assert.equal(b36.length, 50);
  assert.match(b36, /^[0-9a-z]{50}$/);
});

test('pubkeyToBase36: left-pads small values to 50', () => {
  // pubkey = 1 → base36 "1" padded to 50 chars.
  const pk = '00'.repeat(31) + '01';
  assert.equal(pubkeyToBase36(pk), '1'.padStart(50, '0'));
});

test('pubkeyToBase36: deterministic + matches known-style prefix length', () => {
  const pk = 'a'.repeat(64);
  const a = pubkeyToBase36(pk);
  const b = pubkeyToBase36(pk.toUpperCase());
  assert.equal(a, b); // case-insensitive input
  assert.equal(a.length, 50);
});

test('pubkeyToBase36: rejects non-hex / wrong length', () => {
  assert.throws(() => pubkeyToBase36('xyz'), /64-hex/);
  assert.throws(() => pubkeyToBase36('ab'.repeat(20)), /64-hex/);
});

// ── slug + url ──────────────────────────────────────────────────────────────

test('slugifyTitle: lowercases, hyphenates, trims', () => {
  assert.equal(slugifyTitle('Nostr VM'), 'nostr-vm');
  assert.equal(slugifyTitle('  My Cool   Site!! '), 'my-cool-site');
  assert.equal(slugifyTitle('already-good'), 'already-good');
});

test('slugifyTitle: empty / all-symbols falls back to "site"', () => {
  assert.equal(slugifyTitle(''), 'site');
  assert.equal(slugifyTitle('!!!'), 'site');
});

test('nsiteUrl: composes base36+slug.gateway with trailing slash', () => {
  const pk = '00'.repeat(31) + '01';
  const url = nsiteUrl(pk, 'nostr-vm');
  assert.equal(url, `https://${'1'.padStart(50, '0')}nostr-vm.${DEFAULT_NSITE_GATEWAY}/`);
});

test('nsiteUrl: honors a custom gateway', () => {
  const pk = '00'.repeat(31) + '01';
  assert.match(nsiteUrl(pk, 'x', 'example.com'), /\.example\.com\/$/);
});

// ── mime ────────────────────────────────────────────────────────────────────

test('mimeForPath: common web extensions', () => {
  assert.equal(mimeForPath('index.html'), 'text/html');
  assert.equal(mimeForPath('main.js'), 'text/javascript');
  assert.equal(mimeForPath('app.css'), 'text/css');
  assert.equal(mimeForPath('manifest.webmanifest'), 'application/manifest+json');
  assert.equal(mimeForPath('whatever.unknownext'), 'application/octet-stream');
});

// ── build dir discovery + walk ──────────────────────────────────────────────

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nsdeploy-'));
}
let tmpDirs: string[] = [];
afterEach(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } tmpDirs = []; });

function makeBuild(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

test('resolveBuildDir: finds dist; honors explicit; null when empty', () => {
  const proj = tmpProject(); tmpDirs.push(proj);
  assert.equal(resolveBuildDir(proj), null); // nothing yet
  makeBuild(path.join(proj, 'dist'), { 'index.html': '<html>' });
  assert.equal(resolveBuildDir(proj), path.join(proj, 'dist'));
  // explicit relative
  makeBuild(path.join(proj, 'out'), { 'a.txt': 'x' });
  assert.equal(resolveBuildDir(proj, 'out'), path.join(proj, 'out'));
  // explicit that doesn't exist → null
  assert.equal(resolveBuildDir(proj, 'nope'), null);
});

test('walkBuildDir: hashes files + normalizes nested POSIX paths', () => {
  const proj = tmpProject(); tmpDirs.push(proj);
  const dist = path.join(proj, 'dist');
  makeBuild(dist, { 'index.html': '<html>hi</html>', 'assets/app.js': 'console.log(1)' });
  const files = walkBuildDir(dist);
  const byPath = Object.fromEntries(files.map((f: any) => [f.path, f]));
  assert.ok(byPath['/index.html']);
  assert.ok(byPath['/assets/app.js']);
  assert.equal(
    byPath['/index.html'].sha256,
    crypto.createHash('sha256').update('<html>hi</html>').digest('hex'),
  );
  assert.equal(byPath['/assets/app.js'].mime, 'text/javascript');
});

test('walkBuildDir: skips symlinks (no escaping the tree)', () => {
  const proj = tmpProject(); tmpDirs.push(proj);
  const dist = path.join(proj, 'dist');
  makeBuild(dist, { 'index.html': 'x' });
  const secret = path.join(proj, 'secret.txt');
  fs.writeFileSync(secret, 'TOPSECRET');
  try { fs.symlinkSync(secret, path.join(dist, 'link.txt')); }
  catch { return; /* symlinks unsupported on this fs — skip */ }
  const warnings: string[] = [];
  const files = walkBuildDir(dist, (m: string) => warnings.push(m));
  assert.ok(!files.some((f: any) => f.path === '/link.txt'));
  assert.ok(warnings.some(w => /symlink/.test(w)));
});

// ── SPA fallbacks ────────────────────────────────────────────────────────────

test('withSpaFallbacks: synthesizes 404.html (=index) + _redirects', () => {
  const idxBytes = Buffer.from('<html>app</html>');
  const files = [{
    path: '/index.html', sha256: crypto.createHash('sha256').update(idxBytes).digest('hex'),
    bytes: idxBytes, mime: 'text/html',
  }];
  const out = withSpaFallbacks(files);
  const byPath = Object.fromEntries(out.map((f: any) => [f.path, f]));
  assert.ok(byPath['/404.html']);
  assert.equal(byPath['/404.html'].sha256, byPath['/index.html'].sha256); // 404 mirrors index
  assert.ok(byPath['/_redirects']);
  assert.match(byPath['/_redirects'].bytes.toString('utf8'), /\/index\.html\s+200/);
});

test('withSpaFallbacks: no-op without index.html', () => {
  const files = [{ path: '/style.css', sha256: 'a'.repeat(64), bytes: Buffer.from('x'), mime: 'text/css' }];
  const out = withSpaFallbacks(files);
  assert.equal(out.length, 1);
});

test('withSpaFallbacks: respects existing 404/_redirects', () => {
  const idx = { path: '/index.html', sha256: 'a'.repeat(64), bytes: Buffer.from('i'), mime: 'text/html' };
  const own404 = { path: '/404.html', sha256: 'b'.repeat(64), bytes: Buffer.from('custom 404'), mime: 'text/html' };
  const out = withSpaFallbacks([idx, own404]);
  const got404 = out.find((f: any) => f.path === '/404.html');
  assert.equal(got404.sha256, 'b'.repeat(64)); // not overwritten
});

// ── manifest builder ─────────────────────────────────────────────────────────

test('buildManifestTemplate: path tags + server/relay hints + client stamp', () => {
  const files = [
    { path: '/index.html', sha256: 'a'.repeat(64), bytes: Buffer.from('x'), mime: 'text/html' },
    { path: '/app.js',     sha256: 'b'.repeat(64), bytes: Buffer.from('y'), mime: 'text/javascript' },
  ];
  const tpl = buildManifestTemplate({
    slug: 'nostr-vm', title: 'NostrVM', description: 'desc',
    files, servers: ['https://blossom.ditto.pub'], relays: ['wss://relay.nsite.lol'],
    source: 'nostr://npub1abc/host/repo',
  });
  assert.equal(tpl.kind, 35128);
  assert.deepEqual(tpl.tags.find((t: string[]) => t[0] === 'd'), ['d', 'nostr-vm']);
  const paths = tpl.tags.filter((t: string[]) => t[0] === 'path');
  assert.equal(paths.length, 2);
  assert.deepEqual(paths[0], ['path', '/index.html', 'a'.repeat(64)]);
  assert.ok(tpl.tags.some((t: string[]) => t[0] === 'server' && t[1] === 'https://blossom.ditto.pub'));
  assert.ok(tpl.tags.some((t: string[]) => t[0] === 'relay'  && t[1] === 'wss://relay.nsite.lol'));
  assert.ok(tpl.tags.some((t: string[]) => t[0] === 'title' && t[1] === 'NostrVM'));
  assert.ok(tpl.tags.some((t: string[]) => t[0] === 'description' && t[1] === 'desc'));
  assert.ok(tpl.tags.some((t: string[]) => t[0] === 'source'));
  assert.ok(tpl.tags.some((t: string[]) => t[0] === 'client' && t[1] === 'nostr-station'));
});

// ── 30617 web-tag refresh ────────────────────────────────────────────────────

test('refreshAnnounceWebTag: replaces web tag, preserves the rest', () => {
  const prior = {
    tags: [
      ['d', 'nostr-vm'], ['name', 'NostrVM'],
      ['web', 'https://old.example'], ['client', 'shakespeare.diy'],
    ],
    content: '',
  };
  const out = refreshAnnounceWebTag(prior, 'https://new.nsite.lol/');
  const webs = out.tags.filter((t: string[]) => t[0] === 'web');
  assert.equal(webs.length, 1);
  assert.equal(webs[0][1], 'https://new.nsite.lol/');
  // other tags preserved
  assert.ok(out.tags.some((t: string[]) => t[0] === 'name' && t[1] === 'NostrVM'));
  assert.ok(out.tags.some((t: string[]) => t[0] === 'client' && t[1] === 'shakespeare.diy'));
});

// ── deployFiles end-to-end (stubbed sign + publish + real upload mock) ───────

import http from 'node:http';
import { verifyEvent } from 'nostr-tools/pure';

function startBlossomMock(store = new Map<string, Buffer>()) {
  const server = http.createServer((req, res) => {
    const p = (req.url || '/').replace(/^\//, '');
    if (req.method === 'HEAD') { res.writeHead(store.has(p) ? 200 : 404); res.end(); return; }
    if (req.method === 'PUT' && p === 'upload') {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        store.set(crypto.createHash('sha256').update(body).digest('hex'), body);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sha256: crypto.createHash('sha256').update(body).digest('hex') }));
      });
      return;
    }
    res.writeHead(405); res.end();
  });
  return server;
}

test('deployFiles: signs, uploads, publishes manifest, returns deterministic URL', async () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const blobStore = new Map<string, Buffer>();
  const mock = startBlossomMock(blobStore);
  await new Promise<void>(r => mock.listen(0, '127.0.0.1', () => r()));
  const port = (mock.address() as any).port;

  const signed: any[] = [];
  const published: any[] = [];
  const deps = {
    signEvent: async (tpl: any) => { const ev = finalizeEvent(tpl, sk); signed.push(ev); return ev; },
    publish: async (ev: any, relays: string[]) => {
      published.push(ev);
      return relays.map(r => ({ relay: r, ok: true }));
    },
  };

  const idx = Buffer.from('<html>vm</html>');
  const js  = Buffer.from('console.log("vm")');
  const files = withSpaFallbacks([
    { path: '/index.html', sha256: crypto.createHash('sha256').update(idx).digest('hex'), bytes: idx, mime: 'text/html' },
    { path: '/main.js',    sha256: crypto.createHash('sha256').update(js).digest('hex'),  bytes: js,  mime: 'text/javascript' },
  ]);

  const lines: string[] = [];
  const result = await deployFiles(files, {
    projectPath: '/tmp/x',
    siteTitle: 'Nostr VM',
    description: 'A desktop env',
    blossomServers: [`http://127.0.0.1:${port}`],
    relays: ['wss://relay.test'],
    ownerPubkeyHex: pk,
    priorAnnounce: { tags: [['d', 'nostr-vm'], ['name', 'NostrVM'], ['web', 'https://old']], content: '' },
    onProgress: (l) => lines.push(l),
  }, deps);

  try {
    // URL is deterministic from pubkey + slug.
    assert.equal(result.url, `https://${pubkeyToBase36(pk)}nostr-vm.${DEFAULT_NSITE_GATEWAY}/`);
    assert.equal(result.slug, 'nostr-vm');

    // index.html + 404.html share a hash → 3 unique blobs (index, main, _redirects).
    assert.equal(result.fileCount, 4); // index, main, 404, _redirects
    assert.equal(result.blobCount, 3);

    // Blobs actually landed on the mock server.
    assert.ok(blobStore.has(files[0].sha256));

    // Signed: 24242 auth, 35128 manifest, 30617 announce = 3 events.
    const kinds = signed.map(e => e.kind).sort((a, b) => a - b);
    assert.deepEqual(kinds, [24242, 30617, 35128]);
    for (const ev of signed) assert.ok(verifyEvent(ev));

    // Manifest accepted; announce present + accepted.
    assert.equal(result.manifest.accepted, 1);
    assert.ok(result.announce);
    assert.equal(result.announce.accepted, 1);

    // Manifest carries the refreshed web tag? (that's on the 30617, check it)
    const announce = published.find(e => e.kind === 30617);
    const web = announce.tags.find((t: string[]) => t[0] === 'web');
    assert.equal(web[1], result.url);

    assert.ok(lines.some(l => /done →/.test(l)));
  } finally {
    await new Promise<void>(r => mock.close(() => r()));
  }
});

test('deployFiles: no priorAnnounce → no 30617 (manifest only)', async () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const mock = startBlossomMock();
  await new Promise<void>(r => mock.listen(0, '127.0.0.1', () => r()));
  const port = (mock.address() as any).port;

  const signed: any[] = [];
  const deps = {
    signEvent: async (tpl: any) => { const ev = finalizeEvent(tpl, sk); signed.push(ev); return ev; },
    publish: async (_ev: any, relays: string[]) => relays.map(r => ({ relay: r, ok: true })),
  };
  const idx = Buffer.from('<html>');
  const files = [{ path: '/index.html', sha256: crypto.createHash('sha256').update(idx).digest('hex'), bytes: idx, mime: 'text/html' }];

  const result = await deployFiles(files, {
    projectPath: '/tmp/x', siteTitle: 'Solo', blossomServers: [`http://127.0.0.1:${port}`],
    relays: ['wss://relay.test'], ownerPubkeyHex: pk,
  }, deps);

  try {
    assert.equal(result.announce, null);
    assert.deepEqual(signed.map(e => e.kind).sort((a, b) => a - b), [24242, 35128]);
  } finally {
    await new Promise<void>(r => mock.close(() => r()));
  }
});

test('deployFiles: throws when a blob fails to upload to any server', async () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const deps = {
    signEvent: async (tpl: any) => finalizeEvent(tpl, sk),
    publish: async (_ev: any, relays: string[]) => relays.map(r => ({ relay: r, ok: true })),
  };
  const idx = Buffer.from('<html>');
  const files = [{ path: '/index.html', sha256: crypto.createHash('sha256').update(idx).digest('hex'), bytes: idx, mime: 'text/html' }];
  // Point at a dead port → upload fails everywhere.
  await assert.rejects(deployFiles(files, {
    projectPath: '/tmp/x', siteTitle: 'Dead', blossomServers: ['http://127.0.0.1:1'],
    relays: ['wss://relay.test'], ownerPubkeyHex: pk,
  }, deps), /failed to upload/);
});

test('deployFiles: throws when manifest rejected by every relay', async () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const mock = startBlossomMock();
  await new Promise<void>(r => mock.listen(0, '127.0.0.1', () => r()));
  const port = (mock.address() as any).port;
  const deps = {
    signEvent: async (tpl: any) => finalizeEvent(tpl, sk),
    publish: async (_ev: any, relays: string[]) => relays.map(r => ({ relay: r, ok: false, reason: 'blocked' })),
  };
  const idx = Buffer.from('<html>');
  const files = [{ path: '/index.html', sha256: crypto.createHash('sha256').update(idx).digest('hex'), bytes: idx, mime: 'text/html' }];
  try {
    await assert.rejects(deployFiles(files, {
      projectPath: '/tmp/x', siteTitle: 'NoRelay', blossomServers: [`http://127.0.0.1:${port}`],
      relays: ['wss://relay.test'], ownerPubkeyHex: pk,
    }, deps), /rejected by every relay/);
  } finally {
    await new Promise<void>(r => mock.close(() => r()));
  }
});
