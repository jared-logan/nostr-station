# nsite isolation model

Threat-model note covering what a hostile nsite payload *can* and
*cannot* do when previewed through the dashboard's nsite browser.
Companion to `docs/postmessage-inventory.md` (the cross-frame message
boundary), `SECURITY.md` (the user-facing threat model), and the strict
CSP at `src/lib/routes/nsite.ts:STRICT_NSITE_CSP`.

## Origin model

Each `/api/nsite/resolve` call assigns a fresh 16-hex `siteId` via
`randomBytes(8).toString('hex')` (`src/lib/routes/nsite.ts:174`). The
content is then served from `http://<siteId>.nsite.localhost:<port>` —
a real per-resolve browser origin. `*.localhost` resolves to `127.0.0.1`
under RFC 6761, so it reaches the same loopback socket as the dashboard,
but the browser still treats each distinct subdomain as its own origin
(Secure Context, real `crypto.subtle`, real per-origin
`localStorage` / IndexedDB, real `Origin:` on outbound WebSockets).

**The key property: siteId is random, not content-addressed.** Resolving
the same nsite twice produces different origins. There is no persistent
"this nsite always lives at host X" — each preview session is a fresh
origin and a fresh storage bucket.

## What a hostile nsite can do

Within one preview session, the iframe runs untrusted code from the
nsite author. Under the strict CSP it can:

- execute its own JS / inline scripts (`script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'`);
- store data in its per-origin `localStorage` / IndexedDB;
- open WebSocket connections to loopback and to `wss://` (allowed by the
  CSP `connect-src` clause; the same external relay surface the
  dashboard itself uses);
- register a service worker on its own origin (`worker-src` falls
  through to `script-src 'self'`, which permits same-origin scripts);
- spawn dedicated / shared workers on its own origin.

## What a hostile nsite cannot do

The combination of per-resolve origin + sandbox + CSP + dashboard-side
gates makes the following infeasible:

| Attack | Why it's blocked |
|--------|------------------|
| Read the dashboard's localStorage / session token / DOM | Different origin from the dashboard. SOP blocks cross-origin reads; the iframe sandbox keeps `allow-same-origin` only for its own per-sid origin (`src/web/app.js:21131`). |
| Call `/api/*` on the dashboard from the iframe | The web server returns 404 on `/api/*` paths whose Host is a `*.nsite.localhost` subdomain (`src/lib/web-server.ts:623`). |
| Embed the dashboard in itself and clickjack | `frame-ancestors 'self'` in `STRICT_NSITE_CSP` (`src/lib/routes/nsite.ts:607`) plus the inverse direction (dashboard's CSP) blocks this. |
| Persist code across nsite republishes | Each resolve picks a fresh random `siteId`, so the next visit lands on a different origin with no access to the prior origin's SW / storage. |
| Persist code across dashboard restarts | The `sites` LRU is in-process memory (`src/lib/routes/nsite.ts:280`), so a restart wipes all siteId → pubkey mappings. The next resolve regenerates. |
| Pivot to other nsites by guessing their siteId | siteId is 16 hex (64 bits of entropy); guessing is computationally infeasible, and even if guessed, the attacker iframe is on its own origin and can't open a cross-origin window pointed at another `*.nsite.localhost` in a way that grants the prior page access. |
| Reach private IPs through proxies | `/api/img-proxy` and the future `/api/relay-proxy` both call `isPrivateOrLoopbackHost` (`src/lib/nsite-resolver.ts:881`, `src/lib/img-proxy.ts:68`) and refuse non-public targets. The nsite iframe itself is blocked from `/api/*` anyway (see above). |

## Service workers, specifically

The per-resolve random siteId is the load-bearing control. A service
worker registered by a hostile nsite lives at
`http://<sid>.nsite.localhost:<port>/` with scope `'/'`. That registry
is reachable only from the same origin, and the same origin only exists
until the next resolve. The next resolve assigns a new siteId; the new
origin's SW registry is empty.

We do *not* set `Service-Worker-Allowed: ''` or `worker-src 'none'`
today. Those would block legitimate offline-capable nsites without
materially improving the security posture given the per-resolve origin
model.

If a future change makes siteId stable across resolves (e.g.
content-addressed by manifest hash), this section needs to be revisited:
SW persistence then becomes a real risk and `worker-src 'none'` should
be added to `STRICT_NSITE_CSP`.

## Trusted-nsite escape hatch

The user can mark an author's pubkey as trusted via the dashboard's
nsite panel. For trusted nsites the served CSP is widened
(`buildCspForRequest` in `src/lib/routes/nsite.ts`) — `https:` is added
to most `-src` directives and `'unsafe-eval'` is added to `script-src`.
Trusted nsites still run on their own per-sid origin and still cannot
reach the dashboard's `/api/*` surface; the relaxation only affects what
*external* resources the iframe is permitted to load.

## Reproduction notes (for future audits)

To verify the SW-persistence claim against a real browser:

1. Publish an nsite that registers a service worker:
   `navigator.serviceWorker.register('/sw.js', { scope: '/' });`
2. Resolve it through the dashboard panel, confirm the SW shows up in
   DevTools → Application → Service Workers, scoped to the per-sid
   origin.
3. Close the iframe, resolve the same nsite again. Observe the new
   `siteId.nsite.localhost:<port>` origin in the Address bar.
4. In DevTools → Application → Service Workers, confirm the prior
   origin's SW is unreachable from the new origin (it still exists in
   the browser's SW registry under the old origin, but the new tab
   doesn't load it).
5. Restart `nostr-station`. Confirm the prior siteId is no longer
   served (the dashboard issues a fresh random siteId on the next
   resolve), so any code that was browser-cached against the prior
   origin's SW is functionally orphaned.

The orphan SW eventually gets GC'd by the browser (24h idle is the
Chromium default). Users worried about this can `chrome://serviceworker-internals`
and unregister manually, but the threat — persistent code execution
against the same nsite — is closed by the random-siteId scheme.
