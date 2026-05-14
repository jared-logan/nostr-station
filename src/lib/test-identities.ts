/**
 * Per-project test identities.
 *
 * Throwaway keypairs scoped to a single project — used by the project's
 * app code during local development to simulate multiple users without
 * burning real social capital on disposable accounts.
 *
 * Storage: `<project>/.nostr-station/test-identities.json` (mode 0600,
 * gitignored). Plain JSON, intentionally human-inspectable — the nsecs
 * are not encrypted on disk; the safety story is the `client` tag
 * (forced into every event signed by these keys) plus the local-only
 * relay write-gating and the promote-time refusal. See:
 *
 *   - src/lib/local-signer.ts        — forces the "client" tag at sign time
 *   - src/relay/index.ts             — refuses non-loopback publish of tagged events
 *   - src/lib/promote.ts (Phase E)   — refuses to ever publish to prod
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
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import type { Project } from './projects.js';
import { CONFIG_DIRNAME, ensureConfigDir } from './project-config.js';
import { getWhitelistRef } from './routes/_shared.js';

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

function fileFor(project: Project): string | null {
  if (!project.path) return null;
  return path.join(project.path, CONFIG_DIRNAME, FILE_NAME);
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
  ensureConfigDir(project);

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
  const existing = readFileStrict(fp);
  if (!existing.ok) return null;
  const rec = existing.data.identities.find(i => i.id === id);
  return rec ? rec.nsec : null;
}

// Returns every (id → pubkey) pair across the provided projects. Used
// by cross-cutting predicates (e.g. Blossom's isTestIdentity check)
// without coupling this module to the projects-registry IO.
export function listAllTestPubkeys(projects: Project[]): Array<{ pubkey: string; projectId: string }> {
  const out: Array<{ pubkey: string; projectId: string }> = [];
  for (const p of projects) {
    const fp = fileFor(p);
    if (!fp) continue;
    const r = readFileStrict(fp);
    if (!r.ok) continue;
    for (const id of r.data.identities) out.push({ pubkey: id.pubkey, projectId: p.id });
  }
  return out;
}
