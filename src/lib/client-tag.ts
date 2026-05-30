/**
 * Canonical NIP-89 `client` tag for events nostr-station publishes.
 *
 * Single source of truth so every publish path — the native /api/client
 * kind-1 flow, repo announcements (kind 30617), and nsite deploys
 * (kind 35128 + the 30617 web-tag refresh) — stamps the SAME tag, and
 * therefore links back to nostr-station's NIP-89 handler event the way
 * a kind-1 from the Client panel does (the "open in / published by"
 * affordance in Ditto / nostrhub.io).
 *
 * 4-element form: ["client", <name>, <kind>:<pubkey>:<d-tag>, <relay-hint>].
 * The coordinate points at the kind-31990 "client handler" event
 * (NIP-89 handler information), signed by the project pubkey (291c75d…,
 * the same identity that anchors the landing-page nsite and signs ngit
 * merge events). Publish/refresh that handler with
 * `npm run publish-client-handler`; this constant MUST stay in sync with
 * the `client` naddr baked into scripts/fetch-ditto.mjs so the iframe
 * (Ditto) and native publish paths emit an identical tag.
 *
 * A bare ["client", "nostr-station"] (2-element) is NOT enough — it shows
 * the name but doesn't link to the app handler. Always use this.
 */

/** The project pubkey that signs the kind-31990 handler event. */
export const CLIENT_HANDLER_PUBKEY =
  '291c75d937a45f66a1209f8ea6611df7448c59b3526520c66ca2cdcd37f1bfbe';

/** The handler event's d-tag (also the client display name). */
export const CLIENT_NAME = 'nostr-station';

/** The full 4-element NIP-89 client tag. Frozen so callers can't mutate
 *  the shared array; spread it (`[...CLIENT_TAG]`) when building a tag set. */
export const CLIENT_TAG: readonly string[] = Object.freeze([
  'client',
  CLIENT_NAME,
  `31990:${CLIENT_HANDLER_PUBKEY}:${CLIENT_NAME}`,
  'wss://relay.nsite.lol',
]);

/** Returns true if `tags` already carries a nostr-station client tag (in
 *  either the 2- or 4-element form) — used to avoid double-stamping. */
export function hasNostrStationClientTag(tags: string[][]): boolean {
  return tags.some(t => t[0] === 'client' && t[1] === CLIENT_NAME);
}

/** Append the canonical client tag to a tag array unless one is already
 *  present. Mutates and returns `tags` for chaining. */
export function stampClientTag(tags: string[][]): string[][] {
  if (!hasNostrStationClientTag(tags)) tags.push([...CLIENT_TAG]);
  return tags;
}
