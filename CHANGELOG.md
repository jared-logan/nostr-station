# Changelog

All notable changes to nostr-station are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.0.3] — in progress
### Added
- `nostr-station chat` — local web chat UI at `localhost:3000`; reads AI provider from `~/.claude_env` + keychain, injects `NOSTR_STATION.md` as system context on every request, streams via SSE; supports Anthropic native + OpenAI-compatible endpoints (OpenRouter, Routstr, PayPerQ, OpenCode Zen, Maple, Ollama, LM Studio, custom)
- Post-onboard launch picker — choose `tui` / `chat` / exit at the end of the wizard, spawns the selected command
- `nostr-station seed` — populates local relay with dummy events for dev/UI testing (`--events <n>`, `--full`)
- `nostr-station onboard --demo` — throwaway keypair, skips npub/bunker prompts, safe for CI and demos
- Version pinning for Rust components — `nostr-rs-relay`, `ngit`, `nak` install at pinned versions; update wizard compares against pinned versions
- Prebuilt `nostr-rs-relay` download for `linux-x86_64` and `darwin-arm64`, with graceful fallback to `cargo install` on unsupported targets
- Release workflow (`release-relay-prebuilts.yml`) builds + publishes the relay prebuilts with SHA256SUMS
- Linux E2E workflow — runs full `onboard --demo` on `ubuntu-22.04` and `ubuntu-24.04`
- `nostr-station status --json` — machine-readable output, bypasses Ink for non-TTY callers
- NIP coverage map in generated `NOSTR_STATION.md` — lists supported/unsupported NIPs for the local relay
- `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`
- GitHub issue templates (bug report, feature request)
- `NOSTR_STATION.md` repo root — contributor context file for AI coding tools
- SHA256 release checklist for npm publish verification

### Fixed
- TTY safety across all commands — non-interactive callers no longer crash Ink with "Raw mode is not supported"
- TTY detection in `install.sh` — no longer crashes when piped via `curl | bash`
- SSH session detection — warns users to use tmux before long Rust compile
- Sudo pre-auth gated on TTY stdin — unblocks CI runners that inherit a non-interactive stdin
- Sudo environment propagation — `installSystemDeps` preserves PATH/HOME correctly across the `sudo` boundary
- Non-TTY recovery in the Install phase — prints a clean error instead of a React stack trace
- `update` routes `nak` through `installNak` (GitHub release download) instead of `cargo install` — `nak` is a Go binary, `cargo install` never worked
- `install` drops `--locked` from `cargo install` — unblocks modern `rustc` where upstream `Cargo.lock` diverges
- `install` adds `protobuf-compiler` to system deps — required by `nostr-rs-relay` build.rs
- `install` pulls `nak` from GitHub releases (Go binary), not `cargo install`
- nvm version — fetches latest release dynamically with fallback to known-good version
- llm-wiki install prompt — conditional on Anthropic + Claude Code selection
- Banner rendering — compact text banner on narrow terminals (< 100 cols), fixing duplication on Linux x86_64 SSH terminals
- Select component — suppressed ink-select-input's built-in indicator to fix double-arrow (`▸ ▸`) on Linux terminals
- Config phase editor description — restructured to two lines, fits 80-column terminals
- `doctor` — actionable fix hints rendered inline before suggesting `--fix`; exact-match fix lookup replaces fragile substring matches; platform-aware relay start command
- Error phases propagate non-zero exit codes — `doctor`, `update`, `relay`, `logs` now exit honestly so `&&` chains short-circuit on failure
- `--help` / `help` fully populated — every command + every flag listed
- Unknown command falls through to help instead of silent exit
- CI: pass `--repo` to `gh release` in relay-prebuilts publish job
- CI: don't treat the ngit status row as a presence check
- CI: cargo PATH persistence across e2e workflow steps
- Onboard: humanized Amber bunker errors (timeout → "open the app and approve"; connection refused → "make sure app is open"; invalid → "copy it again from Amber"; unauthorized → "tap Approve"; ngit missing → "run: nostr-station update")
- Onboard: prompt helper text for npub + bunker fields — tells users exactly where to get each value

### Changed
- README — fixed stale `update`/`install` claims, filled out `keychain` command reference, added Intel-Mac compile + glibc floor caveat
- Onboard Summary — now shows npub, notes which editor file is symlinked, surfaces the `source ~/.claude_env` step for non-Anthropic providers, and points to `nostr-station chat`
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
