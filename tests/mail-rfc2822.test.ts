/**
 * RFC 2822 builder + parser round-trip tests.
 *
 * Focused on the shapes we actually emit / receive — plain bodies,
 * unicode subjects, inline base64 attachments, and Blossom-referenced
 * attachments with the X-Nostr-* metadata headers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMessage, parseMessage, mintMessageId,
} from '../src/lib/mail/rfc2822.js';

test('rfc2822: plain text round trip preserves body + headers', () => {
  const messageId = mintMessageId();
  const built = buildMessage({
    fromPubkey: 'a'.repeat(64),
    toPubkey:   'b'.repeat(64),
    subject:    'Lunch plans',
    body:       'Want to grab lunch tomorrow?',
    messageId,
  });
  const parsed = parseMessage(built);
  assert.equal(parsed.subject,   'Lunch plans');
  assert.equal(parsed.from,      'a'.repeat(64));
  assert.equal(parsed.to,        'b'.repeat(64));
  assert.equal(parsed.messageId, messageId);
  assert.equal(parsed.body,      'Want to grab lunch tomorrow?');
  assert.equal(parsed.attachments.length, 0);
});

test('rfc2822: unicode subject survives via encoded-word form', () => {
  const built = buildMessage({
    fromPubkey: 'a'.repeat(64),
    toPubkey:   'b'.repeat(64),
    subject:    'Café meeting · 茶',
    body:       'hello',
    messageId:  mintMessageId(),
  });
  // The wire form must be pure ASCII — RFC 2047 encoded-word.
  assert.match(built, /Subject: =\?utf-8\?B\?/);
  const parsed = parseMessage(built);
  assert.equal(parsed.subject, 'Café meeting · 茶');
});

test('rfc2822: threading headers round trip', () => {
  const parentId   = mintMessageId();
  const grandId    = mintMessageId();
  const built = buildMessage({
    fromPubkey: 'a'.repeat(64),
    toPubkey:   'b'.repeat(64),
    subject:    'Re: thing',
    body:       'replying',
    messageId:  mintMessageId(),
    inReplyTo:  parentId,
    references: [grandId, parentId],
  });
  const parsed = parseMessage(built);
  assert.equal(parsed.inReplyTo, parentId);
  assert.deepEqual(parsed.references, [grandId, parentId]);
});

test('rfc2822: inline base64 attachment round-trips through multipart', () => {
  const file = Buffer.from('PNG\x00\x01\x02fake-image-bytes');
  const built = buildMessage({
    fromPubkey: 'a'.repeat(64),
    toPubkey:   'b'.repeat(64),
    subject:    'screenshot',
    body:       'see attached',
    messageId:  mintMessageId(),
    attachments: [{
      name: 'diagram.png',
      mime: 'image/png',
      size: file.length,
      inline: { base64: file.toString('base64') },
    }],
  });
  // Multipart envelope present.
  assert.match(built, /Content-Type: multipart\/mixed; boundary="/);
  assert.match(built, /Content-Disposition: attachment; filename="diagram\.png"/);

  const parsed = parseMessage(built);
  assert.equal(parsed.body, 'see attached');
  assert.equal(parsed.attachments.length, 1);
  const a = parsed.attachments[0];
  assert.equal(a.name, 'diagram.png');
  assert.equal(a.mime, 'image/png');
  assert.ok(a.inline);
  assert.equal(a.inline!.equals(file), true);
});

test('rfc2822: blossom-referenced attachment carries metadata in MIME headers', () => {
  const built = buildMessage({
    fromPubkey: 'a'.repeat(64),
    toPubkey:   'b'.repeat(64),
    subject:    'big file',
    body:       'too large for inline',
    messageId:  mintMessageId(),
    attachments: [{
      name: 'video.mp4',
      mime: 'video/mp4',
      size: 5 * 1024 * 1024,
      blossom: {
        url:      'http://example.test/abc123',
        sha256:   'c'.repeat(64),
        keyHex:   'd'.repeat(64),
        nonceHex: 'e'.repeat(24),
      },
    }],
  });
  // The part body for blossom attachments is empty — bytes live on Blossom.
  assert.match(built, /X-Nostr-Blossom-URL: http:\/\/example\.test\/abc123/);
  assert.match(built, /X-Nostr-Encryption-Algorithm: aes-256-gcm/);

  const parsed = parseMessage(built);
  assert.equal(parsed.body, 'too large for inline');
  assert.equal(parsed.attachments.length, 1);
  const a = parsed.attachments[0];
  assert.ok(a.blossom);
  assert.equal(a.blossom!.url,      'http://example.test/abc123');
  assert.equal(a.blossom!.sha256,   'c'.repeat(64));
  assert.equal(a.blossom!.keyHex,   'd'.repeat(64));
  assert.equal(a.blossom!.nonceHex, 'e'.repeat(24));
  assert.equal(a.inline, undefined);
});

test('rfc2822: mixed inline + blossom attachments parse correctly', () => {
  const small = Buffer.from('small-bytes');
  const built = buildMessage({
    fromPubkey: 'a'.repeat(64),
    toPubkey:   'b'.repeat(64),
    subject:    'mixed',
    body:       'two files',
    messageId:  mintMessageId(),
    attachments: [
      { name: 'note.txt', mime: 'text/plain', size: small.length,
        inline: { base64: small.toString('base64') } },
      { name: 'big.bin',  mime: 'application/octet-stream', size: 1000000,
        blossom: { url: 'http://x.test/y', sha256: 'a'.repeat(64),
                   keyHex: 'b'.repeat(64), nonceHex: 'c'.repeat(24) } },
    ],
  });
  const parsed = parseMessage(built);
  assert.equal(parsed.attachments.length, 2);
  assert.ok(parsed.attachments[0].inline);
  assert.ok(parsed.attachments[1].blossom);
});

test('rfc2822: parser handles bare LF line endings (lenient input)', () => {
  // Some clients emit \n instead of \r\n. We normalise.
  const bareLf = [
    'From: x',
    'To: y',
    'Subject: hi',
    'Message-ID: <abc@nostr-station>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'body content',
  ].join('\n');
  const parsed = parseMessage(bareLf);
  assert.equal(parsed.subject, 'hi');
  assert.equal(parsed.body,    'body content');
});

test('rfc2822: empty body works (subject-only message)', () => {
  const built = buildMessage({
    fromPubkey: 'a'.repeat(64), toPubkey: 'b'.repeat(64),
    subject: 'ping', body: '', messageId: mintMessageId(),
  });
  const parsed = parseMessage(built);
  assert.equal(parsed.subject, 'ping');
  assert.equal(parsed.body,    '');
});

test('rfc2822: malformed multipart falls back to treating body as plaintext', () => {
  const malformed = [
    'From: x', 'To: y', 'Subject: bad',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed',  // missing boundary parameter
    '', 'some body here',
  ].join('\r\n');
  const parsed = parseMessage(malformed);
  assert.equal(parsed.body, 'some body here');
});

test('rfc2822: mintMessageId produces a well-formed value', () => {
  const id = mintMessageId();
  assert.match(id, /^<[0-9a-f]+@[a-z0-9.-]+>$/);
});
