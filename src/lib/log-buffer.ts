// In-memory ring buffer for dashboard log streaming.
//
// The dashboard process doesn't write a log file. The in-process relay
// emits structured events at notable points (event accepted, client
// connected, AUTH success, gating rejection) — we route those through a
// LogBuffer here so the Logs panel can both replay recent history
// (`drain` on connect) and follow new lines as they arrive (`subscribe`).
//
// One buffer per logical channel. The relay channel is the only one
// today; watchdog/vpn channels will hang off the same primitive once
// Phase 2 gives them something to log.

export interface LogLine {
  ts:     number;        // ms epoch
  level:  'info' | 'warn' | 'error';
  text:   string;        // already-formatted, no trailing newline
}

type Listener = (line: LogLine) => void;

export class LogBuffer {
  private ring:      LogLine[]   = [];
  private capacity:  number;
  private listeners: Set<Listener> = new Set();

  constructor(capacity = 500) {
    this.capacity = Math.max(1, capacity);
  }

  push(level: LogLine['level'], text: string): void {
    const line: LogLine = { ts: Date.now(), level, text };
    this.ring.push(line);
    if (this.ring.length > this.capacity) this.ring.shift();
    for (const l of this.listeners) {
      try { l(line); } catch { /* listener faults should not poison the buffer */ }
    }
  }

  // Convenience aliases — keep call sites short. The buffer's name
  // ("event accepted from npub1...") often reads like log4j-style level
  // prefixes, so info/warn/error stays the granularity here.
  info (text: string): void { this.push('info',  text); }
  warn (text: string): void { this.push('warn',  text); }
  error(text: string): void { this.push('error', text); }

  // Snapshot of every line currently in the ring. Caller treats the
  // result as read-only.
  drain(): LogLine[] {
    return this.ring.slice();
  }

  // Live tail. Returns an unsubscribe fn the caller invokes when the
  // SSE response closes (otherwise lines accumulate against a dead
  // socket forever).
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // Test/ops helper — wipe the buffer without flushing listeners.
  clear(): void {
    this.ring = [];
  }

  size(): number {
    return this.ring.length;
  }
}
