/**
 * Shared installer runtime — the boilerplate that ngit-installer.ts,
 * nak-installer.ts, and nvpn-installer.ts each used to repeat.
 *
 * Each installer in this codebase follows the same shape: pin a version
 * + per-target sha256, download a binary or tarball from a GitHub
 * release, verify the digest before touching disk further, then run
 * tool-specific install steps (sudo install / nvpn service install / …).
 *
 * The tool-specific parts stay in the per-installer file — they vary
 * meaningfully (single binary vs two-binary tarball, sudo path vs
 * ~/.cargo/bin, post-install init steps). What ALL three share:
 *   - The log-file conventions (~/logs/<tool>-install.log, ISO-stamped
 *     lines, ProgressCallback bridge for the SSE consumer).
 *   - The download-and-verify pair: curl with the same flags + timeout,
 *     sha256 check BEFORE any extraction or move so a tampered tarball
 *     never gets to write absolute paths through tar.
 *
 * That's what lives here. Per-installer code is now ~30 LOC shorter
 * each, the curl flags are one place to fix (the next time a CDN
 * needs a different option), and the log-file shape stays consistent
 * across tools — a triage script can grep all three logs the same way.
 */
import { execa } from 'execa';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { verifyFileSha256 } from './checksum.js';

export interface InstallResult {
  ok:      boolean;
  detail?: string;
  // Soft failure — the binary itself is installed and runnable but an
  // optional follow-up step (e.g. nvpn `service install`, missing sudo
  // cred cache) didn't complete. Status panel renders this as warn,
  // not err. nak / ngit reuse the same flag for the cred-cache miss
  // case to keep status semantics uniform across the three.
  warn?:   boolean;
}

export type ProgressCallback = (step: string) => void;

// One logger per installer run. Returns the absolute log path (each
// installer surfaces it in error messages) and three helpers:
//   append — raw line into the log file, no progress mirroring
//   step   — appends `step: <msg>` and mirrors via onProgress (used for
//            the SSE log stream the dashboard renders)
//   fail   — appends `FAIL <step>: <reason>` and returns a ready-to-
//            return InstallResult with the same reason exposed to the
//            caller (plus the log path so the user can dig deeper).
//
// All file IO is best-effort: if ~/logs can't be created (read-only
// home, disk full, permissions), we silently swallow — losing log
// lines is preferable to wedging the installer.
export interface InstallLogger {
  logPath: string;
  append:  (line: string) => void;
  step:    (msg: string)  => void;
  fail:    (stepName: string, reason: string) => InstallResult;
}

export function createInstallLogger(
  toolName: string,
  onProgress: ProgressCallback = () => {},
): InstallLogger {
  const logPath = path.join(os.homedir(), 'logs', `${toolName}-install.log`);

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

  return { logPath, append, step, fail };
}

// Download a single file with curl, then verify its sha256 against the
// pinned digest. Verification runs BEFORE any subsequent step touches
// the bytes — that's why both halves live in one helper, not two: we
// never want a caller to forget to verify after downloading.
//
// On any failure: the temp directory is cleaned up (so the installer
// doesn't leave junk in /tmp), an InstallResult is returned, and the
// caller short-circuits its remaining steps. On success: the file is
// at the path the caller passed in, verified, and ready for the
// tool-specific install logic.
//
// Curl flags are fixed: -fsSL means fail on HTTP 4xx/5xx (no half-
// downloaded body), silent, follow redirects (GitHub release URLs
// 302 to S3). The timeout is configurable because nvpn + ngit tarballs
// can be several MB and need longer than nak's single-binary asset.
export interface DownloadAndVerifyArgs {
  url:        string;
  expectedSha: string;
  outFile:    string;
  tmpDir:     string;             // cleaned up on any failure
  log:        InstallLogger;
  toolLabel:  string;             // e.g. "ngit tarball" — used in error messages
  timeoutMs?: number;             // default 60s; nvpn tarballs need ~120s
}

export async function downloadAndVerify(args: DownloadAndVerifyArgs): Promise<
  { ok: true } | { ok: false; result: InstallResult }
> {
  const { url, expectedSha, outFile, tmpDir, log, toolLabel } = args;
  const timeoutMs = args.timeoutMs ?? 60_000;

  log.step(`downloading ${url}`);
  try {
    await execa(
      'curl',
      ['-fsSL', '-o', outFile, url],
      { stdio: 'pipe', timeout: timeoutMs },
    );
    log.append('curl ok');
  } catch (e: any) {
    const stderr = e?.stderr?.toString?.() || '';
    const exit   = e?.exitCode ?? '?';
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return {
      ok: false,
      result: log.fail(
        'download',
        `curl failed (exit ${exit}): ${stderr.trim().slice(0, 160) || 'no stderr'}`,
      ),
    };
  }

  log.step('verifying sha256');
  let verified = false;
  try { verified = verifyFileSha256(outFile, expectedSha); }
  catch (e: any) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return {
      ok: false,
      result: log.fail('checksum', `sha256 read failed: ${(e?.message ?? '').slice(0, 160)}`),
    };
  }
  if (!verified) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return {
      ok: false,
      result: log.fail(
        'checksum',
        `${toolLabel} SHA256 mismatch (expected ${expectedSha.slice(0, 12)}…) — install aborted`,
      ),
    };
  }
  log.append('sha256 verified');
  return { ok: true };
}
