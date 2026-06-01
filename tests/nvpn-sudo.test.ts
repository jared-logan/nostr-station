import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_VERBS, ADMIN_HELPER, ADMIN_NVPN_BIN, ADMIN_LIB_DIR,
  renderAdminSudoers, renderAdminManifest, renderAdminHelperScript,
  buildAdminProvisionCommand,
} from '../src/lib/nvpn-sudo.ts';

// These tests encode the security properties of the root-owned, fixed-verb
// helper — i.e. the escalation tests it must refuse BY CONSTRUCTION:
//   (a) binary-swap   — grant points only at the root-owned helper, never a
//                       user-writable path; helper re-verifies the SHA.
//   (b) extra-args    — sudoers Cmnds are complete, no wildcards/trailing args.
//   (c) drop-in inject — helper takes zero user input; generates content itself.
// The script's runtime is exercised on the VM; here we assert its shape.

// ── sudoers grant ─────────────────────────────────────────────────────────
test('sudoers: references ONLY the root-owned helper path', () => {
  const s = renderAdminSudoers('alice');
  // Never grants the nvpn binary, systemctl, tee, or a cargo path directly.
  assert.ok(!/\/\.cargo\//.test(s), 'no cargo path');
  assert.ok(!s.includes(ADMIN_NVPN_BIN + ' '), 'does not grant nvpn directly');
  assert.ok(!/systemctl|tee|install-cli|\/bin\/sh/.test(s), 'no general commands');
  // Every Cmnd is the helper path + a verb.
  const rhs = s.split('NOPASSWD:')[1];
  for (const cmnd of rhs.split(',').map(c => c.trim()).filter(Boolean)) {
    assert.ok(cmnd.startsWith(ADMIN_HELPER + ' '), `cmnd uses helper path: ${cmnd}`);
  }
});

test('sudoers: each verb is a complete Cmnd — no wildcards, no trailing args (the install-cli gotcha)', () => {
  const s = renderAdminSudoers('alice');
  assert.ok(!s.includes('*'), 'no wildcards');
  const rhs = s.split('NOPASSWD:')[1];
  const cmnds = rhs.split(',').map(c => c.trim()).filter(Boolean);
  for (const cmnd of cmnds) {
    const rest = cmnd.slice((ADMIN_HELPER + ' ').length);
    // exactly one token after the helper path (the verb), nothing more
    assert.equal(rest.split(/\s+/).length, 1, `single verb, no extra args: "${cmnd}"`);
    assert.ok(ADMIN_VERBS.includes(rest as any), `known verb: ${rest}`);
  }
  // Coverage: a sudoers Cmnd exists for every verb (no privileged op left
  // needing broad sudo).
  assert.equal(cmnds.length, ADMIN_VERBS.length);
});

test('sudoers: helper lives in a root-owned system dir, not the user home', () => {
  assert.ok(ADMIN_HELPER.startsWith('/usr/local/lib/'), ADMIN_HELPER);
  assert.ok(ADMIN_LIB_DIR.startsWith('/usr/local/lib/'));
  assert.ok(ADMIN_NVPN_BIN.startsWith('/usr/local/bin/'), ADMIN_NVPN_BIN);
});

// ── helper script ─────────────────────────────────────────────────────────
test('helper: hard-fails on extra args and non-root, takes exactly one verb', () => {
  const h = renderAdminHelperScript();
  assert.match(h, /\[ "\$#" -eq 1 \]\s+\|\| die/, 'rejects != 1 arg');
  assert.match(h, /id -u.*-eq 0.*\|\| die/s, 'requires root');
  assert.match(h, /set -euo pipefail/);
  assert.match(h, /export PATH=/, 'sanitizes PATH');
});

test('helper: invokes only the root-owned binary, never the cargo copy', () => {
  const h = renderAdminHelperScript();
  assert.ok(!/\.cargo\/bin/.test(h), 'never references ~/.cargo/bin');
  assert.match(h, /NVPN_BIN=\/usr\/local\/bin\/nvpn/);
});

test('helper: re-verifies the staged tarball SHA before install (defeats binary-swap)', () => {
  const h = renderAdminHelperScript();
  assert.match(h, /sha256sum -c -.*die/s, 'sha256 check refuses on mismatch');
  assert.match(h, /MANIFEST/, 'reads the root-owned manifest for the pinned sha');
});

test('helper: derives user paths from SUDO_USER (not args/env-controlled input)', () => {
  const h = renderAdminHelperScript();
  assert.match(h, /real_user=\$\{SUDO_USER:-\}/);
  assert.match(h, /\[ -n "\$real_user" \] \|\| die/);
});

test('helper: snapshots the working binary and rolls back a failed install (#7)', () => {
  const h = renderAdminHelperScript();
  assert.match(h, /PREV_BIN/, 'keeps a previous-binary snapshot');
  assert.match(h, /rolled back/, 'rolls back on service-install failure');
});

test('helper: seeds the canonical config AS THE USER (not root) so b2 repoint has a target', () => {
  const h = renderAdminHelperScript();
  // Only seed when absent, and run init dropped to the invoking user so the
  // config is user-owned (a root-owned config would defeat b2).
  assert.match(h, /\[ ! -f "\$CANON_CONFIG" \]/, 'guards on absence');
  assert.match(h, /runuser -u "\$real_user".*init|su -s \/bin\/sh "\$real_user"/s, 'inits as the user, not root');
});

// ── manifest + provisioning ─────────────────────────────────────────────
test('manifest: emits shell-sourceable tag + per-target sha vars', () => {
  const m = renderAdminManifest('v4.0.48', { 'x86_64-unknown-linux-musl': 'abc123' });
  assert.match(m, /NVPN_TAG='v4\.0\.48'/);
  assert.match(m, /NVPN_SHA_x86_64_unknown_linux_musl='abc123'/);
});

test('provision command: validates with visudo before installing the rule, 0440', () => {
  const cmd = buildAdminProvisionCommand({ user: 'alice', tag: 'v4.0.48', shas: { 'x86_64-unknown-linux-musl': 'abc' } });
  const visudoAt = cmd.indexOf('visudo -cf');
  const installAt = cmd.indexOf(`install -m 0440 -o root -g root /tmp/nostr-station-nvpn.sudoers ${'/etc/sudoers.d/nostr-station-nvpn'}`);
  assert.ok(visudoAt > 0 && installAt > 0 && visudoAt < installAt, 'visudo -cf precedes sudoers install');
  // Helper installed root:root 0755 in a root-owned dir.
  assert.ok(cmd.includes('install -d -m 0755 -o root -g root /usr/local/lib/nostr-station'));
  assert.ok(cmd.includes('chmod 0755 /usr/local/lib/nostr-station/nvpn-admin'));
  // The full helper body is embedded so the user can review what runs as root.
  assert.ok(cmd.includes('#!/usr/bin/env bash'));
});
