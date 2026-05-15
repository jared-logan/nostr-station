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
const REPO_ROOT  = path.resolve(here, '..');
const TARGET_DIR = path.resolve(REPO_ROOT, 'dist', 'ditto');
const SENTINEL   = path.join(TARGET_DIR, 'index.html');
// Separate sentinel for the branding-applied state. If extraction
// succeeded but branding wasn't applied yet (first build after the
// branding feature lands), we re-apply without re-downloading.
const BRANDING_SENTINEL = path.join(TARGET_DIR, '.nostr-station-branded');

async function main() {
  if (process.env.STATION_SKIP_DITTO === '1') {
    console.log('[ditto] STATION_SKIP_DITTO=1 — skipping fetch.');
    return;
  }
  const needsFetch = !fs.existsSync(SENTINEL);
  const needsBranding = !fs.existsSync(BRANDING_SENTINEL);
  if (!needsFetch && !needsBranding) {
    console.log(`[ditto] already present + branded at ${path.relative(process.cwd(), TARGET_DIR)} — skipping.`);
    console.log(`[ditto] (run \`npm run update-ditto\` to force a fresh download)`);
    return;
  }
  if (needsFetch) {
    await fetchAndExtract();
  } else {
    console.log(`[ditto] bundle present but unbranded — applying branding only.`);
  }
  if (fs.existsSync(SENTINEL)) {
    applyBranding();
  }
}

async function fetchAndExtract() {

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

// Overlay nostr-station branding on top of the extracted Ditto bundle.
// Three categories:
//   1. Files we own outright — copy our logo over Ditto's logo.svg.
//      Their <link rel="icon" type="image/svg+xml" href="/logo.svg">
//      makes this the favicon too, so one file covers both surfaces.
//   2. HTML / manifest patches — title, description, og:* / twitter:*
//      meta tags, theme-color, manifest name + short_name. Regex
//      replacements on the strings Ditto's pre-built bundle ships with.
//   3. Speculative ditto.json — Ditto's docs say its config is read
//      "at build time", which strictly speaking means a runtime drop-in
//      shouldn't take effect. We ship it anyway: zero cost if ignored,
//      free theming + default-relay alignment if Ditto's runtime ever
//      starts honoring it.
//
// Idempotent: writes .nostr-station-branded as a sentinel file on
// success. Re-runs short-circuit unless the sentinel is missing.
function applyBranding() {
  console.log('[ditto] applying nostr-station branding...');

  // 1. Logo (also serves as favicon via the <link rel=icon> in Ditto's
  //    index.html). nori.svg is nostr-station's mark — same SVG used
  //    elsewhere in the dashboard for visual consistency.
  const sourceLogo = path.join(REPO_ROOT, 'src', 'web', 'nori.svg');
  const targetLogo = path.join(TARGET_DIR, 'logo.svg');
  if (fs.existsSync(sourceLogo)) {
    try {
      fs.copyFileSync(sourceLogo, targetLogo);
      console.log(`[ditto] replaced logo.svg with nori.svg`);
    } catch (e) {
      console.warn(`[ditto] WARN: logo copy failed — ${e.message}`);
    }
  } else {
    console.warn(`[ditto] WARN: source logo not found at ${sourceLogo}; keeping Ditto's default`);
  }

  // 2a. index.html — title + description + og/twitter meta tags
  const indexPath = path.join(TARGET_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    try {
      let html = fs.readFileSync(indexPath, 'utf8');
      html = html.replace(
        /<title>[^<]*<\/title>/,
        '<title>nostr-station — Public Nostr Client</title>',
      );
      html = html.replace(
        /<meta name="description" content="[^"]*"\s*\/?>/,
        '<meta name="description" content="nostr-station — Nostr-native dev environment. Public Nostr client powered by Ditto." />',
      );
      // og:title / og:site_name / twitter:title — all the simple "Ditto"
      // strings become "nostr-station". og:description / twitter:description
      // get the same descriptor.
      html = html.replace(
        /(<meta\s+(?:property|name)="(?:og:title|og:site_name|twitter:title)"\s+content=")[^"]*("\s*\/?>)/g,
        '$1nostr-station$2',
      );
      html = html.replace(
        /(<meta\s+(?:property|name)="(?:og:description|twitter:description)"\s+content=")[^"]*("\s*\/?>)/g,
        '$1Nostr-native dev environment$2',
      );
      // og:url + og:image point at ditto.pub by default — drop them
      // rather than redirect (we don't have a stable og image yet).
      html = html.replace(
        /<meta\s+property="og:(?:url|image|image:width|image:height|image:type)"[^>]*>\s*\n?/g,
        '',
      );
      html = html.replace(
        /<meta\s+name="twitter:image"[^>]*>\s*\n?/g,
        '',
      );
      // theme-color — match nostr-station's dark background (#0a0a0a).
      // Ditto's default ('#161b2e') is a deep navy; ours is near-black.
      html = html.replace(
        /(<meta\s+name="theme-color"\s+content=")#161b2e(")/,
        '$1#0a0a0a$2',
      );
      fs.writeFileSync(indexPath, html);
      console.log('[ditto] patched index.html (title + meta tags + theme-color)');
    } catch (e) {
      console.warn(`[ditto] WARN: index.html patch failed — ${e.message}`);
    }
  }

  // 2b. manifest.webmanifest — PWA install name. Most users won't ever
  //     install Ditto as a PWA from inside our iframe, but if they do,
  //     it should say nostr-station.
  const manifestPath = path.join(TARGET_DIR, 'manifest.webmanifest');
  if (fs.existsSync(manifestPath)) {
    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(raw);
      manifest.name = 'nostr-station';
      manifest.short_name = 'nostr-station';
      if (typeof manifest.description === 'string') {
        manifest.description = 'nostr-station — Nostr-native dev environment.';
      }
      // PWA chrome colors — when the user installs Ditto as a standalone
      // app the OS uses these for the splash screen + title bar. Match
      // nostr-station's --bg (#0a0a0a) and --accent (#7B68EE) so the
      // installed app reads as nostr-station, not Ditto.
      manifest.background_color = '#0a0a0a';
      manifest.theme_color      = '#7B68EE';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      console.log('[ditto] patched manifest.webmanifest (name + short_name)');
    } catch (e) {
      console.warn(`[ditto] WARN: manifest patch failed — ${e.message}`);
    }
  }

  // 3. ditto.json — drop-in config. Per Ditto's docs this is read at
  //    build time, so a runtime drop-in shouldn't take effect on the
  //    pre-built bundle. Shipping anyway because: (a) zero cost if
  //    ignored, (b) free theme + relay-list alignment if Ditto's
  //    runtime ever starts honoring it, (c) makes our intent
  //    legible to anyone inspecting the bundle ("here's what
  //    nostr-station WANTS Ditto to look like").
  //
  //    Color values are HSL space-separated (H S% L%), matching
  //    Ditto's customTheme format. Sourced from nostr-station's
  //    palette (--bg #0a0a0a, --text #c8c8d0, --accent #7B68EE).
  //    Relay list mirrors our App Relays defaults.
  const dittoJson = {
    theme: 'custom',
    customTheme: {
      colors: {
        background: '0 0% 4%',
        text:       '240 6% 80%',
        primary:    '248 80% 67%',
      },
    },
    relayMetadata: {
      relays: [
        { url: 'wss://relay.damus.io',    read: true, write: true },
        { url: 'wss://relay.nostr.band',  read: true, write: true },
        { url: 'wss://nos.lol',           read: true, write: true },
        { url: 'wss://relay.primal.net',  read: true, write: true },
        { url: 'wss://relay.ditto.pub',   read: true, write: true },
      ],
      updatedAt: 0,
    },
  };
  try {
    fs.writeFileSync(
      path.join(TARGET_DIR, 'ditto.json'),
      JSON.stringify(dittoJson, null, 2),
    );
    console.log('[ditto] wrote ditto.json (speculative — may be ignored by pre-built bundle)');
  } catch (e) {
    console.warn(`[ditto] WARN: ditto.json write failed — ${e.message}`);
  }

  // Sentinel: any future `node scripts/fetch-ditto.mjs` invocation with
  // the bundle present + this file present → skip both fetch and
  // branding. `npm run update-ditto` (which deletes the whole dist/ditto
  // dir) re-runs everything from scratch.
  try {
    fs.writeFileSync(BRANDING_SENTINEL, new Date().toISOString() + '\n');
    console.log('[ditto] branding complete.');
  } catch (e) {
    console.warn(`[ditto] WARN: sentinel write failed — ${e.message}`);
  }
}

main().catch(e => {
  console.warn(`[ditto] WARN: unexpected error — ${e.message}`);
  // Don't fail the build.
});
