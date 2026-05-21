// Module-level handle on the in-process relay's EventStore so route
// handlers can ask the local store for already-materialized data (e.g.
// kind-0 profiles) before falling back to remote relays. Avoids the
// import cycle that would result from routes/* importing web-server.ts
// directly.
//
// Lifecycle: web-server.ts calls setLocalStore() once the in-process
// relay has booted, and clears it again on shutdown. Routes call
// getLocalStore() at request time and tolerate a null result (older
// installs may opt out of the in-process relay).
import type { EventStore } from '../relay/store.js';

let store: EventStore | null = null;

export function setLocalStore(s: EventStore | null): void {
  store = s;
}

export function getLocalStore(): EventStore | null {
  return store;
}
