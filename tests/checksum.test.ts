import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// No HOME isolation needed — pure file/crypto helpers.
// @ts-expect-error — runtime import of .ts; tsx handles the resolution
const { verifyFileSha256, sha256File } = await import('../src/lib/checksum.ts');

const TMP = mkdtempSync(join(tmpdir(), 'nostr-station-checksum-'));

function writeTmp(name: string, contents: Buffer | string): string {
  const p = join(TMP, name);
  writeFileSync(p, contents);
  return p;
}

// Known answer: SHA256("hello") =
//   2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
test('sha256File: matches the well-known SHA256 of "hello"', () => {
  const f = writeTmp('hello.txt', 'hello');
  assert.equal(
    sha256File(f),
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  );
});

test('sha256File: handles binary bytes (not just utf-8 strings)', () => {
  const f = writeTmp('bytes.bin', Buffer.from([0x00, 0x01, 0xff, 0xfe]));
  // Pin computed value to lock down the byte-level hashing path.
  assert.equal(sha256File(f), '5e90fe977790507860b03456633c9ad88ea951cd8a6620d3e37ca43c160c15ae');
});

test('verifyFileSha256: returns true on exact match', () => {
  const f = writeTmp('match.txt', 'hello');
  const ok = verifyFileSha256(
    f,
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  );
  assert.equal(ok, true);
});

test('verifyFileSha256: case-insensitive comparison (uppercase expected)', () => {
  const f = writeTmp('case.txt', 'hello');
  const ok = verifyFileSha256(
    f,
    '2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824',
  );
  assert.equal(ok, true);
});

test('verifyFileSha256: tolerates surrounding whitespace in expected hex', () => {
  // SHA256SUMS-style files have `<hex>  <name>` lines — the parser may pass
  // an unstripped hex token. The helper should accept that.
  const f = writeTmp('whitespace.txt', 'hello');
  const ok = verifyFileSha256(
    f,
    '  2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824\n',
  );
  assert.equal(ok, true);
});

test('verifyFileSha256: returns false on single-bit mismatch', () => {
  const f = writeTmp('mismatch.txt', 'hello');
  // Last hex digit flipped: ...9824 → ...9825
  const ok = verifyFileSha256(
    f,
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9825',
  );
  assert.equal(ok, false);
});

test('verifyFileSha256: returns false when expected hex has wrong length', () => {
  const f = writeTmp('wronglen.txt', 'hello');
  // 63 chars instead of 64 — off-by-one on truncation should never silently
  // match the leading bytes.
  assert.equal(
    verifyFileSha256(f, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b982'),
    false,
  );
});

test('verifyFileSha256: returns false when content differs from expected', () => {
  const f = writeTmp('different.txt', 'goodbye');
  // The "hello" digest — wrong file, right hash → false.
  const ok = verifyFileSha256(
    f,
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  );
  assert.equal(ok, false);
});

test('verifyFileSha256: throws when file is missing (no false-positive mismatch)', () => {
  // Contract: a missing file is a different failure mode than a mismatch.
  // Callers (installNak / installNostrVpn) catch this as a distinct error
  // path so users get an accurate "file gone" message instead of a fake
  // "checksum mismatch".
  const ghost = join(TMP, 'does-not-exist');
  assert.throws(() => verifyFileSha256(
    ghost,
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  ));
});

// ── teardown ──────────────────────────────────────────────────────────────
test('cleanup tmp dir', () => {
  rmSync(TMP, { recursive: true, force: true });
});
