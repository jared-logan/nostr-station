# nostr-station

[![npm version](https://badge.fury.io/js/nostr-station.svg)](https://www.npmjs.com/package/nostr-station)
[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

A local Nostr dev environment in one Node process — relay, dashboard, AI chat,
and Amber-signed git in your browser. macOS or Linux.

Build apps, sign with your phone, publish to Nostr relays. Your keys never
touch the machine; your work never leaves the machine unless you push it.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/jared-logan/nostr-station/main/install.sh | bash
```

Installs Node 22+ if needed, installs the `nostr-station` npm package, and
launches it. Total time: ~10 seconds on a warm machine. No Docker, no Rust
toolchain, no system service files, no `sudo`.

Your browser opens at `http://localhost:3000/setup` for first-run pairing.

## First run

Three screens, two phone taps:

1. **Welcome** — get started.
2. **Pair Amber** — one full-screen QR. Scan in [Amber](https://github.com/greenart7c3/Amber)
   on your Android phone, tap approve. Your npub is captured via NIP-46;
   your nsec stays on your phone.
3. **Verify** — sign a test event via Amber (second tap), publish it to the
   local relay, read it back. Live three-row checklist.

Then you land on the dashboard. The local relay is running on
`ws://localhost:7777`, accepting any signed event.

---

## Quick start: build and ship your own project

The happy path for a project you own. No branches, no PRs, no terminal.

1. **Projects panel → `+ New Project`.** Pick a template (mkstack, blank, or
   paste a git URL). The project scaffolds locally; the card appears in your
   list within seconds.
2. **Click the chat bubble icon** on the card to open the project in Chat.
   Nori (your AI assistant) loads the project context automatically.
3. **Tell Nori what to build.** It edits files, runs commands, and commits
   as it goes ("Want me to commit this?" → yes). Each commit gets a
   descriptive message from the AI.
4. **Click Sync** (circular-arrows icon on the project card) when you're
   ready to publish. Amber lights up on your phone — approve the sign
   prompt. The local commits push to your ngit repo and appear on
   [gitworkshop.dev](https://gitworkshop.dev) seconds later.

That's the full loop. Scaffold to "live on Nostr" in five clicks plus a
phone tap or two.

---

## Project operations

The verbs you'll reach for, what they do, when to use which.

| Action      | Where                                                | What it actually runs                                       |
|-------------|------------------------------------------------------|-------------------------------------------------------------|
| **Sync**    | Project card icon (circular arrows)                  | `git pull --ff-only origin HEAD` then `git push origin HEAD`|
| **Snapshot**| Project card icon (disk)                             | `git add -A && git commit -m "snapshot <timestamp>"`        |
| **Publish** | Project view → Settings → ngit signer + sync section | `git push origin HEAD` (no pull)                            |
| **Send PR** | Pull requests tab → "Submit your local commits…"     | Branch + optional reset + `ngit send --defaults`            |
| **Download**| Pull requests tab → Download on a proposal           | `ngit pr checkout <id>` (check out a PR locally to review)  |
| **Merge**   | Pull requests tab → Merge on a proposal              | `ngit pr_merge <id>` (checkout, merge, push, publish 1631)  |

**Sync vs Publish.** Sync pulls first so you never push on top of a stale
tree; Publish just pushes. Use Sync by default. Publish is for "I know
upstream is behind me, just send it."

**Snapshot vs AI-driven commit.** When Nori asks to commit, that's the
granular per-task path. Snapshot is the coarse "save everything dirty into
one commit" path — handy when you hand-edited a file outside the chat or
want a checkpoint before something risky.

---

## User journeys

### Journey 1: build and ship (your own repo)

See the [Quick start](#quick-start-build-and-ship-your-own-project) above —
that's this journey end to end. Five clicks, one Amber tap.

### Journey 2: submit a PR to someone else's project

For contributing to a project you don't own.

1. **Clone the repo.** Projects panel → `+ New Project` → paste their
   `nostr://...` or `naddr1...` URL. Or `ngit scan <url>` from a terminal,
   then adopt the directory via "+ New Project → existing path."
2. **Open in Chat** and build your feature on the default branch. Nori
   commits as it goes.
3. **Project view → Pull requests tab.** You'll see a card at the top:
   *"Submit your local commits as a PR · N commits ahead of origin/main."*
4. **Type a branch name** (e.g. `feature-add-dark-mode`), optionally tick
   *"Reset main back to origin/main after branching"* if you want a clean
   GitHub-style flow, then click **Submit PR**.
5. **Approve the Amber sign prompt** on your phone. The dashboard streams
   the branch + reset + `ngit send` steps live. Your PR shows up on
   gitworkshop and in the maintainer's Pull requests tab.

No terminal. No `git checkout -b`. No knowing what a refspec is.

### Journey 3: review an incoming PR

When someone proposes changes to your project.

1. **Project view → Pull requests tab.** Incoming proposals are listed by
   subject, author, and status.
2. **Click a PR** to expand it — see the commit list and unified diff.
3. **Click Download** to check out the PR branch locally. You can run it,
   open it in Chat, ask Nori to review the diff.
4. To switch back to your default branch: open the Terminal panel and
   `git checkout main`. (One terminal moment — a future polish pass
   closes this.)

### Journey 4: accept and merge a PR

After you've reviewed and want to land it.

1. **Pull requests tab → Merge** on the proposal you want.
2. **Working tree must be clean** — the server refuses loudly if not.
   Commit or stash your local work first.
3. **Approve the Amber sign prompt** (signs the kind-1631 merge event).
4. The dashboard streams `ngit pr_merge`'s output: checkout the PR
   branch, merge to default, push refs, publish the merge event. The
   proposal's status on the relay flips to "merged" within seconds.

---

## Panels

The dashboard has eight panels in the sidebar. What each one does and when
to reach for it.

### Dashboard

The landing panel. Service-health overview: relay, watchdog, nostr-vpn,
optional tools (ngit, claude-code, opencode, nak, Stacks). Each row shows
state (green / yellow / red) plus an Install button when something's
missing.

The status here is the same data `nostr-station status` shows in the
terminal — same source. Cached for 3 s on the dashboard so flipping
panels feels instant; reflects state-change actions (start/stop/install)
within the next poll.

### Chat

Your AI coding assistant. Pick a provider in the dropdown:

- **API providers** — Anthropic, OpenAI, OpenRouter, OpenCode Zen,
  Routstr, PayPerQ. Keys stored per-provider in the OS keychain.
- **Local providers** — Ollama, LM Studio.
- **Pay-per-call** — Maple Desktop.
- **Any OpenAI-compatible endpoint** — add a custom provider.

The chat is scoped to your **active project** — Nori reads your project's
README, `NOSTR_STATION.md`, and code context automatically. Switch
projects from the picker; the system prompt updates.

Two providers per surface is fine — Claude Code in your terminal while
Ollama backs the dashboard chat is a normal setup. See `nostr-station ai
default` in the [CLI reference](#cli-reference).

### Projects

The center of gravity. Lists every project as a card showing:

- Path
- Capabilities (`git`, `ngit`, `nsite`)
- Live git state (`up to date`, `1 ahead`, `dirty`, `diverged`)
- Identity (station default or per-project override)
- Last activity

Card icons (left to right): **Chat**, **Terminal**, **Sync**, **Snapshot**.

Click into a card to open the project view, which has these tabs:

- **Overview** — README + project metadata
- **About** — gitworkshop-style page (ngit only): description, maintainers,
  relays
- **Code** — file tree + viewer (when there's a git checkout)
- **Pull requests** — incoming PRs from collaborators, plus the *"Submit
  your local commits as a PR"* CTA when you're ahead of origin
- **Issues** — kind-1621 issues (ngit only)
- **nsite** — static site state + deploy controls (when configured)
- **Settings** — git remote, ngit signer + sync section, identity
  overrides

See [Project operations](#project-operations) and
[User journeys](#user-journeys) for the verbs.

### Relay

Your local Nostr relay's control surface. Backed by `better-sqlite3` at
`~/.nostr-station/data/relay.db`.

- **Start / stop / restart** the relay (in-process, no separate daemon).
- **Live event feed** — every event the relay accepts, streaming.
- **Manual publish** — paste a signed event JSON, send to the relay.
- **NIP-11 metadata** — name, contact, supported NIPs, version (visible
  to remote clients querying the relay).
- **Whitelist** — which pubkeys are allowed to write (defaults: your
  npub + the seed npub).
- **Database** — size, event count, export, wipe (with confirmation).

Future events with `created_at > now + 15min` are rejected (NIP-01
clock-skew slack) so a bad client can't poison the recent-event window.

### nostr-vpn

Optional. A peer-to-peer mesh over Nostr — connect your laptop to your
home server without port forwarding, public hostnames, or a third-party
VPN. Useful when working across machines; skip it if you only develop
locally.

- **Install** button downloads + sha256-verifies a pinned binary, then
  registers a systemd / launchd service.
- **Start / stop / restart** controls.
- **Tunnel IP** displayed when connected.

The wizard explicitly asks if you want this with a *Skip for now* button
right next to *Install*. Default answer is Skip. You can always install
later from the Status panel or this panel.

### Logs

Three SSE-streamed log channels in tabs:

- **relay** — connection events, EVENT accepts / rejects / duplicates,
  REQ subscriptions, AUTH outcomes.
- **watchdog** — heartbeat publishes (every 5 min) + any errors.
- **nostr-vpn** — daemon stdout / stderr (when nvpn is installed and
  running).

Each channel has a banner at the top showing live status
(running / stopped / pending). Lines are tagged `[INFO]` / `[WARN]` /
`[ERROR]` with ISO timestamps.

### Config

The settings + identity surface:

- **Identity** — your npub, profile (kind-0 metadata), read / write
  relays.
- **ngit account** — Amber bunker pairing for git operations. Connect /
  disconnect.
- **AI providers** — keychain status per provider, default for chat vs
  terminal, base URLs for custom providers.
- **Project AI overrides** — per-project system prompt, context overlay,
  permissions, chat-provider override.
- **Theme** — Ditto theme sync (kind-30078) when configured.
- **Editor target** — `NOSTR_STATION.md` ↔ tool-specific filename
  symlink (`CLAUDE.md`, `.cursorrules`, etc.).

### Terminal

Embedded shell with xterm.js + node-pty. Tabbed (one tab per shell
session). The active project's path is the working directory by default.

- **Open in AI** — launches your configured terminal-native AI (Claude
  Code or opencode) in a new tab, pre-scoped to the active project.
- **Sessions persist** for the lifetime of the dashboard process;
  closing a tab kills that shell.

Same shell experience as a regular terminal — `git`, `npm`, `make`,
whatever you'd normally run.

---

## CLI reference

The same operations the dashboard offers, plus a few power-user verbs,
all scripted-friendly.

### Lifecycle

```
nostr-station            Boot the dashboard + relay, open the browser
nostr-station start      Same as bare invocation
nostr-station stop       Stop via PID file (clean SIGTERM)
nostr-station status     Show service state (--json for machines)
nostr-station chat       Open the dashboard (alias for the launcher)
```

The launcher is foreground — Ctrl+C tears down the dashboard and the
relay together. State persists in `~/.nostr-station/`; subsequent runs
skip the wizard and drop you straight into the dashboard.

`nostr-station status` exits 1 if any probe row is failing, 0 if
everything is green. `--json` always exits 0 — the payload is the
machine-readable signal.

### Optional tools

Tools that aren't on the happy path live behind one explicit verb:

```
nostr-station list                    Show available tools + install state
nostr-station add <tool>              Install (interactive y/N confirm)
nostr-station add <tool> --yes        Install without prompting
```

Available today: `ngit` (Nostr-native git), `nak` (event/relay CLI),
`stacks` (Soapbox app scaffolder), `nsyte` (static-site publishing).
The wizard never asks about these — opt in when you need each one.

### Publish & deploy

```
nostr-station publish               GitHub + ngit (whatever's configured)
nostr-station publish --github      GitHub only
nostr-station publish --ngit        ngit only — Amber signs each event
nostr-station nsite publish         Publish a static site to nsite/Blossom
```

Every ngit push is signed via Amber on your phone — the nsec never
touches the machine.

### AI providers

```
nostr-station ai list                          Configured providers + defaults
nostr-station ai add <provider>                Add a provider (prompts for key)
nostr-station ai remove <provider>             Clear keychain slot + config
nostr-station ai default chat <provider>       Default for the Chat pane
nostr-station ai default terminal <provider>   Default for "Open in AI"
```

Different providers per surface is fine — Claude Code in the terminal,
Ollama in the Chat pane, etc.

### Keychain

```
nostr-station keychain list                   Stored credentials + active backend
nostr-station keychain set <key>              Store/update a credential
nostr-station keychain get <key>              Reveal (y/N confirm)
nostr-station keychain delete <key>           Remove (y/N confirm)
nostr-station keychain rotate <key>           Generate + replace a credential
nostr-station keychain rotate <key> --rollback   Restore the prior value
nostr-station keychain migrate                Move file-fallback secrets into the OS keychain
```

Backends in priority order: macOS Keychain → GNOME Keyring → AES-256-GCM
encrypted file at `~/.config/nostr-station/secrets` (mode 0600).

### Editor target

`NOSTR_STATION.md` is the canonical context file. `nostr-station editor`
symlinks it to whatever filename your AI coding tool reads:

| Tool        | Filename                            |
|-------------|-------------------------------------|
| Claude Code | `CLAUDE.md`                         |
| Cursor      | `.cursorrules`                      |
| Windsurf    | `.windsurfrules`                    |
| Copilot     | `.github/copilot-instructions.md`   |
| Aider       | `CONVENTIONS.md`                    |
| Codex       | `AGENTS.md`                         |
| Other       | `AGENTS.md` (generic)               |

Switch any time by re-running the command.

### Shell completion

```
nostr-station completion --shell zsh --install   # zsh or bash
nostr-station completion --shell bash --print    # write the script yourself
```

---

## Privacy and security

End-user perspective first; threat-model details below.

### What stays on your machine

- **Your nsec (private key).** Never on the machine. nostr-station never
  sees it. Every signing operation routes through Amber on your phone
  via NIP-46.
- **All project files.** Local repos, working tree, git history. Nothing
  copies anywhere unless you explicitly push.
- **The local relay's event store.** SQLite at
  `~/.nostr-station/data/relay.db`. Events you sign land here; the
  relay doesn't fan them out to public relays unless you publish.
- **AI provider API keys.** In your OS keychain (macOS Keychain / GNOME
  Keyring) or an AES-256-GCM encrypted file when the OS keychain isn't
  reachable.
- **Cached relay data.** Per-project caches at
  `<project>/.nostr-station/cache/` (auto-gitignored — never committed
  to your repo) and ephemeral in-memory caches the dashboard discards
  on restart.

### What leaves your machine, and when

Every outbound network call is initiated by an explicit user action:

| Action | Destination | What's sent |
|-|-|-|
| Sign event in Amber | Your phone over the configured NIP-46 relay | Event template (kind, content, tags). Signing happens on your phone; only the signed event comes back. |
| Sync / Publish / Send PR | The ngit remote (one or more relays + a grasp git server) | Your signed commits + the kind-1617/1631/30617 metadata events. |
| AI chat | Your configured AI provider | Your chat messages + the project's system prompt. Provider-specific privacy policies apply. Local providers (Ollama, LM Studio) keep this on your machine. |
| nsite publish | Blossom server + relays you've configured | The static-site files + the nsite metadata event. |
| `nostr-station status --json` from a script | nothing — purely local | nothing |
| Tool install | The pinned upstream URL (curl), then sha256-verified locally | nothing about you; just the binary download |

### What's never sent anywhere

- **Telemetry.** None. There is no phone-home, no usage tracking, no
  error reporting that leaves your machine. Browser DevTools network
  tab will show only loopback (127.0.0.1) and the destinations you
  explicitly act against.
- **Your nsec, again.** Worth saying twice. It never exists on the
  machine.
- **Project source code in cleartext to public Nostr relays** unless
  you publish via ngit, in which case you're explicitly signing every
  event.

### Network and process boundaries

- **Dashboard binds to `127.0.0.1` only.** Not reachable from your LAN
  or the internet — only programs running on your machine can talk to
  it.
- **Loopback-Host check** on every request rejects DNS-rebinding
  attacks (a malicious website tricking your browser into making
  cross-origin requests to localhost).
- **CSRF guard** — state-changing requests require a session token or
  a same-origin Referer header.
- **No `sudo` by default.** Installing optional tools that need write
  access to `/usr/local/bin` uses `sudo -n` (non-interactive) — fails
  fast with a clear "run this command in your terminal" hint if your
  sudo cred cache is empty. We never pipe `curl | sudo bash`.
- **Tool installs are sha256-pinned.** Every downloaded binary
  (`ngit`, `nak`, `nvpn`) is verified against a pinned hash *before*
  any extraction or install step. A tampered upstream tarball is
  refused, not unpacked.
- **No system service files installed by default.** The dashboard is
  a foreground process; the relay is in-process. The only system
  service is nostr-vpn's `nvpn` daemon if you explicitly install it.
- **No background daemons** persist after `nostr-station stop` — Ctrl+C
  (or the stop command) tears down the dashboard, the relay, the
  watchdog, and any pty sessions in one go.

### Trust boundaries to be aware of

- **Local relay accepts any signed event** on loopback (NIP-42
  enforcement is not yet implemented). It's a single-user dev relay —
  don't expose it to a public network.
- **AI providers see your prompts.** If you pick a hosted API provider
  (Anthropic, OpenAI, etc.), your messages and project context go to
  them. Pick a local provider (Ollama, LM Studio) if that matters for
  your threat model.
- **The Terminal panel runs your shell** with your normal privileges.
  Anything you'd run in `bash` you can run there, with all the same
  consequences.

See `SECURITY.md` for reporting issues + the full threat model.

---

## Architecture

One Node process. The relay (NIP-01 + NIP-11, `better-sqlite3`-backed)
and the dashboard HTTP server live in the same process tree. Lifecycle
is one PID file at `~/.nostr-station/pid`. Data:

```
~/.nostr-station/
├── pid                       Dashboard PID (used by `nostr-station stop`)
├── data/relay.db             Local relay's SQLite event store
├── bunker-client.json        Saved NIP-46 pairing for silent re-auth
└── ai-config.json            Provider config + per-surface defaults

~/.config/nostr-station/
├── identity.json             npub, read relays, setupComplete
└── secrets                   Encrypted keychain (Linux fallback)

~/nostr-station/projects/     Default projects directory
```

Why pure Node: install is one curl command. No Docker, no signed-binary
distribution, no Rust toolchain, no Apple Developer account. The relay
is intentionally minimal — it's a single-user local dev relay, not a
production-grade deployment.

---

## Contributing / dev loop

```bash
git clone https://github.com/jared-logan/nostr-station
cd nostr-station
npm install
npm run dev          # tsx watch, dashboard at :3000, relay at :7777
```

Tests:

```bash
npm test             # node:test via tsx
npm run typecheck    # type-check without emit
```

Clean-install testing in a fresh VM (recommended for any install-path
changes) — Multipass or OrbStack VMs both work:

```bash
# Multipass
multipass launch --name ns-test
multipass shell ns-test
# inside the VM:
curl -fsSL https://.../install.sh | bash
# back on host:
multipass delete ns-test --purge

# OrbStack VMs (Apple Silicon-friendly)
orb create ubuntu ns-test
orb shell ns-test
# … same install, then:
orb delete ns-test
```

See `CONTRIBUTING.md` for code style + commit conventions.

---

## License

MIT — see `LICENSE`.
