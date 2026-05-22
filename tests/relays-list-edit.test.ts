// Tests for the NIP-65 relay-list edit primitives.
//
// Identity is persisted at ~/.config/nostr-station/identity.json. Each
// test points HOME at a fresh tmpdir to avoid touching a real install.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function withTmpHome<T>(fn: () => Promise<T> | T): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-relays-'));
  const prevHome = process.env.HOME;
  process.env.HOME = dir;
  try { return await fn(); } finally { process.env.HOME = prevHome; }
}

// Identity + relays modules cache nothing — every call reads
// identity.json fresh — so it's safe to re-import inside withTmpHome.
// Dynamic import per test keeps the module's internal state isolated
// from sibling tests in this process.
async function load() {
  const ident   = await import('../src/lib/identity.ts');
  const relays  = await import('../src/lib/relays.ts');
  return { ident, relays };
}

test('relays: listRelays returns empty list on a fresh install', async () => {
  await withTmpHome(async () => {
    const { relays } = await load();
    // No identity.json on disk → readIdentity returns DEFAULT_READ_RELAYS
    // as readRelays. listRelays projects that through mergeRelayLists.
    // Legacy default = each read relay is also a write relay → mode "both".
    const list = relays.listRelays();
    assert.ok(list.length > 0, 'default read relays should appear');
    assert.ok(list.every(r => r.mode === 'both'),
      'legacy install with undefined writeRelays maps all read relays to mode "both"');
  });
});

test('relays: addRelayLocal default (both) appears in both lists', async () => {
  await withTmpHome(async () => {
    const { ident, relays } = await load();
    // Seed with an empty start so the test is self-contained.
    ident.writeIdentity({ npub: 'a'.repeat(64), readRelays: [], writeRelays: [] });

    const r = relays.addRelayLocal('wss://example.com');
    assert.equal(r.ok, true);
    assert.ok(r.relays);

    const list = relays.listRelays();
    assert.equal(list.length, 1);
    assert.equal(list[0].url, 'wss://example.com');
    assert.equal(list[0].mode, 'both');

    const cur = ident.readIdentity();
    assert.deepEqual(cur.readRelays,  ['wss://example.com']);
    assert.deepEqual(cur.writeRelays, ['wss://example.com']);
  });
});

test('relays: addRelayLocal --read only writes to readRelays', async () => {
  await withTmpHome(async () => {
    const { ident, relays } = await load();
    ident.writeIdentity({ npub: 'a'.repeat(64), readRelays: [], writeRelays: [] });
    relays.addRelayLocal('wss://inbox.example', 'read');

    const cur = ident.readIdentity();
    assert.deepEqual(cur.readRelays,  ['wss://inbox.example']);
    assert.deepEqual(cur.writeRelays, []);

    const list = relays.listRelays();
    assert.equal(list[0].mode, 'read');
  });
});

test('relays: addRelayLocal --write only writes to writeRelays', async () => {
  await withTmpHome(async () => {
    const { ident, relays } = await load();
    ident.writeIdentity({ npub: 'a'.repeat(64), readRelays: [], writeRelays: [] });
    relays.addRelayLocal('wss://outbox.example', 'write');

    const cur = ident.readIdentity();
    assert.deepEqual(cur.readRelays,  []);
    assert.deepEqual(cur.writeRelays, ['wss://outbox.example']);
  });
});

test('relays: addRelayLocal rejects malformed urls', async () => {
  await withTmpHome(async () => {
    const { relays } = await load();
    const r = relays.addRelayLocal('http://not-a-relay.example');
    assert.equal(r.ok, false);
    assert.match(r.error || '', /ws:\/\/ or wss:\/\//);
  });
});

test('relays: removeRelayLocal drops from both lists', async () => {
  await withTmpHome(async () => {
    const { ident, relays } = await load();
    ident.writeIdentity({
      npub: 'a'.repeat(64),
      readRelays:  ['wss://a.example', 'wss://b.example'],
      writeRelays: ['wss://a.example'],
    });
    const r = relays.removeRelayLocal('wss://a.example');
    assert.equal(r.removed, true);

    const cur = ident.readIdentity();
    assert.deepEqual(cur.readRelays,  ['wss://b.example']);
    assert.deepEqual(cur.writeRelays, []);
  });
});

test('relays: removeRelayLocal of an absent url reports removed=false', async () => {
  await withTmpHome(async () => {
    const { ident, relays } = await load();
    ident.writeIdentity({
      npub: 'a'.repeat(64),
      readRelays:  ['wss://a.example'],
      writeRelays: ['wss://a.example'],
    });
    const r = relays.removeRelayLocal('wss://not-present.example');
    assert.equal(r.removed, false);
  });
});

test('relays: mergeRelayLists with undefined writeRelays treats all reads as both', async () => {
  const { relays } = await load();
  const merged = relays.mergeRelayLists(['wss://a', 'wss://b'], undefined);
  assert.equal(merged.length, 2);
  assert.ok(merged.every(r => r.mode === 'both'));
});

test('relays: mergeRelayLists distinguishes read-only / write-only / both', async () => {
  const { relays } = await load();
  const merged = relays.mergeRelayLists(
    ['wss://both.example', 'wss://read.example'],
    ['wss://both.example', 'wss://write.example'],
  );
  const m = new Map(merged.map(r => [r.url, r.mode]));
  assert.equal(m.get('wss://both.example'),  'both');
  assert.equal(m.get('wss://read.example'),  'read');
  assert.equal(m.get('wss://write.example'), 'write');
});

test('relays: diffRelays surfaces added / removed / changed / unchanged', async () => {
  const { relays } = await load();
  const cur = [
    { url: 'wss://stay.example',    mode: 'both'  as const },
    { url: 'wss://remove.example',  mode: 'read'  as const },
    { url: 'wss://promote.example', mode: 'read'  as const },
  ];
  const inc = [
    { url: 'wss://stay.example',    mode: 'both'  as const },
    { url: 'wss://promote.example', mode: 'both'  as const },
    { url: 'wss://added.example',   mode: 'write' as const },
  ];
  const d = relays.diffRelays(cur, inc);

  assert.equal(d.added.length,     1);
  assert.equal(d.added[0].url,     'wss://added.example');
  assert.equal(d.removed.length,   1);
  assert.equal(d.removed[0].url,   'wss://remove.example');
  assert.equal(d.changed.length,   1);
  assert.equal(d.changed[0].url,   'wss://promote.example');
  assert.equal(d.changed[0].from,  'read');
  assert.equal(d.changed[0].to,    'both');
  assert.equal(d.unchanged,        1);
});

test('relays: buildNip65Template emits unmarked tags for both, "read"/"write" markers otherwise', async () => {
  await withTmpHome(async () => {
    const { ident, relays } = await load();
    ident.writeIdentity({
      npub: 'a'.repeat(64),
      readRelays:  ['wss://both.example', 'wss://readonly.example'],
      writeRelays: ['wss://both.example', 'wss://writeonly.example'],
    });
    const t = relays.buildNip65Template({ now: 1_700_000_000_000 });
    assert.equal(t.kind, 10002);
    assert.equal(t.content, '');
    assert.equal(t.created_at, 1_700_000_000);

    const find = (url: string) => t.tags.find(tag => tag[0] === 'r' && tag[1] === url);
    assert.deepEqual(find('wss://both.example'),      ['r', 'wss://both.example']);
    assert.deepEqual(find('wss://readonly.example'),  ['r', 'wss://readonly.example',  'read']);
    assert.deepEqual(find('wss://writeonly.example'), ['r', 'wss://writeonly.example', 'write']);
  });
});

test('relays: publishNip65 refuses to sign when no relays are configured', async () => {
  await withTmpHome(async () => {
    const { ident, relays } = await load();
    ident.writeIdentity({ npub: 'a'.repeat(64), readRelays: [], writeRelays: [] });

    // Inject a signer to prove it never gets called when the template
    // is empty — the early-return must happen before the signing step.
    let signerCalls = 0;
    const result = await relays.publishNip65({
      signEvent: async () => { signerCalls++; return { ok: true, signedEvent: {} as any }; },
      publish:   async () => [],
    });
    assert.equal(result.ok, false);
    assert.equal(signerCalls, 0, 'signer must not run when template tags are empty');
    assert.match(result.error || '', /no relays configured/);
  });
});

test('relays: publishNip65 stops short when the signer fails', async () => {
  await withTmpHome(async () => {
    const { ident, relays } = await load();
    ident.writeIdentity({
      npub: 'a'.repeat(64),
      readRelays:  ['wss://example.com'],
      writeRelays: ['wss://example.com'],
    });
    let publishCalls = 0;
    const result = await relays.publishNip65({
      signEvent: async () => ({ ok: false, error: 'no bunker paired' }),
      publish:   async () => { publishCalls++; return []; },
    });
    assert.equal(result.ok, false);
    assert.equal(publishCalls, 0, 'no broadcast attempt when signing fails');
    assert.match(result.error || '', /bunker/);
  });
});

test('relays: publishNip65 reports per-relay results, ok=true when at least one accepts', async () => {
  await withTmpHome(async () => {
    const { ident, relays } = await load();
    ident.writeIdentity({
      npub: 'a'.repeat(64),
      readRelays:  ['wss://accept.example', 'wss://reject.example'],
      writeRelays: ['wss://accept.example'],
    });

    const fakeSigned = { id: 'aa'.repeat(32), pubkey: 'bb'.repeat(32), kind: 10002, created_at: 1, content: '', tags: [], sig: 'cc'.repeat(64) };
    const result = await relays.publishNip65({
      signEvent: async (template) => {
        // Confirm the signer sees the right template shape — kind 10002,
        // tags include the configured urls.
        assert.equal(template.kind, 10002);
        assert.ok(template.tags.some(t => t[0] === 'r' && t[1] === 'wss://accept.example'));
        return { ok: true, signedEvent: fakeSigned };
      },
      publish: async (_event, urls) => urls.map(u => ({
        relay:  u,
        ok:     u.includes('accept'),
        reason: u.includes('reject') ? 'invalid kind' : undefined,
      })),
    });

    assert.equal(result.ok, true, 'partial success = ok');
    assert.equal(result.relayResults.length, 2);
    const accept = result.relayResults.find(r => r.relay === 'wss://accept.example');
    const reject = result.relayResults.find(r => r.relay === 'wss://reject.example');
    assert.equal(accept?.ok, true);
    assert.equal(reject?.ok, false);
    assert.equal(reject?.reason, 'invalid kind');
  });
});

test('relays: publishNip65 reports ok=false when no relay accepts', async () => {
  await withTmpHome(async () => {
    const { ident, relays } = await load();
    ident.writeIdentity({
      npub: 'a'.repeat(64),
      readRelays:  ['wss://r1.example'],
      writeRelays: ['wss://r1.example'],
    });
    const result = await relays.publishNip65({
      signEvent: async () => ({ ok: true, signedEvent: { id: 'aa'.repeat(32) } as any }),
      publish:   async (_e, urls) => urls.map(u => ({ relay: u, ok: false, reason: 'timeout' })),
    });
    assert.equal(result.ok, false);
    assert.ok(result.signedEvent, 'signed event still surfaces so the caller can retry');
  });
});

test('relays: applyNip65Pull rewrites readRelays + writeRelays from a parsed event', async () => {
  await withTmpHome(async () => {
    const { ident, relays } = await load();
    ident.writeIdentity({
      npub: 'a'.repeat(64),
      readRelays:  ['wss://old.example'],
      writeRelays: ['wss://old.example'],
    });
    relays.applyNip65Pull({
      readRelays:  ['wss://new.example', 'wss://shared.example'],
      writeRelays: ['wss://shared.example', 'wss://out.example'],
      createdAt: 1,
      eventId: 'x'.repeat(64),
    });
    const cur = ident.readIdentity();
    assert.deepEqual(cur.readRelays,  ['wss://new.example', 'wss://shared.example']);
    assert.deepEqual(cur.writeRelays, ['wss://shared.example', 'wss://out.example']);
  });
});
