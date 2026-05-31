# nostr-vpn deployment guide

nvpn is a Tailscale-style mesh that uses Nostr as its control plane and
WireGuard as its data plane. The control plane wants reachable Nostr
relays; the data plane wants a reachable UDP endpoint. Whether you have
both depends on where you run nostr-station.

This guide covers the three common topologies, how to verify each layer
works, and the gotchas that bit real users.

## Topologies

### 1. Cloud VM with a public IP (happy path)

A small DigitalOcean / Hetzner / Fly / EC2 droplet with a public IPv4 and
no inbound firewall on UDP `51820` (or whatever port nvpn picks).

- The VM's public IP is what nvpn advertises as its endpoint.
- Other peers dial that endpoint directly.
- No NAT traversal, no port-forwarding. Just works.

If you're new to nostr-station + nvpn, this is the deployment to try
first — it eliminates every layer that the other topologies have to
fight.

### 2. Home server behind a router

A box on your home LAN — a NUC, a Raspberry Pi, a spare laptop — with no
public IP of its own.

- Your home router's WAN IP is what other peers will reach.
- You need a **UDP port-forward** rule on the router pointing
  `WAN:51820 → LAN-IP:51820`.
- nvpn's STUN discovery should learn the WAN address automatically and
  publish it. Verify on the dashboard once nvpn is running.

If you're behind carrier-grade NAT (CGNAT), you don't actually have a
reachable WAN — peers will only connect when NAT traversal hole-punches
through, which is best-effort. Switch to topology #1 if you can.

### 3. Container or VM on a developer machine

A Docker container, OrbStack VM, LXC container, or anything similar
running on your laptop or workstation.

- The container/VM is behind its own NAT *inside* your machine.
- Your machine is behind your home router's NAT.
- That's two NATs to traverse, even before you reach the public
  internet.
- nvpn's STUN discovery might learn your home's public IP correctly, but
  packets arriving at that public IP have to be forwarded through your
  router → host → container before they reach the daemon.

Expect to set up port-forwarding at every layer:

- **Router → host**: UDP port-forward rule for `51820` pointing at your
  developer machine's LAN IP.
- **Host → container**:
  - **Docker**: `-p 51820:51820/udp` when you run the container.
  - **OrbStack VM**: VMs are reachable from the host via `.orb.local`,
    but inbound from the host's external interface is not automatic.
    `socat` on macOS works:
    ```
    sudo socat -dd UDP4-LISTEN:51820,reuseaddr,fork UDP4:<vm-name>.orb.local:51820
    ```
  - **LXC**: similar — the container's UDP socket isn't exposed on the
    host's external interface by default.

This is the worst-case topology. Reasonable for development; painful for
"deploy this and forget it."

## Verifying each layer

Run these from inside the host nvpn lives on (the cloud VM, home box, or
container).

### Is the daemon running?

```
ps -eo pid,user,cmd | grep -E '[n]vpn'
sudo systemctl status nvpn.service
```

You want exactly one daemon process. If you see two (one user-mode, one
systemd-managed), you have a split-brain — see
[issue #58](https://github.com/jared-logan/nostr-station/issues/58).

### What endpoint did nvpn discover?

```
nvpn status --json
```

Look for `endpoint`, `listen_port`, and any `public_endpoint` /
`external_endpoint` fields. The endpoint is what other peers will dial.

If it's an RFC1918 address (`10.x.x.x`, `192.168.x.x`, `172.16-31.x.x`)
or a private container range, no peer outside your local network will
reach you. nvpn should learn a public IP via STUN — confirm with `curl
-4 ifconfig.me` from the host that it matches your actual public IP.

### Is the UDP listener bound?

```
sudo ss -nupl 'sport = :51820'
```

Note: nvpn may bind the WireGuard socket **on demand** — only when an
active peer is negotiating. If `ss` is empty but `nvpn status --json`
reports a successful STUN discovery, the daemon did bind transiently and
closed when idle. Not a problem.

### Are packets actually arriving from the public internet?

```
sudo tcpdump -i any -n udp port 51820
```

Then from any network outside your LAN (your phone on cell data, a cloud
shell, a friend's box):

```
nc -u <your-public-ip> 51820
```

Type something, press Enter. If tcpdump sees the packet land on the host,
your end-to-end forwarding chain is open. If it doesn't, one of the hops
(router, host, container) is dropping it.

### Are relays accepting publishes?

```
sudo tail -100 /root/.config/nvpn/daemon.log
```

(For user-mode daemons: `~/.config/nvpn/daemon.log`.)

Look for `rate-limited`, `504`, `403`, or `Policy violated`. Each is a
specific failure mode — see "Common failure modes" below.

## Container-specific gotchas

### Route-cache flush permission denied

Logs like:

```
Cannot open "/proc/sys/net/ipv4/route/flush": Permission denied
```

These are expected inside LXC and similar container runtimes —
`/proc/sys` is read-only from the container's namespace, regardless of
capabilities. `CAP_NET_ADMIN` doesn't override procfs restrictions
imposed by the runtime.

Benign. The route flush is only needed when re-routing on tunnel
changes; the tunnel still comes up.

### Interface named `utun100` on Linux

`utun` is the macOS utun(4) driver convention. nvpn naming its Linux
interface `utun100` is cosmetic and harmless on Linux (which doesn't
care about names), but it hints at a Darwin-first code path. Track via
upstream issue if your tunnel never actually creates the interface.

### nvpn binds the UDP listener on demand, not at startup

If you check `ss` or `tcpdump` and see nothing, that may just be the
daemon idle. STUN discovery still happened (look for the public endpoint
in `nvpn status --json`), and the listener will open when an actual peer
starts negotiating.

## Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `peers[*].error: "no signal yet"` indefinitely | Phone/laptop on a disjoint relay set, or peer not actually emitting presence | Verify relay overlap between station and peer; check peer is actively connected, not just configured |
| `peers[*].reachable: false` after presence is seen | Station's published endpoint isn't reachable from peer's network | Run the tcpdump test; fix the port-forward chain |
| `event not published: rate-limited` against `relay.damus.io` | Default relay set includes rate-limiting relay | See [issue #54](https://github.com/jared-logan/nostr-station/issues/54) — use the dashboard's "Use recommended" button or manually replace damus.io |
| `504 Gateway Timeout` against `relay.snort.social` | Flaky upstream default | Remove from relay list |
| `Policy violated and pubkey is not in our web of trust` against a relay | WoT-filtered relay (e.g., offchain.pub) | Remove from relay list — your nvpn pubkey can't authenticate |
| Two `nvpn` processes running (user + systemd) | Split-brain install state | See [issue #58](https://github.com/jared-logan/nostr-station/issues/58) |
| Dashboard reports "running" + tunnel IP but no peer ever connects | Daemon-claimed state doesn't match kernel state | Read `daemon.log` directly; see [issue #56](https://github.com/jared-logan/nostr-station/issues/56) |

## A working "is mine reachable?" checklist

If you want to confirm a fresh deployment end-to-end:

1. `nvpn status --json` reports `session_status: "Connected"`,
   `relay_connected: true`, no error-severity entries in `health[]`.
2. `daemon.log` shows STUN succeeded against a stun server and learned a
   public endpoint.
3. The discovered public endpoint matches `curl -4 ifconfig.me`.
4. From an external network, `nc -u <endpoint> <port>` produces packets
   visible to `tcpdump` on the host.
5. The dashboard's Relays tab lists at least three working relays (use
   the "Use recommended" button for the curated set).
6. Any peer you've added to the roster either shows online or has a
   coherent error message like "presence received, handshake failing"
   rather than just "offline."

If all six are green, your station is ready to host a mesh.

## nvpn 4.x behavioural notes

The pinned binary jumped from 0.3.12 → 4.0.37 in the 2026-05-19 release,
and now tracks the 4.0.x line (current pin 4.0.48). Two behaviours
changed at the 4.x boundary that aren't bugs but will surprise users
coming from older docs or older installs.

### Exit-node leak protection (v4.0.1+)

If you set an exit-node via the Settings tab (`nvpn set --exit-node
<npub>`), the daemon will now **block all outbound internet traffic on
the host whenever that exit-node is unreachable**. This is the secure
default — without it, traffic would silently leak around the tunnel
when the exit-node drops — but it also means a flaky exit-node will
appear as "the whole box has no internet."

If you're running nostr-station on a headless server and don't actually
want exit-node routing, **leave exit-node unset**. Clearing it
afterwards is `nvpn set --exit-node ""` (empty string). You can also
opt out explicitly with `nvpn set --exit-node-leak-protection false`,
which restores the pre-4.0.1 "best-effort" behaviour.

### MagicDNS aliases for unnamed peers (v4.0.29+)

Previously, every roster member got an auto-generated `.nvpn` alias
even when no `[peer_aliases]` entry existed. As of v4.0.29 the daemon
**no longer invents aliases for unnamed members** — devices without an
explicit alias resolve only by tunnel IP.

If you rely on `ssh peer.nvpn` shortcuts, set the alias explicitly:
either via the dashboard's Peers tab (the "alias" button on each peer
row) or by adding to the `[peer_aliases]` block in
`~/.config/nvpn/config.toml`:

```toml
[peer_aliases]
npub1aaa... = "alice"
npub1bbb... = "bob"
```

Existing aliased peers are unaffected.

### CLI surface changes (operator-relevant)

Several CLI verbs were removed in the 4.x redesign. Most users won't
notice because the dashboard wraps them, but if you've been driving
nvpn from shell scripts:

| Removed | Replacement |
|---|---|
| `nvpn publish-roster` | Each mutation auto-publishes via its own `--publish` flag (now default-on in the dashboard's roster API). |
| `nvpn netcheck` | Coverage folded into `nvpn doctor --json`. |
| `nvpn nat-discover` | Daemon runs STUN periodically; see `public_endpoint` / `nat.public_endpoint` in `nvpn status --json`. |
| `nvpn stats` | The `relay-for-others` mode this counted was dropped from the FIPS mesh redesign. |
| `nvpn set --relay <url>` (bulk) | No CLI replacement upstream — edit `[[networks]] relays = […]` in `config.toml` directly, or use the native app. The dashboard's GET `/api/nvpn/relays` still reads correctly; mutations return `501 Not Implemented`. |
| `nvpn init --yes` | Renamed to `nvpn init --force`. The installer was updated in lockstep. |

## Why a containerized node shows "0 online"

A station node behind NAT (OrbStack VM, Docker, home box with no
port-forward) frequently sits at "0 peers online." nvpn fails quietly, so
the dashboard's **nostr-vpn → Diagnostics → Connectivity diagnosis** panel
(auto-run, read-only) names the actual cause. The three common ones:

### Wrong network (the usual culprit)

nvpn assigns each node a **deterministic** mesh IP — there is no
admin-assigned IPAM. From the protocol spec:

```
ip = 10.44.(SHA256(network_id + "\n" + pubkey_hex)[0] % 254 + 1)
          .(SHA256(network_id + "\n" + pubkey_hex)[1] % 254 + 1)
```

Because the IP is a pure function of `(network_id, pubkey)`, the same npub
showing **three different IPs** across config.toml, the live `utun`
interface, and the admin's roster means three different `network_id`s are in
play — i.e. the node activated a *separate* network instead of joining the
intended one. Fix: **Join by ID** with the mesh's exact `network_id`
(Network tab), then restart nvpn so the interface re-derives its IP. The
diagnosis computes the expected IP for every configured network and tells
you which one your live IP actually belongs to.

**Watch for a non-canonical id.** The daemon hashes the stored `network_id`
*literally*, so an id that picked up a separator — e.g. `abcd-1234` instead
of the canonical `abcd1234` — derives a different (wrong) IP and never
converges. Two `[[networks]]` records that canonicalize to the same id
(`abcd1234` + `abcd-1234`) are a **forked duplicate** of one mesh. The
diagnosis flags both.

To fix it without hand-editing TOML, use **Repair network config** (the
button appears on the diagnosis when a fork / non-canonical id is found). It
**previews first** — showing exactly which blocks it drops, the id it
canonicalizes, and the old→new IP — then, on confirm, **backs up**
`config.toml` and rewrites it to a single canonical network. A network-
identity change needs a full **Restart** (brief interface drop), which the
repair prompts for. Joining a network by id already stores the canonical
form, so new forks can't be created.

### Behind NAT with no relay neighbour

nvpn routes directly when possible and **relays through a reachable FIPS
neighbour when direct UDP is blocked** — but only if such a neighbour
exists. A node advertising a private endpoint (`endpoint =
"192.168.x.y:51820"`) that STUN can't lift to a public mapping, with an
empty `[fips_peer_endpoints]`, has no bootstrap path and stays unreachable.

There are no public default bootstrap relays, so "any device, anywhere"
needs *one* mesh node with a reachable endpoint (a public-IP / port-forwarded
box, or a LAN peer the NATed node can reach) to relay through. Once one
exists, point at it:

```
nvpn set --fips-peer-endpoint npub1theirnode…=<reachable-host>:51820
```

nostr-station surfaces the missing-relay state and the private-endpoint
warning; it can't itself *be* the public relay — that's an upstream / infra
concern, the same way Tailscale's DERP relays are infrastructure someone
runs.

### Lonely roster

A roster with only your own node usually means a join didn't adopt the
admin's network. Re-join with the exact `network_id`, or if you're the
admin, add peers / share an invite.
