#!/usr/bin/env node
// Publish nostr-station's NIP-89 kind-31990 "client handler" event so
// other Nostr clients can resolve the coordinate baked into the
// 4-element client tags emitted by:
//   - the Ditto iframe (scripts/fetch-ditto.mjs → buildDittoConfig.client)
//   - the native /api/client publish path (src/lib/routes/client.ts:CLIENT_TAG)
//
// Both surfaces emit:
//   ["client", "nostr-station",
//    "31990:291c75d937a45f66a1209f8ea6611df7448c59b3526520c66ca2cdcd37f1bfbe:nostr-station",
//    "wss://relay.nsite.lol"]
//
// Until a kind-31990 with d="nostr-station" from that pubkey is
// reachable on a relay, NIP-89-aware clients fall back to displaying
// just the bare name "nostr-station" (graceful degradation — same
// outcome as today, no broken UI). Publishing this event turns those
// tags into clickable, rich-rendered attribution cards.
//
// Usage:
//   # Default: dry-run. Prints the unsigned event template + the naddr1
//   # it will resolve to. Safe with no env vars set.
//   npm run publish-client-handler
//
//   # Sign + publish. NOSTR_STATION_NSEC must be the bech32 nsec1...
//   # for the project pubkey (291c75d…). The script refuses to
//   # publish if the derived pubkey doesn't match — a typo can't
//   # accidentally publish under the wrong identity.
//   NOSTR_STATION_NSEC=nsec1... npm run publish-client-handler -- --publish
//
// kind-31990 is a NIP-33 addressable event (parameterized replaceable):
// re-publishes with the same (pubkey, kind, d-tag) replace the previous
// version. Safe to re-run after content edits.

import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { hexToBytes } from 'nostr-tools/utils';
import WebSocket from 'ws';

// ─── Constants ─────────────────────────────────────────────────────
// Project identity — same pubkey used by CLIENT_TAG and the
// scripts/fetch-ditto.mjs `client` naddr. Hard-coded so a wrong nsec
// can't ship the event under a different identity.
const EXPECTED_PUBKEY = '291c75d937a45f66a1209f8ea6611df7448c59b3526520c66ca2cdcd37f1bfbe';
const D_TAG    = 'nostr-station';
// Project's dedicated nsite (nsyte form: base36(pubkey) + project name).
// Same pubkey publishes other nsites at the bare-npub form, so the
// project-name-suffixed URL is what we hand out as the canonical
// "nostr-station" page. tests/nsite-resolver.test.ts already pins
// this resolution.
const NSITE_URL = 'https://10vy5d0umw8izp3bcmh0btzl6k2szvsu8zestncxpsstb6l8e6nostr-station.nsite.lol';
const REPO_URL  = 'https://github.com/jared-logan/nostr-station';
// Icon URL. Served from GitHub raw rather than the nsite so it stays
// reachable regardless of whether the nsite is currently published /
// reachable / has the asset at that path. NIP-89-aware clients fetch
// this directly to render the handler card; a 404 here means clients
// fall back to a placeholder icon.
const PICTURE_URL = 'https://raw.githubusercontent.com/jared-logan/nostr-station/main/src/web/nori.svg';

// Relays we publish to. Mirrors the App Relays default list in
// scripts/fetch-ditto.mjs's buildDittoConfig() plus the nsite relay
// (which is the relay hint baked into the client tag).
const PUBLISH_RELAYS = [
  'wss://relay.nsite.lol',
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.ditto.pub',
];

const PUBLISH_TIMEOUT_MS = 8_000;

function buildTemplate() {
  // Content is a NIP-01 profile-shaped JSON, per NIP-89's recommendation
  // that handler info reuse kind-0 metadata fields. NIP-89-aware
  // clients render `name`, `display_name`, `about`, `picture`, and
  // optionally surface `website`.
  const content = JSON.stringify({
    name:         'nostr-station',
    display_name: 'nostr-station',
    about:        'Nostr-native dev environment — one-command relay, mesh VPN, ngit, AI assistant, Stacks. Public Nostr client powered by Ditto.',
    website:      NSITE_URL,
    picture:      PICTURE_URL,
  });
  return {
    kind: 31990,
    created_at: Math.floor(Date.now() / 1000),
    content,
    tags: [
      ['d', D_TAG],
      // Kinds this client handles (drives "open in nostr-station"
      // affordances in NIP-89-aware UIs). Matches what the Client
      // panel + native /api/client surface support:
      //   1     — short text notes
      //   6     — reposts
      //   7     — reactions
      //   1111  — NIP-22 comments
      ['k', '1'],
      ['k', '6'],
      ['k', '7'],
      ['k', '1111'],
      // ─── Rich-card `a` references ─────────────────────────────────
      // NIP-89-aware clients (Ditto in particular) render `a` tags
      // pointing at other addressable events by the same author as
      // action buttons on the handler card. Reference Ditto's own
      // kind-31990 for the pattern: they ship `a` tags for their
      // nsite (kind-35128) → "Run" button + their ngit repo
      // (kind-30617) → "Fork" button.
      //
      // Both coordinates below resolve under the same project pubkey:
      //   35128:291c75d…:nostr-station → the dedicated nsite at
      //     10vy5d0umw8izp3bcmh0btzl6k2szvsu8zestncxpsstb6l8e6nostr-station.nsite.lol
      //   30617:291c75d…:nostr-station → nostr-station's NIP-34
      //     repository announcement (published via ngit)
      // If either event isn't currently reachable on a relay the
      // client just skips rendering its button — no broken UI,
      // graceful degradation.
      ['a', `35128:${EXPECTED_PUBKEY}:${D_TAG}`],
      ['a', `30617:${EXPECTED_PUBKEY}:${D_TAG}`],
      // Topic tag — surfaces this handler in topic-discovery feeds
      // (e.g. "Nostr clients tagged #nostr-dev"). Ditto uses a
      // single `t` tag for the same purpose.
      ['t', 'nostr-dev'],
      // NB: `web` URI-template tags intentionally omitted. NIP-89 lets
      // a handler declare a URL pattern for opening nevent/naddr/etc.,
      // but nostr-station is a local dashboard — there is no public
      // web URL that takes a {bech32} path and dispatches it. Until
      // the nsite (or some other surface) grows that handler,
      // claiming it would 404 anyone who clicks through.
      // Repo for source-level provenance — NIP-89 doesn't formalize
      // a `r` (reference) tag here, but several clients (notably
      // Coracle, Nostrudel) read it.
      ['r', REPO_URL, 'source'],
    ],
  };
}

function naddrFor(pubkey) {
  return nip19.naddrEncode({
    kind: 31990,
    pubkey,
    identifier: D_TAG,
    relays: ['wss://relay.nsite.lol'],
  });
}

async function publishToRelay(relayUrl, event) {
  return new Promise((resolve) => {
    let done = false;
    const ws = new WebSocket(relayUrl);
    const finish = (result) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch {}
      resolve({ relayUrl, ...result });
    };
    const t = setTimeout(() => finish({ ok: false, reason: 'timeout' }), PUBLISH_TIMEOUT_MS);
    ws.on('open', () => {
      ws.send(JSON.stringify(['EVENT', event]));
    });
    ws.on('message', (m) => {
      try {
        const msg = JSON.parse(m.toString());
        if (msg[0] === 'OK' && msg[1] === event.id) {
          clearTimeout(t);
          finish({ ok: msg[2] === true, reason: msg[3] || (msg[2] ? 'accepted' : 'rejected') });
        }
      } catch {}
    });
    ws.on('error', (e) => {
      clearTimeout(t);
      finish({ ok: false, reason: 'err:' + e.message });
    });
  });
}

async function main() {
  const publish = process.argv.includes('--publish');
  const template = buildTemplate();

  console.log('— nostr-station kind-31990 client handler —');
  console.log(`d-tag       : ${D_TAG}`);
  console.log(`pubkey      : ${EXPECTED_PUBKEY}`);
  console.log(`naddr1      : ${naddrFor(EXPECTED_PUBKEY)}`);
  console.log(`mode        : ${publish ? 'PUBLISH' : 'dry-run (pass --publish to actually send)'}`);
  console.log('');
  console.log('event template:');
  console.log(JSON.stringify(template, null, 2));

  if (!publish) {
    console.log('');
    console.log('Re-run with `--publish` and NOSTR_STATION_NSEC set to broadcast.');
    return;
  }

  const nsec = process.env.NOSTR_STATION_NSEC;
  if (!nsec) {
    console.error('');
    console.error('ERROR: --publish requires NOSTR_STATION_NSEC=nsec1...');
    process.exit(1);
  }

  let sk;
  try {
    const decoded = nip19.decode(nsec);
    if (decoded.type !== 'nsec') throw new Error(`expected nsec, got ${decoded.type}`);
    sk = decoded.data;
  } catch (e) {
    console.error(`ERROR: invalid NOSTR_STATION_NSEC — ${e.message}`);
    process.exit(1);
  }

  const derivedPk = getPublicKey(sk);
  if (derivedPk !== EXPECTED_PUBKEY) {
    console.error('');
    console.error(`ERROR: nsec derives to ${derivedPk}`);
    console.error(`       but this handler must be signed by ${EXPECTED_PUBKEY}.`);
    console.error('       Refusing to publish under a mismatched identity.');
    process.exit(1);
  }

  const signed = finalizeEvent(template, sk);
  console.log('');
  console.log(`signed event id: ${signed.id}`);
  console.log(`publishing to ${PUBLISH_RELAYS.length} relays…`);

  const results = await Promise.all(PUBLISH_RELAYS.map(r => publishToRelay(r, signed)));
  let oks = 0;
  for (const r of results) {
    const marker = r.ok ? '✓' : '✗';
    console.log(`  ${marker} ${r.relayUrl} — ${r.reason}`);
    if (r.ok) oks++;
  }
  console.log('');
  console.log(`Done — accepted by ${oks}/${results.length} relays.`);
  if (oks === 0) {
    console.error('No relays accepted the event. Inspect output above.');
    process.exit(2);
  }
}

main().catch(e => {
  console.error(`Unexpected error: ${e.message}`);
  process.exit(1);
});
