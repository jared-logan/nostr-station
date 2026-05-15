/**
 * AES-256-GCM helpers for attachment payloads.
 *
 * NIP-17 spec doesn't pin down a file-encryption format. We chose
 * AES-256-GCM with a fresh random 32-byte key + 12-byte nonce per
 * attachment, with the 16-byte auth tag appended to the ciphertext (the
 * standard "GCM combined" layout that browsers / WebCrypto and Node's
 * `crypto.subtle` both produce by default). The key + nonce are
 * embedded as hex tags inside the kind-15 rumor, which itself is wrapped
 * in NIP-44 by the gift-wrap pipeline — so the encryption key is only
 * recoverable by someone who can already decrypt the gift wrap.
 *
 * Result: anyone with the URL but no rumor sees uncrackable ciphertext;
 * the recipient (and only the recipient) can decrypt.
 *
 * 25 MiB attachment cap from /api/mail/attachment keeps the buffer
 * comfortably within heap budgets — we do not stream encryption.
 */

import crypto from 'node:crypto';

const ALG = 'aes-256-gcm';
const KEY_BYTES   = 32;
const NONCE_BYTES = 12;
const TAG_BYTES   = 16;

export interface EncryptedBlob {
  // ciphertext || authTag (16 bytes appended). Ready to upload as a
  // single opaque blob; the downloader's slice() reverses the layout.
  ciphertext: Buffer;
  // Hex strings — what we stash in the rumor as
  // ["encryption-key", …] and ["encryption-nonce", …].
  keyHex:     string;
  nonceHex:   string;
}

export function encryptBlob(plaintext: Buffer): EncryptedBlob {
  const key   = crypto.randomBytes(KEY_BYTES);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv(ALG, key, nonce);
  const enc    = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([enc, tag]),
    keyHex:     key.toString('hex'),
    nonceHex:   nonce.toString('hex'),
  };
}

export function decryptBlob(
  blob:     Buffer,
  keyHex:   string,
  nonceHex: string,
): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) {
    throw new Error('decryptBlob: key must be 64 hex chars (32 bytes)');
  }
  if (!/^[0-9a-f]{24}$/i.test(nonceHex)) {
    throw new Error('decryptBlob: nonce must be 24 hex chars (12 bytes)');
  }
  if (blob.length < TAG_BYTES + 1) {
    throw new Error('decryptBlob: blob too small to contain auth tag');
  }
  const key   = Buffer.from(keyHex,   'hex');
  const nonce = Buffer.from(nonceHex, 'hex');
  const tag   = blob.subarray(blob.length - TAG_BYTES);
  const enc   = blob.subarray(0, blob.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALG, key, nonce);
  decipher.setAuthTag(tag);
  // decipher.final() throws on auth tag mismatch — propagate as-is so
  // the route returns 500 with the original message.
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}
