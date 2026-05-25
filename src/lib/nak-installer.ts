// nak (Nostr Army Knife) installer.
//
// nak ships as a single Go binary on github.com/fiatjaf/nak releases —
// no tarball, no install-cli subcommand of its own, just a per-target
// asset named `nak-v{version}-{os}-{arch}`. Download → sha256 verify
// (BINARY_SHA256.nak) → drop in a real PATH dir → chmod 0755.
//
// Drop target is /usr/local/bin via `sudo -n install`. Pre-fix the tools
// registry tried `cargo install nak`, which (a) needed Rust on the host
// and (b) installed an unrelated nak crate from crates.io with the same
// name as fiatjaf's tool — exact wrong-package footgun this installer
// avoids.
//
// Shared installer boilerplate (logger, curl-download + sha256 verify)
// lives in ./installer-runtime.ts so nak / ngit / nvpn stay in sync on
// log conventions and download semantics.

import { execa } from 'execa';
import fs from 'fs';
import path from 'path';
import { COMPONENT_VERSIONS, BINARY_SHA256 } from './versions.js';
import {
  type InstallResult, type ProgressCallback,
  createInstallLogger, downloadAndVerify, verifyVersionOnPath,
} from './installer-runtime.js';

export type { InstallResult, ProgressCallback };

// nak's release-asset naming: nak-v{version}-{os}-{arch}. We resolve
// (os, arch) per Node convention and map to the names upstream uses
// (darwin/linux × amd64/arm64).
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

export async function installNak(
  onProgress: ProgressCallback = () => {},
  opts: { force?: boolean } = {},
): Promise<InstallResult> {
  const target = resolveTarget();
  if (!target) {
    return {
      ok: false,
      detail: `nak isn't published for this platform (${process.platform}/${process.arch}). ` +
              `Supported: linux x64/arm64, macOS x64/arm64.`,
    };
  }

  const log = createInstallLogger('nak', onProgress);
  log.append(`target=${target.key}${opts.force ? ' force=true' : ''}`);

  // Short-circuit when already installed and responding — unless the caller
  // asked for `force` (the per-tool update flow does: it has already
  // version-compared and decided we need to overwrite the on-disk binary).
  if (!opts.force) {
    log.step('checking for existing install');
    try {
      await execa('nak', ['--version'], { stdio: 'pipe', timeout: 5000 });
      log.append('already installed — skipping');
      return { ok: true, detail: 'already installed' };
    } catch { /* fall through to install */ }
  }

  const pinnedVersion = COMPONENT_VERSIONS['nak'];
  if (!pinnedVersion) {
    return log.fail('config', 'no pinned nak version in versions.ts');
  }
  const expectedSha = BINARY_SHA256.nak?.[target.key];
  if (!expectedSha) {
    return log.fail(
      'config',
      `no checksum pinned for nak ${target.key} — refusing unverified install`,
    );
  }

  const tag      = `v${pinnedVersion}`;
  const asset    = `nak-${tag}-${target.os}-${target.arch}`;
  const url      = `https://github.com/fiatjaf/nak/releases/download/${tag}/${asset}`;
  const tmp      = `/tmp/nak-install-${Date.now()}`;
  const tmpFile  = path.join(tmp, 'nak');
  const destFile = '/usr/local/bin/nak';
  fs.mkdirSync(tmp, { recursive: true });
  log.append(`tmp=${tmp} pinned=${pinnedVersion} sha256=${expectedSha.slice(0, 12)}…`);

  const dl = await downloadAndVerify({
    url, expectedSha, outFile: tmpFile, tmpDir: tmp, log,
    toolLabel: 'nak binary',
  });
  if (!dl.ok) return dl.result;

  // Install with sudo into /usr/local/bin. `install -m 0755` is
  // POSIX-portable (handles both copy and mode in one step) — no chmod
  // race vs. concurrent shells looking up nak on PATH. `-n` fails fast
  // when sudo cred cache is empty; we surface it as a soft warn so the
  // user can re-run from their shell with a real prompt.
  log.step(`sudo install ${tmpFile} ${destFile}`);
  try {
    await execa('sudo', ['-n', 'install', '-m', '0755', tmpFile, destFile], {
      stdio: 'pipe', timeout: 10_000,
    });
    log.append(`install ok at ${destFile}`);
  } catch (e: any) {
    const stderr = (e?.stderr?.toString?.() || '').trim();
    const needsPassword = /password is required|sudo:.*required/i.test(stderr);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (needsPassword) {
      return {
        ok:   false,
        warn: true,
        detail:
          `binary downloaded — finish with: sudo install -m 0755 ${tmpFile} ${destFile} ` +
          `(or copy to any PATH dir). Log: ${log.logPath}`,
      };
    }
    return log.fail('install', `sudo install failed: ${stderr.slice(0, 160) || (e?.message || '').slice(0, 160)}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  log.step('verifying binary on PATH');
  // See ngit-installer for the rationale — verifyVersionOnPath catches
  // the PATH-shadowing case the old exit-code-only verify missed.
  const shadowResult = await verifyVersionOnPath({
    bin: 'nak', destFile, expectedVersion: pinnedVersion, log,
  });
  if (shadowResult) return shadowResult;

  return { ok: true, detail: `installed at ${destFile}` };
}
