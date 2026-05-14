/**
 * Test identities routes — project-scoped throwaway keys.
 *
 *   GET    /api/projects/:id/test-identities
 *   POST   /api/projects/:id/test-identities          { label, role, profile? }
 *   POST   /api/projects/:id/test-identities/reset    (wipe all)
 *   DELETE /api/projects/:id/test-identities/:tid
 *   POST   /api/projects/:id/test-identities/:tid/sign { template }
 *
 * Returns `true` when the request was matched. Identity nsecs never
 * leave the server boundary — the /sign endpoint accepts an unsigned
 * template, signs server-side, and returns the resulting signed event.
 */

import http from 'http';
import type { Project } from '../projects.js';
import {
  listIdentities, addIdentity, removeIdentity, regenerateAll, getNsec,
} from '../test-identities.js';
import { signEventWithLocalKey, type EventTemplate } from '../local-signer.js';
import { seedProject } from '../project-seed.js';
import { readBody } from './_shared.js';

export async function handleTestIdentities(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  project: Project,
  tail: string,
  method: string,
): Promise<boolean> {
  // List
  if (tail === 'test-identities' && method === 'GET') {
    const r = listIdentities(project);
    if (!r.ok) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: r.reason, mode: 'mode' in r ? r.mode : undefined }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ identities: r.identities }));
    return true;
  }

  // Create
  if (tail === 'test-identities' && method === 'POST') {
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); res.end('bad json'); return true; }
    const r = addIdentity(project, {
      label: String(parsed.label || ''),
      role:  String(parsed.role  || ''),
      profile: parsed.profile && typeof parsed.profile === 'object' ? {
        displayName: typeof parsed.profile.displayName === 'string' ? parsed.profile.displayName : undefined,
        about:       typeof parsed.profile.about       === 'string' ? parsed.profile.about       : undefined,
        picture:     typeof parsed.profile.picture     === 'string' ? parsed.profile.picture     : undefined,
      } : undefined,
    });
    if (!r.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: r.error }));
      return true;
    }
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      identity: r.result.identity,
      pubkey:   r.result.pubkey,
      // nsec is NEVER returned — the dashboard signs via /sign
      // server-side. App code that wants to sign as a test identity
      // also goes through /sign rather than holding the key in JS.
    }));
    return true;
  }

  // Seed — publish fixture kind-1s from each test identity (Phase D).
  // Lives under the test-identities prefix because the operation is
  // "publish as every test identity"; placing it here keeps the route
  // group cohesive.
  if (tail === 'test-identities/seed' && method === 'POST') {
    let parsed: any = {};
    try { parsed = JSON.parse(await readBody(req)); } catch {}
    const count = Number(parsed?.countPerIdentity || 3);
    const result = await seedProject(project, { countPerIdentity: count });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }

  // Reset (wipe all)
  if (tail === 'test-identities/reset' && method === 'POST') {
    try { await readBody(req); } catch {}
    const r = regenerateAll(project);
    if (!r.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: r.error }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cleared: r.cleared }));
    return true;
  }

  // Per-identity endpoints (sign + delete)
  const tidMatch = tail.match(/^test-identities\/([a-f0-9-]{10,})(?:\/([a-z]+))?$/);
  if (tidMatch) {
    const id  = tidMatch[1];
    const sub = tidMatch[2] || '';
    if (sub === '' && method === 'DELETE') {
      const r = removeIdentity(project, id);
      if (!r.ok) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: r.error }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pubkey: r.pubkey }));
      return true;
    }
    if (sub === 'sign' && method === 'POST') {
      let parsed: any = {};
      try { parsed = JSON.parse(await readBody(req)); }
      catch { res.writeHead(400); res.end('bad json'); return true; }
      const template = parsed?.template;
      if (!template || typeof template !== 'object') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing template' }));
        return true;
      }
      const nsec = getNsec(project, id);
      if (!nsec) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'identity not found' }));
        return true;
      }
      let signed;
      try {
        signed = signEventWithLocalKey(nsec, template as EventTemplate, {
          testIdentityTag: { projectId: project.id },
        });
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e?.message || 'sign failed' }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ event: signed }));
      return true;
    }
  }

  return false;
}
