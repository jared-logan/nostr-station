import { execa, type ExecaError } from 'execa';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Platform, Config } from './detect.js';
import { findBin } from './detect.js';
import { COMPONENT_VERSIONS, BINARY_SHA256 } from './versions.js';
import { verifyFileSha256 } from './checksum.js';

export type InstallResult = {
  ok: boolean;
  detail?: string;
  // `warn` is a partial-success signal: the primary artifact landed but a
  // follow-up step needs the user's involvement (e.g. a system-service
  // install step that requires sudo credentials the TUI can't prompt for).
  // Callers that render step status should show this as yellow/warn rather
  // than red/error, since the component is already usable.
  warn?: boolean;
};

async function run(cmd: string, args: string[]): Promise<InstallResult> {
  try {
    await execa(cmd, args, { stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    const err = e as ExecaError;
    return { ok: false, detail: err.stderr?.toString().slice(0, 120) };
  }
}

// apt-specific runner.
//
// Three problems this helper addresses that a naive `run('sudo', ['apt-get',
// ...])` hits in the wild:
//
//   1. **Password prompt deadlock.** With `stdio: 'pipe'`, if sudo's cred
//      cache has expired, it writes `[sudo] password for <user>:` to the
//      child's stderr and waits on its stdin — which we never drain. The
//      Install phase appears to hang forever with no indication why. We
//      pre-authenticate sudo in `src/cli.tsx` before Ink mounts, so by the
//      time this runs the cache is fresh. But as defence-in-depth we pass
//      `-n` (non-interactive) so sudo fails fast instead of hanging if the
//      cache somehow isn't warm.
//
//   2. **Interactive prompts from apt itself.** `apt-get install` can ask
//      about config-file conflicts, service restarts, kernel updates, etc.
//      Each prompt deadlocks the same way. `DEBIAN_FRONTEND=noninteractive`
//      + `-o Dpkg::Options::=--force-confdef/--force-confold` tells dpkg to
//      pick the sensible default and keep moving.
//
//   3. **Silent lock contention.** If another apt process holds
//      /var/lib/dpkg/lock-frontend, our call blocks indefinitely. We cap
//      each invocation at a hard wall-clock timeout (5min update, 10min
//      install) and report an actionable error that mentions the lock.
//
// Progress streaming: we tee stderr's last line into onProgress so the UI
// shows "Reading package lists…", "Unpacking build-essential…", etc.
// instead of a frozen spinner.
async function runApt(
  args: string[],
  timeoutMs: number,
  onProgress?: (detail: string) => void,
): Promise<InstallResult> {
  try {
    // `sudo --preserve-env=VAR,VAR` is the ONLY reliable way to get env
    // vars through sudo — by default sudo strips almost everything for
    // security. Without this, DEBIAN_FRONTEND=noninteractive set in Node's
    // env never reaches apt-get, and the postinst script prompts us
    // interactively (deadlocking with stdio: 'pipe').
    //
    // We also set the env vars on the sudo process itself so they exist
    // to be preserved in the first place — Node's execa inherits the
    // parent's env for the spawn but we override to be explicit.
    const proc = execa('sudo', [
      '-n',
      '--preserve-env=DEBIAN_FRONTEND,NEEDRESTART_MODE,NEEDRESTART_SUSPEND',
      ...args,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: {
        ...process.env,
        DEBIAN_FRONTEND: 'noninteractive',
        // Even with DEBIAN_FRONTEND, some post-install scripts read these
        // to decide whether to prompt.
        NEEDRESTART_MODE: 'a',
        NEEDRESTART_SUSPEND: '1',
      },
    });

    if (onProgress) {
      const tail = (chunk: Buffer) => {
        const line = chunk.toString().trim().split('\n').pop() ?? '';
        if (line) onProgress(line.slice(0, 60));
      };
      proc.stdout?.on('data', tail);
      proc.stderr?.on('data', tail);
    }

    await proc;
    return { ok: true };
  } catch (e) {
    const err = e as ExecaError;
    // Timed out — almost always lock contention or a stuck mirror.
    if (err.timedOut) {
      return {
        ok: false,
        detail: `apt timed out after ${Math.floor(timeoutMs / 1000)}s — another package manager may be running (check: fuser /var/lib/dpkg/lock-frontend)`,
      };
    }
    // sudo -n failed — cred cache expired between pre-auth and here.
    const stderr = err.stderr?.toString() ?? '';
    if (stderr.includes('a password is required') || stderr.includes('sudo:')) {
      return {
        ok: false,
        detail: 'sudo credentials expired — rerun `sudo -v` and retry',
      };
    }
    return { ok: false, detail: stderr.slice(0, 120) || err.shortMessage?.slice(0, 120) };
  }
}

// Pre-Ink variant of installSystemDeps.
//
// Why: inside a running Ink TUI, `sudo apt-get update` on Linux Mint hangs
// indefinitely even with `sudo -n` + DEBIAN_FRONTEND=noninteractive + pipe
// drain in runApt(). Running the same spawn config outside Ink (verified
// via scripts/repro-apt-hang.mjs — all 7 variants complete in ~4s) works
// fine. The hang is specific to the combination of Ink's raw-mode stdin
// and sudo's PAM/TTY session setup; no amount of child-stdio tweaking from
// within Ink reliably avoids it.
//
// Workaround: install system packages BEFORE Ink's render() mounts, with
// `stdio: 'inherit'` so the child has native terminal access and the user
// sees apt's own progress output. Same pattern as the sudo pre-auth in
// cli.tsx. Caller is responsible for printing any header banner — this
// function just runs the package manager.
export async function installSystemDepsInherit(
  p: Platform,
): Promise<InstallResult> {
  const sudoArgs = [
    '-n',
    '--preserve-env=DEBIAN_FRONTEND,NEEDRESTART_MODE,NEEDRESTART_SUSPEND',
  ];
  const env = {
    ...process.env,
    DEBIAN_FRONTEND: 'noninteractive',
    NEEDRESTART_MODE: 'a',
    NEEDRESTART_SUSPEND: '1',
  };

  const runInherit = async (
    cmd: string,
    args: string[],
    timeoutMs: number,
  ): Promise<InstallResult> => {
    try {
      await execa(cmd, args, { stdio: 'inherit', timeout: timeoutMs, env });
      return { ok: true };
    } catch (e) {
      const err = e as ExecaError;
      if (err.timedOut) {
        return {
          ok: false,
          detail: `${cmd} timed out after ${Math.floor(timeoutMs / 1000)}s`,
        };
      }
      return {
        ok: false,
        detail: err.shortMessage?.slice(0, 160) ?? 'failed',
      };
    }
  };

  switch (p.pkgMgr) {
    case 'brew':
      return runInherit('brew', ['install', 'git', 'curl', 'protobuf'], 10 * 60 * 1000);
    case 'apt': {
      const upd = await runInherit(
        'sudo', [...sudoArgs, 'apt-get', 'update'], 5 * 60 * 1000,
      );
      if (!upd.ok) return upd;
      return runInherit(
        'sudo',
        [
          ...sudoArgs, 'apt-get', 'install', '-y',
          '-o', 'Dpkg::Options::=--force-confdef',
          '-o', 'Dpkg::Options::=--force-confold',
          'build-essential', 'curl', 'git', 'pkg-config',
          'libssl-dev', 'netcat-openbsd',
          'libsecret-tools',
          'protobuf-compiler',
        ],
        10 * 60 * 1000,
      );
    }
    case 'dnf':
      return runInherit(
        'sudo',
        [...sudoArgs, 'dnf', 'install', '-y',
         'gcc', 'curl', 'git', 'openssl-devel', 'pkgconfig', 'nmap-ncat',
         'protobuf-compiler'],
        10 * 60 * 1000,
      );
    case 'pacman':
      return runInherit(
        'sudo',
        [...sudoArgs, 'pacman', '-Sy', '--noconfirm',
         'base-devel', 'curl', 'git', 'openssl', 'protobuf'],
        10 * 60 * 1000,
      );
  }
}

export async function installSystemDeps(
  p: Platform,
  onProgress?: (detail: string) => void,
): Promise<InstallResult> {
  switch (p.pkgMgr) {
    // protobuf-compiler / protoc is required by nostr-rs-relay's build.rs —
    // prost-build invokes `protoc` to compile proto/nauthz.proto and the
    // `cargo install` fails with "Could not find `protoc` installation" without it.
    case 'brew':
      onProgress?.('brew install…');
      return run('brew', ['install', 'git', 'curl', 'protobuf']);
    case 'apt': {
      // Split into two apt invocations so we can stream distinct progress
      // and give each its own timeout. Update can hang on a slow mirror;
      // install can hang on a kernel post-install script.
      onProgress?.('apt-get update…');
      const upd = await runApt(
        ['apt-get', 'update', '-qq'],
        5 * 60 * 1000,
        onProgress,
      );
      if (!upd.ok) return upd;

      onProgress?.('apt-get install…');
      return runApt(
        [
          'apt-get', 'install', '-y',
          '-o', 'Dpkg::Options::=--force-confdef',
          '-o', 'Dpkg::Options::=--force-confold',
          'build-essential', 'curl', 'git', 'pkg-config',
          'libssl-dev', 'netcat-openbsd',
          'libsecret-tools',   // provides secret-tool for GNOME Keyring access
          'protobuf-compiler', // provides protoc for nostr-rs-relay build.rs
        ],
        10 * 60 * 1000,
        onProgress,
      );
    }
    case 'dnf':
      onProgress?.('dnf install…');
      return run('sudo', ['dnf', 'install', '-y',
        'gcc', 'curl', 'git', 'openssl-devel', 'pkgconfig', 'nmap-ncat',
        'protobuf-compiler']);
    case 'pacman':
      onProgress?.('pacman -Sy…');
      return run('sudo', ['pacman', '-Sy', '--noconfirm',
        'base-devel', 'curl', 'git', 'openssl', 'protobuf']);
  }
}

export async function installRust(): Promise<InstallResult> {
  try {
    await execa('rustup', ['update', 'stable', '--quiet'], { stdio: 'pipe' });
    return { ok: true, detail: 'updated' };
  } catch {
    // not installed — run rustup installer
    return run('sh', ['-c',
      'curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --quiet']);
  }
}

// Cargo bins compile from source — can take 10-15 min on a cold machine.
// We stream stderr and tick elapsed time so the UI shows progress, not silence.
// Installs a pinned version from COMPONENT_VERSIONS if available, otherwise latest.
//
// NOTE: we intentionally do NOT pass --locked. --locked forces cargo to use
// the exact Cargo.lock that shipped with the crate, and older published
// versions (e.g. nostr-rs-relay 0.8.12) ship with dep pins like
// `time 0.3.25` that fail to compile on modern rustc with
// `error[E0282]: type annotations needed for Box<_>`. Dropping --locked lets
// cargo pick semver-compatible newer patch versions that include the fix.
// Tradeoff: slightly less reproducible across machines, but actually builds.
export async function installCargoBin(
  pkg: string,
  onProgress: (detail: string) => void,
  // Optional durable sink — when provided, receives every cargo stderr
  // line untruncated. The TUI still gets the 60-char last-line summary
  // via onProgress. Lets ~/logs/install.log capture the actual compile
  // error after the user's terminal scrolls past it.
  appendLog?: (line: string) => void,
): Promise<InstallResult> {
  const start = Date.now();
  const pinnedVersion = COMPONENT_VERSIONS[pkg as keyof typeof COMPONENT_VERSIONS];

  // Resolve cargo absolutely via the same curated-dirs walk that detect uses.
  // The TUI may inherit a stripped PATH that doesn't include ~/.cargo/bin —
  // especially right after rustup has just finished installing in the same
  // session — and spawning by bare name then fails ~instantly with empty
  // stderr (Mint, April 2026 regression). Spawning by absolute path makes
  // the resolution deterministic and lets us log exactly which cargo we
  // chose for the post-mortem.
  const cargoPath = findBin('cargo');
  appendLog?.(`cargo[${pkg}] which cargo: ${cargoPath ?? '<not found>'}`);
  if (!cargoPath) {
    appendLog?.(`cargo[${pkg}] FAILED: cargo binary not found on PATH or in ~/.cargo/bin`);
    return {
      ok: false,
      detail: 'cargo not found on PATH or ~/.cargo/bin — install rust first',
    };
  }

  const ticker = setInterval(() => {
    const secs = Math.floor((Date.now() - start) / 1000);
    const mins = Math.floor(secs / 60);
    onProgress(`compiling… ${mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`}`);
  }, 5000);

  const cargoArgs = pinnedVersion
    ? ['install', pkg, '--version', pinnedVersion]
    : ['install', pkg];

  appendLog?.(`cargo[${pkg}] argv: ${cargoPath} ${cargoArgs.join(' ')}`);

  try {
    const proc = execa(cargoPath, cargoArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CARGO_TERM_COLOR: 'never' },
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (appendLog) {
        for (const raw of text.split('\n')) {
          if (raw) appendLog(`cargo[${pkg}]: ${raw}`);
        }
      }
      const line = text.trim().split('\n').pop() ?? '';
      if (line) onProgress(line.slice(0, 60));
    });

    await proc;
    clearInterval(ticker);
    const elapsed = Math.floor((Date.now() - start) / 1000);
    return { ok: true, detail: `${elapsed}s` };
  } catch (e: any) {
    clearInterval(ticker);
    // Spawn-time failures (ENOENT, EACCES, env stripping, rustup shim race)
    // throw before any stderr reaches the proc.stderr listener — so logging
    // only e.stderr leaves an empty "FAILED" line and the actual root cause
    // invisible (Mint A6 regression). Capture the full execa error surface
    // so the post-mortem in ~/logs/install.log is diagnostic on its own.
    const stderrFull = e?.stderr?.toString?.() ?? '';
    const stdoutFull = e?.stdout?.toString?.() ?? '';
    const code       = e?.code      ?? '<none>';
    const exitCode   = e?.exitCode  ?? '<none>';
    const signal     = e?.signal    ?? '<none>';
    const message    = e?.shortMessage ?? e?.message ?? '<none>';
    if (appendLog) {
      appendLog(`cargo[${pkg}] FAILED:`);
      appendLog(`  code=${code} exitCode=${exitCode} signal=${signal}`);
      appendLog(`  message: ${message}`);
      appendLog(stderrFull
        ? `  stderr (last 400): ${stderrFull.slice(-400)}`
        : `  stderr: <empty>`);
      if (stdoutFull) appendLog(`  stdout (last 400): ${stdoutFull.slice(-400)}`);
    }
    // Surface a meaningful one-line detail in the TUI even when stderr is
    // empty — empty FAIL lines were the original A6 symptom.
    const detail = stderrFull.slice(0, 120)
      || (typeof message === 'string' ? message.slice(0, 120) : '')
      || `${code} (exit ${exitCode})`;
    return { ok: false, detail };
  }
}

// nostr-rs-relay is a Rust crate, so it CAN be installed via `cargo install`
// — but that's the 5–15min cold compile that dominates first-install time.
// Upstream (scsibug/nostr-rs-relay) does not publish prebuilt binaries, so
// nostr-station hosts them itself under a tagged release on this repo:
//   https://github.com/jared-logan/nostr-station/releases/tag/relay-prebuilts-v{version}
// Each release contains per-target binaries and a SHA256SUMS file. The build
// pipeline lives in .github/workflows/release-relay-prebuilts.yml.
//
// This function:
//   1. Skips entirely if a correctly-versioned binary already exists (so
//      pre-seeded installs — e.g. CI cache restores — short-circuit).
//   2. Tries the prebuilt path: download asset, verify against SHA256SUMS,
//      chmod +x.
//   3. Falls back to installCargoBin on ANY failure (network, unsupported
//      target, missing release, checksum mismatch). Users on unsupported
//      targets or behind restrictive firewalls get a working relay; they
//      just pay the compile cost.
//
// Kept intentionally narrow: no retry loop, no mirror list, no background
// prefetch. If this proves flaky in practice, add one problem at a time.
export async function installRelayPrebuilt(
  cargoBin: string,
  onProgress: (detail: string) => void,
  // Threaded straight into installCargoBin's optional appendLog so the
  // cargo fallback path (5 different triggers below: no pin, unsupported
  // arch, download fail, checksum mismatch, etc.) also captures full
  // cargo stderr in ~/logs/install.log.
  appendLog?: (line: string) => void,
): Promise<InstallResult> {
  const pinnedVersion = COMPONENT_VERSIONS['nostr-rs-relay'];
  if (!pinnedVersion) {
    // No pin → no corresponding prebuilt release exists to target.
    return installCargoBin('nostr-rs-relay', onProgress, appendLog);
  }

  const dest = `${cargoBin}/nostr-rs-relay`;
  const fs = await import('fs');
  const crypto = await import('crypto');

  // (1) Short-circuit: if the binary is already present AND reports the
  // pinned version, declare victory. This makes the install idempotent and
  // lets CI cache restores skip the network round-trip.
  try {
    if (fs.existsSync(dest)) {
      const { stdout } = await execa(dest, ['--version'], { timeout: 5000 });
      // `nostr-rs-relay 0.8.12` → last whitespace-separated token
      const existing = stdout.trim().split(/\s+/).pop();
      if (existing === pinnedVersion) {
        return { ok: true, detail: `${pinnedVersion} (already installed)` };
      }
    }
  } catch {
    // Binary exists but can't execute (wrong arch, corrupted, etc.) — fall
    // through to the download path which will overwrite it.
  }

  // (2) Map node's platform/arch to our asset naming convention.
  // Asset format: nostr-rs-relay-{version}-{os}-{arch}
  //   linux-x86_64 → published
  //   darwin-arm64 → published
  //   everything else → fall back to cargo install
  const osMap: Record<string, string>   = { darwin: 'darwin', linux: 'linux' };
  const archMap: Record<string, string> = { x64: 'x86_64', arm64: 'arm64' };
  const os   = osMap[process.platform];
  const arch = archMap[process.arch];
  if (!os || !arch) {
    onProgress(`unsupported platform ${process.platform}/${process.arch} — compiling`);
    return installCargoBin('nostr-rs-relay', onProgress, appendLog);
  }
  const supported = new Set(['linux-x86_64', 'darwin-arm64']);
  const targetKey = `${os}-${arch}`;
  if (!supported.has(targetKey)) {
    onProgress(`no prebuilt for ${targetKey} — compiling`);
    return installCargoBin('nostr-rs-relay', onProgress, appendLog);
  }

  const tag     = `relay-prebuilts-v${pinnedVersion}`;
  const asset   = `nostr-rs-relay-${pinnedVersion}-${targetKey}`;
  const baseUrl = `https://github.com/jared-logan/nostr-station/releases/download/${tag}`;
  const binUrl  = `${baseUrl}/${asset}`;
  const sumsUrl = `${baseUrl}/SHA256SUMS`;

  fs.mkdirSync(cargoBin, { recursive: true });

  onProgress(`downloading ${asset}`);
  const dl = await run('curl', ['-fsSL', binUrl, '-o', dest]);
  if (!dl.ok) {
    onProgress('prebuilt download failed — compiling');
    return installCargoBin('nostr-rs-relay', onProgress, appendLog);
  }

  // (3) Checksum verification. We intentionally use the node-side fetch for
  // the sums file (small text, easy to parse) and sha256 the downloaded
  // binary in-process, so curl doesn't need any extra flags.
  try {
    onProgress('verifying checksum');
    const sumsRes = await fetch(sumsUrl, { headers: { 'User-Agent': 'nostr-station' } });
    if (!sumsRes.ok) throw new Error(`sums http ${sumsRes.status}`);
    const sumsText = await sumsRes.text();
    // SHA256SUMS line format: `<hex>  <filename>`
    const line = sumsText.split('\n').find(l => l.trim().endsWith(asset));
    if (!line) throw new Error('asset not listed in SHA256SUMS');
    const expected = line.trim().split(/\s+/)[0];
    const actual = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
    if (expected !== actual) throw new Error('checksum mismatch');
  } catch (e) {
    // Don't leave a half-downloaded or unverified binary on disk.
    try { fs.unlinkSync(dest); } catch {}
    const msg = (e as Error).message ?? 'verify failed';
    onProgress(`${msg} — compiling`);
    return installCargoBin('nostr-rs-relay', onProgress, appendLog);
  }

  try {
    fs.chmodSync(dest, 0o755);
  } catch (e) {
    return { ok: false, detail: `chmod failed: ${(e as Error).message?.slice(0, 80)}` };
  }

  return { ok: true, detail: `${pinnedVersion} (prebuilt)` };
}

// Resolves the directory containing nostr-station's own package.json — the
// root we install node-pty into and whose node_modules/ we patch with the
// prebuilt native addon. Works in both `tsx src/...` dev mode and the
// published `dist/lib/...` layout because path.dirname + '..', '..' from
// either install.(ts|js) climbs out to the repo/install root.
function stationRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

// Best-effort check: does `require('node-pty')` succeed from the station's
// install root? Run in a child Node so a successful compile during
// `npm install -g nostr-station` is honored, but we never crash the parent
// if node-pty is missing / incompatible / mis-linked.
async function nodePtyLoads(root: string): Promise<boolean> {
  try {
    await execa(process.execPath, [
      '-e',
      "const p = require('node-pty'); if (typeof p.spawn !== 'function') process.exit(2);",
    ], { cwd: root, stdio: 'pipe', timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

// Runs `npm install node-pty@<version> --ignore-scripts --no-save --silent`
// inside the station root. --ignore-scripts keeps the ship-breaking node-gyp
// compile from running; the JS wrapper + package layout land on disk but
// the native addon is absent until we drop in a prebuilt. --no-save avoids
// scribbling on nostr-station's own package.json post-install.
async function installNodePtyJsOnly(
  root: string,
  version: string,
): Promise<InstallResult> {
  try {
    await execa('npm', [
      'install', `node-pty@${version}`,
      '--prefix', root,
      '--ignore-scripts', '--no-save', '--silent',
    ], { cwd: root, stdio: 'pipe', timeout: 90_000 });
    return { ok: true };
  } catch (e) {
    const err = e as ExecaError;
    return { ok: false, detail: err.stderr?.toString().slice(0, 160) || 'npm install failed' };
  }
}

// node-pty is an npm package that ships NO prebuilts upstream; their install
// script runs `scripts/prebuild.js || node-gyp rebuild`, and prebuild.js only
// succeeds if the user ran microsoft/node-pty's private build chain. That
// means a plain `npm install node-pty` fails hard on any machine without
// python3 + a C++ toolchain — which is most fresh dev boxes.
//
// We host our own prebuilts under the nostr-station repo's releases:
//   https://github.com/jared-logan/nostr-station/releases/tag/node-pty-prebuilts-v{version}
// Each tarball contains pty.node + spawn-helper for one (os, arch) pair,
// built against N-API so the same binary works across Node ≥22 ABIs. See
// .github/workflows/release-node-pty-prebuilts.yml for the build pipeline.
//
// Flow:
//   1. Short-circuit if node-pty already loads cleanly (optional dep built
//      successfully during `npm install -g nostr-station`, or a prior run
//      already patched the native addon in).
//   2. Ensure the JS wrapper is on disk with --ignore-scripts (skips compile).
//   3. Download the arch-matching prebuilt tarball, verify SHA256, extract.
//   4. chmod +x the spawn-helper sidecar (Unix only — required by node-pty).
//   5. Re-verify load. If ANYTHING fails along the way, fall back to the
//      vanilla compile path — users with build tools installed still win.
//
// The terminal panel refuses to open if node-pty isn't loadable; nothing
// else in nostr-station depends on node-pty, so an install failure here
// degrades gracefully to "terminal tab is disabled".
export async function installNodePtyPrebuilt(
  onProgress: (detail: string) => void,
): Promise<InstallResult> {
  const pinnedVersion = COMPONENT_VERSIONS['node-pty'];
  if (!pinnedVersion) {
    return { ok: false, detail: 'no pinned node-pty version — check versions.ts' };
  }

  const root = stationRoot();
  const fs = await import('fs');
  const crypto = await import('crypto');

  // (1) Short-circuit: already works? (npm may have compiled it during
  // `npm install -g nostr-station` if build tools were present.)
  if (await nodePtyLoads(root)) {
    return { ok: true, detail: `${pinnedVersion} (already loaded)` };
  }

  // (2) Map node's platform/arch to our asset naming convention.
  // Asset format: node-pty-{version}-{os}-{arch}.tar.gz
  const osMap: Record<string, string>   = { darwin: 'darwin', linux: 'linux' };
  const archMap: Record<string, string> = { x64: 'x64', arm64: 'arm64' };
  const os   = osMap[process.platform];
  const arch = archMap[process.arch];
  if (!os || !arch) {
    onProgress(`unsupported platform ${process.platform}/${process.arch} — compiling`);
    return installNodePtyCompile(root, pinnedVersion);
  }
  const targetKey = `${os}-${arch}`;
  // darwin-x64 is intentionally absent from our prebuilt matrix — see
  // .github/workflows/release-node-pty-prebuilts.yml for the rationale
  // (deprecated runner + upstream already ships a darwin-x64 prebuild
  // that the short-circuit at the top of this function already caught).
  const supported = new Set(['linux-x64', 'linux-arm64', 'darwin-arm64']);
  if (!supported.has(targetKey)) {
    onProgress(`no prebuilt for ${targetKey} — compiling`);
    return installNodePtyCompile(root, pinnedVersion);
  }

  // (3) Ensure the JS wrapper + package layout is on disk. If node-pty's
  // directory is already present (from a half-completed prior run), skip
  // the install; otherwise fetch with --ignore-scripts.
  const nodePtyDir = path.join(root, 'node_modules', 'node-pty');
  const nodePtyPkgJson = path.join(nodePtyDir, 'package.json');
  if (!fs.existsSync(nodePtyPkgJson)) {
    onProgress('fetching node-pty package');
    const js = await installNodePtyJsOnly(root, pinnedVersion);
    if (!js.ok) {
      onProgress(`npm install failed (${js.detail?.slice(0, 40)}) — compiling`);
      return installNodePtyCompile(root, pinnedVersion);
    }
  }

  // (4) Download + verify the prebuilt tarball.
  const tag     = `node-pty-prebuilts-v${pinnedVersion}`;
  const asset   = `node-pty-${pinnedVersion}-${targetKey}.tar.gz`;
  const baseUrl = `https://github.com/jared-logan/nostr-station/releases/download/${tag}`;
  const binUrl  = `${baseUrl}/${asset}`;
  const sumsUrl = `${baseUrl}/SHA256SUMS`;
  const tmpTar  = path.join(root, `.${asset}.tmp`);

  onProgress(`downloading ${asset}`);
  const dl = await run('curl', ['-fsSL', binUrl, '-o', tmpTar]);
  if (!dl.ok) {
    try { fs.unlinkSync(tmpTar); } catch {}
    onProgress('prebuilt download failed — compiling');
    return installNodePtyCompile(root, pinnedVersion);
  }

  try {
    onProgress('verifying checksum');
    const sumsRes = await fetch(sumsUrl, { headers: { 'User-Agent': 'nostr-station' } });
    if (!sumsRes.ok) throw new Error(`sums http ${sumsRes.status}`);
    const sumsText = await sumsRes.text();
    const line = sumsText.split('\n').find(l => l.trim().endsWith(asset));
    if (!line) throw new Error('asset not listed in SHA256SUMS');
    const expected = line.trim().split(/\s+/)[0];
    const actual = crypto.createHash('sha256').update(fs.readFileSync(tmpTar)).digest('hex');
    if (expected !== actual) throw new Error('checksum mismatch');
  } catch (e) {
    try { fs.unlinkSync(tmpTar); } catch {}
    onProgress(`${(e as Error).message} — compiling`);
    return installNodePtyCompile(root, pinnedVersion);
  }

  // (5) Extract into build/Release/, creating the directory if this is the
  // first install. node-pty's require() resolves its addon at
  // ./build/Release/pty.node relative to the package, plus spawn-helper in
  // the same directory for Unix PTY spawns.
  const releaseDir = path.join(nodePtyDir, 'build', 'Release');
  try { fs.mkdirSync(releaseDir, { recursive: true }); } catch {}

  try {
    onProgress('extracting prebuilt');
    await execa('tar', ['-xzf', tmpTar, '-C', releaseDir], { stdio: 'pipe', timeout: 20_000 });
  } catch (e) {
    try { fs.unlinkSync(tmpTar); } catch {}
    const err = e as ExecaError;
    onProgress(`extract failed (${err.stderr?.toString().slice(0, 40) ?? 'unknown'}) — compiling`);
    return installNodePtyCompile(root, pinnedVersion);
  }
  try { fs.unlinkSync(tmpTar); } catch {}

  // (6) spawn-helper must be executable; tar preserves modes from the
  // archive but paranoid chmod here guards against umask/filesystem quirks.
  const spawnHelper = path.join(releaseDir, 'spawn-helper');
  try { if (fs.existsSync(spawnHelper)) fs.chmodSync(spawnHelper, 0o755); } catch {}

  // (7) Sanity: can we load the thing?
  if (!(await nodePtyLoads(root))) {
    onProgress('prebuilt failed to load — compiling');
    return installNodePtyCompile(root, pinnedVersion);
  }

  return { ok: true, detail: `${pinnedVersion} (prebuilt)` };
}

// Fallback path when prebuilts don't exist or can't be used. Runs the vanilla
// npm install which triggers node-gyp — requires python3 + a C++ toolchain.
// On a machine with those already present (covered by installSystemDeps for
// Linux; bundled with Xcode Command Line Tools for macOS) this succeeds; on a
// bare machine it fails and the caller reports an actionable error.
async function installNodePtyCompile(root: string, version: string): Promise<InstallResult> {
  try {
    await execa('npm', [
      'install', `node-pty@${version}`,
      '--prefix', root,
      '--no-save', '--silent',
    ], { cwd: root, stdio: 'pipe', timeout: 5 * 60 * 1000 });
    if (await nodePtyLoads(root)) return { ok: true, detail: `${version} (compiled)` };
    return { ok: false, detail: 'compiled but failed to load — check node ABI' };
  } catch (e) {
    const err = e as ExecaError;
    return {
      ok: false,
      detail: err.stderr?.toString().slice(0, 160)
        || 'compile failed — install python3 + build tools, or wait for a prebuilt',
    };
  }
}

// nak is fiatjaf's Nostr CLI. It is written in Go and is NOT published to
// crates.io — `cargo install nak` will always fail with "could not find nak
// in registry". Instead, we download the matching platform binary from the
// GitHub Releases page and drop it into cargoBin so it lives alongside the
// other Nostr tooling (relay, ngit) for a consistent $PATH story.
//
// Asset naming as of v0.19.x: nak-v{tag}-{os}-{arch}
//   os:   darwin | linux
//   arch: amd64  | arm64
//
// Integrity: nak does NOT publish a SHA256SUMS file alongside its release
// assets, so we pin per-target sums in src/lib/versions.ts and hard-fail on
// mismatch. There is no fallback path — an MITM or CDN swap surfaces as a
// failed install, never as a silent-RCE binary written to disk. Bump the
// version + sums together (see BINARY_SHA256 doc comment for the refresh
// recipe).
export async function installNak(cargoBin: string): Promise<InstallResult> {
  const osMap: Record<string, string>   = { darwin: 'darwin', linux: 'linux' };
  const archMap: Record<string, string> = { x64: 'amd64', arm64: 'arm64' };
  const os   = osMap[process.platform];
  const arch = archMap[process.arch];
  if (!os || !arch) {
    return { ok: false, detail: `unsupported platform for nak: ${process.platform}/${process.arch}` };
  }

  const pinnedVersion = COMPONENT_VERSIONS['nak'];
  if (!pinnedVersion) {
    return { ok: false, detail: 'no pinned nak version in versions.ts' };
  }

  const targetKey = `${os}-${arch}`;
  const expectedSha = BINARY_SHA256.nak?.[targetKey];
  if (!expectedSha) {
    return {
      ok: false,
      detail: `no checksum pinned for nak ${targetKey} — refusing unverified install`,
    };
  }

  const tag = `v${pinnedVersion}`;
  const assetName = `nak-${tag}-${targetKey}`;
  const url  = `https://github.com/fiatjaf/nak/releases/download/${tag}/${assetName}`;
  const dest = `${cargoBin}/nak`;

  // cargoBin may not exist yet on a fresh machine where only rustup ran —
  // cargo only creates it when it first installs a bin.
  const fs = await import('fs');
  fs.mkdirSync(cargoBin, { recursive: true });

  const dl = await run('curl', ['-fsSL', url, '-o', dest]);
  if (!dl.ok) return { ok: false, detail: `download failed: ${dl.detail}` };

  // Verify before chmod — never leave an unverified executable on disk.
  // Mismatch deletes the file and hard-fails so the user sees a real error
  // rather than getting an attacker-controlled `nak` shimmed onto their PATH.
  let verified = false;
  try {
    verified = verifyFileSha256(dest, expectedSha);
  } catch (e) {
    try { fs.unlinkSync(dest); } catch {}
    return { ok: false, detail: `checksum read failed: ${(e as Error).message?.slice(0, 80)}` };
  }
  if (!verified) {
    try { fs.unlinkSync(dest); } catch {}
    return {
      ok: false,
      detail: `nak SHA256 mismatch for ${assetName} — install aborted (expected ${expectedSha.slice(0, 12)}…)`,
    };
  }

  try {
    fs.chmodSync(dest, 0o755);
  } catch (e) {
    return { ok: false, detail: `chmod failed: ${(e as Error).message?.slice(0, 80)}` };
  }

  return { ok: true, detail: tag };
}

export async function installGitHubCLI(p: Platform): Promise<InstallResult> {
  switch (p.pkgMgr) {
    case 'brew':
      return run('brew', ['install', 'gh']);
    case 'apt': {
      // Try native apt first (gh is in Ubuntu 22.04+ universe)
      const native = await run('sudo', ['apt-get', 'install', '-y', 'gh']);
      if (native.ok) return native;
      // Fallback: add GitHub's official apt repo
      const setup = await run('sh', ['-c', [
        'curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg',
        '| sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg',
        '&& sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg',
        '&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main"',
        '| sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null',
        '&& sudo apt-get update -qq',
        '&& sudo apt-get install -y gh',
      ].join(' ')]);
      return setup;
    }
    case 'dnf':
      return run('sudo', ['dnf', 'install', '-y', 'gh']);
    case 'pacman':
      return run('sudo', ['pacman', '-S', '--noconfirm', 'github-cli']);
  }
}

export async function installClaudeCode(): Promise<InstallResult> {
  return run('npm', ['install', '-g', '@anthropic-ai/claude-code', '--quiet']);
}

// Stacks by Soapbox — @getstacks/stacks — Nostr app scaffolding via MKStack
// Docs: getstacks.dev  |  Usage: `stacks agent` for the Dork AI coding loop
// in any project directory. `stacks mkstack` is no longer invoked by our
// scaffold — see project_mkstack_naddr_broken memory — but users who want
// to use Stacks for anything else (agent, aliases, etc.) still benefit
// from having the binary installed.
export async function installStacks(): Promise<InstallResult> {
  return run('npm', ['install', '-g', '@getstacks/stacks', '--quiet']);
}

// nsyte — Deno rewrite of nsite-cli with first-class NIP-46 bunker support
// Installs to ~/.deno/bin/nsyte via the official install script
// Docs: nsyte.run  |  Usage: nsyte upload <dir>  |  Bunker: nsyte bunker connect <url>
export async function installNsyte(): Promise<InstallResult> {
  return run('sh', ['-c', 'curl -fsSL https://nsyte.run/get/install.sh | bash']);
}

export async function installBlossom(homeDir: string): Promise<InstallResult> {
  const dest = `${homeDir}/blossom-server`;
  const fs = await import('fs');
  if (fs.existsSync(dest)) {
    return run('git', ['-C', dest, 'pull', '--quiet']);
  }
  const clone = await run('git', [
    'clone', '--quiet',
    'https://github.com/hzrd149/blossom-server', dest,
  ]);
  if (!clone.ok) return clone;
  await run('npm', ['--prefix', dest, 'install', '--quiet']);
  return run('npm', ['--prefix', dest, 'run', 'build', '--quiet']);
}

// Installs nvpn into the user-writable `${cargoBin}` slot (`~/.cargo/bin`),
// same pattern as the relay + nak binaries. Earlier revisions of this
// function either delegated to upstream's install.sh (which shelled out to
// sudo over a non-TTY pipe and silently no-op'd) or piped `curl | tar` in a
// single `sh -c` so download failures and extraction failures were
// indistinguishable. Both failure modes surfaced as a red "error" row in
// the TUI with no indication of which step failed.
//
// This rewrite breaks the flow into named, individually-attributable steps
// and streams each one through `onProgress` so the Services phase row
// updates live. Errors include the specific step, the exit code / stderr
// snippet, and (for downloads) the full URL so the user can re-fetch
// manually. Writes a log file at ~/logs/nvpn-install.log so a post-mortem
// is available after the TUI exits.
export async function installNostrVpn(
  platform: { nvpnTarget: string; cargoBin: string },
  onProgress: (detail: string) => void = () => {},
): Promise<InstallResult> {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');

  const logPath = path.join(os.homedir(), 'logs', 'nvpn-install.log');
  const log: string[] = [];
  const append = (line: string) => {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    log.push(stamped);
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, stamped + '\n');
    } catch { /* best-effort — log file is diagnostic, not load-bearing */ }
  };
  const step = (msg: string) => { append(`step: ${msg}`); onProgress(msg); };
  const fail = (stepName: string, reason: string): InstallResult => {
    append(`FAIL ${stepName}: ${reason}`);
    return {
      ok: false,
      detail: `${stepName} — ${reason} (log: ${logPath})`,
    };
  };

  const nvpnBin = `${platform.cargoBin}/nvpn`;
  append(`target=${platform.nvpnTarget} cargoBin=${platform.cargoBin}`);

  // Short-circuit: if the binary is already present AND responds to --help,
  // declare victory. `nvpn status --json` would be wrong here — it talks to
  // the daemon and exits non-zero when disconnected, forcing a reinstall
  // on every onboard re-run.
  step('checking for existing install');
  try {
    await execa(nvpnBin, ['--help'], { stdio: 'pipe', timeout: 5000 });
    append('already installed — skipping');
    return { ok: true, detail: 'already installed' };
  } catch { /* fall through to install */ }

  // Resolve pinned version + per-target SHA256 from versions.ts. We refuse
  // to download from `/releases/latest/download/...` (the old behavior)
  // because we have no upstream-published manifest to verify against — the
  // only way to make integrity verification meaningful is to fetch the
  // exact tag we have a pinned hash for. Bump the version + sums together
  // (see BINARY_SHA256 doc comment for the refresh recipe).
  const pinnedVersion = COMPONENT_VERSIONS['nvpn'];
  if (!pinnedVersion) {
    return fail('config', 'no pinned nvpn version in versions.ts');
  }
  const expectedSha = BINARY_SHA256.nvpn?.[platform.nvpnTarget];
  if (!expectedSha) {
    return fail(
      'config',
      `no checksum pinned for nvpn ${platform.nvpnTarget} — refusing unverified install`,
    );
  }

  const tag = `v${pinnedVersion}`;
  const url = `https://github.com/mmalmi/nostr-vpn/releases/download/${tag}/nvpn-${platform.nvpnTarget}.tar.gz`;
  const tmp = `/tmp/nvpn-install-${Date.now()}`;
  const tarPath = `${tmp}/nvpn.tar.gz`;
  fs.mkdirSync(tmp, { recursive: true });
  append(`tmp dir: ${tmp} pinned=${pinnedVersion} sha256=${expectedSha.slice(0, 12)}…`);

  // Download — split from the extract step (older code piped curl | tar
  // which hid HTTP errors behind tar's "Unexpected EOF"). `-w` prints the
  // HTTP code to stdout so we can log 404s distinctly from connection
  // failures.
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
      `curl failed (exit ${exit}) for ${url}: ${stderr.trim().slice(0, 160) || 'no stderr'}`,
    );
  }

  // Verify SHA256 of the tarball BEFORE extraction. Hard-fail on mismatch:
  // an attacker-controlled tarball must never be unpacked, even into /tmp,
  // because tar can write absolute / `..` paths and a malicious archive
  // could land payloads outside the intended dir.
  step('verifying sha256');
  let verified = false;
  try {
    verified = verifyFileSha256(tarPath, expectedSha);
  } catch (e: any) {
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

  // Extract — tar's own errors surface clearly here, distinct from the
  // download step.
  step('extracting tarball');
  try {
    await execa('tar', ['-xzf', tarPath, '-C', tmp], { stdio: 'pipe', timeout: 30_000 });
    append(`extract ok, contents: ${fs.readdirSync(tmp).join(', ')}`);
  } catch (e: any) {
    const stderr = e?.stderr?.toString?.() || '';
    fs.rmSync(tmp, { recursive: true, force: true });
    return fail('extract', `tar failed: ${stderr.trim().slice(0, 160) || e.message?.slice(0, 160)}`);
  }

  // Locate the binary. Upstream moved it in/out of an `nvpn/` subdir across
  // releases; probe both layouts and log where we found it (or what's
  // actually there, if neither matches).
  step('locating binary');
  let binSrc = `${tmp}/nvpn`;
  if (!fs.existsSync(binSrc) || fs.statSync(binSrc).isDirectory()) {
    const nested = `${tmp}/nvpn/nvpn`;
    if (fs.existsSync(nested) && !fs.statSync(nested).isDirectory()) {
      binSrc = nested;
    } else {
      const listing = fs.readdirSync(tmp).join(', ');
      fs.rmSync(tmp, { recursive: true, force: true });
      return fail('locate', `nvpn binary not found in tarball; root contents: ${listing}`);
    }
  }
  append(`found binary at ${binSrc}`);

  step(`copying to ${nvpnBin}`);
  try {
    fs.mkdirSync(platform.cargoBin, { recursive: true });
    fs.copyFileSync(binSrc, nvpnBin);
    fs.chmodSync(nvpnBin, 0o755);
    append(`copy ok, mode=0755`);
  } catch (e: any) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return fail('copy', `copy to ${nvpnBin} failed: ${e.message?.slice(0, 160) ?? 'unknown'}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  // Verify the copy actually executes before we try anything else. Catches
  // glibc/musl mismatches, cross-arch copies, permissions, etc.
  step('verifying binary');
  try {
    await execa(nvpnBin, ['--help'], { stdio: 'pipe', timeout: 5000 });
    append('verify ok');
  } catch (e: any) {
    const stderr = e?.stderr?.toString?.() || '';
    return fail('verify', `${nvpnBin} --help failed: ${stderr.trim().slice(0, 160) || e.message?.slice(0, 160)}`);
  }

  // nvpn init — non-fatal if it fails; keypair may already exist or the
  // subcommand name may have changed upstream. Log the error but don't
  // abort the overall install.
  step('nvpn init');
  try {
    await execa(nvpnBin, ['init', '--yes'], { stdio: 'pipe', timeout: 10000 });
    append('init --yes ok');
  } catch {
    try {
      await execa(nvpnBin, ['init'], {
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, input: '\n',
      });
      append('init (stdin-newline) ok');
    } catch (e: any) {
      append(`init skipped: ${(e?.message || '').slice(0, 120)}`);
    }
  }

  // System service install — installs a LaunchDaemon (macOS) or systemd unit
  // (linux) for auto-start on boot. Uses the absolute nvpn path so sudo's
  // secure_path doesn't need `~/.cargo/bin`.
  //
  // This step ALWAYS needs root — it writes /Library/LaunchDaemons/* or
  // /etc/systemd/system/*. We run under `sudo -n` to fail fast if the cred
  // cache is empty (TUI can't prompt). On fail, we return partial success:
  // the binary is usable right now (`nvpn start --daemon` works as a user
  // process), and the user just needs to rerun one command when they're
  // ready for auto-start. Marking this as a hard error would misrepresent
  // the state — nvpn IS installed, just not supervised yet.
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
    append(`service install FAILED: ${stderr.slice(0, 240) || e.message?.slice(0, 240)}`);

    // Actionable next-step: tell the user exactly what to run and that
    // they can use nvpn without this step if they want to skip auto-start.
    // Separate phrasing for the password-cache miss (the expected path
    // when onboard ran from an Ink TUI without fresh sudo) vs. any other
    // reason the service install declined — both leave the user with a
    // usable binary and a one-liner to finish setup.
    const nextStep = needsPassword
      ? `run \`sudo ${nvpnBin} service install\` when ready for auto-start — or start on demand with \`${nvpnBin} start --daemon\``
      : `rerun \`sudo ${nvpnBin} service install\` to retry (error: ${stderr.slice(0, 100) || 'unknown'}) — or start manually with \`${nvpnBin} start --daemon\``;

    return {
      ok: false,
      warn: true,
      detail: `binary installed — ${nextStep} (log: ${logPath})`,
    };
  }
}

export async function setupNgitBunker(bunker: string, cargoBin: string): Promise<InstallResult> {
  return run(`${cargoBin}/ngit`, ['login', '--bunker', bunker]);
}

export async function generateSshKey(homeDir: string): Promise<string> {
  const keyPath = `${homeDir}/.ssh/id_ed25519`;
  const fs = await import('fs');
  if (!fs.existsSync(keyPath)) {
    await run('ssh-keygen', [
      '-t', 'ed25519', '-C', 'nostr-station', '-N', '', '-f', keyPath, '-q',
    ]);
  }
  return fs.readFileSync(`${keyPath}.pub`, 'utf8').trim();
}
