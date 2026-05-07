#!/usr/bin/env node
// Copies src/scaffold-assets/ → dist/scaffold-assets/ after tsc runs.
// These are seed files written into newly-scaffolded user projects
// (currently just MCP configs that wire AI agents to nostrbook + js-dev).

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const src  = join(root, 'src', 'scaffold-assets');
const dst  = join(root, 'dist', 'scaffold-assets');

if (!existsSync(src)) {
  console.error(`copy-scaffold-assets: source not found at ${src}`);
  process.exit(1);
}

if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });

console.log(`copy-scaffold-assets: ${src} → ${dst}`);
