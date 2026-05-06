// ngit (Nostr-native git remote) installer.
//
// ngit ships a per-target tarball on github.com/DanConwayDev/ngit-cli
// releases. Asset name: `ngit-v{version}-{rust-target-triple}.tar.gz`,
// containing the `ngit` binary (and on some releases, a sibling
// `git-remote-nostr`). Download → sha256 verify the tarball → extract →
// `sudo -n install` into /usr/local/bin/ngit.
//
// Pre-fix the tools registry tried `cargo install ngit`, which required
// Rust on the host; install.sh deliberately skips Rust, so the Status
// panel "Install" button always failed at the prereq check with
// "cargo not found on PATH". This installer avoids the toolchain
// dependency entirely — same security model as nak-installer.ts:
// pinned version + pinned sha256, hard-fail on mismatch, no curl|sh.

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

// ngit's release-asset naming follows Rust target triples, not Go-style
// {os}-{arch}. Mac is a single universal binary that runs on both Intel
// and Apple Silicon, so darwin maps to one triple regardless of arch.
// Linux uses gnu (glibc ≥ 2.17) — covers every modern distro; the musl
// variant exists upstream but isn't pinned until we hear from Alpine.
function resolveTarget(): string | null {
  if (process.platform === 'darwin') {
    return 'universal-apple-darwin';
  }
  if (process.platform === 'linux') {
    if (process.arch === 'x64')   return 'x86_64-unknown-linux-gnu.2.17';
    if (process.arch === 'arm64') return 'aarch64-unknown-linux-gnu.2.17';
    return null;
  }
  return null;
}

// Walk the extracted tree and locate the ngit binary. Upstream's
// tarball layout has shifted between releases (sometimes flat, sometimes
// nested under a versioned directory); a small search with a depth cap
// keeps us robust without scanning the whole filesystem.
function findNgitBinary(rootDir: string): string | null {
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
      } else if (ent.isFile() && ent.name === 'ngit') {
        return full;
      }
    }
  }
  return null;
}

export async function installNgit(onProgress: ProgressCallback = () => {}): Promise<InstallResult> {
  const target = resolveTarget();
  if (!target) {
    return {
      ok: false,
      detail: `ngit isn't published for this platform (${process.platform}/${process.arch}). ` +
              `Supported: linux x64/arm64, macOS x64/arm64.`,
    };
  }

  const logPath = path.join(os.homedir(), 'logs', 'ngit-install.log');
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

  append(`target=${target}`);

  // Short-circuit when already installed and responding.
  step('checking for existing install');
  try {
    await execa('ngit', ['--version'], { stdio: 'pipe', timeout: 5000 });
    append('already installed — skipping');
    return { ok: true, detail: 'already installed' };
  } catch { /* fall through to install */ }

  const pinnedVersion = COMPONENT_VERSIONS['ngit'];
  if (!pinnedVersion) {
    return fail('config', 'no pinned ngit version in versions.ts');
  }
  const expectedSha = BINARY_SHA256.ngit?.[target];
  if (!expectedSha) {
    return fail(
      'config',
      `no checksum pinned for ngit ${target} — refusing unverified install`,
    );
  }

  const tag      = `v${pinnedVersion}`;
  const asset    = `ngit-${tag}-${target}.tar.gz`;
  const url      = `https://github.com/DanConwayDev/ngit-cli/releases/download/${tag}/${asset}`;
  const tmp      = `/tmp/ngit-install-${Date.now()}`;
  const tarPath  = path.join(tmp, 'ngit.tar.gz');
  const destFile = '/usr/local/bin/ngit';
  fs.mkdirSync(tmp, { recursive: true });
  append(`tmp=${tmp} pinned=${pinnedVersion} sha256=${expectedSha.slice(0, 12)}…`);

  step(`downloading ${url}`);
  try {
    await execa(
      'curl',
      ['-fsSL', '-o', tarPath, url],
      { stdio: 'pipe', timeout: 120_000 },
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

  // Verify BEFORE extracting — tar can write absolute paths or symlinks
  // that escape the destination, so we never let an unverified tarball
  // touch disk beyond the single download path we control.
  step('verifying sha256');
  let verified = false;
  try { verified = verifyFileSha256(tarPath, expectedSha); }
  catch (e: any) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return fail('checksum', `sha256 read failed: ${(e?.message ?? '').slice(0, 160)}`);
  }
  if (!verified) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return fail(
      'checksum',
      `ngit tarball SHA256 mismatch (expected ${expectedSha.slice(0, 12)}…) — install aborted`,
    );
  }
  append('sha256 verified');

  step('extracting tarball');
  try {
    await execa('tar', ['-xzf', tarPath, '-C', tmp], { stdio: 'pipe', timeout: 30_000 });
    append(`extract ok, contents: ${fs.readdirSync(tmp).join(', ')}`);
  } catch (e: any) {
    const stderr = e?.stderr?.toString?.() || '';
    fs.rmSync(tmp, { recursive: true, force: true });
    return fail('extract', `tar failed: ${stderr.trim().slice(0, 160) || e.message?.slice(0, 160)}`);
  }

  step('locating binary');
  const binSrc = findNgitBinary(tmp);
  if (!binSrc) {
    const listing = fs.readdirSync(tmp).join(', ');
    fs.rmSync(tmp, { recursive: true, force: true });
    return fail('locate', `ngit binary not found in tarball; root: ${listing}`);
  }
  append(`found binary at ${binSrc}`);

  // Install with sudo into /usr/local/bin. `install -m 0755` is
  // POSIX-portable (handles both copy and mode in one step) — no chmod
  // race vs. concurrent shells looking up ngit on PATH. `-n` fails fast
  // when sudo cred cache is empty; we surface it as a soft warn so the
  // user can re-run from their shell with a real prompt.
  step(`sudo install ${binSrc} ${destFile}`);
  try {
    await execa('sudo', ['-n', 'install', '-m', '0755', binSrc, destFile], {
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
          `binary downloaded — finish with: sudo install -m 0755 ${binSrc} ${destFile} ` +
          `(or copy to any PATH dir). Log: ${logPath}`,
      };
    }
    return fail('install', `sudo install failed: ${stderr.slice(0, 160) || (e?.message || '').slice(0, 160)}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  step('verifying binary on PATH');
  try {
    await execa('ngit', ['--version'], { stdio: 'pipe', timeout: 5000 });
    append('verify ok');
  } catch (e: any) {
    return fail('verify', `ngit --version failed: ${(e?.message || '').slice(0, 160)}`);
  }

  return { ok: true, detail: `installed at ${destFile}` };
}
