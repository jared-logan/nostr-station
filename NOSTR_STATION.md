# nostr-station — Contributor Context

Context file for contributors using Claude Code (or any AI coding tool) to
work on **nostr-station itself**. Describes the project so an AI agent
can contribute effectively without needing the full conversation history.

> This is the repo-root contributor file. It is separate from the
> `NOSTR_STATION.md` written to the *user's* projects directory at first
> run (which lives at `~/nostr-station/projects/NOSTR_STATION.md`).

## What nostr-station is

A single npm package that runs a complete Nostr dev environment in **one
Node process**: an in-process Nostr relay (NIP-01 over WebSocket, NIP-11
over HTTP, `better-sqlite3`-backed event store) and an HTTP dashboard
with chat, projects, terminal, and a first-run setup wizard.

One curl command installs Node + the npm package + auto-launches.
Browser opens at `http://localhost:3000/setup`. First run pairs Amber
via NIP-46 nostrconnect (one QR), runs a live signing-pipeline
verification (sign + publish + read-back), then drops to the dashboard.

**npm:** `npm install -g nostr-station`
**GitHub:** github.com/jared-logan/nostr-station

## Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript strict mode, ES2022, ESM-only |
| Runtime | Node.js ≥ 22 |
| Relay | Pure-JS, in-process. `ws` + `better-sqlite3` (npm prebuilds) |
| Terminal UI | React + [Ink](https://github.com/vadimdemedes/ink) for CLI commands (Add, Editor, Keychain, etc.) |
| Web UI | Plain HTML + vanilla JS (no framework), xterm.js for terminal panel, served by `src/lib/web-server.ts` |
| PTY | [node-pty](https://github.com/microsoft/node-pty) as `optionalDependency` |
| Shell calls | `execa` + `execFile` with fixed argv only — no `/bin/sh -c` string concat |
| Nostr | `nostr-tools` for keys + NIP-19 + NIP-46 + signature verification |
| Bootstrap | `install.sh` — installs Node via nvm, then `npm install -g nostr-station`, then `exec nostr-station` |

No Docker, no Rust toolchain, no Apple Developer cert, no LaunchAgent /
systemd. Optional tools (ngit, nak, stacks, nsyte) are user-installed
post-onboard via `nostr-station add <tool>`.

## File structure

```
src/
  cli.tsx                     Entry — parses argv, dispatches to command
                              components. Bare invocation renders <Chat>
                              (boots web-server.ts + opens browser at /setup).
  cli-ui/                     Reusable Ink components (palette, Select,
                              Prompt, Step) — used by every CLI command.
  commands/                   One Ink component per top-level command.
    Add.tsx                   `nostr-station add <tool>` + `list`
    Ai.tsx                    `ai list|add|remove|default <terminal|chat>`
    Chat.tsx                  Boots web-server.ts; serves dashboard + /setup
    Completion.tsx            zsh/bash tab-completion install
    Editor.tsx                Relink NOSTR_STATION.md symlink to AI tool
    Keychain.tsx              list / get / set / delete / rotate / migrate
    Nsite.tsx                 init / publish / deploy / status / open
    Publish.tsx               Fan out to git push + ngit push
    Seed.tsx                  Seed relay with stable-identity dummy events
    Status.tsx                System status + gatherStatus + formatStatusJson
  relay/                      In-process Nostr relay (~550 LoC).
    types.ts                  NostrEvent + NostrFilter
    filter.ts                 NIP-01 filter matcher (live fan-out)
    store.ts                  better-sqlite3 event store; replaceable +
                              parameterized-replaceable handling, indexed
                              tag table, maxEvents eviction
    index.ts                  WebSocket server (EVENT/REQ/CLOSE/EOSE/OK/
                              NOTICE/CLOSED) + NIP-11 metadata over HTTP
  lib/
    ai-providers.ts           Static provider registry (~14 providers)
    ai-config.ts              ~/.nostr-station/ai-config.json + legacy migration
    ai-context.ts             Build NOSTR_STATION.md as system prompt for
                              Chat pane; per-project overlay support
    auth.ts                   Session tokens, localhost opt-out, requireAuth
    auth-bunker.ts            NIP-46 sign-in: post-setup auth (existing) +
                              setup pairing (startSetupAmber) +
                              signEventWithSavedBunker generic helper
    bunker-storage.ts         Persisted bunker client at ~/.nostr-station/
                              bunker-client.json (mode 0600)
    completion.ts             zsh + bash tab-completion script generators
    detect.ts                 Platform / OS / arch / hasBin / findBin
    editor.ts                 EDITOR_FILENAMES + symlinkEditorFile +
                              extractUserRegion (USER_REGION markers)
    git.ts                    Git helpers — remote resolve, argv-clean clone
    identity.ts               ~/.config/nostr-station/identity.json read/write;
                              hexToNpub / npubToHex helpers
    keychain.ts               OS keychain abstraction (macOS Security /
                              GNOME secret-tool / AES-256-GCM file)
    pid-file.ts               ~/.config/nostr-station/chat.pid lifecycle
    project-scaffold.ts       New Local Project + MKStack scaffold pipeline
    projects.ts               Project CRUD + capability detection
    sync.ts                   Project git-state, sync, snapshot helpers
    terminal.ts               node-pty session registry, PTY spawn helpers
    tools.ts                  Optional-tool registry for `nostr-station add`
    tty.ts                    requireInteractive gate for TTY-only commands
    url-safety.ts             safeHttpUrl — strict scheme + host validation
    version.ts                Re-exports package.json version
    web-server.ts             HTTP server + WS relay-startup hook;
                              /setup wizard endpoints; /api/* router;
                              SSE streaming; mounts in-process relay
                              alongside the dashboard.
    project-config.ts         Per-project .nostr-station/ dir reader/writer:
                              system-prompt.md, project-context.md,
                              template.json, permissions.json, chat.json
    prompt-render.ts          Tiny mustache/jinja-like templating engine
                              ({{ var }}, {% if %}, {% for %}) used by the
                              system-prompt pipeline
    templates.ts              Project-templates registry (built-in MKStack
                              + user-added entries) at
                              ~/.config/nostr-station/templates.json
    ai-tools/
      index.ts                Tool dispatcher + provider-spec adapters
      path-safety.ts          resolveProjectPath — the security guard
      fs.ts                   list_dir/read_file/write_file/apply_patch/delete_file
      git.ts                  git_status/log/diff/commit (project-scoped)
      exec.ts                 run_command (argv only; argv denylist)
      approval-gate.ts        In-memory pending-approvals registry
      tool-loop.ts            Anthropic + OpenAI-compat tool round-trip flows
    routes/
      _shared.ts              readBody + streamExec helpers
      ai.ts                   /api/ai/* (providers, config, chat, models, approve)
      identity.ts             /api/identity/* (config, set, relays, profile)
      ngit.ts                 /api/ngit/* (discover, clone, account)
      projects.ts             /api/projects/* (CRUD, git-state, sync, snapshot,
                              ai-config)
      templates.ts            /api/templates/* (list, CRUD, reset built-in)
      terminal.ts             /api/terminal/* + WS upgrade
  web/
    index.html                Dashboard shell — panels, sidebar, identity
    app.js                    All panel logic (vanilla JS, ~7k LoC)
    app.css                   Dashboard styling
    terminal.js               xterm.js + WS client for the terminal panel
    nori.svg                  Logo
tests/                        node:test via tsx (~2k LoC, 400+ tests)
```

## Key design decisions

**One Node process, no Docker.** The relay (`src/relay/`) runs inside
the dashboard's process via `maybeStartInprocRelay()` in
`web-server.ts`. Lifecycle is one PID file at
`~/.config/nostr-station/chat.pid`. `nostr-station stop` reads the PID
and SIGTERMs — the same handler runs on Ctrl+C. Distribution is the npm
package; install is `curl … | bash → npm install -g → exec`.

**nsec never on this machine.** All user-owned signing routes through
Amber via NIP-46. The setup wizard captures the user's npub via
`signer.getPublicKey()` during the connect handshake (no event signed
during pairing — single phone tap), then the verify stage signs a
kind-1 test event (second tap), publishes, reads back. Future
publish/deploy flows use `signEventWithSavedBunker(template)` from
`auth-bunker.ts` — same primitive.

**Optional tools are post-onboard.** Wizard never asks about ngit /
nak / nsyte / stacks. Users install via `nostr-station add <tool>`.
Registry at `src/lib/tools.ts` is data: `id`, `binary`, `detect` argv,
`prereqs`, `installSteps[{ kind, display, argv }]`. Adding a new tool
is a one-record diff. Step kinds: `cargo-install`, `npm-global`,
`shell-script`, `manual` (no automated path — surfaces install URL).

**AI provider agnostic but curated.** Two surfaces:
- **Terminal-native** (Claude Code, OpenCode Go) — spawned as PTY
  tabs; each owns its own auth.
- **API** — Nostr-native first: Anthropic, OpenCode Zen, PayPerQ ⚡,
  Routstr ⚡, plus a Custom Provider entry for any OpenAI-compat
  endpoint (covers OpenAI / Groq / Gemini / Ollama / LM Studio /
  self-hosted). Proxied via `/api/ai/chat` with keys in per-provider
  keychain slots `ai:<provider-id>`.

Separate defaults for `terminal` and `chat`. Register new providers in
`ai-providers.ts` only — consumers (Config panel, Chat pane, `ai` CLI,
`/api/ai/providers`) enumerate the registry at runtime.

**Project AI configuration is layered.** Three resolution levels for
every chat-pane decision:

1. `<project>/.nostr-station/<file>` (per-project override)
2. `~/.config/nostr-station/<file>` (global default — future)
3. Built-in default in code

Files in `<project>/.nostr-station/`:
- `system-prompt.md` — full template override; gets the same
  `{{ var }}` / `{% if %}` / `{% for %}` surface as the built-in
- `project-context.md` — verbatim overlay spliced into the system
  prompt (also reads legacy `<project>/project-context.md`)
- `template.json` — `{ templateId, templateName, sourceUrl,
  scaffoldedAt }`; the AI sees this in the env block
- `permissions.json` — `{ mode: 'read-only' | 'auto-edit' | 'yolo' }`
  drives the tool-call approval gate
- `chat.json` — `{ provider, model }` per-project AI override
- `.gitignore` — keeps `permissions.json` + `chat.json` out of git
  but commits the shareable files

`src/lib/project-config.ts` is the single source of truth for reads
+ writes. `seedProjectConfig(project, template)` runs once at
scaffold time; never overwrites existing files.

**Project templates are user-editable.** Registry at
`~/.config/nostr-station/templates.json`. Built-in MKStack is
self-healing — deleting it from the JSON re-seeds on next read.
Built-in description is editable; `Reset` restores. User-added
templates fully CRUD via Config → Project Templates.

**System prompt is templated, not stitched.** `ai-context.ts`
resolves the source (project override → built-in
`DEFAULT_PROMPT_TEMPLATE`) and renders through `prompt-render.ts` —
a 200-line dependency-free mustache-like engine that supports
`{{ var.path }}`, `{% if expr %}…{% else %}…{% endif %}`,
`{% for x in xs %}…{% endfor %}`, and string-literal equality.
Variables: `mode` (init/edit), `model.fullId`, `date`, `cwd`,
`repositoryUrl`, `deployedUrl`, `projectTemplate`, `user`,
`config.templates`, `permissions`, `recentCommits`, `README`,
`projectContextOverlay`. Missing variables silently render to empty
string; the renderer evaluates no user code.

**AI tools are project-scoped + path-safe + permission-gated.**
`src/lib/ai-tools/` exposes `list_dir`, `read_file`, `write_file`,
`apply_patch`, `delete_file`, `git_status`, `git_log`, `git_diff`,
`git_commit`, `run_command`. Every path goes through
`resolveProjectPath()` which rejects absolutes, `..` traversal,
NUL bytes, and symlink escapes (canonicalizes the longest existing
ancestor and re-checks). `run_command` is argv-only with a denylist
of obvious footguns (`rm -rf`, `git push --force`, `npm publish`,
`curl`, `wget`, `sudo`).

Permissions:
- `read-only` (default): write/exec require user approval
- `auto-edit`: file writes auto-approved; exec still gated
- `yolo`: everything auto-approved (banner-warned)

Approval gate (`approval-gate.ts`) is an in-memory map keyed by
session UUID. The chat tool-loop (`tool-loop.ts`) emits SSE
`approval_request` and awaits a Promise that the
`/api/ai/chat/approve` route resolves. Sessions are scoped to one
chat turn; cleanup runs in `finally{}`.

**Owner authentication for the dashboard.** NIP-98 challenge/response;
every `/api/*` endpoint requires a session token issued only to the
npub in `identity.json`. 8 h session tokens in `localStorage` so they
survive browser restart. `silentBunkerSign()` re-auths via the persisted
bunker client so users don't rescan a QR on every refresh. Localhost
opt-out: `"requireAuth": false` in `identity.json` exempts `127.0.0.1`
/ `::1` with a persistent banner.

**Terminal panel as the exec surface.** Long-running actions render in
live terminal tabs via `terminal.ts` + `/api/terminal/*`, not modal
dialogs. Copy-pastable, inspectable.

**execa / execFile for all shell calls.** Fixed argv arrays only. No
string concatenation into `/bin/sh -c`. The `tools.ts` install runner
is the canonical pattern: `spawn(argv[0], argv.slice(1), { stdio:
['ignore', 'pipe', 'pipe'] })`, stream lines to the caller.

**Pure-JS over native binaries.** The relay is `better-sqlite3` (which
ships its own npm prebuilds — that's our only native dep, and npm
handles platform matching). No Rust, no Go, no signing pipeline.

## How to run locally

```bash
npm install
npm run dev                          # tsx watch — bare invocation,
                                     #   dashboard at :3000, relay at :7777

# Or after `npm run build`:
node dist/cli.js                     # bare invocation
node dist/cli.js status              # individual commands
node dist/cli.js add                 # list optional tools
node dist/cli.js stop                # SIGTERM via PID file
```

Web assets (`src/web/*`) are copied to `dist/web/` by
`scripts/copy-web.mjs` during build; `tsx` in dev serves them directly
from `src/web/`.

## Tests

```bash
npm test             # node:test via tsx, ~3s, ~160 tests
npx tsc --noEmit     # type-check
```

Test files live in `tests/`. Each test file that touches HOME-rooted
state (config, keychain, identity, relay db) imports `_home.ts`'s
`useTempHome()` BEFORE its module-under-test imports — that pins HOME
to a tmpdir before any module-load constants are computed.

## Clean-install testing

Any change touching `install.sh` or first-run flow should be tested in
a fresh VM, not on a developer machine. Multipass or OrbStack VMs both
work and reset in ~30 seconds:

```bash
multipass launch --name ns-test
multipass shell ns-test
# inside VM: curl -fsSL https://.../install.sh | bash
multipass delete ns-test --purge

# or:
orb create ubuntu ns-test
orb shell ns-test
orb delete ns-test
```

## Current version

v0.0.6-0 (pre-release tag; 0.0.6 is in progress). Version string is
sourced from `package.json` via `src/lib/version.ts`; `cli --version`
derives from there.

## What must never be broken in contributions

1. **nsec never stored in plaintext on disk.** All user-owned signing
   routes through Amber via NIP-46. Local nsecs (watchdog, seed) live
   in the OS keychain via `src/lib/keychain.ts`.
2. **All shell calls use argv arrays** (`execa` / `execFile`). No string
   concatenation into `/bin/sh -c`. The `tools.ts` install runner is
   the reference pattern.
3. **AI providers register in `ai-providers.ts`, nowhere else.**
   Consumers enumerate the registry at runtime.
4. **Dashboard auth stays on by default.** `requireAuth: false` is
   explicit, localhost-scoped, banner-visible. Don't add silent
   bypasses.
5. **Keychain abstraction covers all three backends** (macOS Security,
   GNOME secret-tool, AES-256-GCM file). All backend ops wrapped in a
   5 s timeout — fresh Linux with a locked GNOME keyring hangs
   indefinitely without it.
6. **The relay stays minimal.** `src/relay/` implements NIP-01 + NIP-11
   for a single-user local dev relay. Don't add NIP-42 / NIP-50 /
   metrics / clustering / multi-tenant features without an explicit
   discussion — production-grade relays are not what this is for.
7. **Optional tools stay in `nostr-station add`.** Wizard never asks
   about ngit / nak / nsyte / stacks. Auto-installing them on a fresh
   machine is exactly what the simplification deleted.
8. **`install.sh` stays one curl command.** No `sudo`, no `apt-get`,
   no Docker, no Rust prereq checks. Inner loop: install Node via nvm
   if missing → npm install -g → exec.
9. **AI tool path-safety must not be relaxed.** Every fs / exec tool
   resolves its input via `resolveProjectPath()` in
   `src/lib/ai-tools/path-safety.ts` and rejects on absolute paths,
   `..` traversal, NUL bytes, and symlink escape. The `tests/path-
   safety.test.ts` suite is the spec — tests there should grow, not
   shrink. The `run_command` argv denylist is defense-in-depth, not
   the primary guard.
10. **Tool calls under read-only permissions require explicit user
    approval.** Server-side `requiresApproval()` is the single source
    of truth — providers MUST call it before dispatching. The chat
    UI's Approve/Reject buttons surface the gate; YOLO mode bypasses
    the gate but not the visibility (the call still renders before
    execution).
