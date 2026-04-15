# nostr-station — Contributor Context

This file is for contributors using Claude Code (or any AI coding tool) to work on **nostr-station itself**. It describes the project so an AI agent can contribute effectively without needing the full conversation history.

> This is the repo-root contributor file. It is separate from the `NOSTR_STATION.md` generated on the *user's* machine during install (which lives in `~/projects/`).

## What nostr-station is

A single npm package (`nostr-station`) that sets up a complete Nostr dev environment in one terminal session: local private relay, mesh VPN, Nostr-native git (ngit + Amber signing), AI coding tool, and optional extras (nsyte, Stacks, Blossom).

**npm:** `npm install -g nostr-station`
**GitHub:** github.com/jared-logan/nostr-station

## Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript (strict) |
| TUI | React + [Ink](https://github.com/vadimdemedes/ink) |
| Shell calls | [execa](https://github.com/sindresorhus/execa) (array args only — no shell injection) |
| Package | npm, published as `nostr-station` |
| Bootstrap | `install.sh` bash script — installs Node via nvm, then `npm install -g nostr-station` |

## File structure

```
src/
  cli.tsx                   Entry point — parses argv, dispatches to command components
  commands/                 One React/Ink component per top-level command
    Doctor.tsx              Health checks + auto-repair
    Logs.tsx                Log tailing
    Relay.tsx               Relay start/stop/restart/status
    RelayConfig.tsx         relay config + whitelist subcommands
    Seed.tsx                Seed relay with dummy events
    Status.tsx              System status summary
    Tui.tsx                 Live dashboard
    Update.tsx              Non-interactive update
    UpdateWizard.tsx        Interactive update with version preview
    ...
  lib/
    detect.ts               Platform/OS/arch detection — returns Platform + Config types
    install.ts              installCargoBin(), installClaudeCode(), installStacks(), etc.
    keychain.ts             OS keychain abstraction (macOS / GNOME / AES-256-GCM file)
    relay-config.ts         TOML read/write for nostr-rs-relay config
    services.ts             Config file templates + NOSTR_STATION.md builder
    versions.ts             Pinned versions for Rust components
    completion.ts           zsh + bash tab-completion scripts
  onboard/
    index.tsx               Wizard orchestrator — stages: detect → config → install → services → verify → done
    components/             Banner, Prompt, Select, Step, Summary, palette
    phases/
      Detect.tsx            Phase 1 — OS/arch/pkg-mgr/installed tool detection
      Config.tsx            Phase 2 — collects user config interactively
      Install.tsx           Phase 3 — compiles + installs all components
      Services.tsx          Phase 4 — writes configs, registers services, seeds keychain
      Verify.tsx            Phase 5 — checks everything is running
```

## Key design decisions

**nsec never on machine.** All signing via Amber NIP-46. The watchdog keypair is the only nsec stored locally, and it goes into the OS keychain — never written to disk.

**Private relay by default.** NIP-42 auth enabled; whitelist-only; not listed on relay directories.

**AI provider agnostic.** 9 providers supported. Claude Code is only installed when the user selects Anthropic or Claude Code as their editor — not otherwise.

**Stacks is optional and separate.** Stacks has its own AI provider config. It is not integrated with nostr-station's AI setup. The description "scaffold Nostr apps quickly with stacks mkstack" is accurate — do not add Dork references.

**execa for all shell calls.** No string concatenation passed to `/bin/sh -c`. Every credential-touching call uses array args.

## How to run locally

```bash
npm install
npm run build
node dist/cli.js onboard          # full wizard
node dist/cli.js onboard --demo   # throwaway keypair, no prompts
node dist/cli.js doctor
node dist/cli.js seed --full
```

Or without building (tsx watch):

```bash
npm run dev -- onboard
```

## Current version

v0.0.5 (in progress). See CHANGELOG.md.

## What must never be broken in contributions

1. nsec never stored in plaintext on disk
2. All `execa` calls use array args (no shell injection surface)
3. Claude Code install remains conditional on provider/editor choice
4. Keychain abstraction covers all three backends (macOS, GNOME, encrypted file)
