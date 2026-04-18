# Contributing to nostr-station

## Getting started

```bash
git clone https://github.com/jared-logan/nostr-station
cd nostr-station
npm install
npm run build

# Terminal wizard (Ink TUI)
node dist/cli.js onboard

# Web wizard / dashboard (bare invocation is the default path in shipped installs)
node dist/cli.js                  # → http://localhost:3000/setup  (or / if already configured)
node dist/cli.js chat             # same thing, explicit

# Non-interactive paths (CI / scripts)
node dist/cli.js onboard --demo   # throwaway keypair, no TTY prompts
node dist/cli.js status --json
node dist/cli.js doctor --plain
```

Or use `tsx` for faster iteration without a rebuild step:

```bash
npm run dev -- onboard
npm run dev                       # bare → web wizard/dashboard
```

Web assets (`src/web/*`) are copied into `dist/web/` by `scripts/copy-web.mjs` during `npm run build`; `tsx` in dev serves them directly from `src/web/`.

## Project structure

```
src/
  cli.tsx                       Entry point — argv parsing, command dispatch.
                                Bare invocation routes to the web __welcome__ path.
  commands/                     One React/Ink component per top-level CLI command.
    Ai.tsx                      `ai list|add|remove|default <terminal|chat>`
    Chat.tsx                    Boots the web server; serves dashboard + /setup
    Completion.tsx, Doctor.tsx, Editor.tsx, Keychain.tsx, Logs.tsx,
    Nsite.tsx, Publish.tsx, Relay.tsx, RelayConfig.tsx, Seed.tsx,
    Status.tsx, Tui.tsx, Uninstall.tsx, Update.tsx, UpdateWizard.tsx
  lib/
    ai-providers.ts             Static registry of 14 providers (terminal-native + api)
    ai-config.ts                ~/.nostr-station/ai-config.json r/w + legacy migration
    ai-context.ts               Builds NOSTR_STATION.md as system prompt for the Chat pane
    auth.ts                     Session tokens, localhost opt-out, requireAuth parsing
    auth-bunker.ts              NIP-46 sign-in flow + silent re-auth
    bunker-storage.ts           Persisted bunker client at ~/.nostr-station/bunker-client.json
    completion.ts               zsh / bash tab-completion script generators
    detect.ts                   Platform / OS / arch / pkg-mgr / installed-tool detection
    git.ts                      Git helpers (remote resolve, argv-clean clone)
    identity.ts                 ~/.config/nostr-station/identity.json r/w + seed
    install.ts                  install{CargoBin,ClaudeCode,Stacks,Nvpn}, etc.
    keychain.ts                 OS keychain abstraction; 5 s timeout wrapper
    project-scaffold.ts         New Local Project + MKStack scaffold pipeline
    projects.ts                 Registered-project CRUD + capability detection
    relay-config.ts             TOML r/w for nostr-rs-relay + argv-safe npub→hex
    services.ts                 Service-unit templates + NOSTR_STATION.md builder
    terminal.ts                 node-pty session registry + capability probe
    tty.ts                      requireInteractive gate for TTY-only commands
    verify.ts                   Verify-phase + doctor probes
    version.ts                  Re-exports package.json version (single source of truth)
    versions.ts                 Pinned upstream versions for Rust components
    web-server.ts               HTTP + WS server; /setup wizard; /api/*; SSE streaming
  onboard/
    index.tsx                   Wizard orchestrator — 5-phase pipeline
    components/                 Banner, LaunchPicker, palette, Prompt, Select, Step, Summary
    phases/                     Detect / Config / Install / Services / Verify
  web/
    index.html                  Dashboard shell (panels, sidebar, identity drawer)
    app.js                      All panel logic (vanilla JS, no framework)
    app.css                     Dashboard styling
    terminal.js                 xterm.js + WS client for the terminal panel
    nori.svg                    Logo
```

## Code style

- TypeScript strict mode, ES2022 target, ESM-only
- React Ink for all TUI rendering — no raw `process.stdout.write` in UI paths (exceptions: `--json`, `--plain`, deprecation warnings that must reach stderr before Ink mounts)
- Plain HTML + vanilla JS for the dashboard (no frontend framework). Panel logic lives in `src/web/app.js`, styles in `app.css`, terminal glue in `terminal.js`.
- **All shell calls use `execa` or `execFileSync` with array args** — never string concatenation into `/bin/sh -c`. Credential-touching paths especially.
- **Every `execa('nak', …)` passes `stdin: 'ignore'`** — `nak` blocks forever on EOF otherwise.
- No secrets in code, config files, or generated files — keys go through `src/lib/keychain.ts`.
- AI providers register in `src/lib/ai-providers.ts`, nowhere else. Consumers enumerate the registry at runtime.

## Security model — must not be broken

The core invariant: **the user's nsec never touches this machine.**

- All user-owned signing is via Amber NIP-46 (`ngit push`, `nsite publish`, dashboard NIP-98 sign-in).
- The watchdog nsec and seed nsec are the only nsecs stored locally, and both go through `src/lib/keychain.ts` — never written to disk in plaintext. The watchdog script retrieves its nsec at runtime via `security` / `secret-tool` / the nostr-station CLI.
- AI provider API keys go into per-provider OS-keychain slots (`ai:<provider-id>`). `~/.claude_env` is a shell-env loader, not a secret store.
- `~/.nostr-station/bunker-client.json` (mode `0600`) holds the ephemeral NIP-46 client secret for silent re-auth — it is **not** a signing key (Amber's nsec never leaves the phone). See `SECURITY.md` for the trade-off analysis.
- Every `/api/*` endpoint requires a valid session token unless the `requireAuth: false` + localhost opt-out is in effect (with a persistent dashboard banner).
- All `execa` / `execFileSync` calls use argv arrays to prevent shell injection. Path-traversal-prone paths (`/api/projects/:id/purge`) resolve `realpath` and refuse paths outside `$HOME`.

Contributions that compromise these invariants will not be merged. See `SECURITY.md` for the full model.

## Submitting changes

1. Fork the repo and create a feature branch.
2. Make your changes. `npm run build` to verify TypeScript compiles; run the relevant CLI commands or the dashboard to smoke-test.
3. Open a pull request — describe what changed and why. Link any related issues: [github.com/jared-logan/nostr-station/issues](https://github.com/jared-logan/nostr-station/issues).
4. For security-relevant changes, call out the threat-model impact in the PR description so reviewers don't have to reverse-engineer it.

## Bug reports

Use the [bug report template](https://github.com/jared-logan/nostr-station/issues/new?template=bug_report.md).
Include `nostr-station version`, OS / arch, and `nostr-station doctor --plain` output.

See [CHANGELOG.md](CHANGELOG.md) for version history.
