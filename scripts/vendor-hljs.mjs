#!/usr/bin/env node
// One-shot vendoring script for highlight.js.
//
// The npm package only ships CommonJS (`lib/`) and native ESM (`es/`) —
// no IIFE / browser bundle. The dashboard has no client-side bundler
// (intentionally — see src/web/vendor/README.md), so we produce a
// self-contained IIFE here and commit it under src/web/vendor/.
//
// Run when bumping highlight.js or when fresh-cloning a checkout
// without the vendored bundle. Both the JS and one stylesheet are
// produced in one pass:
//
//     node scripts/vendor-hljs.mjs
//
// Output:
//   src/web/vendor/highlight.min.js    (the engine + ~38 common langs)
//   src/web/vendor/highlight-theme.css (atom-one-dark theme)
//
// The chosen entry — highlight.js/es/common.js — is the upstream
// curated subset (~38 most-common languages: js/ts/jsx/tsx/json/html/
// css/bash/python/go/rust/sql/markdown/yaml/...). The full bundle
// (highlight.js/es/index.js, ~190 langs) is ~3× the size and adds
// nothing the dashboard renders. Easy to swap if a future README
// fenced block points at an exotic language.

import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here  = dirname(fileURLToPath(import.meta.url));
const root  = dirname(here);
const out   = join(root, 'src', 'web', 'vendor');
mkdirSync(out, { recursive: true });

// JS bundle — IIFE exposing `window.hljs`. Minified to keep the
// committed file small (~140 kB minified vs ~430 kB unminified).
await build({
  entryPoints: [join(root, 'node_modules', 'highlight.js', 'es', 'common.js')],
  bundle:      true,
  minify:      true,
  format:      'iife',
  globalName:  'hljsModule',
  outfile:     join(out, 'highlight.min.js'),
  // Plant `window.hljs` from the module's default export (the IIFE
  // itself only assigns the namespace object to `hljsModule`).
  footer: { js: 'window.hljs = hljsModule.default || hljsModule;' },
  logLevel:    'warning',
});

// CSS theme — copy verbatim from the npm package. atom-one-dark
// matches the dashboard's dark palette; a switcher for light themes
// can come later if anyone asks.
copyFileSync(
  join(root, 'node_modules', 'highlight.js', 'styles', 'atom-one-dark.min.css'),
  join(out, 'highlight-theme.css'),
);

console.log(`vendor-hljs: wrote ${out}/highlight.min.js + highlight-theme.css`);
