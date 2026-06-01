import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { recentPeersCandidatePaths, NVPN_LINK_CEILING } from '../src/lib/nvpn.ts';

// recentPeersCandidatePaths is the pure target list for the peer-state
// reset. The stop/clear/start orchestration shells out and is VM-verified.

test('recentPeersCandidatePaths: includes the user config dir, de-duplicated', () => {
  const paths = recentPeersCandidatePaths();
  const userPath = path.join(os.homedir(), '.config', 'nvpn', 'daemon.recent-peers.json');
  assert.ok(paths.includes(userPath), 'user-home candidate present');
  // every entry names the recent-peers cache file
  for (const p of paths) assert.ok(p.endsWith('daemon.recent-peers.json'), p);
  // no duplicates
  assert.equal(new Set(paths).size, paths.length);
});

test('recentPeersCandidatePaths: covers the root daemon default too', () => {
  assert.ok(recentPeersCandidatePaths().includes('/root/.config/nvpn/daemon.recent-peers.json'));
});

test('NVPN_LINK_CEILING matches the daemon hard limit', () => {
  assert.equal(NVPN_LINK_CEILING, 256);
});
