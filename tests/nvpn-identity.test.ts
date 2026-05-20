import test from 'node:test';
import assert from 'node:assert/strict';
import { readNvpnNodeIdentity } from '../src/lib/nvpn.ts';

// readNvpnNodeIdentity reads ~/.config/nvpn/config.toml at module
// runtime — we can't usefully unit-test that path here without
// monkey-patching the filesystem. What we MUST test is the
// extractor that pulls only `[nostr] public_key` and never anything
// else: same file holds `[nostr] secret_key` and `[node]
// private_key`, both of which would compromise the user if leaked.
//
// The extractor is private (`extractNostrPublicKey`), so we test it
// via the public helper's return shape: feed a config through and
// assert (a) the npub IS extracted; (b) NO secret-shaped string
// appears in the result; (c) the result shape has exactly the keys
// we documented.
//
// Strategy: bypass the fs read by importing the extractor through
// the helper's behaviour on a config file we control. The simplest
// way to do that without monkey-patching is to put a fixture config
// at a temp path, point HOME at it via env, and call the helper.
// (TempHOME pattern is borrowed from nvpn-aliases.test.ts.)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function withTempHome(toml: string, fn: () => void): void {
  const tmp  = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-identity-'));
  const cfg  = path.join(tmp, '.config', 'nvpn');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'config.toml'), toml);
  const prev = process.env.HOME;
  process.env.HOME = tmp;
  try { fn(); }
  finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const SAMPLE_NPUB = 'npub160nps2afutv608rs3gxgrz83r0u6t7nym8halw5ysx8ydceg82rqgljzl8';

// `[nostr]` block — adjacent to the public_key we want lives a
// secret_key the helper must never return.
const NOSTR_BLOCK = `
[nostr]
secret_key = "nsec1u0e8fk3p3kc9kxs87s5g5fxakmtsswylq0unkdpfhn2mvldzgafqzj2ner"
public_key = "${SAMPLE_NPUB}"
`;

// `[node]` block — contains a base64-encoded WireGuard private key
// which is also extremely sensitive. Must not appear in any return
// value or be reachable via any documented field.
const NODE_BLOCK = `
[node]
id = "5c099d46-f17e-4615-b693-8349a91b3ad5"
private_key = "P+q8qWT3RsHFakeBase64KeyMaterialDoNotLeakkkkkkkkkkkkkkkk="
public_key = "KVt6ZNQTFakeWireguardPubKeyMaterialNotAnNpub================="
tunnel_ip = "10.44.247.100/32"
`;

const NETWORKS_BLOCK = `
[[networks]]
network_id = "8770b86776819ed8"
name = "Network 1"
participants = []
admins = []
`;

const FULL_CONFIG = NOSTR_BLOCK + NODE_BLOCK + NETWORKS_BLOCK;

test('readNvpnNodeIdentity extracts only [nostr] public_key', () => {
  withTempHome(FULL_CONFIG, () => {
    const id = readNvpnNodeIdentity();
    assert.equal(id.npub, SAMPLE_NPUB);
    assert.ok(id.configPath?.endsWith('config.toml'));
  });
});

test('readNvpnNodeIdentity result has exactly the documented keys', () => {
  withTempHome(FULL_CONFIG, () => {
    const id = readNvpnNodeIdentity();
    // The leak-safe contract is "the result shape is finite and
    // documented." If a future refactor accidentally adds a
    // `secret_key` or `raw` field, this test breaks loudly.
    assert.deepEqual(Object.keys(id).sort(), ['configPath', 'npub']);
  });
});

test('readNvpnNodeIdentity never returns secret material in any field', () => {
  withTempHome(FULL_CONFIG, () => {
    const id = readNvpnNodeIdentity();
    const serialized = JSON.stringify(id);
    // Substrings of every secret in the fixture. If any survive the
    // serialized round-trip, the helper is leaking.
    const forbiddenSubstrings = [
      'nsec1',                                  // bech32 nsec prefix
      'u0e8fk3p3kc9kxs87s5g5fxakmtsswylq',      // body of the secret_key
      'P+q8qWT',                                // WireGuard private key prefix
      'FakeBase64KeyMaterial',                  // marker inside private_key
      'KVt6ZNQT',                               // WireGuard pubkey (still not npub-safe to surface)
      'FakeWireguardPubKey',                    // marker inside [node] public_key
    ];
    for (const s of forbiddenSubstrings) {
      assert.equal(
        serialized.includes(s), false,
        `readNvpnNodeIdentity leaked '${s}' — secret material must not appear in result`,
      );
    }
  });
});

test('readNvpnNodeIdentity returns npub=null when [nostr] is missing', () => {
  withTempHome(NODE_BLOCK + NETWORKS_BLOCK, () => {
    const id = readNvpnNodeIdentity();
    assert.equal(id.npub, null);
    assert.ok(id.configPath?.endsWith('config.toml'));
  });
});

test('readNvpnNodeIdentity returns npub=null when public_key is malformed', () => {
  withTempHome(`
[nostr]
secret_key = "nsec1u0e8fk3..."
public_key = "not-an-npub"
` + NETWORKS_BLOCK, () => {
    const id = readNvpnNodeIdentity();
    // Strict bech32 regex — anything that isn't a real npub1... gets
    // rejected rather than echoed back as garbage.
    assert.equal(id.npub, null);
  });
});

test('readNvpnNodeIdentity returns nulls when config.toml is missing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-identity-empty-'));
  const prev = process.env.HOME;
  process.env.HOME = tmp;
  try {
    const id = readNvpnNodeIdentity();
    assert.equal(id.npub, null);
    assert.equal(id.configPath, null);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The TOML format allows [[networks]] then [nostr] in either order.
// extractNostrPublicKey searches by section header so this must work.
test('readNvpnNodeIdentity finds [nostr] regardless of section order', () => {
  withTempHome(NETWORKS_BLOCK + NODE_BLOCK + NOSTR_BLOCK, () => {
    const id = readNvpnNodeIdentity();
    assert.equal(id.npub, SAMPLE_NPUB);
  });
});

// Critical: [node] public_key (which is a base64 WireGuard key) must
// NOT be extracted as the npub. The strict bech32 regex blocks this,
// but the test pins the contract.
test('readNvpnNodeIdentity does NOT extract [node] public_key as npub', () => {
  withTempHome(NODE_BLOCK + NETWORKS_BLOCK, () => {  // no [nostr] block
    const id = readNvpnNodeIdentity();
    assert.equal(id.npub, null, '[node] public_key must not be confused with [nostr] public_key');
  });
});
