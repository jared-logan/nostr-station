/**
 * File-crypto round-trip tests for attachment AES-256-GCM.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encryptBlob, decryptBlob } from '../src/lib/mail/file-crypto.js';

test('file-crypto: round-trip preserves bytes', () => {
  const plaintext = Buffer.from('hello attachment ☃ unicode 🚀', 'utf8');
  const { ciphertext, keyHex, nonceHex } = encryptBlob(plaintext);
  // Ciphertext should be plaintext length + 16-byte auth tag.
  assert.equal(ciphertext.length, plaintext.length + 16);
  const out = decryptBlob(ciphertext, keyHex, nonceHex);
  assert.equal(out.toString('utf8'), plaintext.toString('utf8'));
});

test('file-crypto: each encrypt yields a fresh key + nonce', () => {
  const plaintext = Buffer.from('same content');
  const a = encryptBlob(plaintext);
  const b = encryptBlob(plaintext);
  assert.notEqual(a.keyHex,   b.keyHex);
  assert.notEqual(a.nonceHex, b.nonceHex);
  // Ciphertext differs because the nonce differs.
  assert.notEqual(a.ciphertext.toString('hex'), b.ciphertext.toString('hex'));
});

test('file-crypto: tampered ciphertext fails auth check', () => {
  const plaintext = Buffer.from('important payload');
  const { ciphertext, keyHex, nonceHex } = encryptBlob(plaintext);
  // Flip a byte in the middle (not the tag) — GCM still detects it.
  ciphertext[5] ^= 0xff;
  assert.throws(() => decryptBlob(ciphertext, keyHex, nonceHex));
});

test('file-crypto: wrong key fails', () => {
  const plaintext = Buffer.from('secret');
  const { ciphertext, nonceHex } = encryptBlob(plaintext);
  const wrongKey = crypto.randomBytes(32).toString('hex');
  assert.throws(() => decryptBlob(ciphertext, wrongKey, nonceHex));
});

test('file-crypto: handles a 1 MiB payload', () => {
  const big = crypto.randomBytes(1024 * 1024);
  const { ciphertext, keyHex, nonceHex } = encryptBlob(big);
  const out = decryptBlob(ciphertext, keyHex, nonceHex);
  // Use sha256 for the comparison so the diff doesn't dump 1 MiB on failure.
  const hashIn  = crypto.createHash('sha256').update(big).digest('hex');
  const hashOut = crypto.createHash('sha256').update(out).digest('hex');
  assert.equal(hashOut, hashIn);
});

test('file-crypto: rejects malformed key / nonce', () => {
  const blob = Buffer.alloc(32);
  assert.throws(() => decryptBlob(blob, 'not-hex', 'a'.repeat(24)));
  assert.throws(() => decryptBlob(blob, 'a'.repeat(64), 'not-hex'));
});
