/**
 * Project-scoped seed: publish a small batch of kind-1 events as each
 * test identity to the project's active dev relay.
 *
 * Intentionally minimal in v1. The plan envisioned template-driven
 * `seedFlows` (role-aware fixture publishing with media uploads via
 * local Blossom). What's here is the "publish hello-world events" core
 * primitive — enough to confirm the relay + test-identities + active-
 * env round-trip works end-to-end. Richer flows can layer on top.
 */

import WebSocket from 'ws';
import type { Project } from './projects.js';
import {
  listIdentities, getNsec,
} from './test-identities.js';
import { signEventWithLocalKey } from './local-signer.js';

export interface SeedOptions {
  countPerIdentity?: number;  // default: 3
}

export interface SeedResult {
  identitiesUsed:  number;
  eventsPublished: number;
  relayUrl:        string;
  errors:          string[];
}

export async function seedProject(project: Project, opts: SeedOptions = {}): Promise<SeedResult> {
  const count = Math.max(1, Math.min(50, opts.countPerIdentity ?? 3));
  const result: SeedResult = {
    identitiesUsed: 0,
    eventsPublished: 0,
    relayUrl: '',
    errors: [],
  };

  // Pick the dev relay from the active environment; fall back to the
  // first relay in the active block if active='prod' (though seeding
  // against prod is unusual — the use case is dev fixture data).
  const env = project.environment;
  if (!env) {
    result.errors.push('Project has no environment block — click "Isolate to local infra" in Settings first.');
    return result;
  }
  const block = env[env.active];
  if (!block.relays.length) {
    result.errors.push(`environment.${env.active}.relays is empty — add a relay URL in Settings first.`);
    return result;
  }
  result.relayUrl = block.relays[0];

  const list = listIdentities(project);
  if (!list.ok) {
    result.errors.push(`Test identities unavailable: ${list.reason}`);
    return result;
  }
  if (list.identities.length === 0) {
    result.errors.push('No test users for this project — add some in Settings → Test users.');
    return result;
  }

  // Open one WebSocket and publish every event through it. Apps could
  // open one per identity, but the relay accepts cross-pubkey EVENTs on
  // a single connection so the simpler shape is fine.
  let ws: WebSocket | null = null;
  try {
    ws = await connect(result.relayUrl);
    for (const id of list.identities) {
      const nsec = getNsec(project, id.id);
      if (!nsec) {
        result.errors.push(`identity ${id.label}: nsec unavailable`);
        continue;
      }
      result.identitiesUsed++;
      for (let i = 0; i < count; i++) {
        const ev = signEventWithLocalKey(nsec, {
          kind: 1,
          content: renderSeedContent(id.label, id.role, i),
          tags: [],
        }, { testIdentityTag: { projectId: project.id } });
        try {
          await publish(ws, ev);
          result.eventsPublished++;
        } catch (e: any) {
          result.errors.push(`publish failed for ${id.label} #${i}: ${e?.message || e}`);
        }
      }
    }
  } catch (e: any) {
    result.errors.push(`relay connect failed: ${e?.message || e}`);
  } finally {
    try { ws?.close(); } catch {}
  }

  return result;
}

function renderSeedContent(label: string, role: string, i: number): string {
  const greetings = [
    `gm from ${label}`,
    `hello world, ${label} here`,
    `${label} (${role || 'no role'}) testing the local relay · note ${i + 1}`,
    `seeded fixture from ${label}`,
  ];
  return greetings[i % greetings.length];
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`connect timeout: ${url}`));
    }, 5000);
    ws.once('open',  () => { clearTimeout(timer); resolve(ws); });
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function publish(ws: WebSocket, ev: any): Promise<void> {
  return new Promise((resolve, reject) => {
    // Relay sends OK ["OK", eventId, success, message] in response.
    const handler = (data: WebSocket.RawData) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (Array.isArray(msg) && msg[0] === 'OK' && msg[1] === ev.id) {
        ws.off('message', handler);
        if (msg[2] === true) resolve();
        else reject(new Error(msg[3] || 'relay rejected'));
      }
    };
    ws.on('message', handler);
    try { ws.send(JSON.stringify(['EVENT', ev])); }
    catch (e) { ws.off('message', handler); reject(e); }
    setTimeout(() => {
      ws.off('message', handler);
      reject(new Error('publish ack timeout'));
    }, 5000);
  });
}
