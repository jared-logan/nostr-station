import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  extractBaseExecStart,
  rewriteExecStartWithConfig,
  renderNvpnConfigDropIn,
  canonicalConfigInstallPath,
} from '../src/lib/nvpn.ts';

// Pure cores of b2 stage 4's ExecStart repoint. The sudo/systemctl I/O in
// applyNvpnConfigDropIn (+ its rollback guard) is exercised on the VM.

// Synthetic `systemctl cat nvpn.service` output: base fragment + a drop-in.
const CAT = [
  '# /etc/systemd/system/nvpn.service',
  '[Unit]',
  'Description=nvpn mesh daemon',
  '',
  '[Service]',
  'ExecStart=/usr/bin/nvpn --service',
  'Restart=always',
  '',
  '# /etc/systemd/system/nvpn.service.d/10-nostr-station-caps.conf',
  '[Service]',
  'AmbientCapabilities=CAP_NET_ADMIN',
  '',
].join('\n');

test('extractBaseExecStart: pulls ExecStart from the base fragment only', () => {
  assert.equal(extractBaseExecStart(CAT), '/usr/bin/nvpn --service');
});

test('extractBaseExecStart: ignores ExecStart that lives in a drop-in fragment', () => {
  const catWithOverride = CAT + [
    '# /etc/systemd/system/nvpn.service.d/20-nostr-station-config.conf',
    '[Service]',
    'ExecStart=',
    'ExecStart=/usr/bin/nvpn --service --config /home/u/.config/nvpn/config.toml',
    '',
  ].join('\n');
  // The base fragment's ExecStart is what we augment, not our own override.
  assert.equal(extractBaseExecStart(catWithOverride), '/usr/bin/nvpn --service');
});

test('extractBaseExecStart: null when there is no base ExecStart', () => {
  assert.equal(extractBaseExecStart('# /etc/systemd/system/other.service\n[Service]\n'), null);
});

test('rewriteExecStartWithConfig: appends --config when none present', () => {
  assert.equal(
    rewriteExecStartWithConfig('/usr/bin/nvpn --service', '/home/u/.config/nvpn/config.toml'),
    '/usr/bin/nvpn --service --config /home/u/.config/nvpn/config.toml',
  );
});

test('rewriteExecStartWithConfig: replaces an existing --config (idempotent)', () => {
  const once = rewriteExecStartWithConfig('/usr/bin/nvpn --service --config /old/path.toml', '/new/path.toml');
  assert.equal(once, '/usr/bin/nvpn --service --config /new/path.toml');
  // Applying again with the same target is a fixed point.
  assert.equal(rewriteExecStartWithConfig(once, '/new/path.toml'), once);
});

test('rewriteExecStartWithConfig: handles --config=VALUE form', () => {
  assert.equal(
    rewriteExecStartWithConfig('/usr/bin/nvpn --config=/old.toml --service', '/new.toml'),
    '/usr/bin/nvpn --service --config /new.toml',
  );
});

test('renderNvpnConfigDropIn: resets then sets ExecStart under [Service]', () => {
  const out = renderNvpnConfigDropIn('/usr/bin/nvpn --service --config /c.toml');
  assert.match(out, /\[Service\]/);
  // The empty reset line must precede our value (systemd single-value rule).
  assert.match(out, /ExecStart=\nExecStart=\/usr\/bin\/nvpn --service --config \/c\.toml/);
});

test('canonicalConfigInstallPath: is the user-home nvpn config, existence-independent', () => {
  assert.equal(
    canonicalConfigInstallPath(),
    path.join(os.homedir(), '.config', 'nvpn', 'config.toml'),
  );
});
