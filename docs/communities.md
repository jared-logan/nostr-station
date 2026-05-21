# Communities

**Managed GRAIN private relays on nvpn meshes.** A community is a
nostr-station-supervised [GRAIN](https://github.com/0ceanSlim/grain)
process bound 1:1 to an nvpn network, with its own allowlist, banlist,
LMDB datastore, and NIP-86 admin interface. The dashboard provides
the control plane; GRAIN provides the relay; nvpn provides the
network. Different communities never share a mesh.

This page is the operator's reference. The plan that drove the
design lives at the top of this repository's PR history.

## When to use it

Spin up a community when you want a private feed for a group of
people you know: a family, a friend group, a book club, a local
neighborhood, a hobby project's contributors. Each community gets:

- Its own GRAIN process on its own port (auto-allocated from 7778).
- Its own nvpn network (optional — local-only mode skips the mesh).
- Its own allowlist (only listed pubkeys can publish/read).
- Its own NIP-86 admin verbs (ban / allow / list).
- Its own log buffer, healthcheck, and crash-restart policy.

It is **not** the right tool for:

- **A public Nostr relay open to the world.** The current build
  refuses non-loopback binds without an explicit nvpn tunnel, and
  has no port-forward / TLS / Let's Encrypt path. Public-internet
  privacy mode is v2.
- **An app's local dev relay.** That's what the in-process relay
  on `7777` is for. Solo developers never need to touch this
  surface.
- **A NIP-29 group.** Communities are allowlist-based private
  relays — the membership boundary is the relay, not an event tag.
  NIP-29 (formal groups) may land later if upstream demand
  materializes.

## On-disk layout

Per-community state lives under `~/.nostr-station/communities/<id>/`:

```
<id>/
  community.json    nostr-station-owned manifest (id, name, port, …)
  config.yml        GRAIN config (server.port, rate limits, …)
  whitelist.yml     pubkey allowlist
  blacklist.yml     pubkey + word denylist (auto-created by GRAIN)
  data/             LMDB databank (managed by GRAIN)
  grain.pid         supervisor's record of the live PID
```

The `community.json` manifest is the dashboard's source of truth for
metadata (name, privacy mode, port, nvpn binding). GRAIN never reads
it — splitting our metadata out of GRAIN's YAML keeps a future
upstream config-schema change from colliding with our fields.

## Privacy modes

Two modes today, one deferred:

- **Local only** — GRAIN binds to `127.0.0.1`. Reachable only from
  the host machine. Good for testing.
- **Private network** — GRAIN binds to the host's tunnel IP on a
  specific nvpn network. Members of that network can reach the
  relay; nothing else can. Subnet routing and exit-node features
  are refused: the subsystem will not operate on a network where
  `advertise-routes` or `advertise-exit-node` is set, to prevent
  accidental LAN exposure.
- **Public internet** *(deferred to v2)* — needs Let's Encrypt,
  port-forwarding wizard, public-IP detection, TLS termination.
  Shipping it half-baked is worse UX than not offering it.

## Security model

Encoded as three deliberate rules (`src/lib/community-process.ts`):

1. **GRAIN binds to the community's nvpn tunnel IP, never `0.0.0.0`.**
   If the tunnel has no IP yet, GRAIN doesn't start.
2. **Subnet routing / exit-node flags are never auto-enabled.**
   The subsystem refuses networks where they're set.
3. **Dashboard binding requires explicit network selection.**
   The default is loopback; the Mobile access flow (when it ships)
   is the only path to a non-loopback bind, and picking a network
   is the user's consent.

## Process supervision

- **Restart backoff:** 1s / 2s / 4s / 8s / 30s ceiling. After **5
  consecutive crashes** the community moves to `error: …` with the
  last 50 log lines surfaced. Manual restart only — we never loop
  forever.
- **Healthcheck:** every 10s, NIP-11 GET to the community's bind
  address. Two consecutive failures → `unhealthy` with a
  diagnostic line in the per-community log buffer.
- **Orphan reconciliation:** on dashboard boot, every `grain.pid`
  file is probed for liveness and cmdline-fingerprinted. Matches
  get SIGTERMed + respawned under fresh supervision (so log piping
  works); mismatches are **never** signalled — that's the
  PID-reuse safety guarantee.

## CLI

- `nostr-station status --json` includes a top-level
  `communities[]` array when one or more communities exist.
  Each entry: `id`, `name`, `port`, `status`, `privacyMode`,
  `memberCount`.
- `nostr-station add grain` installs the pinned GRAIN binary into
  `~/.nostr-station/bin/grain` (no sudo).

## NIP-86 admin

All admin actions flow through GRAIN's NIP-86 endpoint
(`POST /` on the community's port, `application/nostr+json+rpc`,
NIP-98-gated). nostr-station signs NIP-98 challenges via the saved
Amber bunker. The community owner's npub is the NIP-86 admin
pubkey — defaults to the dashboard owner, can be overridden at
creation time.

Verbs typed in `src/lib/community-admin.ts`: `banpubkey`,
`allowpubkey`, `listbannedpubkeys`, `listallowedpubkeys`,
`allowkind`, `disallowkind`, `listallowedkinds`, `stats`,
`supportedmethods`. Raw `callCommunityAdmin(id, { method, params })`
escape hatch for the full NIP-86 method set.

**Signing cadence:** the current implementation prompts Amber on
every NIP-86 call. The plan calls for **silent-sign delegation**
(an 8-hour trust window the user explicitly grants per community)
so moderators triaging a flood don't get prompted per click. That
toggle lands with the full Moderation tab.

## What's deferred to v2

- Public-internet privacy mode (Let's Encrypt + port-forward UX).
- GRAIN data migration across upstream version bumps.
- Restore from backup (Export ships, Import doesn't).
- Cross-machine community migration ("I got a new laptop").
- "Test from outside" reachability probe.
- NIP-29 group support.
- iOS phone pairing (gated on nvpn iOS client availability).
- Silent-sign delegation toggle (gated on the full Moderation tab).
- Mobile access card (Identity panel — gated on the dashboard-
  binding rules + nvpn mobile client UX).
- Join an invitation wizard (guest-side flow — gated on the
  full nvpn integration).

## See also

- `src/lib/communities.ts` — manifest CRUD, port allocation.
- `src/lib/community-yaml.ts` — atomic GRAIN config I/O.
- `src/lib/community-process.ts` — supervisor + healthcheck +
  reconciliation.
- `src/lib/community-admin.ts` — NIP-86 RPC client.
- `src/lib/routes/communities.ts` — REST + SSE surface.
- `tests/communities.test.ts`, `tests/community-process.test.ts`,
  `tests/community-dependencies.test.ts`,
  `tests/community-admin.test.ts`,
  `tests/community-routes.test.ts`,
  `tests/community-yaml.test.ts`,
  `tests/status-cli.test.ts`,
  `tests/ai-context-communities.test.ts` — coverage matrix.
