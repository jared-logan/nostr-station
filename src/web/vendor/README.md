# Vendored browser libraries

These files ship as part of the dashboard. They're committed verbatim
because:

- nostr-station runs locally and must stay functional without internet.
- We have no bundler in the web layer (intentionally — the dashboard is
  plain HTML/CSS/JS for transparency and editability).
- The npm packages either don't ship browser-ready bundles
  (`highlight.js`) or only ship them under non-`.min` filenames
  (`marked`).

## Files

| File                  | Source                                                    | Notes |
|-----------------------|-----------------------------------------------------------|-------|
| `marked.umd.js`       | `node_modules/marked/lib/marked.umd.js`                   | UMD; exposes `window.marked`. Un-minified — the package no longer ships a `.min` build, but it's already small (~42 kB). |
| `dompurify.min.js`    | `node_modules/dompurify/dist/purify.min.js`               | UMD; exposes `window.DOMPurify`. |

## To refresh

```sh
npm install --save-dev marked dompurify
cp node_modules/marked/lib/marked.umd.js   src/web/vendor/marked.umd.js
cp node_modules/dompurify/dist/purify.min.js src/web/vendor/dompurify.min.js
```

Then bump versions noted in this file and verify the dashboard renders
markdown correctly (check any project's README via the Code tab).

## Future

Phase 1c will add `highlight.js` for syntax highlighting in the file
viewer. Because `highlight.js` v11 ships only CJS / ESM (no IIFE
browser bundle), it'll require either a small build script that runs
esbuild, or a one-shot fetch from cdnjs with an integrity check —
TBD when 1c lands.
