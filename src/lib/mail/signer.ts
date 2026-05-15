/**
 * Signer abstraction over "user-key" operations used by the mail pipeline.
 *
 * The mail flow needs four things from the user's identity:
 *   - the user's pubkey (so we can stamp rumors with the right author);
 *   - a NIP-44 encrypt of an arbitrary plaintext to an arbitrary recipient;
 *   - a NIP-44 decrypt of arbitrary ciphertext from an arbitrary sender;
 *   - signing an event (the kind 13 seal).
 *
 * Production builds use AmberSigner, which routes every call through the
 * persisted NIP-46 bunker — the user's nsec never touches the machine.
 * Tests use LocalSigner, which holds a 32-byte secret in memory and does
 * the same operations with nostr-tools locally. Both implementations are
 * interchangeable from the call site's perspective so the wrap/unwrap
 * code can be exercised by unit tests without spinning up an Amber pairing.
 */

import { nip44 } from 'nostr-tools';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from '../nostr-query.js';
import {
  signEventWithSavedBunker,
  nip44EncryptWithSavedBunker,
  nip44DecryptWithSavedBunker,
  getPubkeyWithSavedBunker,
} from '../auth-bunker.js';

export interface UnsignedEventTemplate {
  kind:       number;
  created_at: number;
  tags:       string[][];
  content:    string;
}

export interface Signer {
  getPublicKey():
    Promise<string>;
  nip44Encrypt(thirdPartyPubkey: string, plaintext: string):
    Promise<string>;
  nip44Decrypt(thirdPartyPubkey: string, ciphertext: string):
    Promise<string>;
  signEvent(template: UnsignedEventTemplate):
    Promise<NostrEvent>;
}

// ── LocalSigner ────────────────────────────────────────────────────────────
//
// In-memory signer. Only used by unit tests and by the optional
// "test-identity-as-mail-sender" flow that future test fixtures may need.
// NEVER used to sign the station owner's events — that path runs through
// AmberSigner so nsec stays on the user's phone.

export class LocalSigner implements Signer {
  private readonly secret: Uint8Array;
  private readonly pubkey: string;

  constructor(secret: Uint8Array) {
    if (secret.length !== 32) throw new Error('LocalSigner: secret must be 32 bytes');
    this.secret = secret;
    this.pubkey = getPublicKey(secret);
  }

  async getPublicKey(): Promise<string> {
    return this.pubkey;
  }

  async nip44Encrypt(thirdPartyPubkey: string, plaintext: string): Promise<string> {
    const key = nip44.v2.utils.getConversationKey(this.secret, thirdPartyPubkey);
    return nip44.v2.encrypt(plaintext, key);
  }

  async nip44Decrypt(thirdPartyPubkey: string, ciphertext: string): Promise<string> {
    const key = nip44.v2.utils.getConversationKey(this.secret, thirdPartyPubkey);
    return nip44.v2.decrypt(ciphertext, key);
  }

  async signEvent(template: UnsignedEventTemplate): Promise<NostrEvent> {
    const ev = finalizeEvent({
      kind:       template.kind,
      created_at: template.created_at,
      tags:       template.tags,
      content:    template.content,
    }, this.secret);
    return ev as unknown as NostrEvent;
  }
}

// ── AmberSigner ───────────────────────────────────────────────────────────
//
// Routes every operation through the persisted NIP-46 bunker pairing. The
// helpers in auth-bunker.ts each open + close a BunkerSigner per call —
// that's expensive (1 connect handshake per op) and gives the user a
// per-operation Amber prompt unless they've granted blanket approval for
// these verbs in the Amber UI.
//
// For receive-side workloads (decrypting an inbox of N gift wraps), the
// per-call cost is acceptable for the MVP — N is small in practice and
// callers can decrypt-once-store-once. If receive throughput becomes a
// problem, the auth-bunker helpers can grow a long-lived signer pool
// without changing this surface.

export class AmberSigner implements Signer {
  async getPublicKey(): Promise<string> {
    const r = await getPubkeyWithSavedBunker();
    if (!r.ok || !r.pubkey) throw new Error(r.error || 'amber: get_public_key failed');
    return r.pubkey;
  }

  async nip44Encrypt(thirdPartyPubkey: string, plaintext: string): Promise<string> {
    const r = await nip44EncryptWithSavedBunker(thirdPartyPubkey, plaintext);
    if (!r.ok || typeof r.ciphertext !== 'string') {
      throw new Error(r.error || 'amber: nip44_encrypt failed');
    }
    return r.ciphertext;
  }

  async nip44Decrypt(thirdPartyPubkey: string, ciphertext: string): Promise<string> {
    const r = await nip44DecryptWithSavedBunker(thirdPartyPubkey, ciphertext);
    if (!r.ok || typeof r.plaintext !== 'string') {
      throw new Error(r.error || 'amber: nip44_decrypt failed');
    }
    return r.plaintext;
  }

  async signEvent(template: UnsignedEventTemplate): Promise<NostrEvent> {
    const r = await signEventWithSavedBunker(template);
    if (!r.ok || !r.signedEvent) throw new Error(r.error || 'amber: sign_event failed');
    return r.signedEvent as NostrEvent;
  }
}
