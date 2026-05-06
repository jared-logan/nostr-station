/**
 * Project-templates routes — `/api/templates` CRUD over the
 * `~/.config/nostr-station/templates.json` registry.
 *
 * Surface:
 *   GET    /api/templates              — full list (built-ins + user)
 *   POST   /api/templates              — create new (rejects builtin: true)
 *   GET    /api/templates/:id          — single template
 *   PATCH  /api/templates/:id          — partial update (id + builtin immutable)
 *   DELETE /api/templates/:id          — delete (rejects builtins)
 *   POST   /api/templates/:id/reset    — restore a builtin's seed values
 *
 * Authentication is handled by the orchestrator before this dispatcher
 * runs (NIP-98 session check); we just validate input + persist.
 *
 * Returns `true` when matched and a response was written; `false` lets
 * the orchestrator try its remaining route groups.
 */
import http from 'http';
import {
  readTemplates, getTemplate, createTemplate, updateTemplate,
  deleteTemplate, resetTemplate, type Template,
} from '../templates.js';
import { readBody } from './_shared.js';

export async function handleTemplates(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  if (url === '/api/templates' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ templates: readTemplates() }));
    return true;
  }

  if (url === '/api/templates' && method === 'POST') {
    let parsed: Partial<Template>;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON body' }));
      return true;
    }
    const result = createTemplate(parsed as Template);
    if (!result.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return true;
    }
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ template: result.template }));
    return true;
  }

  // /api/templates/:id and /api/templates/:id/reset
  const m = url.match(/^\/api\/templates\/([a-z0-9][a-z0-9-]{0,40})(?:\/(reset))?$/);
  if (!m) return false;
  const [, id, action] = m;

  if (action === 'reset' && method === 'POST') {
    const result = resetTemplate(id);
    if (!result.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ template: result.template }));
    return true;
  }
  if (action) return false;

  if (method === 'GET') {
    const t = getTemplate(id);
    if (!t) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ template: t }));
    return true;
  }

  if (method === 'PATCH') {
    let parsed: Partial<Template>;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON body' }));
      return true;
    }
    const result = updateTemplate(id, parsed);
    if (!result.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ template: result.template }));
    return true;
  }

  if (method === 'DELETE') {
    const result = deleteTemplate(id);
    if (!result.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return true;
    }
    res.writeHead(204, {});
    res.end();
    return true;
  }

  return false;
}
