import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure helper — no HOME isolation needed.
// @ts-expect-error — runtime import of .ts; tsx handles resolution
const editor = await import('../src/lib/editor.ts');
const { extractUserRegion, USER_REGION_BEGIN, USER_REGION_END } = editor;

// ── happy path ───────────────────────────────────────────────────────────

test('extractUserRegion: returns the content between markers (verbatim)', () => {
  const file = [
    '# Nori',
    'env stuff',
    USER_REGION_BEGIN,
    'My team prefers nip-23 for long form.',
    'Always sign with bunker A.',
    USER_REGION_END,
    '---',
  ].join('\n');
  const got = extractUserRegion(file);
  assert.equal(
    got,
    'My team prefers nip-23 for long form.\nAlways sign with bunker A.',
  );
});

test('extractUserRegion: strips a single leading + trailing newline (markdown breathing room)', () => {
  // The persona template emits markers on their own lines with one
  // newline of vertical breathing room — extracting should strip
  // just that, not the developer's intentional indentation inside.
  const file = `${USER_REGION_BEGIN}
  - bullet with leading spaces
  - second bullet
${USER_REGION_END}`;
  const got = extractUserRegion(file);
  assert.equal(got, '  - bullet with leading spaces\n  - second bullet');
});

// ── empty / absent region ────────────────────────────────────────────────

test('extractUserRegion: empty body between markers → empty string', () => {
  // First-generation NOSTR_STATION.md emits markers with nothing
  // between them. The extract round-trip must produce empty string,
  // not a stray newline that would slowly accumulate over re-runs.
  const file = `${USER_REGION_BEGIN}\n\n${USER_REGION_END}`;
  assert.equal(extractUserRegion(file), '');
});

test('extractUserRegion: markers absent → empty string', () => {
  // Pre-Nori NOSTR_STATION.md from 0.0.6 won't have markers. The
  // first regen needs to land cleanly with an empty user region.
  assert.equal(
    extractUserRegion('# Nostr Station — Dev Environment\n\nblah blah\n'),
    '',
  );
});

test('extractUserRegion: empty input → empty string', () => {
  assert.equal(extractUserRegion(''), '');
});

test('extractUserRegion: non-string input → empty string (defensive)', () => {
  // @ts-expect-error — testing runtime behavior on bad types
  assert.equal(extractUserRegion(null), '');
  // @ts-expect-error
  assert.equal(extractUserRegion(undefined), '');
  // @ts-expect-error
  assert.equal(extractUserRegion(42), '');
});

// ── malformed marker shapes ──────────────────────────────────────────────

test('extractUserRegion: only the begin marker → empty string', () => {
  // Half-written file (editor crashed mid-write, etc.) — refuse to
  // pick a region rather than guess where it ends.
  const file = `prelude\n${USER_REGION_BEGIN}\nmid-edit content`;
  assert.equal(extractUserRegion(file), '');
});

test('extractUserRegion: only the end marker → empty string', () => {
  const file = `prelude\nrandom content\n${USER_REGION_END}\nepilogue`;
  assert.equal(extractUserRegion(file), '');
});

test('extractUserRegion: end marker before begin marker → empty string', () => {
  // Markers reversed (the developer manually pasted them in the
  // wrong order). Don't try to be clever — refuse and re-emit on
  // the next regeneration.
  const file = `${USER_REGION_END}\nlost paragraph\n${USER_REGION_BEGIN}`;
  assert.equal(extractUserRegion(file), '');
});

test('extractUserRegion: duplicated begin marker → empty string', () => {
  // Ambiguous — multiple regions possible. Refuse to splice rather
  // than risk losing the developer's content by picking the wrong
  // pair. The spec is explicit: markers must appear exactly once.
  const file = [
    USER_REGION_BEGIN,
    'first',
    USER_REGION_END,
    'midstream',
    USER_REGION_BEGIN,  // dupe
    'second',
    USER_REGION_END,
  ].join('\n');
  assert.equal(extractUserRegion(file), '');
});

test('extractUserRegion: duplicated end marker → empty string', () => {
  const file = [
    USER_REGION_BEGIN,
    'content',
    USER_REGION_END,
    'midstream',
    USER_REGION_END,  // dupe
  ].join('\n');
  assert.equal(extractUserRegion(file), '');
});

// ── round-trip / preservation contract ───────────────────────────────────

test('extractUserRegion: round-trips arbitrary multi-line content verbatim', () => {
  // The whole point of the helper is that re-emitting markers around
  // the extracted body produces the same body next time. Pin that
  // contract here so a future "smart trim" doesn't quietly start
  // touching content the user wrote.
  const inner = `Line 1
Line 2 with **markdown** and \`code\`.

> Block quote.

\`\`\`
fenced code
multi line
\`\`\`

- list item 1
- list item 2`;
  const file = `${USER_REGION_BEGIN}\n${inner}\n${USER_REGION_END}`;
  const got = extractUserRegion(file);
  assert.equal(got, inner);

  // Now wrap it back and re-extract — should be byte-identical.
  const rewrapped = `# Nori\n\n${USER_REGION_BEGIN}\n${got}\n${USER_REGION_END}\n`;
  assert.equal(extractUserRegion(rewrapped), inner);
});

test('extractUserRegion: markers must match verbatim — variant text is rejected', () => {
  // Spec says markers appear "verbatim". A typo in the marker (e.g.
  // a developer hand-copied the BEGIN line and dropped the em-dash)
  // means we don't recognize the region — defensive behavior is to
  // return empty rather than guess at a fuzzy match.
  const fakeMarker = '<!-- BEGIN USER EDITS -->';  // missing the em-dash subtitle
  const file = `${fakeMarker}\nthought I was preserved\n${USER_REGION_END}`;
  assert.equal(extractUserRegion(file), '');
});
