# Vendored browser libraries

These files ship as part of the dashboard. They're committed verbatim
because:

- nostr-station runs locally and must stay functional without internet.
- We have no bundler in the web layer (intentionally — the dashboard is
  plain HTML/CSS/JS for transparency and editability).
- The npm packages either don't ship browser-ready bundles
  (`highlight.js`) or only ship them under non-`.min` filenames
  (`marked`).

The corresponding npm packages (`marked`, `dompurify`, `highlight.js`)
are deliberately **devDependencies**: nothing imports them at runtime —
production installs serve the committed copies in this directory. The
packages exist only so the refresh steps below have a source to copy
from.

## Files

| File                    | Source                                              | Notes |
|-------------------------|-----------------------------------------------------|-------|
| `marked.umd.js`         | `node_modules/marked/lib/marked.umd.js`             | UMD; exposes `window.marked`. Un-minified — the package no longer ships a `.min` build, but it's already small (~42 kB). |
| `dompurify.min.js`      | `node_modules/dompurify/dist/purify.min.js`         | UMD; exposes `window.DOMPurify`. |
| `highlight.min.js`      | bundled from `highlight.js/es/common.js` (~38 langs) | IIFE produced by `scripts/vendor-hljs.mjs`; exposes `window.hljs`. |
| `highlight-theme.css`   | `node_modules/highlight.js/styles/atom-one-dark.min.css` | Token-class colors only — no layout. Pairs with the dashboard's dark default. |

## To refresh

```sh
npm install --save-dev marked dompurify highlight.js
cp node_modules/marked/lib/marked.umd.js     src/web/vendor/marked.umd.js
cp node_modules/dompurify/dist/purify.min.js src/web/vendor/dompurify.min.js
node scripts/vendor-hljs.mjs                 # rebuilds highlight.min.js + theme
```

Then bump versions noted in this file and verify the dashboard renders
markdown correctly (check any project's README via the Code tab).

## On `highlight.js` bundling

The npm package only ships CommonJS (`lib/`) and native ESM (`es/`) —
no IIFE / browser bundle. The dashboard intentionally has no client-
side bundler, so `scripts/vendor-hljs.mjs` uses the esbuild that
ships transitively with `tsx` to produce a self-contained IIFE from
the `common.js` entry (~38 most-popular languages).

The full bundle (`es/index.js`, ~190 langs) is ~3× the size and adds
nothing the dashboard renders today; if a fenced block appears in
the wild that needs a missing language, swap the entry point and
regenerate.
