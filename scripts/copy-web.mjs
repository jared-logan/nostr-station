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
