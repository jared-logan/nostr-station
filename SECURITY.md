# Security Policy

## Reporting a Vulnerability

nostr-station handles key-adjacent infrastructure (local relay,
dashboard auth tokens, AI provider API keys, persisted bunker
clients). If you discover a security vulnerability, please **do not
open a public GitHub issue**.

Instead, open a private security advisory:
**https://github.com/jared-logan/nostr-station/security/advisories/new**

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix if you have one

We will respond within 72 hours and work with you on a fix before
public disclosure.

## Threat model

nostr-station runs as a single Node process bound to `127.0.0.1`. The
trust boundary is the local user — anything with shell access on the
machine has the same privileges as the dashboard.

| Surface | How it's handled |
|---------|-------------------|
| User's nsec | **Never on this machine.** All user-owned signing routes through Amber via NIP-46. The pairing handshake captures the user's npub via `signer.getPublicKey()` (no event signed during pairing). The verify stage and all subsequent signing requests (`signEventWithSavedBunker`) round-trip through the bunker. |
| AI provider API keys | Stored per-provider in the OS keychain under account name `ai:<provider-id>` (service `nostr-station`). |
| Local relay | In-process, bound to `127.0.0.1:7777` only. NIP-42 is **not** implemented — any signed event from any pubkey is accepted on loopback. The relay is a single-user dev tool, intentionally minimal; do not expose it to a public network. |
| Dashboard sign-in | NIP-98 challenge / response: server signs a 32-byte challenge (60 s TTL, single-use), the user's remote signer returns a kind-27235 event, server issues a 32-byte session token with an 8 h TTL (overridable via `NOSTR_STATION_SESSION_TTL`). Sessions are in-memory — a server restart invalidates all of them. |
| Session token storage | Client stores the token in `localStorage` so sessions survive tab close and browser restart (server-side TTL remains authoritative). Cleared on explicit sign-out. |
| Persisted bunker client | After a successful NIP-46 sign-in, the ephemeral client secret + bunker pointer is stashed at `~/.nostr-station/bunker-client.json` (mode `0600`, scoped by owner npub) for silent re-auth. **This is not a signing key** — Amber's nsec never leaves the phone. See the trade-off note below. |
| Loopback Host check | Every `/api/*` request is rejected if the `Host` header isn't `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`. Defends against DNS-rebinding attacks where an attacker site that resolves to `127.0.0.1` tries to reach the dashboard. |
| Reverse-proxy posture | `isLocalhost()` (`src/lib/auth.ts`) refuses to treat a request as loopback when it carries `X-Forwarded-*`, `X-Real-IP`, or `Forwarded` headers. Without this, a same-host reverse proxy (nginx, Caddy, cloudflared) would let external requests inherit the `requireAuth:false` / wizard `setupComplete:false` exemptions intended for direct loopback. `STATION_TRUST_PROXY=1` opts back in for trusted single-tenant proxy setups. |
| Shell injection | Every credential-handling and user-input path uses `execa` or `execFile` with fixed argv arrays — no `/bin/sh -c` string concatenation anywhere in the codebase. The `tools.ts` install runner is the canonical pattern. |
| Keychain timeout | All OS-keychain reads/writes wrapped in a 5 s timeout. Fresh Linux installs with a locked GNOME keyring would otherwise block indefinitely on DBus. |
| Path traversal | `/api/projects/:id/purge` refuses to `rm -rf` paths outside `$HOME` after `realpath` resolution (symlink escapes cannot slip through) and refuses `$HOME` itself. |

### What's NOT in the threat model

- **Public-network relay exposure.** The in-process relay listens on
  loopback. If you want a publicly-reachable Nostr relay, use a
  production relay like `nostr-rs-relay` or `strfry` — `nostr-station`
  is for a single user on their own machine.
- **Cross-tenant isolation.** Single user, single dashboard, no
  multi-tenant story.
- **Adversarial filesystem access.** Anything with read access to
  `~/.nostr-station/` can read your stored AI keys (encrypted-file
  fallback only — macOS Keychain + GNOME Keyring are gated by their
  respective backends), the persisted bunker client, and the relay's
  SQLite event store. We don't model that as in-scope; if it is for
  you, use full-disk encryption.

### Keychain backends

Priority order: macOS Keychain → GNOME Keyring → AES-256-GCM encrypted
file (`~/.config/nostr-station/secrets`, mode `0600`). Run
`nostr-station keychain list` to see which backend is active.

### Optional tools

`nostr-station add <tool>` runs install commands (`cargo install`,
`npm install -g`, or for `nsyte` an instruction to run the upstream
installer manually). The user sees the literal command before
confirming; nothing pipes a remote script into a shell behind their
back. The opt-in surface is intentionally small (3 tools today: ngit,
nak, nsyte) — adding more is a one-record diff in
`src/lib/tools.ts`.

### Bunker-persistence trade-off

`~/.nostr-station/bunker-client.json` lets the dashboard silently
re-auth against an Amber pairing the user has already approved. That
is **explicitly not a signing key** — the user's nsec remains on
their phone in Amber, and the server-side signing path still goes
through Amber for every event that's actually signed.

The residual risk: an attacker with filesystem read access can
impersonate the dashboard well enough to *trigger* NIP-46 sign
requests against the user's bunker. If Amber's autosign is on for
this app, those requests auto-approve on the phone without a prompt;
if it's off, the user sees a prompt. Worst case with FS access is
causing Amber prompts on the user's phone, not signing arbitrary
events.

Opt-out paths if this isn't your threat model:

- **Sign in via NIP-07 browser extension** (Alby, nos2x, Keys.band)
  instead of Amber — no bunker client persisted.
- **Delete `~/.nostr-station/bunker-client.json`** after sign-in. The
  current session token is independent and remains valid; next
  sign-in falls back to the QR flow.
- **Turn off autosign in Amber** for this app. Sign requests still
  arrive on the phone, but each one requires an explicit tap.

A first-class toggle is tracked as a follow-up.

### Local network attacks

Any browser tab on the user's machine can issue
`fetch('http://127.0.0.1:<N>')` and time the response to enumerate which
local ports answer. This is a platform-level affordance that no application
running on `127.0.0.1` can fully prevent — we document the posture rather
than claim a fix.

**What's discoverable from a hostile tab:**
- That nostr-station is running (dashboard on `127.0.0.1:3000`,
  in-process relay on `127.0.0.1:7777`, in-process Blossom on
  `127.0.0.1:8081` — all by default).
- That arbitrary other services on the user's machine are listening.

**What's NOT exfiltratable from those ports:**
- **Dashboard reads.** Every `/api/*` request goes through the loopback
  Host gate (`src/lib/web-server.ts:636`) and the CSRF Origin/Referer
  gate on mutations (`src/lib/web-server.ts:649`). A cross-origin tab
  cannot read the JSON response body of a session-authed endpoint
  (browsers enforce same-origin reads regardless), and cannot mutate
  state without forging a same-origin Referer (impossible from a
  cross-origin tab).
- **Relay WebSockets.** The in-process relay refuses any WS upgrade
  whose `Origin` header isn't a loopback origin
  (`src/relay/index.ts:152–155`). A hostile tab cannot open a relay
  subscription and read events.
- **Image / WS proxies.** Both reject private and loopback targets
  via `isPrivateOrLoopbackHost` (`src/lib/nsite-resolver.ts:881`,
  mirrored in `src/lib/img-proxy.ts:68`), so an attacker cannot pivot
  through our own server to scan localhost.

**Mitigation tracking:** the W3C *Private Network Access* spec
(<https://wicg.github.io/private-network-access/>) is the upstream fix
for the discoverability problem. Once stable in Chrome and Firefox we
will add the `Access-Control-Allow-Private-Network` response header and
respond to PNA preflights so cross-origin requests from public-network
pages are blocked before they touch our request handlers. Until then,
the same-origin and Origin-gate defenses above are the load-bearing
controls.
