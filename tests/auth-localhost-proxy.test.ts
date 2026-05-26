import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { useTempHome } from './_home.js';
useTempHome();

// @ts-expect-error — runtime .ts import; tsx handles resolution
const { isLocalhost, localhostExempt } = await import('../src/lib/auth.ts');

// Guards a real security hole: with `requireAuth:false` (a documented
// opt-out in identity.json) the dashboard skips auth for loopback requests.
// If a same-host reverse proxy (nginx, Caddy, cloudflared) is publishing
// the dashboard, every external request arrives from `127.0.0.1` from the
// app's perspective. Without this gate, "loopback-only opt-out" would
// silently mean "open to the internet". The DNS-rebinding Host gate
// elsewhere doesn't catch it because the proxy rewrites Host.

function fakeReq(remoteAddress: string, headers: Record<string, string> = {}): http.IncomingMessage {
  return { socket: { remoteAddress }, headers } as unknown as http.IncomingMessage;
}

test('isLocalhost: bare loopback request is localhost', () => {
  assert.equal(isLocalhost(fakeReq('127.0.0.1')), true);
  assert.equal(isLocalhost(fakeReq('::1')),       true);
  assert.equal(isLocalhost(fakeReq('::ffff:127.0.0.1')), true);
});

test('isLocalhost: non-loopback remoteAddress is never localhost', () => {
  assert.equal(isLocalhost(fakeReq('1.2.3.4')), false);
  assert.equal(isLocalhost(fakeReq('')), false);
});

test('isLocalhost: proxy-forwarded request is NOT localhost', () => {
  // Same-host reverse proxy connects from 127.0.0.1 but adds these
  // headers to identify the real client. Refuse the loopback label.
  assert.equal(isLocalhost(fakeReq('127.0.0.1', { 'x-forwarded-for': '8.8.8.8' })), false);
  assert.equal(isLocalhost(fakeReq('127.0.0.1', { 'x-real-ip': '8.8.8.8' })),        false);
  assert.equal(isLocalhost(fakeReq('127.0.0.1', { 'x-forwarded-host': 'evil.example.com' })), false);
  assert.equal(isLocalhost(fakeReq('127.0.0.1', { 'x-forwarded-proto': 'https' })),  false);
  assert.equal(isLocalhost(fakeReq('127.0.0.1', { 'forwarded': 'for=8.8.8.8' })),    false);
});

test('isLocalhost: STATION_TRUST_PROXY=1 re-enables the loopback label behind a proxy', () => {
  process.env.STATION_TRUST_PROXY = '1';
  try {
    assert.equal(isLocalhost(fakeReq('127.0.0.1', { 'x-forwarded-for': '8.8.8.8' })), true);
  } finally {
    delete process.env.STATION_TRUST_PROXY;
  }
});

test('localhostExempt: proxied request never gets the no-auth exemption', () => {
  // No identity.json on disk in this temp home → ident.npub is falsy →
  // localhostExempt would normally return true (fresh-install case).
  // But a proxy-forwarded request must NOT get that exemption, otherwise
  // a same-host reverse proxy bridges the open install window to the
  // public internet.
  assert.equal(localhostExempt(fakeReq('127.0.0.1', { 'x-forwarded-for': '8.8.8.8' })), false);
  // Bare loopback request in the same fresh state IS exempt — sanity check.
  assert.equal(localhostExempt(fakeReq('127.0.0.1')), true);
});
