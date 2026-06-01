import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeConfigTextSync } from '../src/lib/nvpn.ts';

// writeConfigTextSync is the sync sibling routed under the 4 config mutators
// (network-id setter, repair, relay/alias mutators) in stage 3. The
// owned-file path (atomic temp-rename + optional backup) is unit-testable;
// the root-owned `sudo -n install` path needs a real root file + sudo cred
// cache, so it's exercised on the VM, not here.

function freshConfig(): { dir: string; p: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvpn-writesync-'));
  const p = path.join(dir, 'config.toml');
  fs.writeFileSync(p, 'old = true\n', 'utf8');
  return { dir, p };
}

test('writeConfigTextSync: owned file, backup:false -> writes, no .bak, mode 0600', () => {
  const { dir, p } = freshConfig();
  try {
    const r = writeConfigTextSync(p, 'new = 1\n', { rootOwned: false, backup: false });
    assert.equal(r.ok, true);
    assert.equal(r.backedUpTo, undefined);
    assert.equal(fs.readFileSync(p, 'utf8'), 'new = 1\n');
    // no backup littered next to it
    const baks = fs.readdirSync(dir).filter(f => f.includes('.bak-'));
    assert.deepEqual(baks, []);
    // 0600 perms on the written file
    assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeConfigTextSync: owned file, backup:true -> writes AND leaves one .bak with prior contents', () => {
  const { dir, p } = freshConfig();
  try {
    const r = writeConfigTextSync(p, 'new = 2\n', { rootOwned: false, backup: true });
    assert.equal(r.ok, true);
    assert.ok(r.backedUpTo && r.backedUpTo.includes('.bak-'), 'backedUpTo should be reported');
    assert.equal(fs.readFileSync(p, 'utf8'), 'new = 2\n');
    assert.equal(fs.readFileSync(r.backedUpTo!, 'utf8'), 'old = true\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeConfigTextSync: no temp file is left behind on success', () => {
  const { dir, p } = freshConfig();
  try {
    writeConfigTextSync(p, 'x = 1\n', { rootOwned: false, backup: false });
    const tmps = fs.readdirSync(dir).filter(f => f.includes('.tmp-'));
    assert.deepEqual(tmps, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writeConfigTextSync: empty path -> ok:false, nothing written', () => {
  const r = writeConfigTextSync('', 'x', { rootOwned: false });
  assert.equal(r.ok, false);
});
