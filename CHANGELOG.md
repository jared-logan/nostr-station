# Changelog

All notable changes to nostr-station are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.0.3] — in progress
### Fixed
- TTY detection in install.sh — no longer crashes when piped via `curl | bash`
- SSH session detection — warns users to use tmux before long Rust compile
- nvm version — now fetches latest release dynamically with fallback to known-good version
- llm-wiki install prompt — now conditional on Anthropic + Claude Code selection
- Banner rendering — falls back to compact text banner on narrow terminals (< 100 cols), fixing duplication on Linux x86_64 SSH terminals
- Select component — suppressed ink-select-input's built-in indicator to fix double-arrow (`▸ ▸`) on Linux terminals
- Config phase editor description — restructured to two lines, fits 80-column terminals

### Added
- `nostr-station seed` — populates local relay with dummy events for dev/UI testing
- `nostr-station onboard --demo` — throwaway keypair, skips npub/bunker prompts, safe for CI and demos
- Version pinning for Rust components — `nostr-rs-relay`, `ngit`, `nak` now install at pinned versions; update wizard compares against pinned versions
- NIP coverage map in generated `NOSTR_STATION.md` — lists supported/unsupported NIPs for the local relay
- `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`
- GitHub issue templates (bug report, feature request)
- `NOSTR_STATION.md` repo root — contributor context file for AI coding tools
- SHA256 release checklist for npm publish verification

### Changed
- Stacks description — removed inaccurate "Dork AI agent" references; updated to "stacks agent"

## [0.0.2] — 2026-04-09
### Added
- Claude Code conditional install — only installed when using Anthropic provider or Claude Code as editor
- GitHub CLI option alongside ngit — choose ngit only / GitHub CLI only / both during onboard
- nsite publishing via nsyte with Amber bunker signing
- OS keychain integration — AI provider API keys stored in macOS Keychain / GNOME Keyring / AES-256-GCM encrypted file; no secrets in plaintext on disk
- Relay whitelist management — `relay whitelist --add <npub>`, `relay whitelist --remove <npub>` with confirmation on remove
- `push` command — push to all configured remotes (git + ngit) in one command
- `keychain` command — `list / get / set / delete / rotate / migrate`
- `relay config` command — `--auth on|off`, `--dm-auth on|off` with auto-restart
- Shell completion — `completion --shell zsh|bash --install`

## [0.0.1] — 2026-04-08
### Added
- Initial release
- Five-phase Ink TUI onboard wizard (Detect, Config, Install, Services, Verify)
- nostr-rs-relay local relay with NIP-42 auth enabled by default
- ngit with Amber NIP-46 signing
- nak event tool
- nostr-vpn mesh VPN
- 9 AI provider options (Anthropic, OpenRouter, OpenCode Zen, Routstr, PayPerQ, Ollama, LM Studio, Maple Proxy, Custom)
- Watchdog script with Nostr DM alerts on relay downtime
- `NOSTR_STATION.md` context file with editor symlink
- macOS (aarch64 + x86_64) and Linux (apt/dnf/pacman, systemd) support
- Commands: onboard, status, doctor, relay, logs, tui, update, setup-editor, completion, uninstall
