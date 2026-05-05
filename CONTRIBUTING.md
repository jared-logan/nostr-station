# Contributing to nostr-station

## Getting started

```bash
git clone https://github.com/jared-logan/nostr-station
cd nostr-station
npm install
npm run dev                       # tsx watch — bare invocation
                                  # dashboard at :3000, in-process relay at :7777
```

Or after `npm run build`:

```bash
node dist/cli.js                  # bare → /setup wizard or dashboard
node dist/cli.js status           # individual command
node dist/cli.js status --json    # machine-readable
node dist/cli.js add              # list optional tools
node dist/cli.js stop             # SIGTERM via PID file
```

Web assets (`src/web/*`) are copied to `dist/web/` by
`scripts/copy-web.mjs` during `npm run build`; `tsx` in dev serves
them directly from `src/web/`.

## Project structure

```
src/
  cli.tsx                       Entry — argv parsing, command dispatch.
                                Bare invocation renders <Chat>, which
                                boots the dashboard + in-process relay.
  cli-ui/                       Reusable Ink components (palette, Select,
                                Prompt, Step) used by every CLI command.
  commands/                     One Ink component per top-level command.
                                Add, Ai, Chat, Completion, Editor,
                                Keychain, Nsite, Publish, Seed, Status.
  relay/                        In-process Nostr relay (NIP-01 + NIP-11,
                                better-sqlite3-backed). ~550 LoC.
  lib/
    ai-providers.ts             Static registry of ~14 providers
    ai-config.ts                ~/.nostr-station/ai-config.json r/w
    ai-context.ts               NOSTR_STATION.md system-prompt builder
    auth.ts                     Session tokens + localhost opt-out
    auth-bunker.ts              NIP-46 sign-in (post-setup) + setup
                                pairing (startSetupAmber) +
                                signEventWithSavedBunker
    bunker-storage.ts           Persisted bunker client (mode 0600)
    completion.ts               zsh / bash tab-completion generators
    detect.ts                   Platform / OS / arch + hasBin / findBin
    editor.ts                   EDITOR_FILENAMES + symlinkEditorFile +
                                extractUserRegion (USER_REGION markers)
    git.ts                      Git helpers — remote resolve, argv-clean clone
    identity.ts                 identity.json r/w + hexToNpub / npubToHex
    keychain.ts                 OS keychain abstraction (3 backends)
    pid-file.ts                 ~/.config/nostr-station/chat.pid lifecycle
    project-scaffold.ts         New project + MKStack scaffold pipeline
    projects.ts                 Project CRUD + capability detection
    sync.ts                     Project git-state, sync, snapshot helpers
    terminal.ts                 node-pty session registry + capability probe
    tools.ts                    Optional-tool registry for `add` subcommand
    tty.ts                      requireInteractive gate for TTY-only commands
    url-safety.ts               safeHttpUrl — strict scheme + host validation
    version.ts                  Re-exports package.json version
    web-server.ts               HTTP server + WS relay-startup hook;
                                /setup wizard; /api/* router; SSE
    routes/                     Extracted route handlers (ai, identity,
                                ngit, projects, terminal)
  web/
    index.html                  Dashboard shell — panels, sidebar
    app.js                      All panel logic (vanilla JS, ~7k LoC)
    app.css                     Dashboard styling
    terminal.js                 xterm.js + WS client for terminal panel
    nori.svg                    Logo
tests/                          node:test via tsx (~160 tests, ~3s)
```

## Code style

- TypeScript strict mode, ES2022 target, ESM-only
- React Ink for all CLI rendering — no raw `process.stdout.write` in UI
  paths. Exceptions: `--json` / `--plain` / deprecation warnings that
  must reach stderr before Ink mounts
- Plain HTML + vanilla JS for the dashboard (no frontend framework).
  Panel logic lives in `src/web/app.js`, styles in `app.css`, terminal
  glue in `terminal.js`
- **All shell calls use `execa` or `execFile` with argv arrays** —
  never string concatenation into `/bin/sh -c`. The `tools.ts` install
  runner is the canonical pattern: `spawn(argv[0], argv.slice(1), {
  stdio: ['ignore', 'pipe', 'pipe'] })`, stream lines to the caller
- No secrets in code, config files, or generated files — keys go
  through `src/lib/keychain.ts`
- AI providers register in `src/lib/ai-providers.ts`, nowhere else.
  Consumers enumerate the registry at runtime
- Optional tools register in `src/lib/tools.ts`, behind
  `nostr-station add <tool>`. Adding a tool is a one-record diff

## Tests

```bash
npm test             # node:test via tsx, ~3s
npx tsc --noEmit     # type-check
```

Test files live in `tests/`. Each file that touches HOME-rooted state
imports `_home.ts`'s `useTempHome()` BEFORE the module-under-test
imports — that pins HOME to a tmpdir before any module-load constants
are computed.

## Clean-install testing

Any change touching `install.sh` or first-run flow should be verified
in a fresh VM. Multipass and OrbStack VMs both reset in ~30 seconds:

```bash
# Multipass (cross-platform)
multipass launch --name ns-test
multipass shell ns-test
# inside the VM:
curl -fsSL https://.../install.sh | bash
multipass delete ns-test --purge

# OrbStack (Apple Silicon)
orb create ubuntu ns-test
orb shell ns-test
orb delete ns-test
```

## Security model — must not be broken

The core invariant: **the user's nsec never touches this machine.**

- All user-owned signing routes through Amber via NIP-46. The setup
  wizard pairs via `nostrconnect://` QR (single phone tap), captures
  the user's npub from the bunker handshake without signing an event,
  then runs the verify stage which signs a kind-1 test event (second
  tap) and round-trips it through the local relay.
- AI provider API keys go into per-provider OS-keychain slots
  (`ai:<provider-id>`).
- `~/.nostr-station/bunker-client.json` (mode `0600`) holds the
  ephemeral NIP-46 client secret for silent re-auth — **not** a
  signing key (Amber's nsec never leaves the phone). See `SECURITY.md`
  for the trade-off analysis.
- Every `/api/*` endpoint requires a valid session token unless the
  `requireAuth: false` localhost opt-out is in effect (with a
  persistent dashboard banner).
- All shell calls use argv arrays. The `tools.ts` install runner is
  the reference pattern.
- The local relay binds to `127.0.0.1` only and is intentionally
  minimal — single-user dev tool, not a production deployment. Don't
  add NIP-42 / NIP-50 / metrics / clustering without an explicit
  discussion.

Contributions that compromise these invariants will not be merged.
See `SECURITY.md` for the full threat model.

## Submitting changes

1. Fork the repo and create a feature branch
2. Make your changes. `npm run build` to verify TypeScript compiles;
   `npm test` to verify the suite stays green
3. For changes touching install / first-run flow, smoke-test in a
   fresh VM (Multipass or OrbStack) — any breakage there is a real
   user-blocker
4. Open a pull request describing what changed and why. Link any
   related issues:
   [github.com/jared-logan/nostr-station/issues](https://github.com/jared-logan/nostr-station/issues)
5. For security-relevant changes, call out the threat-model impact in
   the PR description

## Bug reports

Use the [bug report template](https://github.com/jared-logan/nostr-station/issues/new?template=bug_report.md).
Include `nostr-station version`, OS / arch, and `nostr-station status
--json` output.

See [CHANGELOG.md](CHANGELOG.md) for version history.
