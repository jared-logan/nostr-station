# Security Policy

## Reporting a Vulnerability

nostr-station handles key-adjacent infrastructure. If you discover a security vulnerability, please **do not open a public GitHub issue**.

Instead, open a private security advisory:
**https://github.com/jared-logan/nostr-station/security/advisories/new**

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix if you have one

We will respond within 72 hours and work with you on a fix before public disclosure.

## Security model

| What | How |
|------|-----|
| nsec | Never stored on this machine — all signing via Amber NIP-46 |
| AI provider API keys | Stored in OS keychain (v0.0.2+) — `~/.claude_env` is a loader script, not a secret store |
| Watchdog nsec | Stored in OS keychain — never written to the watchdog script file |
| Relay | Private by default — NIP-42 auth enabled, whitelist-only |
| GitHub tokens | Managed by `gh` CLI — never printed or logged by nostr-station |
| Shell injection | All credential-handling paths use `execa` with array args — no `/bin/sh -c` string concatenation |

Keychain backends in priority order: macOS Keychain → GNOME Keyring → AES-256-GCM encrypted file (`~/.config/nostr-station/secrets`, mode 0600).
