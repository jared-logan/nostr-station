// nvpn privilege helper.
//
// The dashboard performs a handful of privileged operations (relocate the
// binary onto PATH, install/uninstall the systemd service, manage the unit
// drop-ins). Every one of those shells out to `sudo -n …` (non-interactive)
// — which only succeeds when sudo can run without a password prompt. The
// dashboard runs inside an HTTP/SSE response with no controlling TTY, so it
// can never answer a prompt itself.
//
// Historically this "just assumed" the user had run `sudo -v` in a terminal
// seconds earlier; on a real box that cred cache is almost always cold, so
// every privileged button failed silently and installs left half-states.
//
// This module makes privilege explicit and reliable:
//   * sudoState()      — is `sudo -n` usable right now?
//   * warmSudoCache()  — pipe a password to `sudo -S -v` ONCE to warm the
//                        standard cred cache; afterwards every `sudo -n …`
//                        call in the codebase works for the cache lifetime
//                        (~15 min default). The password is used only as
//                        stdin to sudo, never stored, logged, or returned.
//   * renderNvpnSudoersLine() / buildSudoersInstallCommand() — an OPTIONAL
//                        permanent grant the user can install themselves.
//                        We never write to /etc/sudoers.d ourselves; the
//                        dashboard only displays a visudo-validated command.

import { execa } from 'execa';
import os from 'os';

const SUDO_PROBE_TIMEOUT_MS = 5_000;
const SUDO_WARM_TIMEOUT_MS  = 10_000;

export interface SudoState {
  /** `sudo -n` works right now (cred cache warm OR passwordless sudo). */
  ready:  boolean;
  /** Whether privileged ops are even relevant on this platform. */
  needed: boolean;
  detail: string;
}

// Does `sudo -n -v` succeed without a password? True when the cred cache is
// warm or the user has NOPASSWD sudo. `-v` only refreshes the timestamp; it
// performs no privileged action, so this is a safe, cheap probe.
export async function sudoNonInteractiveReady(): Promise<boolean> {
  try {
    await execa('sudo', ['-n', '-v'], { timeout: SUDO_PROBE_TIMEOUT_MS, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export async function sudoState(): Promise<SudoState> {
  const ready = await sudoNonInteractiveReady();
  return {
    ready,
    needed: true,
    detail: ready
      ? 'admin actions unlocked'
      : 'admin actions locked — unlock to install, update, or manage the service',
  };
}

export interface WarmResult { ok: boolean; detail: string }

// Warm the sudo cred cache from a password. The password is piped to
// `sudo -S -v` via stdin and is NEVER logged, persisted, or returned, and is
// not retained after this call. On success, subsequent `sudo -n …` calls
// across the codebase succeed for the cache lifetime.
export async function warmSudoCache(password: string): Promise<WarmResult> {
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, detail: 'no password provided' };
  }
  try {
    // -S: read the password from stdin. -p '': suppress the prompt text so
    // it never lands in stderr. -v: validate/refresh the timestamp only.
    await execa('sudo', ['-S', '-p', '', '-v'], {
      input:   password.endsWith('\n') ? password : `${password}\n`,
      timeout: SUDO_WARM_TIMEOUT_MS,
      stdio:   'pipe',
    });
    return { ok: true, detail: 'admin actions unlocked' };
  } catch (e: any) {
    // Map sudo's failure to a safe message — never echo stderr verbatim,
    // it can contain the prompt or environment detail.
    const stderr = (e?.stderr?.toString?.() || '').toLowerCase();
    if (/incorrect password|sorry, try again/.test(stderr)) {
      return { ok: false, detail: 'incorrect password' };
    }
    if (/not in the sudoers|not allowed|may not run sudo/.test(stderr)) {
      return { ok: false, detail: 'this user is not permitted to use sudo' };
    }
    return { ok: false, detail: 'could not unlock admin actions (sudo failed)' };
  }
}

// ── Optional permanent grant (user-installed, never auto-applied) ─────────

// The exact, scoped command whitelist the dashboard needs. Deliberately
// enumerates fixed argv (not blanket `nvpn *`, which would be root-
// equivalent via `service install --config`). Covers the common binary +
// service lifecycle; the cache-warm path covers everything else (e.g. unit
// drop-in management). Pure — exported for unit tests.
export function nvpnSudoersCommands(nvpnBin: string): string[] {
  const systemctl = '/usr/bin/systemctl';
  return [
    `${nvpnBin} install-cli`,
    `${nvpnBin} install-cli --force`,
    `${nvpnBin} service install`,
    `${nvpnBin} service install --force`,
    `${nvpnBin} service uninstall`,
    `${nvpnBin} service status`,
    `${nvpnBin} uninstall-cli`,
    `${systemctl} daemon-reload`,
    `${systemctl} start nvpn.service`,
    `${systemctl} stop nvpn.service`,
    `${systemctl} restart nvpn.service`,
    `${systemctl} try-restart nvpn.service`,
  ];
}

// Render the sudoers drop-in line for `user`. Pure — exported for tests.
export function renderNvpnSudoersLine(user: string, nvpnBin: string): string {
  return `${user} ALL=(root) NOPASSWD: ${nvpnSudoersCommands(nvpnBin).join(', ')}`;
}

// The copy-paste command the dashboard shows. Writes the rule to a temp
// file, validates it with `visudo -c` (so a typo can NEVER corrupt the
// user's sudo config), and only then installs it 0440 root:root. The user
// runs this themselves — we never execute it.
export function buildSudoersInstallCommand(user?: string, nvpnBin?: string): string {
  const u   = user || os.userInfo().username;
  const bin = nvpnBin || `${os.homedir()}/.cargo/bin/nvpn`;
  const line = renderNvpnSudoersLine(u, bin).replace(/'/g, `'\\''`);
  const tmp  = '/tmp/nostr-station-nvpn.sudoers';
  return (
    `printf '%s\\n' '${line}' | sudo tee ${tmp} >/dev/null && ` +
    `sudo visudo -cf ${tmp} && ` +
    `sudo install -m 0440 -o root -g root ${tmp} /etc/sudoers.d/nostr-station-nvpn && ` +
    `sudo rm -f ${tmp}`
  );
}
