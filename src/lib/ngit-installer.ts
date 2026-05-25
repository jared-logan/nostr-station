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

export async function installNgit(
  onProgress: ProgressCallback = () => {},
  opts: { force?: boolean } = {},
): Promise<InstallResult> {
  const target = resolveTarget();
  if (!target) {
    return {
      ok: false,
      detail: `ngit isn't published for this platform (${process.platform}/${process.arch}). ` +
              `Supported: linux x64/arm64, macOS x64/arm64.`,
    };
  }

  const log = createInstallLogger('ngit', onProgress);
  log.append(`target=${target}${opts.force ? ' force=true' : ''}`);

  // Short-circuit when already installed and responding — unless the caller
  // asked for `force` (per-tool update flow has already version-compared
  // and wants the on-disk binary swapped).
  if (!opts.force) {
    log.step('checking for existing install');
    try {
      await execa('ngit', ['--version'], { stdio: 'pipe', timeout: 5000 });
      log.append('already installed — skipping');
      return { ok: true, detail: 'already installed' };
    } catch { /* fall through to install */ }
  }

  const pinnedVersion = COMPONENT_VERSIONS['ngit'];
  if (!pinnedVersion) {
    return log.fail('config', 'no pinned ngit version in versions.ts');
  }
  const expectedSha = BINARY_SHA256.ngit?.[target];
  if (!expectedSha) {
    return log.fail(
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
  log.append(`tmp=${tmp} pinned=${pinnedVersion} sha256=${expectedSha.slice(0, 12)}…`);

  // Download + verify in one shot. Pre-shared-runtime, this was two
  // ~25-LOC blocks per installer; now both halves come from the same
  // helper so the curl flags and the BEFORE-EXTRACTION verification
  // are consistent across nak / ngit / nvpn.
  const dl = await downloadAndVerify({
    url, expectedSha, outFile: tarPath, tmpDir: tmp, log,
    toolLabel: 'ngit tarball',
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

  // Locate both binaries. `ngit` is required; `git-remote-nostr` is
  // required for `git clone nostr://…` (the protocol helper) — the
  // /api/ngit/clone path runs stock `git`, which discovers helpers via
  // PATH lookup of `git-remote-<scheme>`. Refusing to install when
  // either is missing prevents the half-broken state where the CLI
  // works but ngit clones fail with `git-remote-nostr: not found`.
  log.step('locating binaries');
  const ngitSrc        = findBinaryInTree(tmp, 'ngit');
  const remoteHelperSrc = findBinaryInTree(tmp, 'git-remote-nostr');
  if (!ngitSrc || !remoteHelperSrc) {
    const listing = fs.readdirSync(tmp).join(', ');
    fs.rmSync(tmp, { recursive: true, force: true });
    const missing = [
      !ngitSrc        ? 'ngit'             : null,
      !remoteHelperSrc ? 'git-remote-nostr' : null,
    ].filter(Boolean).join(' + ');
    return log.fail('locate', `${missing} not found in tarball; root: ${listing}`);
  }
  log.append(`found ngit=${ngitSrc} helper=${remoteHelperSrc}`);

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

  log.step(`sudo install ngit + git-remote-nostr → /usr/local/bin`);
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
          `(or copy both to any PATH dir). Log: ${log.logPath}`,
      };
    }
    return log.fail(
      'install',
      `sudo install failed: ${installRes.stderr.slice(0, 160) || 'unknown'}`,
    );
  }
  log.append(`install ok: ${destFile}, ${helperDest}`);
  fs.rmSync(tmp, { recursive: true, force: true });

  log.step('verifying binaries on PATH');
  // verifyVersionOnPath catches the case where install -m succeeded but
  // PATH still resolves to an older ngit at ~/.cargo/bin or ~/.local/bin
  // (the previous "exit code 0" check happily passed that). Returns a
  // warn-shaped result with a "remove the shadow" detail so the modal
  // surfaces an actionable yellow line instead of fake green success.
  const shadowResult = await verifyVersionOnPath({
    bin: 'ngit', destFile, expectedVersion: pinnedVersion, log,
  });
  if (shadowResult) return shadowResult;
  // `git-remote-nostr` has no --version flag (it's a git protocol
  // helper invoked by git, not a user-facing CLI). Check it's
  // executable via fs instead — `which` would shell out and add
  // nothing over a stat + X_OK check.
  try {
    fs.accessSync(helperDest, fs.constants.X_OK);
    log.append('helper verify ok');
  } catch (e: any) {
    return log.fail('verify', `git-remote-nostr not executable at ${helperDest}: ${(e?.message || '').slice(0, 160)}`);
  }

  return { ok: true, detail: `installed ${destFile} + ${helperDest}` };
}
