import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256File, verifyFileSha256 } from '../src/lib/checksum.ts';
import { getNvpnTarget, getCargoBin } from '../src/lib/detect.ts';

function tmpFile(content: Buffer | string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-checksum-'));
  const p = path.join(dir, 'blob.bin');
  fs.writeFileSync(p, content);
  return p;
}

test('checksum: sha256File returns lowercase hex', () => {
  const p = tmpFile('hello\n');
  const digest = sha256File(p);
  assert.equal(digest.length, 64);
  assert.match(digest, /^[0-9a-f]{64}$/);
  // Reference value for "hello\n":
  assert.equal(digest, '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03');
});

test('checksum: verifyFileSha256 accepts matching digest (mixed case + whitespace)', () => {
  const p = tmpFile('hello\n');
  const digest = sha256File(p);
  assert.equal(verifyFileSha256(p, digest), true);
  assert.equal(verifyFileSha256(p, ' ' + digest.toUpperCase() + '\n'), true);
});

test('checksum: verifyFileSha256 rejects mismatched digest', () => {
  const p = tmpFile('hello\n');
  assert.equal(verifyFileSha256(p, '0'.repeat(64)), false);
});

test('checksum: verifyFileSha256 rejects digest of wrong length', () => {
  const p = tmpFile('hello\n');
  assert.equal(verifyFileSha256(p, 'abc'), false);
});

test('detect: getNvpnTarget returns a known triple or null', () => {
  const triple = getNvpnTarget();
  // Either null (unsupported platform) or one of the published targets.
  if (triple !== null) {
    assert.match(triple, /^(aarch64-apple-darwin|aarch64-unknown-linux-musl|x86_64-unknown-linux-musl)$/);
  }
});

test('detect: getCargoBin lands under home', () => {
  const cb = getCargoBin();
  assert.equal(cb, path.join(os.homedir(), '.cargo', 'bin'));
});
