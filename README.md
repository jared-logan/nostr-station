# nostr-station

[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

A local Nostr dev environment in one Node process — relay, dashboard, AI chat,
and Amber-signed git in your browser. macOS or Linux.

Build apps, sign with your phone, publish to Nostr relays. Your keys never
touch the machine; your work never leaves the machine unless you push it.

---

## Install

Requires **Node.js 22+** (plus `git` and a C build toolchain —
`build-essential` on Debian/Ubuntu) already on your `PATH`.

Don't have Node yet? Install it first — via [nodejs.org](https://nodejs.org/),
your system package manager, or nvm:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && nvm install 22
```

Then install nostr-station:

```bash
curl -fsSL https://raw.githubusercontent.com/jared-logan/nostr-station/main/install.sh | bash
```

Clones nostr-station to `~/nostr-station`, builds it, links the
`nostr-station` command globally, and launches the dashboard. Total time:
~30-45 seconds on a warm machine. No Docker, no Rust toolchain, no system
service files, no `sudo`. If Node 22+, `git`, or the build toolchain is
missing, the installer prints the exact one-line fix and exits — it never
auto-installs system packages.

Re-running the same one-liner upgrades an existing install (fast-forward
pull, rebuild, relaunch). The prerequisites above (Node 22+, `git`, a C
build toolchain) are the only requirements — the installer detects each
and prints a clear, copy-pasteable fix if any is missing, rather than
failing partway.

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

![nostr-station dashboard](https://i.nostr.build/cZHIgynIL3XAtrqZ.png)

*The dashboard after first run: service-health overview, identity card, and the project list. Everything below starts from this screen.*

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

> MKStack-templated projects scaffold with a "Powered by nostr-station"
> footer convention — a tiny, removable nod so visitors can find their
> way back here. Delete or restyle it like any other component.

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

   ![Submit-a-PR CTA on the Pull requests tab](https://i.nostr.build/WuQp0E4vv1cNyNU6.png)

   *The CTA appears whenever you're on the default branch with a clean working tree and at least one commit ahead of origin. Optional `Reset main` checkbox matches GitHub's "branch off upstream" mental model.*

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

The dashboard organizes panels into three sidebar groups — **Operations**
(what you do daily), **Infrastructure** (what runs underneath), and
**Status** (live health rollup). What each panel does and when to reach
for it.

### Dashboard

The landing panel. At-a-glance overview cards (identity, projects, relay,
AI) plus a collapsible service-health rollup: relay, watchdog, nostr-vpn,
Communities, optional tools (ngit, nak, nsyte, grain). Each row
shows state (green / yellow / red) plus an Install / Start button when
something's missing.

The status here is the same data `nostr-station status` shows in the
terminal — same source. Cached for 3 s on the dashboard so flipping
panels feels instant; reflects state-change actions (start/stop/install)
within the next poll.

### Chat

![Chat panel mid-conversation, with the live preview iframe on the right](https://i.nostr.build/NnCH6vVCQRimGCfb.png)

*Chat panel with Nori in mid-edit — left pane streams the AI's reasoning and tool calls, right pane is a live iframe of the project's dev server (here, the BLIP demo at `localhost:5173`).*

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

### Mail

Encrypted email over Nostr — NIP-17 gift-wrapped messages, threaded.
Inbox / Requests / Blocked buckets, custom folders, compose with the
same Amber-signed pipeline as everything else. Manages your kind-10050
inbox-relay list directly from the panel; the unread badge surfaces
in the sidebar so you see new messages without opening the panel.

### Projects

![Projects panel listing two projects, each with capability badges and a live git-state pill](https://i.nostr.build/HaQHWyUCG7Pgwio6.png)

*The Projects panel. Each card surfaces path, capabilities, live git state ("up to date", "dirty", "N ahead"), identity, and four action icons (Chat, Terminal, Sync, Snapshot).*

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

![Project view — About tab](https://i.nostr.build/fyzcS72FqoDXiTL8.png)

*About tab: topics, maintainers, GRASP servers, additional relays, and the canonical clone command — the gitworkshop-equivalent "what is this repo?" page.*

![Project view — Code tab](https://i.nostr.build/sG4UClk1RTwlnbSd.png)

*Code tab: branch picker, verified-maintainer chip, file tree. Mirrors what visitors see on a hosted git forge.*

See [Project operations](#project-operations) and
[User journeys](#user-journeys) for the verbs.

### nsite

Browser-style panel for browsing decentralized sites: Nostr addressing
(`npub1…`, `user@host`, `nsite://name`), Blossom-hosted bytes,
SHA256-verified before render. Tabbed, back / forward / reload,
bookmarks, address-bar menu (Bookmarks · Site info · Settings · Dev
tools). Each tab renders inside a strict sandbox at a per-site origin
(`<siteId>.nsite.localhost:<port>`) so SOP keeps sites isolated from
the dashboard and from each other. See [docs/nsite-isolation.md](docs/nsite-isolation.md)
for the isolation model. Use `nostr-station nsite publish` to publish
a project's static build (separate from the browser side of this panel).

### Communities — experimental (beta)

> Off by default. Enable in **Config → Experimental**, click through
> the first-use acknowledgement, then the sidebar entry appears.

Managed private Nostr relays for the people you actually know. Each
community is a supervised [GRAIN](https://github.com/0ceanSlim/grain)
(Go Nostr relay) child process bound 1:1 to an
[nostr-vpn](#nostr-vpn) mesh, with its own allowlist, banlist, LMDB
datastore, and NIP-86 admin interface. The dashboard provides the
control plane; GRAIN provides the relay; nvpn provides the network.
Different communities never share a mesh.

- **Create** — wizard: name, owner pubkey, mesh selection, auto-
  allocated port (from 7778).
- **Members** — npub allowlist; only listed pubkeys can read or
  publish. Add by npub or hex.
- **Moderation** — banwords + per-pubkey bans via NIP-86.
- **Settings** — name, privacy mode, mesh binding.
- **Logs** — per-community tail with crash-restart history.

Privacy modes today: **Local only** (loopback) and **Private network**
(binds to the community's nvpn tunnel IP — never `0.0.0.0`).
Public-internet mode is deferred. The dashboard refuses meshes with
subnet-routing or exit-node flags set, to prevent accidental LAN
exposure.

GRAIN itself ships via `nostr-station add grain` (per-user install at
`~/.nostr-station/bin/grain`, no sudo, sha256-pinned). The Communities
panel surfaces a one-click installer when grain isn't present.

The full operator reference — supervision policy, healthcheck cadence,
NIP-86 verb set, what's deferred to v2 — lives at
[docs/communities.md](docs/communities.md).

### Relay

![Relay panel — status cards, whitelist, common nak commands](https://i.nostr.build/m75937aQOREIXNsS.png)

*The Relay panel: live status cards, write-whitelist (Seed + Watchdog pre-registered, more pubkeys addable), and ready-to-paste `nak` commands wired at `ws://127.0.0.1:7777`.*

Your local Nostr relay's control surface. Backed by `better-sqlite3` at
`~/.nostr-station/data/relay.db`.

- **Start / stop / restart** the relay (in-process, no separate daemon).
- **Live event feed** — every event the relay accepts, streaming.
- **Search corpus** — full-text search across every event the relay
  has cached locally, backed by SQLite FTS5 over `events.content`.
  Accepts plain keywords, quoted phrases, and FTS5 boolean syntax.
- **Materialized profiles** — kind-0 metadata is decoded and stored
  in a `profiles` table at ingest, so the dashboard resolves pubkeys
  to names + avatars locally without re-parsing JSON on every render.
  Profile rows outlive the underlying kind-0 event when the event-cap
  evicts, so author names keep resolving for history you've already
  pulled. Also powers `@-mention` autocomplete in the issue / PR
  composers.
- **Manual publish** — paste a signed event JSON, send to the relay.
- **NIP-11 metadata** — name, contact, supported NIPs, version (visible
  to remote clients querying the relay).
- **Whitelist** — which pubkeys are allowed to write (defaults: your
  npub + the seed npub). NIP-42 write gating is on by default — only
  the station owner and whitelisted pubkeys can publish.
- **Database** — size, event count, export, wipe (with confirmation).
  Composite indexes on `(pubkey, kind, created_at)` and
  `(tag_name, tag_value, created_at)` keep tag-filter queries fast as
  the corpus grows. Bulk import / export via JSONL through the CLI:
  `nostr-station relay export <path>` and `nostr-station relay import
  <path>`.

Future events with `created_at > now + 15min` are rejected (NIP-01
clock-skew slack) so a bad client can't poison the recent-event window.

The in-process relay is intentionally minimal — a single-user dev
relay. For private group / community relays use the
[Communities](#communities--experimental-beta) panel (managed GRAIN
processes); for public-internet relays use `strfry` / `nostr-rs-relay`.

### Blossom

Local blob storage browser — an in-process Blossom server bundled with
nostr-station. Browse, preview, filter, and delete blobs stored at
`~/.nostr-station/data/blobs/`. Bulk-select + delete; wipe-all. Used
as the default Blossom target for nsite publishes from this machine,
and as a content-addressed store for any client that points at
`http://localhost:3000/blossom`.

### nostr-vpn

Optional. A peer-to-peer mesh over Nostr — connect your laptop to your
home server without port forwarding, public hostnames, or a third-party
VPN. Useful when working across machines (and required for Communities
that use Private-network mode); skip it if you only develop locally.

Six sub-tabs in the panel:

- **Status** — live peer list, tunnel IP, identity, stale-status
  banner when the daemon's view drifts from the dashboard's.
- **Network** — meshes you've joined, members, current bind.
- **Relays** — discovery-relay health, signal/coordination
  diagnostics.
- **Settings** — daemon config, **Mobile access** toggle (formerly
  in the Identity drawer) — when on, the dashboard accepts traffic
  from the mesh tunnel IP, not just loopback.
- **Service** — install / start / stop / restart, systemd / launchd
  controls. Routed through `systemctl` because the nvpn CLI doesn't
  expose `service start/stop`.
- **Diagnostics** — captures for bug reports.

The first-run wizard explicitly asks if you want nvpn with a *Skip for
now* button right next to *Install*. Default answer is Skip. Installs
are sha256-pinned and pin-bumped deliberately — current pin
`v4.0.48`+.

For deployment topologies (cloud VM vs home server vs container), how to
verify each layer of the stack, and the common failure modes, see
[docs/nvpn-deployment.md](docs/nvpn-deployment.md).

### Logs

![Logs panel — relay tab, INFO-tagged lines with ISO timestamps](https://i.nostr.build/f4Caw9ClVL2eLPCu.png)

*Logs panel on the relay channel. Lines are `[INFO]` / `[WARN]` / `[ERROR]` with ISO timestamps; auto-scroll keeps the latest line in view as the SSE stream tails.*

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
  relays. NIP-65 (kind-10002) relay list edits round-trip to the
  network on Save.
- **ngit account** — Amber bunker pairing for git operations. Connect /
  disconnect.
- **AI providers** — keychain status per provider, default for chat vs
  terminal, base URLs for custom providers. Rows are collapsible to
  keep the panel scannable; Maple AI ships as a curated provider with
  a local proxy.
- **Project AI overrides** — per-project system prompt, context overlay,
  permissions, chat-provider override.
- **Project templates** — built-in MKStack + user-added registry; full
  CRUD with self-healing of the built-in entry.
- **Watchdog** — enable / disable the heartbeat that pings the local
  relay every 5 minutes. On by default; toggle off for headless or
  CI-shared installs where you don't want extra events landing in the
  store.
- **Experimental** — opt-in toggle for **Communities** (off by
  default, gated behind a first-use acknowledgement modal that
  describes the privacy trade-offs). Future experimental features
  surface here too.
- **Editor target** — `NOSTR_STATION.md` ↔ tool-specific filename
  symlink (`CLAUDE.md`, `.cursorrules`, etc.).

![Config — Profile section](https://i.nostr.build/Xqovg8i9xPZqzglb.png)

*Config → Profile: your npub, NIP-05, follower stats, session expiry, and the "SIGNED IN VIA AMBER" badge — proof your nsec lives in Amber, not here.*

![Config — AI providers section, three providers configured](https://i.nostr.build/f1SQfyFN0bhsO3yi.png)

*Config → AI: providers list with terminal-native vs API badges. Note the "✓ key set" status — keys themselves never display; they live at `ai:<provider>` slots in the OS keychain.*

![Config — Git/ngit section, paired with Amber](https://i.nostr.build/joTRgHN8pKnXnk0B.png)

*Config → Git/ngit: GRASP server list (where your git-over-Nostr data is hosted) plus the Amber-paired signer, with re-login and logout controls.*

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

### Always-on (Linux, systemd --user)

For an Ubuntu workstation or Linux server you want to leave running —
phone client always has a reachable relay, dashboard always up — install
the user systemd unit:

```
./scripts/install-systemd-unit.sh           # uses `nostr-station` on PATH
./scripts/install-systemd-unit.sh /path/to/dist/cli.js
```

The script writes `~/.config/systemd/user/nostr-station.service`,
enables linger (so the service survives logout and reboot), and starts
the unit. Logs go to journald — view with
`journalctl --user -u nostr-station -f`.

To remove:

```
./scripts/uninstall-systemd-unit.sh                  # leaves linger alone
./scripts/uninstall-systemd-unit.sh --revoke-linger  # also revokes linger
```

The launcher detects a non-TTY stdout (which is what systemd gives you)
and skips the Ink dashboard renderer, so journald gets one clean
`Dashboard running at …` line instead of cursor-control escapes.

### Optional tools

Tools that aren't on the happy path live behind one explicit verb:

```
nostr-station list                    Show available tools + install state
nostr-station add <tool>              Install (interactive y/N confirm)
nostr-station add <tool> --yes        Install without prompting
```

Available today: `ngit` (Nostr-native git), `nak` (event/relay CLI),
`nsyte` (static-site publishing),
`grain` (Go Nostr relay — installed automatically when you enable
Communities). The wizard never asks about these — opt in when you
need each one.

### Relay event store

JSONL import / export for the in-process relay's event database.
Script-friendly, no interactive prompts.

```
nostr-station relay export <path>            Stream every event as JSONL
nostr-station relay import <path>            Ingest a JSONL file into the relay
nostr-station relay import <path> --dry-run  Count rows without writing
nostr-station relay import <path> --no-verify  Skip signature verification (trusted re-imports)
```

### Relay list (NIP-65)

Manage your kind-10002 relay list — distinct from the `relay` command,
which manages the local event database. The `s` matters.

```
nostr-station relays list                  Show local read/write lists
nostr-station relays add <wss://url>       Add (read + write, NIP-65 default)
nostr-station relays add <wss://url> --read   Mark read-only (inbox)
nostr-station relays add <wss://url> --write  Mark write-only (outbox)
nostr-station relays remove <wss://url>    Remove from both lists
nostr-station relays pull [--yes]          Fetch published kind-10002 + diff + apply
nostr-station relays publish [--yes]       Build kind-10002 + sign via bunker + broadcast
```

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

![Sign-in screen reinforcing 'nostr-station never stores your nsec'](https://i.nostr.build/dsUMnA9YxnEwJHGr.png)

*Sign-in screen: Alby browser-extension or Amber-via-bunker. The fine print is the contract — "nostr-station never stores your nsec. Signing happens in your extension, phone (Amber), or bunker service."*

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

- **Dashboard binds to `127.0.0.1` only** by default. Not reachable
  from your LAN or the internet — only programs running on your
  machine can talk to it. The optional **Mobile access** toggle (nvpn
  panel → Settings) extends the bind to the mesh tunnel IP, which
  exposes the dashboard *only* to peers on your nvpn network. The same
  toggle governs project **dev servers** spawned from the dashboard
  (`npm run dev`): loopback-only by default, bound to all interfaces
  when Mobile access is on so the chat preview pane works from mesh
  devices. Dev servers started before flipping the toggle keep their
  old binding until restarted.
- **Loopback-Host check** on every request rejects DNS-rebinding
  attacks (a malicious website tricking your browser into making
  cross-origin requests to localhost).
- **CSRF guard** — state-changing requests require a session token or
  a same-origin Referer header.
- **CSP without `unsafe-inline`** — the dashboard's Content-Security-
  Policy disallows inline scripts; all browser-side code is loaded
  from same-origin files.
- **Server-side image + WebSocket proxies** — external image URLs
  resolve through `/api/img-proxy` with HMAC-signed URLs (the HMAC
  secret is generated per-install and persisted to
  `~/.nostr-station/img-proxy-secret`, mode `0600`), and external
  relay WebSocket connections route through a server-side proxy so
  `wss://` is dropped from the page's connect-src CSP.
- **WebSocket frame cap** at 1 MiB (down from the `ws` default of
  100 MiB) — a malicious sender can't pin RAM by streaming a single
  oversized frame.
- **No `sudo` by default.** Installing optional tools that need write
  access to `/usr/local/bin` uses `sudo -n` (non-interactive) — fails
  fast with a clear "run this command in your terminal" hint if your
  sudo cred cache is empty. We never pipe `curl | sudo bash`.
- **Tool installs are sha256-pinned.** Every downloaded binary
  (`ngit`, `nak`, `nvpn`, `grain`) is verified against a pinned hash
  *before* any extraction or install step. A tampered upstream
  tarball is refused, not unpacked.
- **Atomic config-file writes** — every JSON config file the
  dashboard owns is written via temp-file + atomic rename so a
  power-loss / SIGKILL mid-write can't corrupt user state.
- **No system service files installed by default.** The dashboard is
  a foreground process; the relay is in-process. The only system
  services are nostr-vpn's `nvpn` daemon (if installed) and the
  optional `~/.config/systemd/user/nostr-station.service` you can
  enable via the always-on installer.
- **No background daemons** persist after `nostr-station stop` — Ctrl+C
  (or the stop command) tears down the dashboard, the relay, the
  watchdog, supervised GRAIN community processes, and any pty
  sessions in one go.

### Trust boundaries to be aware of

- **Local relay accepts only whitelisted signed events** on loopback
  (NIP-42 write gating is on; defaults to your npub + the seed npub,
  with the whitelist editable in the Relay panel). The relay is a
  single-user dev relay — don't expose it to a public network.
- **AI providers see your prompts.** If you pick a hosted API provider
  (Anthropic, OpenAI, etc.), your messages and project context go to
  them. Pick a local provider (Ollama, LM Studio) if that matters for
  your threat model.
- **The Terminal panel runs your shell** with your normal privileges.
  Anything you'd run in `bash` you can run there, with all the same
  consequences.
- **Communities (experimental).** Each community is a GRAIN process
  bound to an nvpn tunnel IP, never `0.0.0.0`. The dashboard refuses
  meshes with subnet routing or exit-node flags set. Still: this is
  experimental and gated off by default. Read
  [docs/communities.md](docs/communities.md) and the in-app first-use
  acknowledgement before enabling.

See `SECURITY.md` for reporting issues + the full threat model.

---

## Architecture

One Node process. The relay (NIP-01 + NIP-11, `better-sqlite3`-backed)
and the dashboard HTTP server live in the same process tree. Lifecycle
is one PID file at `~/.nostr-station/pid`. Supervised child processes
(GRAIN community relays, when enabled; the `nvpn` daemon, when
installed) inherit the lifecycle and tear down with the parent. Data:

```
~/.nostr-station/
├── pid                          Dashboard PID (used by `nostr-station stop`)
├── data/relay.db                Local relay's SQLite event store
│                                (events + tags + materialized
│                                 profiles + FTS5 events_fts)
├── data/blobs/                  In-process Blossom store
├── bunker-client.json           Saved NIP-46 pairing for silent re-auth
├── ai-config.json               Provider config + per-surface defaults
├── communities-feature.json     Experimental-feature gate + acknowledgement
├── communities/<id>/            Per-community state (only when enabled)
│   ├── community.json           nostr-station-owned manifest
│   ├── config.yml               GRAIN config
│   ├── whitelist.yml            Pubkey allowlist
│   ├── blacklist.yml            Pubkey + word denylist
│   ├── data/                    GRAIN's LMDB datastore
│   └── grain.pid                Supervisor's PID record
└── bin/grain                    Managed GRAIN binary (when installed)

~/.config/nostr-station/
├── identity.json                npub, read relays, setupComplete
├── chat.pid                     Dashboard pid (alternate path)
└── secrets                      Encrypted keychain (Linux fallback)

~/nostr-station/                 Source clone (when installed via curl)
└── projects/                    Default projects directory
```

Why pure Node: install is one curl command. No Docker, no signed-binary
distribution, no Rust toolchain, no Apple Developer account. The
in-process relay is intentionally minimal — it's a single-user local
dev relay, not a production-grade deployment. The production-relay
answer is the **Communities** feature: managed GRAIN child processes,
one per community, each on its own port and nvpn mesh, with NIP-86
admin.

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

For the Communities subsystem (GRAIN supervisor, NIP-86 admin client,
per-community state model), see
[docs/communities.md](docs/communities.md).

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
