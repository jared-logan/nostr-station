import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  isSafeRef,
  isSafePath,
  isLikelyBinary,
  parseRepoAnnouncement,
  clampInt,
} = await import('../src/lib/routes/repo.ts');

// ── isSafeRef ────────────────────────────────────────────────────────────

test('isSafeRef: accepts plain branch / tag names', () => {
  for (const ok of ['main', 'master', 'develop', 'v1.2.3', 'release-1', 'feature_x']) {
    assert.equal(isSafeRef(ok), true, ok);
  }
});

test('isSafeRef: accepts full ref paths', () => {
  for (const ok of ['refs/heads/main', 'refs/tags/v1.0.0', 'refs/heads/feature/foo']) {
    assert.equal(isSafeRef(ok), true, ok);
  }
});

test('isSafeRef: accepts short SHAs', () => {
  assert.equal(isSafeRef('abc1234'), true);
  assert.equal(isSafeRef('a'.repeat(40)), true);
});

test('isSafeRef: rejects empty / overlong', () => {
  assert.equal(isSafeRef(''), false);
  assert.equal(isSafeRef('a'.repeat(256)), false);
});

test('isSafeRef: rejects leading dash (would be misread as a flag)', () => {
  assert.equal(isSafeRef('-main'), false);
  assert.equal(isSafeRef('--all'), false);
});

test('isSafeRef: rejects path-traversal patterns', () => {
  assert.equal(isSafeRef('refs/../etc'),     false);
  assert.equal(isSafeRef('refs//heads/main'), false);
  assert.equal(isSafeRef('/refs/heads/main'), false);
  assert.equal(isSafeRef('refs/heads/main/'), false);
});

test('isSafeRef: rejects shell metacharacters and whitespace', () => {
  for (const bad of ['a;b', 'a b', 'a&b', 'a|b', 'a$x', 'a`x`', 'a\nb', 'a\tb', 'a"b', "a'b"]) {
    assert.equal(isSafeRef(bad), false, JSON.stringify(bad));
  }
});

test('isSafeRef: rejects non-string inputs', () => {
  // Defensive: query-param values can theoretically be undefined or
  // arrays; the regex predicate must guard.
  assert.equal(isSafeRef(null as any),     false);
  assert.equal(isSafeRef(undefined as any), false);
  assert.equal(isSafeRef(123 as any),       false);
});

// ── isSafePath ───────────────────────────────────────────────────────────

test('isSafePath: empty string is the repo root', () => {
  assert.equal(isSafePath(''), true);
});

test('isSafePath: accepts ordinary paths', () => {
  for (const ok of ['README.md', 'src/lib/foo.ts', 'a/b/c.json', 'docs/architecture/maintainer-model.md']) {
    assert.equal(isSafePath(ok), true, ok);
  }
});

test('isSafePath: rejects absolute paths and leading dash', () => {
  assert.equal(isSafePath('/etc/passwd'),      false);
  assert.equal(isSafePath('-rf'),              false);
});

test('isSafePath: rejects parent-segment traversal', () => {
  assert.equal(isSafePath('..'),               false);
  assert.equal(isSafePath('src/../etc'),       false);
  assert.equal(isSafePath('a/b/../../c'),      false);
  assert.equal(isSafePath('./foo'),            false);
});

test('isSafePath: rejects empty segments and NUL', () => {
  assert.equal(isSafePath('a//b'),             false);
  assert.equal(isSafePath('a/\0/b'),           false);
});

test('isSafePath: rejects overlong paths', () => {
  assert.equal(isSafePath('a'.repeat(1025)),   false);
});

// ── isLikelyBinary ───────────────────────────────────────────────────────

test('isLikelyBinary: text content is not binary', () => {
  assert.equal(isLikelyBinary(Buffer.from('hello world\n')),                 false);
  assert.equal(isLikelyBinary(Buffer.from('# README\n\nMarkdown content')),  false);
  assert.equal(isLikelyBinary(Buffer.from('// some code\nconst x = 1;\n')), false);
});

test('isLikelyBinary: a single null byte in the first 8 kB classifies as binary', () => {
  assert.equal(isLikelyBinary(Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6f])), true);
});

test('isLikelyBinary: null beyond the 8 kB scan window is missed (deliberate)', () => {
  // Only the first 8 kB is scanned — deliberately bounded so we don't
  // chew through 100 MB looking for a null. Mirrors git's own heuristic.
  const buf = Buffer.alloc(9000, 0x41);  // 'A' * 9000
  buf[8500] = 0;
  assert.equal(isLikelyBinary(buf), false);
});

test('isLikelyBinary: empty buffer is not binary', () => {
  assert.equal(isLikelyBinary(Buffer.alloc(0)), false);
});

// ── parseRepoAnnouncement ────────────────────────────────────────────────

const PUBKEY      = 'a'.repeat(64);
const COMAINT     = 'b'.repeat(64);
const COMAINT_TWO = 'c'.repeat(64);

function makeAnnouncement(tags: string[][]): any {
  return {
    id:         'd'.repeat(64),
    pubkey:     PUBKEY,
    kind:       30617,
    created_at: 1_700_000_000,
    tags,
    content:    '',
    sig:        'e'.repeat(128),
  };
}

test('parseRepoAnnouncement: extracts standard NIP-34 fields', () => {
  const ev = makeAnnouncement([
    ['d', 'torchlite'],
    ['name', 'Torchlite'],
    ['description', 'A nostr app'],
    ['web', 'https://torchlite.example'],
    ['clone', 'https://relay.ngit.dev/x/torchlite.git'],
    ['relays', 'wss://relay.ngit.dev'],
    ['t', 'nostr'],
    ['t', 'ngit'],
    ['r', 'abcdef0123456789', 'euc'],
  ]);
  const meta = parseRepoAnnouncement(ev);
  assert.equal(meta.coordinate,  `30617:${PUBKEY}:torchlite`);
  assert.equal(meta.identifier,  'torchlite');
  assert.equal(meta.name,        'Torchlite');
  assert.equal(meta.description, 'A nostr app');
  assert.deepEqual(meta.web,     ['https://torchlite.example']);
  assert.deepEqual(meta.clone,   ['https://relay.ngit.dev/x/torchlite.git']);
  assert.deepEqual(meta.relays,  ['wss://relay.ngit.dev']);
  assert.deepEqual(meta.hashtags, ['nostr', 'ngit']);
  assert.equal(meta.euc,         'abcdef0123456789');
  assert.equal(meta.publishedAt, 1_700_000_000);
});

test('parseRepoAnnouncement: name falls back to identifier when missing', () => {
  const meta = parseRepoAnnouncement(makeAnnouncement([['d', 'foo']]));
  assert.equal(meta.name, 'foo');
});

test('parseRepoAnnouncement: announcing pubkey is always in maintainer set', () => {
  // Announcing pubkey trivially trusted (signed under its own coord).
  const meta = parseRepoAnnouncement(makeAnnouncement([['d', 'foo']]));
  assert.deepEqual(meta.maintainers, [PUBKEY]);
});

test('parseRepoAnnouncement: co-maintainers union with announcing pubkey, dedupe', () => {
  const ev = makeAnnouncement([
    ['d', 'foo'],
    ['maintainers', COMAINT, COMAINT_TWO],
    ['maintainers', PUBKEY],          // already implicit — dedupe
  ]);
  const meta = parseRepoAnnouncement(ev);
  assert.equal(meta.maintainers[0], PUBKEY, 'announcing pubkey first');
  assert.ok(meta.maintainers.includes(COMAINT));
  assert.ok(meta.maintainers.includes(COMAINT_TWO));
  // Dedupe — PUBKEY should appear once, not twice.
  const count = meta.maintainers.filter((p: string) => p === PUBKEY).length;
  assert.equal(count, 1);
});

test('parseRepoAnnouncement: filters non-hex maintainers', () => {
  const ev = makeAnnouncement([
    ['d', 'foo'],
    ['maintainers', 'not-hex', COMAINT, '   ', 'also not hex'],
  ]);
  const meta = parseRepoAnnouncement(ev);
  // PUBKEY (announcer, implicit) + COMAINT.
  assert.deepEqual(meta.maintainers, [PUBKEY, COMAINT]);
});

test('parseRepoAnnouncement: web tags sanitized via safeHttpUrl', () => {
  const ev = makeAnnouncement([
    ['d', 'foo'],
    ['web', 'javascript:alert(1)'],     // dropped
    ['web', 'https://safe.example'],    // kept
    ['web', 'ftp://nope.example'],      // dropped
  ]);
  const meta = parseRepoAnnouncement(ev);
  assert.deepEqual(meta.web, ['https://safe.example']);
});

test('parseRepoAnnouncement: multi-clone URL union preserved in order', () => {
  const ev = makeAnnouncement([
    ['d', 'foo'],
    ['clone', 'https://a.example/x.git'],
    ['clone', 'https://b.example/x.git', 'ssh://b.example/x.git'],
  ]);
  const meta = parseRepoAnnouncement(ev);
  assert.deepEqual(meta.clone, [
    'https://a.example/x.git',
    'https://b.example/x.git',
    'ssh://b.example/x.git',
  ]);
});

test('parseRepoAnnouncement: missing optional fields default safely', () => {
  const meta = parseRepoAnnouncement(makeAnnouncement([['d', 'foo']]));
  assert.equal(meta.description, '');
  assert.deepEqual(meta.web,     []);
  assert.deepEqual(meta.clone,   []);
  assert.deepEqual(meta.relays,  []);
  assert.deepEqual(meta.hashtags, []);
  assert.equal(meta.euc,         null);
});

test('parseRepoAnnouncement: hashtag length cap (≤ 64 chars)', () => {
  const ev = makeAnnouncement([
    ['d', 'foo'],
    ['t', 'short'],
    ['t', 'a'.repeat(65)],   // dropped
    ['t', 'a'.repeat(64)],   // kept (boundary)
  ]);
  const meta = parseRepoAnnouncement(ev);
  assert.deepEqual(meta.hashtags, ['short', 'a'.repeat(64)]);
});

test('parseRepoAnnouncement: euc marker is the FIRST r/euc tag', () => {
  // If multiple r=...,euc tags exist, the first wins. NIP-34 doesn't
  // specify ordering, but pinning to first-wins is deterministic.
  const ev = makeAnnouncement([
    ['d', 'foo'],
    ['r', 'first-euc', 'euc'],
    ['r', 'second-euc', 'euc'],
  ]);
  assert.equal(parseRepoAnnouncement(ev).euc, 'first-euc');
});

test('parseRepoAnnouncement: r tags WITHOUT the "euc" marker are not the EUC', () => {
  // `r` tags are also used for plain refs in NIP-34. Only the
  // explicitly-marked one is the earliest-unique-commit.
  const ev = makeAnnouncement([
    ['d', 'foo'],
    ['r', 'random-ref'],
    ['r', 'another-ref', 'something-else'],
  ]);
  assert.equal(parseRepoAnnouncement(ev).euc, null);
});

// ── clampInt ─────────────────────────────────────────────────────────────

test('clampInt: returns fallback for null', () => {
  assert.equal(clampInt(null, 20, 1, 100), 20);
});

test('clampInt: returns fallback for non-numeric', () => {
  assert.equal(clampInt('abc',  20, 1, 100), 20);
  assert.equal(clampInt('',     20, 1, 100), 20);
  assert.equal(clampInt('NaN',  20, 1, 100), 20);
});

test('clampInt: clamps within bounds', () => {
  assert.equal(clampInt('50',   20, 1, 100), 50);
  assert.equal(clampInt('200',  20, 1, 100), 100);
  assert.equal(clampInt('-5',   20, 1, 100), 1);
  assert.equal(clampInt('0',    20, 1, 100), 1);
});

test('clampInt: parses leading-numeric strings (parseInt semantics)', () => {
  // parseInt('10abc', 10) → 10. Document the behavior so a future
  // tightening (to /^-?\d+$/) is a deliberate choice.
  assert.equal(clampInt('10abc', 20, 1, 100), 10);
});
