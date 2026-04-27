import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure module — no HOME setup needed. nvpnStateFor only consumes its
// argument; all I/O lives in gatherStatus and is intentionally NOT tested
// here (those probes are integration territory).
// @ts-expect-error — runtime import of .tsx
const { nvpnStateFor } = await import('../src/commands/Status.tsx');

// ── err: binary missing ───────────────────────────────────────────────────

test('nvpnStateFor: binary missing → err / "not installed"', () => {
  const r = nvpnStateFor({ binPresent: false, serviceLoaded: false, meshIp: null });
  assert.equal(r.state, 'err');
  assert.equal(r.value, 'not installed');
  assert.equal(r.ok, false);
});

test('nvpnStateFor: binary missing, ignore other fields (state machine is binary-gated)', () => {
  // Belt-and-suspenders: even if upstream state is somehow inconsistent
  // (serviceLoaded=true but binPresent=false — shouldn't happen, but the
  // probe could theoretically race), the err branch wins. Pinning so a
  // future cascade refactor can't accidentally bypass the binary check.
  const r = nvpnStateFor({ binPresent: false, serviceLoaded: true, meshIp: '10.0.0.1' });
  assert.equal(r.state, 'err');
  assert.equal(r.value, 'not installed');
});

// ── warn: A4's new sub-state ──────────────────────────────────────────────

test('nvpnStateFor: binary present, service NOT loaded → warn with sudo hint', () => {
  // The case A4 closes — binary downloaded into ~/.cargo/bin, but
  // `sudo nvpn service install` was skipped (TUI couldn't pre-auth on
  // Linux). Pre-A4 this collapsed into "not connected" alongside the
  // mesh-not-connected case; now the message tells the user exactly
  // which command they need.
  const r = nvpnStateFor({ binPresent: true, serviceLoaded: false, meshIp: null });
  assert.equal(r.state, 'warn');
  assert.equal(r.ok, false);
  // Actionable signal — copy-paste the command verbatim.
  assert.match(r.value, /sudo nvpn service install/);
  // And distinct from the legacy "not connected" so users (and any
  // dashboard text-match logic) can tell the two warn shapes apart.
  assert.notEqual(r.value, 'not connected');
});

test('nvpnStateFor: service-not-loaded warn beats stale meshIp from a previous session', () => {
  // If the binary is reinstalled or the service unit removed while the
  // last-cached meshIp is non-null, the "service not loaded" branch must
  // still fire — service-loaded is a precondition for the meshIp signal
  // to even be meaningful.
  const r = nvpnStateFor({ binPresent: true, serviceLoaded: false, meshIp: '10.0.0.1' });
  assert.equal(r.state, 'warn');
  assert.match(r.value, /sudo nvpn service install/);
});

// ── ok: mesh connected ────────────────────────────────────────────────────

test('nvpnStateFor: binary + service + mesh up → ok / tunnel IP', () => {
  const r = nvpnStateFor({
    binPresent: true, serviceLoaded: true, meshIp: '10.42.0.7',
  });
  assert.equal(r.state, 'ok');
  assert.equal(r.value, '10.42.0.7');
  assert.equal(r.ok, true);
});

// ── warn: legacy "not connected" — service loaded but no mesh ─────────────

test('nvpnStateFor: service loaded but mesh down → warn / "not connected"', () => {
  // The peer-down / firewall-blocking-WireGuard case. Distinct from the
  // A4 sub-state above — value MUST NOT mention `sudo nvpn service install`
  // because the service is already loaded; running it again is a no-op
  // dressed up as a recovery hint, which would be misleading.
  const r = nvpnStateFor({
    binPresent: true, serviceLoaded: true, meshIp: null,
  });
  assert.equal(r.state, 'warn');
  assert.equal(r.value, 'not connected');
  assert.doesNotMatch(r.value, /sudo nvpn service install/);
});

// ── meshIp empty string is treated as falsy (matches `nvpn status --json`) ─

test('nvpnStateFor: empty-string meshIp falls through to the warn branch', () => {
  // Defensive — `JSON.parse(out)?.tunnel_ip ?? null` could in principle
  // surface "" if upstream changes the daemon's reply shape. Empty string
  // is not a valid IP and shouldn't flip the row green.
  const r = nvpnStateFor({
    binPresent: true, serviceLoaded: true, meshIp: '',
  });
  assert.equal(r.state, 'warn');
  assert.equal(r.value, 'not connected');
});
