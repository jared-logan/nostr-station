/**
 * Native nsite deploy orchestrator.
 *
 * Composes the full publish pipeline that shakespeare.diy performs, but
 * in-process (no `nsyte` CLI shell-out):
 *
 *   1. build    — run the project's build script (npm run build/compile)
 *   2. walk     — recurse the build output, hash every file (sha256),
 *                 synthesize 404.html + _redirects for SPA routing
 *   3. authorize — ONE kind:24242 batch token covering all blob hashes
 *   4. upload   — PUT each blob to the effective Blossom servers
 *   5. manifest — publish kind:35128 (NIP-5A v2 named site, d=<slug>)
 *   6. announce — refresh the kind:30617 repo announcement's `web` tag
 *   7. url      — base36(pubkey)+slug+gateway → persist + log
 *
 * Signing and relay-publishing are INJECTED (DeployDeps) so this module
 * stays free of bunker/identity/websocket imports and is unit-testable
 * with a local key + a stub publisher. The route layer wires the real
 * signEventWithSavedBunker + publishEventToRelays.
 *
 * URL determinism: because the host prefix is base36(pubkey) and the
 * path is the user's slug, deploying the same project under the same
 * identity + title from anywhere (here OR shakespeare.diy) targets the
 * SAME addressable kind:35128 event and resolves to the SAME nsite URL.
 */

import fs from 'fs';
import path from 'path';
import { sha256Hex, buildUploadAuthTemplate, uploadBlobs, type BlobToUpload, type BlobUploadResult } from './blossom-upload.js';

// ── Tunables ────────────────────────────────────────────────────────────────

/** Default public gateway used to render the human-facing URL. The events
 *  are gateway-agnostic; this only affects the displayed/announced URL. */
export const DEFAULT_NSITE_GATEWAY = 'nsite.lol';

const NSITE_MANIFEST_KIND_NAMED = 35128;  // NIP-5A v2 named manifest
const REPO_ANNOUNCE_KIND        = 30617;  // NIP-34 repo announcement
const MAX_FILE_BYTES            = 100 * 1024 * 1024;  // 100 MiB per-file ceiling

// ── Injected dependencies ────────────────────────────────────────────────────

export interface SignedEvent {
  id: string; pubkey: string; sig: string;
  kind: number; created_at: number; tags: string[][]; content: string;
}

export interface RelayPublishOutcome { relay: string; ok: boolean; reason?: string }

export interface DeployDeps {
  /** Sign an unsigned template, returning a fully-formed event. Throws on
   *  failure (e.g. no paired signer / user rejected). */
  signEvent: (tpl: { kind: number; created_at: number; tags: string[][]; content: string }) => Promise<SignedEvent>;
  /** Publish a signed event to relays; returns per-relay outcomes. */
  publish:   (event: SignedEvent, relays: string[]) => Promise<RelayPublishOutcome[]>;
}

// ── Inputs / outputs ─────────────────────────────────────────────────────────

export interface DeployInput {
  /** Absolute path to the project root (build runs here). */
  projectPath: string;
  /** Site title — slugified into the kind:35128 `d` tag and the URL path. */
  siteTitle: string;
  /** Optional description → manifest + 30617 `description` tags. */
  description?: string;
  /** Effective Blossom upload targets (https://…). */
  blossomServers: string[];
  /** Effective manifest-publish relays (wss://…). */
  relays: string[];
  /** Owner pubkey (hex) — must match the signer; drives the URL prefix. */
  ownerPubkeyHex: string;
  /** Optional pre-resolved build output dir (absolute or project-relative).
   *  When omitted, common dirs are auto-detected. */
  buildDir?: string;
  /** Gateway host for the rendered URL. Defaults to DEFAULT_NSITE_GATEWAY. */
  gateway?: string;
  /** nostr:// source coordinate for the manifest `source` tag (optional). */
  source?: string;
  /** Prior 30617 announcement to carry through + refresh, if known. */
  priorAnnounce?: { tags: string[][]; content: string } | null;
  /** Progress sink — drives the SSE stream. */
  onProgress?: (line: string) => void;
}

export interface DeployResult {
  url: string;
  slug: string;
  fileCount: number;
  blobCount: number;
  manifest: { event: SignedEvent; publish: RelayPublishOutcome[]; accepted: number };
  announce: { event: SignedEvent; publish: RelayPublishOutcome[]; accepted: number } | null;
  uploads: BlobUploadResult[];
}

// ── base36 pubkey encoding (NIP-5A gateway host prefix) ──────────────────────

const B36_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Encode a 32-byte hex pubkey as the 50-char base36 string NIP-5A named-site
 * gateways use for the host prefix. Always exactly 50 chars (left-padded
 * with '0'), lowercase, no padding chars — matching the spec and what
 * nsite.lol / shakespeare produce.
 */
export function pubkeyToBase36(pubkeyHex: string): string {
  const hex = String(pubkeyHex || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`pubkeyToBase36: expected 64-hex pubkey, got ${JSON.stringify(pubkeyHex).slice(0, 80)}`);
  }
  let n = BigInt('0x' + hex);
  let out = '';
  const base = 36n;
  while (n > 0n) {
    const rem = Number(n % base);
    out = B36_ALPHABET[rem] + out;
    n = n / base;
  }
  return out.padStart(50, '0');
}

/**
 * Slugify a site title into a DNS-label-safe `d` tag: lowercase, spaces and
 * runs of disallowed chars → single hyphens, trimmed of leading/trailing
 * hyphens. Empty input (or all-stripped) yields 'site' so a deploy never
 * produces an empty d-tag / dangling URL.
 */
export function slugifyTitle(title: string): string {
  const slug = String(title || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'site';
}

/** Compose the gateway URL for a named site: base36(pubkey)+slug.gateway. */
export function nsiteUrl(pubkeyHex: string, slug: string, gateway = DEFAULT_NSITE_GATEWAY): string {
  return `https://${pubkeyToBase36(pubkeyHex)}${slug}.${gateway}/`;
}

/**
 * Extract the repo `d`-tag (identifier) from an ngit `nostr://` remote.
 * ngit emits two shapes:
 *   nostr://<npub>/<d-tag>                 (2-part)
 *   nostr://<npub>/<relay-host>/<d-tag>    (3-part — e.g. .../relay.ngit.dev/repo)
 * The d-tag is ALWAYS the last path segment. A naive greedy capture folds
 * the relay host into the identifier and then fails to match the published
 * 30617 (whose d-tag is just the repo name) — the bug that made the deploy
 * web-tag refresh silently no-op. Returns null for non-nostr:// or malformed
 * remotes. Pure; exported for direct testing.
 */
export function ngitRemoteDTag(remote: string): string | null {
  const m = String(remote || '').match(/^nostr:\/\/(npub1[0-9a-z]+)\/(.+)$/);
  if (!m) return null;
  const segs = m[2].split('/').filter(Boolean);
  return segs.length ? segs[segs.length - 1] : null;
}

// ── Build output discovery + walk ────────────────────────────────────────────

const BUILD_DIR_CANDIDATES = ['dist', 'build', 'out', 'public'];

/**
 * Resolve the build output directory. Honors an explicit `buildDir`
 * (absolute or project-relative); otherwise probes common locations and
 * returns the first that exists and is a non-empty directory.
 */
export function resolveBuildDir(projectPath: string, buildDir?: string): string | null {
  if (buildDir) {
    const abs = path.isAbsolute(buildDir) ? buildDir : path.join(projectPath, buildDir);
    return dirHasFiles(abs) ? abs : null;
  }
  for (const c of BUILD_DIR_CANDIDATES) {
    const abs = path.join(projectPath, c);
    if (dirHasFiles(abs)) return abs;
  }
  return null;
}

function dirHasFiles(abs: string): boolean {
  try {
    const st = fs.statSync(abs);
    if (!st.isDirectory()) return false;
    return fs.readdirSync(abs).length > 0;
  } catch { return false; }
}

export interface WalkedFile {
  /** Absolute site path, leading slash, forward slashes (e.g. "/assets/x.js"). */
  path:   string;
  sha256: string;
  bytes:  Buffer;
  mime:   string;
}

/**
 * Recursively walk a build directory into WalkedFile[]. Symlinks are NOT
 * followed (prevents escaping the build dir). Files above the size ceiling
 * are skipped with a warning. Paths are normalized to POSIX with a leading
 * slash regardless of host platform.
 */
export function walkBuildDir(buildDir: string, onWarn?: (msg: string) => void): WalkedFile[] {
  const root = path.resolve(buildDir);
  const out: WalkedFile[] = [];

  const recurse = (absDir: string, relPrefix: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      const abs = path.join(absDir, ent.name);
      // Refuse symlinks outright — both dirs and files — so a crafted
      // build output can't exfiltrate files from outside the tree.
      if (ent.isSymbolicLink()) { onWarn?.(`skipped symlink ${ent.name}`); continue; }
      if (ent.isDirectory()) {
        recurse(abs, `${relPrefix}/${ent.name}`);
      } else if (ent.isFile()) {
        let bytes: Buffer;
        try {
          const st = fs.statSync(abs);
          if (st.size > MAX_FILE_BYTES) { onWarn?.(`skipped ${ent.name} (${st.size} bytes > ceiling)`); continue; }
          bytes = fs.readFileSync(abs);
        } catch { continue; }
        const sitePath = `${relPrefix}/${ent.name}`.replace(/\\/g, '/');
        out.push({
          path:   sitePath.startsWith('/') ? sitePath : `/${sitePath}`,
          sha256: sha256Hex(bytes),
          bytes,
          mime:   mimeForPath(ent.name),
        });
      }
    }
  };
  recurse(root, '');
  return out;
}

/**
 * Add the two files shakespeare/nsyte synthesize for SPA hosting if the
 * build didn't already provide them:
 *   - /404.html      → mirror of index.html (gateways serve it on miss)
 *   - /_redirects    → SPA fallback rule (/* → /index.html 200)
 * Returns a NEW array; inputs are not mutated. No-op when there's no
 * index.html (nothing to fall back to).
 */
export function withSpaFallbacks(files: WalkedFile[]): WalkedFile[] {
  const byPath = new Set(files.map(f => f.path));
  const index = files.find(f => f.path === '/index.html');
  if (!index) return files.slice();

  const extra: WalkedFile[] = [];
  if (!byPath.has('/404.html')) {
    extra.push({ path: '/404.html', sha256: index.sha256, bytes: index.bytes, mime: 'text/html' });
  }
  if (!byPath.has('/_redirects')) {
    const bytes = Buffer.from('/*    /index.html   200\n', 'utf8');
    extra.push({ path: '/_redirects', sha256: sha256Hex(bytes), bytes, mime: 'text/plain' });
  }
  return [...files, ...extra];
}

// Minimal extension → MIME map. Covers the web-asset long tail; unknown
// extensions fall back to application/octet-stream (gateways sniff anyway).
const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.json': 'application/json', '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain', '.md': 'text/markdown',
  '.xml': 'application/xml', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
};

export function mimeForPath(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

// ── kind:35128 manifest builder ──────────────────────────────────────────────

export interface ManifestInput {
  slug:        string;
  title:       string;
  description?: string;
  files:       WalkedFile[];
  servers:     string[];
  relays:      string[];
  source?:     string;
}

/**
 * Build the unsigned kind:35128 NIP-5A v2 named manifest. One `path` tag
 * per file (path → sha256), `server`/`relay` hints, title/description, an
 * optional `source` coordinate, and the client stamp. Pure.
 */
export function buildManifestTemplate(input: ManifestInput): { kind: number; created_at: number; tags: string[][]; content: string } {
  const tags: string[][] = [['d', input.slug]];
  for (const f of input.files) {
    tags.push(['path', f.path, f.sha256]);
  }
  for (const s of input.servers) tags.push(['server', s]);
  for (const r of input.relays)  tags.push(['relay', r]);
  tags.push(['title', input.title]);
  if (input.description) tags.push(['description', input.description]);
  if (input.source)      tags.push(['source', input.source]);
  // Mirror shakespeare.diy's ["client", ...] stamp so the manifest is
  // attributable to nostr-station.
  tags.push(['client', 'nostr-station']);
  return {
    kind:       NSITE_MANIFEST_KIND_NAMED,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content:    '',
  };
}

/**
 * Refresh a prior 30617 announcement's `web` tag to point at the freshly
 * deployed URL, preserving every other tag. When there's no prior event we
 * return null — the deploy route falls back to the dedicated announce flow
 * (which knows how to construct a 30617 from scratch). Pure.
 */
export function refreshAnnounceWebTag(
  prior: { tags: string[][]; content: string },
  url: string,
): { tags: string[][]; content: string } {
  const tags = prior.tags
    .filter(t => Array.isArray(t) && t[0] !== 'web')
    .map(t => t.slice());
  tags.push(['web', url]);
  // Stamp ['client','nostr-station'] if it isn't already present. We're the
  // one republishing this 30617, so the deploy should be attributable to
  // nostr-station — mirroring shakespeare.diy's client tag. We DON'T strip
  // an existing client tag (e.g. a repo originally announced by another
  // client): both can coexist, and a repo's provenance is preserved.
  // Note: ngit-CLI-generated 30617s carry no client tag at all, which is
  // why a freshly `ngit push`ed repo shows none until its first deploy.
  if (!tags.some(t => t[0] === 'client' && t[1] === 'nostr-station')) {
    tags.push(['client', 'nostr-station']);
  }
  return { tags, content: prior.content };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Run the deploy pipeline given an ALREADY-RESOLVED set of inputs and the
 * walked files. Separated from build/walk so callers (and tests) can drive
 * the sign+upload+publish core directly. Steps 3–7.
 */
export async function deployFiles(
  files: WalkedFile[],
  input: DeployInput,
  deps: DeployDeps,
): Promise<DeployResult> {
  const log = (s: string) => { try { input.onProgress?.(s); } catch {} };

  if (files.length === 0) throw new Error('no files to deploy (build output was empty)');

  const slug    = slugifyTitle(input.siteTitle);
  const gateway = input.gateway || DEFAULT_NSITE_GATEWAY;
  const url     = nsiteUrl(input.ownerPubkeyHex, slug, gateway);

  // Unique blobs by hash (dedupe — e.g. 404.html shares index.html's hash).
  const blobByHash = new Map<string, BlobToUpload>();
  for (const f of files) {
    if (!blobByHash.has(f.sha256)) {
      blobByHash.set(f.sha256, { sha256: f.sha256, bytes: f.bytes, mime: f.mime, path: f.path });
    }
  }
  const blobs = [...blobByHash.values()];
  log(`hashed ${files.length} files → ${blobs.length} unique blobs`);

  // (3) One signed kind:24242 covering every blob hash.
  const authTpl = buildUploadAuthTemplate(blobs.map(b => b.sha256));
  log('requesting upload authorization signature…');
  const authEvent = await deps.signEvent(authTpl);

  // (4) Upload.
  log(`uploading ${blobs.length} blobs → ${input.blossomServers.length} servers`);
  const uploads = await uploadBlobs({
    servers: input.blossomServers,
    blobs,
    authEvent,
    onProgress: (p) => {
      const okCount = p.result.servers.filter(s => s.ok).length;
      const verb = p.result.servers.some(s => s.skipped) && p.result.servers.every(s => s.skipped) ? 'exists' : 'uploaded';
      log(`  [${p.index}/${p.total}] ${p.result.path || p.result.sha256.slice(0, 12)} ${verb} (${okCount}/${p.result.servers.length} servers)`);
    },
  });
  const failed = uploads.filter(u => !u.ok);
  if (failed.length > 0) {
    throw new Error(
      `${failed.length}/${uploads.length} blobs failed to upload to any server` +
      ` (first: ${failed[0].path || failed[0].sha256.slice(0, 12)})`,
    );
  }

  // (5) Manifest.
  log('publishing site manifest (kind 35128)…');
  const manifestTpl = buildManifestTemplate({
    slug, title: input.siteTitle, description: input.description,
    files, servers: input.blossomServers, relays: input.relays, source: input.source,
  });
  const manifestEvent = await deps.signEvent(manifestTpl);
  const manifestPublish = await deps.publish(manifestEvent, input.relays);
  const manifestAccepted = manifestPublish.filter(r => r.ok).length;
  log(`manifest accepted by ${manifestAccepted}/${manifestPublish.length} relays`);
  if (manifestAccepted === 0) {
    throw new Error('site manifest was rejected by every relay — nsite would not resolve');
  }

  // (6) Refresh the 30617 web tag (only when we have a prior to carry through).
  let announce: DeployResult['announce'] = null;
  if (input.priorAnnounce) {
    try {
      const refreshed = refreshAnnounceWebTag(input.priorAnnounce, url);
      const annTpl = {
        kind: REPO_ANNOUNCE_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: refreshed.tags,
        content: refreshed.content,
      };
      log('refreshing repo announcement web tag (kind 30617)…');
      const annEvent = await deps.signEvent(annTpl);
      const annPublish = await deps.publish(annEvent, input.relays);
      announce = { event: annEvent, publish: annPublish, accepted: annPublish.filter(r => r.ok).length };
      log(`announcement accepted by ${announce.accepted}/${annPublish.length} relays`);
    } catch (e: any) {
      // Non-fatal: the site is already live via the manifest. Surface but
      // don't fail the deploy.
      log(`warning: web-tag refresh failed (${e?.message || e}) — site is still live`);
    }
  }

  log(`done → ${url}`);
  return {
    url, slug,
    fileCount: files.length,
    blobCount: blobs.length,
    manifest: { event: manifestEvent, publish: manifestPublish, accepted: manifestAccepted },
    announce,
    uploads,
  };
}
