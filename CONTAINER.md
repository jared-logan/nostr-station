# Running nostr-station in Docker

End-to-end guide for the containerized deployment. If you'd rather install
nostr-station and its services natively on your host, see `README.md` and
the `nostr-station onboard` flow instead — this doc covers the
`docker compose up` path only.

## Quick start

```bash
git clone <this-repo> && cd nostr-station
docker compose up
```

Open `http://localhost:3000` in a browser on the same machine. First run
walks the setup wizard; subsequent runs land on the dashboard.

To stop and reset to first-run state:

```bash
docker compose down -v   # -v wipes named volumes (config, keys, relay db)
```

## Architecture

Three services on a private bridge network (`nostr-net`):

```
       host: 127.0.0.1:3000
              │
              ▼
   ┌──────────────────────┐
   │  station             │   command: node dist/cli.js
   │  (Node 22 + dashboard)│   reads:   STATION_MODE, RELAY_HOST,
   │                      │           WATCHDOG_HEARTBEAT, KEYCHAIN_DIR
   └──────┬───────────────┘
          │  ws://relay:8080 (Docker DNS)
          ▼
   ┌──────────────────────┐    ┌──────────────────────┐
   │  relay               │    │  watchdog            │
   │  (nostr-rs-relay)    │    │  (Node 22 loop)      │
   │                      │    │                      │
   │  no published port   │    │  no published port   │
   └──────────────────────┘    └──────────────────────┘
              ▲                           │
              │   nc probe                │   writes heartbeat
              │   (every 60s)             │   every 60s
              └───────────────────────────┘
```

- **`relay`** — `nostr-rs-relay` 0.8.12. Internal-Docker-only; the relay's
  port 8080 is *not* published to the host. Sibling containers reach it
  via Docker DNS as `relay`.
- **`station`** — the dashboard. The single host-published service:
  `127.0.0.1:3000:3000`, host-loopback only.
- **`watchdog`** — long-lived Node loop probing the relay every 60s and
  writing a heartbeat file the dashboard reads.

## Trust model

The dashboard's auth localhost-exemption requires an explicit trust gate.
In container deployments that gate is the **host port binding**, not the
container's view of the TCP socket.

- The station's port is published as `127.0.0.1:3000:3000`. Only the host
  itself can reach the dashboard — anything from the network is rejected
  by the host kernel.
- Inside the container, the request appears to come from the Docker bridge
  gateway IP (e.g. `172.17.0.1`), *not* `127.0.0.1`. The
  `STATION_MODE=container` env var tells `isLocalhost()` in
  `src/lib/auth.ts` to trust any source IP, because the gate has already
  been enforced upstream.

**Do not change the port binding to `0.0.0.0:3000:3000`.** That widens the
trust boundary to your entire network and lets any LAN host reach a
dashboard with auth disabled.

## Common operations

```bash
# Bring up the station stack
docker compose up                  # foreground, logs streaming
docker compose up -d               # detached

# Stop containers (volumes preserved)
docker compose down

# Stop containers AND wipe named volumes (full reset)
docker compose down -v

# View logs
docker compose logs -f             # all services
docker compose logs -f station     # one service
docker compose logs -f watchdog    # heartbeat ticks

# Rebuild after code changes
docker compose build               # rebuild all images
docker compose build station      # rebuild one
docker compose up -d --build       # rebuild + restart in one step

# Health check
docker compose ps                  # service status
curl http://127.0.0.1:3000/api/status   # JSON status snapshot
```

## Environment variables

The `station` and `watchdog` services read these at startup. All have
defaults; override in compose's `environment:` block as needed.

| Variable | Default | Purpose |
|---|---|---|
| `STATION_MODE` | (unset) | Set to `container` to enable container-aware code paths (auth exemption, status probes, keychain backend). Required for the compose stack to behave correctly. |
| `DEV_HOST` | `127.0.0.1` | Bind address for the dashboard's HTTP listener. Set to `0.0.0.0` inside containers so Docker port-forwarding works. |
| `RELAY_HOST` | `localhost` | Hostname the dashboard probes for relay reachability. In compose, set to `relay` (the service name) for Docker DNS resolution. |
| `RELAY_PORT` | `8080` | Port for the relay reachability probe. |
| `WATCHDOG_HEARTBEAT` | `/var/run/nostr-station/watchdog.heartbeat` | Path the watchdog writes and the dashboard reads to determine watchdog liveness. Both services must have it mounted at the same path. |
| `KEYCHAIN_DIR` | `/var/lib/nostr-station/keys` | Where the file-based keychain stores its encrypted secrets and persisted KEK. Mount as a named volume so secrets survive image rebuilds. |

## Volumes

Four named volumes are created on first `docker compose up`. They survive
`docker compose down`. Wipe them all with `docker compose down -v`.

| Volume | Mounted at | Service(s) | Contents |
|---|---|---|---|
| `relay-data` | `/var/lib/nostr-rs-relay` | relay | SQLite event store + relay config |
| `station-config` | `/root/.nostr-station` | station | identity.json, ai-config.json |
| `keys` | `/var/lib/nostr-station/keys` | station, watchdog | Encrypted-file keychain (watchdog nsec, AI keys) + persisted KEK |
| `watchdog-heartbeat` | `/var/run/nostr-station` | station, watchdog | Heartbeat file (mtime is the liveness signal) |

The `keys` and `watchdog-heartbeat` volumes are intentionally shared
between the station and watchdog services — they need the same view of
those files.

## Keychain in container mode

`STATION_MODE=container` pins the encrypted-file backend (no macOS
Keychain or GNOME secret-tool inside a slim Debian image). The encryption
key (KEK) is generated once and persisted to `${KEYCHAIN_DIR}/.kek` so
secrets survive image rebuilds. They do *not* survive `docker compose
down -v` — that's the deliberate "fresh start" path.

The watchdog's seed nsec is encrypted at rest. CLAUDE.md invariant 1
("no nsec on disk in plaintext") is preserved.

## Watchdog

A long-running Node process replaces the host-OS systemd-timer/launchd
pattern. Single image as the station service, different command:

```yaml
command: ["node", "dist/cli.js", "watchdog", "--loop", "--interval", "60"]
```

It probes the relay every 60s via TCP socket connect (no shell), writes a
JSON heartbeat to `WATCHDOG_HEARTBEAT`, and logs each iteration to stdout
(visible via `docker compose logs watchdog`). SIGTERM (sent by
`docker stop`) interrupts mid-sleep cleanly.

Standalone use without compose:

```bash
node dist/cli.js watchdog                                    # one-shot
node dist/cli.js watchdog --loop                             # 60s interval
node dist/cli.js watchdog --loop --interval 30               # 30s interval
node dist/cli.js watchdog --heartbeat-file /tmp/heart.json   # custom path
```

## Working alongside the codebase

The end-user compose file at the repo root is intentionally slim — three
services, no dev tooling. If you're hacking on nostr-station's source,
you typically want a separate compose file (or compose override) that
adds a sleep-infinity Node container with the repo bind-mounted, so you
can run `npm run dev` against the codebase without rebuilding the
station image on every save. That's a personal-infrastructure decision
and not part of this doc.

## Deferred follow-ups

Two pieces of feature parity with the host-OS deployment remain:

1. **Wizard-side relay config personalization in container mode.** The
   wizard's host-OS path writes `~/.nostr-station/relay/config.toml` with
   the user's npub/contact. The container path doesn't yet — the relay
   currently runs with the static `docker/relay/config.toml` baked into
   the image. Personalization would write into the `relay-data` named
   volume.
2. **DM-on-relay-down in the watchdog.** The host-OS bash watchdog
   publishes a NIP-04 kind-4 DM via `nak event` when the relay is
   unreachable. The JS watchdog logs the down state but doesn't yet
   send a DM — adding it requires NIP-04 encryption and a
   relay-publish path via `nostr-tools`.

Neither blocks daily use of the containerized station.

## Troubleshooting

**Port 3000 already in use** — another container or process is holding
the host port. `lsof -iTCP:3000 -sTCP:LISTEN` to identify; stop it.

**Wizard says "Status unavailable"** — open browser devtools' Network
tab, refresh, and check the `/api/status` row. A 401 means
`STATION_MODE=container` isn't set on the station service. A non-200
non-401 means the API itself errored — check `docker compose logs station`.

**Watchdog row shows red even after compose up** — the heartbeat file
hasn't been written yet (first iteration takes a few seconds), or the
`watchdog-heartbeat` volume isn't shared between the station and
watchdog services. Check `docker compose logs watchdog` for errors.

**Relay row is yellow** — the station container can't reach the relay
container. Verify `RELAY_HOST=relay` (matching the compose service name)
and that both services share the `nostr-net` network.

**Build fails at `cargo install nostr-rs-relay`** — if you see a
`time 0.3.25` compile error, your `Dockerfile.relay` has `--locked` —
remove it. The shipped Cargo.lock for older relay versions pins
transitive deps that don't compile on modern rustc.
