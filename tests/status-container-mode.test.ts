import { test } from 'node:test';
import assert from 'node:assert/strict';

import { useTempHome } from './_home.js';
useTempHome();

// Status.tsx imports identity.ts which resolves paths at load time. Pin HOME
// before the dynamic import even though the pure helper we test
// (gatherStatusContainer) doesn't touch identity.
// @ts-expect-error — runtime import of .ts; tsx handles the resolution
const { gatherStatusContainer } = await import('../src/commands/Status.tsx');

const NOW = 1_700_000_000_000;  // fixed epoch for deterministic age math

const baseInputs = {
  relayUp:        false,
  heartbeatPath:  '/var/run/nostr-station/watchdog.heartbeat',
  heartbeatMtime: null as number | null,
  now:            NOW,
  relayHost:      'relay',
  relayPort:      8080,
};

function findRow(rows: any[], id: string): any {
  return rows.find((r: any) => r.id === id);
}

test('relay row: ok when port answers', () => {
  const rows = gatherStatusContainer({ ...baseInputs, relayUp: true });
  const r = findRow(rows, 'relay');
  assert.equal(r.state, 'ok');
  assert.equal(r.ok,    true);
  assert.match(r.value, /ws:\/\/relay:8080/);
});

test('relay row: warn when port silent (managed by docker compose)', () => {
  const rows = gatherStatusContainer({ ...baseInputs, relayUp: false });
  const r = findRow(rows, 'relay');
  assert.equal(r.state, 'warn');
  assert.equal(r.ok,    false);
  assert.match(r.value, /docker compose/);
});

test('watchdog row: err when no heartbeat file', () => {
  const rows = gatherStatusContainer({ ...baseInputs, heartbeatMtime: null });
  const w = findRow(rows, 'watchdog');
  assert.equal(w.state, 'err');
  assert.match(w.value, /no heartbeat/);
  assert.match(w.value, /watchdog container/);
});

test('watchdog row: ok when heartbeat is fresh (<10min)', () => {
  const rows = gatherStatusContainer({
    ...baseInputs,
    heartbeatMtime: NOW - 5 * 60 * 1000, // 5min old
  });
  const w = findRow(rows, 'watchdog');
  assert.equal(w.state, 'ok');
  assert.match(w.value, /5m ago/);
});

test('watchdog row: "just now" wording when heartbeat is <1min old', () => {
  const rows = gatherStatusContainer({
    ...baseInputs,
    heartbeatMtime: NOW - 30 * 1000,  // 30s old
  });
  const w = findRow(rows, 'watchdog');
  assert.equal(w.state, 'ok');
  assert.match(w.value, /just now/);
});

test('watchdog row: warn when heartbeat is stale (>10min)', () => {
  const rows = gatherStatusContainer({
    ...baseInputs,
    heartbeatMtime: NOW - 25 * 60 * 1000,  // 25min old
  });
  const w = findRow(rows, 'watchdog');
  assert.equal(w.state, 'warn');
  assert.match(w.value, /stale/);
  assert.match(w.value, /25m ago/);
});

test('watchdog row: ok exactly at the 10min boundary', () => {
  const rows = gatherStatusContainer({
    ...baseInputs,
    heartbeatMtime: NOW - 10 * 60 * 1000,
  });
  const w = findRow(rows, 'watchdog');
  // Inclusive: <= 10min is fresh. Pin this so future refactors don't drift.
  assert.equal(w.state, 'ok');
});

test('vpn row: collapses to "not applicable in container mode"', () => {
  const rows = gatherStatusContainer({ ...baseInputs });
  const v = findRow(rows, 'vpn');
  assert.equal(v.state, 'warn');
  assert.match(v.value, /not applicable/);
});

test('binary rows: warn when binaries map missing or all null (image-build gap)', () => {
  // Default `baseInputs` has no `binaries` field — represents the
  // pre-Phase-2.5 case where nothing is baked into the image. Dashboard
  // must surface this as actionable warn, not pretend it's fine.
  const rows = gatherStatusContainer({ ...baseInputs });
  for (const id of ['ngit', 'claude', 'nak', 'stacks']) {
    const row = findRow(rows, id);
    assert.equal(row.state, 'warn', `${id} should be warn when binary missing`);
    assert.match(row.value, /not installed in image/, `${id} value should mention image`);
    assert.equal(row.ok, false, `${id} ok must be false when missing`);
  }
});

test('binary rows: ok with version when --version output is present', () => {
  // Mirrors the runtime case after Phase 2.5: gatherStatus() shells the
  // four `<tool> --version` probes and feeds results in. The row's value
  // is the first line of the version output (claude-code prints multi-line
  // banners that we don't want cluttering the panel).
  const rows = gatherStatusContainer({
    ...baseInputs,
    binaries: {
      ngit:   'ngit 2.2.3',
      claude: '1.0.42 (Claude Code)\nadditional banner line',
      nak:    'v0.19.7',
      stacks: 'stacks 2.4.0',
    },
  });

  const ngit = findRow(rows, 'ngit');
  assert.equal(ngit.state, 'ok');
  assert.equal(ngit.ok,    true);
  assert.equal(ngit.value, 'ngit 2.2.3');

  const claude = findRow(rows, 'claude');
  assert.equal(claude.state, 'ok');
  assert.equal(claude.value, '1.0.42 (Claude Code)');  // first line only

  const nak = findRow(rows, 'nak');
  assert.equal(nak.state, 'ok');
  assert.equal(nak.value, 'v0.19.7');

  const stacks = findRow(rows, 'stacks');
  assert.equal(stacks.state, 'ok');
  assert.equal(stacks.value, 'stacks 2.4.0');
});

test('binary rows: empty/whitespace --version output treated as missing', () => {
  // Pin the contract: a tool that exits 0 but writes nothing useful is
  // still "missing" from the user's perspective — we'd rather flag than
  // show a blank green row.
  const rows = gatherStatusContainer({
    ...baseInputs,
    binaries: { ngit: '', claude: '   \n  ', nak: null, stacks: null },
  });
  for (const id of ['ngit', 'claude', 'nak', 'stacks']) {
    const row = findRow(rows, id);
    assert.equal(row.state, 'warn', `${id} should be warn for empty/null output`);
    assert.equal(row.ok,    false);
  }
});

test('relay-bin row: ok when relay container is up, warn otherwise', () => {
  const upRow = findRow(
    gatherStatusContainer({ ...baseInputs, relayUp: true }),
    'relay-bin',
  );
  assert.equal(upRow.state, 'ok');
  assert.match(upRow.value, /relay container/);

  const downRow = findRow(
    gatherStatusContainer({ ...baseInputs, relayUp: false }),
    'relay-bin',
  );
  assert.equal(downRow.state, 'warn');
});

test('row count and ids stable (dashboard depends on these)', () => {
  const rows = gatherStatusContainer({ ...baseInputs });
  const ids = rows.map((r: any) => r.id);
  assert.deepEqual(ids, [
    'relay', 'vpn', 'watchdog',
    'ngit', 'claude', 'nak', 'relay-bin', 'stacks',
  ]);
});
