# Security Policy

## Reporting a Vulnerability

nostr-station handles key-adjacent infrastructure (local relay, watchdog nsec, dashboard auth tokens, AI provider API keys, persisted bunker clients). If you discover a security vulnerability, please **do not open a public GitHub issue**.

Instead, open a private security advisory:
**https://github.com/jared-logan/nostr-station/security/advisories/new**

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix if you have one

We will respond within 72 hours and work with you on a fix before public disclosure.

## Security model

| Surface | How it is handled |
|---------|-------------------|
| User's nsec | **Never on this machine.** All user-owned signing goes through Amber NIP-46 (`ngit push`, `nsite publish`, dashboard sign-in). |
| AI provider API keys | Stored per-provider in the OS keychain under account name `ai:<provider-id>` (service `nostr-station`). `~/.claude_env` is a loader script for Claude Code's environment-variable path, not a secret store. |
| Watchdog nsec | Stored in the OS keychain (`watchdog-nsec`). The watchdog script probes `security` / `secret-tool` / the CLI to retrieve it at runtime — never written to the script file. |
| Seed nsec | Stored in the OS keychain (`seed-nsec`) so `nostr-station seed` reuses a stable identity and doesn't grow the relay whitelist by one npub per run. |
| Relay | Private by default — NIP-42 auth enabled, whitelist-only, not listed on relay directories. The station's main npub, watchdog npub, and seed npub are auto-whitelisted; everything else is an explicit add. |
| GitHub tokens | Managed by `gh` CLI (browser OAuth) — stored in the system keychain by `gh`, never printed or logged by nostr-station. |
| Dashboard sign-in | NIP-98 challenge / response: server signs a 32-byte challenge (60 s TTL, single-use), the user's remote signer returns a kind-27235 event, server issues a 32-byte session token with an 8 h TTL (overridable via `NOSTR_STATION_SESSION_TTL`). Sessions are in-memory — a server restart invalidates all of them. |
| Session token storage | Client stores the token in `localStorage` so sessions survive tab close and browser restart (server-side TTL remains authoritative). Cleared on explicit sign-out from the identity drawer. |
| Persisted bunker client | After a successful NIP-46 sign-in, the ephemeral client secret + bunker pointer is stashed at `~/.nostr-station/bunker-client.json` (mode `0600`, scoped by owner npub) for silent re-auth on subsequent sign-ins. **This is not a signing key** — Amber's nsec never leaves the phone. See the trade-off note below. |
| Shell injection | Every credential-handling and user-input path uses `execa` or `execFileSync` with fixed argv arrays — no `/bin/sh -c` string concatenation anywhere in the codebase. `npub`/`hex` helpers in the web server specifically invoke `nak` via `execFileSync` with regex-validated inputs. |
| Keychain timeout | All OS-keychain reads/writes are wrapped in a 5 s timeout. Fresh Linux installs with a locked GNOME keyring would otherwise block indefinitely on DBus. |
| Path traversal | `/api/projects/:id/purge` refuses to `rm -rf` paths outside `$HOME` after `realpath` resolution (so symlink escapes cannot slip through) and refuses `$HOME` itself. |

### Keychain backends

Priority order: macOS Keychain → GNOME Keyring → AES-256-GCM encrypted file (`~/.config/nostr-station/secrets`, mode `0600`). Run `nostr-station keychain list` to see which backend is active. `nostr-station uninstall` clears every `nostr-station`-scoped slot across all backends (Linux: `secret-tool clear service nostr-station` + rm of the encrypted-file fallback; macOS: looped `security delete-generic-password -s nostr-station`, capped at 64 iterations since the command has no wildcard).

### Bunker-persistence trade-off

`~/.nostr-station/bunker-client.json` lets the dashboard silently re-auth against an Amber pairing the user has already approved. That is **explicitly not a signing key** — the user's nsec remains on their phone in Amber, and the server-side signing path still goes through Amber for every event that is actually signed. The residual risk: an attacker with filesystem read access can impersonate the dashboard well enough to *trigger* NIP-46 sign requests against the user's bunker. If Amber's autosign is on for this app, those requests auto-approve on the phone without a prompt; if it's off, the user sees a prompt. Worst case with FS access is therefore causing Amber prompts on the user's phone, not signing arbitrary events.

Opt-out paths if this is not your threat model:

- **Sign in via NIP-07 browser extension** (Alby, nos2x, Keys.band) instead of Amber — no bunker client is persisted.
- **Delete `~/.nostr-station/bunker-client.json`** after each sign-in. The current session remains valid (the session token is independent); the next sign-in falls back to the QR flow.
- **Turn off autosign in Amber** for this app. Sign requests still arrive on the phone, but each one now requires an explicit tap.

A first-class toggle is tracked as a follow-up.
