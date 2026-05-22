/**
 * Tests for the NIP-86 admin client.
 *
 * Focused on the wire-shape primitives — the parts we can exercise
 * without a live GRAIN or a real Amber bunker:
 *   - payloadHashHex matches the standard SHA-256 of UTF-8 bytes
 *   - buildNip98Template emits the kind, tags, and required fields
 *   - typed verbs reject malformed inputs at the boundary
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  payloadHashHex, buildNip98Template,
  banPubkey, unbanPubkey, allowKind, disallowKind,
} from '../src/lib/community-admin.ts';

test('payloadHashHex matches node crypto sha256 hex digest', () => {
  for (const s of ['', 'hello', '{"method":"banpubkey","params":["aa"]}']) {
    const ours   = payloadHashHex(s);
    const theirs = createHash('sha256').update(s, 'utf8').digest('hex');
    assert.equal(ours, theirs, `mismatch for ${JSON.stringify(s)}`);
  }
});

test('buildNip98Template emits kind 27235 with u/method/payload tags', () => {
  const url  = 'http://127.0.0.1:7778/';
  const body = '{"method":"stats","params":[]}';
  const t    = buildNip98Template(url, 'POST', body);
  assert.equal(t.kind, 27235);
  assert.equal(t.content, '');
  const tagsByName = new Map(t.tags.map((row) => [row[0], row[1]]));
  assert.equal(tagsByName.get('u'),       url);
  assert.equal(tagsByName.get('method'),  'POST');
  assert.equal(tagsByName.get('payload'), payloadHashHex(body));
  // created_at must be a Unix timestamp roughly equal to "now".
  const now = Math.floor(Date.now() / 1000);
  assert.ok(Math.abs(t.created_at - now) < 5);
});

test('banPubkey rejects non-hex / wrong-length pubkeys at the boundary', async () => {
  // These should throw synchronously (BEFORE attempting to sign) so a
  // misuse from the route layer surfaces as a 400, not a 5xx after a
  // bunker timeout. Each case is invalid for a different reason:
  //   - ''               empty
  //   - 'abc'            wrong length
  //   - 'zz'.repeat(32)  64 chars but 'z' isn't hex
  //   - 'b'.repeat(63)   one char short of 64
  for (const bad of ['', 'abc', 'zz'.repeat(32), 'b'.repeat(63)]) {
    await assert.rejects(banPubkey('an-id', bad), /64-char/);
  }
});

test('unbanPubkey shares the boundary validation with banPubkey', async () => {
  await assert.rejects(unbanPubkey('an-id', 'too-short'), /64-char/);
});

test('allowKind / disallowKind reject non-integer or negative kinds', async () => {
  for (const bad of [-1, 1.5, NaN, Infinity]) {
    await assert.rejects(allowKind('an-id', bad as number),    /non-negative integer/);
    await assert.rejects(disallowKind('an-id', bad as number), /non-negative integer/);
  }
});
