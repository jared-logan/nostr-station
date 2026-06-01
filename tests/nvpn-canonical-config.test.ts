import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseCanonicalConfigPath } from '../src/lib/nvpn.ts';

// Synthetic paths only. chooseCanonicalConfigPath is the pure decision core
// for b2's "which config is authoritative"; fs/sudo I/O is layered on top in
// resolveCanonicalConfig / readConfigText / writeConfigText.

const DAEMON = '/root/.config/nvpn/config.toml';
const USER   = '/home/u/.config/nvpn/config.toml';
const ALL_EXIST = () => true;
const NONE_EXIST = () => false;
const NOT_FOREIGN = () => false;

test('chooseCanonical: prefers the daemon path when it exists', () => {
  const c = chooseCanonicalConfigPath({
    daemonPath: DAEMON, userPath: USER,
    exists: ALL_EXIST, foreignOwned: (p) => p === DAEMON,
  });
  assert.equal(c.path, DAEMON);
  assert.equal(c.source, 'daemon');
  assert.equal(c.rootOwned, true);
});

test('chooseCanonical: falls back to the user path when no daemon path', () => {
  const c = chooseCanonicalConfigPath({
    daemonPath: null, userPath: USER,
    exists: ALL_EXIST, foreignOwned: NOT_FOREIGN,
  });
  assert.equal(c.path, USER);
  assert.equal(c.source, 'user');
  assert.equal(c.rootOwned, false);
});

test('chooseCanonical: falls back to user when the daemon path does not exist', () => {
  const c = chooseCanonicalConfigPath({
    daemonPath: DAEMON, userPath: USER,
    exists: (p) => p === USER, foreignOwned: NOT_FOREIGN,
  });
  assert.equal(c.path, USER);
  assert.equal(c.source, 'user');
});

test('chooseCanonical: none when neither exists', () => {
  const c = chooseCanonicalConfigPath({
    daemonPath: DAEMON, userPath: USER,
    exists: NONE_EXIST, foreignOwned: NOT_FOREIGN,
  });
  assert.equal(c.path, null);
  assert.equal(c.source, 'none');
  assert.equal(c.rootOwned, false);
});

test('chooseCanonical: user path reported root-owned when foreign', () => {
  // e.g. dashboard process is not the file owner — reads/writes need sudo.
  const c = chooseCanonicalConfigPath({
    daemonPath: null, userPath: USER,
    exists: ALL_EXIST, foreignOwned: () => true,
  });
  assert.equal(c.path, USER);
  assert.equal(c.rootOwned, true);
});
