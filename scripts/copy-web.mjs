#!/usr/bin/env node
// Copies src/web/ → dist/web/ after tsc runs.
// We ship raw HTML/CSS/JS/SVG — no bundler, no minifier. Files are small,
// served from localhost, and stay readable for anyone inspecting the install.

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const src  = join(root, 'src', 'web');
const dst  = join(root, 'dist', 'web');

if (!existsSync(src)) {
  console.error(`copy-web: source not found at ${src}`);
  process.exit(1);
}

if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });

console.log(`copy-web: ${src} → ${dst}`);

// Migration cleanup: the embedded Ditto client was removed. Older installs
// have a built dist/ditto/ (and possibly a .ditto-src/ build scratch dir)
// left on disk from when scripts/fetch-ditto.mjs ran during the build.
// The dashboard no longer serves /ditto/* (serveDitto was deleted), so a
// stale bundle is already unreachable — but remove it on every build so a
// normal `git pull` + update leaves no Ditto artifacts behind. No-op once
// the directories are gone.
for (const stale of ['ditto']) {
  const p = join(root, 'dist', stale);
  if (existsSync(p)) {
    rmSync(p, { recursive: true, force: true });
    console.log(`copy-web: removed stale dist/${stale}/ (embedded Ditto client was removed)`);
  }
}
const scratch = join(root, '.ditto-src');
if (existsSync(scratch)) {
  rmSync(scratch, { recursive: true, force: true });
  console.log('copy-web: removed stale .ditto-src/ build scratch dir');
}
