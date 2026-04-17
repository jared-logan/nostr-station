# Changelog

All notable changes to nostr-station are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.0.5] — 2026-04-17
### Changed
- **CLI command renames** — clearer, less collision-prone names across the top-level commands. Old names remain as deprecated aliases for one release cycle and print a one-line stderr warning when used.
  - `push` → `publish` (avoids the "does it also pull?" ambiguity of `sync`; signals that the command orchestrates git + ngit + any configured signer, not just `git push`)
  - `setup-editor` → `editor`
  - `logs` → `relay logs` (folded under the `relay` subcommand group — `--service relay|watchdog|all` still works)

### Fixed
- **`/api/status` event-loop hang on fresh Linux** — `gatherStatus()`'s six sync `execSync` calls had no timeout, and `nvpn status --json` blocks on the nvpn daemon IPC socket when the service hasn't fully come up on first boot. A single wedged probe stalled the Node event loop for every in-flight `/api/*` request (observed: curl getting 0 bytes in 10s on Mint). `cmd()` now runs `execSync` with a 2s ceiling + `SIGKILL`; `nc -z` takes `-w 1` and a 1.5s cap; `nvpn status --json` is tightened to 1s.
- **Doctor conflated "nvpn daemon running" with "mesh connected"** — the check ran `nvpn status --json | grep -q connected`, which requires the mesh tunnel to be up, so a freshly-started daemon with no peers was flagged as a failure. Replaced with a platform-aware daemon probe (`systemctl is-active --quiet nvpn` on Linux, `launchctl list | grep nostr-vpn` on macOS). The fix suggestion changed from `sudo nvpn service install` (correct only when the unit is missing) to `sudo systemctl start nvpn` / `sudo launchctl kickstart` (idempotent; fails loudly if the unit is actually absent).
- **Web wizard `POST /api/setup/relay/install` hang on locked GNOME keyring** — `ensureWatchdogKeypair()` shelled out to `secret-tool lookup` with no timeout; on fresh Linux Mint installs where gnome-keyring-daemon isn't up yet or the login keyring is locked, the DBus call blocks indefinitely, which stalled the whole wizard before any systemd unit file was written. Keychain retrieve/store are now bounded by a 5s `withTimeout()` wrapper, and `bootstrapRelayServices()` emits timestamped per-step START/OK/ERR lines to stderr with elapsed ms so the blocking step is identifiable from server logs.
- **`nostr-station uninstall` now clears stored secrets** — previously left watchdog-nsec, legacy `ai-api-key`, and all per-provider `ai:<id>` slots in the system keychain after uninstall. Linux: `secret-tool clear service nostr-station` + `rm -f ~/.config/nostr-station/secrets` (encrypted-file fallback). macOS: `security delete-generic-password -s nostr-station` in a loop (capped at 64 iterations) since the command has no wildcard. `WHAT_GETS_REMOVED` preamble on the confirm screen updated accordingly.
- **Server starts before keychain + browser calls** — prior startup order could block opening the dashboard on a slow keychain prompt (macOS Aqua). Listener now binds first; slow I/O runs after.
- **`onboard --demo` runs without a TTY** — CI and headless demo paths no longer crash Ink with "Raw mode is not supported".
- **Onboard seeds `identity.json`** so the dashboard, ngit Service Health dot, and `Projects → ngit init` relay pre-fill all work on first run. If a prior file exists, missing fields are merged in without clobbering user customizations.
- **`git push` preflight** in the dashboard streaming exec modal — if the project has no `origin` remote, the modal surfaces `No git remote named 'origin' — add one in project Settings.` instead of a cryptic git error.
- **`npub`/hex helpers** in the web server now invoke `nak` via `execFileSync` with fixed argv arrays (no shell, no template literals). Not a live vuln — inputs are regex-validated — but sets the standard for argv hygiene pre-publish.

### Added
- **First-run web setup wizard** — `nostr-station` with no arguments opens a browser-based wizard at `/setup` that walks users through identity, relay + watchdog install, AI provider configuration, ngit signer setup (with embedded Amber terminal for the `nostrconnect://` flow), and seals the bootstrap by issuing a session and setting `setupComplete: true` in `identity.json`. Same end-state as the TUI onboard, but no terminal polish required — fresh-install users stay in the browser from first command to configured dashboard. `localhostExempt()` treats unconfigured + in-flight stations as exempt so the wizard can reach otherwise-gated endpoints before any session exists.
- **Web terminal panel** — xterm.js + node-pty terminal embedded in the dashboard with multi-tab support, 256-color rendering, and bracketed-paste disabled (fixes stray `[200~…[201~` sequences on Mint). Capability probe at `/api/terminal/capability` tells the client whether node-pty loaded successfully, with a degraded-mode hint when build tools are missing. Backed by our own `node-pty-prebuilts` release pipeline (linux-x64, darwin-arm64) since upstream ships no prebuilts and a plain `npm install node-pty` fails hard without python3 + build tools.
- **Dashboard actions routed through the terminal panel** — long-running operations render live in a terminal tab instead of a modal that can't be copied from: Status "run doctor", Config "Update components", Relay "seed events" and "logs" (replacing the legacy streaming panel), Projects "Open in Claude Code", Projects "Publish", ngit push, and nsite deploy. Sidebar gets a dedicated Terminal nav item. Session token accepted via `?token=` query param so WebSocket upgrades (which can't set Authorization headers from browsers) stay authenticated.
- **AI multi-provider system** — replaces the single-provider `~/.claude_env` + `ai-api-key` keychain slot with a first-class registry (Claude Code, OpenCode, Anthropic, OpenAI, OpenRouter, OpenCode Zen, Groq, Mistral, Gemini, Routstr, PayPerQ, Ollama, LM Studio, Maple) persisted in `~/.nostr-station/ai-config.json`. Per-provider keychain slots (`ai:<provider-id>`), separate `defaults.terminal` (for Projects "Open in AI") and `defaults.chat` (for the Chat pane), optional model and baseUrl overrides per provider, and a one-shot migration from the legacy layout. Config panel UI + Chat pane both render from the same `/api/ai/providers` endpoint. Dynamic model discovery via a "Fetch models" button that hits `/v1/models` on the configured provider. Legacy `~/.claude_env` is kept alongside the new config so Claude Code's shell-env path keeps working.
- **`nostr-station ai` CLI subcommands** — `list`, `add`, `remove`, `set-default`, `set-key`, `set-model`, `set-base-url` for managing `ai-config.json` without the browser.
- **Nsite owner-site discovery** — Projects panel gains a "Sites" section that queries kind-35128 events for the station owner's npub, surfaces title/description/URL, and renders a deploy affordance; integrates with the terminal panel for `nsyte upload` streams.
- **nostr-vpn (`nvpn`) install integration** — `nostr-station install` (and the web wizard) now installs `nvpn` from upstream prebuilts into `~/.cargo/bin`, runs `nvpn init --yes`, and `sudo nvpn service install` to land the system service. Granular per-step error surfaces (`~/logs/nvpn-install.log`) so failures show which phase broke, not just "install failed". Not hard-required — step is best-effort; doctor surfaces mesh state separately.
- **Web dashboard control center** — `nostr-station chat` now serves a full dashboard (not just chat): identity drawer with owner sign-in (NIP-07 / Amber QR / bunker URI), Status panel with live Service Health sidebar, Logs panel, Relay control panel, Config panel, Projects panel, and a streaming exec modal for long-running commands
- **Owner auth (NIP-98)** — every `/api/*` endpoint requires a session token issued only to the npub in `identity.json`. Server signs a 32-byte challenge (60 s TTL, single-use), verifies kind-27235 response, issues 8-hour session. `sessionStorage`-scoped tokens, never on disk. Localhost opt-out via `"requireAuth": false` with persistent dashboard banner
- **Projects panel** — register local project paths, detect Git/ngit/claude/stacks capabilities, run `ngit init` against a pre-filled relay, discover and clone Nostr-native repos
- **ngit repo discovery + clone** — `Scan ngit` queries kind-30617 announcement events for the station owner's npub, surfaces name/description/clone URLs, builds server-resolved `~/projects/<name>` paths, clones via `git clone nostr://<npub>/<d-tag>` with strict argv construction (no shell)
- **ngit account signer UI** — Config panel shows signer login state derived from `git config --global nostr.bunker-uri`, supports `ngit account login -i` (streams `nostrconnect://` for Amber scan) and `ngit account logout`, with masked URI display
- **NGIT config section** — default-relay input with `wss://` validation and inline save confirmation; `ngitRelay` field added to `identity.json`
- **Service Health sidebar** — interactive status dots (green/yellow/red) jump to matching Status cards with pulse highlight; tooltips expose state-specific resolution hints
- **`src/lib/version.ts`** — single source of truth for the version string; `cli --version` and the onboard Banner both derive from `package.json` so they never drift apart again
- **Linux E2E coverage for node-pty + terminal capability** — CI workflow verifies the prebuilt drops into place and `/api/terminal/capability` reports available on ubuntu-22.04 and ubuntu-24.04.

## [0.0.4] — 2026-04-15
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
