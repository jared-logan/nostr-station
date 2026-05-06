// Tiny templating engine — exercise variable interpolation, if/else,
// for-loops, and edge cases (missing vars, dot-paths, equality
// comparisons). The renderer is the foundation of the system-prompt
// pipeline; bugs here surface as broken AI prompts everywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPrompt } from '../src/lib/prompt-render.js';

// ── Variable interpolation ────────────────────────────────────────────────

test('interpolation: top-level variable', () => {
  assert.equal(renderPrompt('Hello, {{ name }}!', { name: 'world' }), 'Hello, world!');
});

test('interpolation: dot-path', () => {
  assert.equal(
    renderPrompt('Model: {{ model.fullId }}', { model: { fullId: 'claude-opus-4-7' } }),
    'Model: claude-opus-4-7',
  );
});

test('interpolation: missing variable → empty string', () => {
  assert.equal(renderPrompt('A{{ missing }}B', {}), 'AB');
});

test('interpolation: missing nested path → empty string', () => {
  assert.equal(renderPrompt('A{{ a.b.c }}B', { a: {} }), 'AB');
});

test('interpolation: numeric values render as strings', () => {
  assert.equal(renderPrompt('{{ n }}', { n: 42 }), '42');
});

test('interpolation: handles whitespace inside braces', () => {
  assert.equal(renderPrompt('{{    name    }}', { name: 'foo' }), 'foo');
});

// ── if/else ───────────────────────────────────────────────────────────────

test('if: truthy branch', () => {
  const tmpl = '{% if x %}YES{% endif %}';
  assert.equal(renderPrompt(tmpl, { x: true }),  'YES');
  assert.equal(renderPrompt(tmpl, { x: false }), '');
});

test('if/else: picks correct branch', () => {
  const tmpl = '{% if x %}A{% else %}B{% endif %}';
  assert.equal(renderPrompt(tmpl, { x: true }),  'A');
  assert.equal(renderPrompt(tmpl, { x: false }), 'B');
});

test('if: missing variable → falsy → else branch', () => {
  assert.equal(renderPrompt('{% if x %}A{% else %}B{% endif %}', {}), 'B');
});

test('if: empty string is falsy', () => {
  assert.equal(renderPrompt('{% if x %}A{% else %}B{% endif %}', { x: '' }), 'B');
});

test('if: empty array is falsy', () => {
  assert.equal(renderPrompt('{% if x %}A{% else %}B{% endif %}', { x: [] }), 'B');
});

test('if: empty object is truthy (matches Jinja)', () => {
  assert.equal(renderPrompt('{% if x %}A{% else %}B{% endif %}', { x: {} }), 'A');
});

test('if: equality literal', () => {
  const tmpl = '{% if mode === "init" %}init{% else %}edit{% endif %}';
  assert.equal(renderPrompt(tmpl, { mode: 'init' }), 'init');
  assert.equal(renderPrompt(tmpl, { mode: 'edit' }), 'edit');
});

test('if: inequality literal', () => {
  const tmpl = '{% if mode !== "init" %}other{% endif %}';
  assert.equal(renderPrompt(tmpl, { mode: 'edit' }), 'other');
  assert.equal(renderPrompt(tmpl, { mode: 'init' }), '');
});

test('if: nested', () => {
  const tmpl = '{% if a %}A{% if b %}B{% endif %}{% endif %}';
  assert.equal(renderPrompt(tmpl, { a: true, b: true }),  'AB');
  assert.equal(renderPrompt(tmpl, { a: true, b: false }), 'A');
  assert.equal(renderPrompt(tmpl, { a: false }), '');
});

// ── for ───────────────────────────────────────────────────────────────────

test('for: iterates list', () => {
  const tmpl = '{% for x in items %}[{{ x.name }}]{% endfor %}';
  const out = renderPrompt(tmpl, {
    items: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
  });
  assert.equal(out, '[A][B][C]');
});

test('for: empty list → empty output', () => {
  assert.equal(
    renderPrompt('start{% for x in items %}{{ x }}{% endfor %}end', { items: [] }),
    'startend',
  );
});

test('for: missing list → empty output', () => {
  assert.equal(
    renderPrompt('start{% for x in items %}{{ x }}{% endfor %}end', {}),
    'startend',
  );
});

test('for: outer scope still visible', () => {
  const tmpl = '{% for x in items %}{{ prefix }}{{ x }}{% endfor %}';
  assert.equal(
    renderPrompt(tmpl, { prefix: '> ', items: ['a', 'b'] }),
    '> a> b',
  );
});

// ── Combined / realistic ──────────────────────────────────────────────────

test('Shakespeare-style mode switch + template list', () => {
  const tmpl = `{% if mode === "init" %}You are starting from a template ({{ template.name }}).{% else %}You are continuing work on {{ project.name }}.{% endif %}

Available templates:
{% for t in templates %}- {{ t.name }}: {{ t.desc }}
{% endfor %}`;

  const initOut = renderPrompt(tmpl, {
    mode: 'init',
    template: { name: 'MKStack' },
    templates: [
      { name: 'MKStack', desc: 'Nostr React' },
      { name: 'Custom',  desc: 'Blank canvas' },
    ],
  });
  assert.match(initOut, /starting from a template \(MKStack\)/);
  assert.match(initOut, /- MKStack: Nostr React/);
  assert.match(initOut, /- Custom: Blank canvas/);

  const editOut = renderPrompt(tmpl, {
    mode: 'edit',
    project: { name: 'foo' },
    templates: [],
  });
  assert.match(editOut, /continuing work on foo/);
});

// ── Safety / robustness ───────────────────────────────────────────────────

test('does not execute code in templates', () => {
  // A user might put weird stuff in their override file; we should
  // emit it as literal text, not eval it.
  const tmpl = '{{ "literal" }}'; // Not a path → resolves to undefined → empty string.
  assert.equal(renderPrompt(tmpl, {}), '');
});

test('survives unbalanced curly braces in plain text', () => {
  const tmpl = 'Some {literal} text';
  assert.equal(renderPrompt(tmpl, {}), 'Some {literal} text');
});

test('renders multi-line templates verbatim', () => {
  const tmpl = 'Line 1\n{{ x }}\nLine 3';
  assert.equal(renderPrompt(tmpl, { x: 'two' }), 'Line 1\ntwo\nLine 3');
});
