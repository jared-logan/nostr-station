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

import { execa } from 'execa';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { COMPONENT_VERSIONS, BINARY_SHA256 } from './versions.js';
import { verifyFileSha256 } from './checksum.js';

export interface InstallResult {
  ok:      boolean;
  detail?: string;
  warn?:   boolean;
}

export type ProgressCallback = (step: string) => void;

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

export async function installNak(onProgress: ProgressCallback = () => {}): Promise<InstallResult> {
  const target = resolveTarget();
  if (!target) {
    return {
      ok: false,
      detail: `nak isn't published for this platform (${process.platform}/${process.arch}). ` +
              `Supported: linux x64/arm64, macOS x64/arm64.`,
    };
  }

  const logPath = path.join(os.homedir(), 'logs', 'nak-install.log');
  const append = (line: string): void => {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, stamped + '\n');
    } catch { /* best-effort */ }
  };
  const step = (msg: string): void => {
    append(`step: ${msg}`);
    onProgress(msg);
  };
  const fail = (stepName: string, reason: string): InstallResult => {
    append(`FAIL ${stepName}: ${reason}`);
    return { ok: false, detail: `${stepName} — ${reason} (log: ${logPath})` };
  };

  append(`target=${target.key}`);

  // Short-circuit when already installed and responding.
  step('checking for existing install');
  try {
    await execa('nak', ['--version'], { stdio: 'pipe', timeout: 5000 });
    append('already installed — skipping');
    return { ok: true, detail: 'already installed' };
  } catch { /* fall through to install */ }

  const pinnedVersion = COMPONENT_VERSIONS['nak'];
  if (!pinnedVersion) {
    return fail('config', 'no pinned nak version in versions.ts');
  }
  const expectedSha = BINARY_SHA256.nak?.[target.key];
  if (!expectedSha) {
    return fail(
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
  append(`tmp=${tmp} pinned=${pinnedVersion} sha256=${expectedSha.slice(0, 12)}…`);

  step(`downloading ${url}`);
  try {
    await execa(
      'curl',
      ['-fsSL', '-o', tmpFile, url],
      { stdio: 'pipe', timeout: 60_000 },
    );
    append(`curl ok`);
  } catch (e: any) {
    const stderr = e?.stderr?.toString?.() || '';
    const exit   = e?.exitCode ?? '?';
    fs.rmSync(tmp, { recursive: true, force: true });
    return fail(
      'download',
      `curl failed (exit ${exit}): ${stderr.trim().slice(0, 160) || 'no stderr'}`,
    );
  }

  step('verifying sha256');
  let verified = false;
  try { verified = verifyFileSha256(tmpFile, expectedSha); }
  catch (e: any) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return fail('checksum', `sha256 read failed: ${(e?.message ?? '').slice(0, 160)}`);
  }
  if (!verified) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return fail(
      'checksum',
      `nak binary SHA256 mismatch (expected ${expectedSha.slice(0, 12)}…) — install aborted`,
    );
  }
  append('sha256 verified');

  // Install with sudo into /usr/local/bin. `install -m 0755` is
  // POSIX-portable (handles both copy and mode in one step) — no chmod
  // race vs. concurrent shells looking up nak on PATH. `-n` fails fast
  // when sudo cred cache is empty; we surface it as a soft warn so the
  // user can re-run from their shell with a real prompt.
  step(`sudo install ${tmpFile} ${destFile}`);
  try {
    await execa('sudo', ['-n', 'install', '-m', '0755', tmpFile, destFile], {
      stdio: 'pipe', timeout: 10_000,
    });
    append(`install ok at ${destFile}`);
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
          `(or copy to any PATH dir). Log: ${logPath}`,
      };
    }
    return fail('install', `sudo install failed: ${stderr.slice(0, 160) || (e?.message || '').slice(0, 160)}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  step('verifying binary on PATH');
  try {
    await execa('nak', ['--version'], { stdio: 'pipe', timeout: 5000 });
    append('verify ok');
  } catch (e: any) {
    return fail('verify', `nak --version failed: ${(e?.message || '').slice(0, 160)}`);
  }

  return { ok: true, detail: `installed at ${destFile}` };
}
