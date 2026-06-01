// Pure peer reconciliation for the Nostr VPN Network tab. Shared between the
// browser dashboard (app.js) and node unit tests — no DOM, no node built-ins.
//
// The daemon reports discovered peers keyed by HEX pubkey; the config roster
// stores participants as npub. Matching them requires normalizing the
// encoding. Without it, every peer renders TWICE — once as a roster row
// (by npub, "never seen") and once as a discovered row (by hex + IP,
// "discovered (not in roster)") — even though they're the same key. This
// module does the npub↔hex join so there's one row per real peer.

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

// Decode an npub (or pass through a 64-char hex) to lowercase hex. Returns
// null for anything that isn't a recognizable pubkey. The bech32 checksum is
// NOT verified — we only need the payload to MATCH peers, and the daemon /
// config already validated these. Browser- and node-safe.
export function npubToHex(s) {
  if (typeof s !== 'string') return null;
  const v = s.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(v)) return v;          // already hex
  if (!v.startsWith('npub1')) return null;
  const data = v.slice(5);
  const vals = [];
  for (const c of data) {
    const d = BECH32_CHARSET.indexOf(c);
    if (d === -1) return null;
    vals.push(d);
  }
  if (vals.length < 6) return null;
  const payload = vals.slice(0, vals.length - 6);  // drop the 6-char checksum
  let acc = 0, bits = 0;
  const out = [];
  for (const d of payload) {
    acc = (acc << 5) | d;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((acc >>> bits) & 0xff); }
  }
  if (out.length !== 32) return null;              // not a 32-byte pubkey
  return out.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Canonical hex key for a peer-ish object or string (npub or hex).
function hexKey(x) {
  if (!x) return null;
  if (typeof x === 'string') return npubToHex(x);
  return npubToHex(x.pubkey) || npubToHex(x.npub) || null;
}

// Merge config-roster participants (npub strings) with daemon-discovered
// live peers (hex pubkeys) into ONE row per real peer. Join order:
//   1. hex pubkey — the canonical identity, encoding-normalized (npub↔hex);
//   2. tunnel IP — handles the rarer case where a node appears under a
//      different identity in a FIPS-overlay entry vs the roster.
// A live peer with no roster match becomes a "discovered" row; a rostered
// peer with no live match is "never seen". Output shape is unchanged from
// the prior inline implementation: { id, rosterKey, live, alias, connected,
// admin, roster }.
export function mergePeers(rosterParts, rosterAdmins, livePeers, aliases = {}) {
  const adminSet = new Set((rosterAdmins || []).map(s => String(s).toLowerCase()));
  const adminHex = new Set([...adminSet].map(npubToHex).filter(Boolean));
  const aliasLookup = new Map();
  for (const [k, val] of Object.entries(aliases || {})) {
    if (typeof k === 'string' && typeof val === 'string') {
      aliasLookup.set(k.toLowerCase(), val);
      const h = npubToHex(k);
      if (h) aliasLookup.set(h, val);
    }
  }

  const live = livePeers || [];
  const liveByHex = new Map();
  for (const lp of live) {
    const h = hexKey(lp);
    if (h && !liveByHex.has(h)) liveByHex.set(h, lp);
  }

  const out = [];
  const consumed = new Set(); // live peers (by ref) folded into a roster row

  for (const p of (rosterParts || [])) {
    const raw = String(p).toLowerCase();
    const hex = npubToHex(p);
    const lp = (hex && liveByHex.get(hex)) || liveByHex.get(raw) || null;
    if (lp) consumed.add(lp);
    const aliasVal = (hex && aliasLookup.get(hex)) || aliasLookup.get(raw) || null;
    out.push({
      id:        p,
      rosterKey: p,
      live:      lp,
      alias:     aliasVal,
      connected: !!(lp && lp.connected),
      admin:     adminSet.has(raw) || !!(hex && adminHex.has(hex)),
      roster:    true,
    });
  }

  // Live peers with no roster match → "discovered" rows, deduped by hex then
  // IP (the same node can surface as a FIPS-overlay entry + a raw entry).
  const seenHex = new Set(out.map(r => hexKey(r.live)).filter(Boolean));
  const seenIp  = new Set(out.map(r => r.live && (r.live.ip || '').toLowerCase()).filter(Boolean));
  for (const lp of live) {
    if (consumed.has(lp)) continue;
    const h  = hexKey(lp);
    const ip = (lp.ip || '').toLowerCase();
    if (h && seenHex.has(h)) continue;
    if (ip && seenIp.has(ip)) continue;
    if (h) seenHex.add(h);
    if (ip) seenIp.add(ip);
    out.push({
      id:        lp.npub || lp.pubkey || lp.ip || `peer-${out.length}`,
      rosterKey: null,
      live:      lp,
      alias:     (h && aliasLookup.get(h)) || null,
      connected: !!lp.connected,
      admin:     false,
      roster:    false,
    });
  }
  return out;
}
