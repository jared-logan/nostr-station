import { test } from 'node:test';
import assert from 'node:assert/strict';

import { useTempHome } from './_home.js';
useTempHome();

// authStatus depends on identity.ts which resolves paths at load time.
// Pin HOME first; auth import drags in the path module-level constants.
// @ts-expect-error — runtime import of .ts; tsx handles the resolution
const auth = await import('../src/lib/auth.ts');

function fakeReq(): any {
  return { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
}

function withEnv(entries: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(entries)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(entries)) {
      if (v === undefined) delete process.env[k];
      else                 process.env[k] = v;
    }
    fn();
  } finally {
    for (const k of Object.keys(entries)) {
      if (prev[k] === undefined) delete process.env[k];
      else                       process.env[k] = prev[k];
    }
  }
}

test('authStatus: inprocRelay = true by default (host-Node deployment)', () => {
  withEnv({ STATION_MODE: undefined, STATION_INPROC_RELAY: undefined }, () => {
    const s = auth.authStatus(fakeReq());
    assert.equal(s.inprocRelay, true);
    assert.equal(s.containerMode, false);
  });
});

test('authStatus: inprocRelay = false when STATION_INPROC_RELAY=0 (explicit opt-out)', () => {
  withEnv({ STATION_MODE: undefined, STATION_INPROC_RELAY: '0' }, () => {
    const s = auth.authStatus(fakeReq());
    assert.equal(s.inprocRelay, false);
  });
});

test('authStatus: inprocRelay = false in container mode (sibling Docker relay handles it)', () => {
  withEnv({ STATION_MODE: 'container', STATION_INPROC_RELAY: undefined }, () => {
    const s = auth.authStatus(fakeReq());
    assert.equal(s.inprocRelay, false);
    assert.equal(s.containerMode, true);
  });
});

test('authStatus: container mode wins over STATION_INPROC_RELAY=1 (container relay always preferred)', () => {
  withEnv({ STATION_MODE: 'container', STATION_INPROC_RELAY: '1' }, () => {
    const s = auth.authStatus(fakeReq());
    assert.equal(s.inprocRelay, false);
    assert.equal(s.containerMode, true);
  });
});
