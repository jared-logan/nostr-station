/**
 * ngit binary probe — Phase 0 of the ngit-suite expansion.
 *
 * Phases 3 (issues + comments), 4 (status + merge), and 6 (explore) all
 * lean on `ngit` subcommands the user's installed version may or may
 * not actually have:
 *   - `ngit issue_create` / `issue_list` / `issue_status`     (Phase 3)
 *   - `ngit comment`                                          (Phase 3)
 *   - `ngit pr_status` / `pr_merge` / `label` / `set_subject` (Phase 4)
 *
 * Older ngit installs predate some of these. Rather than letting a
 * route handler spawn `ngit pr_merge` and surface a generic "no such
 * subcommand" error to the user, probe `ngit --help` once at startup
 * and let the dashboard feature-detect: hide a button if the local
 * binary doesn't know how to back it, with a clear "your ngit is too
 * old, run `ngit-installer upgrade`" hint.
 *
 * The probe is cached (single resolved Promise reused across calls)
 * so the cost is one spawn at first use, not one spawn per route hit.
 */
import { spawn } from 'child_process';
import { findBin } from './detect.js';

export interface NgitCapabilities {
  installed:   boolean;
  binPath:     string | null;
  /** Semver-ish — first `MAJOR.MINOR.PATCH(-suffix)?` match in --version output. */
  version:     string | null;
  /** Lowercased subcommand names parsed from `ngit --help`. */
  subcommands: Set<string>;
  /** Set when the probe failed unexpectedly (timeout, crash). */
  probeError:  string | null;
}

// ── Pure parser (unit-testable without ngit installed) ────────────────────

/**
 * Parse the "Commands" / "SUBCOMMANDS" section out of `ngit --help`
 * output. Tolerant of both the modern `clap` v4 layout:
 *
 *     Commands:
 *       init     Publish or refresh a kind 30617 …
 *       send     Submit a PR …
 *
 * and the older v3 layout:
 *
 *     SUBCOMMANDS:
 *         init        Publish or refresh …
 *         send        Submit a PR …
 *
 * The section ends at the first blank line OR the first line that
 * starts a new heading (non-whitespace-prefixed text ending with `:`).
 * The `help` pseudo-subcommand is filtered out — every clap binary
 * has it and it adds noise to capability checks.
 */
export function parseNgitHelp(stdout: string): Set<string> {
  const subs = new Set<string>();
  let inSection = false;
  for (const raw of stdout.split('\n')) {
    if (!inSection) {
      // Section opener — case-insensitive, allows trailing colon.
      if (/^\s*(?:SUBCOMMANDS|Commands)\s*:?\s*$/i.test(raw)) {
        inSection = true;
      }
      continue;
    }
    // Blank line ends the section in clap v4.
    if (!raw.trim()) {
      inSection = false;
      continue;
    }
    // A new heading (non-indented and ends with `:`) ends the section
    // in clap v3-style multi-section help.
    if (/^[A-Z][A-Za-z0-9 _-]*:\s*$/.test(raw)) {
      inSection = false;
      continue;
    }
    // Subcommand line: leading whitespace, then an identifier, then
    // either whitespace + description or end-of-line.
    const m = raw.match(/^\s+([a-z][a-z0-9_-]*)(?:\s|$)/);
    if (m && m[1] !== 'help') subs.add(m[1].toLowerCase());
  }
  return subs;
}

/**
 * Extract the version number from `ngit --version` output. Accepts
 * formats like `ngit 2.4.3`, `ngit-cli 2.4.3-rc.1`, or even bare
 * `2.4.3`. Returns null if no semver-shaped substring is found.
 */
export function parseNgitVersion(stdout: string): string | null {
  const m = stdout.match(/(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)/);
  return m ? m[1] : null;
}

// ── Async probe ───────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 5_000;

let cached: Promise<NgitCapabilities> | null = null;

export async function probeNgit(opts?: { force?: boolean }): Promise<NgitCapabilities> {
  if (cached && !opts?.force) return cached;
  cached = doProbe();
  return cached;
}

/** Test seam — drops the memoised promise so the next call re-runs. */
export function resetNgitProbeCache(): void {
  cached = null;
}

async function doProbe(): Promise<NgitCapabilities> {
  const binPath = findBin('ngit');
  if (!binPath) {
    return {
      installed:   false,
      binPath:     null,
      version:     null,
      subcommands: new Set(),
      probeError:  null,
    };
  }
  try {
    const [versionOut, helpOut] = await Promise.all([
      runCmd(binPath, ['--version']),
      runCmd(binPath, ['--help']),
    ]);
    return {
      installed:   true,
      binPath,
      version:     parseNgitVersion(versionOut),
      subcommands: parseNgitHelp(helpOut),
      probeError:  null,
    };
  } catch (e: any) {
    return {
      installed:   true,
      binPath,
      version:     null,
      subcommands: new Set(),
      probeError:  String(e?.message || e).slice(0, 200),
    };
  }
}

function runCmd(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch {}
      if (err) reject(err); else resolve(out);
    };
    // Both streams contribute — clap prints help to stdout but some
    // versions print version banners to stderr. Concatenating keeps
    // the parsers' job simple.
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { out += b.toString(); });
    child.on('error',  (e) => finish(e));
    child.on('close',  () => finish());
    const timer = setTimeout(
      () => finish(new Error(`ngit probe timed out after ${PROBE_TIMEOUT_MS}ms`)),
      PROBE_TIMEOUT_MS,
    );
  });
}

// ── Capability check (used by route handlers + UI gating) ─────────────────

export function hasSubcommand(caps: NgitCapabilities, name: string): boolean {
  return caps.installed && caps.subcommands.has(name.toLowerCase());
}
