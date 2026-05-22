/**
 * Tests for the /api/communities/* route module's pure parts:
 *   - parseRoute(url) on the matrix of paths we serve
 *   - validateCreatePayload coerces + rejects bad inputs
 *
 * Full end-to-end HTTP tests would require booting the web server +
 * an authenticated session, which the existing route modules don't
 * exercise either — they keep the unit tests at the pure-helper
 * layer and rely on the smoke test in the dashboard for the wiring.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _parseRoute as parseRoute,
  _validateCreatePayload as validateCreatePayload,
} from '../src/lib/routes/communities.ts';

const ID  = 'a'.repeat(12);
const HEX = 'b'.repeat(64);

test('parseRoute: collection routes', () => {
  assert.deepEqual(parseRoute('/api/communities'),  {});
  assert.deepEqual(parseRoute('/api/communities/'), {});
});

test('parseRoute: detail + actions', () => {
  assert.deepEqual(parseRoute(`/api/communities/${ID}`),         { id: ID });
  assert.deepEqual(parseRoute(`/api/communities/${ID}/start`),   { id: ID, action: 'start' });
  assert.deepEqual(parseRoute(`/api/communities/${ID}/stop`),    { id: ID, action: 'stop' });
  assert.deepEqual(parseRoute(`/api/communities/${ID}/restart`), { id: ID, action: 'restart' });
  assert.deepEqual(parseRoute(`/api/communities/${ID}/logs`),    { id: ID, action: 'logs' });
  assert.deepEqual(parseRoute(`/api/communities/${ID}/members`), { id: ID, action: 'members' });
});

test('parseRoute: member-by-hex sub-path', () => {
  assert.deepEqual(
    parseRoute(`/api/communities/${ID}/members/${HEX}`),
    { id: ID, action: 'members', memberHex: HEX },
  );
});

test('parseRoute: query string is stripped before matching', () => {
  assert.deepEqual(
    parseRoute(`/api/communities/${ID}/logs?token=abc`),
    { id: ID, action: 'logs' },
  );
});

test('parseRoute: detail path matches GET / PATCH / DELETE alike (action stays undefined)', () => {
  // The route table dispatches on (method, action) — same id-only
  // route serves GET (detail), PATCH (rename), and DELETE (remove),
  // so parseRoute returning { id, action: undefined } is the
  // expected shape for all three.
  assert.deepEqual(parseRoute(`/api/communities/${ID}`), { id: ID });
});

test('parseRoute: foreign paths return null (not an empty match)', () => {
  assert.equal(parseRoute('/api/communities/xyz/start'), null,
    'invalid id format must not match');
  assert.equal(parseRoute('/api/community'),  null);
  assert.equal(parseRoute('/api/communities/abc'), null,
    'id must be exactly 12 hex chars');
  assert.equal(parseRoute(`/api/communities/${ID}/unknown-action`), null);
});

test('parseRoute: banwords list + per-word', () => {
  assert.deepEqual(parseRoute(`/api/communities/${ID}/banwords`),
    { id: ID, action: 'banwords' });
  assert.deepEqual(parseRoute(`/api/communities/${ID}/banwords/spam`),
    { id: ID, action: 'banwords', banword: 'spam' });
  assert.deepEqual(parseRoute(`/api/communities/${ID}/banwords/${encodeURIComponent('bad phrase')}`),
    { id: ID, action: 'banwords', banword: 'bad%20phrase' });
});

test('parseRoute: bans list + per-pubkey', () => {
  assert.deepEqual(parseRoute(`/api/communities/${ID}/bans`),
    { id: ID, action: 'bans' });
  assert.deepEqual(parseRoute(`/api/communities/${ID}/bans/${HEX}`),
    { id: ID, action: 'bans', bannedHex: HEX });
});

test('parseRoute: bans/:hex rejects non-hex', () => {
  assert.equal(parseRoute(`/api/communities/${ID}/bans/not-a-hex`), null);
});

// ---------------------------------------------------------------------
// validateCreatePayload

const ADMIN = 'a'.repeat(64);

test('validateCreatePayload: minimal local community is valid', () => {
  const v = validateCreatePayload({
    name: 'fam', privacyMode: 'local', adminPubkey: ADMIN,
  });
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.input.name, 'fam');
    assert.equal(v.input.privacyMode, 'local');
    assert.equal(v.input.adminPubkey, ADMIN);
    assert.equal(v.input.nvpnNetworkId, undefined);
  }
});

test('validateCreatePayload: private-network without nvpnNetworkId is OK at the validator layer', () => {
  // Contract change: the validator accepts a missing nvpnNetworkId
  // for private-network mode. The route handler (POST) auto-resolves
  // from the active nvpn network at create time — that's the
  // Option-B "one shared mesh, no selection to make" model. Tests
  // for the auto-resolve live in tests covering the handler.
  const v = validateCreatePayload({
    name: 'fam', privacyMode: 'private-network', adminPubkey: ADMIN,
  });
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.input.privacyMode, 'private-network');
    assert.equal(v.input.nvpnNetworkId, undefined);
  }
});

test('validateCreatePayload: private-network WITH an explicit nvpnNetworkId passes it through', () => {
  const v = validateCreatePayload({
    name: 'fam', privacyMode: 'private-network', adminPubkey: ADMIN,
    nvpnNetworkId: 'net-abcdef',
  });
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.input.nvpnNetworkId, 'net-abcdef');
});

test('validateCreatePayload: name max 60 chars', () => {
  const v = validateCreatePayload({
    name: 'x'.repeat(61), privacyMode: 'local', adminPubkey: ADMIN,
  });
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.error, /name.*60/);
});

test('validateCreatePayload: rejects non-hex adminPubkey', () => {
  const v = validateCreatePayload({
    name: 'x', privacyMode: 'local', adminPubkey: 'zz'.repeat(32),
  });
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.error, /adminPubkey/);
});

test('validateCreatePayload: rejects malformed memberPubkeys entries with a useful message', () => {
  const v = validateCreatePayload({
    name: 'x', privacyMode: 'local', adminPubkey: ADMIN,
    memberPubkeys: [ADMIN, 'oops'],
  });
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.error, /not 64-char hex/);
});

test('validateCreatePayload: normalizes member pubkeys to lowercase', () => {
  const upper = 'A'.repeat(64);
  const v = validateCreatePayload({
    name: 'x', privacyMode: 'local', adminPubkey: ADMIN,
    memberPubkeys: [upper],
  });
  assert.equal(v.ok, true);
  if (v.ok) assert.deepEqual(v.input.memberPubkeys, ['a'.repeat(64)]);
});

test('validateCreatePayload: description max 200 chars', () => {
  const v = validateCreatePayload({
    name: 'x', privacyMode: 'local', adminPubkey: ADMIN,
    description: 'x'.repeat(201),
  });
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.error, /description.*200/);
});

test('validateCreatePayload: rejects non-object body', () => {
  for (const bad of [null, 'string', 42, undefined]) {
    const v = validateCreatePayload(bad as any);
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.error, /JSON body required/);
  }
});
