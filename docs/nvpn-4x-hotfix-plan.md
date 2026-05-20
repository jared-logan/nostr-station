# nvpn 4.x hotfix plan

> **Handoff doc** — written after live validation of PR #154 (pin bump 0.3.12 → 4.0.37) against a real
> 4.0.37 daemon on a Linux x86_64 VM. PR #154 fenced the *removed* CLI commands behind 501s and shipped.
> This doc captures everything **PR #154 missed** because it was sandbox-only — schema-drift in status JSON,
> latent landmines in CLI invocation, dashboard rendering bugs, and installer hardening gaps.
>
> Implement in a fresh session, in P0 → P1 → P2 → P3 order. P0 alone is shippable as a hotfix; P1 is the
> follow-up parity pass. Each P-level should be a separate PR.

## Context

Upstream `mmalmi/nostr-vpn` v4.0.37 made the CLI surface deeper than the changelog suggested. Three classes
of problem the PR-merge audit missed:

1. **Silent fallback in `nvpn status --json`.** When the CLI can't reach the daemon (most often: `--config`
   path mismatches the dir where the daemon wrote `daemon.pid`), it returns HTTP 200 with `status_source:
   "config"` and every live field nulled. Our routes return that snapshot to the dashboard with no warning.
2. **Identity and public-endpoint fields removed from `status --json`.** `npub` / `pubkey` /
   `public_endpoint` / `external_endpoint` / `nat.public_endpoint` / `port` are all `null` in live 4.x
   output. Identity now lives in `~/.config/nvpn/config.toml` under `[nostr] public_key`. STUN-discovered
   public endpoint doesn't surface in any CLI output (visible only in daemon log).
3. **`--publish` doesn't guarantee delivery.** Roster mutations report `published: true` even when
   `published_recipients: 0` (relay timeouts, POW gates, etc). PR #154 removed the manual
   `/api/nvpn/roster/publish` endpoint on the premise that `--publish` made it redundant — that's wrong
   when delivery silently fails.

Plus three rendering bugs and seven installer hardening gaps surfaced during the live upgrade walkthrough.

## P0 — silent landmines (ship as standalone hotfix)

Each of these silently lies to the user. None of them will throw a visible error; they just display wrong
values or absorb stale data. P0 must land before more users upgrade.

### P0.1 — gate `status_source !== "daemon"` at the route layer

**File**: `src/lib/routes/nvpn.ts` (status handler at `:89-200`)
**Lib**: `src/lib/nvpn.ts` `probeNvpnStatus()` reader

When `nvpn status --json` returns `status_source: "config"`, the response contains zero live data —
every "is the daemon up?" / "what's my endpoint?" field is null. Today our routes return this snapshot
verbatim to the dashboard, which renders it as "everything zero / disconnected."

Fix:
- Add `status_source` to the parsed status JSON shape in `nvpn.ts`.
- In the status route, if `status_source !== "daemon"`, override `running: false` and add a top-level
  warning field (e.g. `stale: { reason: "config-snapshot", detail: "CLI couldn't reach the daemon. Likely
  cause: $HOME / --config mismatch." }`).
- Dashboard `app.js` status strip + the deployment-banner renderer should read the warning and surface a
  third banner ("Status data is stale — restart nvpn or check daemon visibility").

### P0.2 — pass `--config <path>` to every CLI invocation that needs live data

**Lib**: `src/lib/nvpn.ts` — every `execa(binPath, ['status', '--json'], ...)` call site and similar

Root cause of P0.1 in the wild: under `sudo`, nvpn's CLI resolves `~/.config/nvpn/` to `/root/.config/nvpn/`
where the pid file doesn't exist, so it falls back to config-mode. Even without sudo, mismatched `$HOME`
values across the nostr-station process and the daemon's startup environment cause the same drift.

Fix: thread `findNvpnConfigPath()` (already in `nvpn.ts` for roster reads) through every CLI invocation
that needs live data. Affected commands: `status`, `service status`, `doctor`, `ping`, `whois`, `ip`,
`add/remove-participant`, `add/remove-admin`, `create-invite`, `import-invite`, `set`. The flag is
`--config <path>` and is accepted by every command (verified per-help-output).

Belt-and-suspenders against P0.1 — even if the daemon's pid-file location changes again upstream, an
explicit config flag pins the lookup.

### P0.3 — identity helper that reads `config.toml` safely

**Lib**: new helper in `src/lib/nvpn.ts` — `readNvpnNodeIdentity(): { publicKey: string | null }`
**Route**: `src/lib/routes/nvpn.ts` — splice identity into `/api/nvpn/status` response

In 4.x, the local node's pubkey/npub is **only** in `~/.config/nvpn/config.toml`:

```toml
[nostr]
secret_key = "nsec1..."      # SENSITIVE — must never leak
public_key = "npub1..."      # what we need
```

Same file also contains `[node] private_key = "<wireguard base64>"` and `[node] secret_key`.

Fix:
- Add a focused TOML parser (regex-based, same pattern as our existing `extractFirstNetworksSection`) that
  pulls **only** `[nostr] public_key` and ignores everything else.
- The helper must never return or log other fields from `[nostr]` or `[node]`. Add a unit test that pins
  this — pass a config with secret material, assert the returned shape is exactly `{ publicKey }` and that
  no secret string appears in the function's exported surface.
- Splice the result into the `/api/nvpn/status` response under a new `identity.npub` field so the dashboard
  can read a single key.
- Dashboard's Status panel identity display reads `status.identity.npub` (with the existing
  `status.npub || status.pubkey` fallback retained for transitional installs still on 0.3.x).

### P0.4 — surface `published_recipients` honestly

**Lib**: `src/lib/nvpn.ts` — `runRosterCommand()` and the four roster mutation wrappers
**Route**: `src/lib/routes/nvpn.ts` — return `published_recipients` to the dashboard
**Dashboard**: `src/web/app.js` — roster mutation toast rendering

Today every successful mutation returns `ok: true` and the dashboard shows green. With 4.x's relay setup
flakiness, the daemon happily reports `published: true, published_recipients: 0` — saved locally,
delivered nowhere.

Fix:
- Pass through `published_recipients` (already in `RosterMutationResult` per the schema audit) to the
  route response.
- Toast logic: 0 recipients = yellow ("saved locally, no relays reached"); ≥1 = green; absent = silent
  (older versions).
- Add an inline "Retry publish" button to the yellow state. See P0.5 for the underlying mechanism.

### P0.5 — restore a "publish roster" affordance

**Lib**: new `republishRoster()` in `src/lib/nvpn.ts`
**Route**: `/api/nvpn/roster/publish` — flip from 501 to 200 (or 502 on actual failure)

PR #154 fenced this endpoint behind 501 on the premise that `--publish` made it redundant. Wrong when
publish silently fails. Need an explicit retry path.

Probe upstream first (small Bash script handoff to this PR's implementer):
```sh
# Does any of these trigger a republish without mutating the roster?
nvpn reload --help                                       # might re-read config + republish
nvpn connect --help                                      # "Run a FIPS private mesh session from config"
# Fallback: re-add an existing participant to trigger --publish
nvpn add-participant --participant <existing-roster-npub> --publish --json
```

If `reload` or `connect` republishes without side-effects → use that. Otherwise the practical workaround
is "re-add the first roster member to itself" via `add-participant --publish` (idempotent, triggers a
fresh publish). Cosmetic but functional.

Either way: flip `/api/nvpn/roster/publish` back to a 200 path wrapping the chosen mechanism. Update the
PR #154 CHANGELOG entry to retract the "publish-roster removed, no replacement needed" claim.

## P1 — broken renders

### P1.1 — 5 read-path field mapping

**File**: `src/lib/routes/nvpn.ts` (status response shaping at `:90-200`)

| Field | Old read | New read |
|---|---|---|
| Identity | `status.npub \|\| status.pubkey` | from P0.3 helper |
| Public endpoint | `status.public_endpoint \|\| status.external_endpoint \|\| status.nat.public_endpoint \|\| status.endpoint` | **drop** — not surfaced in 4.x; show FIPS overlay state (`peers[].endpoint === "fips"`) instead. Update the "private address" detection at `:120-125` to read `status.endpoint` only (the LAN/configured endpoint), and skip the "public endpoint" widget entirely. |
| Port | `status.listen_port \|\| status.port` | `status.listen_port` (the `port` field is gone; existing fallback already works but the comment should be updated) |
| Peer identity | `peer.public_key` | `peer.public_key \|\| peer.participant_pubkey \|\| peer.node_id` — `public_key` is empty in live mode; `participant_pubkey` (new in 4.x, 64-hex) is the canonical live field; `node_id` is sometimes an alias and sometimes a UUID |
| "Is the mesh up?" | `daemon.running` | `daemon.running && peer_count > 0` — `mesh_ready` alone only means initialized, not connected |

### P1.2 — "Publish roster" button restoration

**File**: `src/web/app.js:14041` (Network tab roster controls)

After P0.5 lands, the button stops 501ing. Re-enable it visually. Add the "Retry publish" affordance from
P0.4 inline (separate from the "Publish roster" button — one is "publish current state," the other is
"redo the last mutation's publish step").

### P1.3 — peer dedup by tunnel IP

**File**: `src/web/app.js` — peer-list renderer (search for the lobster.nvpn rendering path)

4.x's `peers[]` returns rostered-and-named entries AND discovered-but-unrostered entries as separate items.
Same tunnel IP, different displays. Today the dashboard renders both → user sees "1 admin · 0 online" plus
a duplicate "10.44.184.115/32 · discovered (not in roster)" entry for the same node.

Fix: group `peers[]` by `tunnel_ip`. When a discovered-only entry matches a rostered entry's IP, fold it
in (show roster name, append "(discovered)" badge). Standalone discovered peers (no roster match) keep
their existing display.

### P1.4 — runtime-vs-config tunnel IP

**File**: `src/lib/nvpn.ts` (any config.toml tunnel_ip reader)

In 4.x the daemon picks the real tunnel IP at runtime; `[node] tunnel_ip` in config.toml becomes a
stored hint, not source of truth. Confirmed by side-by-side: config says `10.44.247.100/32`, runtime
reports `10.44.217.186/32`.

Fix: read tunnel IP from `status.tunnel_ip` (runtime) for every display. If the dashboard ever needs the
"requested" value, expose it under `status.identity.requestedTunnelIp` or similar, but the headline
display is the runtime one.

### P1.5 — service-status cache bust

**File**: `src/web/app.js:13489-13622` (Service tab renderer)

Bug observed in screenshots: Service tab shows `v0.3.12` and the old cargo-bin path, even though
`nvpn service status --json` returns the correct `v4.0.37` + `/usr/local/bin/nvpn`. The dashboard caches
the response and doesn't refetch on tab switch.

Fix: cache-bust the service-status fetch on the Refresh button at minimum; ideally also on tab focus and
a short TTL (30-60s).

## P2 — installer hardening

The PR #154 walkthrough surfaced seven distinct installer rough edges. Each is small individually; together
they explain why "click Update → things break" happened.

### P2.1 — installer should `warn: true` on silent `install-cli` failure

**File**: `src/lib/nvpn-installer.ts:151-156`

Today: `sudo -n nvpn install-cli` failure (empty cred cache) is caught, logged, and ignored. End result:
`ok: true` with no warning, while PATH-resolved `nvpn` is still the old binary.

Fix: when the catch block fires, return `{ ok: true, warn: true, detail: 'binary updated in
~/.cargo/bin/nvpn but install-cli couldn't relocate to PATH (sudo cred cache empty). Run `sudo nvpn install-cli --force` manually, or seed sudo first.' }`.

### P2.2 — pass `--force` to `nvpn install-cli`

**File**: `src/lib/nvpn-installer.ts:151`

Today: `sudo -n nvpn install-cli`. Upstream refuses to overwrite an existing binary without `--force`, so
the new binary lands in `~/.cargo/bin/` and the system-PATH binary stays stale.

Fix: when `opts.force === true` (per-tool update flow), append `--force`: `sudo -n nvpn install-cli --force`.
The flag is safe to pass on first-install too (no existing binary → no-op).

### P2.3 — re-run `service install --force` on force-update

**File**: `src/lib/nvpn-installer.ts:164-173`

Today: force-update mode (`opts.force === true`) skips `service install` entirely. So the systemd unit
file keeps pointing at whatever path it was originally installed from (cargo-bin) — even after the binary
moves to `/usr/local/bin/nvpn`. Result: unit's ExecStart is stale.

Fix: in force-update mode, also run `sudo -n nvpn service install --force` (the `--force` flag is new in
4.x — probe with `nvpn service install --help` for safety). This rewrites the unit file at the new
canonical path.

### P2.4 — `service install` $HOME mismatch warning

**File**: `src/lib/nvpn-installer.ts`

Upstream 4.x's `service install`, when invoked via `sudo`, resolves `$HOME` from the invoking user — not
from `/root`. So a system service installed via `sudo nvpn service install` ends up pointing at
`/home/<user>/.config/nvpn/config.toml`, not `/root/.config/nvpn/config.toml`. The daemon writes its
state files next to the config (`daemon.state.json`, `daemon.pid`, `daemon.log`), so they all migrate
silently into the user's home dir. The old `/root/.config/nvpn/` becomes orphaned.

This isn't catastrophic on its own — but combined with P0.1, anyone who later runs `sudo nvpn status` will
get the config-snapshot fallback because the pid file isn't where the CLI expects.

Fix options (pick one):
- (a) Always pass `--config /root/.config/nvpn/config.toml` to `service install`. Pins the canonical
  location. Requires migrating state forward on upgrade if there's a pre-existing user-config.
- (b) Detect the silent switch by reading the ExecStart after install and surface a warn-level message:
  "service unit now reads config from `<path>` — old `/root/.config/nvpn/` is orphaned."

Recommend (b) — less invasive, lets the user decide.

### P2.5 — identity field migration on upgrade

When upgrading from 0.3.x to 4.x against an existing config, the daemon either auto-migrates state files
or rejects them. This walkthrough showed it auto-migrates cleanly (no `failed to deserialize` errors), but
that's one data point. The installer should:

- After `service install --force`, probe `nvpn status --json` and verify `status_source: "daemon"`.
- If `"config"` → daemon is up but CLI can't reach it → P0.1 territory; warn and link to docs.
- If status JSON has `npub` / `pubkey` null → identity field migration story is intact (expected in 4.x);
  proceed.

### P2.6 — peer.public_key live-mode emptiness

Already covered by P1.1's peer-identity fallback chain.

### P2.7 — `daemon.state.json.corrupt-*` cleanup

**File**: `src/lib/nvpn-installer.ts` (post-install step)

Observed during the walkthrough: 0.3.12 detected its own state corruption at some point and renamed the
file to `daemon.state.json.corrupt-<pid>-<timestamp>`. These accumulate over time and aren't cleaned up by
upstream. Not from our PR — but the installer is the natural place to opportunistically clean them.

Fix: after a successful `service install --force`, glob for `daemon.state.json.corrupt-*` in
`$config_dir`, keep the most recent (forensics), delete the rest. Cap deletions at e.g. 10 per run for
safety.

## P3 — new surface (UI parity work)

Defer until P0 + P1 land. Each is a separate PR, sequenced for incremental shipping.

### P3.1 — exit-node leak protection warning

Added in upstream v4.0.1. When a configured exit-node is unreachable, the daemon blocks all internet
traffic until it reconnects. Today the dashboard has no awareness.

**Files**: `src/web/app.js:12620-12707` (status strip), `src/web/app.js:13334-13479` (Settings tab)

Fix: when `status.settings.exit_node` is set AND no peer in `status.peers[]` matches it with `reachable:
true`, surface a yellow strip on the Status tab: "Exit-node {alias} is unreachable. Outbound internet is
blocked until it reconnects or you clear the exit-node setting." Settings tab gets an inline hint near
the exit-node dropdown.

Also: expose the new `exit-node-leak-protection` set flag (added to `SETTABLE_KEYS` in PR #154 but not
surfaced anywhere in the UI yet).

### P3.2 — `wg-upstream-test` button

Added in upstream v4.0.16. WireGuard upstream config probe — useful for users running nvpn behind a
Mullvad/Proton-style wg-host setup.

**Files**: `src/lib/routes/nvpn.ts` (new route), `src/web/app.js:13643-13775` (Diagnostics tab)

Fix: new `/api/nvpn/wg-upstream-test` endpoint that runs `nvpn wg-upstream-test --json`, new button in
Diagnostics tab. Pass-through schema — output rendered as inline JSON pretty-print like the other
diagnostics tools.

### P3.3 — service-version mismatch banner

Added in upstream v4.0.19. When the daemon's binary version doesn't match what the GUI expects, upstream
shows a "service-version mismatch" strip in its own UI.

**Files**: `src/lib/routes/nvpn.ts` (new `/api/nvpn/version` route), `src/web/app.js:12554-12609`
(banner rendering, alongside deployment + split-brain banners)

Fix: read `expected_service_binary_version` from `status --json` (new field in 4.x), compare to
`service status --json` `binary_version`. Mismatch → third banner: "Daemon binary v{installed} doesn't
match expected v{expected}. Run `nvpn update` or reinstall." Reinstall action re-runs the per-tool
update flow.

### P3.4 — `peer_count` vs `mesh_ready`

Already covered in P1.1's "Is the mesh up?" mapping change.

## Verification plan

After P0 lands, run this test on a fresh Linux VM **and** on the test VM that already has the 0.3.12→4.0.37
upgrade applied. Both must pass; the dual run catches install-fresh vs upgrade-from-old code paths.

```sh
# 1. status_source check works: pump bogus data and confirm it gets caught
nvpn status --json --config /nonexistent/config.toml > /tmp/forced-config-mode.json
python3 -c "import json; d=json.load(open('/tmp/forced-config-mode.json')); assert d.get('status_source') != 'daemon'"
# Trigger our route, confirm `stale` field is set:
curl -sS http://127.0.0.1:3000/api/nvpn/status -H "Authorization: Bearer $(...)" | jq .stale

# 2. Identity surfaces in /api/nvpn/status:
curl -sS http://127.0.0.1:3000/api/nvpn/status ... | jq '.identity.npub'
# Expected: a real npub1... string. NOT secret_key or anything from [node].

# 3. Roster mutation surfaces published_recipients honestly:
TEST_NPUB="npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm"
curl -sS -XPOST .../api/nvpn/peers/add ... -d '{"participants":["'"$TEST_NPUB"'"],"publish":true}'
# Body should include published_recipients (integer, possibly 0).
curl -sS -XPOST .../api/nvpn/peers/remove ... -d '{"participants":["'"$TEST_NPUB"'"],"publish":true}'

# 4. /api/nvpn/roster/publish returns 200 again (was 501 in PR #154):
curl -sS -XPOST .../api/nvpn/roster/publish ... -w "HTTP %{http_code}\n"
# Expected: HTTP 200 with a body indicating which mechanism we used (reload / connect / re-add).

# 5. Dashboard browser checks:
#    - Status panel: identity displayed? Endpoint shows LAN ip with "private address" warning when applicable?
#    - Status panel: stale-data banner appears if you `sudo systemctl stop nvpn; sleep 5; refresh`?
#    - Service tab: clicking Refresh updates the binary_path and binary_version?
#    - Network tab: no duplicate peer entries when one is rostered + discovered with same tunnel IP?
#    - Network tab: Publish roster button works (200 response)?
```

## Open questions for the implementer

1. **Does `nvpn reload` trigger a republish, or does it just re-read config?** Answer determines whether
   P0.5's restored endpoint can use a clean verb or has to fall back to the "re-add an existing member"
   hack.
2. **What other CLI invocations need `--config` threaded through?** I listed the ones I know about
   (status, service status, doctor, ping, whois, ip, add/remove-participant, add/remove-admin,
   create-invite, import-invite, set). Audit the full `execa(binPath, [...])` call sites in
   `nvpn.ts` and `nvpn-installer.ts` to be sure nothing's missed.
3. **`status.settings.exit_node` — is that the field name?** P3.1 assumes; verify against a live daemon.
   The full settings shape isn't yet enumerated; the agent only verified the top-level keys of
   `status --json`.
4. **Should the identity helper read `[node] public_key` too** (the WireGuard pubkey)? Currently spec'd
   to return only `[nostr] public_key`. The WireGuard pub might be useful in advanced diagnostics, but
   exposing it adds attack surface — skip unless a concrete UI need surfaces.

## Notes for the PR descriptions

**P0 hotfix PR title**: `nvpn 4.x: gate stale status data + restore publish + surface identity`
**P0 PR body must include**:
- Reference to PR #154 — this hotfixes its blind spots.
- Note that the 501 on `/api/nvpn/roster/publish` is being **flipped back to 200** with a new mechanism;
  this is a documented retraction of PR #154's CHANGELOG claim.
- Test plan section: the verification checklist above.
- Specific call-out: the identity helper handles `secret_key` adjacency — point reviewers at the unit
  test that pins the leak-safe shape.

**P1 follow-up PR title**: `nvpn 4.x: dashboard field mapping + render dedup + cache bust`
**P2 follow-up PR title**: `nvpn installer: warn on silent failures + force flags + state cleanup`
**P3 series**: one PR per item; sequence per the order above.
