# nostr-station — Contributor Context

This file is for contributors using Claude Code (or any AI coding tool) to work on **nostr-station itself**. It describes the project so an AI agent can contribute effectively without needing the full conversation history.

> This is the repo-root contributor file. It is separate from the `NOSTR_STATION.md` generated on the *user's* machine during install (which lives in `~/projects/`).

## What nostr-station is

A single npm package (`nostr-station`) that sets up a complete Nostr dev environment in one invocation: local private relay, mesh VPN (nostr-vpn), Nostr-native git (ngit + Amber signing), any combination of AI coding tools (terminal-native + API), and optional extras (nsyte, Stacks/MKStack, Blossom).

Two equivalent entry paths, both reaching the same configured end-state:

- **Web setup wizard** — `nostr-station` with no arguments boots the dashboard server and deep-links the browser to `/setup`. The default path; expected to be most users' first experience.
- **Ink TUI wizard** — `nostr-station onboard` runs a five-phase terminal wizard (Detect → Config → Install → Services → Verify). Equivalent end-state; preferred for SSH, CI, headless, or copy-pastable logs.

**npm:** `npm install -g nostr-station`
**GitHub:** github.com/jared-logan/nostr-station

## Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript strict mode, ES2022, ESM-only |
| Runtime | Node.js ≥ 22 |
| Terminal UI | React + [Ink](https://github.com/vadimdemedes/ink) for the onboard wizard, tui, and CLI commands |
| Web UI | Plain HTML + vanilla JS (no framework), xterm.js for the terminal panel, served by `src/lib/web-server.ts` |
| PTY | [node-pty](https://github.com/microsoft/node-pty) as an `optionalDependency`, with our own `node-pty-prebuilts` release pipeline (linux-x64, darwin-arm64) since upstream ships no prebuilts |
| Shell calls | `execa` + `execFileSync` with fixed argv arrays only — no `/bin/sh -c` string concatenation anywhere |
| Nostr | `nostr-tools` for key ops + NIP-19 + NIP-46 + NIP-98; `nak` CLI for event publish/query where it shortens code |
| Package | npm, published as `nostr-station` |
| Bootstrap | `install.sh` bash script — installs Node via nvm, then `npm install -g nostr-station` |

## File structure

```
src/
  cli.tsx                     Entry point — parses argv, dispatches to command components.
                              Bare invocation (process.argv.length === 2) routes to the
                              web __welcome__ path (Chat component with path: '/setup').
  commands/                   One React/Ink component per top-level command.
    Ai.tsx                    `ai list|add|remove|default <terminal|chat>` subcommands
    Chat.tsx                  Boots web-server.ts; serves dashboard + /setup wizard
    Completion.tsx            zsh/bash tab-completion install
    Doctor.tsx                Health checks + --fix auto-repair; --plain for SSE/CI
    Editor.tsx                Relink NOSTR_STATION.md symlink to different AI tool
    Keychain.tsx              list / get / set / delete / rotate / migrate
    Logs.tsx                  Log tailing (relay / watchdog / vpn / all)
    Nsite.tsx                 init / publish / deploy / status / open
    Publish.tsx               Fan out to git push + ngit push
    Relay.tsx                 start / stop / restart / status
    RelayConfig.tsx           relay config + relay whitelist subcommands
    Seed.tsx                  Seed relay with stable-identity dummy events
    Status.tsx                System status summary; gatherStatus() + formatStatusJson
    Tui.tsx                   Ink live dashboard (events, logs, mesh)
    Uninstall.tsx             Clean removal; clears all keychain slots
    Update.tsx                Non-interactive update
    UpdateWizard.tsx          Interactive update with version preview
  lib/
    ai-providers.ts           Static provider registry (14 providers, terminal-native + api)
    ai-config.ts              ~/.nostr-station/ai-config.json reader/writer + legacy migration
    ai-context.ts             Builds NOSTR_STATION.md as system prompt for the Chat pane
    auth.ts                   Session tokens, localhost opt-out, requireAuth parsing
    auth-bunker.ts            NIP-46 sign-in flow + silentBunkerSign() re-auth
    bunker-storage.ts         Persisted bunker client at ~/.nostr-station/bunker-client.json
    completion.ts             zsh + bash tab-completion script generators
    detect.ts                 Platform / OS / arch / pkg-mgr / installed-tool detection
    git.ts                    Git helpers — remote resolve, argv-clean clone
    identity.ts               ~/.config/nostr-station/identity.json read/write + seed
    install.ts                installCargoBin, installClaudeCode, installStacks, installNvpn
    keychain.ts               OS keychain abstraction (macOS Security / GNOME secret-tool /
                              AES-256-GCM file); 5 s timeout wrapper on all backend ops
    project-scaffold.ts       New Local Project + MKStack scaffold pipeline
    projects.ts               Registered-project CRUD + capability detection; /api/projects
    relay-config.ts           TOML read/write for nostr-rs-relay config; whitelist helpers;
                              argv-safe npubToHex via nip19.decode (no nak dep)
    services.ts               Config file templates, service-unit writers, NOSTR_STATION.md builder
    terminal.ts               node-pty session registry, PTY spawn helpers, capability probe
    tty.ts                    requireInteractive gate for TTY-only commands
    verify.ts                 Onboard Phase 5 checks + doctor probes
    version.ts                Re-exports package.json version — single source of truth
    versions.ts               Pinned upstream versions for Rust components
    web-server.ts             HTTP + WS server; /setup wizard; /api/* endpoints; SSE streaming
  onboard/
    index.tsx                 Wizard orchestrator — Detect → Config → Install → Services → Verify
    components/               Banner, LaunchPicker, palette, Prompt, Select, Step, Summary
    phases/
      Detect.tsx              Phase 1 — OS/arch/pkg-mgr/installed-tool detection
      Config.tsx              Phase 2 — collects user config interactively
      Install.tsx             Phase 3 — compiles + installs all components
      Services.tsx            Phase 4 — writes configs, registers services, seeds keychain
      Verify.tsx              Phase 5 — checks everything is running
  web/
    index.html                Dashboard shell — panels, sidebar, identity drawer
    app.js                    All panel logic (vanilla JS, no framework)
    app.css                   Dashboard styling
    terminal.js               xterm.js + WS client for the terminal panel
    nori.svg                  Logo
```

## Key design decisions

**nsec never on this machine.** All signing via Amber NIP-46 (`ngit push`, `nsite publish`). The watchdog keypair and the stable seed keypair are the only nsecs stored locally, and both live in the OS keychain — never written to disk in plaintext.

**Private relay by default.** NIP-42 auth enabled; whitelist-only; not listed on relay directories.

**AI provider agnostic — multi-provider registry.** Two surfaces:

- **Terminal-native** (Claude Code, OpenCode) — spawned as PTY tabs via `terminal.ts`; each tool owns its own auth.
- **API** (Anthropic, OpenAI, OpenRouter, OpenCode Zen, Groq, Mistral, Gemini, Routstr, PayPerQ, Ollama, LM Studio, Maple) — proxied via `/api/ai/chat` with keys in per-provider keychain slots `ai:<provider-id>`.

Separate defaults for `terminal` (the "Open in AI" project-card button) and `chat` (the Chat pane) — a user can pair e.g. Claude Code for coding with Ollama for chat. `ai-providers.ts` is the static registry; `ai-config.ts` reads `~/.nostr-station/ai-config.json` for which providers the user has configured and any overrides. **Do not add providers ad-hoc in consuming code** — register in `ai-providers.ts` and consumers pick them up for free.

**Stacks/MKStack is integrated.** The Projects panel scaffolds new Nostr React apps via `stacks mkstack <slug>` (see `project-scaffold.ts`), surfaces Open-in-Dork / Run-dev-server / Deploy buttons on stacks projects, and the Config panel exposes a "Stacks AI (Dork)" section that reads (sanitized — provider ids only, never keys) from `~/Library/Preferences/stacks/config.json`. `ensureStacksRelays()` widens Stacks's relay list on install and on every mkstack scaffold. (Historical note: earlier versions of this file said "do not add Dork references" — that constraint no longer applies.)

**Owner authentication for the dashboard.** NIP-98 challenge/response: every `/api/*` endpoint requires a session token issued only to the npub in `identity.json`. Server signs a 32-byte challenge (60 s TTL, single-use), verifies the kind-27235 response, issues an 8 h session token returned via `Authorization: Bearer <token>`. Tokens live in `localStorage` so sessions survive browser restart. `silentBunkerSign()` re-auths via a persisted bunker client at `~/.nostr-station/bunker-client.json` (mode 0600) so users don't face a QR rescan on every refresh. Localhost opt-out: `"requireAuth": false` in `identity.json` skips auth for `127.0.0.1` / `::1` with a persistent dashboard banner.

**Terminal panel as the exec surface.** Long-running dashboard actions (doctor, update, relay seed, relay logs, Open-in-Claude-Code, publish, ngit push, nsite deploy) render in live terminal tabs via `terminal.ts` + `/api/terminal/*` endpoints, not modal dialogs. Copy-pastable, inspectable, paste-a-trace-into-issue friendly.

**execa / execFileSync for all shell calls.** No string concatenation passed to `/bin/sh -c`. Every credential-touching or user-input path uses fixed argv arrays. The `npub`/`hex` helpers in `web-server.ts` specifically invoke `nak` via `execFileSync` with regex-validated inputs — not a live vuln either way, but the standard for the codebase.

**Nak on PATH is not assumed.** Where a hot path needs to decode npubs or hex (watchdog script, onboard Services phase, relay-config whitelist), the code prefers `nostr-tools` `nip19.decode` directly rather than shelling out to `nak`. `nak` is a convenience wrapper when it shortens code, never a hard dependency in critical paths — users frequently land in fresh shells where `~/.cargo/bin` isn't on PATH.

## How to run locally

```bash
npm install
npm run build

# Terminal wizard (Ink TUI)
node dist/cli.js onboard
node dist/cli.js onboard --demo          # throwaway keypair, no prompts (CI/screenshots)

# Web wizard / dashboard (default on bare invocation)
node dist/cli.js                          # → http://localhost:3000/setup or /
node dist/cli.js chat                     # same, explicit

# Individual commands
node dist/cli.js doctor
node dist/cli.js seed --full
node dist/cli.js ai list
node dist/cli.js status --json
```

Or without building (tsx watch):

```bash
npm run dev -- onboard
npm run dev                               # bare → web wizard/dashboard
```

Web assets (`src/web/*`) are copied into `dist/web/` by `scripts/copy-web.mjs` during build; `tsx` in dev serves them directly from `src/web/`.

## Current version

v0.0.6-0 (pre-release tag; 0.0.6 is in progress — see `[Unreleased]` at the top of `CHANGELOG.md`). The version string is sourced from `package.json` via `src/lib/version.ts`; `cli --version` and the onboard Banner both derive from there so they never drift.

## What must never be broken in contributions

1. **nsec never stored in plaintext on disk.** Watchdog nsec, seed nsec, and any future locally-stored nsec go through `src/lib/keychain.ts`. Amber signing for anything user-owned.
2. **All shell calls use argv arrays** (`execa` / `execFileSync`). No string concatenation into `/bin/sh -c`. Credential-touching paths especially.
3. **AI providers register in `ai-providers.ts`, nowhere else.** Consumers (Config panel, Chat pane, `ai` CLI, `/api/ai/providers`) enumerate the registry at runtime.
4. **Dashboard auth stays on by default.** The `requireAuth: false` opt-out is explicit + localhost-scoped + banner-visible for a reason. Don't add silent bypasses.
5. **Keychain abstraction covers all three backends** (macOS Security, GNOME secret-tool, AES-256-GCM file). All backend ops are wrapped in a 5 s timeout — fresh Linux installs with a locked GNOME keyring hang indefinitely without it.
6. **Every `execa('nak', …)` passes `stdin: 'ignore'`.** nak blocks forever on EOF without it. (See `project_nak_stdin_hang` memory.)
