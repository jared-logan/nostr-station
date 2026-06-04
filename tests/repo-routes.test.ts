import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { nip19 } from 'nostr-tools';

const {
  isSafeRef,
  isSafePath,
  isLikelyBinary,
  parseRepoAnnouncement,
  clampInt,
  buildRepoAnnounceTemplate,
  decodeNgitRemote,
  fetchRepoMeta,
  buildNgitRemoteUrl,
  mergeRelaySet,
  mergeRelaysTagValues,
  computeSuggestedHashtags,
  computeSuggestedOtherRelays,
  STATION_TOPIC,
  deriveLocalEuc,
  normalizeTopic,
} = await import('../src/lib/routes/repo.ts');

const { isCanonicalClientTag, CLIENT_TAG, CLIENT_NAME } = await import('../src/lib/client-tag.ts');

// ── decodeNgitRemote (regression: 3-part remote forked the d-tag) ─────────
// A `nostr://<npub>/<relay-host>/<repo>` remote must decode to d=<repo>,
// NOT d=<relay-host>/<repo>. The latter forks every lookup + re-announce
// onto a phantom coordinate and produced a duplicate repo on gitworkshop.
const NPUB = 'npub19yw8tkfh530kdgfqn782vcga7azgckdn2fjjp3nv5txu6dl3h7lqhv322j';
const HEX  = '291c75d937a45f66a1209f8ea6611df7448c59b3526520c66ca2cdcd37f1bfbe';

test('decodeNgitRemote: 2-part nostr remote → d-tag is the repo, no relay hints', () => {
  const c = decodeNgitRemote({ remotes: { ngit: `nostr://${NPUB}/hello-world` } });
  assert.equal(c?.pubkey, HEX);
  assert.equal(c?.identifier, 'hello-world');
  assert.deepEqual(c?.relayHints, []);
});

test('decodeNgitRemote: 3-part remote → LAST segment is d-tag, middle is a relay hint', () => {
  const c = decodeNgitRemote({ remotes: { ngit: `nostr://${NPUB}/relay.ngit.dev/hello-world` } });
  assert.equal(c?.pubkey, HEX);
  assert.equal(c?.identifier, 'hello-world');                 // NOT 'relay.ngit.dev/hello-world'
  assert.deepEqual(c?.relayHints, ['wss://relay.ngit.dev']);
});

test('decodeNgitRemote: no ngit remote → null', () => {
  assert.equal(decodeNgitRemote({ remotes: {} }), null);
  assert.equal(decodeNgitRemote({}), null);
});

// ── isSafeRef ────────────────────────────────────────────────────────────

test('isSafeRef: accepts plain branch / tag names', () => {
  for (const ok of ['main', 'master', 'develop', 'v1.2.3', 'release-1', 'feature_x']) {
    assert.equal(isSafeRef(ok), true, ok);
  }
});

test('isSafeRef: accepts full ref paths', () => {
  for (const ok of ['refs/heads/main', 'refs/tags/v1.0.0', 'refs/heads/feature/foo']) {
    assert.equal(isSafeRef(ok), true, ok);
  }
});

test('isSafeRef: accepts short SHAs', () => {
  assert.equal(isSafeRef('abc1234'), true);
  assert.equal(isSafeRef('a'.repeat(40)), true);
});

test('isSafeRef: rejects empty / overlong', () => {
  assert.equal(isSafeRef(''), false);
  assert.equal(isSafeRef('a'.repeat(256)), false);
});

test('isSafeRef: rejects leading dash (would be misread as a flag)', () => {
  assert.equal(isSafeRef('-main'), false);
  assert.equal(isSafeRef('--all'), false);
});

test('isSafeRef: rejects path-traversal patterns', () => {
  assert.equal(isSafeRef('refs/../etc'),     false);
  assert.equal(isSafeRef('refs//heads/main'), false);
  assert.equal(isSafeRef('/refs/heads/main'), false);
  assert.equal(isSafeRef('refs/heads/main/'), false);
});

test('isSafeRef: rejects shell metacharacters and whitespace', () => {
  for (const bad of ['a;b', 'a b', 'a&b', 'a|b', 'a$x', 'a`x`', 'a\nb', 'a\tb', 'a"b', "a'b"]) {
    assert.equal(isSafeRef(bad), false, JSON.stringify(bad));
  }
});

test('isSafeRef: rejects non-string inputs', () => {
  // Defensive: query-param values can theoretically be undefined or
  // arrays; the regex predicate must guard.
  assert.equal(isSafeRef(null as any),     false);
  assert.equal(isSafeRef(undefined as any), false);
  assert.equal(isSafeRef(123 as any),       false);
});

// ── isSafePath ───────────────────────────────────────────────────────────

test('isSafePath: empty string is the repo root', () => {
  assert.equal(isSafePath(''), true);
});

test('isSafePath: accepts ordinary paths', () => {
  for (const ok of ['README.md', 'src/lib/foo.ts', 'a/b/c.json', 'docs/architecture/maintainer-model.md']) {
    assert.equal(isSafePath(ok), true, ok);
  }
});

test('isSafePath: rejects absolute paths and leading dash', () => {
  assert.equal(isSafePath('/etc/passwd'),      false);
  assert.equal(isSafePath('-rf'),              false);
});

test('isSafePath: rejects parent-segment traversal', () => {
  assert.equal(isSafePath('..'),               false);
  assert.equal(isSafePath('src/../etc'),       false);
  assert.equal(isSafePath('a/b/../../c'),      false);
  assert.equal(isSafePath('./foo'),            false);
});

test('isSafePath: rejects empty segments and NUL', () => {
  assert.equal(isSafePath('a//b'),             false);
  assert.equal(isSafePath('a/\0/b'),           false);
});

test('isSafePath: rejects overlong paths', () => {
  assert.equal(isSafePath('a'.repeat(1025)),   false);
});

// ── isLikelyBinary ───────────────────────────────────────────────────────

test('isLikelyBinary: text content is not binary', () => {
  assert.equal(isLikelyBinary(Buffer.from('hello world\n')),                 false);
  assert.equal(isLikelyBinary(Buffer.from('# README\n\nMarkdown content')),  false);
  assert.equal(isLikelyBinary(Buffer.from('// some code\nconst x = 1;\n')), false);
});

test('isLikelyBinary: a single null byte in the first 8 kB classifies as binary', () => {
  assert.equal(isLikelyBinary(Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6f])), true);
});

test('isLikelyBinary: null beyond the 8 kB scan window is missed (deliberate)', () => {
  // Only the first 8 kB is scanned — deliberately bounded so we don't
  // chew through 100 MB looking for a null. Mirrors git's own heuristic.
  const buf = Buffer.alloc(9000, 0x41);  // 'A' * 9000
  buf[8500] = 0;
  assert.equal(isLikelyBinary(buf), false);
});

test('isLikelyBinary: empty buffer is not binary', () => {
  assert.equal(isLikelyBinary(Buffer.alloc(0)), false);
});

// ── parseRepoAnnouncement ────────────────────────────────────────────────

const PUBKEY      = 'a'.repeat(64);
const COMAINT     = 'b'.repeat(64);
const COMAINT_TWO = 'c'.repeat(64);

function makeAnnouncement(tags: string[][]): any {
  return {
    id:         'd'.repeat(64),
    pubkey:     PUBKEY,
    kind:       30617,
    created_at: 1_700_000_000,
    tags,
    content:    '',
    sig:        'e'.repeat(128),
  };
}

test('parseRepoAnnouncement: extracts standard NIP-34 fields', () => {
  const ev = makeAnnouncement([
    ['d', 'torchlite'],
    ['name', 'Torchlite'],
    ['description', 'A nostr app'],
    ['web', 'https://torchlite.example'],
    ['clone', 'https://relay.ngit.dev/x/torchlite.git'],
    ['relays', 'wss://relay.ngit.dev'],
    ['t', 'nostr'],
    ['t', 'ngit'],
    ['r', 'abcdef0123456789', 'euc'],
  ]);
  const meta = parseRepoAnnouncement(ev);
  assert.equal(meta.coordinate,  `30617:${PUBKEY}:torchlite`);
  assert.equal(meta.identifier,  'torchlite');
  assert.equal(meta.name,        'Torchlite');
  assert.equal(meta.description, 'A nostr app');
  assert.deepEqual(meta.web,     ['https://torchlite.example']);
  assert.deepEqual(meta.clone,   ['https://relay.ngit.dev/x/torchlite.git']);
  assert.deepEqual(meta.relays,  ['wss://relay.ngit.dev']);
  assert.deepEqual(meta.hashtags, ['nostr', 'ngit']);
  assert.equal(meta.euc,         'abcdef0123456789');
  assert.equal(meta.publishedAt, 1_700_000_000);
});

test('parseRepoAnnouncement: name falls back to identifier when missing', () => {
  const meta = parseRepoAnnouncement(makeAnnouncement([['d', 'foo']]));
  assert.equal(meta.name, 'foo');
});

test('parseRepoAnnouncement: announcing pubkey is always in maintainer set', () => {
  // Announcing pubkey trivially trusted (signed under its own coord).
  const meta = parseRepoAnnouncement(makeAnnouncement([['d', 'foo']]));
  assert.deepEqual(meta.maintainers, [PUBKEY]);
});

test('parseRepoAnnouncement: co-maintainers union with announcing pubkey, dedupe', () => {
  const ev = makeAnnouncement([
    ['d', 'foo'],
    ['maintainers', COMAINT, COMAINT_TWO],
    ['maintainers', PUBKEY],          // already implicit — dedupe
  ]);
  const meta = parseRepoAnnouncement(ev);
  assert.equal(meta.maintainers[0], PUBKEY, 'announcing pubkey first');
  assert.ok(meta.maintainers.includes(COMAINT));
  assert.ok(meta.maintainers.includes(COMAINT_TWO));
  // Dedupe — PUBKEY should appear once, not twice.
  const count = meta.maintainers.filter((p: string) => p === PUBKEY).length;
  assert.equal(count, 1);
});

test('parseRepoAnnouncement: filters non-hex maintainers', () => {
  const ev = makeAnnouncement([
    ['d', 'foo'],
    ['maintainers', 'not-hex', COMAINT, '   ', 'also not hex'],
  ]);
  const meta = parseRepoAnnouncement(ev);
  // PUBKEY (announcer, implicit) + COMAINT.
  assert.deepEqual(meta.maintainers, [PUBKEY, COMAINT]);
});

test('parseRepoAnnouncement: web tags sanitized via safeHttpUrl', () => {
  const ev = makeAnnouncement([
    ['d', 'foo'],
    ['web', 'javascript:alert(1)'],     // dropped
    ['web', 'https://safe.example'],    // kept
    ['web', 'ftp://nope.example'],      // dropped
  ]);
  const meta = parseRepoAnnouncement(ev);
  assert.deepEqual(meta.web, ['https://safe.example']);
});

test('parseRepoAnnouncement: multi-clone URL union preserved in order', () => {
  const ev = makeAnnouncement([
    ['d', 'foo'],
    ['clone', 'https://a.example/x.git'],
    ['clone', 'https://b.example/x.git', 'ssh://b.example/x.git'],
  ]);
  const meta = parseRepoAnnouncement(ev);
  assert.deepEqual(meta.clone, [
    'https://a.example/x.git',
    'https://b.example/x.git',
    'ssh://b.example/x.git',
  ]);
});

test('parseRepoAnnouncement: missing optional fields default safely', () => {
  const meta = parseRepoAnnouncement(makeAnnouncement([['d', 'foo']]));
  assert.equal(meta.description, '');
  assert.deepEqual(meta.web,     []);
  assert.deepEqual(meta.clone,   []);
  assert.deepEqual(meta.relays,  []);
  assert.deepEqual(meta.hashtags, []);
  assert.equal(meta.euc,         null);
});

test('parseRepoAnnouncement: hashtag length cap (≤ 64 chars)', () => {
  const ev = makeAnnouncement([
    ['d', 'foo'],
    ['t', 'short'],
    ['t', 'a'.repeat(65)],   // dropped
    ['t', 'a'.repeat(64)],   // kept (boundary)
  ]);
  const meta = parseRepoAnnouncement(ev);
  assert.deepEqual(meta.hashtags, ['short', 'a'.repeat(64)]);
});

test('parseRepoAnnouncement: euc marker is the FIRST r/euc tag', () => {
  // If multiple r=...,euc tags exist, the first wins. NIP-34 doesn't
  // specify ordering, but pinning to first-wins is deterministic.
  const ev = makeAnnouncement([
    ['d', 'foo'],
    ['r', 'first-euc', 'euc'],
    ['r', 'second-euc', 'euc'],
  ]);
  assert.equal(parseRepoAnnouncement(ev).euc, 'first-euc');
});

test('parseRepoAnnouncement: r tags WITHOUT the "euc" marker are not the EUC', () => {
  // `r` tags are also used for plain refs in NIP-34. Only the
  // explicitly-marked one is the earliest-unique-commit.
  const ev = makeAnnouncement([
    ['d', 'foo'],
    ['r', 'random-ref'],
    ['r', 'another-ref', 'something-else'],
  ]);
  assert.equal(parseRepoAnnouncement(ev).euc, null);
});

// ── clampInt ─────────────────────────────────────────────────────────────

test('clampInt: returns fallback for null', () => {
  assert.equal(clampInt(null, 20, 1, 100), 20);
});

test('clampInt: returns fallback for non-numeric', () => {
  assert.equal(clampInt('abc',  20, 1, 100), 20);
  assert.equal(clampInt('',     20, 1, 100), 20);
  assert.equal(clampInt('NaN',  20, 1, 100), 20);
});

test('clampInt: clamps within bounds', () => {
  assert.equal(clampInt('50',   20, 1, 100), 50);
  assert.equal(clampInt('200',  20, 1, 100), 100);
  assert.equal(clampInt('-5',   20, 1, 100), 1);
  assert.equal(clampInt('0',    20, 1, 100), 1);
});

test('clampInt: parses leading-numeric strings (parseInt semantics)', () => {
  // parseInt('10abc', 10) → 10. Document the behavior so a future
  // tightening (to /^-?\d+$/) is a deliberate choice.
  assert.equal(clampInt('10abc', 20, 1, 100), 10);
});

// ── buildRepoAnnounceTemplate ────────────────────────────────────────────

const ANCHOR_HEX = 'a'.repeat(64);
const CO_HEX     = 'b'.repeat(64);

test('buildRepoAnnounceTemplate: kind=30617, identifier as d-tag, default content empty', () => {
  const tpl = buildRepoAnnounceTemplate(
    { identifier: 'blip' },
    null,
    ANCHOR_HEX,
  );
  assert.equal(tpl.kind, 30617);
  assert.equal(tpl.content, '');
  assert.deepEqual(tpl.tags[0], ['d', 'blip']);
  assert.ok(Number.isFinite(tpl.created_at) && tpl.created_at > 0);
});

test('buildRepoAnnounceTemplate: emits one t-tag per hashtag (relays index per value)', () => {
  // Hashtag indexing in NIP-01 relies on a tag PER value, not a single
  // tag with multiple values. Confirms we're using the right shape.
  const tpl = buildRepoAnnounceTemplate(
    { identifier: 'blip', hashtags: ['shakespeare', 'mkstack'] },
    null,
    ANCHOR_HEX,
  );
  const tTags = tpl.tags.filter(t => t[0] === 't');
  assert.equal(tTags.length, 2);
  assert.ok(tTags.some(t => t[1] === 'shakespeare'));
  assert.ok(tTags.some(t => t[1] === 'mkstack'));
});

test('buildRepoAnnounceTemplate: web/clone/relays/blossoms collapse to one multi-value tag each', () => {
  const tpl = buildRepoAnnounceTemplate(
    {
      identifier: 'blip',
      web:        ['https://example.com'],
      clone:      ['https://git.example.com/x.git', 'https://git2.example.com/x.git'],
      relays:     ['wss://relay.one', 'wss://relay.two'],
      blossoms:   ['https://blossom.example.com'],
    },
    null,
    ANCHOR_HEX,
  );
  const find = (n: string) => tpl.tags.find(t => t[0] === n);
  assert.deepEqual(find('web'),      ['web', 'https://example.com']);
  assert.deepEqual(find('clone'),    ['clone', 'https://git.example.com/x.git', 'https://git2.example.com/x.git']);
  assert.deepEqual(find('relays'),   ['relays', 'wss://relay.one', 'wss://relay.two']);
  assert.deepEqual(find('blossoms'), ['blossoms', 'https://blossom.example.com']);
});

test('buildRepoAnnounceTemplate: maintainers strips the signer (avoids self-claim)', () => {
  // The signer IS the trust anchor by construction; including their
  // own pubkey in the `maintainers` tag would be redundant noise.
  const tpl = buildRepoAnnounceTemplate(
    { identifier: 'blip', maintainers: [ANCHOR_HEX, CO_HEX] },
    null,
    ANCHOR_HEX,
  );
  const m = tpl.tags.find(t => t[0] === 'maintainers');
  assert.deepEqual(m, ['maintainers', CO_HEX]);
});

test('buildRepoAnnounceTemplate: no maintainers tag when only the signer was passed', () => {
  // Self-only list collapses to no tag (consistent with the strip rule).
  const tpl = buildRepoAnnounceTemplate(
    { identifier: 'blip', maintainers: [ANCHOR_HEX] },
    null,
    ANCHOR_HEX,
  );
  assert.equal(tpl.tags.find(t => t[0] === 'maintainers'), undefined);
});

test('buildRepoAnnounceTemplate: auto-injects client=nostr-station when absent', () => {
  const tpl = buildRepoAnnounceTemplate(
    { identifier: 'blip' },
    null,
    ANCHOR_HEX,
  );
  const client = tpl.tags.find(t => t[0] === 'client');
  // 4-element NIP-89 form (links to the kind-31990 handler), not the bare
  // 2-element marker — so the announcement links to nostr-station in
  // NIP-89-aware clients exactly like the Client panel's kind-1s do.
  assert.equal(client?.[0], 'client');
  assert.equal(client?.[1], 'nostr-station');
  assert.equal(client?.length, 4);
  assert.match(client?.[2] || '', /^31990:[0-9a-f]{64}:nostr-station$/);
});

test('buildRepoAnnounceTemplate: does NOT overwrite an explicit client tag from the form', () => {
  // Forward compat: a user-supplied client tag wins. Lets users
  // override the auto-injection if they republish from a multi-tool
  // setup.
  const tpl = buildRepoAnnounceTemplate(
    { identifier: 'blip', customTags: [['client', 'my-other-client']] },
    null,
    ANCHOR_HEX,
  );
  const clients = tpl.tags.filter(t => t[0] === 'client');
  assert.equal(clients.length, 1);
  assert.deepEqual(clients[0], ['client', 'my-other-client']);
});

test('buildRepoAnnounceTemplate: preserves unknown tags from the prior announcement', () => {
  // Forward-compat carry-through. If the prior announcement contained
  // a tag type we don't surface in the form (e.g. ['x-future-thing', …]),
  // we MUST preserve it on republish or the user silently loses data.
  const prior: any = {
    kind: 30617,
    tags: [
      ['d', 'blip'],
      ['x-future-thing', 'value1', 'value2'],
      ['client', 'shakespeare.diy'],   // also unknown to our form
    ],
  };
  const tpl = buildRepoAnnounceTemplate(
    { identifier: 'blip' },
    prior,
    ANCHOR_HEX,
  );
  const x = tpl.tags.find(t => t[0] === 'x-future-thing');
  assert.deepEqual(x, ['x-future-thing', 'value1', 'value2']);
  // Prior's client tag wins over auto-injection (no double client tag).
  const clients = tpl.tags.filter(t => t[0] === 'client');
  assert.equal(clients.length, 1);
  assert.equal(clients[0][1], 'shakespeare.diy');
});

test('buildRepoAnnounceTemplate: form-supplied custom tag overrides prior with same name', () => {
  // Edit form wins over the prior announcement's value when both
  // supply the same tag name — required so the form can actually
  // change a custom tag's value.
  const prior: any = {
    kind: 30617,
    tags: [['d', 'blip'], ['client', 'old-value']],
  };
  const tpl = buildRepoAnnounceTemplate(
    { identifier: 'blip', customTags: [['client', 'new-value']] },
    prior,
    ANCHOR_HEX,
  );
  const clients = tpl.tags.filter(t => t[0] === 'client');
  assert.equal(clients.length, 1);
  assert.equal(clients[0][1], 'new-value');
});

test('buildRepoAnnounceTemplate: r-euc tag emitted only when euc provided', () => {
  const without = buildRepoAnnounceTemplate({ identifier: 'blip' }, null, ANCHOR_HEX);
  assert.equal(without.tags.find(t => t[0] === 'r'), undefined);

  const sha = '0'.repeat(40);
  const withEuc = buildRepoAnnounceTemplate(
    { identifier: 'blip', euc: sha },
    null,
    ANCHOR_HEX,
  );
  assert.deepEqual(withEuc.tags.find(t => t[0] === 'r'), ['r', sha, 'euc']);
});

// ── Bug 2: bare client tag upgrades to the canonical 4-element form ───────
//
// A prior announcement that carried the sticky bare ["client","nostr-station"]
// (2-element) must NOT be preserved verbatim — it must be REPLACED with the
// canonical 4-element CLIENT_TAG so the announcement links back to our
// kind-31990 handler (NIP-89) like nsite deploys do.

test('isCanonicalClientTag: true only for the byte-equal 4-element CLIENT_TAG', () => {
  assert.equal(isCanonicalClientTag([...CLIENT_TAG]), true);
  assert.equal(isCanonicalClientTag(['client', CLIENT_NAME]), false);          // bare 2-element
  assert.equal(isCanonicalClientTag(['client', CLIENT_NAME, 'x', 'y']), false); // wrong coords
  assert.equal(isCanonicalClientTag(['client', 'other', CLIENT_TAG[2], CLIENT_TAG[3]]), false);
});

test('buildRepoAnnounceTemplate: upgrades a prior BARE nostr-station client tag to canonical', () => {
  const prior: any = {
    kind: 30617,
    tags: [['d', 'blip'], ['client', 'nostr-station']],   // sticky bare form
  };
  const tpl = buildRepoAnnounceTemplate({ identifier: 'blip' }, prior, ANCHOR_HEX);
  const clients = tpl.tags.filter(t => t[0] === 'client');
  assert.equal(clients.length, 1, 'exactly one client tag');
  assert.deepEqual(clients[0], [...CLIENT_TAG]);
  assert.equal(isCanonicalClientTag(clients[0]), true);
});

test('buildRepoAnnounceTemplate: leaves a DIFFERENT client tag untouched (only upgrades our own)', () => {
  const prior: any = {
    kind: 30617,
    tags: [['d', 'blip'], ['client', 'shakespeare.diy']],
  };
  const tpl = buildRepoAnnounceTemplate({ identifier: 'blip' }, prior, ANCHOR_HEX);
  const clients = tpl.tags.filter(t => t[0] === 'client');
  assert.equal(clients.length, 1);
  assert.deepEqual(clients[0], ['client', 'shakespeare.diy']);
});

// ── Bug 4: import remote normalization (buildNgitRemoteUrl) ───────────────

test('buildNgitRemoteUrl: with a relay hint → full 3-part form (host stripped of scheme)', () => {
  assert.equal(
    buildNgitRemoteUrl('npubX', 'myrepo', ['wss://relay.ngit.dev']),
    'nostr://npubX/relay.ngit.dev/myrepo',
  );
});

test('buildNgitRemoteUrl: no relay hint → bare 2-part form', () => {
  assert.equal(buildNgitRemoteUrl('npubX', 'myrepo', []), 'nostr://npubX/myrepo');
  assert.equal(buildNgitRemoteUrl('npubX', 'myrepo'), 'nostr://npubX/myrepo');
});

test('buildNgitRemoteUrl: first non-empty hint wins; trailing slashes trimmed', () => {
  assert.equal(
    buildNgitRemoteUrl('npubX', 'r', ['', 'wss://relay.ngit.dev/']),
    'nostr://npubX/relay.ngit.dev/r',
  );
});

// A 3-part remote produced by buildNgitRemoteUrl round-trips through
// decodeNgitRemote with a non-empty relayHints — closing the Bug 4 loop
// (the bare form is what zeroed relayHints and stranded the read).
test('buildNgitRemoteUrl ↔ decodeNgitRemote: 3-part form yields non-empty relayHints', () => {
  const remote = buildNgitRemoteUrl(NPUB, 'hello-world', ['wss://relay.ngit.dev']);
  const c = decodeNgitRemote({ remotes: { ngit: remote } });
  assert.equal(c?.identifier, 'hello-world');
  assert.deepEqual(c?.relayHints, ['wss://relay.ngit.dev']);
});

test('discover-path remote → non-empty relayHints (every clone entry point carries hints)', () => {
  // The Discover handler builds its remote with the in-scope GRASP relay set
  // (getGraspServers()) via buildNgitRemoteUrl(npub, dTag, relays) — same call
  // the clone/explore fallbacks use. A repo cloned from Discover must therefore
  // store a remote that decodes to a non-empty relayHints, not the bare form.
  const discoverRelays = ['wss://relay.ngit.dev', 'wss://git.shakespeare.diy'];
  const remote = buildNgitRemoteUrl(NPUB, 'hello-world', discoverRelays);
  const c = decodeNgitRemote({ remotes: { ngit: remote } });
  assert.equal(c?.identifier, 'hello-world');
  assert.deepEqual(c?.relayHints, ['wss://relay.ngit.dev']);   // first grasp host
  assert.ok((c?.relayHints.length ?? 0) > 0, 'relayHints is non-empty');
});

// ── publishEventToRelays ────────────────────────────────────────────────
//
// Round-trip test against an in-process WebSocketServer mock. Stands up
// two relays — one that ACK's the EVENT, one that NACK's — then asserts
// the per-relay results.

import { WebSocketServer } from 'ws';
import { AddressInfo } from 'net';

const { publishEventToRelays } = await import('../src/lib/routes/repo.ts');

function startMockRelay(behavior: 'accept' | 'reject'): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (Array.isArray(msg) && msg[0] === 'EVENT' && msg[1]?.id) {
            const id = msg[1].id;
            if (behavior === 'accept') ws.send(JSON.stringify(['OK', id, true, '']));
            else                       ws.send(JSON.stringify(['OK', id, false, 'mock-rejected']));
          }
        } catch { /* ignore */ }
      });
    });
    wss.on('listening', () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({
        url:   `ws://127.0.0.1:${port}`,
        close: () => wss.close(),
      });
    });
  });
}

test('publishEventToRelays: parses OK true → ok=true', async () => {
  const relay = await startMockRelay('accept');
  try {
    const event = { id: 'a'.repeat(64), kind: 30617, tags: [], pubkey: 'b'.repeat(64), created_at: 1, content: '', sig: 'x' };
    const results = await publishEventToRelays(event, [relay.url], 2000);
    assert.equal(results.length, 1);
    assert.equal(results[0].relay, relay.url);
    assert.equal(results[0].ok, true);
  } finally { relay.close(); }
});

test('publishEventToRelays: parses OK false → ok=false with reason', async () => {
  const relay = await startMockRelay('reject');
  try {
    const event = { id: 'c'.repeat(64), kind: 30617, tags: [], pubkey: 'd'.repeat(64), created_at: 1, content: '', sig: 'x' };
    const results = await publishEventToRelays(event, [relay.url], 2000);
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.equal(results[0].reason, 'mock-rejected');
  } finally { relay.close(); }
});

test('publishEventToRelays: parallel relays — mixed accept + reject reflected per-relay', async () => {
  // Establishes that the per-relay results array preserves which relay
  // returned what — important UX so we can list reasons in the toast.
  const a = await startMockRelay('accept');
  const r = await startMockRelay('reject');
  try {
    const event = { id: 'e'.repeat(64), kind: 30617, tags: [], pubkey: 'f'.repeat(64), created_at: 1, content: '', sig: 'x' };
    const results = await publishEventToRelays(event, [a.url, r.url], 2000);
    const byRelay = Object.fromEntries(results.map(x => [x.relay, x]));
    assert.equal(byRelay[a.url].ok, true);
    assert.equal(byRelay[r.url].ok, false);
    assert.equal(byRelay[r.url].reason, 'mock-rejected');
  } finally { a.close(); r.close(); }
});

test('publishEventToRelays: relay that never responds → ok=false reason="timeout"', async () => {
  // Mock relay that accepts the connection but ignores EVENT — the
  // helper must time out cleanly and surface "timeout" as the reason
  // rather than hanging.
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', () => { /* swallow */ });
  await new Promise<void>(r => wss.on('listening', () => r()));
  const port = (wss.address() as AddressInfo).port;
  try {
    const event = { id: 'g'.repeat(64), kind: 30617, tags: [], pubkey: 'h'.repeat(64), created_at: 1, content: '', sig: 'x' };
    const results = await publishEventToRelays(event, [`ws://127.0.0.1:${port}`], 300);
    assert.equal(results[0].ok, false);
    assert.equal(results[0].reason, 'timeout');
  } finally { wss.close(); }
});

// ── mergeRelaySet: shared read/publish relay-set builder ──────────────────
//
// Note 2 from review: a naive append-then-slice drops App Relays when the
// primary list already fills the cap. mergeRelaySet reserves slots so the
// App Relays (the guaranteed announcement home) survive the cap.

test('mergeRelaySet: dedupes across primary + app and preserves primary order', () => {
  const out = mergeRelaySet(
    ['wss://a', 'wss://b', 'wss://a'],
    ['wss://b', 'wss://c'],
  );
  assert.deepEqual(out, ['wss://a', 'wss://b', 'wss://c']);
});

test('mergeRelaySet: App Relays are NOT crowded out when primary fills the cap', () => {
  // 12 distinct primary relays + 2 App Relays, cap 12. A naive append+slice
  // would keep only the 12 primary and drop both App Relays (the stranding
  // bug). The reserve guarantees the App Relays survive.
  const primary = Array.from({ length: 12 }, (_, i) => `wss://p${i}`);
  const app     = ['wss://app1', 'wss://app2'];
  const out = mergeRelaySet(primary, app, { cap: 12, appReserve: 6 });
  assert.equal(out.length, 12);
  assert.ok(out.includes('wss://app1'), 'app1 retained');
  assert.ok(out.includes('wss://app2'), 'app2 retained');
  // Reserve = 6, so 6 primary slots are yielded to make room (12 - 2 app = 10
  // primary kept; the 2 reserved app slots are filled, 4 reserve unused).
  assert.equal(out.filter(r => r.startsWith('wss://p')).length, 10);
});

test('mergeRelaySet: invalid relay URLs filtered out', () => {
  const out = mergeRelaySet(['not-a-url', 'wss://ok'], ['http://nope', 'wss://app']);
  assert.deepEqual(out, ['wss://ok', 'wss://app']);
});

test('mergeRelaySet: leftover App Relays backfill spare capacity past the reserve', () => {
  // 8 App Relays, reserve 6, no primary, cap 12 → all 8 fit (6 reserved + 2
  // backfilled). Confirms the reserve is a floor, not a ceiling.
  const app = Array.from({ length: 8 }, (_, i) => `wss://app${i}`);
  const out = mergeRelaySet([], app, { cap: 12, appReserve: 6 });
  assert.equal(out.length, 8);
});

// ── Bug 1: fetchRepoMeta must find an announcement reachable ONLY on App Relays
//
// The exact stranded-Overview scenario: an ngit project whose remote is the
// bare `nostr://<npub>/<d-tag>` form (empty relayHints), with a dead GRASP
// override and no project read relays — but the 30617 WAS published to the
// user's App Relays. The old union (relayHints+grasp+projRelays) excluded the
// App Relays, so the announcement it had successfully published was
// structurally unreadable. With App Relays in the union it must be found.

function startMockRepoRelay(event: any): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        let msg: any;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (!Array.isArray(msg)) return;
        if (msg[0] === 'REQ') {
          const subId = msg[1];
          ws.send(JSON.stringify(['EVENT', subId, event]));
          ws.send(JSON.stringify(['EOSE', subId]));
        }
      });
    });
    wss.on('listening', () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({ url: `ws://127.0.0.1:${port}`, close: () => wss.close() });
    });
  });
}

// A reachable-but-silent relay: accepts the connection and the REQ but never
// returns an EVENT/EOSE. Models a dead/unhelpful GRASP server faithfully
// WITHOUT a fast connection-error that could end the one-shot query early
// (queryRelaysDirect finishes once every socket has closed) — so the test
// deterministically depends on the App-Relay mock being queried.
function startSilentRelay(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on('connection', () => { /* swallow everything */ });
    wss.on('listening', () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({ url: `ws://127.0.0.1:${port}`, close: () => wss.close() });
    });
  });
}

test('fetchRepoMeta: finds a 30617 reachable ONLY on App Relays (bare remote, dead grasp, no projRelays)', async () => {
  const event = {
    id:         'f'.repeat(64),
    pubkey:     HEX,                       // matches NPUB used in the remote
    kind:       30617,
    created_at: 1_700_000_000,
    tags:       [['d', 'app-only-repo'], ['name', 'App Only Repo']],
    content:    '',
    sig:        '0'.repeat(128),
  };
  const relay      = await startMockRepoRelay(event);
  const deadGrasp  = await startSilentRelay();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-repo-'));
  try {
    const project: any = {
      id:        'a'.repeat(12),
      path:      tmp,
      // Bare 2-part remote → decodeNgitRemote yields relayHints = [].
      remotes:   { ngit: `nostr://${NPUB}/app-only-repo` },
      readRelays: [],                      // no project read relays
    };
    // Sanity: the remote really does decode to empty relayHints.
    assert.deepEqual(decodeNgitRemote(project)?.relayHints, []);

    const result = await fetchRepoMeta(project, true, {
      getGrasp:     () => [deadGrasp.url],   // reachable but returns nothing
      getAppRelays: () => [relay.url],       // the announcement's only home
    });
    assert.ok(result.repo, 'announcement should be found via App Relays');
    assert.equal(result.repo?.identifier, 'app-only-repo');
    assert.equal(result.repo?.name, 'App Only Repo');
  } finally {
    relay.close();
    deadGrasp.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

test('fetchRepoMeta: without App Relays in the union the same announcement is NOT found (regression guard)', async () => {
  // Pins the failure mode: if the union excludes App Relays (old behavior),
  // the relay set is empty (no relayHints, no grasp, no projRelays) so the
  // announcement — live on the mock below, which is deliberately NOT in the
  // set — is unreadable. Guards against a future refactor dropping the
  // App-Relay fallback.
  const event = {
    id: 'e'.repeat(64), pubkey: HEX, kind: 30617, created_at: 1_700_000_000,
    tags: [['d', 'app-only-repo']], content: '', sig: '0'.repeat(128),
  };
  const relay = await startMockRepoRelay(event);   // running, but never queried
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-repo-'));
  try {
    const project: any = {
      id: 'b'.repeat(12), path: tmp,
      remotes: { ngit: `nostr://${NPUB}/app-only-repo` }, readRelays: [],
    };
    const result = await fetchRepoMeta(project, true, {
      getGrasp:     () => [],
      getAppRelays: () => [],                                // App Relays empty
    });
    assert.equal(result.repo, null);
  } finally {
    relay.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

// ── Feature A: `relays` tag advertises where the event is actually published ─
//
// The form's "Other relays" default + the guard-rail union ensure the written
// `relays` tag covers GRASP ∪ App Relays without ever dropping the in-use
// GRASP servers, while respecting a user's deliberate App-Relay removal.

test('computeSuggestedOtherRelays: App relays minus GRASP, deduped, invalid filtered', () => {
  const grasp = ['wss://relay.ngit.dev', 'wss://git.shakespeare.diy'];
  const app   = ['wss://relay.damus.io', 'wss://relay.ngit.dev', 'wss://nos.lol', 'wss://nos.lol', 'not-a-url'];
  assert.deepEqual(
    computeSuggestedOtherRelays(app, grasp),
    ['wss://relay.damus.io', 'wss://nos.lol'],   // ngit.dev removed (grasp), dupe + invalid dropped
  );
});

test('first-publish defaults: GRASP ∪ "Other relays" default == GRASP ∪ App Relays', () => {
  // The form advertises grasp (suggestedGraspServers) + other (suggestedOtherRelays);
  // their union must equal GRASP ∪ App Relays so the relays tag matches the
  // publish targets by default.
  const grasp = ['wss://relay.ngit.dev', 'wss://git.shakespeare.diy'];
  const app   = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.ngit.dev'];
  const other = computeSuggestedOtherRelays(app, grasp);
  const formUnion = [...new Set([...grasp, ...other])].sort();
  const expected  = [...new Set([...grasp, ...app])].sort();
  assert.deepEqual(formUnion, expected);
});

test('mergeRelaysTagValues: form order preserved, required (grasp) appended, deduped', () => {
  assert.deepEqual(
    mergeRelaysTagValues(['wss://nos.lol', 'wss://relay.ngit.dev'], ['wss://relay.ngit.dev', 'wss://git.shakespeare.diy']),
    ['wss://nos.lol', 'wss://relay.ngit.dev', 'wss://git.shakespeare.diy'],
  );
});

test('buildRepoAnnounceTemplate: relays tag ALWAYS advertises in-use GRASP even when form relays empty', () => {
  // Guard rail: a re-announce with no form relays must still publish a
  // `relays` tag carrying the in-use grasp — otherwise nostr:// clones break.
  const tpl = buildRepoAnnounceTemplate(
    { identifier: 'blip', relays: [], requiredRelays: ['wss://relay.ngit.dev'] },
    null,
    ANCHOR_HEX,
  );
  assert.deepEqual(tpl.tags.find(t => t[0] === 'relays'), ['relays', 'wss://relay.ngit.dev']);
});

test('buildRepoAnnounceTemplate: re-announce never drops the in-use GRASP servers from relays', () => {
  // User kept only App Relays in the form (trimmed grasp); the guard rail
  // re-adds the in-use grasp so the announcement still advertises it.
  const tpl = buildRepoAnnounceTemplate(
    { identifier: 'blip', relays: ['wss://relay.damus.io'], requiredRelays: ['wss://relay.ngit.dev'] },
    null,
    ANCHOR_HEX,
  );
  const relays = tpl.tags.find(t => t[0] === 'relays');
  assert.ok(relays?.includes('wss://relay.ngit.dev'), 'in-use grasp retained');
  assert.ok(relays?.includes('wss://relay.damus.io'), 'app relay retained');
});

test('buildRepoAnnounceTemplate: App Relays are NOT force-re-added (anti-sticky) — only grasp is required', () => {
  // A user who removed an App Relay (it's absent from form relays) must not
  // see it forced back; requiredRelays carries grasp only.
  const tpl = buildRepoAnnounceTemplate(
    { identifier: 'blip', relays: ['wss://relay.ngit.dev'], requiredRelays: ['wss://relay.ngit.dev'] },
    null,
    ANCHOR_HEX,
  );
  const relays = tpl.tags.find(t => t[0] === 'relays');
  assert.deepEqual(relays, ['relays', 'wss://relay.ngit.dev']);
  assert.ok(!relays?.includes('wss://relay.damus.io'), 'removed app relay stays removed');
});

// ── Feature B: default-on, REMOVABLE nostr-station topic ──────────────────

test('computeSuggestedHashtags: appends nostr-station; not doubled if keywords already have it', () => {
  assert.deepEqual(computeSuggestedHashtags(['rust', 'nostr']), ['rust', 'nostr', STATION_TOPIC]);
  assert.deepEqual(computeSuggestedHashtags([]), [STATION_TOPIC]);
  // Already present → kept once, no duplicate.
  const out = computeSuggestedHashtags(['nostr-station', 'app']);
  assert.deepEqual(out, ['nostr-station', 'app']);
  assert.equal(out.filter(t => t === STATION_TOPIC).length, 1);
});

test('buildRepoAnnounceTemplate: re-announce does NOT re-inject nostr-station when prior t tags lack it', () => {
  // Anti-sticky regression guard: the topic default lives in the form layer,
  // NOT in buildRepoAnnounceTemplate. On re-announce the form loads the prior
  // event's `t` tags into input.hashtags; if the user had removed
  // nostr-station, the output must not re-add it.
  const prior: any = {
    kind: 30617,
    tags: [['d', 'blip'], ['t', 'rust']],   // nostr-station deliberately absent
  };
  const tpl = buildRepoAnnounceTemplate(
    { identifier: 'blip', hashtags: ['rust'] },   // form-loaded prior topics, no station topic
    prior,
    ANCHOR_HEX,
  );
  const tTags = tpl.tags.filter(t => t[0] === 't').map(t => t[1]);
  assert.deepEqual(tTags, ['rust']);
  assert.ok(!tTags.includes(STATION_TOPIC), 'nostr-station NOT re-added on re-announce');
});

// ── normalizeTopic + server backstop ──────────────────────────────────────
//
// beacon published t="nostr-station," (trailing comma) because nothing
// stripped it. normalizeTopic is the shared contract; buildRepoAnnounceTemplate
// is the authoritative backstop so no client can publish a malformed t tag.

test('normalizeTopic: strips trailing comma / leading # / casing', () => {
  assert.equal(normalizeTopic('nostr-station,'), 'nostr-station');
  assert.equal(normalizeTopic('#Nostr-Station'), 'nostr-station');
  assert.equal(normalizeTopic('  #FOO,  '), 'foo');
});

test('normalizeTopic: collapses internal whitespace/commas to a single hyphen', () => {
  assert.equal(normalizeTopic(' a, b '), 'a-b');
  assert.equal(normalizeTopic('a b c'), 'a-b-c');
  assert.equal(normalizeTopic('hello   world'), 'hello-world');
});

test('normalizeTopic: empties / punctuation-only → ""', () => {
  assert.equal(normalizeTopic(''), '');
  assert.equal(normalizeTopic('   '), '');
  assert.equal(normalizeTopic(',,,'), '');
  assert.equal(normalizeTopic('###'), '');
  assert.equal(normalizeTopic('---'), '');
  assert.equal(normalizeTopic(null as any), '');
});

test('buildRepoAnnounceTemplate: backstop normalizes t tags (no comma, no #, lowercased)', () => {
  const tpl = buildRepoAnnounceTemplate(
    { identifier: 'blip', hashtags: ['nostr-station,', '#Foo'] },
    null,
    ANCHOR_HEX,
  );
  const tTags = tpl.tags.filter(t => t[0] === 't');
  assert.deepEqual(tTags, [['t', 'nostr-station'], ['t', 'foo']]);
});

test('buildRepoAnnounceTemplate: backstop drops empties and dedupes after normalization', () => {
  const tpl = buildRepoAnnounceTemplate(
    { identifier: 'blip', hashtags: ['Foo', 'foo,', ',,', '   ', '#FOO'] },
    null,
    ANCHOR_HEX,
  );
  const tTags = tpl.tags.filter(t => t[0] === 't');
  // 'Foo' / 'foo,' / '#FOO' all normalize to 'foo' → one tag; blanks dropped.
  assert.deepEqual(tTags, [['t', 'foo']]);
});

// ── Recovery prefill: euc is locally recoverable (deriveLocalEuc) ─────────
//
// When the announcement is genuinely missing, the synth prefill must still
// carry the repo's euc anchor — derived the SAME way ngit does (earliest root
// commit) so a recovery re-announce can't write a DIFFERENT euc and fork the
// coordinate.

function makeGitRepo(commits: number): { dir: string; rootSha: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-euc-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
  };
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  git('init', '-q');
  // Disable commit signing locally — some environments globally enable it
  // (gpg.program / commit.gpgsign), which would make `git commit` fail here.
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  let rootSha = '';
  for (let i = 0; i < commits; i++) {
    fs.writeFileSync(path.join(dir, `f${i}.txt`), `content ${i}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', `commit ${i}`);
    if (i === 0) rootSha = git('rev-list', '--max-parents=0', 'HEAD');
  }
  return { dir, rootSha };
}

test('deriveLocalEuc: returns the repo root commit for a checkout with history', async () => {
  const { dir, rootSha } = makeGitRepo(3);
  try {
    const euc = await deriveLocalEuc(dir);
    assert.match(euc, /^[0-9a-f]{40}$/);
    assert.equal(euc, rootSha, 'euc == earliest root commit');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('deriveLocalEuc: empty string when the path is not a git repo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-noeuc-'));
  try { assert.equal(await deriveLocalEuc(dir), ''); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recovery prefill: synth-prefill announce (no live 30617) carries the derived euc, matching a normal re-announce', async () => {
  const { dir, rootSha } = makeGitRepo(2);
  try {
    // suggestedEuc / synthRepoPrefill source the euc from deriveLocalEuc.
    const euc = await deriveLocalEuc(dir);
    const synth = buildRepoAnnounceTemplate(
      {
        identifier: 'beacon',
        euc,                                   // ← was '' before the fix (euc dropped)
        relays: ['wss://relay.ngit.dev'],
        clone:  ['https://relay.ngit.dev/npub/beacon.git'],
      },
      null,                                    // no live event — genuine recovery
      ANCHOR_HEX,
    );
    const rTag = synth.tags.find(t => t[0] === 'r');
    assert.deepEqual(rTag, ['r', rootSha, 'euc'], 'synth re-announce carries the euc anchor');

    // A normal re-announce prefills euc from the live event; with the same euc
    // value the `r` tag is byte-identical — i.e. recovery never forks the
    // coordinate by writing a different euc than a normal re-announce would.
    const normal = buildRepoAnnounceTemplate({ identifier: 'beacon', euc: rootSha }, null, ANCHOR_HEX);
    assert.deepEqual(rTag, normal.tags.find(t => t[0] === 'r'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
