// nvpn (nostr-vpn) installer.
//
// Privilege model: the dashboard runs unprivileged and CANNOT place a
// binary on a system PATH or manage the service itself. It downloads +
// verifies the tarball, stages it, and hands off to the root-owned helper
// (see nvpn-sudo.ts) via `sudo -n nvpn-admin install`. The helper:
//   * re-verifies the staged tarball's SHA256 against its OWN root-owned
//     manifest (so a swapped tarball is refused — the security boundary),
//   * installs the binary to /usr/local/bin/nvpn (root:root),
//   * runs `nvpn service install`, lays the caps + canonical-config
//     drop-ins, restarts, and snapshots/rolls back a failed install.
//
// Steps:
//   1. Resolve the Rust-target triple upstream publishes for this host.
//   2. Look up the pinned version + per-target SHA256 in versions.ts.
//   3. Skip if the service is already installed + running (unless force).
//   4. Download the exact tag's tarball; verify SHA256 before extraction.
//   5. Stage the verified tarball where the helper expects it.
//   6. Hand off to `sudo -n nvpn-admin install|reinstall`.
//   7. Best-effort reconcile (dormant safety net — left untouched).
//
// Logs every step to ~/logs/nvpn-install.log so a TUI/SSE consumer can
// drop the connection without losing the post-mortem trail.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { COMPONENT_VERSIONS, BINARY_SHA256 } from './versions.js';
import { getNvpnTarget } from './detect.js';
import { reconcileDaemonIdentityAfterInstall, probeNvpnServiceStatusUncached } from './nvpn.js';
import {
  adminState, runAdminVerb, ADMIN_STAGE_REL, ADMIN_HELPER,
} from './nvpn-sudo.js';
import {
  type InstallResult, type ProgressCallback,
  createInstallLogger, downloadAndVerify,
} from './installer-runtime.js';

export type { InstallResult, ProgressCallback };

export async function installNostrVpn(
  onProgress: ProgressCallback = () => {},
  opts: { force?: boolean } = {},
): Promise<InstallResult> {
  const target = getNvpnTarget();
  if (!target) {
    return {
      ok: false,
      detail: `nvpn is not published for this platform (${process.platform}/${process.arch}). ` +
              `Supported: linux x64/arm64, macOS arm64.`,
    };
  }

  const log = createInstallLogger('nvpn', onProgress);
  log.append(`target=${target}${opts.force ? ' force=true' : ''}`);

  // Short-circuit only when the service is genuinely installed AND running.
  // (A stray ~/.cargo/bin/nvpn must NOT count as "installed" — that was the
  // no-op-reinstall bug that left boxes unrecoverable.) Uncached so a stale
  // reading can't re-trigger the no-op.
  if (!opts.force) {
    log.step('checking for existing install');
    const svc = await probeNvpnServiceStatusUncached();
    if (svc.installed && svc.running) {
      log.append('service installed + running — skipping');
      return { ok: true, detail: 'already installed' };
    }
    log.append(`not fully installed (installed=${svc.installed} running=${svc.running}) — provisioning`);
  }

  const pinnedVersion = COMPONENT_VERSIONS['nvpn'];
  if (!pinnedVersion) return log.fail('config', 'no pinned nvpn version in versions.ts');
  const expectedSha = BINARY_SHA256.nvpn?.[target];
  if (!expectedSha) {
    return log.fail('config', `no checksum pinned for nvpn ${target} — refusing unverified install`);
  }

  const tag     = `v${pinnedVersion}`;
  const url     = `https://github.com/mmalmi/nostr-vpn/releases/download/${tag}/nvpn-${target}.tar.gz`;
  const tmp     = `/tmp/nvpn-install-${Date.now()}`;
  const tarPath = path.join(tmp, 'nvpn.tar.gz');
  fs.mkdirSync(tmp, { recursive: true });
  log.append(`tmp=${tmp} pinned=${pinnedVersion} sha256=${expectedSha.slice(0, 12)}…`);

  // Download + verify. The helper re-verifies too; doing it here gives a
  // fast fail + progress UX before we ask for privilege.
  const dl = await downloadAndVerify({
    url, expectedSha, outFile: tarPath, tmpDir: tmp, log, toolLabel: 'nvpn tarball',
  });
  if (!dl.ok) return dl.result;

  // Stage the verified tarball where the root-owned helper will pick it up.
  log.step('staging verified tarball for the admin helper');
  const stagePath = path.join(os.homedir(), ADMIN_STAGE_REL);
  try {
    fs.mkdirSync(path.dirname(stagePath), { recursive: true });
    fs.copyFileSync(tarPath, stagePath);
    log.append(`staged at ${stagePath}`);
  } catch (e: any) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return log.fail('stage', `could not stage tarball: ${(e?.message || '').slice(0, 160)}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  // The root-owned helper is the only privileged path. If it isn't set up
  // (or isn't root-owned, or the grant is missing), tell the user exactly
  // what to do — we never escalate on our own.
  const admin = await adminState();
  if (!admin.helperInstalled || !admin.rootOwned) {
    return {
      ok: false,
      detail: `nvpn downloaded + verified, but admin access isn't set up. Open Nostr VPN → Service and run the one-time "Set up admin access" command (it installs a root-owned helper + a scoped sudo rule), then click Install again. (log: ${log.logPath})`,
    };
  }
  if (!admin.manifestCurrent) {
    return {
      ok: false,
      detail: `nvpn downloaded, but the admin helper's pinned version is stale. Re-run the "Set up admin access" command (it bakes in this version's checksum), then Install again. (log: ${log.logPath})`,
    };
  }
  if (!admin.ready) {
    return {
      ok: false,
      detail: `admin helper is installed but the sudo grant isn't active. Re-run the "Set up admin access" command, then Install again. (log: ${log.logPath})`,
    };
  }

  // Hand off. The helper re-verifies the SHA, installs to /usr/local/bin,
  // runs service install, lays the drop-ins, restarts, and rolls back a
  // failed install (#7).
  const verb = opts.force ? 'reinstall' : 'install';
  log.step(`sudo ${ADMIN_HELPER} ${verb}`);
  const r = await runAdminVerb(verb);
  if (!r.ok) return { ok: false, detail: `${r.detail} (log: ${log.logPath})` };
  log.append('helper install ok');

  // Dormant safety net (left untouched): under the helper's config drop-in
  // the daemon already reads the canonical config, so reconcile no-ops —
  // but we still invoke it best-effort so the net stays wired.
  log.step('reconcile daemon identity (safety net)');
  try {
    const rec = await reconcileDaemonIdentityAfterInstall(null);
    log.append(`reconcile: ${rec.adopted ? 'adopted managed identity' : 'no-op'} — ${rec.detail}`);
  } catch (e: any) {
    log.append(`reconcile skipped: ${(e?.message || '').slice(0, 160)}`);
  }

  return { ok: true, detail: `nvpn installed + service registered (${tag})` };
}
