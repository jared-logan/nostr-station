/**
 * In-memory approval gate for the chat tool-loop.
 *
 * The provider tool-loop needs to pause stream-mid-flight when a
 * gated tool call arrives, surface the call to the user, and wait
 * for a yes/no — all over a half-duplex HTTP+SSE channel. The
 * server-side state is just a registry of pending approvals keyed
 * by sessionId+approvalId; the client-facing protocol is:
 *
 *   1. SSE stream emits `event: session` with the sessionId.
 *   2. Server emits `event: approval_request` with approvalId + the
 *      tool call to be approved.
 *   3. Client POSTs /api/ai/chat/approve { sessionId, approvalId,
 *      decision: 'approve' | 'reject' }.
 *   4. Server resolves the awaiting Promise; tool-loop continues.
 *
 * Sessions live for the lifetime of one chat turn (one POST to
 * /api/ai/chat) and are cleaned up via finally{} in the loop.
 *
 * Memory bound: each session holds at most a few pending approvals
 * (model emits all tool_use blocks before stop, then waits — we
 * dispatch them serially, so realistically it's one at a time).
 * Stale sessions (client disconnect) are GC'd by the request
 * cleanup; tests verify this.
 */

import crypto from 'crypto';

export type ApprovalDecision = 'approve' | 'reject';

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
}

interface Session {
  approvals: Map<string, PendingApproval>;
}

const SESSIONS = new Map<string, Session>();

export function createSession(): string {
  const sessionId = crypto.randomUUID();
  SESSIONS.set(sessionId, { approvals: new Map() });
  return sessionId;
}

export function destroySession(sessionId: string): void {
  const sess = SESSIONS.get(sessionId);
  if (!sess) return;
  // Reject any still-pending approvals so dangling Promises resolve.
  for (const [, pending] of sess.approvals) {
    pending.resolve('reject');
  }
  SESSIONS.delete(sessionId);
}

/**
 * Reserve a new approvalId in the session. The returned Promise
 * resolves when the client POSTs /api/ai/chat/approve. Caller is
 * responsible for emitting the matching `approval_request` SSE
 * event with the approvalId.
 */
export function awaitApproval(sessionId: string): { approvalId: string; promise: Promise<ApprovalDecision> } {
  const sess = SESSIONS.get(sessionId);
  if (!sess) throw new Error(`unknown session ${sessionId}`);
  const approvalId = crypto.randomUUID();
  const promise = new Promise<ApprovalDecision>(resolve => {
    sess.approvals.set(approvalId, { resolve });
  });
  return { approvalId, promise };
}

/**
 * Resolve a pending approval. Returns true if the approval existed
 * (so the route can return 200) or false if not (404). Idempotent:
 * a second call after resolution returns false.
 */
export function resolveApproval(
  sessionId: string,
  approvalId: string,
  decision: ApprovalDecision,
): boolean {
  const sess = SESSIONS.get(sessionId);
  if (!sess) return false;
  const pending = sess.approvals.get(approvalId);
  if (!pending) return false;
  sess.approvals.delete(approvalId);
  pending.resolve(decision);
  return true;
}

// ── Test-only helpers (also fine to call in prod for diagnostics) ─────────

export function _activeSessionCount(): number {
  return SESSIONS.size;
}

export function _pendingApprovalCount(sessionId: string): number {
  return SESSIONS.get(sessionId)?.approvals.size ?? 0;
}
