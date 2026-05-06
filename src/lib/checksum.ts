// SHA256 verification for downloaded binaries.
//
// Pulled into its own module so the binary-fetch helpers can stay focused
// on the network/spawn flow, and the verify path can be unit-tested
// without dragging execa + the install machinery into the test process.
//
// The hard-fail contract: every download path that calls verifyFileSha256()
// must treat `false` as a fatal error and refuse the install. There is no
// "silently fall back to unverified" mode.

import { createHash } from 'crypto';
import { readFileSync } from 'fs';

// Computes SHA256 of `filePath`, returns hex digest in lowercase. Caller
// is responsible for handling read errors — we don't catch them here so a
// missing file surfaces as a thrown error rather than a fake "checksum
// mismatch" reason.
export function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

// Constant-time-ish compare of computed digest against an expected hex
// string. Lowercase + trim both sides so callers can pass mixed-case or
// whitespace-padded values from external sources without surprises.
//
// Returns true if the file's SHA256 matches `expectedHex`, false otherwise.
// Throws (propagates) on read failure — see sha256File above.
export function verifyFileSha256(filePath: string, expectedHex: string): boolean {
  const actual = sha256File(filePath).toLowerCase();
  const expected = expectedHex.trim().toLowerCase();
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
