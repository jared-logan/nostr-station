import { test } from 'node:test';
import assert from 'node:assert/strict';

// verify.ts has no module-load-time path resolution, so we can use a static
// import here. (Other tests use dynamic imports because they have to pin
// HOME first — not applicable for the pure check function.)
// @ts-expect-error — runtime import of .ts; tsx handles the resolution
import { runChecksContainer } from '../src/lib/verify.ts';

const NOW = 1_700_000_000_000;

const baseInputs = {
  relayUp:        false,
  nip11Ok:        false,
  heartbeatMtime: null as number | null,
  now:            NOW,
  relayHost:      'relay',
  relayPort:      8080,
  binaries: {
    ngit:   null as string | null,
    claude: null as string | null,
    nak:    null as string | null,
    stacks: null as string | null,
  },
};

function findCheck(rows: ReturnType<typeof runChecksContainer>, label: string) {
  const row = rows.find(r => r.label === label);
  assert.ok(row, `expected a check labelled "${label}"`);
  return row!;
}

test('relay row label encodes host:port from inputs', () => {
  const rows = runChecksContainer({ ...baseInputs, relayHost: 'relay', relayPort: 8080 });
  findCheck(rows, 'Relay (relay:8080)');

  const rows2 = runChecksContainer({ ...baseInputs, relayHost: 'foo.internal', relayPort: 9000 });
  findCheck(rows2, 'Relay (foo.internal:9000)');
});

test('relay row: ok mirrors relayUp', () => {
  const up   = findCheck(runChecksContainer({ ...baseInputs, relayUp: true }),  'Relay (relay:8080)');
  const down = findCheck(runChecksContainer({ ...baseInputs, relayUp: false }), 'Relay (relay:8080)');
  assert.equal(up.ok,   true);
  assert.equal(down.ok, false);
});

test('watchdog: fail when no heartbeat file (mtime null)', () => {
  const rows = runChecksContainer({ ...baseInputs, heartbeatMtime: null });
  assert.equal(findCheck(rows, 'Watchdog heartbeat').ok, false);
});

test('watchdog: ok when heartbeat is fresh (<10min)', () => {
  const rows = runChecksContainer({
    ...baseInputs,
    heartbeatMtime: NOW - 5 * 60 * 1000,
  });
  assert.equal(findCheck(rows, 'Watchdog heartbeat').ok, true);
});

test('watchdog: ok at the 10min boundary inclusive', () => {
  // Mirrors the inclusive boundary in status-container-mode tests so the two
  // surfaces don't drift on freshness semantics.
  const rows = runChecksContainer({
    ...baseInputs,
    heartbeatMtime: NOW - 10 * 60 * 1000,
  });
  assert.equal(findCheck(rows, 'Watchdog heartbeat').ok, true);
});

test('watchdog: fail when heartbeat is stale (>10min)', () => {
  const rows = runChecksContainer({
    ...baseInputs,
    heartbeatMtime: NOW - 11 * 60 * 1000,
  });
  assert.equal(findCheck(rows, 'Watchdog heartbeat').ok, false);
});

test('binary rows: fail when --version output is null', () => {
  const rows = runChecksContainer({ ...baseInputs });
  for (const label of ['ngit binary', 'claude-code binary', 'nak binary', 'stacks binary']) {
    assert.equal(findCheck(rows, label).ok, false, `${label} should fail when null`);
  }
});

test('binary rows: ok when --version emits non-empty output', () => {
  const rows = runChecksContainer({
    ...baseInputs,
    binaries: {
      ngit:   'ngit 2.2.3',
      claude: '1.0.42 (Claude Code)',
      nak:    'v0.19.7',
      stacks: 'stacks 2.4.0',
    },
  });
  for (const label of ['ngit binary', 'claude-code binary', 'nak binary', 'stacks binary']) {
    assert.equal(findCheck(rows, label).ok, true, `${label} should pass`);
  }
});

test('binary rows: empty/whitespace --version is treated as missing', () => {
  // Pin parity with status-container-mode: a tool that exits 0 but writes
  // nothing useful is still "missing" from the user's perspective.
  const rows = runChecksContainer({
    ...baseInputs,
    binaries: { ngit: '', claude: '   \n  ', nak: null, stacks: null },
  });
  for (const label of ['ngit binary', 'claude-code binary', 'nak binary', 'stacks binary']) {
    assert.equal(findCheck(rows, label).ok, false, `${label} should fail`);
  }
});

test('NIP-11 row: ok mirrors nip11Ok flag', () => {
  const okRow   = findCheck(runChecksContainer({ ...baseInputs, nip11Ok: true }),  'Relay NIP-11 response');
  const failRow = findCheck(runChecksContainer({ ...baseInputs, nip11Ok: false }), 'Relay NIP-11 response');
  assert.equal(okRow.ok,   true);
  assert.equal(failRow.ok, false);
});

test('host-mode-only labels are NOT present in container output', () => {
  // The container probe set must not include nvpn (not supportable inside an
  // unprivileged container) or the host nostr-rs-relay binary (lives in a
  // sibling container). If these labels reappear here, doctor will start
  // emitting false failures the dashboard correctly hides.
  const rows = runChecksContainer({ ...baseInputs });
  const labels = rows.map(r => r.label);
  assert.ok(!labels.includes('nostr-vpn daemon'), 'nvpn check leaked into container mode');
  assert.ok(!labels.includes('nostr-rs-relay binary'), 'host relay-bin check leaked');
});

test('check ordering and labels are stable (dashboard depends on these)', () => {
  const rows = runChecksContainer({ ...baseInputs });
  assert.deepEqual(
    rows.map(r => r.label),
    [
      'Relay (relay:8080)',
      'Watchdog heartbeat',
      'ngit binary',
      'claude-code binary',
      'nak binary',
      'stacks binary',
      'Relay NIP-11 response',
    ],
  );
});
