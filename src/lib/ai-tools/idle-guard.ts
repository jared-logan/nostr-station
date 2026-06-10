/**
 * Idle-timeout guard for streamed provider responses.
 *
 * The SSE chat paths read provider bodies with `reader.read()` in a
 * loop. If the provider connection hangs after headers (proxy eats the
 * stream, provider stalls mid-generation), that read waits forever —
 * the client's chat bubble just spins and the approval session leaks
 * until the browser gives up. fetch() has no built-in inactivity
 * timeout, so this guard supplies one: an AbortSignal whose timer is
 * re-armed on every received chunk. A healthy stream never trips it;
 * a stalled one aborts and surfaces a clear error frame.
 */

export const STREAM_IDLE_TIMEOUT_MS = 60_000;

export interface IdleGuard {
  /** Pass to fetch() so an idle abort kills the connection and any pending read. */
  signal: AbortSignal;
  /** Re-arm the timer — call on every chunk received. */
  touch: () => void;
  /** Stop the timer — call in finally once the stream is done. */
  clear: () => void;
  /** True when the abort came from this guard (vs. some other failure). */
  timedOut: () => boolean;
}

export function makeIdleGuard(idleMs: number = STREAM_IDLE_TIMEOUT_MS): IdleGuard {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  let fired = false;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { fired = true; ac.abort(); }, idleMs);
    timer.unref?.();
  };
  arm();
  return {
    signal: ac.signal,
    touch: arm,
    clear: () => { if (timer) { clearTimeout(timer); timer = null; } },
    timedOut: () => fired,
  };
}

/**
 * Normalize a guard-aborted failure into an actionable message; rethrow
 * anything the guard didn't cause untouched.
 */
export function rethrowIdleAware(e: unknown, guard: IdleGuard, providerName: string): never {
  if (guard.timedOut()) {
    throw new Error(
      `${providerName} stream stalled — no data received for ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s`,
    );
  }
  throw e;
}
