/**
 * WebSocket payload-size limits — defense against OOM via single large
 * frame. The `ws` library defaults to 100 MiB; we cap at 1 MiB so a
 * malicious external relay (mail/inbox connects out to user-configured
 * relays) or a misbehaving browser client can't blow up the process.
 *
 * Sizing rationale:
 *   - Largest realistic Nostr event today is a kind-34128 nsite manifest
 *     with thousands of file entries (~500 KiB worst-case).
 *   - Damus relay caps at 256 KiB; strfry at 128 KiB. We're more
 *     permissive than the ecosystem norm, not less.
 *   - 1 MiB leaves 2× headroom for present needs and is a single
 *     constant to bump when larger event kinds emerge (binary
 *     attachments via NIP-94, very-large-site nsite manifests).
 *
 * Applies to both directions:
 *   - Relay WSS (in-process, listens on :7777): accepts up to MAX_WS_PAYLOAD
 *     per frame from any client.
 *   - Inbox + nostr-query + identity + repo + promote + seed +
 *     setup-verify + test-identities: outbound connections to external
 *     relays should reject oversized server-to-client frames before
 *     they're parsed.
 *
 * Note: src/relay/index.ts intentionally re-declares this constant to
 * preserve the "relay layer never imports from lib" invariant. Keep
 * the two in sync; if you bump it here, bump it there too.
 */
export const MAX_WS_PAYLOAD = 1024 * 1024;
