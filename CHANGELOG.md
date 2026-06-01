# Changelog

All notable changes to nostr-station are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### nostr-vpn: canonical-config foundation (b2 stage 1 of 4)

First, behavior-preserving step toward a single authoritative nvpn config —
the one the daemon actually runs — with the dashboard reading/writing it
directly (via sudo when root-owned), so there's never a second identity to
reconcile and no private key is ever copied. This stage adds the machinery
without flipping any call site yet:

- `chooseCanonicalConfigPath` (pure, unit-tested) — decides which config is
  authoritative: the daemon's live `--config` path when it exists, else the
  user-side path, else none.
- `resolveCanonicalConfig` — wraps it with existence + ownership detection
  (`pathIsForeignOwned`). Stage 1 still defaults to the user-side path, so
  behavior is unchanged.
- `readConfigText` / `writeConfigText` — ownership-aware primitives: direct
  fs when we own the file, `sudo -n` (atomic `install -m 600` from stdin,
  with backup) when root-owned. Mirrors the adopt/repair write discipline;
  secret-bearing bodies are only ever used as fs/stdin input, never returned.

No call sites switched (the 11 existing config readers/writers are
untouched) — later stages route reads, then writes, then the installer
through these, and retire the create-then-heal reconcile layer. Synthetic
test data; full suite 1553 pass.

### nostr-vpn: installer reconciles to a single identity (prevention)

The prevention half of the identity-split fix (the adopt flow is the cure
for already-split boxes; this stops new ones). `nvpn service install` runs
`nvpn init` as root, minting a separate root identity at
`/root/.config/nvpn/` — distinct from the dashboard user's managed identity.
That's the split at the source, and it would also regress a 1.6-adopted box
on the next install/upgrade.

Now, right after a successful `service install` (and `service install
--force` on upgrades), the installer runs a best-effort reconcile: when the
dashboard user already has a managed identity (paired / joined), it makes
the freshly-installed daemon run **that** identity (via the same backup →
sudo-write → restart the adopt flow uses), so the daemon's config and the
dashboard's config never diverge. It's quiet and safe — no managed identity
yet (fresh install, not paired) → it no-ops; identities already aligned →
no-op; sudo is warm from the install step. The whole thing only logs to the
install log; the install result is unchanged.

New: `reconcileDaemonIdentityAfterInstall` + pure gate
`shouldReconcileAfterInstall` (unit-tested), wired into both install paths
in `nvpn-installer.ts`. Nothing hardcoded.

### nostr-vpn: adopt identity — make the daemon run the managed identity

The load-bearing fix for the dashboard/daemon split. Until the daemon runs
the identity the dashboard manages, every control (join, repair, relay
edits) writes a config the daemon never reads — the dashboard is cosmetic.
"Adopt" makes the running daemon use the dashboard-managed identity + config.

Surfaced as **"Make the daemon use this identity"** on the diagnosis when an
identity split is detected. It:

- **Previews first** — shows the daemon's current npub → your managed npub
  and the 3 steps (back up daemon config, copy managed config onto the
  daemon's resolved `--config` path, restart). No write until you confirm.
- **Backs up** the daemon's current config (`sudo cp -p` to `<path>.bak-<ts>`)
  before overwriting, so the prior identity is recoverable.
- **Writes atomically with the correct ownership for a secret-bearing file**
  — `sudo -n install -o root -g root -m 600` from the managed config's body
  via stdin. The managed config contains the private key, so it's never
  returned through the API or logged; only the two (public) npubs and paths
  are surfaced. Empty sudo cred cache → clear "run `sudo -v` then retry"
  hint, and nothing is changed (or only the backup, never a half-write).
- **Restarts** nvpn so the daemon comes up on the adopted identity.

New: pure decision core `decideAdoptIdentity` (unit-tested), `planAdoptIdentity`
/ `adoptIdentity` (`nvpn.ts`), route `POST /api/nvpn/identity/adopt`
(`{ apply }`), and the preview→confirm→restart UI. Verified end-to-end by
hand on a live VM (managed identity adopted → tunnel landed on the correct
deterministic IP, mesh converged). Nothing hardcoded — paths/identities are
all resolved live.

### nostr-vpn: identity-aware diagnosis (dashboard vs daemon split)

The deepest cause of "nothing connects" on a service install: the dashboard
runs as the user and edits `~/.config/nvpn/config.toml`, but the daemon runs
as a root `--service` off `/root/.config/nvpn/config.toml` — and that root
config can be a **completely different nvpn identity** (its own keypair),
auto-minted when the service was installed. So every join / repair / relay
edit lands in a config the daemon never reads, against an identity that
isn't even the same node. The diagnosis was splicing the managed identity
onto the daemon's state.

The Connectivity diagnosis now tells the truth:

- Resolves the daemon's **real** config path from live evidence only — its
  own `--config` argument (read from `/proc/<pid>/cmdline`, world-readable
  even for a root process), falling back to the systemd unit's `ExecStart`.
  Nothing hardcoded.
- Reads the daemon's identity from that path (leak-safe: only the `[nostr]
  public_key` is ever extracted; falls back to `sudo -n cat` when the file
  is root-owned, degrades quietly on an empty sudo cred cache).
- New **identity-split** finding (top priority) when the daemon's npub
  differs from the managed one — it explains *why* dashboard changes don't
  reach the daemon, and suppresses the now-meaningless cross-identity
  network findings. Evidence shows both identities + both config paths. The
  config-repair button is hidden in this state (it wouldn't reach the
  daemon); identity adoption is the fix (next).

New pure helper `parseConfigPathFromCmdline` + `resolveDaemonConfigPath` /
`readNodeNpubFromPath` (`nvpn.ts`), `identitySplit` in the diagnosis, and
`managedNpub`/`daemonNpub` plumbed through the route. All read-only.

### nostr-vpn: prevent + repair forked / non-canonical networks

Follow-up to the connectivity diagnosis: stop the forked-network bug from
happening, and fix configs that already have it.

- **Prevent (Join by ID).** Joins now store the **canonical** (separator-
  free) network id, and dedupe against existing networks by canonical form.
  A hyphenated id like `abcd-1234` can no longer be written as a second copy
  of `abcd1234` — new forks are impossible.
- **Repair (Diagnostics → "Repair network config").** When the diagnosis
  finds a forked duplicate or a non-canonical active id, a repair action
  collapses each forked group to a single canonical survivor (keeping the
  most-populated roster + unioned relays), makes the active network's
  survivor first, and re-pins a stale `tunnel_ip` to the deterministic
  value. The re-pin targets `[node].tunnel_ip` (verified on hardware to be
  where nvpn persists the node IP — the `[[networks]]` blocks carry only
  `network_id`), rewriting only that line and never the `[node]`
  private-key fields. It's config hygiene: the daemon re-derives the live
  interface IP from the canonical id on Restart, so the de-fork + Restart
  is the load-bearing fix; the re-pin just stops config.toml showing a
  wrong IP.

  It is **preview-first**: the dry-run returns the exact plan (blocks to
  remove, id rewrite, old→new IP) with no write; only an explicit confirm
  applies it. Before any write it **backs up** `config.toml` to
  `config.toml.bak-<ts>` and writes atomically (temp + rename); it **bails**
  if the backup fails. It never reloads/restarts — a network-identity change
  needs a full **Restart** (brief interface drop), which the UI states up
  front and offers inline after applying.

  New pure planner `planNvpnRepair` + `repairNvpnNetworkConfig`
  (unit-tested against synthetic forked configs), route
  `POST /api/nvpn/networks/repair` (`{ apply }`), and the preview→confirm→
  restart UI. `joinNvpnNetwork` now canonicalizes on write.

### nostr-vpn: connectivity diagnosis — turn "0 online" into a reason

A NATed/containerized station node (OrbStack VM, Docker, …) often sits at
"0 peers online" with no surfaced cause. nvpn fails quietly: a node on the
wrong network, a node behind NAT with no relay neighbour, and a healthy-but-
lonely node all read identically. New **Connectivity diagnosis** panel at
the top of the nostr-vpn → Diagnostics tab names the actual reason. It's
read-only (one status probe + config.toml reads, no external calls), so it
auto-runs on every visit.

Signals, all computed from data we already have:

- **Wrong-network detection (the headline).** Per nvpn's protocol doc — and
  verified against four live nodes — a node's mesh IP is deterministic:
  `10.44.(SHA256(network_id + "\n" + pubkey_hex)[0]%254+1).(…[1]%254+1)`, no
  admin IPAM. So if the live tunnel IP doesn't match the IP computed for the
  *active* network, the node is almost always running a different network
  than its config claims (the "separate network instead of joining" failure,
  which shows up as one npub holding three different IPs across config /
  interface / roster). We compare the daemon-reported network id against the
  active one, and compute the expected IP for every configured network to
  report which one the live IP actually belongs to.
- **Forked / non-canonical network id.** The daemon hashes the stored id
  *literally*, so an id that picked up a separator (`abcd-1234` vs the
  canonical `abcd1234`) derives the wrong IP and never converges — and two
  records that canonicalize equal are a forked duplicate of one mesh. The
  diagnosis canonicalizes before computing the expected IP, flags the
  non-canonical id (showing the correct one + IP), and flags forked
  duplicates — the actual root cause behind the "three different IPs" symptom.
- **Behind-NAT-with-no-relay.** nvpn relays through a reachable FIPS
  neighbour when direct UDP is blocked — but only if one exists. A node
  advertising a private endpoint (`192.168.x`) with no `[fips_peer_endpoints]`
  configured and 0 peers online is flagged with the remediation: point at a
  reachable mesh node as a relay, or run one with a public/forwarded
  endpoint. (nostr-station can surface this and make adding a relay peer
  easy; it can't *be* the public relay — that stays an upstream/infra
  concern.)
- **Solo roster.** A roster with only your node usually means a join didn't
  adopt the admin's network — points at Join-by-ID with the exact id.

Each finding carries a level + a "what to do" line; an **evidence**
disclosure shows the underlying values (active vs daemon network, expected
vs live IP, advertised endpoint, roster/online counts, configured relay
peers). New pure helpers `computeNvpnTunnelIp` / `diagnoseNvpnNetwork`
(unit-tested), config reader `readNvpnFipsPeerEndpoints`, and route
`GET /api/nvpn/network-diagnosis`.

### nostr-vpn panel: copyable npub, join-by-ID, in-dashboard relay editing

UX pass on the nostr-vpn panel, driven by three reported pain points: the
node's own npub couldn't be copied, joining a network you already run
elsewhere didn't work, and several buttons threw API errors.

- **Your node npub is now copyable.** nvpn 4.x dropped `npub` from
  `status --json`, so the panel's only copy of it was a truncated,
  copy-less badge in the status strip. The full value now carries a copy
  button in the **status strip**, a dedicated **"this node (npub)"** row in
  the **Network** tab (the place you reach for when adding this station to a
  mesh), and the **Status** tab's npub row now falls back to the
  config-derived identity instead of vanishing on modern daemons.
- **Join a network by ID — no invite.** New **Join by ID** action on the
  Network tab mirrors the native nvpn app's manual join: enter the
  network id of a mesh you already run and it's added + activated by
  writing a `[[networks]]` block to config.toml (seeded with the active
  network's discovery relays, or the recommended set) and reloading the
  daemon, which then converges on the admin-signed roster on its own. The
  Import-invite modal now also explains the invite must be an
  `nvpn://invite/…` minted by an admin of the target network, and points
  at Join-by-ID / copy-this-npub as alternatives.
- **Relay editing works again, and no more buttons that always 501.**
  nvpn 4.x removed the bulk `set --relay` CLI; rather than 501, the
  add / remove / Use-recommended actions now edit config.toml's active
  `[[networks]] relays = […]` directly (server-side, atomic temp-file +
  rename) and reload the daemon — the same path the native app takes.
  Relay rows still surface publish-health from the in-process aggregator.
  The **Diagnostics** tab drops the dead **Run netcheck** and **Show
  stats** buttons (both removed in 4.x; `doctor` covers netcheck's old
  ground), and the Logs panel's 504-loop hint now routes to the Relays tab.

  New lib surface (all unit-tested): `joinNvpnNetwork` +
  `isValidNetworkId` / `buildNvpnNetworkBlock` / `insertNetworkBlockFirst`,
  and real `addNvpnRelay` / `removeNvpnRelay` / `setNvpnRelays` backed by
  `rebuildTomlWithRelays`. New routes: `POST /api/nvpn/networks/join`, and
  `POST /api/nvpn/relays/{add,remove,set}` now mutate config + reload
  (200 on success, 400 on bad/duplicate input) instead of returning 501.

### nvpn pin bump 4.0.37 → 4.0.48

Tracks the upstream 4.0.x line forward. Existing users see the upgrade as
an `nvpn` row in the dashboard's Updates modal (installed `< 4.0.48`), and
applying it streams through the usual force-install path — download +
sha256-verify the new tarball, `install-cli --force` to swap the on-PATH
binary, `service install --force` to repoint the systemd/launchd unit, then
a restart hint. Fresh installs pick up 4.0.48 directly.

- `versions.ts` — `nvpn` pin `4.0.37` → `4.0.48`; all three pinned-target
  sha256 digests refreshed (`aarch64-apple-darwin`,
  `aarch64-unknown-linux-musl`, `x86_64-unknown-linux-musl`). Verified
  against the published GitHub release asset digests.
- No CLI-surface changes across 4.0.38–4.0.48 — `init`, `service install`,
  `install-cli`, `start`, and `status --json` are unchanged, so no call
  sites in `nvpn.ts` / installer need touching. The one in-band change is
  nvpn's own config-secret migration to sidecar files (4.0.40), which the
  daemon performs itself on first start of the new binary.
- Heads-up for a future bump: 4.0.48 ships nvpn's own secure
  (hashtree/Nostr/Blossom) self-updater. If that becomes the default update
  channel, the installed binary's version could drift ahead of our pin
  on its own — worth deciding whether we keep driving updates via the pin
  or step back and let nvpn self-update.

### Projects: publish wizard moves to Overview (review-then-announce)

The first-publish ngit wizard used to take over the **Code** tab for any
not-yet-published project — which meant you couldn't browse the repo's
files, README, or commit history before announcing it. The wizard now lives
on the **Overview** tab instead:

- **Code always shows the file browser / commits**, even pre-publish, so
  you can review what you're about to announce. It only short-circuits when
  there's genuinely no git repo on disk yet, with a small note pointing to
  Overview.
- **Overview renders the publish wizard inline** (below the summary) for
  projects that have a path but no ngit remote yet — including the
  "Initialize git" path for projects with no repo. Publishing from here
  swaps the wizard for the operational ngit block + About metadata, same as
  before.

### Projects: badge accuracy + scan-clone polish (follow-up fixes)

Three fixes from testing the onboarding flow:

- **Scan-cloned ngit repos no longer show a spurious `git` badge.** A
  NIP-34 `clone` tag usually carries the GRASP server's own HTTP transport
  (`https://git.shakespeare.diy/…`, `relay.ngit.dev`) rather than a
  separate GitHub/GitLab origin. The Discover → Add-to-projects prefill now
  compares each clone URL's host against the GRASP servers we actually
  queried (`res.queried`) and only lights the `git` capability for a clone
  URL whose host is *not* a GRASP host. A pure-ngit repo shows just `ngit`,
  as expected (`app.js`).
- **Template scaffolds no longer record the template's upstream as their
  git remote.** A New local project scaffolded from MKStack used to carry
  `gitlab.com/soapbox-pub/mkstack.git` as its recorded GitHub remote — the
  template *source*, never a remote you'd push to. `freshenGitRepo` already
  wipes the on-disk remote; now a template scaffold (templateId set) also
  records no remote and no `git` capability, landing as a local-only git
  repo — same "publish to ngit when ready" model as a blank project. A
  direct git-url *import* (no templateId) still records its source for
  reference (`project-scaffold.ts`).
- **Long `nostr://` clone URLs wrap inside the scan-clone box** instead of
  pushing it off the drawer's right edge (`app.css`).

### Projects: smoother "get rolling" UX — scan-clone defaults + starter moves to New project

Two related UX passes on the project-onboarding flow, both aimed at
fewer decisions between "I want a project" and "I'm coding."

**Scan → Add to projects lands you faster** (`src/web/app.js`,
`src/web/app.css`). When the Add Project drawer is seeded from a scanned
ngit repo, the first step used to lead with an empty "Local path" field +
a generic Continue button — reading as a required chore even though the
server owns the clone target (`~/projects/<name>`, constructed in
`routes/ngit.ts`). Now:
- The **"Clone this repo"** CTA leads; the manual path controls move
  behind an *"or use an existing local path"* disclosure (still there for
  adopting an on-disk folder, invisible otherwise).
- The chosen destination shows as a quiet `~/projects/<name>` preview so
  the path reads as pre-decided, not a prompt.
- After a successful clone the drawer **jumps to the final review + "Add
  project" step** instead of parking back on Step 1 with three
  already-answered Continues — steps 1–3 collapse into done-summaries with
  edit links.

**Starter templates move from Import → New local project.** A starter is
a "create something new" concept, not an "import an existing repo" one, so
MKStack now lives where new projects are born:
- New local project gains a **Starter** picker defaulting to **MKStack**
  ("recommended"), with **Blank — folder + README, no git** as the
  offline-friendly second option. Picking a starter sends `templateId` to
  the existing `/api/projects/new` (server resolves the git-url source,
  wipes inherited history, seeds project-context + dev environment); Blank
  keeps the original `local-only` path. No backend change.
- The Import modal's template picker is **removed** — Import is now purely
  "clone a repo that already exists at a URL (ngit or git)."
- **Scaffolded Node projects auto-install dependencies** (`npm install`,
  `project-scaffold.ts`). Any project scaffolded with a `package.json` —
  MKStack and any other Node-based git-url template/import — now runs
  `npm install` as a streamed step in the create modal, so the user lands
  on a project that's ready to `npm run dev` / open in AI with one click
  instead of hitting a missing-`node_modules` error on first run. Gated on
  `package.json` presence, so blank local-only projects skip it. Non-fatal:
  a failed install (or `npm` not on PATH) still leaves a fully registered
  project with a clear "run npm install to finish setup" warning rather
  than discarding the user's work.
- After creating a project the user **lands on the Projects list** (not
  the detail view) so the new card appears among their projects — a subtle
  confirmation, with Open-in-AI / terminal / open-detail affordances right
  there. This now applies consistently across **all** creation paths —
  New local, Import (ngit + git-url), and scan-clone — so they no longer
  diverge on where you end up.

git stays a co-equal capability; the adopt-existing-folder, Import-by-URL,
and Browse/scratch flows are untouched.

### grain 0.6.0 → 0.7.0 — version-pin bump + upgrade-detection path

Upstream's [v0.7.0](https://github.com/0ceanSlim/grain/releases/tag/v0.7.0)
adds a web `/admin` dashboard, NIP-86/98 served by default, and gift-wrap-DM
recipient scoping. nostrdb format is unchanged and the new endpoints are
additive — for the supervisor it's a transparent swap. Two things did need
work to make the upgrade roll out cleanly:

**Pinned-binary update path** (`src/lib/grain-installer.ts`,
`src/lib/tool-updates.ts`):
- The installer now writes a sibling marker file
  (`~/.nostr-station/bin/grain.version`) recording the installed semver.
  grain ships without a `--version` flag, so the marker is the only way
  to tell what's on disk — the runtime-probe pattern nak/ngit/nvpn share
  doesn't apply.
- `gatherToolUpdates` now includes a grain row, computed from
  `(binary present?) × (marker matches pinned?)`. The "binary present,
  marker absent" case (every existing v0.6.0 install) maps to
  `currentVersion:null + updateAvailable:true`, which surfaces the
  upgrade in the existing Updates modal without any new UI.
- The installer's "already installed — skip" short-circuit was rewritten
  to require BOTH the binary AND a matching marker. Previously a fresh
  install request on a v0.6.0 box would no-op forever; now it falls
  through and reinstalls when the marker doesn't match the pin.
- Marker write failure (rare: requires a read-only `~/.nostr-station/bin`,
  which we own) now surfaces a warn-shaped install result with an
  actionable detail string instead of silently logging. Without this,
  a persistent failure would re-offer the upgrade every poll and the
  user would have no signal explaining why their "successful" upgrade
  kept coming back. The new failure path tells them exactly which
  directory to check, then transient I/O hiccups self-heal on retry.

**Homepage Status row for grain** (`src/commands/Status.tsx`,
`src/web/app.js`):
- Row value now reads `grain <version>` (e.g. `grain 0.7.0`) instead of
  bare `installed`, sourced from the new marker file so the homepage
  card matches the rendering style of every other binary row (ngit /
  nak / claude / opencode / stacks). Pre-marker installs fall back to
  `installed` for one upgrade cycle, then take on the version once the
  user clicks Update.
- Added a `SERVICE_DETAILS.grain` entry so the expanded row carries a
  summary + an `Open Communities →` panel link. There's no row-level
  Start/Stop button by design: grain runs once per community
  (community-process.ts), not as a singleton, so lifecycle ops belong
  on the Communities panel where each instance has its own state +
  log buffer. The summary explains this so the row doesn't read as
  "missing controls."

**Spawn-time config migration** (`src/lib/community-yaml.ts`,
`src/lib/community-process.ts`):
- 0.7.0 renamed `backup_relay.url: <str>` → `backup_relay.urls: [<str>]`.
  Default configs we write never set the field, but a user who hand-
  edited their `config.yml` to mirror to an upstream relay would see
  GRAIN refuse to start on the new schema.
- New `coerceGrainBackupRelay()` helper handles every shape we've seen
  (`url: <str>`, `url: ""`, `url: [<str>, <str>]`) and refuses to
  migrate unrecognized shapes (so a typo fails loud rather than getting
  silently rewritten to nonsense). The supervisor calls it alongside
  the existing `server.port` coercion in `spawnChild` — single atomic
  write per spawn when anything actually changed, no rewrite when the
  config is already in 0.7.0 shape (idempotent — won't churn mtime on
  every restart).

**SHA256 digests** for v0.7.0 were pulled from upstream's `checksums.txt`
and pinned in `src/lib/versions.ts`. Asset naming
(`grain-{os}-{arch}.tar.gz`) is unchanged, so the installer's URL
construction needed no edits.

**Confirmed non-issues from the v0.7.0 release notes:**
- `GRAIN_OWNER_PUBKEY`: required only by the new `/admin` UI, not by
  startup. The supervisor drives admin via NIP-86 in
  `src/lib/community-admin.ts`, so we don't set the var and grain still
  boots fine without it.
- Gift-wrap DM scoping (kind 1059 served only to recipients): pure
  upstream behavior change; the supervisor doesn't care.
- New `/admin` + `/setup` endpoints: additive, served by grain itself
  on the community port. We don't proxy them (the dashboard's own
  communities surface is the user's entry point), so no conflict.

### nvpn 4.x — P0 silent-landmine hotfix

> Followup to the 4.0.37 pin bump below. Live VM validation of that PR surfaced
> three classes of silent failure the sandbox audit couldn't catch:
>
> 1. `nvpn status --json` falls back to a config snapshot when the CLI can't
>    reach the daemon (typically a $HOME / --config dir mismatch under sudo).
>    The fallback is HTTP-200 with every live field nulled — the dashboard
>    used to render "everything zero" with no warning.
> 2. Identity (`npub` / `pubkey`) was removed from status JSON; the local
>    pubkey only lives in `~/.config/nvpn/config.toml`'s `[nostr]` block.
> 3. The previous PR removed `/api/nvpn/roster/publish` on the premise that
>    `--publish` made it redundant. Live data showed `published_recipients:
>    0` is a common outcome (relay timeouts, WoT/POW gates), and users had
>    no retry path. That premise was wrong.

**Status route gates the silent fallback** (`src/lib/routes/nvpn.ts` status
handler, `src/lib/nvpn.ts` `probeNvpnStatusUncached`):
- `NvpnStatus` now carries `statusSource` from the new 4.x `status_source` field.
- When `status_source !== "daemon"`, `running` is force-flipped to false so the
  dashboard doesn't paint a "running" pill on top of stale data.
- The status route adds a top-level `stale: { reason, source, detail }` warning
  to the response so the UI can surface a banner explaining *why* the data is
  unreliable, not just *that* something is off.

**`--config <path>` threaded through every CLI invocation** (`src/lib/nvpn.ts`
`buildNvpnArgs` helper). Mostly defensive — nostr-station runs as the user
who installed nvpn so the default lookup works — but anything that ever
shells out via sudo or with a mismatched $HOME would otherwise drop into the
config-snapshot fallback. Covers: `status`, `service status`, `stop`,
`pause`, `resume`, `reload`, `repair-network`, `ping`, `doctor`,
`create-invite`, `import-invite`, `whois`, `set`, `add-participant`,
`remove-participant`, `add-admin`, `remove-admin`.

**Identity helper that's leak-safe** (`src/lib/nvpn.ts`
`readNvpnNodeIdentity`):
- New helper reads `[nostr] public_key` from config.toml — the ONE place
  4.x stashes the local node's npub. Same file holds `[nostr] secret_key`
  and `[node] private_key`; the helper's strict bech32 regex and
  section-scoped extraction guarantee neither field can be returned.
- Spliced into `/api/nvpn/status` as `identity.npub` so the dashboard has
  a single source for identity display.
- New unit test (`tests/nvpn-identity.test.ts`, 8 cases) pins the
  leak-safe shape: result has exactly `{ npub, configPath }` keys, and a
  serialized round-trip asserts no `nsec1`, no WireGuard private-key
  bytes, no `[node] public_key` confusion appears anywhere in the
  output even when fed a config with all three.

**`/api/nvpn/roster/publish` restored** (flipped 501 → 200 in
`src/lib/routes/nvpn.ts`; `src/lib/nvpn.ts` `publishRoster()`
re-implemented). Now triggers a republish by re-adding an existing admin
(or, if no admins, the first participant) with `--publish`. That's a no-op
on the roster but exercises the publish path, so the dashboard's "Publish
roster" button works again. Response includes `publishedRecipients` so the
UI can render the recipient count honestly (yellow when 0, green when ≥1
— UI hook lands in P1).

Retracts this claim from the 4.0.37 PR's CHANGELOG entry:

> ~~`POST /api/nvpn/roster/publish` — `nvpn publish-roster` was removed;
> every roster mutation now broadcasts inline via the `--publish` flag~~

The replacement mechanism still works, but it's not a substitute for a
manual republish action — that affordance is back.

### nvpn 4.x — installer hardening for the update path

> P2 followup to PR #154 (the 4.0.37 pin bump). The PR-#154 walkthrough
> revealed three installer rough edges that turned the "click Update" path
> into a manual recovery exercise:
>
> 1. `sudo -n nvpn install-cli` silently failed (empty cred cache) but
>    the installer returned `ok: true` anyway, leaving the user with the
>    new binary in `~/.cargo/bin/nvpn` but stale `/usr/local/bin/nvpn` —
>    `which nvpn` kept resolving to the old version.
> 2. Upstream 4.x's `install-cli` refuses to overwrite an existing
>    binary without `--force`. We weren't passing it, so the relocate
>    silently no-op'd whenever a prior install existed.
> 3. The force-update path skipped `service install` entirely. The
>    systemd unit's ExecStart kept pointing at the original install
>    location (typically `~/.cargo/bin/nvpn`), surviving until cargo
>    bin gets cleaned, then breaking the daemon.

**Fixes** (`src/lib/nvpn-installer.ts`):

- `install-cli` is now invoked with `--force` on the upgrade path
  (`opts.force === true`). First-install paths still pass through
  without the flag — harmless since there's no existing binary to
  overwrite.
- A failed `install-cli` no longer returns `ok: true` silently. Sets
  `warn: true` on the result with the actual stderr in `detail` and an
  explicit remediation command. Dashboard renders this as yellow with
  the next step inline.
- Force-update path now also runs `sudo -n nvpn service install --force`
  so the systemd unit / launchd plist is rewritten with the canonical
  PATH location of the new binary. Best-effort: if sudo fails, the warn
  flag fires with both remediation commands stitched together.

Net effect: clicking Update in the dashboard now either fully completes
the upgrade (binary swapped + relocated + unit refreshed) or surfaces a
yellow "run these two commands" hint, instead of silently leaving the
install in a half-finished state.

### nvpn 4.0.37 — upstream major-version bump + breaking CLI changes

> **Upstream major.** `mmalmi/nostr-vpn` cut v4.0.0 on 2026-05-07 with a
> FIPS-mesh redesign (native shells replacing Tauri, shared app-core
> state/action contract) and then iterated to v4.0.37 by 2026-05-18. We
> were pinned to v0.3.12 — a 25-release lag across ~6 weeks. The bump
> lands as a single PR alongside the CLI-compat fences below; UI parity
> work for newly-exposed features (exit-node leak protection, per-relay
> enable/disable, service-version mismatch banner, unnamed-peer DNS
> hint) is deferred to follow-ups.

**Bumped:**
- `versions.ts` — `nvpn` pin `0.3.12` → `4.0.37`
- `BINARY_SHA256.nvpn` — rotated all three pinned target digests

**Breaking-but-fenced upstream removals.** Each surfaces as a `501 Not
Implemented` response with a clear `detail` string explaining the
removal and pointing at the replacement (where one exists). The
endpoints stay wired so dashboards / scripts get a recognizable signal
instead of a generic 500:

- `POST /api/nvpn/roster/publish` — `nvpn publish-roster` was removed;
  every roster mutation now broadcasts inline via the `--publish` flag
  (already the default on `/api/nvpn/peers/{add,remove}` and
  `/api/nvpn/admins/{add,remove}`).
- `GET /api/nvpn/netcheck` — `nvpn netcheck` was folded into
  `nvpn doctor --json`. Use `POST /api/nvpn/doctor` for the same
  coverage.
- `POST /api/nvpn/nat-discover` — replaced by the daemon's built-in
  periodic STUN discovery. The result surfaces in `status --json` under
  `public_endpoint` / `nat.public_endpoint`.
- `GET /api/nvpn/stats` — `nvpn stats` and the underlying
  `relay-for-others` mode were dropped from the FIPS mesh redesign.
- `POST /api/nvpn/relays/{add,remove,set}` — `nvpn set --relay` (bulk
  replacement) and the per-relay CLI never landed in 4.x; the native
  app is the only writer upstream supports. `GET /api/nvpn/relays`
  still reads from `config.toml` and is unaffected.

**`nvpn set` allowlist changes:**
- Removed: `magic-dns-port` (daemon picks automatically),
  `relay-for-others`, `provide-nat-assist` (entire relay-operator
  feature class is gone).
- Added: `exit-node-leak-protection` (new in upstream v4.0.1 — blocks
  internet traffic while a selected exit-node is unreachable; settable
  as `true` / `false`). UI exposure is a follow-up.

**Install-flow fixes:**
- `nvpn init --yes` → `nvpn init --force` (upstream rename). Stdin-
  newline fallback retained for transitional installs.
- `seedFreeMagicDnsPort()` is now a no-op stub — the underlying setting
  is gone. The installer still calls it for log-symmetry; it returns
  `skipped (nvpn 4.x picks magic-dns-port automatically)`.

**Behavioural changes worth flagging to users** (documented in
`docs/nvpn-deployment.md` — no code change required):
- **Exit-node leak protection** (v4.0.1): if a user configures an
  exit-node that's unreachable, the host loses internet until it
  reconnects or the setting is cleared. Headless servers should leave
  exit-node unset.
- **MagicDNS aliases** (v4.0.29): roster members without a `.nvpn`
  name no longer get auto-generated DNS aliases. Set names via the
  `[peer_aliases]` config block (or via the dashboard's alias button)
  if you want resolution.

**Rollback contract.** Reverting `versions.ts` to `0.3.12` plus its
prior `BINARY_SHA256.nvpn` digests is sufficient — the installer's
hard-fail-on-mismatch contract means a stale 4.0.37 binary on a user's
machine won't be silently kept; the next Install action re-downloads
and verifies against the rolled-back digests.

### Architectural simplification (six-step rewrite)

> **Major.** nostr-station is now a single Node process with an in-process
> Nostr relay. No Docker, no Rust toolchain, no LaunchAgent / systemd, no
> mesh VPN, no Ink TUI wizard. Install is one curl command and ~10 seconds.
> All host-install and Docker-stack code paths were deleted. ~10,400 lines
> of legacy infra removed; codebase shrunk by roughly half.

The user-journey spec — pair Amber with one QR, verify the signing
pipeline live, then dashboard — is now the only first-run flow. The
six commits, in order:

- **`feat(relay)`: in-process Nostr relay behind `STATION_INPROC_RELAY=1`.**
  New `src/relay/` module — NIP-01 protocol over WebSocket, NIP-11 over
  HTTP, `better-sqlite3` event store with replaceable / parameterized-
  replaceable handling, indexed tag table, max-events eviction. Lazy-imported
  by the dashboard so the legacy Docker path is unaffected when the flag
  is off. 23 new tests covering filter logic, store, and protocol.
- **`feat(relay)`: make in-process relay the default.** Boots automatically
  unless `STATION_MODE=container` (sibling Docker relay) or
  `STATION_INPROC_RELAY=0` (explicit opt-out). `RELAY_HOST` / `RELAY_PORT`
  env vars are auto-populated so `nostr-station status` and the dashboard's
  service panel find the new relay on `:7777`. `auth.inprocRelay` flag added
  to `/api/auth/status` so the wizard knows to skip the legacy relay-install
  stage.
- **`feat(install)`: strip Docker out of `install.sh`.** New 70-line
  installer: detect macOS / Linux, install Node 22+ via nvm if missing,
  `npm install -g nostr-station`, `exec nostr-station`. No Docker check,
  no compose-asset copy, no `sudo`, no `apt-get`, no `brew`, no `cargo`.
  CLI verbs collapsed: bare invocation + `start` + `up` all render the
  Chat component (which boots the dashboard + in-process relay);
  `stop` / `down` SIGTERM via PID file; `ps` removed (use `status`).
- **`feat(setup)`: Amber QR pairing + live verification stage.** First-run
  `/setup` wizard now uses `STAGES_INPROC = [welcome, amber, verify, ai,
  ngit, done]`. The amber stage shows ONE full-screen QR — the
  nostr-connect URI — and polls for the bunker handshake. On connect:
  captures user pubkey via `signer.getPublicKey()`, encodes to npub,
  writes `identity.json`, persists the bunker client for silent
  re-auth. The verify stage runs an end-to-end pipeline test: sign a
  kind-1 event via Amber (second tap), publish over WS to the
  in-process relay, REQ-replay to read it back, return a step-by-step
  result. New endpoints: `POST /api/setup/amber/start`,
  `GET /api/setup/amber/session/:eph`, `POST /api/setup/verify`. New
  generic helper `signEventWithSavedBunker(template)` in
  `auth-bunker.ts` is the building block for ngit / nsite signing too.
- **`refactor`: delete the host-install / Docker-stack legacy infra.**
  Removed: `Dockerfile.relay`, `Dockerfile.station`, `docker-compose.yml`,
  `docker/`, `.dockerignore`, `CONTAINER.md`, `src/onboard/` (legacy Ink TUI
  wizard, ~1,300 LoC), nine legacy CLI commands (Doctor / Tui / Uninstall /
  Update / UpdateWizard / Watchdog / Logs / Relay / RelayConfig), eight
  legacy lib modules (`install.ts`, `services.ts`, `verify.ts`,
  `relay-config.ts`, `launcher.ts`, `watchdog.ts`, `checksum.ts`,
  `install-log.ts`), and ~1,500 LoC of container-mode + host-install tests.
  `src/lib/web-server.ts` lost ~660 lines: `relayAction`,
  `serveRelayConfig`, `streamLogs`, `exportRelayEvents`, the
  ServiceHealth / log-tail apparatus, and ten dead route handlers
  (`/api/relay-config`, `/api/relay/{start,stop,restart}`,
  `/api/relay/whitelist/{add,remove}`, `/api/relay/database/{stats,wipe,export}`,
  `/api/setup/relay/install`, `/api/setup/nvpn/install`, `/api/exec/:cmd`,
  `/api/installed`, `/api/logs/:service`). Reusable Ink components
  (`palette.ts`, `Select.tsx`, `Prompt.tsx`, `Step.tsx`) moved from
  `src/onboard/components/` to `src/cli-ui/`. Editor helpers
  (`EDITOR_FILENAMES`, `symlinkEditorFile`, `extractUserRegion`) extracted
  from the deleted `services.ts` to a new minimal `src/lib/editor.ts`.
  `hexToNpub` / `npubToHex` moved to `identity.ts` from the deleted
  `relay-config.ts`. **67 files changed, 112 insertions, 10,527 deletions.**
- **`feat(add)`: `nostr-station add <tool>` — opt-in installer.** Restores
  the spec's "Optional means post-onboard" model. New `src/lib/tools.ts`
  registry — Tool entries are data, not code: `id`, `binary`, `detect`
  argv, `prereqs`, `installSteps`. Four kinds of step: `cargo-install`,
  `npm-global`, `shell-script`, `manual` (no automated path — surfaces
  the install URL). `installTool()` streams stdout / stderr line-by-line
  to a callback so the UI shows progress instead of looking like a hang.
  New `src/commands/Add.tsx`: list view (`nostr-station list` /
  `nostr-station add`) shows every tool with ✓ / ○ install state +
  detected version; install view runs detect → confirm (or `--yes`) →
  installing (with last-12-lines stream) → done. Initial tools: `ngit`,
  `nak`, `stacks`, `nsyte`. 7 new tests including a planted-stub
  fakebin-on-augmented-PATH detection round-trip.

End state: 161 tests passing, type-check clean. The full happy path is
`curl … | bash` → ~10s → browser opens at `/setup` → scan QR → tap
approve → verify pipeline → dashboard. Codebase footprint is now ~12k
LoC TS/TSX backend + ~7k LoC dashboard SPA + ~2k LoC tests, down from
~17k + ~7k + ~3.5k.

### Added
- **Ditto Client panel — compiled from source with baked `ditto.json`, no longer a generic prebuilt drop-in.** `scripts/fetch-ditto.mjs` now clones `soapbox-pub/ditto` pinned to a specific upstream SHA (`DITTO_REF`), writes an authoritative `ditto.json` at the clone root *before* `npm ci` + `npm run build`, then copies the resulting `dist/` to `dist/ditto/`. This unlocks every benefit `ditto.json` was supposed to provide — Ditto reads it at build time per its own docs, which the previous "drop the JSON into a prebuilt bundle" approach (acknowledged as dead code in the script's own comments) was silently ignoring. `customTheme.colors` (HSL `0 0% 4%` / `240 6% 80%` / `248 80% 67%` — nostr-station's `--bg` / `--text` / `--accent`), `customTheme.title: "nostr-station"`, and the five-relay `relayMetadata.relays` list (damus.io / nostr.band / nos.lol / primal.net / ditto.pub) now flow into Ditto's actual rendered UI rather than just the iframe wrapper. **`appName` + `client` together are the big payoff**: Ditto's `useNostrPublish` hook appends the full 4-element NIP-89 client tag `["client", "nostr-station", "31990:291c75d…:nostr-station", "wss://relay.nsite.lol"]` to every outgoing kind-1/6/7/1111 event. The `naddr1` baked into `buildDittoConfig()` resolves to the kind-31990 handler event signed by nostr-station's project pubkey (same identity that anchors the landing-page nsite and signs ngit merge events). The matching `src/lib/routes/client.ts:CLIENT_TAG` constant was updated in the same change so the native `/api/client` publish path emits the same coordinate — both surfaces (iframe Ditto + native client API) now agree on the project's NIP-89 identity. A one-shot publisher (`npm run publish-client-handler`, `scripts/publish-client-handler.mjs`) builds, signs (NOSTR_STATION_NSEC), and broadcasts the kind-31990 handler event to six relays; refuses to publish if the nsec doesn't derive to the expected pubkey, and runs in dry-run mode by default. kind-31990 is a NIP-33 addressable event so re-publishes (after content edits, relay-hint changes, etc.) are idempotent. No fork or source patch — `appName` and `client` are already first-class fields in Ditto's `AppConfigSchema` (discovered during exploration, killed the patch-maintenance branch of the design). Pipeline is idempotent: a sibling `.ditto-built-from` sentinel records the SHA, so re-running with the same pin short-circuits while bumping `DITTO_REF` forces a rebuild automatically. `STATION_SKIP_DITTO=1` still short-circuits entirely (air-gapped installs, CI) — and `install.sh` now passes that flag to keep the curl-pipe install at its advertised 30-45s instead of paying ~3-5 min for the Ditto build upfront. The first time a user opens the Client panel after a fresh install, they see the existing "Build Ditto now" recovery UI; clicking it streams the source build inline via the dashboard exec modal (10-min `streamExec` timeout). The themed-and-attributed bundle they get is exactly what we'd ship, just deferred to point-of-use. The dashboard's "Build Ditto now" recovery button (formerly "Fetch Ditto now") gets a 10-min `streamExec` timeout to cover the source-build path on slow networks. Branding overlay (favicon, og:* meta cleanup, manifest install name) is unchanged but the speculative `ditto.json` write step is gone — the real one lives in the source tree. `.ditto-src/` is gitignored.
- **`AGENTS.md` explicit support — Editor TUI surfaces it, contract pinned with tests.** `EDITOR_FILENAMES` already mapped both `codex` and `other` to `AGENTS.md`, and `symlinkEditorFile` already handled the file/subdir mechanics — no code change there. The `nostr-station editor` Ink TUI gains a clarifying paragraph above the picker explaining that AGENTS.md is the canonical target for Codex and Stacks Dork: it gives those tools environmental awareness (relay URL, signer status, NIPs available) without overriding their identity. The Nori persona's Section 5 (added in Item 1) already mentions this. New 8-test suite (`tests/editor-symlink.test.ts`) pins the contract: codex + other both land on AGENTS.md, the result is a symlink (not a file copy — switching tools mustn't quietly stale), the relative target is `NOSTR_STATION.md`, the copilot subdir case (`.github/copilot-instructions.md`) creates parent dirs, re-running on the same editor is idempotent (no EEXIST), switching editors leaves the previous tool's link intact (developers can flip between Codex and Claude Code without losing either file), and the documented EDITOR_FILENAMES table round-trips byte-identically.
- **Per-project chat overlay — `project-context.md`.** New developer-authored file at any project root, read on every chat turn by `ai-context.ts`'s `projectContext()` and spliced into the system prompt under `## Project context overlay` *(after* the README excerpt — tail placement gives the most intentional guidance the best survival odds against pathological truncation). Verbatim splice (no truncation — README is capped because every project has one whether it's AI-facing or not, but `project-context.md` is *deliberately* AI-facing and its length is the length the developer chose). Empty / whitespace-only / missing files all silently omit the section — no "auto-create" path; the file is intentional or it doesn't exist. New `readProjectContext(projectPath): string | null` helper, exported for testability. 9 unit tests cover present / missing / empty / whitespace-only / unreadable / rich-markdown round-trip / `buildAiContext` integration showing the section header lands and sits after the README. A header comment in `ai-context.ts` documents the `## Wiki namespaces` convention developers can use inside the file (today it's spliced verbatim; a future pass will parse the section to gate `/wiki:lookup` namespaces).
- **Nori — `NOSTR_STATION.md` reshaped from cheat sheet to AI persona + environment.** `buildContextContent()` now emits a 7-section structure: Identity ("You are Nori, the assistant for nostr-station…"), Environment (dynamic — relay URL + auth, AI provider + model, signer status, installed tools), Your role (Nostr app dev guidance, three first-class backends, dashboard-first, ask-before-destructive), Nostr / NIP reference (compact one-liners), Available commands (table — with explicit AGENTS.md / project-context.md notes), Stacks agent (Dork) boundary (only when `installStacks` — explicit "Dork is not Nori, don't absorb its role"), and a user-preserved region. The user region sits between two literal HTML-comment sentinels (`<!-- BEGIN USER EDITS — preserved across regeneration -->` / `<!-- END USER EDITS -->`); `writeContextFile` reads any prior file, extracts the region via `extractUserRegion`, and re-splices it on rewrite — never overwritten. Marker handling refuses to splice on duplicated / out-of-order / partial-marker shapes (returns empty rather than guessing a fuzzy region). 13 unit tests pin the marker contract: present / absent / empty / round-trip verbatim with markdown body / variant marker text / both halves missing / order swap / duplicated halves. `c.installLlmWiki` adds a wiki-first guidance line in Section 3 ("query the knowledge base before training data for NIP specs"), nothing else.
- **Projects panel — per-card Sync + Save-snapshot affordances.** Two new icon buttons in the card's action row: **Sync** (visible on git and ngit cards with a local path; hidden on local-only — no remote story) and **Save snapshot** (visible on every card with a local path — every project is locally a git repo). The Sync icon spins while the underlying `POST /api/projects/:id/sync` is in flight; results land inline in a new `.pc-banner` slot at the bottom of the card. Banner kinds: `pending` (muted "Syncing…"), `ok` (green, auto-clears after 5 s), `err` (red, persists until the next user action — diverged / dirty / network errors are actionable, not noise). On the ngit success branch, `proposals[]` from the server is rendered as a first-class count chip (`"2 open proposals"`) alongside the status message rather than collapsed into the message string. Save snapshot opens an inline form in the same banner — `<input>` + Save + Cancel — with auto-focus, Enter-to-submit, Escape-to-cancel; submits through `POST /api/projects/:id/snapshot` and renders the new short SHA on success. The "nothing to commit" path is rendered as ok (not error) since the user's intent — save what's there — succeeded with zero work. Both flows kick a single-shot poll afterwards so the badge state catches up immediately. All inner click / keydown / submit events `stopPropagation` so the card-level openDetail handler doesn't fire on every input keystroke.
- **Projects panel — per-card git-state badge with 30 s polling.** Each project card now carries a `.pc-state` pill on the badges row showing the GitState `label` returned by `GET /api/projects/:id/git-state`. Color mapping mirrors the spec: muted (up to date) / amber (dirty) / blue (ahead, behind) / red (diverged). Local-only projects render no badge — the backend signal `local-only` short-circuits the render. Polling: one round fires immediately after `reload()` (so cards have state on first paint, not 30 s later), then `setInterval` every 30 s plus a `visibilitychange → 'visible'` re-fetch so a tab return refreshes between ticks. In-flight dedup per project (a `Set` of project ids currently being fetched) means a slow `git fetch` underneath can't stack calls. The poller never fires while the document is hidden or while the panel is in detail view.
- **Sync API — three new project endpoints.** `GET /api/projects/:id/git-state` returns the parsed `--porcelain=v2 --branch` shape; `POST /api/projects/:id/sync` runs the per-backend sync with the SyncResult body carrying ngit `proposals[]` first-class (not flattened into a generic message); `POST /api/projects/:id/snapshot` accepts `{ message?: string }` and returns `{ ok, sha?, error? }`. All three gate on `project.path` presence (400 on missing) and `validateProjectPath` (defense-in-depth for legacy rows recorded before B2). 404 for unknown `:id` is inherited from the existing project lookup at the top of `projMatch`. Sync results return 200 even on `ok: false` — the actionable signal lives in the body, mirroring the existing `/api/projects` PATCH error contract.
- **Sync primitives — `src/lib/sync.ts`.** Three helpers that turn the Projects panel from a launcher into a dashboard. `getProjectGitState(project)` parses `git status --porcelain=v2 --branch` into an `{ ahead, behind, dirty, diverged, branch, label, backend }` shape. `syncProject(project)` dispatches per-backend: local-only no-ops, git does `fetch --all --prune` followed by a strict `merge --ff-only` (refusing dirty trees and diverged branches with actionable messages, never force-push or rebase), ngit does `ngit fetch` plus a kind-1617 proposals query against the project's relay hints + read relays — proposals come back as a first-class array on the result, not flattened into a generic message. `snapshotProject(project, message)` runs `git add -A` + `git commit -m <message>` via `execFile` (no shell template strings; arbitrary message content round-trips safely) with an ISO-timestamp fallback when the message is empty. 26 unit tests cover the porcelain parser (clean / ahead / behind / diverged / dirty-wins-priority / no-upstream / detached HEAD / local-only zero-out) and integration through real `git init` / `git push` / `git commit` flows including the ff-only fast-forward path, dirty-tree refusal, and snapshot's nothing-to-commit graceful path.

## [0.0.6] — 2026-04-27

> **Security release.** Six findings closed: H1 (DNS rebinding) / H2 (CSRF during wizard) / H3 (relay-URL XSS) / M5 (dashboard security headers) / B1 (`nak` + `nvpn` SHA256 verification) / B2 (project-path traversal). All 0.0.5 users should upgrade — H1 and B2 in particular turn the local dashboard into an arbitrary-event-sign and arbitrary-file-read primitive against any remote site the user happens to visit. See the **Security** subsection below for full details.

### Added
- **Projects: New Project flow with Stacks/MKStack integration** — "New Project" path alongside the existing adopt-an-existing-repo flow. Anchored to `~/projects`, slug-aware (`My Cool App` → `~/projects/my-cool-app`), with collision handling that swaps to the Add Project drawer with path prefilled when the directory already exists. Two templates: empty (`mkdir` + `git init` + README) and **mkstack** (Soapbox's Nostr React scaffolder via `stacks mkstack <slug>`, auto-disabled with a tooltip when `stacks` isn't on PATH). Stacks project cards surface three new icon buttons — Open in Dork (`stacks agent`), Run dev server (`npm run dev -- --port 5173` to avoid the 8080 relay collision), and Deploy to NostrDeploy (`npm run deploy`). Post-scaffold modal prompts "Open Dork now / Run dev server / Skip" to mirror shakespeare.diy's creation-to-AI loop in one click. Config panel gains a "Stacks AI (Dork)" section with sanitized status (reads `~/Library/Preferences/stacks/config.json` server-side; exposes provider ids only, never keys). `ensureStacksRelays()` idempotently appends nos.lol / damus / wine / snort to Stacks's nostrRelays list at install time and on every mkstack scaffold so existing users get the widened relay net without reinstalling.
- **Projects: three-source Add Project chooser** — replaces the scaffold picker with a chooser opening one of three purpose-built modals: **New local project** (folder + README only, no `git init`; matches shakespeare's "no VCS until you pick a sync destination" model), **Existing local project** (adoption flow, unchanged), **Import repository** (standard git URLs, `nostr://`, and `naddr1` in one modal). `capabilities.git = true` now means "has a traditional git remote" — an ngit-cloned repo only flips `git` when its announcement lists a github mirror. Zero-capability projects are a valid first-class state as long as there's a local path; cards no longer render yellow warnings on intentional local-only projects. `/api/ngit/clone` handles `naddr` inputs end-to-end: decodes, queries embedded relay hints for the kind-30617 announcement, extracts an HTTPS clone URL from `clone` tags, falls back to reconstructing `nostr://<npub>/<d-tag>`.
- **Projects: per-project identity in Add Project modals** — both New Local Project and Import Repository modals now expose a collapsed "Advanced — signer identity" section matching the full ProjectDrawer (station-default vs project-specific npub + optional bunker URL). `scaffoldProject()` takes an optional `ScaffoldIdentity` parameter; `validateInput` in `projects.ts` rejects nsec and validates bunker URL format server-side. nsec detection surfaces inline as the user types.
- **Projects: Remove vs Delete-on-disk, plus pathMissing red cards** — Settings tab's Danger zone now offers two destructive actions: Remove (unregister only, files stay on disk, existing behavior) and **Delete on disk** (runs `rm -rf` on the project path and unregisters in one shot; type-the-project-name confirm). `POST /api/projects/:id/purge` refuses projects without a path, paths outside `$HOME` (after realpath resolution so symlink escapes can't slip through), and `$HOME` itself. `/api/projects` annotates each entry with `pathMissing: true` when the recorded path no longer exists on disk, and the card paints red — orphan entries from external `rm` or interrupted scaffolds become immediately visible.
- **Status panel: services/binaries split with new rows** — Status cards and sidebar Service Health now group `kind: 'service' | 'binary'` separately. Services (Relay, nostr-vpn, **watchdog**) carry colored-dot state (ok/warn/err); binaries (ngit, nak, claude-code, relay-bin, **Stacks**) carry glyph state (✓ installed / ✗ missing / ! needs-config). Watchdog probes `launchctl` / `systemctl --user is-enabled` for loaded state. Stacks joins Binaries so users who skipped it at onboard can one-click install from the Status panel. Claude Code plugins (read from `~/.claude/plugins/installed_plugins.json`) render nested under an expanded Claude Code row — recommended plugins render even when absent with the exact `/install-plugin` command and a copy button.
- **Status panel: horizontal expandable rows** — flat card grid replaced with a vertical stack of `<details>/<summary>` rows. Each row shows dot + label + value on one line; expand reveals a service-specific blurb tailored to ok/warn/err state, relevant CTAs (Install, run-this-hint, "Configure in Config" for ngit), and a deep-link to the destination panel (#relay, #logs, #config, …). Sidebar Service Health click-through auto-expands the target row after scrolling. `refreshHealth()` now hashes the payload and skips re-render when nothing changed, preserving `<details open>` across 5s ticks.
- **Relay: role badges on managed whitelist entries** — `/api/relay-config` emits a `knownRoles` map derived from `identity.json` + keychain (station npub, watchdog, seed). Whitelist rows render a pill — "You · station" (accent blue), "Watchdog" (warn yellow), "Seed" (success green). User-added entries stay unlabeled — the honest signal. Live-derived so rotating identities refreshes labels on next panel load.
- **Relay: collapsible Recent events list** — 50+ seed events previously pushed whitelist + stats cards off-screen. Wrapped in `<details>/<summary>`, closed by default. Summary row shows "Recent events · N shown" with a rotating chevron and live count.
- **Chat: model chip on assistant replies** — server emits `data: {"model": "..."}` at stream-open (immediate) and again when the upstream API's `message_start` / first chunk carries a more fully-qualified id (e.g. `claude-opus-4-6` → `claude-opus-4-6-20240229`). Client renders as a small monospaced chip on the assistant bubble's "assistant" label row. Claude's self-identification is famously unreliable across versions; this gives users visible proof of which model actually replied.
- **Auth: persistent sessions + silent re-auth via saved bunker** — session token moved from `sessionStorage` to `localStorage` so sessions survive tab close, browser restart, and cross-tab access (server-side 8 h TTL remains authoritative). After any successful NIP-46 sign-in (QR or `bunker://` paste), the ephemeral client secret + bunker pointer is stashed to `~/.nostr-station/bunker-client.json` (mode `0600`, scoped by owner npub). Next sign-in tries `silentBunkerSign()` first: reuses the same client pubkey Amber already trusts, sends a `sign_event` request over the existing pairing (push notification if "Ask Always" is set, auto-signs if autosign is on). Falls through to QR only when the saved pairing is dead and self-clears stale state. Eliminates the QR-rescan-on-every-refresh dance that burned Amber approvals with no security win.
  - **Trade-off / threat model:** your Amber nsec never leaves your phone, so an attacker with filesystem access can't sign arbitrary events — but they _can_ trigger NIP-46 sign requests against the bunker you've already paired with. If Amber's autosign is on for this app, those requests are approved on your phone without a prompt; if it's off, you see the prompt. To opt out for now, either sign in via NIP-07 browser extension instead of bunker, or delete `~/.nostr-station/bunker-client.json` after sign-in (session remains valid; silent re-auth just falls back to QR on the next sign-in). A first-class opt-out flag is tracked as a follow-up.
- **Terminal: bare shell cwd defaults to `~/projects`** — clicking the sidebar Terminal button (or expanding the bottom drawer) previously opened a shell wherever the web server was launched from. Claude booted without station context (no `CLAUDE.md` → `NOSTR_STATION.md` symlink reachable), and `ngit clone <naddr>` scattered repos across the filesystem. Now anchored to `~/projects` when present, home-dir fallback otherwise. Project-scoped tabs (Claude on a project card, ngit-push, nsite-deploy) are unchanged — they already `cd` via `opts.cwd`.
- **Terminal: shell tabs labeled with cwd basename** — every shell tab previously rendered as `zsh` / `bash` with no way to distinguish two open shells. New pattern: `zsh · projects` for `~/projects`, `zsh · my-app` for a project-scoped shell, `zsh` alone when cwd is indeterminate. Matches the existing convention for claude / ngit push / git push tabs. Only applies to new tabs — persisted labels stay as-is.
- **Unit-test scaffolding seeded for regression coverage.** `node:test` via `tsx` (zero new dependencies, uses Node 22+ built-in runner). `tests/_home.ts` pins a tmpdir `HOME` before module import so `ai-config.ts`'s load-time `CONFIG_DIR` constant resolves to the tmpdir rather than the user's real `~/.nostr-station`. 141 tests covering path-traversal validation, SHA256 verification, PID-file round-trip, `installCargoBin` post-install verify, `nvpnStateFor` decision table, terminal-key dispatch, the preview-retry decision helper, `projects.ts` (CRUD + three-source `createProject` branches + duplicate-path rejection + credential scrubbing + identity normalization), `ai-config.ts` (read/write round-trip, `setProviderEntry` merge semantics including the "Fetch models wiped the API key" regression, migrate short-circuit when file exists), `findBin` curated-dir walking, the install-log durable sink, and `url-safety.ts` (full vector battery — `javascript:`/`JAVASCRIPT:`/leading-whitespace variants, `data:image/svg+xml`, `vbscript:`, `file:`, protocol-relative, non-string inputs). Wired into `.github/workflows/ci.yml` before the TypeScript build.

### Changed
- **Terminal bar: centered expand chevron, removed redundant close-session ×** — `term-bar-toggle` is a 3-column grid (`1fr auto 1fr`) so the chevron sits on true horizontal center regardless of label width, bumped from 9 px to 12 px so it reads as the primary affordance. Per-tab × in the strip is now the sole session-close control.

### Fixed
- **Projects: duplicate-path adds now rejected in `createProject`** — adding the same directory twice (or scaffold-then-adopt with a path collision) silently appended a second entry with new capabilities, leaving two cards pointing at one checkout. `createProject` now refuses the insert with "A project at `<path>` already exists (`<name>`). Edit it to enable additional capabilities instead of adding a duplicate." Path comparison is intentionally shallow (exact-string match on trimmed input) — no symlink canonicalization, no trailing-slash normalization.
- **Projects panel: re-render when NSTerminal capability resolves** — `bootDashboard()` activates the panel before `NSTerminal.init()` resolves, so first paint saw `available === null` and rendered project cards without terminal-gated buttons (Open in Claude Code, Stacks Dork, dev server). They only came back on a manual panel switch. `NSTerminal.init().then()` now dispatches a `terminal-available` event; ProjectsPanel listens and re-renders if the user is on the projects list or detail view.
- **Scaffold: post-MKStack-test robustness pass** — four fixes from exercising New Project end-to-end. (1) `stacks mkstack` animates a "Cloning stack…" spinner via ANSI CSI codes (`\x1b[999D` / `\x1b[J`); SSE was treating each redraw as a fresh line and spamming the modal with thousands of identical frames. `makeLineEmitter()` strips CSI, treats them as logical newlines, collapses runs that differ only in spinner glyph. (2) `require('child_process')` replaced with ESM `execSync` in the stacks-binary presence check — the `require()` threw `ReferenceError` under ESM, got swallowed, and the scaffold bailed with "stacks binary not found" even when `stacks` was on PATH. (3) `ensureStacksRelays()` (see Added). (4) `freshenGitRepo()` resets the project's git history to a single root commit — templates cloned via `stacks mkstack` inherit Soapbox's upstream history + remote, so cards read "Alex Gleason · 21d ago" under Last Commit until wiped. Skips silently when `user.name` / `user.email` aren't configured.
- **Chat panel refreshes after adding an AI provider key** — `populateProvider()` is `initialized`-guarded, so panel re-entry didn't re-query `/api/ai/providers`. The add-key handler only dispatched `api-config-changed` transitively via `setAiDefault()` when no chat default existed — returning users with `defaults.chat` already set saw "No AI provider configured" stick until a full page reload. Dispatched unconditionally after a successful key save now.
- **Relay: long stat values contained inside their cards** — "up · ws://localhost:8080" at 20 px on a 160 px min-width grid cell overflowed the border. Value font dropped to 18 px, `overflow-wrap: anywhere` + `word-break: break-word` so URLs wrap, `min-width: 0` on `.stat` so grid columns can shrink.
- **Relay: clear client state + reconnect WS after DB wipe** — the "Wipe database" button correctly stopped the relay, deleted `nostr.db` + WAL + SHM, and restarted — but the dashboard's in-memory view (events array, kindCounts map, pubkeys set, WS subscription) was untouched, so users saw stale counts and pre-wipe event rows until page refresh, which misread as "wipe didn't actually work." Wipe handler now mirrors `action('restart')`: clears local state, resets stat chips to 0, closes the dead WS, reconnects after 1200 ms.
- **Terminal: session token read from `localStorage` to match the new auth contract** — commit `e2c7666` moved `app.js`'s session token to `localStorage`, but `terminal.js`'s `getToken()` still read from `sessionStorage`. `/api/terminal/capability` fired with an empty Authorization header, got 401, left `available` stuck at `null`, and every terminal-gated button (Seed Events, Open in Claude Code, relay logs, ngit login, update --wizard, nsite deploy) showed "Terminal unavailable" even though node-pty was installed.
- **Seed: stable identity + auto-whitelist + honest success counts** — two compounding bugs masked that seed has been silently broken against any `nip42_auth`-enabled whitelist relay (default nostr-station config). (1) Seed generated a fresh ephemeral keypair on every run and tried to publish without NIP-42 AUTH; the relay rejected with "blocked: pubkey is not allowed to publish" OR "auth-required" but `nak event` exits 0 even when rejected, so the UI reported "✓ Seeded 50 events" while the relay stored zero. (2) The ephemeral pubkey wasn't whitelisted anyway. Fix: new `seed-nsec` keychain slot holds a stable seed identity (generate + store on first run via nostr-tools, reuse thereafter — one identity indefinitely, no whitelist growth per seed run); `ensureSeedIdentity()` runs in a new `preparing` phase that adds the npub to the whitelist idempotently and restarts the relay only when the whitelist actually changed; every `nak` invocation passes `--sec` + `--auth`; `nakPublish` scans stdout+stderr for `/failed:|blocked|auth-required|restricted|rate-limit/` and returns `{ ok: false, reason }` on match. Seed UI now tracks published + failed independently, shows ✓/⚠/✗ honestly, surfaces the first rejection reason, exits non-zero when every event was rejected.
- **Onboard: main npub whitelisted even when `nak` isn't on PATH** — `Services.tsx` step 2 imported `npubToHex` from `detect.ts`, which shells out to `nak decode`. Common fresh-rustup scenario: user installs rustup, opens onboard in the same shell without re-sourcing `~/.cargo/env`, `has('nak')` returns false, `npubToHex` returns `''`, `cfg.hexPubkey` never gets set, `addToWhitelist(hexPubkey, dest)` silently no-ops, user's own npub missing from `pubkey_whitelist`. Swapped to `relay-config.ts`'s `npubToHex`, which uses `nip19.decode` directly — no exec, no PATH dependency.
- **Verify: nvpn probed via `status --json` across platforms** — step 5/5's nvpn check ran `launchctl list | grep -q nostr-vpn` on darwin and `systemctl is-active --quiet nvpn` on linux, both of which assume init-system management. False for homebrew installs, false for `nvpn start --daemon`, false for any user who didn't run `sudo nvpn service install`. Routed through `nvpn status --json`: `daemon.running` reports truth regardless of how the process was started.
- **Onboard: nvpn `sudo service install` failure surfaces as actionable warn** — previously flipped the row to red ✗ with "service install failed: sudo: a password is required" when the sudo cred cache was empty (expected on macOS, where the TUI doesn't pre-auth). Accurate but useless — the binary IS installed and `nvpn start --daemon` works without sudo. Now shows yellow ⚠ with the exact next-step command. Introduces a `warn` partial-success signal on `InstallResult` that future install helpers can reuse.
- **Logs: nvpn detected via `status --json`, tailed from daemon's own log path** — the vpn tab grep'd launchctl for a `nostr-vpn` label and hardcoded `~/logs/nvpn.log`. nvpn isn't launchd-managed in most install styles — homebrew runs it as a plain daemon and the log lives at `~/Library/Application Support/nvpn/daemon.log` (or wherever daemon config points). A correctly running nvpn showed "not installed." Now reads `daemon.running` + `daemon.log_file` from `nvpn status --json`. Also fixed the banner hint (previously suggested `nvpn up`, not a real command).
- **Watchdog: install-agnostic script + npub surfaced in dashboard** — three interlocking fixes. (1) `Services.tsx` switched from `generateWatchdogKeypair` (shelled out to `nak keygen`, removed in nak v0.18+ in favor of `nak key generate`, swallowed errors — onboard showed ✓ while the nsec was never stored) to `ensureWatchdogKeypair` (uses nostr-tools directly, no nak dep, idempotent, propagates keychain-write failures). (2) Watchdog script no longer assumes `nostr-station` is on launchd / systemd's minimal PATH (false for dev-mode installs via `npm run onboard` without a global install). Probes `security` (macOS), `secret-tool` (Linux GNOME keyring), and finally the CLI. (3) `/api/logs/watchdog` ships the watchdog npub (derived from keychain nsec) in the status payload; client renders as a copy-able chip above the log so users can follow the watchdog identity on their phone to actually receive the relay-down DM alerts. Banner no longer false-positives for interval jobs — launchd StartInterval jobs have no PID between fires, so "loaded" is treated as "running" for watchdog.
- **Logs: service health banner + relay info-level logging enabled** — `/api/logs/:service` now emits a leading status event with `installed`/`running`/`stale` flags (launchctl on darwin, systemctl on linux), and holds the SSE connection open with heartbeats when the log file doesn't yet exist. Client renders a banner above the tail with per-state hints ("relay is not installed — run nostr-station onboard", "installed but not running — run nostr-station relay start"). Staleness is only checked for watchdog (known 5-min cadence); relay/vpn are long-running and legitimately silent when idle. Relay plist template now sets `RUST_LOG=info` (launchd `EnvironmentVariables`, systemd `Environment=`) — default tracing filter is above info, so a healthy relay wrote zero bytes to stdout and the Logs panel relay tab appeared blank on every fresh install.
- **A2 — setup wizard preview retry storm closed (1s/3s/10s backoff + circuit break).** The identity stage of `/setup` auto-fired `/api/identity/profile/preview` on mount, and the failure path called `render()` — which remounted the component, which fired the on-mount auto-preview, which 500'd, which… 33k+ requests in short windows on real installs (Routstr endpoint outage during a relay-down window), browser fans on, devtools wedged. Two-piece fix: (1) the failure branch no longer renders inside the loop — only the success path and the final circuit-break write to the DOM, breaking the remount-fires-fetch cycle; (2) a module-scoped `previewRetry` object (attempt count + circuit-broken flag + pending timer) survives renders and feeds a new `previewRetryDecision` helper in `src/web/preview-retry.js`. 3 retries at 1 s / 3 s / 10 s, then `{ action: 'break' }` and the wizard renders a permanent error state with a manual `Retry preview` button. Editing the npub in the input clears the budget; the on-mount auto-fetch skips when the circuit is broken so navigating away and back doesn't re-fire the storm. 10 unit tests pin the schedule and the defensive coercion (NaN, negative, floating-point, custom backoff arrays).
- **A5 — Status panel "Install" routes through the terminal panel instead of the silent SSE modal.** Clicking Install on a missing tool used to open an SSE modal that ran `nostr-station doctor --fix` — but cargo compiles inside that flow take 60s–10min, the modal couldn't render the live stderr stream, and users saw a single spinner with no output for the full window. Either gave up, assumed it was hung, or fell back to a shell. Same path through `doctor --fix` now opens a terminal tab (matching the established pattern from `status-doctor` / Relay seed / Logs / Publish), so cargo's compile output streams live with colour, scrollback, and the strip's `doctor --fix` tab label. New `doctor-fix` resolver key in `src/lib/terminal.ts` (whitelist-strict — no per-slug argv interpolation; the slug-keyed `/api/exec/install/<slug>` SSE endpoint is preserved as the fallback for environments where node-pty failed to load). Health refresh schedule extended for the cargo long-tail (30 s / 2 min / 5 min). 4 unit tests pin the dispatch including a typo'd-key rejection covering the whitelist invariant.
- **A4 — Status panel distinguishes "binary installed, service not loaded" from "service loaded, mesh not connected".** On Linux, `sudo nvpn service install` runs as part of the install flow but the TUI can't pre-auth sudo, so the step lands a `warn` and leaves the binary at `~/.cargo/bin/nvpn` without a system unit. Pre-A4, Status collapsed both this case and the peer-down / firewall-blocked case into a generic "not connected" line — neither was actionable. Added a system-supervisor probe (`launchctl list com.nostr-vpn.nvpn` on darwin, `systemctl cat nvpn` on linux — both no-sudo, both fail-fast on missing) that runs alongside the existing `nvpn status --json` mesh probe. New pure helper `nvpnStateFor({binPresent, serviceLoaded, meshIp})` collapses the four-state truth table into the row's value/state/ok triple, with the new sub-state surfacing the exact recovery command: `installed but service not running — run: sudo nvpn service install`. The peer-down case keeps its existing `not connected` text so users (and any dashboard text-match logic) can tell the two warn shapes apart. 7 unit tests pin every branch including precedence (binary missing trumps stale meshIp; service-not-loaded trumps stale meshIp; empty-string meshIp doesn't flip the row green).
- **A12 — `installCargoBin` verifies the binary actually landed before reporting ✓.** Cargo's "already installed" shortcut reads `~/.cargo/.crates2.json` and exits 0 without writing anything; when the state file lies (manual `rm`, restored-from-backup partial home, prebuilt-drop overwriting the file without updating the record), users saw a green ✓ from the Install phase and an "✗ not installed" from Status's `findBin` probe in the same dashboard frame — looked self-contradictory. Post-`await proc`, the helper now calls `findBin(pkg)` (the same walker Status uses, so the two surfaces can never disagree) and turns null into `{ ok: false, detail: "cargo reported installed but <pkg> binary missing — try \`cargo install <pkg> --force\`" }`. The durable sink at `~/logs/install.log` captures a `cargo[<pkg>] FAILED: cargo exited 0 but binary not found on disk` line so the post-mortem isn't blank when cargo's own stderr was empty. New `verifyCargoBinaryLanded` helper (exported for testing) is exercised by 7 unit tests covering: present in `~/.cargo/bin`, present via PATH (non-curated dir, e.g. CARGO_INSTALL_ROOT override), missing entirely, file present but non-executable (matches `findBin`'s X_OK semantics), and the no-log-sink fallback.

### Security
- **Dashboard hardening pass — H1 / H2 / H3 / M5.** Four findings closed in one batch. The dashboard's loopback bind on `127.0.0.1` protects the network layer but not the browser layer; the browser happily talks to `evil.com` and our own port in the same session, which is the gap each of these addresses.
  - **H1 — DNS rebinding blocked.** `expectedDashboardUrl()` previously reconstructed the expected NIP-98 `u` URL from the untrusted `Host` header, so an attacker hosting `evil.com` that DNS-rebinds to `127.0.0.1:<port>` could have Amber sign an event against `http://evil.com` and have the server verify it (both sides of the comparison were attacker-controlled). Added a loopback-only `Host` header check at the top of the HTTP dispatcher, and pinned `expectedDashboardUrl` to the actual bound port — the verified URL is now always `http://127.0.0.1:<bound-port>` regardless of what the header claims.
  - **H2 — CSRF during the wizard / `requireAuth:false` window blocked.** `localhostExempt()` skips session checks for localhost requests during the setup wizard and when a user has opted out of auth. Without an Origin/Referer check, any page the user had open in the same browser could POST to `/api/keychain/set`, `/api/identity/set`, `/api/exec/*`, `/api/setup/*`, etc. Mutations (`POST`/`PATCH`/`PUT`/`DELETE`) now require a loopback `Origin` or `Referer`; GETs carrying a `?token=<hex>` (EventSource / WebSocket / downloads) require the same; the WebSocket upgrade handler at `/api/terminal/ws/:id` re-runs both checks. `Referrer-Policy: same-origin` ensures the dashboard's own same-origin fetches keep a Referer the middleware can see while stripping cross-origin leaks.
  - **H3 — XSS via relay-authored URLs blocked.** `escapeHtml()` on the client only HTML-entity-encodes — it does nothing about URL scheme, so `javascript:alert(1)` in a kind-30617 `web` tag survived intact as a clickable `<a href>` payload on the discover panel. New `safeHttpUrl()` helper (`src/lib/url-safety.ts`) parses with WHATWG URL and passes only `http:`/`https:`; applied to the `web` tag in `/api/ngit/discover` and the `picture` field in `/api/identity/profile` + `/api/identity/profile/preview` (kind-0 events forward these into `<img src>`, where `data:image/svg+xml` could execute JS via SVG-embedded `<script>`). Also repaired a pre-existing defense-in-depth gap at `src/web/app.js:597` where `<img src="${p.picture}">` interpolated without `escapeHtml`.
  - **M5 — security headers added to dashboard HTML.** `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, and a starter `Content-Security-Policy` (`default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `connect-src 'self' ws://127.0.0.1:* ws://localhost:* wss:`, `img-src 'self' data: https:`). `script-src` and `style-src` keep `'unsafe-inline'` because the current dashboard uses inline scripts/styles and `innerHTML`; tightening to nonces or hashes is deferred to 0.0.7. Headers are applied only to HTML responses — JSON and SSE skip them so devtools doesn't flag CSP on every data fetch.
- **B1 — `nak` + `nvpn` downloads now SHA256-verified before they touch disk.** `installNak` previously fetched the latest release tag from GitHub's API and `curl`-downloaded the matching asset with no integrity check; `installNostrVpn` `curl`-downloaded a `releases/latest/download/...` tarball and extracted it, also unverified. Either was a one-MITM-or-CDN-swap-away silent RCE channel into `~/.cargo/bin/nak` and `~/.cargo/bin/nvpn`. Neither upstream publishes a `SHA256SUMS` file, so per-target hex digests are pinned in `src/lib/versions.ts` (new `BINARY_SHA256` map) alongside the version pins; bumping the version requires bumping the sums in lockstep. New `src/lib/checksum.ts` (`verifyFileSha256`, length-stable XOR compare) is exercised by `tests/checksum.test.ts`. Hard-fail contract: mismatch deletes the partial download and returns an actionable error — there is no silent fallback to an unverified copy. `installNak` no longer hits the GitHub API at all (one less network round-trip + one less attack surface); it constructs the asset URL deterministically from the pinned version. `installNostrVpn` switched off `releases/latest/download/...` to a versioned tag URL so the verification target is reproducible. Targets without a pinned hash (e.g. macOS x86_64 for nvpn — upstream doesn't publish it) surface as a clear "no checksum pinned for `<target>` — refusing unverified install" instead of a silent skip.
- **B2 — path-traversal guard on `createProject` / `updateProject`.** `/api/projects` POST and PATCH accept a client-supplied `path`, and `resolveProjectContext` later reads `README.md` / `CLAUDE.md` / `NOSTR_STATION.md` from that path into the chat system prompt. Without the guard, posting `path: "/etc"` turned the project registry into an arbitrary-file-read primitive over the chat surface. New `validateProjectPath` (and supporting `resolveSafeAbsolute`) in `src/lib/projects.ts` walks up to the longest existing ancestor before realpath'ing — so paths inside the new-project flow that haven't been mkdir'd yet still validate, while symlinked or `..`-traversed paths that escape HOME canonicalize and get rejected via `path.relative(home, …) → starts with ".."`. The classic `startsWith` bug (`/home/jared-evil` looks like a child of `/home/jared`) is sidestepped by using `path.relative` instead of prefix-matching. Helper applied in `createProject`, `updateProject` (only when `patch.path` is actually set, so name-only PATCHes on legacy rows still succeed), and `/api/projects/:id/purge` — the inline realpath-prefix check on the purge handler is removed in favor of the shared helper. 14 new test cases including HOME-prefix sibling rejection, symlink escape, not-yet-existing leaf paths, and the classic `..` escape.
- **B3 — uninstall guards: PID file gate + opt-in config wipe.** Two intertwined gaps. (1) Nothing prevented `nostr-station uninstall` from running while the dashboard server was still up — services got nuked, npm got uninstalled, and the running process was left holding open file handles to deleted launchd/systemd units. The dashboard now writes `~/.config/nostr-station/chat.pid` (mode 0o600) once the socket is bound, removes it on `server.close` / SIGINT / SIGTERM / `beforeExit`, and the uninstall command probes that PID before doing anything: alive → refuse with `kill <pid>` instructions and the pid-file path; ESRCH (the canonical "dashboard crashed without cleanup") → silently sweep the stale file and continue; EPERM/unknown → defensively treat as alive (don't yank services from under another user's running server). (2) Uninstall used to take `~/.config/nostr-station/{identity,projects,ai-config}.json`, `~/.claude_env`, and `~/projects/NOSTR_STATION.md` with it whether the user wanted that or not — making reinstall a "re-enter every API key from scratch" exercise. New post-keychain `Remove configuration files?` prompt with default **No**; only nukes the listed files when the user explicitly says yes. `--yes` keeps the no-prompt path (preserves configs), matching the documented default. New `src/lib/pid-file.ts` (`writePidFile` / `removePidFile` / `probePidFile` returning a tagged union of absent/alive/stale/unknown/unreadable) is exercised by 14 tests including stale-PID round-trip via spawnSync child + detached-child live probe.
- **B4 — `git log` argv hygiene (ride-along).** `projectGitLog` interpolated `limit` into a shell command via template literal (\`git log -${limit} --pretty='…'\`) — not a live vuln (`limit` defaults to 10 and the only caller passes no client input), but the wrong codebase pattern. Swapped to `execFileSync('git', ['log', '-N', '--pretty=%h|%s|%an|%ct'])` with a defensive integer coerce + clamp, no shell, no quoting concerns on the `|` separators. Sets the pattern future git calls in this file are expected to follow.

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

## [0.0.3] — 2026-04-10
_All work originally slated for 0.0.3 (initial CHANGELOG, CONTRIBUTING, SECURITY, seed command, onboard `--demo`, Rust-component version pinning, NIP coverage map, install.sh TTY / SSH / nvm fixes, Banner + Select rendering fixes on narrow terminals, and several others) was rolled forward into the [0.0.4] entry below when that release landed five days later. The `v0.0.3` git tag (commit `fbb17f8`) is real — this stub exists so the version sequence is complete and future archaeologists don't hunt for a missing tag._

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
