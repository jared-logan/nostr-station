/**
 * NIP-01 event-kind classifier.
 *
 * Used by the promote pipeline (and any future caller that needs to
 * reason about replaceable / ephemeral semantics generically) to handle
 * any kind correctly, including ones the dashboard has never seen.
 * The whole point of the local dev relay is to let users iterate on
 * new event kinds without polluting public relays — locking down the
 * promote path to a hardcoded allowlist would defeat that.
 *
 * Reference: https://github.com/nostr-protocol/nips/blob/master/01.md
 * (search "Standard event kinds" → the table that ranges 1000-9999 as
 * Regular, 10000-19999 as Replaceable, 20000-29999 as Ephemeral, and
 * 30000-39999 as Parameterized Replaceable / "Addressable"). Plus the
 * legacy individual-kind exceptions (0, 3 are replaceable; 5 is the
 * deletion-request signal).
 */

export type EventClass =
  | 'regular'        // stored, non-replaceable — new publish creates a new note
  | 'replaceable'    // relays keep only the latest per (pubkey, kind)
  | 'addressable'    // parameterized replaceable — kept per (pubkey, kind, d-tag)
  | 'ephemeral'      // relays do not store these by design
  | 'deletion';      // NIP-09 kind 5 — authoritative delete signal

export interface KindInfo {
  kind:        number;
  class:       EventClass;
  // Whether a promote needs to keep created_at intact (replaceable /
  // addressable do; regular events get a fresh timestamp so dedupers
  // treat the prod copy as distinct from the local original).
  preserveTs:  boolean;
  // True when promote should refuse this kind entirely. Caller's
  // `RefusedEvent.reason` echoes this back to the user.
  promotable:  boolean;
  // Human-readable explanation used in dry-run output.
  note?:       string;
}

export function classifyKind(kind: number): KindInfo {
  if (!Number.isInteger(kind) || kind < 0 || kind > 65535) {
    return { kind, class: 'regular', preserveTs: false, promotable: false,
             note: 'kind out of valid range (0–65535)' };
  }
  // Legacy individually-classified kinds. NIP-01 carves these out
  // because they predate the numeric-range conventions.
  if (kind === 0)  return { kind, class: 'replaceable', preserveTs: true,  promotable: true };
  if (kind === 3)  return { kind, class: 'replaceable', preserveTs: true,  promotable: true,
                            note: 'kind 3 is the user\'s contact list — promote rewrites it wholesale' };
  if (kind === 5)  return { kind, class: 'deletion',    preserveTs: false, promotable: true,
                            note: 'kind 5 is a deletion request — confirm e-tags reference public events' };
  // Numeric-range classification.
  if (kind >= 10000 && kind < 20000) return { kind, class: 'replaceable',  preserveTs: true,  promotable: true };
  if (kind >= 20000 && kind < 30000) return { kind, class: 'ephemeral',    preserveTs: false, promotable: false,
                                              note: 'ephemeral kinds are not stored by relays — promote is incoherent' };
  if (kind >= 30000 && kind < 40000) return { kind, class: 'addressable',  preserveTs: true,  promotable: true };
  // Everything else (1, 2, 4, 6, 7, 1000-9999, etc.) is "regular".
  return { kind, class: 'regular', preserveTs: false, promotable: true };
}
