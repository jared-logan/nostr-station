import type { NostrEvent, NostrFilter } from './types.js';

// In-memory NIP-01 filter matching. Used for fan-out to live subscribers
// (the sqlite store handles historical queries with SQL — see store.ts).
//
// The exact match rules are spelled out in NIP-01 §"Communication between
// clients and relays". Briefly:
//   - all top-level conditions are ANDed
//   - within a list (ids, authors, kinds), values are ORed (any match)
//   - tag filters #x match if ANY tag of name x has a value in the list
//   - since / until are inclusive bounds on created_at
//   - limit applies only to historical queries, not live; we ignore it here

export function eventMatchesFilter(ev: NostrEvent, f: NostrFilter): boolean {
  if (f.ids     && !f.ids.includes(ev.id))         return false;
  if (f.authors && !f.authors.includes(ev.pubkey)) return false;
  if (f.kinds   && !f.kinds.includes(ev.kind))     return false;
  if (f.since   !== undefined && ev.created_at < f.since) return false;
  if (f.until   !== undefined && ev.created_at > f.until) return false;

  for (const key of Object.keys(f)) {
    if (!key.startsWith('#') || key.length !== 2) continue;
    const wanted = f[key as `#${string}`];
    if (!Array.isArray(wanted) || wanted.length === 0) continue;
    const tagName = key.slice(1);
    const hit = ev.tags.some(t => t[0] === tagName && wanted.includes(t[1]));
    if (!hit) return false;
  }

  return true;
}

// An event matches a subscription if it matches ANY of the subscription's
// filters (filters within a single REQ are ORed per NIP-01).
export function eventMatchesAny(ev: NostrEvent, filters: NostrFilter[]): boolean {
  return filters.some(f => eventMatchesFilter(ev, f));
}
