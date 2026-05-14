// Join-request bridge.
//
// nvpn 0.3+ supports a peer-initiated "join request" flow per the
// protocol docs (crates/nostr-vpn-core/src/join_requests.rs upstream):
// a new device that imports an admin's invite can submit a request
// that the admin then approves to add to the roster.
//
// We don't know the exact CLI surface — upstream nvpn has renamed
// subcommands across versions and the project's evolving fast. So
// this module tries a small set of plausible names (verb-noun and
// noun-verb variants), and returns `supported: false` when none of
// them work. That way the UI can keep the join-request section hidden
// on nvpn versions that don't expose it yet, instead of red-flagging
// every install with "command not found" toasts.
//
// All three operations follow the same pattern: try variants in order,
// return the first successful result; if every variant errors with an
// exit code that looks like "unrecognized subcommand", report
// `supported: false`. Any other error class (network, daemon down)
// propagates as a normal failure.

import { execa, type ExecaError } from 'execa';
import { findBin } from './detect.js';

export interface JoinRequest {
  // Best-effort wire shape. We pass the daemon's JSON straight through
  // and let the UI render whatever fields it can find — different
  // versions of nvpn have shipped different keys, and we don't want
  // to ratchet on a particular layout.
  npub?:        string;
  pubkey?:      string;
  alias?:       string;
  device_name?: string;
  ts?:          number | string;
  // Pass-through. Keep the whole object so the UI can show any extra
  // metadata (peer-stated network_id, request signature, etc.).
  raw:          Record<string, unknown>;
}

export interface ListJoinRequestsResult {
  supported:   boolean;
  requests:    JoinRequest[];
  raw:         unknown;
  detail:      string;
}

export interface JoinActionResult {
  supported: boolean;
  ok:        boolean;
  detail:    string;
  raw:       unknown;
}

const LIST_VARIANTS    = [
  ['list-join-requests', '--json'],
  ['join-requests',      'list', '--json'],
  ['joinrequests',       'list', '--json'],
];
const APPROVE_VARIANTS = [
  ['approve-join-request', '--json'],
  ['join-requests',        'approve', '--json'],
  ['joinrequests',         'approve', '--json'],
];
const DENY_VARIANTS    = [
  ['deny-join-request',    '--json'],
  ['join-requests',        'deny',    '--json'],
  ['joinrequests',         'deny',    '--json'],
];

function looksLikeUnrecognizedSubcommand(e: ExecaError): boolean {
  // clap (upstream nvpn's CLI lib) emits "unrecognized subcommand" or
  // "Found argument 'X' which wasn't expected" / "error: unrecognized
  // subcommand 'X'" / similar. Match heuristically; falling through to
  // "supported: false" on a false positive is no worse than today
  // (UI hidden + user re-checks the nvpn version manually).
  const stderr = String(e.stderr || '').toLowerCase();
  return (
    stderr.includes('unrecognized subcommand') ||
    stderr.includes('unknown subcommand') ||
    stderr.includes('invalid subcommand') ||
    stderr.includes('was not provided') ||
    /^error:[^\n]*usage:/i.test(stderr)
  );
}

async function tryVariants<T>(
  variants: ReadonlyArray<string[]>,
  extraArgs: string[],
  parse: (stdout: string) => T,
): Promise<{ supported: boolean; ok: boolean; data: T | null; detail: string; raw: unknown }> {
  const binPath = findBin('nvpn');
  if (!binPath) {
    return { supported: false, ok: false, data: null, detail: 'nvpn binary not installed', raw: null };
  }
  let lastErr: ExecaError | null = null;
  for (const v of variants) {
    try {
      const r = await execa(binPath, [...v, ...extraArgs], { timeout: 8000 });
      let parsed: T;
      let raw: unknown = null;
      try { raw = JSON.parse(String(r.stdout)); parsed = parse(String(r.stdout)); }
      catch { parsed = parse(String(r.stdout)); }
      return { supported: true, ok: true, data: parsed, detail: 'ok', raw };
    } catch (e) {
      const err = e as ExecaError;
      if (looksLikeUnrecognizedSubcommand(err)) {
        lastErr = err;
        continue; // try next variant
      }
      // Different class of failure — real error from a recognized subcommand.
      return {
        supported: true, ok: false, data: null,
        detail: String(err.shortMessage || err.message || 'nvpn failed'),
        raw: null,
      };
    }
  }
  return {
    supported: false, ok: false, data: null,
    detail: lastErr ? 'nvpn does not appear to support join-request commands' : 'no nvpn variants matched',
    raw: null,
  };
}

export async function listJoinRequests(): Promise<ListJoinRequestsResult> {
  const r = await tryVariants(LIST_VARIANTS, [], (stdout) => {
    // Pass through any JSON shape — be defensive about keys. Expected
    // shape per protocol docs: { requests: [{ npub, ts, ... }] }.
    let payload: any = null;
    try { payload = JSON.parse(stdout); } catch { /* not JSON, return empty */ }
    const arr = Array.isArray(payload) ? payload
              : Array.isArray(payload?.requests) ? payload.requests
              : Array.isArray(payload?.join_requests) ? payload.join_requests
              : [];
    const out: JoinRequest[] = [];
    for (const x of arr) {
      if (!x || typeof x !== 'object') continue;
      out.push({
        npub:        typeof x.npub === 'string' ? x.npub : undefined,
        pubkey:      typeof x.pubkey === 'string' ? x.pubkey : undefined,
        alias:       typeof x.alias === 'string' ? x.alias : undefined,
        device_name: typeof x.device_name === 'string' ? x.device_name : undefined,
        ts:          (typeof x.ts === 'number' || typeof x.ts === 'string') ? x.ts : undefined,
        raw:         x,
      });
    }
    return out;
  });
  return {
    supported: r.supported,
    requests:  r.data ?? [],
    raw:       r.raw,
    detail:    r.detail,
  };
}

export async function approveJoinRequest(participant: string): Promise<JoinActionResult> {
  const p = (participant || '').trim();
  if (!p) return { supported: true, ok: false, detail: 'missing participant', raw: null };
  const r = await tryVariants(APPROVE_VARIANTS, ['--participant', p], (stdout) => {
    try { return JSON.parse(stdout); } catch { return stdout; }
  });
  return {
    supported: r.supported,
    ok:        r.ok,
    detail:    r.ok ? `approved ${p}` : r.detail,
    raw:       r.raw,
  };
}

export async function denyJoinRequest(participant: string): Promise<JoinActionResult> {
  const p = (participant || '').trim();
  if (!p) return { supported: true, ok: false, detail: 'missing participant', raw: null };
  const r = await tryVariants(DENY_VARIANTS, ['--participant', p], (stdout) => {
    try { return JSON.parse(stdout); } catch { return stdout; }
  });
  return {
    supported: r.supported,
    ok:        r.ok,
    detail:    r.ok ? `denied ${p}`   : r.detail,
    raw:       r.raw,
  };
}
