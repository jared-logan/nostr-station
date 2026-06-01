import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nvpnSudoersCommands,
  renderNvpnSudoersLine,
  buildSudoersInstallCommand,
} from '../src/lib/nvpn-sudo.ts';

// Pure renderers for the OPTIONAL permanent sudoers grant. The interactive
// warmSudoCache/sudoState paths shell out to sudo and are exercised on the
// VM, not here.

const BIN = '/home/u/.cargo/bin/nvpn';

test('nvpnSudoersCommands: scoped to fixed nvpn + systemctl argv, never blanket', () => {
  const cmds = nvpnSudoersCommands(BIN);
  // Must NOT contain a blanket `nvpn *` (root-equivalent via service install --config).
  assert.ok(!cmds.some(c => /nvpn\s*\*/.test(c)), 'no wildcard nvpn command');
  // Covers the lifecycle the dashboard actually needs.
  assert.ok(cmds.includes(`${BIN} install-cli`));
  assert.ok(cmds.includes(`${BIN} service install`));
  assert.ok(cmds.includes(`${BIN} service uninstall`));
  assert.ok(cmds.includes(`${BIN} uninstall-cli`));
  assert.ok(cmds.some(c => c.endsWith('systemctl restart nvpn.service')));
  // Every entry is a concrete command path, no shell metacharacters.
  for (const c of cmds) assert.ok(!/[;&|`$]/.test(c), `no shell metachars in: ${c}`);
});

test('renderNvpnSudoersLine: well-formed NOPASSWD line for the user', () => {
  const line = renderNvpnSudoersLine('alice', BIN);
  assert.match(line, /^alice ALL=\(root\) NOPASSWD: /);
  assert.ok(line.includes(`${BIN} install-cli`));
  // comma-separated command list
  assert.ok(line.split(', ').length === nvpnSudoersCommands(BIN).length);
});

test('buildSudoersInstallCommand: validates with visudo before installing', () => {
  const cmd = buildSudoersInstallCommand('alice', BIN);
  // Must validate before placing the file — a typo can never corrupt sudo.
  assert.ok(cmd.includes('visudo -cf'), 'runs visudo -cf');
  const visudoAt = cmd.indexOf('visudo -cf');
  const installAt = cmd.indexOf('/etc/sudoers.d/nostr-station-nvpn');
  assert.ok(visudoAt < installAt, 'visudo check precedes the install into sudoers.d');
  assert.ok(cmd.includes('-m 0440'), 'installs 0440');
});

test('buildSudoersInstallCommand: defaults user/bin without throwing', () => {
  const cmd = buildSudoersInstallCommand();
  assert.ok(cmd.includes('/etc/sudoers.d/nostr-station-nvpn'));
});
