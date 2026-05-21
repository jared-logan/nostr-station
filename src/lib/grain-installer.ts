// grain (Go Nostr relay) installer.
//
// grain ships a per-target tarball on github.com/0ceanSlim/grain releases.
// Asset name: `grain-{os}-{arch}.tar.gz` containing one `grain` binary.
// Download → sha256 verify the tarball → extract → drop the binary in
// ~/.nostr-station/bin/grain (no sudo — we own the dir and the binary is
// only ever spawned by the Communities supervisor via absolute path,
// never by the user from a shell).
//
// Why a per-user dir instead of /usr/local/bin like nak / ngit do:
//   - The Communities supervisor spawns N copies of GRAIN, one per
//     community, all from the same path. Hardcoding the absolute path
//     in the supervisor is simpler than re-discovering via PATH every
//     restart, and avoids the case where a user's later sudo install
//     of a different `grain` shadows ours.
//   - Skipping sudo gives a smoother UX for the most common install
//     case (single-user laptop). The tradeoff is no PATH availability
//     for ad-hoc `grain --help` from a shell, which we don't need:
//     anything a user wants to do with grain runs through the
//     dashboard's Communities surface.
//   - augmentedBinDirs() in detect.ts is extended to include the dir,
//     so the existing findBin('grain') call from gatherStatus surfaces
//     the install state in the Status panel with no special-case code.
//
// Shared installer boilerplate (logger, curl-download + sha256 verify)
// lives in ./installer-runtime.ts so nak / ngit / nvpn / grain stay in
// sync on log conventions and download semantics.

import { execa } from 'execa';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { COMPONENT_VERSIONS, BINARY_SHA256 } from './versions.js';
import {
  type InstallResult, type ProgressCallback,
  createInstallLogger, downloadAndVerify,
} from './installer-runtime.js';

export type { InstallResult, ProgressCallback };

// Absolute path where this installer drops the binary, and where the
// Communities supervisor spawns it from. Exported so callers don't
// reinvent the path string (a typo here would surface as "binary not
// found" at supervise time, not at install time).
export function grainBinPath(): string {
  return path.join(os.homedir(), '.nostr-station', 'bin', 'grain');
}

// GRAIN's release-asset naming: grain-{os}-{arch}.tar.gz. Go-style
// (darwin/linux × amd64/arm64), same shape as nak — but a tarball
// rather than a single binary.
function resolveTarget(): { os: string; arch: string; key: string } | null {
  const osName = process.platform === 'darwin' ? 'darwin'
              : process.platform === 'linux'  ? 'linux'
              : null;
  if (!osName) return null;
  const arch = process.arch === 'arm64' ? 'arm64'
            : process.arch === 'x64'   ? 'amd64'
            : null;
  if (!arch) return null;
  return { os: osName, arch, key: `${osName}-${arch}` };
}

// Walk an extracted tree and locate the `grain` binary by exact filename.
// Upstream's tarball layout could shift between releases (sometimes flat,
// sometimes nested under a versioned dir); a small bounded search keeps
// us robust without scanning the whole filesystem. Duplicate of the
// helper in ngit-installer.ts — extracting to installer-runtime.ts is
// the right move once a third installer wants it, not yet.
function findBinaryInTree(rootDir: string, name: string): string | null {
  const stack: string[] = [rootDir];
  let visited = 0;
  while (stack.length > 0 && visited < 128) {
    const dir = stack.pop()!;
    visited++;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && ent.name === name) {
        return full;
      }
    }
  }
  return null;
}

export async function installGrain(
  onProgress: ProgressCallback = () => {},
  opts: { force?: boolean } = {},
): Promise<InstallResult> {
  const target = resolveTarget();
  if (!target) {
    return {
      ok: false,
      detail: `grain isn't published for this platform (${process.platform}/${process.arch}). ` +
              `Supported: linux x64/arm64, macOS x64/arm64.`,
    };
  }

  const log = createInstallLogger('grain', onProgress);
  log.append(`target=${target.key}${opts.force ? ' force=true' : ''}`);

  const destFile = grainBinPath();

  // Short-circuit when already installed at our managed path — unless
  // the caller asked for `force` (the per-tool update flow does so
  // after version-comparing and deciding the on-disk binary needs to
  // be swapped). We probe the well-known path, not $PATH, since we
  // own the binary's location.
  if (!opts.force) {
    log.step('checking for existing install');
    try {
      fs.accessSync(destFile, fs.constants.X_OK);
      log.append('already installed — skipping');
      return { ok: true, detail: 'already installed' };
    } catch { /* fall through to install */ }
  }

  const pinnedVersion = COMPONENT_VERSIONS['grain'];
  if (!pinnedVersion) {
    return log.fail('config', 'no pinned grain version in versions.ts');
  }
  const expectedSha = BINARY_SHA256.grain?.[target.key];
  if (!expectedSha) {
    return log.fail(
      'config',
      `no checksum pinned for grain ${target.key} — refusing unverified install`,
    );
  }

  const tag     = `v${pinnedVersion}`;
  const asset   = `grain-${target.os}-${target.arch}.tar.gz`;
  const url     = `https://github.com/0ceanSlim/grain/releases/download/${tag}/${asset}`;
  const tmp     = `/tmp/grain-install-${Date.now()}`;
  const tarPath = path.join(tmp, 'grain.tar.gz');
  fs.mkdirSync(tmp, { recursive: true });
  log.append(`tmp=${tmp} pinned=${pinnedVersion} sha256=${expectedSha.slice(0, 12)}…`);

  const dl = await downloadAndVerify({
    url, expectedSha, outFile: tarPath, tmpDir: tmp, log,
    toolLabel: 'grain tarball',
    timeoutMs: 120_000,
  });
  if (!dl.ok) return dl.result;

  log.step('extracting tarball');
  try {
    await execa('tar', ['-xzf', tarPath, '-C', tmp], { stdio: 'pipe', timeout: 30_000 });
    log.append(`extract ok, contents: ${fs.readdirSync(tmp).join(', ')}`);
  } catch (e: any) {
    const stderr = e?.stderr?.toString?.() || '';
    fs.rmSync(tmp, { recursive: true, force: true });
    return log.fail('extract', `tar failed: ${stderr.trim().slice(0, 160) || e.message?.slice(0, 160)}`);
  }

  log.step('locating grain binary');
  const grainSrc = findBinaryInTree(tmp, 'grain');
  if (!grainSrc) {
    const listing = fs.readdirSync(tmp).join(', ');
    fs.rmSync(tmp, { recursive: true, force: true });
    return log.fail('locate', `grain not found in tarball; root: ${listing}`);
  }
  log.append(`found grain=${grainSrc}`);

  // Install into ~/.nostr-station/bin/grain. No sudo needed — this is
  // a per-user dir owned by the Node process. Atomic rename via
  // copyFileSync + chmod is fine here because the supervisor only
  // spawns from this path and is not running during install (gatherStatus
  // shows install/no-install state, not running state, for the binary).
  const destDir = path.dirname(destFile);
  log.step(`installing → ${destFile}`);
  try {
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(grainSrc, destFile);
    fs.chmodSync(destFile, 0o755);
    log.append(`install ok at ${destFile}`);
  } catch (e: any) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return log.fail('install', `copy failed: ${(e?.message || '').slice(0, 160)}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  // Verify the binary is executable. GRAIN doesn't ship a `--version`
  // flag (it exits non-zero on unknown args), so we don't try to run
  // it bare here — an X_OK stat is sufficient confirmation, and the
  // first community spawn surfaces any deeper runtime issue with full
  // stdout/stderr in the per-community log buffer.
  log.step('verifying binary');
  try {
    fs.accessSync(destFile, fs.constants.X_OK);
    log.append('verify ok');
  } catch (e: any) {
    return log.fail('verify', `grain not executable at ${destFile}: ${(e?.message || '').slice(0, 160)}`);
  }

  return { ok: true, detail: `installed at ${destFile}` };
}
