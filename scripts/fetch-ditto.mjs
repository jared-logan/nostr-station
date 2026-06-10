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
import crypto from 'node:crypto';
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
// v2.21.0 release tag (2026-06-07). Bumped from 7a5820c (2026-05-24, just
// after v2.18.0) — 63 commits, 4 patch releases + 3 minor releases. Notable
// inheritance: v2.19.0 IndexedDB offline event cache + first-paint cache
// reads, v2.20.0 expanded global search (articles/lists/follow packs/emoji
// packs) + app handler /client/:name route, v2.21.0 Nostr Clients sidebar
// widget + Android share targets. Also picks up the fontLoader URL-
// sanitization security fix. Sticking to a release tag rather than tracking
// main HEAD — post-v2.21.0 main is mid-merge on a large unreleased "Blobbi"
// feature and we want a known-stable surface.
const DITTO_REF  = '734baf513aa59b365d3181b2cf6fc9fc0f98f986';

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

// Hash of the ditto.json content that buildDittoConfig() would write
// right now. Embedded in the BUILT_FROM_SENTINEL alongside DITTO_REF so
// the smart-rebuild logic can detect when our config output has changed
// since the last successful build — even when DITTO_REF itself is
// unchanged.
//
// Why this matters: ditto.json is read by Ditto's vite build at build
// time (see header comment at the top of this file). Changes to
// buildDittoConfig() only take effect after a full cloneAndBuild() run.
// Without this hash dimension, edits like dropping customTheme.font
// would silently fail to propagate via a typical `npm run update` — the
// existing dist/ditto/ matches DITTO_REF, needsBuild stays false, the
// stale ditto.json stays baked in. The fix that landed alongside this
// function makes any buildDittoConfig() diff invalidate the SENTINEL,
// which flips needsBuild to true on the next run, which triggers the
// full rebuild that picks up the new config.
//
// JSON.stringify on the literal object is deterministic in modern Node
// (key insertion order is preserved) so no manual sort needed — explicit
// key-order changes in source are real changes worth rebuilding for.
function currentBuildConfigHash() {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(buildDittoConfig()));
  // Skin layer file bytes (path + content). Any change to a skin file —
  // edit, add, delete — invalidates the sentinel so the next run does
  // a full clone+build that re-applies the skin into the new clone and
  // re-runs vite. We hash relative paths first so a file MOVE
  // invalidates even if content is byte-identical.
  const skinRoot = path.join(REPO_ROOT, 'src', 'web', 'ditto-skin');
  if (fs.existsSync(skinRoot)) {
    const files = listFilesRecursive(skinRoot).sort();
    for (const f of files) {
      hash.update(path.relative(skinRoot, f));
      hash.update('\0');
      try { hash.update(fs.readFileSync(f)); } catch { /* ignore */ }
    }
  }
  return hash.digest('hex').slice(0, 16);
}

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

// Skin layer: copies our TSX components from src/web/ditto-skin/ INTO the
// freshly-cloned Ditto source tree before `npm run build` runs. Files
// mirror the clone's src/ layout — src/web/ditto-skin/components/X.tsx
// overwrites .ditto-src/src/components/X.tsx, src/web/ditto-skin/skin/X.ts
// adds .ditto-src/src/skin/X.ts (the adapter file lives here so skin
// components can import upstream hooks via @/skin/adapter — a single
// indirection that absorbs upstream module-path churn on DITTO_REF bumps).
//
// The path-mirror convention is intentional: anyone editing a skin file
// can find the upstream original at the matching path under .ditto-src/src/.
//
// applySkin runs after ditto.json is written and before npm ci/build so
// the copied components participate in dependency install + bundle.
// No-op if src/web/ditto-skin/ doesn't exist yet (lets the script keep
// working on pre-skin-layer branches).
function applySkin() {
  const skinRoot = path.join(REPO_ROOT, 'src', 'web', 'ditto-skin');
  if (!fs.existsSync(skinRoot)) {
    console.log('[ditto] no skin layer at src/web/ditto-skin/ — using upstream shell as-is');
    return;
  }
  const cloneSrc = path.join(SRC_DIR, 'src');
  const files = listFilesRecursive(skinRoot);
  if (files.length === 0) {
    console.log('[ditto] skin layer directory empty — nothing to apply');
    return;
  }
  console.log(`[ditto] applying skin layer (${files.length} file${files.length === 1 ? '' : 's'})…`);
  for (const src of files) {
    const rel = path.relative(skinRoot, src);
    const dst = path.join(cloneSrc, rel);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      console.log(`[ditto]   skin: src/${rel}`);
    } catch (e) {
      console.warn(`[ditto] WARN: skin file copy failed for ${rel} — ${e.message}`);
    }
  }
}

// Hash of all branding inputs. Embedded in the branding sentinel so
// the script can detect when ANY input that feeds applyBranding() has
// changed since the last run — the script's own bytes, the overlay
// CSS, or the logo. Without this, the sentinel-exists check would
// short-circuit re-branding even after a new branding input lands.
//
// Inputs hashed (in order, must stay stable for sentinel comparison):
//   1. scripts/fetch-ditto.mjs       — this script (so logic changes
//                                      to applyBranding re-fire)
//   2. src/web/ditto-overrides.css   — overlay CSS copied to dist/
//                                      ditto/nostr-station-overrides.css
//   3. src/web/nori.svg              — logo copied to dist/ditto/logo.svg
//
// Real-world repros:
//   - PR #189 added an overlay-CSS copy step. End users pulling that
//     commit saw their dist/ditto/ stay untouched because the existing
//     .nostr-station-branded sentinel matched DITTO_REF and the
//     script's idempotency check exited early before applyBranding
//     could run again. PR #191 introduced the script-hash check to
//     fix that class of bug.
//   - PR #193 changed ONLY src/web/ditto-overrides.css. The script-
//     hash check from PR #191 did not invalidate (script bytes were
//     identical), so applyBranding() short-circuited and the new CSS
//     never reached dist/. Users had to run `npm run update-ditto`
//     manually. Folding the CSS + logo into the hash closes that gap:
//     ANY branding input that changes invalidates the sentinel.
//
// A missing input file gets a deterministic marker in the hash so a
// previously-present-then-removed file still invalidates the
// sentinel correctly. 16-char sha256 prefix is plenty for uniqueness.
const SCRIPT_PATH = fileURLToPath(import.meta.url);
function currentInputsHash() {
  const hash = crypto.createHash('sha256');
  try {
    hash.update(fs.readFileSync(SCRIPT_PATH));
  } catch {
    // Can't read this script's own bytes — extremely unusual; bail
    // with a sentinel that won't match any real hash. brandingIsCurrent
    // will return false and the next run will try again.
    return 'unknown';
  }
  const brandingInputs = [
    path.join(REPO_ROOT, 'src', 'web', 'ditto-overrides.css'),
    path.join(REPO_ROOT, 'src', 'web', 'nori.svg'),
  ];
  for (const p of brandingInputs) {
    try {
      hash.update(fs.readFileSync(p));
    } catch {
      hash.update(`<missing:${path.basename(p)}>`);
    }
  }
  return hash.digest('hex').slice(0, 16);
}

// Returns true when the existing branding sentinel was written by the
// *same* version of this script that's currently running. Returns false
// when missing, malformed, or written by a different script version —
// any of which should trigger re-branding.
function brandingIsCurrent() {
  if (!fs.existsSync(BRANDING_SENTINEL)) return false;
  try {
    const stored = fs.readFileSync(BRANDING_SENTINEL, 'utf8');
    // Sentinel format: line 1 = ISO timestamp, line 2 = inputs hash
    // (script bytes + overlay CSS bytes + logo bytes — see
    // currentInputsHash above). Pre-hash sentinels (timestamp only)
    // lack line 2 — treat as stale, which is correct: we want to
    // re-brand once after each fix lands so the new hash dimension
    // gets stamped onto the sentinel.
    const lines = stored.split('\n');
    const storedHash = lines[1]?.trim();
    if (!storedHash) return false;
    return storedHash === currentInputsHash();
  } catch {
    return false;
  }
}

async function main() {
  if (process.env.STATION_SKIP_DITTO === '1') {
    console.log('[ditto] STATION_SKIP_DITTO=1 — skipping build.');
    return;
  }
  const built       = readBuildSentinel();
  const configHash  = currentBuildConfigHash();
  // Three independent triggers for a full clone+build:
  //   1. No SENTINEL at all (fresh install / wiped dist).
  //   2. DITTO_REF changed since the last build (upstream pin bumped).
  //   3. buildDittoConfig() output changed since the last build (our
  //      ditto.json shape changed; needs to be re-baked into the bundle).
  // Legacy single-line sentinels (pre-config-hash) parse with
  // built.configHash === null, so condition 3 fires once after this
  // logic lands and seeds the new two-line format.
  const needsBuild    = !fs.existsSync(SENTINEL)
    || built.ref !== DITTO_REF
    || built.configHash !== configHash;
  const needsBranding = !brandingIsCurrent();
  if (!needsBuild && !needsBranding) {
    console.log(`[ditto] already built (${DITTO_REF.slice(0, 7)}) + branded at ${path.relative(process.cwd(), TARGET_DIR)} — skipping.`);
    console.log(`[ditto] (run \`npm run update-ditto\` to force a fresh build)`);
    return;
  }
  if (needsBuild) {
    if (built.ref && built.ref !== DITTO_REF) {
      console.log(`[ditto] DITTO_REF changed (${built.ref.slice(0, 7)} → ${DITTO_REF.slice(0, 7)}) — rebuilding.`);
    } else if (built.configHash !== configHash) {
      console.log(`[ditto] buildDittoConfig() changed — rebuilding ditto.json + bundle.`);
    }
    const ok = await cloneAndBuild();
    if (!ok) return;
  } else {
    // needsBranding fired without needsBuild — either no sentinel yet
    // (first-ever post-build branding pass) or the sentinel hash
    // doesn't match this script's hash (fetch-ditto.mjs's branding
    // logic changed since the last run; re-apply).
    console.log(`[ditto] bundle present but branding stale — re-applying branding only.`);
  }
  if (fs.existsSync(SENTINEL)) {
    applyBranding();
  }
}

// Parses the BUILT_FROM_SENTINEL into { ref, configHash }.
//   Line 1: DITTO_REF (e.g. "7a5820ca93f833b5...")
//   Line 2: buildDittoConfig() output hash (e.g. "52b704d2d3eaaef4")
// Pre-config-hash sentinels are single-line — line 2 returns null, which
// the needsBuild check in main() treats as stale (triggers one rebuild
// to seed the new format).
function readBuildSentinel() {
  try {
    const lines = fs.readFileSync(BUILT_FROM_SENTINEL, 'utf8').split('\n');
    return {
      ref:        (lines[0] || '').trim() || null,
      configHash: (lines[1] || '').trim() || null,
    };
  } catch {
    return { ref: null, configHash: null };
  }
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

  applySkin();

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

  // Two-line sentinel:
  //   line 1: DITTO_REF (upstream pin we built against)
  //   line 2: buildDittoConfig() output hash at build time
  // Parsed by readBuildSentinel(); needsBuild in main() invalidates the
  // dist when either line drifts from the current state.
  try {
    fs.writeFileSync(
      BUILT_FROM_SENTINEL,
      DITTO_REF + '\n' + currentBuildConfigHash() + '\n',
    );
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
    // appName + client together drive the full 4-element NIP-89 client
    // tag that Ditto's useNostrPublish hook appends to every outgoing
    // kind-1/6/7/1111 event:
    //   ["client", "nostr-station",
    //    "31990:291c75d…:nostr-station",
    //    "wss://relay.nsite.lol"]
    // The naddr1 below decodes to the kind-31990 client handler
    // coordinate for nostr-station (pubkey 291c75d… — same project
    // identity that anchors the landing-page nsite and signs ngit
    // merge events). The LIVE handler event is managed manually through
    // the Apps panel; scripts/publish-client-handler.mjs is
    // bootstrap/recovery only — re-publishing from it REPLACES the
    // panel-curated version (banner, artwork, topics).
    appName: 'nostr-station',
    client: 'naddr1qvzqqqru7cpzq2guwhvn0fzlv6sjp8uw5es3ma6y33vmx5n9yrrxegkde5mlr0a7qy2hwumn8ghj7un9d3shjtnwwd5hgefwd3hkcqqddehhxarj94ehgct5d9hkuy7cpf4',
    homePage: 'feed',
    // Disable Ditto's "magic mouse" cursor-fire animation. It's a
    // decorative flourish that's on-brand for Ditto but at odds with
    // nostr-station's minimalist dashboard aesthetic. Schema field
    // explicitly accepts boolean — no source patch needed.
    magicMouse: false,

    // ─── Theme ────────────────────────────────────────────────────
    // Only the 3 core colors are baked here. customTheme.font and
    // customTheme.titleFont are deliberately omitted: setting them
    // would make Ditto's fontLoader inject
    //   <style id="theme-font-overrides">html{font-family:!important}</style>
    // at runtime on every theme apply (src/lib/fontLoader.ts:76-92 in
    // the pinned Ditto). That tag is appended to <head> AFTER our
    // overlay <link>, so even though both sides use !important, source
    // order means Ditto's font would win the cascade.
    //
    // Strategy instead: leave font unset here so the override tag
    // never gets written in the steady state, and let
    // src/web/ditto-overrides.css's `html { font-family: ... !important }`
    // rule define typography unopposed. For the rarer case where a
    // user publishes a kind-16767 with f-tag fonts (which would cause
    // fontLoader to write the tag at runtime), a MutationObserver in
    // /theme.js (see DITTO_THEME_JS_BODY in src/lib/web-server-static.ts)
    // strips the tag as it appears.
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

// Inputs to applyBranding() that affect the bundle on disk:
//   - src/web/nori.svg              → dist/ditto/logo.svg + favicon
//   - src/web/ditto-overrides.css   → dist/ditto/nostr-station-overrides.css
//   - this script's own content     → invalidates BRANDING_SENTINEL via
//                                     the script-hash check above
// When any of those change, the in-app updater's dittoConfigChanged()
// detector (src/lib/update-check.ts) drops STATION_SKIP_DITTO=1 so
// this script runs and applyBranding picks up the new inputs.
//
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

  // 1b. CSS overlay — nostr-station style overrides (border-radius
  //     scale matched to the dashboard's --r-sm/--r/--r-lg, plus a
  //     re-application of the mono font stack as cascade-priority
  //     insurance against Ditto's runtime theme-sync overriding the
  //     customTheme.font baked into ditto.json). Source lives at
  //     src/web/ditto-overrides.css and gets copied alongside Ditto's
  //     own assets; the <link> tag is injected by step 2 below.
  const sourceOverlay = path.join(REPO_ROOT, 'src', 'web', 'ditto-overrides.css');
  const targetOverlay = path.join(TARGET_DIR, 'nostr-station-overrides.css');
  if (fs.existsSync(sourceOverlay)) {
    try {
      fs.copyFileSync(sourceOverlay, targetOverlay);
      console.log(`[ditto] copied ditto-overrides.css → nostr-station-overrides.css`);
    } catch (e) {
      console.warn(`[ditto] WARN: overlay css copy failed — ${e.message}`);
    }
  } else {
    console.warn(`[ditto] WARN: overlay css not found at ${sourceOverlay}; skipping`);
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
      // Inject the nostr-station style-overrides stylesheet. Position
      // matters: just before </head>, AFTER Ditto's own bundled
      // stylesheets, so for equal specificity our rules win the
      // cascade. Idempotent — if the link is already present from a
      // prior applyBranding run, regex match fails and the replace is
      // a no-op (we still won't get duplicate links because the file
      // gets rebuilt from scratch on `npm run update-ditto`).
      if (!html.includes('nostr-station-overrides.css')) {
        html = html.replace(
          /(<\/head>)/,
          '    <link rel="stylesheet" href="/ditto/nostr-station-overrides.css">\n$1',
        );
      }
      fs.writeFileSync(indexPath, html);
      console.log('[ditto] patched index.html (title + meta tags + theme-color + overrides link)');
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
    // Sentinel format: ISO timestamp on line 1, inputs hash on line 2.
    // brandingIsCurrent() reads line 2 and invalidates when it doesn't
    // match the current inputs hash — so the next time fetch-ditto.mjs,
    // ditto-overrides.css, or nori.svg changes, the next run re-brands
    // automatically.
    fs.writeFileSync(BRANDING_SENTINEL, new Date().toISOString() + '\n' + currentInputsHash() + '\n');
    console.log('[ditto] branding complete.');
  } catch (e) {
    console.warn(`[ditto] WARN: sentinel write failed — ${e.message}`);
  }
}

main().catch(e => {
  console.warn(`[ditto] WARN: unexpected error — ${e.message}`);
  // Don't fail the build.
});
