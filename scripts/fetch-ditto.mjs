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
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const DITTO_URL = 'https://gitlab.com/api/v4/projects/79646323/jobs/artifacts/main/download?job=build-web';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = path.resolve(here, '..');
const TARGET_DIR = path.resolve(REPO_ROOT, 'dist', 'ditto');
const SENTINEL   = path.join(TARGET_DIR, 'index.html');
// Separate sentinel for the branding-applied state. If extraction
// succeeded but branding wasn't applied yet (first build after the
// branding feature lands), we re-apply without re-downloading.
//
// Versioned: when the branding payload grows new files (e.g. the
// station-signer.js shim) the sentinel's first line must match the
// current version or we re-run branding. Bump BRANDING_VERSION any
// time applyBranding() writes a new file or rewrites HTML in a way
// users on an existing install need picked up by `npm run build`.
const BRANDING_SENTINEL = path.join(TARGET_DIR, '.nostr-station-branded');
const BRANDING_VERSION  = 'v2-signer-shim';

function isBrandingCurrent() {
  if (!fs.existsSync(BRANDING_SENTINEL)) return false;
  try {
    const first = fs.readFileSync(BRANDING_SENTINEL, 'utf8').split('\n', 1)[0];
    return first === BRANDING_VERSION;
  } catch {
    return false;
  }
}

async function main() {
  if (process.env.STATION_SKIP_DITTO === '1') {
    console.log('[ditto] STATION_SKIP_DITTO=1 — skipping fetch.');
    return;
  }
  const needsFetch = !fs.existsSync(SENTINEL);
  const needsBranding = !isBrandingCurrent();
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

  // Extract using a pure-Node ZIP reader. We previously shelled out to
  // `unzip`, but it isn't reliably on PATH (minimal docker images, some
  // managed/cloud envs, fresh Windows installs without git-bash) and the
  // "Fetch Ditto" dashboard button surfaced the failure as ENOENT. zlib
  // is built into Node, so this avoids both the spawn and a new dep.
  fs.mkdirSync(TARGET_DIR, { recursive: true });
  try {
    extractZip(buf, TARGET_DIR);
  } catch (e) {
    console.warn(`[ditto] WARN: extraction failed — ${e.message}`);
    return;
  }

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

// Pure-Node ZIP extractor. Supports the only two compression methods
// GitLab CI artifact zips use in practice: stored (0) and deflate (8).
// Walks the Central Directory from the End-of-Central-Directory record
// rather than scanning sequentially, which is the standard ZIP read path
// and tolerates trailing junk / signed archives gracefully.
function extractZip(buf, destDir) {
  const EOCD_SIG = 0x06054b50;
  const CD_SIG   = 0x02014b50;
  const LFH_SIG  = 0x04034b50;

  // EOCD lives within the last 22 + 65535 bytes (the trailing comment
  // field is capped at 64 KiB by the spec). Scan backwards.
  let eocdOff = -1;
  const minOff = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= minOff; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocdOff = i; break; }
  }
  if (eocdOff < 0) throw new Error('not a ZIP (no EOCD record)');

  const totalEntries = buf.readUInt16LE(eocdOff + 10);
  const cdOffset     = buf.readUInt32LE(eocdOff + 16);
  // ZIP64 signal: 0xffffffff in the 32-bit fields. The 6 MiB GitLab
  // artifact won't hit this, but bail loudly if it ever does rather
  // than silently corrupt.
  if (cdOffset === 0xffffffff) throw new Error('ZIP64 archive not supported');

  const destResolved = path.resolve(destDir);
  let off = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(off) !== CD_SIG) {
      throw new Error(`malformed central directory at entry ${i}`);
    }
    const method     = buf.readUInt16LE(off + 10);
    const compSize   = buf.readUInt32LE(off + 20);
    const nameLen    = buf.readUInt16LE(off + 28);
    const extraLen   = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const extAttr    = buf.readUInt32LE(off + 38);
    const localOff   = buf.readUInt32LE(off + 42);
    const name       = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    off += 46 + nameLen + extraLen + commentLen;

    if (buf.readUInt32LE(localOff) !== LFH_SIG) {
      throw new Error(`malformed local file header for ${name}`);
    }
    const lfhNameLen  = buf.readUInt16LE(localOff + 26);
    const lfhExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lfhNameLen + lfhExtraLen;

    // Path-traversal guard — refuse any entry that escapes destDir.
    const outPath = path.resolve(destResolved, name);
    if (outPath !== destResolved && !outPath.startsWith(destResolved + path.sep)) {
      throw new Error(`refusing to extract outside dest: ${name}`);
    }

    // Directory entries: name ends with '/', no data.
    if (name.endsWith('/')) {
      fs.mkdirSync(outPath, { recursive: true });
      continue;
    }

    const compData = buf.subarray(dataOff, dataOff + compSize);
    let data;
    if (method === 0) {
      data = compData;
    } else if (method === 8) {
      data = zlib.inflateRawSync(compData);
    } else {
      throw new Error(`unsupported compression method ${method} for ${name}`);
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, data);

    // Preserve Unix mode bits if present (upper 16 bits of external
    // attrs when "version made by" is Unix). Bundled JS/CSS/HTML don't
    // need exec bits, but matches what `unzip` did before.
    const unixMode = (extAttr >>> 16) & 0o777;
    if (unixMode) {
      try { fs.chmodSync(outPath, unixMode); } catch {}
    }
  }
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

  // 1b. station-signer.js — the NIP-07 shim that routes window.nostr
  //     through the station's saved bunker pairing. Copied alongside
  //     Ditto's own assets and pulled in via a <script> injected into
  //     index.html below. The shim itself decides whether to install
  //     based on a localStorage flag, so shipping it is harmless even
  //     for users who want to keep using their browser extension.
  //     Looked up in src/web/ (dev) or dist/web/ (built, npm-installed).
  const signerCandidates = [
    path.join(REPO_ROOT, 'src',  'web', 'station-signer.js'),
    path.join(REPO_ROOT, 'dist', 'web', 'station-signer.js'),
  ];
  const sourceSigner = signerCandidates.find(p => fs.existsSync(p));
  const targetSigner = path.join(TARGET_DIR, 'station-signer.js');
  if (sourceSigner) {
    try {
      fs.copyFileSync(sourceSigner, targetSigner);
      console.log('[ditto] copied station-signer.js into bundle');
    } catch (e) {
      console.warn(`[ditto] WARN: station-signer copy failed — ${e.message}`);
    }
  } else {
    console.warn(`[ditto] WARN: station-signer source not found in src/web or dist/web; station-side signing won't work in Ditto`);
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
      // Inject the station-signer shim as the first <script> in <head>
      // — it MUST run before Ditto's main module bundle so it can claim
      // window.nostr before Ditto reads it for NIP-07 detection.
      // Inserted right after the opening <head> tag so it precedes
      // everything (Ditto's CSP allows 'self' scripts, which this is).
      // Idempotent: a marker class guards re-injection if applyBranding
      // ever runs against an already-branded bundle.
      if (!/data-station-signer/.test(html)) {
        html = html.replace(
          /<head>/i,
          '<head>\n    <script data-station-signer src="/ditto/station-signer.js"></script>',
        );
      }
      fs.writeFileSync(indexPath, html);
      console.log('[ditto] patched index.html (title + meta tags + theme-color + signer shim)');
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
    fs.writeFileSync(BRANDING_SENTINEL, BRANDING_VERSION + '\n' + new Date().toISOString() + '\n');
    console.log('[ditto] branding complete.');
  } catch (e) {
    console.warn(`[ditto] WARN: sentinel write failed — ${e.message}`);
  }
}

main().catch(e => {
  console.warn(`[ditto] WARN: unexpected error — ${e.message}`);
  // Don't fail the build.
});
