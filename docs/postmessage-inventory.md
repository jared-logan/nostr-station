# postMessage / iframe boundary inventory

Baseline snapshot of every cross-frame message boundary in the dashboard.
Re-run the audit (`rg "postMessage\(|addEventListener\('message'"
src/web/ src/scaffold-assets/`) on any PR that touches frames and update
this file. Drift between table and reality is the signal a new boundary
landed without an origin-check review.

## Senders (parent → iframe, iframe → parent)

| File:line | Sender | Receiver | `targetOrigin` | Payload shape |
|-----------|--------|----------|----------------|---------------|
| `src/lib/routes/nsite.ts:1048,1050` (injected reporter script) | nsite iframe | `window.parent` and `window.top` | `'*'` — see "Reporter `targetOrigin` posture" below. | `{ type: 'nsite-csp-violation' \| 'nsite-script-error' \| 'nsite-loaded', siteId: '<16hex>', ...details }` |
| `src/lib/web-server-static.ts:390` (`DITTO_PREFIX_STRIP_SCRIPT`) | Ditto iframe (same-origin `/ditto/`) | dashboard parent | `location.origin` (dashboard origin, literal in the script) | `{ type: 'station:open-nsite', url: '<https://...nsite.lol/...>' }` |

Scaffold assets under `src/scaffold-assets/` ship only `.mcp.json` /
`mcp.json` / `opencode.json` — no JS templates, no postMessage
surface.

### Reporter `targetOrigin` posture

The nsite reporter posts with `targetOrigin: '*'`. The same script
template is served in two modes (`src/lib/routes/nsite.ts:1032–1034`):

- **path-prefix mode:** iframe is in an opaque origin (no
  `allow-same-origin`); the parent's origin from inside is observable
  but the targetOrigin must be `'*'` because the iframe cannot
  authenticate the parent.
- **subdomain mode (current preview iframe):** iframe runs at its
  per-sid origin with `allow-same-origin`; the parent dashboard's
  origin is *not* hard-coded into the reporter script today.

The dashboard-side gate added in J5 closes the security-relevant
direction: a hostile parent embedding an nsite iframe cannot trick the
dashboard into accepting forged reports, because the receiver checks
`event.origin` matches `http://<sid>.nsite.localhost:<port>`. The
remaining gap is *outbound* — if a malicious page ever embedded an
nsite iframe, that page would see the CSP-violation / script-error
payloads (siteId + violation details). Acceptable in nostr-station's
threat model (the dashboard is the only thing that frames nsites in
this tool), but flagged here so a future patch tightens the sender
side if the embedding story changes.

## Receivers (`addEventListener('message', …)`)

| File:line | Receiver context | Expected sender origin | Validation in place |
|-----------|------------------|------------------------|---------------------|
| `src/web/app.js` Ditto-panel listener (~19633) | dashboard parent | same-origin Ditto frame (`/ditto/`) | `event.source === frame.contentWindow` **and** `event.origin === location.origin` **and** message-shape check (`m.type === 'station:open-nsite'`) **and** URL host matched against `NSITE_GATEWAY_HOST` regex. |
| `src/web/app.js` nsite-reporter listener (~21212) | dashboard parent | per-sid nsite frame at `http://<sid>.nsite.localhost:<port>` | siteId format gate (`/^[a-f0-9]{16}$/`) → expected origin computed from siteId → `event.origin === expectedOrigin` → tab lookup by siteId. Origin check added in the J5 follow-up; previously trusted message shape only. |

## Iframes hosted by the dashboard

| File:line | Iframe purpose | `src` origin | `sandbox` |
|-----------|---------------|--------------|-----------|
| `src/web/app.js:21146` + `:21131` | nsite content preview (per-sid) | `http://<sid>.nsite.localhost:<port>` (different origin from dashboard) | `allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin` — same-origin is granted **to the iframe's own per-sid origin only**, not the dashboard. SOP isolates the two. |
| `src/web/index.html:237` (`#cp-iframe`) | Live-preview of the user's running dev server | `http://localhost:<dev-port>` (e.g. 5173) — different port = different origin from the dashboard | none |
| `src/web/app.js` Ditto panel (`/ditto/`) | Bundled Ditto client | same-origin (dashboard) | none — required to be same-origin for the bundled-client integration |

### Live-preview posture

The `#cp-iframe` is intentionally unsandboxed. Three reasons:

1. The content is the user's own dev server (e.g. Vite, Next, SvelteKit
   on `localhost:5173`) that they explicitly chose to run. The trust
   boundary is the local user, not the iframe contents.
2. It runs on a different origin from the dashboard (different port),
   so SOP already prevents it from reading the dashboard DOM, cookies,
   or `localStorage`.
3. HMR / WebSocket overlays in modern dev stacks rely on
   `allow-same-origin` + `allow-scripts` + storage / IndexedDB. Adding
   a `sandbox=` attribute that includes both of those flags is
   functionally equivalent to no sandbox; a tighter sandbox breaks HMR.

If the live-preview is ever extended to render *untrusted* third-party
content, this posture must be revisited.

## Invariants future patches must preserve

1. Every `addEventListener('message', …)` in `src/web/` MUST gate on
   `event.origin` against an explicit allowlist before reading any
   field of `event.data`. Message-shape checks alone are insufficient:
   any framed origin can forge the shape.
2. Every new `postMessage(…)` MUST pass a literal `targetOrigin` —
   `location.origin` for same-origin frames, or a known per-sid origin
   for nsite frames. The legacy nsite-reporter `'*'` is documented
   above; do not extend that pattern.
3. No `eval`, no `innerHTML` of message contents, no
   `Object.assign(target, JSON.parse(event.data))`. Treat message
   payloads as opaque structured data and pull out named fields with
   explicit type checks.
4. Sandbox flags on the nsite iframe must keep `allow-same-origin` —
   the per-sid origin is what the SOP isolation depends on. Removing
   it makes the iframe opaque and `event.origin === 'null'`, which
   defeats the receiver gate.
