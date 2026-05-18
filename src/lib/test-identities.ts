/**
 * Per-project test identities.
 *
 * Throwaway keypairs scoped to a single project — used by the project's
 * app code during local development to simulate multiple users without
 * burning real social capital on disposable accounts.
 *
 * Storage: `~/.config/nostr-station/projects/<id>/test-identities.json`
 * (mode 0600). Lives in user-config (not in the project tree) so the
 * nsecs can never be reached by `git add`, ngit push, or any sweep that
 * a project's own .gitignore might miss. Plain JSON, intentionally
 * human-inspectable — the nsecs are not encrypted on disk; the safety
 * story is the `client` tag (forced into every event signed by these
 * keys) plus the local-only relay write-gating and the promote-time
 * refusal. See:
 *
 *   - src/lib/local-signer.ts        — forces the "client" tag at sign time
 *   - src/relay/index.ts             — refuses non-loopback publish of tagged events
 *   - src/lib/promote.ts (Phase E)   — refuses to ever publish to prod
 *
 * Legacy migration: pre-2026-05 projects stored this at
 * `<project>/.nostr-station/test-identities.json`. `migrateLegacy()` runs
 * once per process per project on the read path and copies the legacy
 * file (preserving 0600) before deleting it when untracked in git.
 *
 * On-disk shape (kept narrow so a user editing the file by hand can do so):
 *
 *   {
 *     "identities": [
 *       { "id": "uuid", "label": "teacher-alice", "role": "teacher",
 *         "nsec": "nsec1…", "pubkey": "hex", "createdAt": 1730… }
 *     ],
 *     "updatedAt": 1730…
 *   }
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import type { Project } from './projects.js';
import { CONFIG_DIRNAME, userConfigDirFor, ensureUserConfigDir } from './project-config.js';
import { getWhitelistRef, getInprocRelayPort } from './routes/_shared.js';
import { signEventWithLocalKey } from './local-signer.js';

const FILE_NAME = 'test-identities.json';
const STRICT_MODE = 0o600;

export interface TestIdentity {
  id:         string;     // uuid
  label:      string;     // user-visible name, e.g. "teacher-alice"
  role:       string;     // template-defined slot
  npub:       string;     // bech32
  pubkey:     string;     // 64-hex
  createdAt:  number;     // epoch ms
  profile?:   TestIdentityProfile;
}

export interface TestIdentityProfile {
  displayName?: string;
  about?:       string;
  picture?:     string;
}

interface PersistedRecord extends TestIdentity {
  nsec: string;
}

interface PersistedFile {
  identities: PersistedRecord[];
  updatedAt:  number;
}

// ── Path helpers ──────────────────────────────────────────────────────────
//
// `fileFor` now returns a user-config path regardless of project.path
// (project.id is always set). We keep returning `null` only for the
// edge case where the project has no local path at all — addIdentity()
// and friends still refuse there, because callers (UI, signing) need
// SOME notion of "this project lives on disk" to be meaningful.

function fileFor(project: Project): string | null {
  if (!project.path) return null;
  return path.join(userConfigDirFor(project), FILE_NAME);
}

// One-time-per-process per-project copy of a legacy
// `<project>/.nostr-station/test-identities.json` into the new
// user-config location, with the legacy file deleted afterwards when
// it's untracked in git. Tracked legacy files are left alone — surface
// via project-config's legacyLocalFiles() so the UI can nudge for a
// deliberate `git rm`.
const legacyMigrated = new Set<string>();

function migrateLegacy(project: Project): void {
  if (!project.path) return;
  if (legacyMigrated.has(project.id)) return;
  legacyMigrated.add(project.id);

  const legacy = path.join(project.path, CONFIG_DIRNAME, FILE_NAME);
  const dest   = fileFor(project);
  if (!dest) return;
  try {
    if (!fs.existsSync(dest) && fs.existsSync(legacy)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      const data = fs.readFileSync(legacy);
      fs.writeFileSync(dest, data, { mode: STRICT_MODE });
      try { fs.chmodSync(dest, STRICT_MODE); } catch {}
    }
    if (fs.existsSync(legacy)) {
      // git ls-files exits non-zero when the file isn't tracked.
      let tracked = false;
      try {
        execFileSync('git', ['ls-files', '--error-unmatch', '--', `${CONFIG_DIRNAME}/${FILE_NAME}`], {
          cwd: project.path,
          stdio: ['ignore', 'ignore', 'ignore'],
          timeout: 2000,
        });
        tracked = true;
      } catch { /* untracked or not a repo */ }
      if (!tracked) {
        try { fs.unlinkSync(legacy); } catch {}
      }
    }
  } catch { /* best-effort */ }
}

function readFileStrict(p: string): { ok: true; data: PersistedFile } | { ok: false; reason: 'missing' | 'bad-mode' | 'bad-json'; mode?: number } {
  let stat: fs.Stats;
  try { stat = fs.statSync(p); }
  catch { return { ok: false, reason: 'missing' }; }
  const mode = stat.mode & 0o777;
  if (mode !== STRICT_MODE) {
    return { ok: false, reason: 'bad-mode', mode };
  }
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.identities)) {
      return { ok: false, reason: 'bad-json' };
    }
    return { ok: true, data: parsed as PersistedFile };
  } catch {
    return { ok: false, reason: 'bad-json' };
  }
}

function writeFileAtomic(p: string, data: PersistedFile): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: STRICT_MODE });
  fs.renameSync(tmp, p);
  // Defensive: re-apply mode in case umask altered it on creation.
  try { fs.chmodSync(p, STRICT_MODE); } catch {}
}

// ── Strict-load result surfaced by routes for UI banners ─────────────────

export type LoadResult =
  | { ok: true;  identities: TestIdentity[] }
  | { ok: false; reason: 'no-path' | 'missing' | 'bad-mode' | 'bad-json'; mode?: number };

export function listIdentities(project: Project): LoadResult {
  const fp = fileFor(project);
  if (!fp) return { ok: false, reason: 'no-path' };
  migrateLegacy(project);
  const r = readFileStrict(fp);
  if (!r.ok) {
    if (r.reason === 'missing') return { ok: true, identities: [] };
    return { ok: false, reason: r.reason, mode: r.mode };
  }
  // Strip nsec from the returned shape — HTTP routes call this; nsecs
  // never leave the server boundary except via the dedicated /sign API.
  const stripped = r.data.identities.map(({ nsec: _nsec, ...rest }) => rest);
  return { ok: true, identities: stripped };
}

// ── Mutators ──────────────────────────────────────────────────────────────

export interface AddInput {
  label:  string;
  role:   string;
  profile?: TestIdentityProfile;
}

export interface AddResult {
  identity: TestIdentity;
  nsec:     string;
  pubkey:   string;
}

export function addIdentity(project: Project, input: AddInput): { ok: true; result: AddResult } | { ok: false; error: string } {
  const fp = fileFor(project);
  if (!fp) return { ok: false, error: 'project has no local path' };
  if (!input.label || !input.label.trim()) return { ok: false, error: 'label is required' };
  migrateLegacy(project);
  ensureUserConfigDir(project);

  let current: PersistedFile = { identities: [], updatedAt: Date.now() };
  const existing = readFileStrict(fp);
  if (existing.ok) current = existing.data;
  else if (existing.reason === 'bad-mode' || existing.reason === 'bad-json') {
    return { ok: false, error: `refusing to write — existing file is ${existing.reason}` };
  }

  // Refuse duplicate labels so the UI selector doesn't show two
  // "teacher-alice" rows.
  if (current.identities.some(i => i.label === input.label)) {
    return { ok: false, error: `label "${input.label}" already exists in this project` };
  }

  const sk     = generateSecretKey();
  const pubkey = getPublicKey(sk);
  const nsec   = nip19.nsecEncode(sk);
  const npub   = nip19.npubEncode(pubkey);

  const identity: TestIdentity = {
    id:        crypto.randomUUID(),
    label:     input.label.trim(),
    role:      String(input.role || ''),
    npub,
    pubkey,
    createdAt: Date.now(),
    ...(input.profile ? { profile: { ...input.profile } } : {}),
  };
  const record: PersistedRecord = { ...identity, nsec };

  const next: PersistedFile = {
    identities: [...current.identities, record],
    updatedAt:  Date.now(),
  };
  writeFileAtomic(fp, next);

  // Auto-whitelist the new pubkey so it can publish to the in-process
  // relay without the user manually editing the whitelist. No-op if
  // the relay isn't running (e.g. STATION_INPROC_RELAY=0); the
  // identity stays on disk and gets whitelisted on next relay start.
  try { getWhitelistRef()?.add(pubkey); } catch {}

  return { ok: true, result: { identity, nsec, pubkey } };
}

export function removeIdentity(project: Project, id: string): { ok: true; pubkey: string } | { ok: false; error: string } {
  const fp = fileFor(project);
  if (!fp) return { ok: false, error: 'project has no local path' };
  migrateLegacy(project);
  const existing = readFileStrict(fp);
  if (!existing.ok) {
    if (existing.reason === 'missing') return { ok: false, error: 'no test identities for this project' };
    return { ok: false, error: `refusing to write — file is ${existing.reason}` };
  }
  const before = existing.data.identities;
  const idx = before.findIndex(i => i.id === id);
  if (idx < 0) return { ok: false, error: 'identity not found' };
  const pubkey = before[idx].pubkey;
  const next: PersistedFile = {
    identities: before.filter((_, i) => i !== idx),
    updatedAt:  Date.now(),
  };
  writeFileAtomic(fp, next);
  try { getWhitelistRef()?.remove(pubkey); } catch {}
  return { ok: true, pubkey };
}

export function regenerateAll(project: Project): { ok: true; cleared: number } | { ok: false; error: string } {
  const fp = fileFor(project);
  if (!fp) return { ok: false, error: 'project has no local path' };
  migrateLegacy(project);
  const existing = readFileStrict(fp);
  if (!existing.ok && existing.reason !== 'missing') {
    return { ok: false, error: `refusing to wipe — file is ${existing.reason}` };
  }
  const had = existing.ok ? existing.data.identities.length : 0;
  writeFileAtomic(fp, { identities: [], updatedAt: Date.now() });
  return { ok: true, cleared: had };
}

// Server-side accessor for the routes/test-identities.ts /sign endpoint.
// Returns the nsec for a given identity id, or null when absent. NEVER
// expose this through an HTTP response — sign on the server, return only
// the signed event.
export function getNsec(project: Project, id: string): string | null {
  const fp = fileFor(project);
  if (!fp) return null;
  migrateLegacy(project);
  const existing = readFileStrict(fp);
  if (!existing.ok) return null;
  const rec = existing.data.identities.find(i => i.id === id);
  return rec ? rec.nsec : null;
}

// Best-effort: publish a kind-0 profile metadata event for a freshly-
// created identity so apps (and the built-in client) render it with a
// name + avatar instead of a bare npub. The event carries the
// mandatory test-identity tag (via signEventWithLocalKey's opts), so
// it can never leak to a public relay through the promote path.
//
// Fire-and-forget from the route handler — fails silently if the
// in-process relay isn't running, on a connect timeout, or on relay
// rejection. The identity itself is already persisted; the kind-0 is
// a UX polish on top.
export async function publishIdentityProfile(
  project: Project,
  identity: TestIdentity,
  nsec: string,
): Promise<{ ok: true; eventId: string } | { ok: false; reason: string }> {
  const port = getInprocRelayPort();
  if (!port) return { ok: false, reason: 'in-process relay not running' };

  // Defaults are chosen so the kind-0 looks like a real user's profile
  // in screenshots / demos: name + display_name only. `about`, `picture`,
  // etc. are set ONLY when the user supplies them via input.profile —
  // we never invent content that would look like leakage of "this is
  // really a test user" in a UI screenshot.
  const profile = identity.profile || {};
  const meta: Record<string, string> = {
    name:         identity.label,
    display_name: profile.displayName || humanize(identity.label),
  };
  if (profile.about)   meta.about   = profile.about;
  if (profile.picture) meta.picture = profile.picture;
  const content = JSON.stringify(meta);

  let signed;
  try {
    signed = signEventWithLocalKey(nsec, { kind: 0, content, tags: [] }, {
      testIdentityTag: { projectId: project.id },
    });
  } catch (e: any) {
    return { ok: false, reason: `sign failed: ${e?.message || e}` };
  }

  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const settled = { done: false };
    const settle = (r: { ok: true; eventId: string } | { ok: false; reason: string }) => {
      if (settled.done) return;
      settled.done = true;
      try { ws.close(); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => settle({ ok: false, reason: 'publish timeout' }), 4000);
    ws.once('open', () => {
      try { ws.send(JSON.stringify(['EVENT', signed])); }
      catch (e: any) { clearTimeout(timer); settle({ ok: false, reason: e?.message || 'send failed' }); }
    });
    ws.on('message', (data) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (Array.isArray(msg) && msg[0] === 'OK' && msg[1] === signed.id) {
        clearTimeout(timer);
        if (msg[2] === true) settle({ ok: true, eventId: signed.id });
        else settle({ ok: false, reason: msg[3] || 'relay rejected' });
      }
    });
    ws.once('error', (e) => { clearTimeout(timer); settle({ ok: false, reason: (e as Error).message }); });
  });
}

// "teacher-alice" → "Teacher Alice". Best-effort capitalization for
// the default display_name; users who want something different supply
// it via input.profile.displayName at add time.
function humanize(label: string): string {
  return label
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// Returns every (id → pubkey) pair across the provided projects. Used
// by cross-cutting predicates (e.g. Blossom's isTestIdentity check)
// without coupling this module to the projects-registry IO.
export function listAllTestPubkeys(projects: Project[]): Array<{ pubkey: string; projectId: string }> {
  const out: Array<{ pubkey: string; projectId: string }> = [];
  for (const p of projects) {
    const fp = fileFor(p);
    if (!fp) continue;
    migrateLegacy(p);
    const r = readFileStrict(fp);
    if (!r.ok) continue;
    for (const id of r.data.identities) out.push({ pubkey: id.pubkey, projectId: p.id });
  }
  return out;
}
