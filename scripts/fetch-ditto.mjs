#!/usr/bin/env node
// Fetch + extract Ditto's pre-built web release into dist/ditto/ so the
// dashboard can serve it as embedded static files.
//
// Ditto (https://about.ditto.pub/self-hosting) ships as a static SPA —
// no backend, no DB, just HTML/CSS/JS. We bundle it as part of our
// build pipeline (call from `npm run build`) so the Client panel can
// iframe a local copy instead of redirecting offsite or maintaining our
// own client.
//
// Behavior:
//   - Idempotent: re-running with an already-extracted dist/ditto/
//     skips the download. Force-refresh by deleting dist/ditto/.
//   - STATION_SKIP_DITTO=1 short-circuits the fetch entirely (CI builds
//     that don't need Ditto, network-air-gapped installs).
//   - Failure is NON-FATAL — we log a warning and continue. The
//     dashboard's Client panel detects a missing index.html at runtime
//     and surfaces a clear "Ditto not installed" message with a retry
//     hint, so the rest of nostr-station still boots fine.
//
// Source: GitLab CI artifacts from the `build-web` job on `main`.
// Per Ditto's docs that link is "the latest pre-built release". For
// reproducible installs you could pin to a specific job id, but the
// rolling-latest tracks upstream improvements automatically.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DITTO_URL = 'https://gitlab.com/api/v4/projects/79646323/jobs/artifacts/main/download?job=build-web';

const here = path.dirname(fileURLToPath(import.meta.url));
const TARGET_DIR = path.resolve(here, '..', 'dist', 'ditto');
const SENTINEL   = path.join(TARGET_DIR, 'index.html');

async function main() {
  if (process.env.STATION_SKIP_DITTO === '1') {
    console.log('[ditto] STATION_SKIP_DITTO=1 — skipping fetch.');
    return;
  }
  if (fs.existsSync(SENTINEL)) {
    console.log(`[ditto] already present at ${path.relative(process.cwd(), TARGET_DIR)} — skipping fetch.`);
    console.log(`[ditto] (delete that directory to force a fresh download)`);
    return;
  }

  console.log(`[ditto] fetching ${DITTO_URL}`);
  let buf;
  try {
    const res = await fetch(DITTO_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    buf = Buffer.from(await res.arrayBuffer());
    console.log(`[ditto] downloaded ${(buf.length / (1024 * 1024)).toFixed(1)} MiB`);
  } catch (e) {
    console.warn(`[ditto] WARN: download failed — ${e.message}`);
    console.warn(`[ditto] Continuing without Ditto. The Client panel will show "Ditto not installed" at runtime.`);
    console.warn(`[ditto] Retry with: npm run build  (after fixing network)`);
    return;
  }

  // Write to a tmp file, extract via unzip, clean up. unzip is available
  // on every supported platform (macOS preinstalled, linux default-y,
  // Windows via git-bash / WSL). Falling back to a JS zip lib would
  // pull in a dep just for one file extraction — not worth it.
  const tmpZip = path.join(os.tmpdir(), `nostr-station-ditto-${Date.now()}.zip`);
  fs.writeFileSync(tmpZip, buf);
  fs.mkdirSync(TARGET_DIR, { recursive: true });

  try {
    execFileSync('unzip', ['-q', '-o', tmpZip, '-d', TARGET_DIR], { stdio: 'inherit' });
  } catch (e) {
    console.warn(`[ditto] WARN: unzip failed — ${e.message}`);
    console.warn(`[ditto] is the \`unzip\` binary on PATH?`);
    try { fs.unlinkSync(tmpZip); } catch {}
    return;
  }
  try { fs.unlinkSync(tmpZip); } catch {}

  // GitLab CI artifact zips occasionally wrap the build output in a
  // top-level subdirectory (e.g. dist/, build/). Flatten: if there's no
  // index.html at TARGET_DIR root but one subdir contains it, hoist
  // that subdir's contents up.
  if (!fs.existsSync(SENTINEL)) {
    const entries = fs.readdirSync(TARGET_DIR);
    let hoisted = false;
    for (const e of entries) {
      const sub = path.join(TARGET_DIR, e);
      let stat;
      try { stat = fs.statSync(sub); } catch { continue; }
      if (!stat.isDirectory()) continue;
      if (!fs.existsSync(path.join(sub, 'index.html'))) continue;
      console.log(`[ditto] hoisting build output from ${e}/`);
      for (const f of fs.readdirSync(sub)) {
        fs.renameSync(path.join(sub, f), path.join(TARGET_DIR, f));
      }
      fs.rmdirSync(sub);
      hoisted = true;
      break;
    }
    if (!hoisted) {
      console.warn(`[ditto] WARN: extracted zip but no index.html found in ${TARGET_DIR}`);
      console.warn(`[ditto] contents: ${entries.join(', ')}`);
      return;
    }
  }

  console.log(`[ditto] extracted to ${path.relative(process.cwd(), TARGET_DIR)}`);
}

main().catch(e => {
  console.warn(`[ditto] WARN: unexpected error — ${e.message}`);
  // Don't fail the build.
});
