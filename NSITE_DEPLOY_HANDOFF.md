# nsite Deploy + Repo Announcement — Session Handoff

> **Status as of this session:** nsite deploy is shipped and working end-to-end against
> live infra. Repo re-announcement (resurrecting a deleted 30617) works but has two
> open UX/correctness issues likely worth tackling next. Shakespeare's git server
> (`git.shakespeare.diy`) was intermittently **down** during testing, which may explain
> some of the grasp-server misbehavior observed — re-test when it's stable before
> assuming a code bug.

This doc is a context primer for the next Claude Code session. It summarizes what was
built, what's merged, what's verified, and what's still open.

---

## 1. What we set out to do

Add **shakespeare.diy-style nsite deployment** to nostr-station so a project (repo) can be
published to the Nostr network as a live nsite — without leaving nostr-station and without
ever returning to shakespeare.diy. Goal: clone a project, build, deploy, and have it live at
a deterministic nsite URL; redeploying the same project under the same identity + title
updates the same site in place (Shakespeare-compatible).

---

## 2. Architecture (the native deploy pipeline)

Deploy is **native / in-process** — no `nsyte` CLI shell-out. It publishes the same three
event kinds shakespeare.diy does:

| Event | Kind | Purpose |
|---|---|---|
| Upload auth | **24242** (Blossom BUD-02) | ONE batch token: `["t","upload"]`, one `["x",<sha256>]` per blob, 1h `expiration`. Signed once, reused as `Authorization: Nostr <base64>` on every `PUT /upload`. |
| Site manifest | **35128** (NIP-5A v2 named) | `d`=slug, one `["path", "/x", <sha256>]` per file, `server`/`relay` hints, `title`, `description`, `source`, client tag. |
| Repo announce | **30617** (NIP-34) | Existing repo announcement; deploy refreshes its `web` tag to the live nsite URL. |

**Deterministic URL:** `https://<base36(pubkey)><slug>.<gateway>/`
- `base36(pubkey)` = 50-char lowercase base36 of the 32-byte pubkey (NIP-5A named-site host prefix).
- `<slug>` = slugified Site Title (the `d` tag).
- `<gateway>` default `nsite.lol` (gateway-agnostic; only affects the displayed URL + 30617 `web` tag).
- Same identity + same title ⇒ same addressable 35128 ⇒ **same URL**, so it updates in place
  (matches shakespeare.diy).

### Key files
- **`src/lib/blossom-upload.ts`** — external Blossom upload client. `HEAD /<sha>` skip-if-present,
  else `PUT /upload`. One signed 24242 reused across all servers. Partial-failure tolerant
  (a blob is OK once it lands on ≥1 server). Also has `verifyDeployedBlobs()` … **wait, no** —
  see note below; the verify diagnostic was in a CLOSED PR (#215) and is NOT in main.
- **`src/lib/nsite-deploy.ts`** — the pipeline orchestrator: build → walk dir + sha256 +
  SPA-fallback synth (`404.html` = index, `_redirects` `/* /index.html 200`) → 24242 →
  upload → 35128 → 30617 web-tag refresh → compute URL → persist. Signing + relay-publish are
  **injected** (`DeployDeps`) so the module is free of bunker/websocket imports and unit-testable.
  Exports: `pubkeyToBase36`, `slugifyTitle`, `nsiteUrl`, `ngitRemoteDTag`, `resolveBuildDir`,
  `walkBuildDir`, `withSpaFallbacks`, `buildManifestTemplate`, `refreshAnnounceWebTag`, `deployFiles`.
- **`src/lib/routes/projects-nsite-deploy.ts`** — SSE wiring for `POST /api/projects/:id/nsite/deploy`.
  Wires real `signEventWithSavedBunker` + `publishEventToRelays`, runs the build (streamed),
  resolves owner hex + prior 30617, persists `project.nsite.{url,lastDeploy}`. Emits an
  `info:url` SSE frame so the modal can surface the live URL.
- **`src/lib/client-tag.ts`** — single source of truth for the canonical **4-element NIP-89
  `client` tag** (`["client","nostr-station","31990:<pubkey>:nostr-station","wss://relay.nsite.lol"]`).
  Exports `CLIENT_TAG`, `CLIENT_NAME`, `CLIENT_HANDLER_PUBKEY`, `hasNostrStationClientTag`,
  `stampClientTag`. Used by `/api/client` kind-1, 30617 announce, 35128 manifest, and the
  30617 web-tag refresh — so every published event links to the kind-31990 app handler.
- **`src/lib/nsite-config.ts`** — adds deploy-side config: `deployBlossomServers`,
  `deployBlossomAppEnabled`, `deployRelays`, `deployRelayAppEnabled` + `effectiveDeployBlossomServers()`
  / `effectiveDeployRelays()` (App/Your union model, mirroring Client Relays). **Kept distinct
  from the browsing fields** (`contentRelays`/`blossomServers`).
- **`src/lib/nsite-resolver.ts`** — adds `DEFAULT_DEPLOY_BLOSSOM_SERVERS`
  (`blossom.ditto.pub`, `blossom.dreamith.to`, `blossom.primal.net`) and `DEFAULT_DEPLOY_RELAYS`
  (`relay.nsite.lol` first, then ditto/primal/damus/nos.lol).

### Frontend (`src/web/app.js`)
- **Deploy tab** (`renderDeployTab`) — Site Title (defaults to repo name, slugified) +
  optional Description + live predicted-URL preview (base36 computed client-side) + Deploy.
  Streams progress via the exec modal; on success reloads + shows the URL. No provider chooser
  (nsite is the only provider, by design).
- **Config → nsite deploy** section (`paintDeployConfigSection`) — App/Your Blossom servers +
  App/Your relays with toggles, plus "Sync from Nostr" (reads owner's kind-10063 BUD-03 list,
  merge-only; we never publish a 10063). The old nsite section was relabeled **"nsite browsing"**
  to disambiguate read (browse other people's sites) vs. publish (deploy your own).
- **Settings → Nostr remote & signing → Announcement** section — probes the live 30617 and
  offers "Re-announce (refresh metadata)" when present or "Announce now" when missing.
  Reuses the **Edit Repository** modal → `POST /announce`.

---

## 3. Conceptual model — IMPORTANT distinctions

These bit us repeatedly; keep them straight:

1. **Two relay/server families:**
   - **GRASP servers** (`identity.json` → `graspServers`, Config → **Git**): git-over-Nostr
     (NIP-34). Git hosting + a nostr relay at one domain (e.g. `relay.ngit.dev`,
     `git.shakespeare.diy`). Used for `ngit push` and the **kind-30617** announcement's
     `clone`/`relays` tags.
   - **nsite deploy relays + Blossom servers** (`nsite.json` → `deployRelays`/`deployBlossomServers`,
     Config → **nsite deploy**): nsite/Blossom protocol. Where the **kind-35128 manifest + file
     blobs** go. **NOT** the same as grasp servers. Don't cross-wire them.
   - **Browsing config** (`contentRelays`/`blossomServers`, Config → **nsite browsing**):
     read-side, for resolving OTHER people's nsites. Separate again.

2. **git push ≠ announce.** `git push` moves commits to the grasp server. The kind-30617 is a
   separate Nostr event (what lists the repo on gitworkshop/nostrhub). Deleting the announcement
   doesn't touch git; pushing git doesn't recreate the announcement. They're different layers.

3. **The in-process loopback relay (`src/relay/`) + Blossom server (`src/blossom/`) are
   DEV/TEST infra** (controlled in Project Settings alongside Test Users) — NOT deploy targets.
   Deploy always uses external public servers.

4. **`client` tag = "custom tag" in the ecosystem.** gitworkshop.dev and nostrhub.io both
   surface `client` tags in a "Custom tags (advanced)" section and preserve them as editable.
   nostr-station matches this. The 4-element NIP-89 form (links to the app handler) is
   auto-injected on new announcements; pre-existing bare 2-element tags are preserved as-is.
   **This is correct — do not "hide" or force-upgrade the client tag (would diverge from
   ecosystem convention).**

5. **ngit remote shapes:** `nostr://<npub>/<d-tag>` (2-part) OR
   `nostr://<npub>/<relay-host>/<d-tag>` (3-part, e.g. `.../relay.ngit.dev/hello-world`).
   The d-tag is ALWAYS the **last** path segment. Use `ngitRemoteDTag()` — a greedy regex
   bug here once silently broke the web-tag refresh (fixed in #213).

---

## 4. Shipped PRs (all merged to main)

| PR | Status | What |
|---|---|---|
| **#212** | ✅ merged | Native nsite deploy (Blossom upload + 24242/35128/30617), Deploy tab, Config nsite-deploy section, deploy defaults |
| **#213** | ✅ merged | Fix: 30617 web-tag refresh silently skipped on 3-part ngit remotes (greedy regex → `ngitRemoteDTag` last-segment). Canonical NIP-89 client tag extracted to `client-tag.ts`, wired to all publish paths |
| **#214** | ✅ merged | Publish wizard inherits ALL configured GRASP servers (was sending only one). Backend `publish-state` returns `suggestedGraspServers`; wizard field is now multi-line |
| **#215** | ⏹️ **CLOSED, not merged** | Post-deploy asset verification diagnostic — not needed; the "missing styling" turned out to be an app-side theme default, deploy proven correct. `verifyDeployedBlobs` is NOT in main. |
| **#216** | ✅ merged | Re-announce path when the 30617 is missing/deleted. `/repo` returns `hasRemote`; Settings "Announcement" section; About empty-state corrected |
| **#217** | ✅ merged | Re-announce polish: amber marker rendered via `innerHTML` (was literal HTML text); `synthRepoPrefill` inherits full Config→Git grasp list |
| **#218** | ✅ merged | Announce publishes to general read-relays too (was grasp-only → 502 when grasp rejected); frontend reads the 502 body to show per-relay reasons (was dead code) |

Branch naming convention used: `claude/<topic>`. Repo: `jared-logan/nostr-station`.
Develop branch for this work line historically: `claude/wizardly-curie-VDY4R` (#212–#214 era);
later fixes each on their own `claude/*` branch.

---

## 5. What's verified working (live)

- **Test Case 1 (new local project → build → announce/push → deploy):** ✅ PASSED.
  - Deploy produced a correct kind-35128 (all paths + hashes, 3 Blossom servers, 5 relays,
    title/description/source, `client:nostr-station`).
  - Site went live at `https://<base36>hello-world.nsite.lol/`.
  - The "different look when deployed" scare = **app-side theme default**
    (`defaultConfig.theme: "light"` in the app's `src/App.tsx`; the gradient design only renders
    in dark; dev browser had `theme:dark` in localStorage; fresh origin defaulted light).
    NOT a deploy bug. Deploy validated as byte-correct.
- **Re-announce / resurrect a deleted 30617:** ✅ MOSTLY WORKING.
  - After deleting the announcement via nostrhub.io + gitworkshop.dev, "Announce now" in
    Settings republished successfully: toast "Repository updated · **5/9 relays accepted**"
    (the mixed state is expected — relays that honored the NIP-09 delete refused; fresh public
    relays accepted; the new event post-dates the delete so it's spec-compliant resurrection).
  - Showed up on **Ditto timeline** with the **working client tag → app link**. 🎉
  - **gitworkshop.dev**: showed a "funny state" at first, then appeared after ~1 min
    (propagation/caching).

---

## 6. OPEN ISSUES (likely next-session work)

> ⚠️ **Caveat:** `git.shakespeare.diy` was intermittently DOWN during testing. Re-test these
> when it's stable before treating them as code bugs — the symptoms below are consistent with
> an unreachable grasp server.

### 6a. Only ONE grasp server announced, despite the form showing both
- The re-announce form (Edit Repository) showed BOTH `wss://relay.ngit.dev` and
  `wss://git.shakespeare.diy` in the GRASP servers field (the #217 inheritance worked).
- But the resulting 30617 / gitworkshop "About" showed only `relay.ngit.dev` as a grasp server.
- **Hypotheses to check:**
  1. Shakespeare server was down → its relay rejected the publish → only ngit.dev persisted.
     (Most likely given the known outage.)
  2. The announce builder/`/announce` handler collapses or drops grasp servers somewhere
     between the form payload and the emitted `relays`/`clone` tags.
  3. gitworkshop only renders grasp hosts that appear in BOTH `relays` AND `clone` tags
     (its grasp-detection heuristic) — if the clone tag only had one host, only one shows.
- **Where to look:** `src/lib/routes/repo.ts` → `handleAnnounce` + `buildRepoAnnounceTemplate`
  (how `input.clone` / `input.relays` are constructed from the form), and the frontend
  Edit-repo save handler in `src/web/app.js` (how `graspServers` + `otherRelays` collapse into
  the `relays` list and how `clone` URLs are generated — does it generate a clone URL per
  grasp server, or just one?). Compare to `openPublishReview` in app.js which DOES build one
  clone URL per grasp server (per #214).

### 6b. Doubled grasp host in the gitworkshop URL ("Page not found")
- gitworkshop showed: `/jaredlogan@happytavern.co/relay.ngit.dev/relay.ngit.dev/hello-world`
  — note **`relay.ngit.dev/relay.ngit.dev`** doubled.
- This is the repo's `web` tag / clone URL being malformed with a doubled relay-host segment.
- **Hypotheses:**
  1. gitworkshop's own URL-rendering quirk when a grasp server is unreachable (low-stakes, theirs).
  2. A real double-join in our clone/web URL construction — e.g. a `nostr://<npub>/<relay>/<repo>`
     remote getting the relay host concatenated twice when building a clone URL or the web link.
- **Where to look:** clone-URL construction in `src/web/app.js` (`openPublishReview` /
  Edit-repo save → `cloneUrls`) and any `web`-tag building; also `src/lib/routes/repo.ts`
  `buildRepoAnnounceTemplate` for how `clone`/`web` are emitted. Check whether a 3-part remote's
  relay host is being re-prepended to a value that already contains it.

### 6c. nostrhub.io hadn't shown the re-announced repo yet
- As of session end, not appeared on nostrhub.io. Likely caching / relay-set overlap /
  the same shakespeare-down issue. Re-check after propagation + when shakespeare is stable.
  Possibly nothing to fix on our side (publish succeeded to 5/9 relays).

---

## 7. Still UNTESTED

- **Test Case 2 — clone a Shakespeare repo (e.g. NostrVM), tweak, push, re-deploy → confirm
  the live site updates IN PLACE at the same URL and the 30617 web-tag refresh fires.**
  This is the real exercise of the deterministic-URL + web-tag-refresh logic against a repo
  with a pre-existing 30617. Highest-value next test.
- Multi-grasp-server announce once `git.shakespeare.diy` is back up (validates 6a/6b are env, not code).
- Deploy with a custom (non-default) Blossom/relay set in Config → nsite deploy.

---

## 8. Testing / build commands

- Full test suite: `npx tsx --test tests/*.test.ts` (≈1486 pass / 1 skipped = symlink test
  on FS without symlink support).
- Typecheck: `npx tsc --noEmit`.
- Frontend syntax (app.js is plain JS, not tsc'd): `node --check src/web/app.js`.
- Full build (also copies/branding for the Ditto iframe): `npm run build`.
- CI on PRs: `install.sh lint` + `Build + CLI smoke` (both must be green before merge).
- Relevant test files: `tests/nsite-deploy.test.ts`, `tests/blossom-upload.test.ts`,
  `tests/nsite-config.test.ts`, `tests/client-tag.test.ts`, `tests/repo-routes.test.ts`.
- **Testing-posture note:** the route handlers (announce, nsite/deploy) and all of `app.js` are
  I/O-bound / have no JS harness, so they're validated by live click-through, not unit tests.
  Pure helpers (base36, slug, dtag, manifest builders, config union) ARE unit-tested.

---

## 9. Key signing/publishing primitives (for reuse)

- `signEventWithSavedBunker(template, timeoutMs)` — `src/lib/auth-bunker.ts`. Amber/bunker signing.
  All publish flows use this (bunker-only by design).
- `publishEventToRelays(event, relays, timeoutMs?)` — `src/lib/routes/repo.ts`. Per-relay
  OK/reason results.
- `buildRepoAnnounceTemplate(input, prior, signerPubkey)` — `src/lib/routes/repo.ts`. 30617 builder;
  auto-injects the 4-element client tag; carries through unknown prior tags.
- `getGraspServers()`, `getEffectiveReadRelays()` — `src/lib/identity.ts`.
- `queryRelays(...)` — `src/lib/nostr-query.ts` (nak-backed).

---

## 10. TL;DR for next session

nsite deploy works. Re-announce/resurrect works (5/9 relays, live on Ditto with app-linked
client tag). Two open announce-form issues — **only ONE grasp server lands** and a **doubled
relay-host in the gitworkshop URL** — but `git.shakespeare.diy` was DOWN during testing, so
**reproduce with shakespeare up before debugging code.** If they persist, the fix is almost
certainly in how the Edit-repo save handler / `buildRepoAnnounceTemplate` construct the
`clone` and `relays` tags from multiple grasp servers (compare against the working
`openPublishReview` per-server clone-URL logic from #214). Also still owed: **Test Case 2**
(update-in-place re-deploy of a cloned Shakespeare repo).
