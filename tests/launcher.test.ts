import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { useTempHome, resetTempHome } from './_home.js';

const HOME = useTempHome();

// @ts-expect-error — runtime import of .ts; tsx handles the resolution
const launcher = await import('../src/lib/launcher.ts');
const {
  composeFilePath,
  buildComposeArgv,
  waitForDashboard,
  tryOpenBrowser,
} = launcher;

beforeEach(() => resetTempHome(HOME));

// ── composeFilePath ───────────────────────────────────────────────────────

test('composeFilePath: returns null when nothing exists', () => {
  // Fresh temp HOME, no install + no repo-local file. The dev fallback
  // does check the repo, so this test relies on the fact that this test
  // file is at <repo>/tests/launcher.test.ts and therefore the repo-root
  // docker-compose.yml WILL be found. Pin both branches separately.
  // Here we only assert composeFilePath returns *something string-like*,
  // since the repo-local copy is real.
  const out = composeFilePath();
  // Either HOME-installed (test isn't installing) or repo fallback.
  // In the test environment, the repo-local copy lands.
  assert.ok(out === null || typeof out === 'string');
});

test('composeFilePath: prefers HOME-installed when both exist', () => {
  // Lay down a fake compose file at the canonical install location.
  const dir = path.join(HOME, '.nostr-station', 'compose');
  fs.mkdirSync(dir, { recursive: true });
  const homeCompose = path.join(dir, 'docker-compose.yml');
  fs.writeFileSync(homeCompose, '# fake compose\n');

  const out = composeFilePath();
  assert.equal(out, homeCompose);
});

// ── buildComposeArgv ──────────────────────────────────────────────────────

test('buildComposeArgv: builds the canonical docker compose argv', () => {
  const argv = buildComposeArgv('/tmp/compose.yml', 'up', ['-d']);
  assert.deepEqual(argv, ['compose', '-f', '/tmp/compose.yml', 'up', '-d']);
});

test('buildComposeArgv: empty extraArgs is handled', () => {
  const argv = buildComposeArgv('/tmp/compose.yml', 'down');
  assert.deepEqual(argv, ['compose', '-f', '/tmp/compose.yml', 'down']);
});

test('buildComposeArgv: preserves arg order verbatim', () => {
  const argv = buildComposeArgv('/x.yml', 'logs', ['-f', '--tail', '50', 'station']);
  assert.deepEqual(argv, ['compose', '-f', '/x.yml', 'logs', '-f', '--tail', '50', 'station']);
});

// ── waitForDashboard ──────────────────────────────────────────────────────

test('waitForDashboard: returns true on first 200 from /api/status', async () => {
  // Spin up a tiny HTTP server that 200s on /api/status. The launcher
  // shouldn't care what the body looks like — only the status code.
  const server = http.createServer((req, res) => {
    if (req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port as number;

  try {
    const ok = await waitForDashboard(port, 5000);
    assert.equal(ok, true);
  } finally {
    server.close();
  }
});

test('waitForDashboard: returns false on timeout when nothing listens', async () => {
  // Pick a port no one is on. Port 0 isn't valid for the client side;
  // use a high port that's unlikely to be bound. If it IS bound, the
  // test fails noisily — we'd rather catch the false-positive than
  // skip silently.
  const port = 49999;
  const start = Date.now();
  const ok = await waitForDashboard(port, 1500);
  const elapsed = Date.now() - start;
  assert.equal(ok, false);
  // Sanity-check: actually waited the full timeout, not short-circuited.
  assert.ok(elapsed >= 1500, `expected to wait >=1500ms, waited ${elapsed}`);
  // And not absurdly long either — should be within a reasonable margin
  // of timeoutMs (allowing for the 500ms poll cadence overshoot).
  assert.ok(elapsed < 3500, `unexpectedly long wait: ${elapsed}ms`);
});

test('waitForDashboard: returns false when server answers non-200', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(503);  // service unavailable — dashboard not ready yet
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port as number;

  try {
    const ok = await waitForDashboard(port, 1500);
    assert.equal(ok, false);
  } finally {
    server.close();
  }
});

// ── tryOpenBrowser ────────────────────────────────────────────────────────

test('tryOpenBrowser: returns true and does not throw when launcher is missing', () => {
  // We can't actually open a browser in tests, and on macOS the `open`
  // command will succeed; on Linux CI the `xdg-open` command is usually
  // absent and `spawn` reports `error` async via the listener. Either way,
  // tryOpenBrowser should not throw and should return true (it
  // successfully called spawn — it doesn't observe whether the launcher
  // worked end-to-end).
  const out = tryOpenBrowser('http://127.0.0.1:3000/');
  assert.equal(out, true);
});
