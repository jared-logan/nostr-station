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
import path from 'path';
import { COMPONENT_VERSIONS, BINARY_SHA256 } from './versions.js';
import { getCargoBin, getNvpnTarget } from './detect.js';
import { applyLinuxCapsDropIn, seedFreeMagicDnsPort } from './nvpn.js';
import {
  type InstallResult, type ProgressCallback,
  createInstallLogger, downloadAndVerify,
} from './installer-runtime.js';

export type { InstallResult, ProgressCallback };

export async function installNostrVpn(
  onProgress: ProgressCallback = () => {},
  opts: { force?: boolean } = {},
): Promise<InstallResult> {
  const cargoBin = getCargoBin();
  const target   = getNvpnTarget();
  if (!target) {
    return {
      ok: false,
      detail: `nvpn is not published for this platform (${process.platform}/${process.arch}). ` +
              `Supported: linux x64/arm64, macOS arm64.`,
    };
  }

  const log = createInstallLogger('nvpn', onProgress);
  const nvpnBin = path.join(cargoBin, 'nvpn');
  log.append(`target=${target} cargoBin=${cargoBin}${opts.force ? ' force=true' : ''}`);

  // Short-circuit when already installed. `nvpn status --json` would be
  // wrong here — it talks to the daemon and exits non-zero when
  // disconnected, forcing a reinstall every time the user re-ran the
  // wizard on a working install. `force` (per-tool update flow) bypasses
  // this — the caller already version-compared and wants the binary swapped.
  if (!opts.force) {
    log.step('checking for existing install');
    try {
      await execa(nvpnBin, ['--help'], { stdio: 'pipe', timeout: 5000 });
      log.append('already installed — skipping');
      return { ok: true, detail: 'already installed' };
    } catch { /* fall through to install */ }
  }

  const pinnedVersion = COMPONENT_VERSIONS['nvpn'];
  if (!pinnedVersion) {
    return log.fail('config', 'no pinned nvpn version in versions.ts');
  }
  const expectedSha = BINARY_SHA256.nvpn?.[target];
  if (!expectedSha) {
    return log.fail(
      'config',
      `no checksum pinned for nvpn ${target} — refusing unverified install`,
    );
  }

  const tag     = `v${pinnedVersion}`;
  const url     = `https://github.com/mmalmi/nostr-vpn/releases/download/${tag}/nvpn-${target}.tar.gz`;
  const tmp     = `/tmp/nvpn-install-${Date.now()}`;
  const tarPath = path.join(tmp, 'nvpn.tar.gz');
  fs.mkdirSync(tmp, { recursive: true });
  log.append(`tmp=${tmp} pinned=${pinnedVersion} sha256=${expectedSha.slice(0, 12)}…`);

  const dl = await downloadAndVerify({
    url, expectedSha, outFile: tarPath, tmpDir: tmp, log,
    toolLabel: 'nvpn tarball',
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

  // Locate the binary. Upstream has moved it in/out of an `nvpn/` subdir
  // across releases; probe both layouts and log whatever's there if neither
  // matches.
  log.step('locating binary');
  let binSrc = path.join(tmp, 'nvpn');
  if (!fs.existsSync(binSrc) || fs.statSync(binSrc).isDirectory()) {
    const nested = path.join(tmp, 'nvpn', 'nvpn');
    if (fs.existsSync(nested) && !fs.statSync(nested).isDirectory()) {
      binSrc = nested;
    } else {
      const listing = fs.readdirSync(tmp).join(', ');
      fs.rmSync(tmp, { recursive: true, force: true });
      return log.fail('locate', `nvpn binary not found in tarball; root: ${listing}`);
    }
  }
  log.append(`found binary at ${binSrc}`);

  log.step(`copying to ${nvpnBin}`);
  try {
    fs.mkdirSync(cargoBin, { recursive: true });
    fs.copyFileSync(binSrc, nvpnBin);
    fs.chmodSync(nvpnBin, 0o755);
    log.append('copy ok, mode=0755');
  } catch (e: any) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return log.fail('copy', `copy to ${nvpnBin} failed: ${(e?.message ?? '').slice(0, 160)}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  log.step('verifying binary');
  try {
    await execa(nvpnBin, ['--help'], { stdio: 'pipe', timeout: 5000 });
    log.append('verify ok');
  } catch (e: any) {
    const stderr = e?.stderr?.toString?.() || '';
    return log.fail('verify', `${nvpnBin} --help failed: ${stderr.trim().slice(0, 160) || (e?.message ?? '').slice(0, 160)}`);
  }

  // Relocate to a real PATH directory via upstream's install-cli
  // subcommand. Pre-fix the binary lived only at ~/.cargo/bin/nvpn,
  // which isn't on PATH on a fresh Ubuntu (no Rust toolchain seeds
  // the cargo env), so the user could see "✓ installed" in the
  // dashboard but `which nvpn` returned nothing in their shell. Run
  // with `sudo -n` so it fails fast on an empty cred cache; on
  // failure we fall back to keeping the cargo-bin copy and warn —
  // the binary still works via absolute path.
  // 4.x: `install-cli` refuses to overwrite an existing binary unless
  // `--force` is passed. Without --force on the upgrade path, the new
  // binary lands in ~/.cargo/bin/ but the system-PATH copy stays
  // stale — `which nvpn` keeps resolving to the old version. Pass
  // --force on opts.force so the relocation actually replaces the
  // old binary; first-install paths still pass through without the
  // flag (no existing binary → no-op anyway).
  log.step('sudo nvpn install-cli');
  const installCliArgs = opts.force
    ? [nvpnBin, 'install-cli', '--force']
    : [nvpnBin, 'install-cli'];
  let installCliFailed = false;
  let installCliErrDetail = '';
  try {
    await execa('sudo', ['-n', ...installCliArgs], { stdio: 'pipe', timeout: 10_000 });
    log.append('install-cli ok — binary placed on PATH');
  } catch (e: any) {
    const stderr = (e?.stderr?.toString?.() || '').trim();
    installCliErrDetail = stderr.slice(0, 160) || (e?.message || '').slice(0, 120);
    log.append(`install-cli FAILED: ${installCliErrDetail}`);
    installCliFailed = true;
  }

  // Update path stops here: every remaining step is first-run setup
  // (keypair init, drop-in caps, magic-dns-port seed) that's either
  // idempotent-but-noisy or actively rewrites system state we don't
  // want to touch on a binary refresh. We DO re-run service install
  // --force so the systemd unit's ExecStart picks up the new
  // canonical PATH; without that, the unit keeps pointing at
  // whatever path the original `service install` saw (typically
  // ~/.cargo/bin/nvpn), which is fine until cargo bin gets cleaned.
  if (opts.force) {
    const restartHint = process.platform === 'darwin'
      ? 'sudo launchctl kickstart -k system/com.github.nvpn'
      : 'sudo systemctl restart nvpn';

    // service install --force on the upgrade path. Best-effort: if
    // sudo cred cache is empty it fails fast and we surface that via
    // the warn flag below. 4.x supports the --force flag (verified
    // against the v4.0.37 help output).
    log.step('sudo nvpn service install --force');
    let serviceInstallFailed = false;
    let serviceInstallErr = '';
    try {
      const { stdout } = await execa(
        'sudo', ['-n', nvpnBin, 'service', 'install', '--force'],
        { stdio: 'pipe', timeout: 30_000 },
      );
      log.append(`service install --force ok; stdout=${stdout.slice(0, 240)}`);
    } catch (e: any) {
      const stderr = (e?.stderr?.toString?.() || '').trim();
      serviceInstallErr = stderr.slice(0, 160) || (e?.message || '').slice(0, 120);
      log.append(`service install --force FAILED: ${serviceInstallErr}`);
      serviceInstallFailed = true;
    }

    // P2.1 — warn-not-silent when install-cli or service-install
    // failed during a force-update. Pre-fix the installer returned
    // ok:true with the warning buried in the log file, so the user
    // got a green "✓ updated" dashboard while `nvpn` on PATH was
    // still the old binary (or the systemd unit was still pointing
    // at the old binary path). The warn flag lets the dashboard
    // render this case as yellow with a clear remediation hint.
    if (installCliFailed || serviceInstallFailed) {
      const remediation: string[] = [];
      if (installCliFailed) {
        remediation.push(`\`sudo ${nvpnBin} install-cli --force\``);
      }
      if (serviceInstallFailed) {
        remediation.push(`\`sudo ${nvpnBin} service install --force\``);
      }
      remediation.push(`then \`${restartHint}\``);
      const errCauses = [installCliErrDetail, serviceInstallErr].filter(Boolean).join(' / ');
      return {
        ok:     true,
        warn:   true,
        detail:
          `binary updated at ${nvpnBin}, but post-install relocation didn't complete cleanly ` +
          `(${errCauses || 'sudo cred cache empty / unknown'}). ` +
          `Run ${remediation.join(', ')} to finish the upgrade. (log: ${log.logPath})`,
      };
    }
    log.append('update mode — skipping init / caps / port-seed');
    return {
      ok:     true,
      detail: `binary updated at ${nvpnBin}. Run \`${restartHint}\` to load the new code now (otherwise it picks up on next service restart).`,
    };
  }

  // Pre-seed a free magic-dns-port + lay down the systemd caps drop-in
  // BEFORE service install, so the daemon's first start sees both.
  // Without this, port 1053 collisions and missing CAP_DAC_OVERRIDE
  // each write a set of scary red lines to the daemon log on first
  // start; the user sees them in the dashboard's log panel even though
  // the daemon is functionally fine. Order matters — once nvpn writes
  // its unit and `systemctl start nvpn` runs (inside `service install`),
  // it's too late to keep the first start clean. Both are best-effort.
  log.step('seed free magic-dns-port');
  const portSeed = await seedFreeMagicDnsPort();
  log.append(`magic-dns-port: ${portSeed.ok ? 'ok' : 'skipped'} — ${portSeed.detail}`);

  log.step('apply systemd caps drop-in');
  const caps = await applyLinuxCapsDropIn();
  log.append(`caps drop-in: ${caps.ok ? 'ok' : 'skipped'} — ${caps.detail}`);

  // System service install — writes /Library/LaunchDaemons (macOS) or
  // /etc/systemd/system (linux), creates the root-owned identity at
  // /root/.config/nvpn/ (or root's $XDG_CONFIG_HOME equivalent), and
  // starts the daemon. `sudo -n` fails fast if the cred cache is empty.
  // The dashboard runs in an SSE response, no TTY for a sudo prompt —
  // the user has to have run a sudo command in the same shell session
  // shortly beforehand for this to succeed.
  //
  // We DELIBERATELY don't run `nvpn init` as the dashboard user before
  // this step. Doing so creates a second, parallel identity at
  // ~/.config/nvpn/ with its own network_id + tunnel_ip — distinct
  // from what the root-owned service daemon ends up using. The two
  // identities then confuse the dashboard's status / network / roster
  // probes (which read the user-side config) vs. the actual running
  // daemon (which uses the root-side config). The user-mode init is
  // now a fallback path further down — it only runs when service
  // install fails and we need user-mode `nvpn start --daemon` to work.
  log.step('sudo nvpn service install');
  try {
    const { stdout, stderr } = await execa(
      'sudo', ['-n', nvpnBin, 'service', 'install'],
      { stdio: 'pipe', timeout: 30_000 },
    );
    log.append(`service install ok; stdout=${stdout.slice(0, 120)} stderr=${stderr.slice(0, 120)}`);
    return { ok: true, detail: `installed ${nvpnBin}` };
  } catch (e: any) {
    const stderr = (e?.stderr?.toString?.() || '').trim();
    const needsPassword = /password is required|sudo:.*required/i.test(stderr);
    log.append(`service install FAILED: ${stderr.slice(0, 240) || (e?.message || '').slice(0, 240)}`);

    // Fallback: when service install fails (no sudo cache, missing
    // systemd, container without privileged init), the user-mode
    // daemon path is the only remaining option. That path needs a
    // user-side identity, which `nvpn init --force` creates at
    // ~/.config/nvpn/. Upstream subcommand spelling shifted in 4.x
    // (--yes → --force); try the new flag first, fall back to stdin-
    // newline for older binaries. Best-effort — a failure here just
    // means the user-mode CLI may prompt them on first manual run.
    log.step('nvpn init (user-mode fallback)');
    try {
      await execa(nvpnBin, ['init', '--force'], { stdio: 'pipe', timeout: 10_000 });
      log.append('init --force ok');
    } catch {
      try {
        await execa(nvpnBin, ['init'], {
          stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000, input: '\n',
        });
        log.append('init (stdin-newline) ok');
      } catch (initErr: any) {
        log.append(`init skipped: ${(initErr?.message || '').slice(0, 120)}`);
      }
    }

    const nextStep = needsPassword
      ? `run \`sudo ${nvpnBin} service install\` when ready for auto-start — or start on demand with \`${nvpnBin} start --daemon\``
      : `rerun \`sudo ${nvpnBin} service install\` to retry (error: ${stderr.slice(0, 100) || 'unknown'}) — or start manually with \`${nvpnBin} start --daemon\``;

    return {
      ok:     false,
      warn:   true,
      detail: `binary installed — ${nextStep} (log: ${log.logPath})`,
    };
  }
}
