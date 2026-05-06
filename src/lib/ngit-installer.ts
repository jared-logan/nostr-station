// ngit (Nostr-native git remote) installer.
//
// ngit ships a per-target tarball on github.com/DanConwayDev/ngit-cli
// releases. Asset name: `ngit-v{version}-{rust-target-triple}.tar.gz`,
// containing two binaries: `ngit` (the CLI) and `git-remote-nostr` (the
// git protocol helper that makes `git clone nostr://…` resolve via
// Nostr relays). Both must end up on PATH or `/api/ngit/clone` fails
// at the git-clone step. Download → sha256 verify the tarball →
// extract → `sudo -n install` both into /usr/local/bin.
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

// Walk the extracted tree and locate a binary by exact filename.
// Upstream's tarball layout has shifted between releases (sometimes
// flat, sometimes nested under a versioned directory); a small search
// with a depth cap keeps us robust without scanning the whole
// filesystem. Used to find both `ngit` and `git-remote-nostr` inside
// the extracted tarball — they live next to each other in the same dir.
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

  // Locate both binaries. `ngit` is required; `git-remote-nostr` is
  // required for `git clone nostr://…` (the protocol helper) — the
  // /api/ngit/clone path runs stock `git`, which discovers helpers via
  // PATH lookup of `git-remote-<scheme>`. Refusing to install when
  // either is missing prevents the half-broken state where the CLI
  // works but ngit clones fail with `git-remote-nostr: not found`.
  step('locating binaries');
  const ngitSrc        = findBinaryInTree(tmp, 'ngit');
  const remoteHelperSrc = findBinaryInTree(tmp, 'git-remote-nostr');
  if (!ngitSrc || !remoteHelperSrc) {
    const listing = fs.readdirSync(tmp).join(', ');
    fs.rmSync(tmp, { recursive: true, force: true });
    const missing = [
      !ngitSrc        ? 'ngit'             : null,
      !remoteHelperSrc ? 'git-remote-nostr' : null,
    ].filter(Boolean).join(' + ');
    return fail('locate', `${missing} not found in tarball; root: ${listing}`);
  }
  append(`found ngit=${ngitSrc} helper=${remoteHelperSrc}`);

  // Install both with sudo into /usr/local/bin. `install -m 0755` is
  // POSIX-portable (handles both copy and mode in one step) — no chmod
  // race vs. concurrent shells looking up ngit on PATH. `-n` fails fast
  // when sudo cred cache is empty; we surface it as a soft warn so the
  // user can re-run from their shell with a real prompt.
  const helperDest = '/usr/local/bin/git-remote-nostr';
  const installPair = async (): Promise<{ ok: true } | { ok: false; needsPassword: boolean; stderr: string }> => {
    try {
      // Single sudo invocation for both binaries — one cred-cache hit,
      // one prompt at most, and we never end up with ngit installed
      // but the helper missing.
      await execa(
        'sudo',
        ['-n', 'sh', '-c',
          `install -m 0755 ${ngitSrc} ${destFile} && install -m 0755 ${remoteHelperSrc} ${helperDest}`],
        { stdio: 'pipe', timeout: 15_000 },
      );
      return { ok: true };
    } catch (e: any) {
      const stderr = (e?.stderr?.toString?.() || '').trim();
      const needsPassword = /password is required|sudo:.*required/i.test(stderr);
      return { ok: false, needsPassword, stderr };
    }
  };

  step(`sudo install ngit + git-remote-nostr → /usr/local/bin`);
  const installRes = await installPair();
  if (!installRes.ok) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (installRes.needsPassword) {
      return {
        ok:   false,
        warn: true,
        detail:
          `binaries downloaded — finish with: ` +
          `sudo install -m 0755 ${ngitSrc} ${destFile} && ` +
          `sudo install -m 0755 ${remoteHelperSrc} ${helperDest} ` +
          `(or copy both to any PATH dir). Log: ${logPath}`,
      };
    }
    return fail(
      'install',
      `sudo install failed: ${installRes.stderr.slice(0, 160) || 'unknown'}`,
    );
  }
  append(`install ok: ${destFile}, ${helperDest}`);
  fs.rmSync(tmp, { recursive: true, force: true });

  step('verifying binaries on PATH');
  try {
    await execa('ngit', ['--version'], { stdio: 'pipe', timeout: 5000 });
    append('ngit verify ok');
  } catch (e: any) {
    return fail('verify', `ngit --version failed: ${(e?.message || '').slice(0, 160)}`);
  }
  // `git-remote-nostr` has no --version flag (it's a git protocol
  // helper invoked by git, not a user-facing CLI). Check it's
  // executable via fs instead — `which` would shell out and add
  // nothing over a stat + X_OK check.
  try {
    fs.accessSync(helperDest, fs.constants.X_OK);
    append('helper verify ok');
  } catch (e: any) {
    return fail('verify', `git-remote-nostr not executable at ${helperDest}: ${(e?.message || '').slice(0, 160)}`);
  }

  return { ok: true, detail: `installed ${destFile} + ${helperDest}` };
}
