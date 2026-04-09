# nostr-station

**One-command Nostr dev environment.**

Sets up a local relay, mesh VPN, Nostr-native git with Amber signing, and your AI coding tool of choice — on macOS or Linux — in a single terminal session.

```bash
curl -fsSL https://raw.githubusercontent.com/jared-logan/nostr-station/main/install.sh | bash
```

> v0.0.1 — early release. Works on macOS (Apple Silicon + Intel) and Linux (apt / dnf / pacman).

---

## What it installs

| Component | What it is |
|-----------|-----------|
| [nostr-rs-relay](https://github.com/scsibug/nostr-rs-relay) | Local Nostr relay on `ws://localhost:8080`, NIP-42 auth enabled |
| [ngit](https://github.com/DanConwayDev/ngit-cli) | Nostr-native git — clone, push, and sign commits via Amber |
| [nak](https://github.com/fiatjaf/nak) | Nostr event Swiss army knife — publish, query, decode |
| [nostr-vpn](https://github.com/mmalmi/nostr-vpn) | Mesh VPN over Nostr — connect dev machines without port forwarding |
| [Claude Code](https://claude.ai/code) | AI coding agent, wired to your chosen AI provider |
| [Stacks](https://getstacks.dev) *(optional)* | Nostr app scaffolding with Dork AI agent |
| [Blossom](https://github.com/hzrd149/blossom-server) *(optional)* | Local media server for Nostr dev |

All Rust binaries compile from source. First install takes 10–15 minutes.

---

## How it works

The installer runs an interactive Ink TUI wizard with five phases:

1. **Detect** — reads your OS, arch, package manager, and what's already installed
2. **Config** — collects your npub, Amber bunker string, relay name, AI provider, and editor
3. **Install** — compiles and installs all components, streams live progress
4. **Services** — writes configs, registers relay and watchdog as system services, generates SSH key
5. **Verify** — checks every component is running and reachable

After setup, a `NOSTR_STATION.md` context file is written to `~/projects/` and symlinked to whatever filename your AI coding tool reads (e.g. `CLAUDE.md`, `.cursorrules`, `.windsurfrules`). Switch tools any time with `nostr-station setup-editor`.

---

## AI provider options

nostr-station configures Claude Code to route through any OpenAI-compatible endpoint. You are not locked in to Anthropic's API.

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
nostr-station tui                  Live dashboard — events, logs, mesh status
nostr-station setup-editor         Relink context file to a different AI tool
nostr-station completion --shell zsh|bash --install
nostr-station uninstall            Clean removal (relay data is preserved)
```

---

## Signing with Amber

nostr-station is designed for **nsec-free development**. Your private key stays on your phone in [Amber](https://github.com/greenart7c3/Amber); the dev machine never sees it.

```bash
# During onboard, paste your Amber bunker string when prompted
# bunker://...

# After setup, push a repo
ngit push   # Amber prompts on your phone → approve → done

# Or connect later
ngit login --bunker <bunker-string>
```

---

## Relay

The local relay runs on `ws://localhost:8080` with NIP-42 auth enabled. A watchdog script monitors it every 5 minutes and sends you a Nostr DM if it goes down.

```bash
# Test it
nak event -k 1 --sec <test-nsec> "hello" ws://localhost:8080
nak req -k 1 -l 5 ws://localhost:8080

# Manage
nostr-station relay restart
nostr-station logs --follow
```

Config: `~/.config/nostr-rs-relay/config.toml`  
Data: `~/Library/Application Support/nostr-rs-relay/` (macOS) or `~/.local/share/nostr-rs-relay/` (Linux)  
Logs: `~/logs/nostr-rs-relay.log`

---

## Requirements

- macOS 12+ or Linux (Debian/Ubuntu, Fedora, Arch)
- Node.js 22+ (installed automatically via nvm if missing)
- ~2 GB free disk space (Rust toolchain + compiled binaries)
- Internet connection for first install

---

## Updating

```bash
nostr-station update
```

Updates nostr-rs-relay, ngit, nak (via `cargo install --locked`), and Claude Code (via npm). Run `--wizard` to preview version changes before applying.

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

---

## License

MIT
