# nostr-station

[![npm version](https://badge.fury.io/js/nostr-station.svg)](https://www.npmjs.com/package/nostr-station)
[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

**One-command Nostr dev environment.**

Sets up a local relay, mesh VPN, Nostr-native git with Amber signing, and your AI coding tool of choice — on macOS or Linux — in a single terminal session.

```bash
curl -fsSL https://raw.githubusercontent.com/jared-logan/nostr-station/main/install.sh | bash
```

> v0.0.3 — macOS (Apple Silicon + Intel) and Linux (apt / dnf / pacman).

---

## What it installs

| Component | What it is |
|-----------|-----------|
| [nostr-rs-relay](https://github.com/scsibug/nostr-rs-relay) | Local private relay on `ws://localhost:8080`, NIP-42 auth, whitelist-only |
| [ngit](https://github.com/DanConwayDev/ngit-cli) | Nostr-native git — clone, push, and sign commits via Amber |
| [nak](https://github.com/fiatjaf/nak) | Nostr event Swiss army knife — publish, query, decode |
| [nostr-vpn](https://github.com/mmalmi/nostr-vpn) | Mesh VPN over Nostr — connect dev machines without port forwarding |
| [Claude Code](https://claude.ai/code) | AI coding agent — conditional, only installed if your config needs it |
| [GitHub CLI](https://cli.github.com) *(optional)* | `gh` — standard GitHub workflows alongside ngit |
| [nsyte](https://nsyte.run) *(optional)* | Deploy static apps to Nostr/Blossom — Amber-signed, nsec-free |
| [Stacks](https://getstacks.dev) *(optional)* | Nostr app scaffolding — `stacks mkstack` + stacks agent |
| [Blossom](https://github.com/hzrd149/blossom-server) *(optional)* | Local media server for Nostr dev |

`nostr-rs-relay` is downloaded as a prebuilt binary when one is available for your OS/arch (falls back to `cargo install` on older platforms). `ngit` always compiles from source. `nak` is a prebuilt Go binary from GitHub Releases. First install on a platform without relay prebuilts takes 10–15 minutes; with prebuilts, ~2 minutes.

---

## How it works

The installer runs an interactive Ink TUI wizard with five phases:

1. **Detect** — reads your OS, arch, package manager, and what's already installed
2. **Config** — collects your npub, Amber bunker string, relay name, version control preference, AI provider, and editor
3. **Install** — compiles and installs all components, streams live progress
4. **Services** — writes configs, registers relay and watchdog as system services, seeds relay whitelist, stores credentials in OS keychain
5. **Verify** — checks every component is running and reachable

After setup, a `NOSTR_STATION.md` context file is written to `~/projects/` and symlinked to whatever filename your AI coding tool reads (`CLAUDE.md`, `.cursorrules`, `.windsurfrules`, etc.). Switch tools any time with `nostr-station setup-editor`.

---

## AI provider options

nostr-station configures your AI coding tool to route through any OpenAI-compatible endpoint.

| Provider | Description |
|----------|-------------|
| **Anthropic** | Standard API key — direct access |
| **OpenRouter** | Multi-model API — access 100+ models with one key |
| **OpenCode Zen** | Curated models benchmarked for coding agents |
| **Routstr ⚡** | Pay-per-use via Lightning / Cashu — no subscription |
| **PayPerQ ⚡** | Pay-per-query at ppq.ai |
| **Ollama** | Local models, no key required — auto-detected |
| **LM Studio** | Local models, no key required — auto-detected |
| **Maple Proxy** | TEE-encrypted inference, end-to-end private |
| **Custom** | Any OpenAI-compatible endpoint |

API keys are stored in the OS keychain (macOS Keychain, GNOME Keyring, or AES-256-GCM encrypted file on headless Linux). They are never written to disk in plaintext.

---

## Commands

```
nostr-station onboard              Interactive setup wizard (first run)
nostr-station doctor               Health checks + quick fixes
nostr-station doctor --fix         Auto-repair common issues
nostr-station status               Relay, mesh VPN, and service status
nostr-station status --json        Machine-readable JSON output
nostr-station update               Update all components
nostr-station update --dry-run     Preview updates without applying
nostr-station update --wizard      Interactive update with version preview
nostr-station logs                 Tail relay log
nostr-station logs --follow        Follow log in real time (-f also works)
nostr-station logs --service watchdog|relay|all
nostr-station relay start|stop|restart|status
nostr-station relay config                     Show relay settings
nostr-station relay config --auth on|off       Toggle NIP-42 auth
nostr-station relay config --dm-auth on|off    Toggle DM auth restriction
nostr-station relay whitelist                  List whitelisted npubs
nostr-station relay whitelist --add <npub>     Add an npub
nostr-station relay whitelist --remove <npub>  Remove an npub
nostr-station push                 Push to all configured remotes (git + ngit)
nostr-station push --github        Push to GitHub only
nostr-station push --ngit          Push to ngit only
nostr-station nsite init           Configure nsite for a project
nostr-station nsite publish        Publish to Nostr/Blossom via Amber
nostr-station nsite status         Compare local build vs published
nostr-station nsite open           Open site in browser
nostr-station nsite open --titan   Copy nsite:// URL for Titan browser
nostr-station keychain list        Show stored credentials and backend
nostr-station keychain get <key>   Display a credential (confirmation required)
nostr-station keychain get <key> --raw  Print value to stdout (for scripts)
nostr-station keychain set <key>   Store a credential
nostr-station keychain delete <key>  Remove a credential (confirmation required)
nostr-station keychain rotate      Hot-swap ai-api-key with 60s rollback window
nostr-station keychain rotate --rollback  Restore previous value (within 60s)
nostr-station keychain migrate     Convert plaintext ~/.claude_env to keychain loader
nostr-station tui                  Live dashboard — events, logs, mesh status
nostr-station seed                 Seed relay with dummy events for dev/testing
nostr-station seed --events 100    Specify event count
nostr-station seed --full          Profiles + notes + follows + reactions
nostr-station onboard --demo       Quick setup with throwaway keypair
nostr-station setup-editor         Relink context file to a different AI tool
nostr-station completion --shell zsh|bash --install
nostr-station uninstall            Clean removal (relay data is preserved)
```

---

## Signing with Amber

nostr-station is designed for **nsec-free development**. Your private key stays on your phone in [Amber](https://github.com/greenart7c3/Amber); the dev machine never sees it.

- `ngit push` — Amber prompts on your phone to approve each push
- `nsite publish` — Amber approves each publish event via bunker
- The watchdog keypair is auto-generated and stored in the OS keychain

```bash
# During onboard, paste your Amber bunker string when prompted
# bunker://...

# Or connect later
ngit login --bunker <bunker-string>
```

---

## Relay

The local relay is **private by default** — NIP-42 auth enabled, whitelist-only, not listed on relay directories. It is a personal dev relay, not a public relay.

Your main npub and watchdog npub are added to the whitelist automatically during setup. Add test keypairs as needed:

```bash
nostr-station relay whitelist --add <npub>
nostr-station relay whitelist

# Test it
nak event -k 1 --sec <test-nsec> "hello" ws://localhost:8080
nak req -k 1 --auth <nsec> ws://localhost:8080
```

Config: `~/.config/nostr-rs-relay/config.toml`  
Data: `~/Library/Application Support/nostr-rs-relay/` (macOS) or `~/.local/share/nostr-rs-relay/` (Linux)  
Logs: `~/logs/nostr-rs-relay.log`

---

## Publishing

### ngit — Nostr-native source repos

```bash
ngit clone <naddr>        # clone a repo from Nostr
ngit push                 # push + sign via Amber
```

### GitHub — standard repos (if version control = github or both)

```bash
gh repo clone <owner>/<repo>
gh pr create
nostr-station push        # push to all configured remotes at once
```

### nsite — static app publishing

Deploy built web apps to Nostr/Blossom. nsec never on machine — all signing via Amber bunker.

```bash
nostr-station nsite init        # one-time project setup
nostr-station nsite publish     # Amber approves, files uploaded
nostr-station nsite status      # compare local build vs live

# Access
https://<npub>.nsite.lol        # any browser, immediate
nsite://<npub>                  # Titan browser
```

For human-readable `nsite://<name>` addresses, see [Titan](https://github.com/btcjt/titan) — requires a Bitcoin OP_RETURN registration (external to nostr-station).

---

## Security model

| Operation | How credentials are handled |
|-----------|----------------------------|
| `push --github` | Uses gh OAuth token stored in system keychain by `gh`, never printed |
| `push --ngit` | Signing request to Amber via relay — nsec never on machine |
| `nsite publish` | Signing request to Amber via bunker — nsec never on machine |
| `gh auth login` | Browser-based OAuth — token stored by `gh` in system keychain |
| AI provider API key | Stored in OS keychain; `~/.claude_env` is a loader script, not a secret store |
| Watchdog nsec | Stored in OS keychain — never written to the watchdog script file |

`~/.claude_env` contains no secrets — it calls `nostr-station keychain get ai-api-key --raw` at shell load time to retrieve the key into memory.

Keychain backends in priority order: macOS Keychain → GNOME Keyring → AES-256-GCM encrypted file (`~/.config/nostr-station/secrets`, mode 0600). Run `nostr-station keychain list` to see which backend is active.

---

## Version control options

Choose during onboard — or mix and match:

| Option | What it does |
|--------|-------------|
| **ngit only** | Nostr-native repos, Amber-signed pushes, no GitHub required |
| **GitHub only** | Standard git + `gh` CLI — familiar workflow |
| **Both** | ngit for Nostr repos, gh for GitHub — `nostr-station push` handles both |

---

## Requirements

- macOS 12+ or Linux (Debian/Ubuntu, Fedora, Arch)
- Node.js 22+ (installed automatically via nvm if missing)
- ~2 GB free disk space (Rust toolchain + compiled binaries)
- Internet connection for first install

---

## Updating

```bash
nostr-station update                 # update everything to the pinned version
nostr-station update --dry-run       # preview what would change
nostr-station update --wizard        # interactive picker with current → latest diff
```

- `nostr-rs-relay` and `ngit` are updated via `cargo install` to the versions pinned in `src/lib/versions.ts`. The `--locked` flag is intentionally omitted — upstream `Cargo.lock` entries occasionally break on newer `rustc`, and pinning the top-level crate version is enough to keep builds reproducible.
- `nak` is pulled from the latest [fiatjaf/nak](https://github.com/fiatjaf/nak) GitHub release (Go binary, not a cargo install).
- `claude-code` is updated via `npm update -g @anthropic-ai/claude-code`.

A partial failure (e.g. one crate fails to build) exits with a non-zero code and prints which components succeeded — so `nostr-station update && nostr-station push` short-circuits on a broken update.

---

## Uninstalling

```bash
nostr-station uninstall
```

Removes services, configs, logs, and the npm package. **Does not remove** your relay data (SQLite), ngit repos, nak, Claude Code, nostr-vpn, or Rust.

---

## Platform support

| OS | Arch | Service manager | Package manager |
|----|------|----------------|-----------------|
| macOS | Apple Silicon (aarch64) | launchd | Homebrew |
| macOS | Intel (x86_64) | launchd | Homebrew |
| Linux | aarch64 | systemd | apt / dnf / pacman |
| Linux | x86_64 | systemd | apt / dnf / pacman |

**Not supported:**
Windows is not a supported platform. WSL2 on Windows may work but is not tested or officially supported. Contributions welcome.

---

## License

MIT
