import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WhitelistStore } from '../src/relay/whitelist-store.ts';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-wl-'));
  return path.join(dir, 'whitelist.json');
}

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const HEX_C = 'c'.repeat(64);

test('whitelist: starts empty when file does not exist', () => {
  const w = new WhitelistStore(tmpFile());
  assert.deepEqual(w.list(), []);
  assert.equal(w.has(HEX_A), false);
});

test('whitelist: add returns true for new entry, false for duplicate', () => {
  const w = new WhitelistStore(tmpFile());
  assert.equal(w.add(HEX_A), true);
  assert.equal(w.add(HEX_A), false);
  assert.deepEqual(w.list(), [HEX_A]);
});

test('whitelist: remove returns true when present, false when absent', () => {
  const w = new WhitelistStore(tmpFile());
  w.add(HEX_A);
  assert.equal(w.remove(HEX_A), true);
  assert.equal(w.remove(HEX_A), false);
  assert.deepEqual(w.list(), []);
});

test('whitelist: list output is sorted', () => {
  const w = new WhitelistStore(tmpFile());
  w.add(HEX_C);
  w.add(HEX_A);
  w.add(HEX_B);
  assert.deepEqual(w.list(), [HEX_A, HEX_B, HEX_C]);
});

test('whitelist: persists across reinstantiation', () => {
  const file = tmpFile();
  const w1 = new WhitelistStore(file);
  w1.add(HEX_A);
  w1.add(HEX_B);
  const w2 = new WhitelistStore(file);
  assert.deepEqual(w2.list(), [HEX_A, HEX_B]);
  assert.equal(w2.has(HEX_A), true);
  assert.equal(w2.has(HEX_B), true);
});

test('whitelist: rejects malformed pubkeys on load', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    pubkeys: [HEX_A, 'not-hex', '', 'too-short', HEX_B],
    updatedAt: Date.now(),
  }));
  const w = new WhitelistStore(file);
  assert.deepEqual(w.list(), [HEX_A, HEX_B]);
});

test('whitelist: case-insensitive lookup, normalizes to lowercase', () => {
  const w = new WhitelistStore(tmpFile());
  const upper = HEX_A.toUpperCase();
  w.add(upper);
  assert.equal(w.has(upper), true);
  assert.equal(w.has(HEX_A), true);
  assert.deepEqual(w.list(), [HEX_A]);
});

test('whitelist: handles missing file gracefully (no crash on first save)', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ns-wl-')), 'sub', 'whitelist.json');
  const w = new WhitelistStore(file);
  w.add(HEX_A);
  assert.ok(fs.existsSync(file));
  const w2 = new WhitelistStore(file);
  assert.deepEqual(w2.list(), [HEX_A]);
});
