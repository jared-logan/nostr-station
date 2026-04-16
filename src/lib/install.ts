import { execa, type ExecaError } from 'execa';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Platform, Config } from './detect.js';
import { COMPONENT_VERSIONS } from './versions.js';

export type InstallResult = { ok: boolean; detail?: string };

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
): Promise<InstallResult> {
  const start = Date.now();
  const pinnedVersion = COMPONENT_VERSIONS[pkg as keyof typeof COMPONENT_VERSIONS];

  const ticker = setInterval(() => {
    const secs = Math.floor((Date.now() - start) / 1000);
    const mins = Math.floor(secs / 60);
    onProgress(`compiling… ${mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`}`);
  }, 5000);

  const cargoArgs = pinnedVersion
    ? ['install', pkg, '--version', pinnedVersion]
    : ['install', pkg];

  try {
    const proc = execa('cargo', cargoArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CARGO_TERM_COLOR: 'never' },
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim().split('\n').pop() ?? '';
      if (line) onProgress(line.slice(0, 60));
    });

    await proc;
    clearInterval(ticker);
    const elapsed = Math.floor((Date.now() - start) / 1000);
    return { ok: true, detail: `${elapsed}s` };
  } catch (e: any) {
    clearInterval(ticker);
    return { ok: false, detail: (e as any).stderr?.toString().slice(0, 120) };
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
): Promise<InstallResult> {
  const pinnedVersion = COMPONENT_VERSIONS['nostr-rs-relay'];
  if (!pinnedVersion) {
    // No pin → no corresponding prebuilt release exists to target.
    return installCargoBin('nostr-rs-relay', onProgress);
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
    return installCargoBin('nostr-rs-relay', onProgress);
  }
  const supported = new Set(['linux-x86_64', 'darwin-arm64']);
  const targetKey = `${os}-${arch}`;
  if (!supported.has(targetKey)) {
    onProgress(`no prebuilt for ${targetKey} — compiling`);
    return installCargoBin('nostr-rs-relay', onProgress);
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
    return installCargoBin('nostr-rs-relay', onProgress);
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
    return installCargoBin('nostr-rs-relay', onProgress);
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
  const supported = new Set(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']);
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
export async function installNak(cargoBin: string): Promise<InstallResult> {
  const osMap: Record<string, string>   = { darwin: 'darwin', linux: 'linux' };
  const archMap: Record<string, string> = { x64: 'amd64', arm64: 'arm64' };
  const os   = osMap[process.platform];
  const arch = archMap[process.arch];
  if (!os || !arch) {
    return { ok: false, detail: `unsupported platform for nak: ${process.platform}/${process.arch}` };
  }

  // Resolve latest release tag from the GitHub API.
  // We use /releases/latest (not a fixed /download/latest URL) because the
  // asset filenames embed the version, so we have to read the tag first.
  let tag: string;
  try {
    const res = await fetch('https://api.github.com/repos/fiatjaf/nak/releases/latest', {
      headers: { 'User-Agent': 'nostr-station' },
    });
    if (!res.ok) return { ok: false, detail: `github api ${res.status}` };
    const data = await res.json() as { tag_name?: string };
    if (!data.tag_name) return { ok: false, detail: 'no tag_name in release response' };
    tag = data.tag_name;
  } catch (e) {
    const msg = (e as Error).message ?? 'fetch failed';
    return { ok: false, detail: `github api fetch failed: ${msg.slice(0, 80)}` };
  }

  const assetName = `nak-${tag}-${os}-${arch}`;
  const url  = `https://github.com/fiatjaf/nak/releases/download/${tag}/${assetName}`;
  const dest = `${cargoBin}/nak`;

  // cargoBin may not exist yet on a fresh machine where only rustup ran —
  // cargo only creates it when it first installs a bin.
  const fs = await import('fs');
  fs.mkdirSync(cargoBin, { recursive: true });

  const dl = await run('curl', ['-fsSL', url, '-o', dest]);
  if (!dl.ok) return { ok: false, detail: `download failed: ${dl.detail}` };

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
// Docs: getstacks.dev  |  Usage after install: stacks mkstack (per project)
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

export async function installNostrVpn(nvpnTarget: string): Promise<InstallResult> {
  // Skip full reinstall if nvpn already exists and is working
  try {
    await execa('nvpn', ['status', '--json'], { stdio: 'pipe', timeout: 5000 });
    return { ok: true, detail: 'already installed' };
  } catch {}

  const url = `https://github.com/mmalmi/nostr-vpn/releases/latest/download/nvpn-${nvpnTarget}.tar.gz`;
  const tmp = `/tmp/nvpn-install-${Date.now()}`;
  const fs = await import('fs');
  fs.mkdirSync(tmp, { recursive: true });

  // Download and extract
  const dl = await run('sh', ['-c', `curl -fsSL "${url}" | tar -xz -C "${tmp}"`]);
  if (!dl.ok) return { ok: false, detail: `download failed: ${dl.detail}` };

  // Confirm install.sh exists in the extracted archive
  const installScript = `${tmp}/install.sh`;
  const fsSync = await import('fs');
  if (!fsSync.existsSync(installScript)) {
    // Try one level deeper — some releases nest inside a subdirectory
    const subdirs = fsSync.readdirSync(tmp);
    const subdir = subdirs.find(d => fsSync.statSync(`${tmp}/${d}`).isDirectory());
    if (subdir && fsSync.existsSync(`${tmp}/${subdir}/install.sh`)) {
      const install = await run('bash', [`${tmp}/${subdir}/install.sh`]);
      fs.rmSync(tmp, { recursive: true, force: true });
      if (!install.ok) return install;
    } else {
      fs.rmSync(tmp, { recursive: true, force: true });
      return { ok: false, detail: 'install.sh not found in release archive — check github.com/mmalmi/nostr-vpn/releases' };
    }
  } else {
    const install = await run('bash', [installScript]);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!install.ok) return install;
  }

  // nvpn init — non-interactive, generates keypair if not already present
  // --yes or equivalent varies by version; we pass it and ignore failure
  // since some versions don't need it
  try {
    await execa('nvpn', ['init', '--yes'], { stdio: 'pipe', timeout: 10000 });
  } catch {
    try {
      await execa('nvpn', ['init'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
        input: '\n', // send newline in case it prompts
      });
    } catch {}
  }

  return run('sudo', ['nvpn', 'service', 'install']);
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
