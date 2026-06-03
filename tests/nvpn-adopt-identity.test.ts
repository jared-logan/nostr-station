import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAdoptIdentity } from '../src/lib/nvpn.ts';

// All npubs/paths synthetic. decideAdoptIdentity is the pure decision core
// for "make the daemon run the managed identity"; the fs/proc/sudo I/O is
// layered on top in planAdoptIdentity/adoptIdentity.

const MANAGED = '/home/u/.config/nvpn/config.toml';
const DAEMON  = '/root/.config/nvpn/config.toml';

test('decideAdoptIdentity: split identities → needed, with a 3-step plan', () => {
  const p = decideAdoptIdentity({
    managedConfigPath: MANAGED, managedNpub: 'npub1managed',
    daemonConfigPath:  DAEMON,  daemonNpub:  'npub1daemonother',
  });
  assert.equal(p.needed, true);
  assert.equal(p.blocker, null);
  assert.equal(p.summary.length, 3);
  assert.match(p.summary[0], /Back up the daemon config/);
  assert.match(p.summary[1], /onto \/root\/\.config/);
});

test('decideAdoptIdentity: same identity → blocked, not needed', () => {
  const p = decideAdoptIdentity({
    managedConfigPath: MANAGED, managedNpub: 'npub1same',
    daemonConfigPath:  DAEMON,  daemonNpub:  'npub1same',
  });
  assert.equal(p.needed, false);
  assert.match(p.blocker, /already runs the managed identity/);
});

test('decideAdoptIdentity: daemon reads the managed config already → blocked', () => {
  const p = decideAdoptIdentity({
    managedConfigPath: MANAGED, managedNpub: 'npub1x',
    daemonConfigPath:  MANAGED, daemonNpub:  'npub1x',
  });
  assert.equal(p.needed, false);
  assert.match(p.blocker, /already reads the managed config/);
});

test('decideAdoptIdentity: no daemon config path → blocked (not running / not a service)', () => {
  const p = decideAdoptIdentity({
    managedConfigPath: MANAGED, managedNpub: 'npub1x',
    daemonConfigPath:  null,    daemonNpub:  null,
  });
  assert.equal(p.needed, false);
  assert.match(p.blocker, /could not resolve the daemon/);
});

test('decideAdoptIdentity: no managed config → blocked (run nvpn init)', () => {
  const p = decideAdoptIdentity({
    managedConfigPath: null,   managedNpub: null,
    daemonConfigPath:  DAEMON, daemonNpub:  'npub1d',
  });
  assert.equal(p.needed, false);
  assert.match(p.blocker, /no user-side nvpn config/);
});

test('decideAdoptIdentity: distinct files, daemon identity unreadable (null) → still needed', () => {
  // Can't read the daemon npub (e.g. empty sudo cred cache), but it's a
  // different config file than the managed one — adopting is still the
  // right move; we just can't show the daemon's npub.
  const p = decideAdoptIdentity({
    managedConfigPath: MANAGED, managedNpub: 'npub1managed',
    daemonConfigPath:  DAEMON,  daemonNpub:  null,
  });
  assert.equal(p.needed, true);
  assert.equal(p.daemonNpub, null);
});

// shouldReconcileAfterInstall + reconcileDaemonIdentityAfterInstall were
// retired with the create-then-heal layer (the helper's install now seeds
// the canonical config + repoints the daemon at it). The manual adopt path
// (decideAdoptIdentity, above) is what remains.
