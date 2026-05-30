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
import { spawn } from 'child_process';
import { nip19 } from 'nostr-tools';
import type { Project } from '../projects.js';
import { updateProject, projectEnvContract } from '../projects.js';
import { readIdentity, getGraspServers, isValidRelayUrl } from '../identity.js';
import { readNsiteConfig, effectiveDeployBlossomServers, effectiveDeployRelays } from '../nsite-config.js';
import { signEventWithSavedBunker } from '../auth-bunker.js';
import { publishEventToRelays } from './repo.js';
import { queryRelays } from '../nostr-query.js';
import { detectBuildCommand } from '../ai-tools/build.js';
import {
  deployFiles, resolveBuildDir, walkBuildDir, withSpaFallbacks,
  DEFAULT_NSITE_GATEWAY, type DeployDeps, type SignedEvent,
} from '../nsite-deploy.js';
import { readBody } from './_shared.js';

const REPO_ANNOUNCE_KIND      = 30617;
const RELAY_QUERY_TIMEOUT_MS  = 8_000;
const BUILD_TIMEOUT_MS        = 600_000;  // 10 min ceiling for big builds
const SIGN_TIMEOUT_MS         = 60_000;   // Amber round-trip budget per event

export async function handleProjectsNsiteDeploy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  project: Project,
  tail: string,
  method: string,
): Promise<boolean> {
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

    // ── Prior 30617 (to refresh its web tag) + source coordinate ─────────
    const { priorAnnounce, source } = await resolvePriorAnnounce(project, ownerHex);

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
      priorAnnounce,
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

// ── Prior 30617 lookup ───────────────────────────────────────────────────────

interface PriorResult {
  priorAnnounce: { tags: string[][]; content: string } | null;
  source:        string | undefined;
}

/**
 * Fetch the project's existing kind:30617 announcement so the deploy can
 * refresh its `web` tag in place (preserving clone/relays/maintainers/etc).
 * Derives the manifest `source` coordinate from the project's ngit remote
 * when available. Best-effort: any failure yields a null prior (the deploy
 * still publishes the manifest; it just won't touch the 30617).
 */
async function resolvePriorAnnounce(project: Project, ownerHex: string): Promise<PriorResult> {
  const remote = project.remotes?.ngit || '';
  let identifier = '';
  let source: string | undefined;

  // Decode (pubkey, d-tag) from the ngit remote — same shapes repo.ts handles.
  if (remote.startsWith('naddr1')) {
    try {
      const d = nip19.decode(remote);
      if (d.type === 'naddr' && d.data.kind === REPO_ANNOUNCE_KIND) identifier = d.data.identifier;
    } catch {}
  } else if (remote.startsWith('nostr://')) {
    const m = remote.match(/^nostr:\/\/(npub1[0-9a-z]+)\/(.+)$/);
    if (m) { identifier = m[2]; source = remote; }
  }
  if (!identifier) return { priorAnnounce: null, source };
  if (!source && ident_npubOf(ownerHex)) source = `nostr://${ident_npubOf(ownerHex)}/${identifier}`;

  const relays = [
    ...getGraspServers().map(s => /^wss?:/i.test(s) ? s : `wss://${s}`),
    ...(project.readRelays || []),
  ].filter(isValidRelayUrl).filter((r, i, a) => a.indexOf(r) === i).slice(0, 8);
  if (relays.length === 0) return { priorAnnounce: null, source };

  try {
    const r = await queryRelays({
      filter: { kinds: [REPO_ANNOUNCE_KIND], authors: [ownerHex], tags: { d: identifier }, limit: 1 },
      relays,
      timeoutMs: RELAY_QUERY_TIMEOUT_MS,
      stream: false,
      acceptUntil: (evs) => evs.length >= 1,
    });
    let prior: any = null;
    for (const ev of r.events) {
      if (ev.kind !== REPO_ANNOUNCE_KIND) continue;
      if (!prior || ev.created_at > prior.created_at) prior = ev;
    }
    if (prior) return { priorAnnounce: { tags: prior.tags, content: prior.content || '' }, source };
  } catch { /* non-fatal */ }
  return { priorAnnounce: null, source };
}

function ident_npubOf(hex: string): string | null {
  try { return nip19.npubEncode(hex); } catch { return null; }
}
