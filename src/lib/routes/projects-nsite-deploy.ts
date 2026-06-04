/**
 * POST /api/projects/:id/nsite/deploy — native nsite deploy over SSE.
 *
 * Replaces the old `nostr-station nsite deploy --yes` CLI shell-out with
 * the in-process pipeline (src/lib/nsite-deploy.ts + blossom-upload.ts).
 * This module is the WIRING layer: it owns the HTTP/SSE plumbing, runs the
 * project build, resolves the signing identity + publish targets, and
 * persists the result. The pure pipeline does the protocol work.
 *
 * SSE frame protocol matches streamExec so the dashboard's existing
 * exec-modal renderer works unchanged:
 *   { line, stream: 'stdout'|'stderr' }   — progress lines
 *   { done: true, code, url? }            — terminal frame
 *
 * Body: { siteTitle?, description?, gateway? } (JSON). siteTitle defaults
 * to the project name; an empty/symbol-only title slugifies to "site".
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { nip19 } from 'nostr-tools';
import type { Project } from '../projects.js';
import { updateProject, projectEnvContract } from '../projects.js';
import { readIdentity, getEffectiveReadRelays } from '../identity.js';
import { readNsiteConfig, effectiveDeployBlossomServers, effectiveDeployRelays } from '../nsite-config.js';
import { signEventWithSavedBunker } from '../auth-bunker.js';
import { publishEventToRelays, fetchRepoMeta } from './repo.js';
import { queryRelaysDirect, getTagValue, type NostrEvent } from '../nostr-query.js';
import { detectBuildCommand } from '../ai-tools/build.js';
import {
  deployFiles, resolveBuildDir, walkBuildDir, withSpaFallbacks, ngitRemoteDTag,
  slugifyTitle, extractManifestMeta, resolveDeployDefaults,
  DEFAULT_NSITE_GATEWAY, type DeployDeps, type SignedEvent, type ManifestMeta,
} from '../nsite-deploy.js';
import { readBody } from './_shared.js';

const NSITE_MANIFEST_KIND = 35128;

const REPO_ANNOUNCE_KIND      = 30617;
const BUILD_TIMEOUT_MS        = 600_000;  // 10 min ceiling for big builds
const SIGN_TIMEOUT_MS         = 60_000;   // Amber round-trip budget per event

export async function handleProjectsNsiteDeploy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  project: Project,
  tail: string,
  method: string,
): Promise<boolean> {
  // Deploy-form defaults (read-only). Sources the title + description the
  // form pre-fills with so a redeploy doesn't silently drop the description.
  if (tail === 'nsite/deploy-defaults' && method === 'GET') {
    const defaults = await resolveDeployFormDefaults(project);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(defaults));
    return true;
  }
  if (tail !== 'nsite/deploy' || method !== 'POST') return false;

  // Parse body up front (before we open the SSE stream).
  let body: any = {};
  try { body = JSON.parse(await readBody(req)); } catch { /* empty/invalid → defaults */ }
  const siteTitle   = typeof body.siteTitle === 'string' && body.siteTitle.trim()
    ? body.siteTitle.trim() : project.name;
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const gateway     = typeof body.gateway === 'string' && body.gateway.trim()
    ? body.gateway.trim() : DEFAULT_NSITE_GATEWAY;

  // Open the SSE stream now — every subsequent failure is reported as a
  // stderr line + done frame so the exec modal renders it consistently.
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
  const emit  = (payload: object) => { try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {} };
  const log   = (line: string, stream: 'stdout' | 'stderr' = 'stdout') => emit({ line, stream });
  const fail  = (msg: string, code = 1) => { log(msg, 'stderr'); emit({ done: true, code }); try { res.end(); } catch {} };
  const finish = (url: string) => {
    // Side-channel the URL via an info frame (the exec-modal stashes
    // `info[name]=value` and surfaces it on the resolved promise), then
    // the terminal done frame.
    emit({ info: 'url', value: url });
    emit({ done: true, code: 0, url });
    try { res.end(); } catch {}
  };

  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    if (!project.path) { fail('project has no local path — clone or scaffold it first'); return true; }

    // ── Identity: resolve owner hex; require a paired signer ──────────────
    const ident = readIdentity();
    let ownerHex = '';
    try { ownerHex = ident.npub ? (nip19.decode(ident.npub).data as string) : ''; } catch { ownerHex = ''; }
    if (!/^[0-9a-f]{64}$/.test(ownerHex)) {
      fail('no station identity configured — pair your Nostr key (Config → Identity) before deploying');
      return true;
    }

    // ── Build ─────────────────────────────────────────────────────────────
    const spec = detectBuildCommand(project.path);
    if (spec) {
      log(`$ ${spec.command}  (cwd: ${project.path})`);
      const code = await runBuildStreaming(spec.argv, project.path, projectEnvContract(project), emit, () => aborted);
      if (aborted) { try { res.end(); } catch {} return true; }
      if (code !== 0) { fail(`build failed (exit ${code}) — fix the build and retry`, code ?? 1); return true; }
    } else {
      log('no build script detected (package.json has no build/compile) — deploying existing output as-is', 'stdout');
    }

    // ── Collect files ─────────────────────────────────────────────────────
    const buildDir = resolveBuildDir(project.path, body.buildDir);
    if (!buildDir) {
      fail('no build output found — expected a non-empty dist/ (or build/out/public). Build your project first.');
      return true;
    }
    log(`build output: ${buildDir}`);
    const walked = walkBuildDir(buildDir, (w) => log(`  ${w}`, 'stderr'));
    const files  = withSpaFallbacks(walked);
    if (files.length === 0) { fail('build output directory is empty — nothing to deploy'); return true; }

    // ── Targets ───────────────────────────────────────────────────────────
    const cfg     = readNsiteConfig();
    const servers = effectiveDeployBlossomServers(cfg);
    const relays  = effectiveDeployRelays(cfg);
    if (servers.length === 0) { fail('no Blossom servers configured for deploy (Config → nsite deploy)'); return true; }
    if (relays.length === 0)  { fail('no relays configured for deploy (Config → nsite deploy)'); return true; }

    // ── Manifest source coordinate (deploy never touches the 30617) ──────
    const source = resolveSourceCoordinate(project, ownerHex);

    // ── Wire signing + publishing into the pure pipeline ─────────────────
    const deps: DeployDeps = {
      signEvent: async (tpl) => {
        const signed = await signEventWithSavedBunker(tpl, SIGN_TIMEOUT_MS);
        if (!signed.ok || !signed.signedEvent) {
          throw new Error(signed.error || (signed.tried ? 'signer rejected the event' : 'no paired signer'));
        }
        const ev = signed.signedEvent as SignedEvent;
        if (ev.pubkey !== ownerHex) {
          throw new Error('signer pubkey does not match the station identity');
        }
        return ev;
      },
      publish: async (event, targetRelays) => {
        const out = await publishEventToRelays(event, targetRelays);
        return out.map(r => ({ relay: r.relay, ok: r.ok, reason: r.reason }));
      },
    };

    const result = await deployFiles(files, {
      projectPath: project.path,
      siteTitle, description,
      blossomServers: servers,
      relays,
      ownerPubkeyHex: ownerHex,
      gateway,
      source,
      onProgress: (l) => log(l),
    }, deps);

    // ── Persist ───────────────────────────────────────────────────────────
    try {
      updateProject(project.id, {
        nsite: { url: result.url, lastDeploy: new Date().toISOString() },
      });
    } catch (e: any) {
      log(`warning: could not persist deploy state (${e?.message || e})`, 'stderr');
    }

    log(`✓ deployed ${result.fileCount} files (${result.blobCount} blobs) to ${result.manifest.accepted} relay(s)`);
    finish(result.url);
    return true;
  } catch (e: any) {
    if (!aborted) fail(`deploy failed: ${e?.message || e}`);
    else { try { res.end(); } catch {} }
    return true;
  }
}

// ── Build runner: spawn + stream stdout/stderr as SSE lines ──────────────────

function runBuildStreaming(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  emit: (payload: object) => void,
  isAborted: () => boolean,
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb', CI: '1', ...env },
    });
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, BUILD_TIMEOUT_MS);
    const pump = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      if (isAborted()) { try { child.kill('SIGTERM'); } catch {} return; }
      for (const line of chunk.toString().split('\n')) {
        if (line.length) emit({ line, stream });
      }
    };
    child.stdout.on('data', pump('stdout'));
    child.stderr.on('data', pump('stderr'));
    child.on('error', (e) => { clearTimeout(timer); emit({ line: String(e.message || e), stream: 'stderr' }); resolve(-1); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code); });
  });
}

// ── Manifest source coordinate ───────────────────────────────────────────────

/**
 * Derive the manifest `source` coordinate (a nostr:// URL) from the project's
 * ngit remote, when one exists — purely to stamp provenance on the kind:35128
 * manifest. Deploy does NOT read or modify the repo's kind:30617 announcement,
 * so there's no relay lookup here. Returns undefined for no decodable remote.
 */
function resolveSourceCoordinate(project: Project, ownerHex: string): string | undefined {
  const remote = project.remotes?.ngit || '';

  if (remote.startsWith('naddr1')) {
    try {
      const d = nip19.decode(remote);
      if (d.type === 'naddr' && d.data.kind === REPO_ANNOUNCE_KIND) {
        const npub = ident_npubOf(ownerHex);
        return npub ? `nostr://${npub}/${d.data.identifier}` : undefined;
      }
    } catch {}
    return undefined;
  }
  if (remote.startsWith('nostr://')) {
    // The full nostr:// path is the source coordinate (matches Shakespeare).
    // ngitRemoteDTag also validates the shape (and yields the d-tag) — we
    // only keep the remote as `source` when it decodes to a real d-tag.
    return ngitRemoteDTag(remote) ? remote : undefined;
  }
  return undefined;
}

function ident_npubOf(hex: string): string | null {
  try { return nip19.npubEncode(hex); } catch { return null; }
}

// ── Deploy-form defaults ─────────────────────────────────────────────────────

/**
 * Resolve the deploy form's default { title, description }. READ-ONLY: this
 * never writes or modifies the 30617 announcement (or the 35128 manifest) —
 * it only sources sensible default values so a redeploy doesn't drop the
 * site's description. Cascade (see resolveDeployDefaults):
 *   description: prior 35128 deploy → 30617 announcement → package.json → ''
 *   title:       prior 35128 deploy → project name
 * Every relay/fs lookup is best-effort; failures degrade to the next source.
 */
async function resolveDeployFormDefaults(project: Project): Promise<ManifestMeta> {
  let ownerHex = '';
  try {
    const ident = readIdentity();
    ownerHex = ident.npub ? (nip19.decode(ident.npub).data as string) : '';
  } catch { ownerHex = ''; }

  // (1) Most recent prior deploy for this site.
  let priorDeploy: ManifestMeta | null = null;
  if (/^[0-9a-f]{64}$/.test(ownerHex)) {
    try { priorDeploy = await findPriorDeploy(project, ownerHex); } catch { priorDeploy = null; }
  }

  // (2) The repo's 30617 announcement description (read-only — same fetch the
  //     Overview uses, so it's usually warm in cache).
  let announcementDescription: string | null = null;
  try {
    const meta = await fetchRepoMeta(project, false);
    announcementDescription = meta.repo?.description || null;
  } catch { announcementDescription = null; }

  // (3) package.json description.
  let packageDescription: string | null = null;
  if (project.path) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(project.path, 'package.json'), 'utf8'));
      if (typeof pkg.description === 'string') packageDescription = pkg.description;
    } catch { /* no package.json */ }
  }

  return resolveDeployDefaults({
    priorDeploy,
    announcementDescription,
    packageDescription,
    projectName: project.name,
  });
}

/**
 * Find the most recent kind:35128 manifest this owner published for THIS
 * project's site. Matches on the manifest `source` coordinate (when the
 * project has an ngit remote) or the slug derived from the project name —
 * the same d-tag a default-titled deploy produces. Returns its title +
 * description, or null when nothing matches.
 */
async function findPriorDeploy(project: Project, ownerHex: string): Promise<ManifestMeta | null> {
  const relays = getEffectiveReadRelays();
  if (relays.length === 0) return null;
  const result = await queryRelaysDirect({
    filter: { kinds: [NSITE_MANIFEST_KIND], authors: [ownerHex], limit: 50 },
    relays,
    timeoutMs: 6_000,
    stream: false,
  });
  const source   = resolveSourceCoordinate(project, ownerHex);
  const wantSlug = slugifyTitle(project.name);
  let best: NostrEvent | null = null;
  for (const ev of result.events) {
    if (ev.kind !== NSITE_MANIFEST_KIND || ev.pubkey !== ownerHex) continue;
    const dTag     = getTagValue(ev, 'd');
    const evSource = getTagValue(ev, 'source');
    const matches  = (!!source && evSource === source) || dTag === wantSlug;
    if (!matches) continue;
    if (!best || (ev.created_at || 0) > (best.created_at || 0)) best = ev;
  }
  return best ? extractManifestMeta(best) : null;
}
