# nostr-station

[![npm version](https://badge.fury.io/js/nostr-station.svg)](https://www.npmjs.com/package/nostr-station)
[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

A local Nostr dev environment in one Node process — relay, dashboard, AI chat,
and Amber-signed git in your browser. macOS or Linux.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/jared-logan/nostr-station/main/install.sh | bash
```

Installs Node 22+ if needed, installs the `nostr-station` npm package, and
launches it. Total time: ~10 seconds on a warm machine. No Docker, no Rust
toolchain, no system service files, no `sudo`.

Your browser opens at `http://localhost:3000/setup` for first-run pairing.

## First run

Three screens, two phone taps:

1. **Welcome** — get started.
2. **Pair Amber** — one full-screen QR. Scan in [Amber](https://github.com/greenart7c3/Amber)
   on your Android phone, tap approve. Your npub is captured via NIP-46;
   your nsec stays on your phone.
3. **Verify** — sign a test event via Amber (second tap), publish it to the
   local relay, read it back. Live three-row checklist.

Then you land on the dashboard. The local relay is running on
`ws://localhost:7777`, accepting any signed event.

## Day-to-day

```
nostr-station            Boot the dashboard + relay, open the browser
nostr-station start      Same as bare invocation
nostr-station stop       Stop via PID file (clean SIGTERM)
nostr-station status     Show service state (--json for machines)
nostr-station chat       Open the dashboard (alias for the launcher)
```

The launcher is foreground — Ctrl+C tears down the dashboard and the
relay together. State persists in `~/.nostr-station/`; subsequent runs
skip the wizard and drop you straight into the dashboard.

## Optional tools

Tools that aren't on the happy path live behind one explicit verb:

```
nostr-station list                    Show available tools + install state
nostr-station add <tool>              Install (interactive y/N confirm)
nostr-station add <tool> --yes        Install without prompting
```

Available today: `ngit` (Nostr-native git), `nak` (event/relay CLI),
`stacks` (Soapbox app scaffolder), `nsyte` (static-site publishing). The
wizard never asks about these — opt in when you need each one.

## Build loop

Inside the dashboard:

- **Chat (Nori)** — AI assistant scoped to your active project. Pick from
  Anthropic, OpenAI, OpenRouter, OpenCode Zen, Routstr, PayPerQ, Ollama,
  LM Studio, Maple, or any OpenAI-compatible endpoint. Per-provider keys
  in the OS keychain.
- **Projects** — scaffold from templates, clone GitHub or ngit, or adopt
  an existing local repo. Per-card git state, sync, snapshot.
- **Terminal** — embedded shell tabs anchored at your active project.
- **Relay** — live event feed, manual publish, NIP-11 metadata.
- **Status** — service health, version info.

## Publish & deploy

```
nostr-station publish               GitHub + ngit (whatever's configured)
nostr-station publish --github      GitHub only
nostr-station publish --ngit        ngit only — Amber signs each event
nostr-station nsite publish         Publish a static site to nsite/Blossom
```

Every ngit push is signed via Amber on your phone — the nsec never touches
the machine.

## AI providers

```
nostr-station ai list                          Configured providers + defaults
nostr-station ai add <provider>                Add a provider (prompts for key)
nostr-station ai remove <provider>             Clear keychain slot + config
nostr-station ai default chat <provider>       Default for the Chat pane
nostr-station ai default terminal <provider>   Default for "Open in AI"
```

Different providers per surface is fine — Claude Code in the terminal,
Ollama in the Chat pane, etc.

## Keychain

```
nostr-station keychain list           Stored credentials + active backend
nostr-station keychain set <key>      Store/update a credential
nostr-station keychain get <key>      Reveal (y/N confirm)
nostr-station keychain delete <key>   Remove (y/N confirm)
```

Backends in priority order: macOS Keychain → GNOME Keyring → AES-256-GCM
encrypted file at `~/.config/nostr-station/secrets` (mode 0600).

## Editor target

`NOSTR_STATION.md` is the canonical context file. `nostr-station editor`
symlinks it to whatever filename your AI coding tool reads:

| Tool        | Filename                            |
|-------------|-------------------------------------|
| Claude Code | `CLAUDE.md`                         |
| Cursor      | `.cursorrules`                      |
| Windsurf    | `.windsurfrules`                    |
| Copilot     | `.github/copilot-instructions.md`   |
| Aider       | `CONVENTIONS.md`                    |
| Codex       | `AGENTS.md`                         |
| Other       | `AGENTS.md` (generic)               |

Switch any time by re-running the command.

## Architecture

One Node process. The relay (NIP-01 + NIP-11, `better-sqlite3`-backed) and
the dashboard HTTP server live in the same process tree. Lifecycle is one
PID file at `~/.nostr-station/pid`. Data:

```
~/.nostr-station/
├── pid                       Dashboard PID (used by `nostr-station stop`)
├── data/relay.db             Local relay's SQLite event store
├── bunker-client.json        Saved NIP-46 pairing for silent re-auth
└── ai-config.json            Provider config + per-surface defaults

~/.config/nostr-station/
├── identity.json             npub, read relays, setupComplete
└── secrets                   Encrypted keychain (Linux fallback)

~/nostr-station/projects/    Default projects directory
```

Why pure Node: install is one curl command. No Docker, no signed-binary
distribution, no Rust toolchain, no Apple Developer account. The relay
is intentionally minimal — it's a single-user local dev relay, not a
production-grade deployment.

## Contributing / dev loop

```bash
git clone https://github.com/jared-logan/nostr-station
cd nostr-station
npm install
npm run dev          # tsx watch, dashboard at :3000, relay at :7777
```

Tests:

```bash
npm test             # node:test via tsx, ~3s
npx tsc --noEmit     # type-check
```

Clean-install testing in a fresh VM (recommended for any install-path
changes) — Multipass or OrbStack VMs both work:

```bash
# Multipass
multipass launch --name ns-test
multipass shell ns-test
# inside the VM:
curl -fsSL https://.../install.sh | bash
# back on host:
multipass delete ns-test --purge

# OrbStack VMs (Apple Silicon-friendly)
orb create ubuntu ns-test
orb shell ns-test
# … same install, then:
orb delete ns-test
```

See `CONTRIBUTING.md` for code style + commit conventions.

## Security

- Dashboard binds to `127.0.0.1` only.
- Loopback-Host check rejects DNS-rebinding attacks.
- nsec never on the machine — every signing operation routes through Amber via NIP-46.
- API keys stored via OS keychain; encrypted-file fallback when the OS
  keychain isn't reachable.
- The local relay accepts any signed event from any pubkey on loopback
  (no NIP-42 today). It's intentionally scoped to development; don't
  expose it to a public network.

See `SECURITY.md` for reporting issues + the full threat model.

## License

MIT — see `LICENSE`.
