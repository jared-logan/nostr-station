import { test } from 'node:test';
import assert from 'node:assert/strict';

import { useTempHome } from './_home.js';
useTempHome();

// auth.ts imports identity.ts which resolves paths at load time. Pin HOME
// before the dynamic import even though these tests only exercise pure
// helpers (isLocalhost / isContainerMode), so the side-effect imports don't
// land on the real ~/.nostr-station.
// @ts-expect-error — runtime import of .ts; tsx handles the resolution
const auth = await import('../src/lib/auth.ts');

function fakeReq(remoteAddress: string): any {
  return { socket: { remoteAddress }, headers: {} };
}

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

test('isContainerMode: false by default', () => {
  withEnv('STATION_MODE', undefined, () => {
    assert.equal(auth.isContainerMode(), false);
  });
});

test('isContainerMode: true when STATION_MODE=container', () => {
  withEnv('STATION_MODE', 'container', () => {
    assert.equal(auth.isContainerMode(), true);
  });
});

test('isContainerMode: false for any other STATION_MODE value', () => {
  withEnv('STATION_MODE', 'host', () => {
    assert.equal(auth.isContainerMode(), false);
  });
});

test('isLocalhost: accepts 127.0.0.1 in normal mode', () => {
  withEnv('STATION_MODE', undefined, () => {
    assert.equal(auth.isLocalhost(fakeReq('127.0.0.1')), true);
  });
});

test('isLocalhost: accepts ::1 in normal mode', () => {
  withEnv('STATION_MODE', undefined, () => {
    assert.equal(auth.isLocalhost(fakeReq('::1')), true);
  });
});

test('isLocalhost: accepts ::ffff:127.0.0.1 (v4-mapped) in normal mode', () => {
  withEnv('STATION_MODE', undefined, () => {
    assert.equal(auth.isLocalhost(fakeReq('::ffff:127.0.0.1')), true);
  });
});

test('isLocalhost: rejects Docker bridge gateway in normal mode', () => {
  withEnv('STATION_MODE', undefined, () => {
    assert.equal(auth.isLocalhost(fakeReq('172.17.0.1')), false);
  });
});

test('isLocalhost: rejects arbitrary remote IP in normal mode', () => {
  withEnv('STATION_MODE', undefined, () => {
    assert.equal(auth.isLocalhost(fakeReq('203.0.113.5')), false);
  });
});

test('isLocalhost: trusts ANY source IP in container mode', () => {
  withEnv('STATION_MODE', 'container', () => {
    assert.equal(auth.isLocalhost(fakeReq('172.17.0.1')), true);
    assert.equal(auth.isLocalhost(fakeReq('10.0.0.5')), true);
    assert.equal(auth.isLocalhost(fakeReq('127.0.0.1')), true);
    // Trust boundary lives at the host port binding, not the container's
    // view of the socket — see the comment above isContainerMode().
  });
});

test('isLocalhost: missing remoteAddress falls back to non-localhost in normal mode', () => {
  withEnv('STATION_MODE', undefined, () => {
    assert.equal(auth.isLocalhost({ socket: {}, headers: {} } as any), false);
  });
});

test('isLocalhost: missing remoteAddress is still localhost in container mode', () => {
  withEnv('STATION_MODE', 'container', () => {
    assert.equal(auth.isLocalhost({ socket: {}, headers: {} } as any), true);
  });
});
