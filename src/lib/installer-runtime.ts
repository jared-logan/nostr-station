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
  // PATH-shadowing warn case: file at destFile is the new pinned
  // version, but `which <bin>` resolves to an older binary at this
  // path. Surfaced as a structured field (not just in `detail`) so
  // the Updates modal can offer a one-click "remove this and retry"
  // button without parsing the detail string. Always a real absolute
  // path; absent when `which` couldn't identify the shadow.
  shadowPath?: string;
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

// First MAJOR.MINOR.PATCH(-suffix)? in the input. Tolerant of "ngit 2.4.3",
// "nak version 0.19.7", "ngit-cli 2.4.3-rc.1", etc. Used by the post-
// install verify step to compare what `<bin> --version` actually returns
// against the version we just dropped on disk.
export function extractSemver(s: string): string | null {
  const m = s.match(/(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)/);
  return m ? m[1] : null;
}

// Post-install PATH-resolution check. Runs `<bin> --version` against the
// user's shell PATH and confirms the running binary actually reports the
// version we just installed at `destFile`.
//
// The bug this catches: install -m writes /usr/local/bin/<bin> at the
// pinned version, but the user has an older <bin> at ~/.cargo/bin or
// ~/.local/bin (or another dir earlier in PATH). The previous verify
// step only checked that `<bin> --version` exited 0 — it does, because
// the shadow binary is still a working <bin>, just an older one. The
// installer reported success, the Updates modal printed a green
// "updated to X", and the update pill kept reappearing on every poll
// because the live binary on PATH never actually changed.
//
// On mismatch we shell out to `which <bin>` to identify the shadowing
// path and return a warn-shaped result (warn:true) — the file at
// destFile IS the new version, so this isn't a hard failure; the user
// just needs to remove the shadow or reorder PATH. The Updates modal
// surfaces this as a yellow "needs manual step" with the actionable
// detail line in the log above.
export async function verifyVersionOnPath(opts: {
  bin:             string;     // e.g. 'ngit'
  destFile:        string;     // where we just installed it
  expectedVersion: string;     // pinned version from versions.ts
  log:             InstallLogger;
}): Promise<InstallResult | null> {
  let probe;
  try {
    probe = await execa(opts.bin, ['--version'], { stdio: 'pipe', timeout: 5000 });
  } catch (e: any) {
    return opts.log.fail('verify', `${opts.bin} --version failed: ${(e?.message || '').slice(0, 160)}`);
  }
  // Some Rust binaries print --version to stderr; concatenate both so the
  // extractor doesn't miss it. Mirrors the dual-stream capture in
  // tool-updates.ts probeVersion().
  const out = (probe.stdout || '') + (probe.stderr || '');
  const actual = extractSemver(out);
  if (!actual) {
    // No semver found — can't decide. Don't fail the install; the same
    // input would have made gatherToolUpdates return currentVersion:null
    // (and thus updateAvailable:false), so a stuck pill isn't a risk here.
    opts.log.append(`verify ok (no semver in --version output: ${out.slice(0, 80)})`);
    return null;
  }
  if (actual === opts.expectedVersion) {
    opts.log.append(`verify ok (PATH resolves to ${actual})`);
    return null;
  }

  // Mismatch — PATH shadowing. Identify the offending binary so the
  // detail message tells the user exactly what to remove (and so the
  // SSE done frame can carry a structured shadowPath for the Updates
  // modal's one-click "Remove shadow and retry" button).
  let shadowPath: string | null = null;
  try {
    const w = await execa('which', [opts.bin], { stdio: 'pipe', timeout: 3000 });
    const p = w.stdout.trim();
    if (p) shadowPath = p;
  } catch { /* `which` not available — fall through to generic phrasing */ }

  const shadowDesc = shadowPath || 'an earlier PATH entry';
  opts.log.append(`verify shadow: installed=${opts.expectedVersion} actual=${actual} shadow=${shadowDesc}`);
  return {
    ok:   false,
    warn: true,
    shadowPath: shadowPath ?? undefined,
    detail:
      `${opts.bin} ${opts.expectedVersion} installed at ${opts.destFile}, but PATH still ` +
      `resolves to ${opts.bin} ${actual} at ${shadowDesc}. ` +
      `Remove the older binary (e.g. \`rm ${shadowDesc}\`) or reorder PATH so ${opts.destFile} wins, ` +
      `then re-run the update.`,
  };
}
