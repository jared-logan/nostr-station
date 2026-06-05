import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  buildAppTemplate, parseHandlerEvent,
  // @ts-expect-error — runtime .ts import
} = await import('../src/lib/routes/apps.ts');

const {
  CLIENT_TAG,
  // @ts-expect-error — runtime .ts import
} = await import('../src/lib/client-tag.ts');

function tagsOf(template: any, name: string): string[][] {
  return template.tags.filter((t: string[]) => t[0] === name);
}

test('buildAppTemplate: maps content fields into the kind-0-shaped JSON', () => {
  const r = buildAppTemplate({
    name: 'My App', about: 'does things', website: 'https://app.example',
    picture: 'https://img/i.png', banner: 'https://img/b.png',
    lud16: 'me@wallet.com', nip05: 'me@app.example',
  });
  assert.equal(r.ok, true);
  assert.equal(r.template.kind, 31990);
  const content = JSON.parse(r.template.content);
  assert.deepEqual(content, {
    name: 'My App', about: 'does things', website: 'https://app.example',
    picture: 'https://img/i.png', banner: 'https://img/b.png',
    lud16: 'me@wallet.com', nip05: 'me@app.example',
  });
});

test('buildAppTemplate: derives the d-tag from the name when none given', () => {
  const r = buildAppTemplate({ name: 'My Cool App!!' });
  assert.equal(r.ok, true);
  assert.deepEqual(tagsOf(r.template, 'd'), [['d', 'my-cool-app']]);
});

test('buildAppTemplate: an explicit d-tag is slugified and wins', () => {
  const r = buildAppTemplate({ name: 'Whatever', d: 'My Slug' });
  assert.deepEqual(tagsOf(r.template, 'd'), [['d', 'my-slug']]);
});

test('buildAppTemplate: name is required', () => {
  const r = buildAppTemplate({ about: 'no name' });
  assert.equal(r.ok, false);
});

test('buildAppTemplate: kinds become deduped k tags', () => {
  const r = buildAppTemplate({ name: 'A', kinds: [1, 6, 1, 30023] });
  assert.deepEqual(tagsOf(r.template, 'k'), [['k', '1'], ['k', '6'], ['k', '30023']]);
});

test('buildAppTemplate: invalid kind is rejected', () => {
  const r = buildAppTemplate({ name: 'A', kinds: [1, 'abc'] });
  assert.equal(r.ok, false);
});

test('buildAppTemplate: handlers become platform tags with optional entity', () => {
  const r = buildAppTemplate({
    name: 'A',
    handlers: [
      { platform: 'web', template: 'https://a/<bech32>', entity: 'nevent' },
      { platform: 'ios', template: 'a://<bech32>' },
    ],
  });
  assert.deepEqual(tagsOf(r.template, 'web'), [['web', 'https://a/<bech32>', 'nevent']]);
  assert.deepEqual(tagsOf(r.template, 'ios'), [['ios', 'a://<bech32>']]);
});

test('buildAppTemplate: handler missing the <bech32> placeholder is rejected', () => {
  const r = buildAppTemplate({ name: 'A', handlers: [{ platform: 'web', template: 'https://a/view' }] });
  assert.equal(r.ok, false);
});

test('buildAppTemplate: topics become deduped, lowercased t tags', () => {
  const r = buildAppTemplate({ name: 'A', topics: ['Client', 'relay', 'client'] });
  assert.deepEqual(tagsOf(r.template, 't'), [['t', 'client'], ['t', 'relay']]);
});

test('buildAppTemplate: extra tags pass through but cannot shadow structured tags', () => {
  const r = buildAppTemplate({
    name: 'A',
    extraTags: [['r', 'https://repo', 'source'], ['d', 'hijack'], ['k', '999'], ['client', 'evil']],
  });
  assert.deepEqual(tagsOf(r.template, 'r'), [['r', 'https://repo', 'source']]);
  // structured-tag names in extraTags are dropped
  assert.deepEqual(tagsOf(r.template, 'd'), [['d', 'a']]);
  assert.deepEqual(tagsOf(r.template, 'k'), []);
});

test('buildAppTemplate: always stamps the canonical 4-element client tag', () => {
  const r = buildAppTemplate({ name: 'A' });
  const client = tagsOf(r.template, 'client');
  assert.equal(client.length, 1);
  assert.deepEqual(client[0], [...CLIENT_TAG]);
  assert.equal(client[0].length, 4);
});

test('buildAppTemplate: client tag is not double-stamped via extraTags', () => {
  // even if an event round-trips, parseHandlerEvent strips the client tag,
  // so a republish gets exactly one canonical stamp.
  const r = buildAppTemplate({ name: 'A' });
  assert.equal(tagsOf(r.template, 'client').length, 1);
});

test('parseHandlerEvent: round-trips structured tags and routes the rest to extraTags', () => {
  const ev = {
    id: 'x'.repeat(64), pubkey: 'a'.repeat(64), created_at: 1, kind: 31990, sig: '', content:
      JSON.stringify({ name: 'Round Trip', about: 'about', picture: 'p', banner: 'b', website: 'w', lud16: 'l', nip05: 'n' }),
    tags: [
      ['d', 'round-trip'],
      ['k', '1'], ['k', '30023'],
      ['web', 'https://a/<bech32>', 'naddr'],
      ['t', 'client'],
      ['client', 'nostr-station', '31990:abc:nostr-station', 'wss://relay'],
      ['alt', 'some alt'],
      ['r', 'https://repo', 'source'],
    ],
  };
  const app = parseHandlerEvent(ev as any);
  assert.equal(app.d, 'round-trip');
  assert.equal(app.name, 'Round Trip');
  assert.deepEqual(app.kinds, [1, 30023]);
  assert.deepEqual(app.handlers, [{ platform: 'web', template: 'https://a/<bech32>', entity: 'naddr' }]);
  assert.deepEqual(app.topics, ['client']);
  // client + alt are bookkeeping (re-stamped on republish) → not in extraTags
  assert.deepEqual(app.extraTags, [['r', 'https://repo', 'source']]);
});

test('parse → build round-trip preserves the structured shape', () => {
  const ev = {
    id: 'x'.repeat(64), pubkey: 'a'.repeat(64), created_at: 1, kind: 31990, sig: '',
    content: JSON.stringify({ name: 'RT', about: 'a' }),
    tags: [['d', 'rt'], ['k', '1'], ['web', 'https://a/<bech32>'], ['t', 'x'], ['r', 'https://repo']],
  };
  const app = parseHandlerEvent(ev as any);
  const rebuilt = buildAppTemplate({
    name: app.name, d: app.d, about: app.about,
    kinds: app.kinds, handlers: app.handlers, topics: app.topics, extraTags: app.extraTags,
  });
  assert.equal(rebuilt.ok, true);
  assert.deepEqual(tagsOf(rebuilt.template, 'd'), [['d', 'rt']]);
  assert.deepEqual(tagsOf(rebuilt.template, 'k'), [['k', '1']]);
  assert.deepEqual(tagsOf(rebuilt.template, 'web'), [['web', 'https://a/<bech32>']]);
  assert.deepEqual(tagsOf(rebuilt.template, 't'), [['t', 'x']]);
  assert.deepEqual(tagsOf(rebuilt.template, 'r'), [['r', 'https://repo']]);
  assert.equal(tagsOf(rebuilt.template, 'client').length, 1);
});
