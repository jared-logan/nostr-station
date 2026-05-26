/**
 * Per-tool update check for pinned-binary installers (nak / ngit / nvpn).
 *
 * These three tools each have a dedicated installer (src/lib/{nak,ngit,nvpn}-installer.ts)
 * that downloads a specific upstream release asset and SHA256-verifies it
 * against versions.ts. Because we control the version we ship, "is an
 * update available?" reduces to: probe the installed binary's --version,
 * parse a semver-shaped substring, compare to COMPONENT_VERSIONS[id].
 *
 * Other tools managed by nostr-station are deliberately NOT in this list:
 *
 *   - claude-code / opencode / nsyte ship as `curl | bash` bootstrappers;
 *     we don't pin a version and can't cheaply check upstream's latest.
 *   - stacks ships via `npm install -g`; same story.
 *   - The relay, watchdog, blossom-server live in-process and ship with
 *     nostr-station itself — updated by the existing self-update path.
 *
 * For those, the user re-runs the install flow if they want to refresh.
 * This module exists specifically so the existing update modal can show
 * pinned-binary upgrades alongside the nostr-station self-update commits.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { findBin } from './detect.js';
import { COMPONENT_VERSIONS } from './versions.js';
import { parseNgitVersion } from './ngit-version.js';

export interface ToolUpdate {
  id:               'nak' | 'ngit' | 'nvpn';
  name:             string;
  /** True when the binary is on PATH. We only flag updates for installed
   *  tools — a fresh-install user finds these via the Status panel's
   *  Install button, not the update modal. */
  installed:        boolean;
  /** Parsed `<bin> --version` output, or null when probe failed. */
  currentVersion:   string | null;
  /** What versions.ts says we ship. */
  pinnedVersion:    string;
  /** True iff installed && current < pinned (semver compare). A user who
   *  manually installed a newer-than-pinned binary will NOT be offered
   *  a downgrade. */
  updateAvailable:  boolean;
  /** SSE endpoint the client POSTs to apply the update. The `?force=1`
   *  query bypasses the installer's "already installed" short-circuit. */
  installEndpoint:  string;
}

interface ToolEntry {
  id:              ToolUpdate['id'];
  name:            string;
  binary:          string;
  versionArgs:     string[];
  installEndpoint: string;
}

// Mirrors the three pinned-binary installers' dispatch routes in
// src/lib/web-server.ts: /api/exec/install/{nak,ngit} stream via SSE,
// /api/setup/nvpn/install streams NDJSON. Both accept ?force=1.
const PINNED_TOOLS: ToolEntry[] = [
  { id: 'nak',  name: 'nak',  binary: 'nak',  versionArgs: ['--version'], installEndpoint: '/api/exec/install/nak'  },
  { id: 'ngit', name: 'ngit', binary: 'ngit', versionArgs: ['--version'], installEndpoint: '/api/exec/install/ngit' },
  { id: 'nvpn', name: 'nvpn', binary: 'nvpn', versionArgs: ['--version'], installEndpoint: '/api/setup/nvpn/install' },
];

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Semver-aware compare: returns -1/0/1 for a vs b. Pre-release suffix
 * (the `-rc.1` in `2.5.0-rc.1`) is ignored — good enough for the
 * "should we offer an update?" decision and matches what parseNgitVersion
 * captures. Returns 0 when either input is not parseable, which makes
 * the update check fail-closed: we won't claim an update is needed
 * unless we can prove current < pinned.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parse = (s: string): [number, number, number] | null => {
    const m = s.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! < pb[i]!) return -1;
    if (pa[i]! > pb[i]!) return  1;
  }
  return 0;
}

function probeVersion(bin: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (val: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch {}
      resolve(val);
    };
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return resolve(null);
    }
    // Some Rust binaries print --version to stderr; concatenate both
    // streams so a single regex pass catches it.
    child.stdout?.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr?.on('data', (b: Buffer) => { out += b.toString(); });
    child.on('error', () => finish(null));
    child.on('close', () => finish(parseNgitVersion(out)));
    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
  });
}

export async function gatherToolUpdates(): Promise<ToolUpdate[]> {
  const results = await Promise.all(PINNED_TOOLS.map(async (t): Promise<ToolUpdate | null> => {
    const pinnedVersion = COMPONENT_VERSIONS[t.id];
    if (!pinnedVersion) return null; // shouldn't happen — versions.ts is the registry
    const binPath = findBin(t.binary);
    if (!binPath) {
      return {
        id:              t.id,
        name:            t.name,
        installed:       false,
        currentVersion:  null,
        pinnedVersion,
        updateAvailable: false,
        installEndpoint: t.installEndpoint,
      };
    }
    // Probe by bin NAME first so the spawn's PATH lookup matches the
    // user's interactive `<bin>` command — same lookup the installer's
    // verifyVersionOnPath uses post-install. findBin's augmentedBinDirs-
    // first walk (detect.ts:11-33) puts ~/.cargo/bin, ~/.local/bin, etc.
    // AHEAD of /usr/local/bin so we catch cargo-installed binaries on
    // fresh setups, but that order can return a shadowing OLD binary
    // even when shell PATH (and `which`) would resolve the NEW one we
    // just installed at /usr/local/bin. That mismatch was what caused
    // the "Worked then came back" report: the installer's verify saw
    // 2.4.3 on shell PATH, but gatherToolUpdates saw an older binary
    // via findBin's curated walk and the pill came back the moment the
    // modal closed. Falling back to the absolute findBin path covers
    // the original use case (Node inherits a restricted PATH, ngit is
    // only findable via our curated dirs).
    let currentVersion = await probeVersion(t.binary, t.versionArgs);
    if (currentVersion === null) {
      currentVersion = await probeVersion(binPath, t.versionArgs);
    }
    const updateAvailable =
      currentVersion !== null && compareSemver(currentVersion, pinnedVersion) < 0;
    return {
      id:              t.id,
      name:            t.name,
      installed:       true,
      currentVersion,
      pinnedVersion,
      updateAvailable,
      installEndpoint: t.installEndpoint,
    };
  }));
  return results.filter((r): r is ToolUpdate => r !== null);
}
