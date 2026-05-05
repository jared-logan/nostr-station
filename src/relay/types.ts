// Minimal Nostr event type — matches NIP-01.
// We accept what the wire gives us (signature already verified by nostr-tools)
// and trust id/pubkey to be lowercase hex per spec.

export interface NostrEvent {
  id:         string;
  pubkey:     string;
  created_at: number;
  kind:       number;
  tags:       string[][];
  content:    string;
  sig:        string;
}

// NIP-01 filter shape. Tag filters live as `#<letter>` keys; we keep them
// in a separate map so the rest of the type stays well-typed.
export interface NostrFilter {
  ids?:        string[];
  authors?:    string[];
  kinds?:      number[];
  since?:      number;
  until?:      number;
  limit?:      number;
  // Tag filters are dynamic ("#e", "#p", "#a", ...). Stored verbatim.
  [key: `#${string}`]: string[] | undefined;
}
