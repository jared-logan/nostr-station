import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfigTextSync } from '../src/lib/nvpn.ts';

// readConfigTextSync is the sync sibling routed under the 5 read helpers in
// stage 2. The direct-fs path + degrade-to-null behavior is unit-testable;
// the `sudo -n cat` fallback needs a real root-owned file + sudo, so it's
// exercised on the VM, not here.

test('readConfigTextSync: returns file contents on a readable file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvpn-readsync-'));
  const p = path.join(dir, 'config.toml');
  const body = '[nostr]\npublic_key = "npub1example"\n';
  fs.writeFileSync(p, body, 'utf8');
  try {
    assert.equal(readConfigTextSync(p), body);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readConfigTextSync: empty path -> null (no read attempted)', () => {
  assert.equal(readConfigTextSync(''), null);
});

test('readConfigTextSync: missing file degrades to null, never throws', () => {
  // No sudo cred cache in CI -> the sudo -n fallback also fails -> null.
  const p = path.join(os.tmpdir(), `nvpn-does-not-exist-${Date.now()}.toml`);
  assert.doesNotThrow(() => readConfigTextSync(p));
  assert.equal(readConfigTextSync(p), null);
});
