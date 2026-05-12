/**
 * Setup verification — extracted from web-server.ts as part of the D13
 * split. Implements Phase 4 of the user-journey spec.
 *
 * Asks the saved bunker client (Amber on the user's phone) to sign a
 * kind-1 test event, publishes it to the running in-process relay over
 * ws://, and reads it back via a REQ subscription. Each step is named
 * so the client can render a checklist; failures stop at the first
 * broken step.
 *
 * Why ws:// instead of calling the relay's store directly: the test is
 * trying to prove "your apps will be able to talk to this relay." Going
 * through the WebSocket layer exercises the same path the user's apps
 * will use (NIP-01 over WS), which is what we want to verify.
 */
import { readIdentity } from './identity.js';
import { signEventWithSavedBunker } from './auth-bunker.js';

export interface VerifyStep { name: string; ok: boolean; detail?: string }
export interface VerifyResult {
  ok:      boolean;
  steps:   VerifyStep[];
  eventId?: string;
  npub?:    string;
  error?:   string;
}

export async function runSetupVerify(): Promise<VerifyResult> {
  const steps: VerifyStep[] = [];
  const ident = readIdentity();
  // Step 1 — sign via Amber. Generic event template; signEventWithSavedBunker
  // returns a fully-signed event whose pubkey is the user's main pubkey.
  const template = {
    kind:       1,
    created_at: Math.floor(Date.now() / 1000),
    tags:       [['client', 'nostr-station-setup-verify']],
    content:    'nostr-station: setup verification — you can ignore this event.',
  };
  let signed: any;
  try {
    const r = await signEventWithSavedBunker(template, 60_000);
    if (!r.ok || !r.signedEvent) {
      steps.push({ name: 'sign-via-amber', ok: false, detail: r.error || 'signing failed' });
      return { ok: false, steps, error: 'Amber did not sign the test event' };
    }
    signed = r.signedEvent;
    steps.push({ name: 'sign-via-amber', ok: true, detail: `signed by ${signed.pubkey.slice(0, 8)}…` });
  } catch (e: any) {
    steps.push({ name: 'sign-via-amber', ok: false, detail: String(e?.message ?? e) });
    return { ok: false, steps, error: 'sign step failed' };
  }

  // Resolve relay URL — same env vars maybeStartInprocRelay sets.
  const relayHost = process.env.RELAY_HOST || '127.0.0.1';
  const relayPort = process.env.RELAY_PORT || '7777';
  const relayUrl  = `ws://${relayHost}:${relayPort}`;

  // Steps 2 + 3 — publish + read back, both over a single WS connection.
  // Lazy-import ws so we don't pay the cost on cold-path requests.
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(relayUrl);

  // Generic JSON-frame waiter so each step can wait for the message it
  // cares about without racing on the buffer's order.
  const waiters: Array<{ pred: (m: any[]) => boolean; resolve: (m: any[]) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }> = [];
  const buffer: any[][] = [];
  ws.on('message', d => {
    try {
      const msg = JSON.parse(d.toString());
      if (!Array.isArray(msg)) return;
      const idx = waiters.findIndex(w => w.pred(msg));
      if (idx >= 0) {
        const [w] = waiters.splice(idx, 1);
        if (w.timer) clearTimeout(w.timer);
        w.resolve(msg);
      } else {
        buffer.push(msg);
      }
    } catch { /* not JSON / not array — ignore */ }
  });
  const next = (pred: (m: any[]) => boolean, ms = 5_000): Promise<any[]> => {
    const idx = buffer.findIndex(pred);
    if (idx >= 0) return Promise.resolve(buffer.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.findIndex(w => w.pred === pred);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error(`timeout after ${ms}ms`));
      }, ms);
      waiters.push({ pred, resolve, reject, timer });
    });
  };

  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open',  () => resolve());
      ws.once('error', reject);
    });

    // Step 2 — publish.
    ws.send(JSON.stringify(['EVENT', signed]));
    const ok = await next(m => m[0] === 'OK' && m[1] === signed.id, 10_000);
    if (ok[2] !== true) {
      steps.push({ name: 'publish-to-relay', ok: false, detail: ok[3] || 'relay rejected event' });
      ws.close();
      return { ok: false, steps, error: 'relay rejected the test event' };
    }
    steps.push({ name: 'publish-to-relay', ok: true, detail: `accepted by ${relayUrl}` });

    // Step 3 — read back via REQ. The store is local and the round-trip
    // takes single-digit ms, so a 5s timeout is generous slack.
    const subId = 'setup-verify';
    ws.send(JSON.stringify(['REQ', subId, { ids: [signed.id] }]));
    await next(m => m[0] === 'EVENT' && m[1] === subId && m[2]?.id === signed.id, 5_000);
    await next(m => m[0] === 'EOSE'  && m[1] === subId, 5_000);
    ws.send(JSON.stringify(['CLOSE', subId]));
    steps.push({ name: 'read-back-from-relay', ok: true, detail: 'event found in store' });
  } catch (e: any) {
    steps.push({ name: 'read-back-from-relay', ok: false, detail: String(e?.message ?? e) });
    try { ws.close(); } catch {}
    return { ok: false, steps, error: 'relay round-trip failed' };
  }
  try { ws.close(); } catch {}

  return { ok: true, steps, eventId: signed.id, npub: ident.npub };
}
