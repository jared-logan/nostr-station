#!/usr/bin/env node
// Build Ditto from source with a baked nostr-station ditto.json so the
// dashboard's Client panel can serve it as embedded static files.
//
// Why source-compile instead of fetching GitLab CI artifacts (the
// previous approach):
//   - Ditto's `ditto.json` is read at *build time* per Ditto's docs
//     (https://about.ditto.pub/self-hosting). Dropping a JSON file
//     into a pre-built bundle has no effect, so the custom theme /
//     relays / appName / blossom servers we wanted never took.
//   - With a source build, our ditto.json drives Ditto's actual UI
//     (theme colors, fonts, background, title) AND the NIP-89 client
//     tag via `appName`: Ditto's useNostrPublish hook appends
//     ["client", appName, …] to every outgoing kind-1/6/7/1111
//     event. Setting appName: "nostr-station" gives every post from
//     the Client panel network-wide attribution.
//   - Pinned to a specific upstream commit (DITTO_REF below) instead
//     of rolling-latest from a third party's CI — bumps are
//     deliberate and reviewable.
//
// Pipeline:
//   1. Clone soapbox-pub/ditto pinned to DITTO_REF into .ditto-src/
//   2. Write ditto.json at the clone root (read at build time)
//   3. npm ci + npm run build inside the clone
//   4. Copy <clone>/dist → dist/ditto/
//   5. applyBranding() patches over the build for things ditto.json
//      doesn't cover (favicon swap, og:* / twitter:* meta cleanup,
//      manifest name).
//
// Behavior:
//   - Idempotent: re-running with an already-built dist/ditto/ at the
//     same DITTO_REF skips the clone+build. `npm run update-ditto`
//     deletes dist/ditto/ to force a fresh rebuild. Bumping DITTO_REF
//     also forces a rebuild on next run.
//   - STATION_SKIP_DITTO=1 short-circuits entirely (CI builds, air-
//     gapped installs).
//   - Failure is NON-FATAL — log a warning and continue. The Client
//     panel detects a missing index.html at runtime and surfaces a
//     clear "Ditto not installed" message with a retry hint, so the
//     rest of nostr-station still boots.
//
// The filename is kept as fetch-ditto.mjs (not renamed to build-ditto.mjs)
// so existing references in src/lib/web-server.ts, README, and shell
// muscle memory keep working. The work it does is now "build" but the
// intent — "make Ditto present in dist/ditto/" — is unchanged.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ─── Upstream pin ─────────────────────────────────────────────────────
// To bump: pick a SHA on soapbox-pub/ditto's `main` branch that you've
// validated (CI green, no breaking ditto.json schema changes), paste it
// here, run `npm run update-ditto`, smoke-test the Client panel. The
// ditto.json schema is strict (`unknown keys fail the build`), so any
// field rename upstream surfaces as a loud build failure rather than a
// silent regression.
const DITTO_REPO = 'https://gitlab.com/soapbox-pub/ditto.git';
const DITTO_REF  = '7a5820ca93f833b56cf368fc40c91e42c63f912f';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT   = path.resolve(here, '..');
const SRC_DIR     = path.resolve(REPO_ROOT, '.ditto-src');
const TARGET_DIR  = path.resolve(REPO_ROOT, 'dist', 'ditto');
const SENTINEL          = path.join(TARGET_DIR, 'index.html');
const BRANDING_SENTINEL = path.join(TARGET_DIR, '.nostr-station-branded');
// Records the upstream SHA the current dist/ditto/ was built from. If
// DITTO_REF is bumped and this file doesn't match, we rebuild even
// without `npm run update-ditto`.
const BUILT_FROM_SENTINEL = path.join(TARGET_DIR, '.ditto-built-from');

async function main() {
  if (process.env.STATION_SKIP_DITTO === '1') {
    console.log('[ditto] STATION_SKIP_DITTO=1 — skipping build.');
    return;
  }
  const builtFrom = readBuiltFrom();
  const needsBuild    = !fs.existsSync(SENTINEL) || builtFrom !== DITTO_REF;
  const needsBranding = !fs.existsSync(BRANDING_SENTINEL);
  if (!needsBuild && !needsBranding) {
    console.log(`[ditto] already built (${DITTO_REF.slice(0, 7)}) + branded at ${path.relative(process.cwd(), TARGET_DIR)} — skipping.`);
    console.log(`[ditto] (run \`npm run update-ditto\` to force a fresh build)`);
    return;
  }
  if (needsBuild) {
    if (builtFrom && builtFrom !== DITTO_REF) {
      console.log(`[ditto] DITTO_REF changed (${builtFrom.slice(0, 7)} → ${DITTO_REF.slice(0, 7)}) — rebuilding.`);
    }
    const ok = await cloneAndBuild();
    if (!ok) return;
  } else {
    console.log(`[ditto] bundle present but unbranded — applying branding only.`);
  }
  if (fs.existsSync(SENTINEL)) {
    applyBranding();
  }
}

function readBuiltFrom() {
  try { return fs.readFileSync(BUILT_FROM_SENTINEL, 'utf8').trim(); }
  catch { return null; }
}

async function cloneAndBuild() {
  // Wipe any stale clone so the SHA pin is honored deterministically —
  // a half-checked-out tree from a prior interrupted run is worse than
  // starting over.
  if (fs.existsSync(SRC_DIR)) {
    fs.rmSync(SRC_DIR, { recursive: true, force: true });
  }

  console.log(`[ditto] cloning ${DITTO_REPO} @ ${DITTO_REF.slice(0, 7)}`);
  // --filter=blob:none + --no-checkout + fetch by SHA gives us a shallow
  // partial clone of just the pinned commit. Faster than a full clone,
  // and the SHA fetch works against any commit on the remote (including
  // non-tip commits, which a plain `git clone --depth 1 --branch <sha>`
  // can't do because --branch needs a ref name not a SHA).
  if (!run('git', ['clone', '--filter=blob:none', '--no-checkout', DITTO_REPO, SRC_DIR])) return false;
  if (!run('git', ['-C', SRC_DIR, 'fetch', '--depth', '1', 'origin', DITTO_REF])) return false;
  if (!run('git', ['-C', SRC_DIR, 'checkout', DITTO_REF])) return false;

  // Write ditto.json BEFORE the build — Ditto reads it at build time
  // and bakes the values into the resulting bundle.
  const dittoJson = buildDittoConfig();
  try {
    fs.writeFileSync(
      path.join(SRC_DIR, 'ditto.json'),
      JSON.stringify(dittoJson, null, 2),
    );
    console.log('[ditto] wrote ditto.json (theme, relays, appName=nostr-station)');
  } catch (e) {
    console.warn(`[ditto] WARN: ditto.json write failed — ${e.message}`);
    return false;
  }

  console.log('[ditto] running npm ci (this can take a minute)…');
  if (!run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: SRC_DIR })) {
    console.warn(`[ditto] WARN: npm ci failed. Continuing without Ditto.`);
    return false;
  }

  console.log('[ditto] running npm run build…');
  if (!run('npm', ['run', 'build'], { cwd: SRC_DIR })) {
    console.warn(`[ditto] WARN: build failed. Continuing without Ditto.`);
    return false;
  }

  // Copy dist out into our published location.
  const builtDist = path.join(SRC_DIR, 'dist');
  if (!fs.existsSync(path.join(builtDist, 'index.html'))) {
    console.warn(`[ditto] WARN: built dist/index.html not found in ${builtDist}`);
    return false;
  }
  fs.rmSync(TARGET_DIR, { recursive: true, force: true });
  fs.mkdirSync(TARGET_DIR, { recursive: true });
  fs.cpSync(builtDist, TARGET_DIR, { recursive: true });

  try {
    fs.writeFileSync(BUILT_FROM_SENTINEL, DITTO_REF + '\n');
  } catch (e) {
    console.warn(`[ditto] WARN: built-from sentinel write failed — ${e.message}`);
  }

  console.log(`[ditto] built to ${path.relative(process.cwd(), TARGET_DIR)}`);

  // Best-effort cleanup of the source tree — it's gitignored and not
  // referenced after the copy. Skipping the rm on failure is fine; the
  // next run will wipe it anyway before re-cloning.
  try {
    fs.rmSync(SRC_DIR, { recursive: true, force: true });
  } catch {}

  return true;
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.error) {
    console.warn(`[ditto] WARN: ${cmd} ${args.join(' ')} errored — ${res.error.message}`);
    return false;
  }
  if (res.status !== 0) {
    console.warn(`[ditto] WARN: ${cmd} ${args.join(' ')} exited ${res.status}`);
    return false;
  }
  return true;
}

// Authoritative ditto.json. Schema is enforced strictly at Ditto build
// time by DittoConfigSchema (see /tmp/upstream src/lib/schemas.ts —
// AppConfigSchema.partial().strict()). Unknown keys fail the build, so
// every field below has been verified against upstream at DITTO_REF.
//
// HSL colors are space-separated "H S% L%" per Ditto's CoreThemeColors
// schema. Values sourced from nostr-station's palette:
//   --bg     #0a0a0a  → 0 0% 4%
//   --text   #c8c8d0  → 240 6% 80%
//   --accent #7B68EE  → 248 80% 67% (mediumslateblue)
function buildDittoConfig() {
  return {
    // ─── Identity ─────────────────────────────────────────────────
    // appName is the magic field: useNostrPublish.ts appends
    // ["client", appName] to every outgoing event when no naddr1 is
    // provided via `client`. To upgrade to the full NIP-89 form,
    // publish a kind-31990 handler event from a project-controlled
    // npub, encode it as naddr1, and add a `client` field here.
    appName: 'nostr-station',
    homePage: 'feed',

    // ─── Theme ────────────────────────────────────────────────────
    theme: 'custom',
    customTheme: {
      title: 'nostr-station',
      colors: {
        background: '0 0% 4%',
        text:       '240 6% 80%',
        primary:    '248 80% 67%',
      },
    },

    // ─── Relays ───────────────────────────────────────────────────
    // Mirrors nostr-station's App Relays defaults. useAppRelays=true
    // makes Ditto honor this list; updatedAt=0 so any user-side
    // override (kind-10002 list, in-app changes) supersedes.
    useAppRelays: true,
    useUserRelays: false,
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
}

// Overlay nostr-station branding on top of the source-built bundle.
// With ditto.json now honored, several historically-patched fields
// (title, theme-color) are baked in already — but applying the regex
// patches defensively is idempotent and forward-compatible if Ditto's
// schema drops one of those fields in a future bump.
//
// Categories that ditto.json doesn't cover and still need patching:
//   1. Logo SVG (we own the bytes, not just a name)
//   2. og:* / twitter:* social cards (point at ditto.pub by default)
//   3. PWA manifest.webmanifest install name + colors
//
// Idempotent: writes BRANDING_SENTINEL on success. Re-runs short-
// circuit unless the sentinel is missing.
function applyBranding() {
  console.log('[ditto] applying nostr-station branding…');

  // 1. Logo (also serves as favicon via Ditto's <link rel=icon>).
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

  // 2. index.html patches. ditto.json's `customTheme.title` controls
  //    Ditto's IN-APP rendered title (sidebar, header) but doesn't
  //    touch the <title> tag or social meta in the built index.html —
  //    those come from Ditto's static index.html template, baked in
  //    at build time. We still regex-patch them.
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
      // og:title / og:site_name / twitter:title — generic strings
      // mentioning "Ditto" become "nostr-station".
      html = html.replace(
        /(<meta\s+(?:property|name)="(?:og:title|og:site_name|twitter:title)"\s+content=")[^"]*("\s*\/?>)/g,
        '$1nostr-station$2',
      );
      html = html.replace(
        /(<meta\s+(?:property|name)="(?:og:description|twitter:description)"\s+content=")[^"]*("\s*\/?>)/g,
        '$1Nostr-native dev environment$2',
      );
      // og:url + og:image still point at ditto.pub by default; drop
      // them rather than redirect (we don't have a stable og image yet).
      html = html.replace(
        /<meta\s+property="og:(?:url|image|image:width|image:height|image:type)"[^>]*>\s*\n?/g,
        '',
      );
      html = html.replace(
        /<meta\s+name="twitter:image"[^>]*>\s*\n?/g,
        '',
      );
      // theme-color — Ditto ships TWO tags (one per color-scheme media
      // query) now. Match the dark one only; light mode keeps Ditto's
      // default (we don't have a light-mode palette).
      html = html.replace(
        /(<meta\s+name="theme-color"\s+content=")#161b2e("\s+media="\(prefers-color-scheme:\s*dark\)"\s*\/?>)/,
        '$1#0a0a0a$2',
      );
      // Fallback: also match a theme-color tag with no media query
      // (older Ditto builds).
      html = html.replace(
        /(<meta\s+name="theme-color"\s+content=")#161b2e("\s*\/?>)/,
        '$1#0a0a0a$2',
      );
      fs.writeFileSync(indexPath, html);
      console.log('[ditto] patched index.html (title + meta tags + theme-color)');
    } catch (e) {
      console.warn(`[ditto] WARN: index.html patch failed — ${e.message}`);
    }
  }

  // 3. manifest.webmanifest — PWA install name + colors. ditto.json
  //    doesn't expose manifest fields, so this stays regex-driven.
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
      manifest.background_color = '#0a0a0a';
      manifest.theme_color      = '#7B68EE';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      console.log('[ditto] patched manifest.webmanifest (name + colors)');
    } catch (e) {
      console.warn(`[ditto] WARN: manifest patch failed — ${e.message}`);
    }
  }

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
