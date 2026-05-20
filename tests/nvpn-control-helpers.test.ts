import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'dgram';
import {
  clampInt,
  isSettableNvpnKey,
  renderLinuxCapsDropIn,
  isUdpPortFree,
  pickFreeMagicDnsPort,
  classifyNvpnLogLine,
} from '../src/lib/nvpn.ts';

// ── clampInt ──────────────────────────────────────────────────────────

test('clampInt: in-range value returns floor', () => {
  assert.equal(clampInt(3, 1, 10, 5), 3);
  assert.equal(clampInt(3.7, 1, 10, 5), 3);  // floor, not round
});

test('clampInt: clamps to bounds', () => {
  assert.equal(clampInt(0, 1, 10, 5), 1);
  assert.equal(clampInt(99, 1, 10, 5), 10);
});

test('clampInt: non-numeric returns fallback', () => {
  assert.equal(clampInt('abc', 1, 10, 5), 5);
  assert.equal(clampInt(undefined, 1, 10, 5), 5);
  assert.equal(clampInt(null, 1, 10, 5), 5);
  assert.equal(clampInt(NaN, 1, 10, 5), 5);
  assert.equal(clampInt(Infinity, 1, 10, 5), 5);
});

test('clampInt: numeric strings are accepted', () => {
  assert.equal(clampInt('7', 1, 10, 5), 7);
});

// ── isSettableNvpnKey ─────────────────────────────────────────────────

test('isSettableNvpnKey: known nvpn-set keys', () => {
  // Curated subset of `nvpn set --<key>` flags. Add cases here when the
  // allowlist grows in src/lib/nvpn.ts. `relay-for-others`,
  // `provide-nat-assist`, and `magic-dns-port` were removed in
  // nvpn 4.x and are no longer settable.
  for (const k of ['node-name', 'listen-port', 'autoconnect',
                   'advertise-exit-node', 'advertise-routes',
                   'exit-node-leak-protection', 'magic-dns-suffix',
                   'tunnel-ip', 'endpoint', 'exit-node',
                   'network-id']) {
    assert.equal(isSettableNvpnKey(k), true, `expected ${k} to be settable`);
  }
});

test('isSettableNvpnKey: nvpn-4.x removals are no longer settable', () => {
  // These three flags vanished from `nvpn set` in the FIPS-mesh
  // redesign. If a future upstream brings any of them back, restore
  // them in SETTABLE_KEYS (and add them to the test above).
  for (const removed of ['relay-for-others', 'provide-nat-assist', 'magic-dns-port']) {
    assert.equal(isSettableNvpnKey(removed), false,
      `${removed} should not be settable on nvpn 4.x`);
  }
});

test('isSettableNvpnKey: unknown / dangerous keys are rejected', () => {
  // Things we don't allow the dashboard to mutate via /api/nvpn/set:
  assert.equal(isSettableNvpnKey('private-key'), false);
  assert.equal(isSettableNvpnKey('secret-key'),  false);
  assert.equal(isSettableNvpnKey('config'),      false);
  assert.equal(isSettableNvpnKey(''),            false);
  // Underscore form (TOML key) — must use the kebab-case CLI flag form.
  assert.equal(isSettableNvpnKey('node_name'),   false);
});

// ── renderLinuxCapsDropIn ─────────────────────────────────────────────
// The drop-in is what lets the nvpn daemon flush the kernel route cache
// (CAP_DAC_OVERRIDE for /proc/sys/net/ipv4/route/flush) and run its NAT
// probes (CAP_NET_RAW) without surfacing permission-denied lines in the
// log panel on every connect. Pin the systemd-readable shape so a stray
// edit doesn't break the unit silently.

test('renderLinuxCapsDropIn: contains [Service] section header', () => {
  assert.match(renderLinuxCapsDropIn(), /^\[Service\]$/m);
});

test('renderLinuxCapsDropIn: grants the three caps nvpn needs', () => {
  const out = renderLinuxCapsDropIn();
  for (const cap of ['CAP_NET_ADMIN', 'CAP_DAC_OVERRIDE', 'CAP_NET_RAW']) {
    assert.match(out, new RegExp(`AmbientCapabilities=[^\\n]*${cap}`),
                 `AmbientCapabilities missing ${cap}`);
    assert.match(out, new RegExp(`CapabilityBoundingSet=[^\\n]*${cap}`),
                 `CapabilityBoundingSet missing ${cap}`);
  }
});

test('renderLinuxCapsDropIn: ends with a newline (systemd-friendly)', () => {
  assert.ok(renderLinuxCapsDropIn().endsWith('\n'),
            'drop-in must end with a newline');
});

// ── isUdpPortFree / pickFreeMagicDnsPort ──────────────────────────────
// These run for real against the loopback interface — fast (sub-ms per
// bind), deterministic, and the only way to validate the probe without
// mocking dgram. We use very-high ports we know are vacant on CI/dev
// boxes; if a port happens to be taken the test re-tries with the
// next candidate, mirroring the production logic.

test('isUdpPortFree: returns true for an unused high port', async () => {
  // 49152+ is the dynamic/private range — vanishingly low chance of
  // collision in a test context.
  assert.equal(await isUdpPortFree(54321), true);
});

test('isUdpPortFree: returns false when a socket holds the port', async () => {
  const holder = dgram.createSocket('udp4');
  await new Promise<void>((resolve) => {
    holder.bind({ port: 54322, address: '127.0.0.1', exclusive: true }, () => resolve());
  });
  try {
    assert.equal(await isUdpPortFree(54322), false);
  } finally {
    holder.close();
  }
});

test('pickFreeMagicDnsPort: returns the first free candidate', async () => {
  // Hold the first two candidates so the function has to skip past them.
  const a = dgram.createSocket('udp4');
  const b = dgram.createSocket('udp4');
  await new Promise<void>((resolve) => {
    a.bind({ port: 54401, address: '127.0.0.1', exclusive: true }, () => resolve());
  });
  await new Promise<void>((resolve) => {
    b.bind({ port: 54402, address: '127.0.0.1', exclusive: true }, () => resolve());
  });
  try {
    const port = await pickFreeMagicDnsPort([54401, 54402, 54403]);
    assert.equal(port, 54403);
  } finally {
    a.close();
    b.close();
  }
});

test('pickFreeMagicDnsPort: returns null when every candidate is taken', async () => {
  const holder = dgram.createSocket('udp4');
  await new Promise<void>((resolve) => {
    holder.bind({ port: 54501, address: '127.0.0.1', exclusive: true }, () => resolve());
  });
  try {
    const port = await pickFreeMagicDnsPort([54501]);
    assert.equal(port, null);
  } finally {
    holder.close();
  }
});

// ── classifyNvpnLogLine ───────────────────────────────────────────────
// First-run UX hinges on these: an Ubuntu host with systemd-resolved's
// stub on 1053 + an nvpn unit without CAP_DAC_OVERRIDE writes a wall
// of red lines on the very first connect. The lines below are all
// upstream-INFO that the daemon recovers from on its own; we color
// them as info so the user doesn't see a fake outage.

test('classifyNvpnLogLine: magicdns port-collision is info, not error', () => {
  const line = '2026-05-12T02:50:15.470Z [INFO] magicdns: preferred port 1053 ' +
               'unavailable (failed to bind magic dns on 127.0.0.1:1053); ' +
               'trying random local port';
  assert.equal(classifyNvpnLogLine(line), 'info');
});

test('classifyNvpnLogLine: resolved-missing is info, not error', () => {
  const line = 'magicdns: system resolver install failed (resolvectl dns lo ' +
               '127.0.0.1:44935 failed: Failed to set DNS configuration: Unit ' +
               'dbus-org.freedesktop.resolve1.service not found.); local dns remains';
  assert.equal(classifyNvpnLogLine(line), 'info');
});

test('classifyNvpnLogLine: route-flush perm-denied is info, not error', () => {
  assert.equal(
    classifyNvpnLogLine('tunnel: failed to flush linux route cache: command failed'),
    'info',
  );
  assert.equal(
    classifyNvpnLogLine('stderr: Cannot open "/proc/sys/net/ipv4/route/flush": Permission denied'),
    'info',
  );
});

test('classifyNvpnLogLine: genuine errors still color red', () => {
  // Sanity: the demotion list must not swallow real failures.
  assert.equal(classifyNvpnLogLine('relay: error connecting to peer'), 'error');
  assert.equal(classifyNvpnLogLine('panic: nil pointer'),               'error');
  assert.equal(classifyNvpnLogLine('warn: clock skew detected'),        'warn');
  assert.equal(classifyNvpnLogLine('starting daemon'),                  'info');
});
