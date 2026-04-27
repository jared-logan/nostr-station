# nostr-station

[![npm version](https://badge.fury.io/js/nostr-station.svg)](https://www.npmjs.com/package/nostr-station)
[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

**One-command Nostr dev environment.**

Sets up a local relay, mesh VPN, Nostr-native git with Amber signing, and the AI coding tools of your choice — on macOS or Linux. A browser-based wizard walks you through first-run configuration, and the same URL becomes a full web control center with chat, an embedded terminal, a projects panel, service health, and live relay state.

```bash
curl -fsSL https://raw.githubusercontent.com/jared-logan/nostr-station/main/install.sh | bash
```

After install, run `nostr-station` with no arguments — a browser opens at `http://localhost:3000/setup` for first-run configuration, or drops you at the dashboard if the station is already configured. Prefer a terminal-only flow? `nostr-station onboard` still launches the Ink TUI wizard and reaches the same end-state.

### Contributors / pre-release testing

To run from source against an unpublished commit:

```bash
git clone https://github.com/jared-logan/nostr-station
cd nostr-station
npm install
npm run build
npm link            # exposes `nostr-station` on your PATH from this checkout
```

> ⚠ **`nostr-station uninstall` on a source build removes the global symlink.** It calls `npm uninstall -g nostr-station`, which also unlinks the `npm link` you just created — `nostr-station` will read as "not found" until you re-run `npm link` from the project root.

> v0.0.5 — macOS (Apple Silicon + Intel) and Linux (apt / dnf / pacman).

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

Two paths to the same configured station — pick whichever matches how you like to work.

### Web setup wizard (default — run `nostr-station` with no arguments)

Opens `http://localhost:3000/setup` in your browser and walks through:

1. **Identity** — main npub and optional Amber bunker URL
2. **Relay + watchdog** — installs `nostr-rs-relay`, registers it as a system service (launchd on macOS, systemd on Linux), seeds the whitelist, generates the watchdog keypair in the OS keychain
3. **AI providers** — pick any combination of terminal-native tools (Claude Code, OpenCode) and API providers (Anthropic, OpenRouter, Ollama, Maple, …); keys land in per-provider keychain slots (`ai:<id>`)
4. **ngit signer** — scan a `nostrconnect://` QR with Amber from an embedded terminal pane, or paste a `bunker://` URI
5. **Seal** — mint a session token, flip `setupComplete: true` in `identity.json`, hand you off to the dashboard

Fresh-install users stay in the browser from first command to configured dashboard. `localhostExempt()` treats unconfigured in-flight stations as exempt so the wizard can reach otherwise-gated endpoints before any session exists.

### Terminal wizard (`nostr-station onboard`)

Same end-state, delivered in an Ink TUI — useful over SSH, for CI (`onboard --demo`), or when you want copy-pastable logs. Runs five phases: Detect → Config → Install → Services → Verify. On Linux, system packages are installed pre-Ink with a native sudo prompt to avoid an Ink-raw-mode / PAM TTY interaction that hangs `apt`; the wizard mounts afterwards.

After either path, a `NOSTR_STATION.md` context file is written to `~/projects/` and symlinked to whatever filename your AI coding tool reads (`CLAUDE.md`, `.cursorrules`, `.windsurfrules`, etc.). Switch tools any time with `nostr-station editor`.

---

## AI providers

nostr-station ships a first-class multi-provider registry: two surfaces, 14 providers, per-provider keychain slots, and separate defaults for the terminal panel vs. the Chat pane. Configure through the dashboard's **Config** panel or the `nostr-station ai` CLI.

**Terminal-native** — spawned as PTY tabs in the dashboard's terminal panel, scoped to the active project's directory. Each tool owns its own auth (logs in via its own CLI), so nostr-station doesn't store a key.

| Provider | Binary |
|----------|--------|
| Claude Code | `claude` |
| OpenCode | `opencode` |

**API providers** — proxied via `/api/ai/chat` from the Chat pane, or hit directly with the configured key. Each has an optional `baseUrl` / default model override and a "Fetch models" button in Config for dynamic model discovery.

| Provider | Wire format | Notes |
|----------|-------------|-------|
| **Anthropic** | Anthropic-native (`/v1/messages` + `x-api-key`) | Standard API key — direct access |
| **OpenAI** | OpenAI-compat | GPT-4o and the standard OpenAI family |
| **OpenRouter** | OpenAI-compat | 100+ models with one key |
| **OpenCode Zen** | OpenAI-compat | Curated models benchmarked for coding agents |
| **Groq** | OpenAI-compat | Llama + Mixtral, low latency |
| **Mistral** | OpenAI-compat | `mistral-large-latest` |
| **Google Gemini** | OpenAI-compat endpoint | `gemini-2.0-flash` |
| **Routstr ⚡** | OpenAI-compat | Pay-per-use via Lightning / Cashu — no subscription |
| **PayPerQ ⚡** | OpenAI-compat | Pay-per-query at ppq.ai |
| **Ollama** | OpenAI-compat, local | No key required — auto-detected |
| **LM Studio** | OpenAI-compat, local | No key required — auto-detected |
| **Maple** | OpenAI-compat, local | TEE-encrypted inference, end-to-end private |

You can pair different providers across surfaces — e.g. Claude Code as the default for "Open in AI" on project cards, Ollama as the default for the Chat pane — via `nostr-station ai default terminal <provider>` and `ai default chat <provider>`.

### Storage

- Per-provider API keys: OS keychain under account name `ai:<provider-id>` (service `nostr-station`)
- Configured providers + defaults + overrides: `~/.nostr-station/ai-config.json`
- Legacy `~/.claude_env` is kept alongside the new config so Claude Code's shell-env path keeps working; a one-shot migration runs on first boot if you upgraded from a single-provider install.

Keychain backends in priority order: macOS Keychain → GNOME Keyring → AES-256-GCM encrypted file (`~/.config/nostr-station/secrets`, mode 0600). Run `nostr-station keychain list` to see which backend is active.

---

## Commands

```
nostr-station                      Open the web dashboard (or /setup wizard on first run)
nostr-station onboard              Terminal setup wizard (Ink TUI alternative to /setup)
nostr-station onboard --demo       Throwaway keypair — CI / screenshots, no TTY needed
nostr-station doctor               Health checks + quick fixes
nostr-station doctor --fix         Auto-repair common issues
nostr-station doctor --plain       Non-Ink text output (for SSE / CI consumers)
nostr-station doctor --deep        Extra checks — slower, more thorough
nostr-station status               Relay, mesh VPN, and service status
nostr-station status --json        Machine-readable JSON output
nostr-station update               Update all components
nostr-station update --dry-run     Preview updates without applying
nostr-station update --wizard      Interactive update with version preview
nostr-station update --yes         Skip confirmation (for scripts / dashboard exec)
nostr-station relay start|stop|restart|status
nostr-station relay logs                       Tail relay log
nostr-station relay logs --follow              Follow log in real time (-f also works)
nostr-station relay logs --service watchdog|relay|all
nostr-station relay config                     Show relay settings
nostr-station relay config --auth on|off       Toggle NIP-42 auth
nostr-station relay config --dm-auth on|off    Toggle DM auth restriction
nostr-station relay whitelist                  List whitelisted npubs
nostr-station relay whitelist --add <npub>     Add an npub
nostr-station relay whitelist --remove <npub>  Remove an npub (confirmation required)
nostr-station publish              Publish to all configured remotes (git + ngit)
nostr-station publish --github     Publish to GitHub only
nostr-station publish --ngit       Publish to ngit only
nostr-station publish --yes        Skip confirmation (dashboard exec path)
nostr-station nsite init           Configure nsite for a project
nostr-station nsite publish        Publish to Nostr/Blossom via Amber
nostr-station nsite status         Compare local build vs published
nostr-station nsite open           Open site in browser
nostr-station nsite open --titan   Copy nsite:// URL for Titan browser
nostr-station ai                   List configured AI providers + defaults
nostr-station ai list              (same as `ai` with no subcommand)
nostr-station ai add <provider>    Enable a provider — prompts for API key on real API providers; no-op for terminal-native (claude-code, opencode) and local daemons (ollama, lm-studio, maple)
nostr-station ai remove <provider> [--yes]   Clear keychain slot + ai-config entry
nostr-station ai default terminal <provider> Default for "Open in AI" on project cards
nostr-station ai default chat <provider>     Default for the Chat pane
nostr-station keychain list        Show stored credentials and active backend
nostr-station keychain get <key>   Display a credential (confirmation required)
nostr-station keychain get <key> --raw  Print value to stdout (for scripts)
nostr-station keychain set <key>   Store a credential
nostr-station keychain delete <key>  Remove a credential (confirmation required)
nostr-station keychain rotate      Hot-swap ai-api-key with 60s rollback window
nostr-station keychain rotate --rollback  Restore previous value (within 60s)
nostr-station keychain migrate     Convert plaintext ~/.claude_env to keychain loader
nostr-station chat                 Web dashboard at localhost:3000 — setup, chat, terminal, projects, status, relay, logs, config
nostr-station chat --port <n>      Custom port for the dashboard
nostr-station tui                  Live terminal dashboard — events, logs, mesh status
nostr-station seed                 Seed relay with dummy events for dev/testing
nostr-station seed --events 100    Specify event count
nostr-station seed --full          Profiles + notes + follows + reactions
nostr-station editor               Relink NOSTR_STATION.md for a different AI tool
nostr-station completion --shell zsh|bash --install
nostr-station uninstall [--yes]    Clean removal (relay data is preserved; keychain slots cleared)
nostr-station version              Print version (also: --version, -v)
```

**macOS `ai add` note:** writing an API key to the macOS Keychain requires an Aqua-session terminal (iTerm / Terminal.app). Running `ai add` from inside the dashboard's embedded terminal will fail because the PTY's `setsid` drops the Aqua bootstrap — use iTerm for key writes, or add the key through the Config panel's UI form (which goes through the server's authenticated keychain write path).

**Deprecated aliases** (kept one release cycle, print a stderr warning when used): `push` → `publish`, `setup-editor` → `editor`, `logs` → `relay logs`.

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

## Dashboard

`nostr-station chat` (or just `nostr-station` once setup is sealed) starts a local web dashboard at `http://localhost:3000` — a full control center for the station in a single view. The dashboard is locked to the station owner: every `/api/*` endpoint (and the panels that use them) requires a valid session.

### Panels

| Panel | What it does |
|-------|-------------|
| **Chat** | AI chat streaming from your configured default-chat provider; injects `NOSTR_STATION.md` as system context. Assistant replies are tagged with a small monospaced chip showing the exact model id that answered (e.g. `claude-opus-4-6-20240229`) — server emits the model on stream open and refines it when the upstream API's first chunk carries a more fully-qualified id |
| **Terminal** | xterm.js + node-pty terminal with multi-tab support, 256-color rendering, and bracketed-paste disabled. Dashboard actions (Status "run doctor", Config "Update components", Relay "seed events" and "logs", Projects "Open in Claude Code" / "Publish", ngit push, nsite deploy) render live in terminal tabs instead of modal dialogs you can't copy from. Bare shells default to `~/projects` so `claude` picks up the `NOSTR_STATION.md` symlink and `ngit clone <naddr>` lands in a predictable directory. Capability probe at `/api/terminal/capability` surfaces a degraded-mode hint if `node-pty` failed to load — backed by the project's own `node-pty-prebuilts` release pipeline (linux-x64, darwin-arm64) since upstream ships no prebuilts |
| **Status** | Two groups: **Services** (Relay, nostr-vpn, watchdog) with green/yellow/red dots, and **Binaries** (ngit, nak, claude-code, relay-bin, Stacks) with ✓ / ✗ / ! glyphs. Each row is expandable — reveals a state-aware blurb, the exact remediation command, and a deep-link to the relevant panel. Claude Code plugins (read from `~/.claude/plugins/installed_plugins.json`) nest under the expanded Claude Code row with per-plugin `/install-plugin` copy buttons. Sidebar Service Health dots are interactive: click any dot to jump and auto-expand the corresponding row |
| **Logs** | Live tail of relay, watchdog, or nvpn logs with follow mode. Leading SSE status event surfaces installed / running / stale state so empty log tails don't look like broken panels — banner above the tail says e.g. "relay is not installed — run `nostr-station onboard`" or "installed but not running — run `nostr-station relay start`" |
| **Relay** | Start / stop / restart, NIP-42 auth toggle, DM-auth toggle, whitelist add/remove, wipe database. Whitelist entries carry role badges ("You · station" / "Watchdog" / "Seed") derived from live config + keychain state. Recent events list is collapsible (closed by default) so 50+ seed events don't push the stats cards off-screen |
| **Config** | Read-relay list, AI provider registry (add / remove / set per-surface defaults / fetch models), NGIT default relay (with `wss://` validation), **ngit account (signer)** — shows login state from `git config --global nostr.bunker-uri`, streams `ngit account login -i` into a terminal tab so you can scan the `nostrconnect://` URL with Amber — plus a **Stacks AI (Dork)** section that surfaces the configured provider ids (never keys) from `~/Library/Preferences/stacks/config.json` and a Configure button that opens `stacks configure` in a terminal tab |
| **Projects** | Three-source Add Project chooser: **New local project** (folder + README only, no `git init`), **Existing local project** (adoption), **Import repository** (standard git URLs, `nostr://`, and `naddr1` in one modal). Zero-capability local-only projects are first-class. Stacks/MKStack integration: scaffold a new Nostr React app via `stacks mkstack <slug>`, Open in Dork (`stacks agent`), Run dev server (`npm run dev -- --port 5173`), Deploy to NostrDeploy. Per-project signer identity (station-default vs project-specific npub + optional bunker URL). **Scan ngit** discovers kind-30617 repo announcements for your npub; **Clone this repo** resolves a server-owned `~/projects/<name>` path and clones via `git clone nostr://<npub>/<d-tag>` (strict argv, no shell). Danger zone exposes **Remove** (unregister only, files stay) and **Delete on disk** (`rm -rf` + unregister, confined to paths under `$HOME` after realpath resolution). Cards paint red when the recorded path no longer exists on disk |
| **Sites** | Kind-35128 nsite events for the station owner — title / description / URL, with a deploy affordance that streams `nsyte upload` output into a terminal tab |

### Owner authentication

Signing in proves you hold the npub configured in `~/.config/nostr-station/identity.json`. Three paths:

- **Browser extension (NIP-07)** — Alby, nos2x, Keys.band. One click if the extension is detected.
- **Amber QR (NIP-46 `nostrconnect://`)** — scan with Amber on your phone; the dashboard polls until Amber approves.
- **Bunker URL (NIP-46)** — paste a `bunker://` URI from nsecBunker, Keycast, or similar.

Server-side: a random 32-byte challenge (60 s TTL, single-use) is signed by your remote signer as a NIP-98 kind-27235 event. On verification the server issues a 32-byte session token, returned via `Authorization: Bearer <token>`. Sessions are 8 h (override with `NOSTR_STATION_SESSION_TTL=<hours>`), extended on each authenticated request, in-memory only — a server restart invalidates every session.

Token lives in `localStorage` so sessions survive tab close and browser restart (server-side TTL remains authoritative). On successful NIP-46 sign-in the ephemeral client secret + bunker pointer is stashed at `~/.nostr-station/bunker-client.json` (mode 0600, scoped by owner npub) so subsequent sign-ins can silently re-auth against the same Amber pairing — you get a push notification (or auto-sign if Amber's autosign is on) instead of the QR-rescan dance.

**Bunker persistence trade-off.** Your Amber nsec stays on your phone, so an attacker with filesystem access can't sign arbitrary events — but they _can_ trigger NIP-46 sign requests against the bunker you've already paired with. If Amber's autosign is on for this app, those requests auto-approve on your phone. To opt out: sign in via NIP-07 extension instead of bunker, or delete `~/.nostr-station/bunker-client.json` after each sign-in (the current session stays valid; the next sign-in falls back to QR).

For local-only setups you can opt out of auth entirely by adding `"requireAuth": false` to `identity.json` — auth is then skipped for requests from `127.0.0.1`/`::1` only, with a persistent banner on the dashboard. Default is always on.

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
nostr-station publish     # publish to all configured remotes at once
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
| `publish --github` | Uses gh OAuth token stored in system keychain by `gh`, never printed |
| `publish --ngit` | Signing request to Amber via relay — nsec never on machine |
| `nsite publish` | Signing request to Amber via bunker — nsec never on machine |
| `gh auth login` | Browser-based OAuth — token stored by `gh` in system keychain |
| AI provider API keys | Stored per-provider in OS keychain as `ai:<provider-id>`; `~/.claude_env` is a loader script for Claude Code's shell-env path, not a secret store |
| Watchdog nsec | Stored in OS keychain — never written to the watchdog script file |
| Seed nsec | Stored in OS keychain as `seed-nsec` so seed runs don't grow the whitelist by an npub per invocation |
| Dashboard sign-in | NIP-98 challenge signed by your remote signer (extension / Amber / bunker); session token in `localStorage` (survives browser restart, cleared on sign-out); 8 h server-side TTL |
| Persisted bunker client | Ephemeral NIP-46 client secret + bunker pointer at `~/.nostr-station/bunker-client.json` (mode 0600), scoped by owner npub, for silent re-auth across browser restarts — **not** a signing key (Amber's nsec never leaves your phone); see the Dashboard section for the trade-off |

`~/.claude_env` contains no secrets — it calls `nostr-station keychain get ai-api-key --raw` at shell load time to retrieve the key into memory. The multi-provider registry uses `ai:<provider-id>` slots, but the legacy `~/.claude_env` is kept alongside the new layout so Claude Code's environment-variable path continues to work.

Keychain backends in priority order: macOS Keychain → GNOME Keyring → AES-256-GCM encrypted file (`~/.config/nostr-station/secrets`, mode 0600). Run `nostr-station keychain list` to see which backend is active.

---

## Version control options

Choose during onboard — or mix and match:

| Option | What it does |
|--------|-------------|
| **ngit only** | Nostr-native repos, Amber-signed pushes, no GitHub required |
| **GitHub only** | Standard git + `gh` CLI — familiar workflow |
| **Both** | ngit for Nostr repos, gh for GitHub — `nostr-station publish` handles both |

---

## Requirements

- macOS 12+ or Linux (Debian/Ubuntu, Fedora, Arch)
- Node.js 22+ (installed automatically via nvm if missing)
- ~2 GB free disk space (Rust toolchain + compiled binaries)
- Internet connection for first install

Prebuilt relay binaries target `linux-x86_64` (glibc ≥ 2.31) and `darwin-arm64`. On Intel Macs and older Linux distros, the relay falls back to `cargo install` and compiles locally (~10–15 min on modest hardware).

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

A partial failure (e.g. one crate fails to build) exits with a non-zero code and prints which components succeeded — so `nostr-station update && nostr-station publish` short-circuits on a broken update.

---

## Uninstalling

```bash
nostr-station uninstall          # interactive — y/N confirmation
nostr-station uninstall --yes    # skip confirmation (for scripts)
```

Removes services, configs, logs, the npm package, and **clears every nostr-station-managed keychain slot** — `watchdog-nsec`, `seed-nsec`, the legacy `ai-api-key`, and all per-provider `ai:<id>` slots. Linux uses `secret-tool clear service nostr-station` + removal of the encrypted-file fallback at `~/.config/nostr-station/secrets`; macOS loops `security delete-generic-password -s nostr-station` (capped at 64 iterations — the command has no wildcard).

**Does not remove** your relay data (SQLite), ngit repos, nak, Claude Code, nostr-vpn, or Rust.

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
