// nvpn (nostr-vpn) installer.
//
// Pre-deletion this lived inside install.ts alongside ten other binary
// installers. The new architecture only needs the one tool, so we extract
// it into its own module — easier to reason about, easier to test, no
// shared lifecycle with the deleted installer registry.
//
// Steps, in order:
//   1. Resolve the Rust-target triple upstream publishes for this host.
//   2. Look up the pinned version + per-target SHA256 in versions.ts.
//   3. Skip if the binary is already on disk and responds to --help.
//   4. Download the exact tag's tarball into a temp dir.
//   5. Verify SHA256 BEFORE extraction (tar can write absolute paths).
//   6. Extract, locate the binary inside the tarball.
//   7. Copy to ~/.cargo/bin/nvpn, chmod 0755, run --help to confirm exec.
//   8. nvpn init (best-effort — keypair may already exist).
//   9. sudo -n nvpn service install (needed for auto-start; warn-not-fail
//      on cred-cache miss so the user gets a usable binary either way).
//
// Logs every step to ~/logs/nvpn-install.log so a TUI/SSE consumer can
// drop the connection without losing the post-mortem trail.

import { execa } from 'execa';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { COMPONENT_VERSIONS, BINARY_SHA256 } from './versions.js';
import { verifyFileSha256 } from './checksum.js';
import { getCargoBin, getNvpnTarget } from './detect.js';

export interface InstallResult {
  ok:       boolean;
  detail?:  string;
  // True when the binary itself is installed and runnable but the
  // optional `sudo nvpn service install` step (auto-start) didn't
  // complete — typically a missing sudo cred cache. The caller treats
  // this as a soft failure: status row stays warn instead of err.
  warn?:    boolean;
}

export type ProgressCallback = (step: string) => void;

export async function installNostrVpn(onProgress: ProgressCallback = () => {}): Promise<InstallResult> {
  const cargoBin = getCargoBin();
  const target   = getNvpnTarget();
  if (!target) {
    return {
      ok: false,
      detail: `nvpn is not published for this platform (${process.platform}/${process.arch}). ` +
              `Supported: linux x64/arm64, macOS arm64.`,
    };
  }

  const logPath = path.join(os.homedir(), 'logs', 'nvpn-install.log');
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

  const nvpnBin = path.join(cargoBin, 'nvpn');
  append(`target=${target} cargoBin=${cargoBin}`);

  // Short-circuit when already installed. `nvpn status --json` would be
  // wrong here — it talks to the daemon and exits non-zero when
  // disconnected, forcing a reinstall every time the user re-ran the
  // wizard on a working install.
  step('checking for existing install');
  try {
    await execa(nvpnBin, ['--help'], { stdio: 'pipe', timeout: 5000 });
    append('already installed — skipping');
    return { ok: true, detail: 'already installed' };
  } catch { /* fall through to install */ }

  const pinnedVersion = COMPONENT_VERSIONS['nvpn'];
  if (!pinnedVersion) {
    return fail('config', 'no pinned nvpn version in versions.ts');
  }
  const expectedSha = BINARY_SHA256.nvpn?.[target];
  if (!expectedSha) {
    return fail(
      'config',
      `no checksum pinned for nvpn ${target} — refusing unverified install`,
    );
  }

  const tag     = `v${pinnedVersion}`;
  const url     = `https://github.com/mmalmi/nostr-vpn/releases/download/${tag}/nvpn-${target}.tar.gz`;
  const tmp     = `/tmp/nvpn-install-${Date.now()}`;
  const tarPath = path.join(tmp, 'nvpn.tar.gz');
  fs.mkdirSync(tmp, { recursive: true });
  append(`tmp=${tmp} pinned=${pinnedVersion} sha256=${expectedSha.slice(0, 12)}…`);

  step(`downloading ${url}`);
  try {
    const { stdout: httpCode } = await execa(
      'curl',
      ['-fsSL', '-o', tarPath, '-w', '%{http_code}', url],
      { stdio: 'pipe', timeout: 60_000 },
    );
    append(`curl ok, http=${httpCode || '?'}`);
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
  try { verified = verifyFileSha256(tarPath, expectedSha); }
  catch (e: any) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return fail('checksum', `sha256 read failed: ${(e?.message ?? '').slice(0, 160)}`);
  }
  if (!verified) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return fail(
      'checksum',
      `nvpn tarball SHA256 mismatch (expected ${expectedSha.slice(0, 12)}…) — install aborted`,
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

  // Locate the binary. Upstream has moved it in/out of an `nvpn/` subdir
  // across releases; probe both layouts and log whatever's there if neither
  // matches.
  step('locating binary');
  let binSrc = path.join(tmp, 'nvpn');
  if (!fs.existsSync(binSrc) || fs.statSync(binSrc).isDirectory()) {
    const nested = path.join(tmp, 'nvpn', 'nvpn');
    if (fs.existsSync(nested) && !fs.statSync(nested).isDirectory()) {
      binSrc = nested;
    } else {
      const listing = fs.readdirSync(tmp).join(', ');
      fs.rmSync(tmp, { recursive: true, force: true });
      return fail('locate', `nvpn binary not found in tarball; root: ${listing}`);
    }
  }
  append(`found binary at ${binSrc}`);

  step(`copying to ${nvpnBin}`);
  try {
    fs.mkdirSync(cargoBin, { recursive: true });
    fs.copyFileSync(binSrc, nvpnBin);
    fs.chmodSync(nvpnBin, 0o755);
    append('copy ok, mode=0755');
  } catch (e: any) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return fail('copy', `copy to ${nvpnBin} failed: ${(e?.message ?? '').slice(0, 160)}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  step('verifying binary');
  try {
    await execa(nvpnBin, ['--help'], { stdio: 'pipe', timeout: 5000 });
    append('verify ok');
  } catch (e: any) {
    const stderr = e?.stderr?.toString?.() || '';
    return fail('verify', `${nvpnBin} --help failed: ${stderr.trim().slice(0, 160) || (e?.message ?? '').slice(0, 160)}`);
  }

  // nvpn init — best-effort. Upstream subcommand spelling has shifted
  // between releases; try --yes first, fall back to a stdin-newline.
  step('nvpn init');
  try {
    await execa(nvpnBin, ['init', '--yes'], { stdio: 'pipe', timeout: 10_000 });
    append('init --yes ok');
  } catch {
    try {
      await execa(nvpnBin, ['init'], {
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000, input: '\n',
      });
      append('init (stdin-newline) ok');
    } catch (e: any) {
      append(`init skipped: ${(e?.message || '').slice(0, 120)}`);
    }
  }

  // System service install — writes /Library/LaunchDaemons (macOS) or
  // /etc/systemd/system (linux). `sudo -n` fails fast if the cred cache
  // is empty. The dashboard runs in an SSE response, no TTY for a sudo
  // prompt — the user has to have run a sudo command in the same shell
  // session shortly beforehand for this to succeed.
  step('sudo nvpn service install');
  try {
    const { stdout, stderr } = await execa(
      'sudo', ['-n', nvpnBin, 'service', 'install'],
      { stdio: 'pipe', timeout: 30_000 },
    );
    append(`service install ok; stdout=${stdout.slice(0, 120)} stderr=${stderr.slice(0, 120)}`);
    return { ok: true, detail: `installed ${nvpnBin}` };
  } catch (e: any) {
    const stderr = (e?.stderr?.toString?.() || '').trim();
    const needsPassword = /password is required|sudo:.*required/i.test(stderr);
    append(`service install FAILED: ${stderr.slice(0, 240) || (e?.message || '').slice(0, 240)}`);

    const nextStep = needsPassword
      ? `run \`sudo ${nvpnBin} service install\` when ready for auto-start — or start on demand with \`${nvpnBin} start --daemon\``
      : `rerun \`sudo ${nvpnBin} service install\` to retry (error: ${stderr.slice(0, 100) || 'unknown'}) — or start manually with \`${nvpnBin} start --daemon\``;

    return {
      ok:     false,
      warn:   true,
      detail: `binary installed — ${nextStep} (log: ${logPath})`,
    };
  }
}
