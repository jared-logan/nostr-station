/**
 * Local-only event signer for project-scoped test identities.
 *
 * Wraps `nostr-tools/pure` `finalizeEvent` with a mandatory "client" tag
 * when the caller marks an event as test-identity-authored. The tag is
 * the load-bearing piece for the local-to-prod safety story:
 *
 *   1. The local relay's accept path refuses to forward test-tagged
 *      events to any non-loopback endpoint (Phase B handler change).
 *   2. The Phase E promote pipeline refuses to publish events carrying
 *      the test tag to public relays — full stop, no opt-out.
 *
 * This module only handles the signing side. Where the tag is added is
 * deliberately inside this signer (not at the call site) so it's
 * impossible to forget — passing `testIdentityTag` forces the tag.
 */

import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';

export interface EventTemplate {
  kind:        number;
  created_at?: number;
  tags?:       string[][];
  content:     string;
}

export interface SignOptions {
  // When set, the event is bound to a project's test-identity registry.
  // The signer appends ["client", "nostr-station-test", projectId] to
  // tags before signing so the relay and promote layers can reject
  // accordingly.
  testIdentityTag?: { projectId: string };
}

export interface SignedEvent {
  id:         string;
  pubkey:     string;
  kind:       number;
  created_at: number;
  tags:       string[][];
  content:    string;
  sig:        string;
}

export const TEST_CLIENT_NAME = 'nostr-station-test';

export function signEventWithLocalKey(
  nsecOrHex: string,
  template:  EventTemplate,
  opts:      SignOptions = {},
): SignedEvent {
  const sk = nsecToBytes(nsecOrHex);
  const tags = Array.isArray(template.tags) ? template.tags.map(t => t.slice()) : [];
  if (opts.testIdentityTag) {
    tags.push(['client', TEST_CLIENT_NAME, opts.testIdentityTag.projectId]);
  }
  const ev = finalizeEvent({
    kind:       template.kind,
    created_at: template.created_at ?? Math.floor(Date.now() / 1000),
    tags,
    content:    template.content,
  }, sk);
  return ev as SignedEvent;
}

// Helper exported separately for callers that want the pubkey
// (e.g. to populate a profile row) without a full sign cycle.
export function pubkeyFromNsec(nsecOrHex: string): string {
  return getPublicKey(nsecToBytes(nsecOrHex));
}

function nsecToBytes(nsecOrHex: string): Uint8Array {
  if (typeof nsecOrHex !== 'string' || !nsecOrHex) {
    throw new Error('local-signer: nsec is required');
  }
  if (nsecOrHex.startsWith('nsec1')) {
    const decoded = nip19.decode(nsecOrHex);
    if (decoded.type !== 'nsec') throw new Error('local-signer: not an nsec');
    return decoded.data as Uint8Array;
  }
  // Accept raw 64-hex for the storage round-trip — internal callers
  // sometimes carry secrets as hex strings to match the public-key
  // representation.
  if (/^[0-9a-f]{64}$/i.test(nsecOrHex)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(nsecOrHex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  throw new Error('local-signer: input must be nsec1… or 64-char hex');
}

// True when an event was authored by a test identity (carries the
// distinctive client tag). Used by the relay and the promote pipeline
// to fail-closed against test-tagged events.
export function isTestIdentityEvent(event: { tags?: string[][] }): boolean {
  if (!event?.tags) return false;
  for (const t of event.tags) {
    if (Array.isArray(t) && t[0] === 'client' && t[1] === TEST_CLIENT_NAME) return true;
  }
  return false;
}
