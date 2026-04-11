import { execa, type ExecaError } from 'execa';
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

export async function installSystemDeps(p: Platform): Promise<InstallResult> {
  switch (p.pkgMgr) {
    // protobuf-compiler / protoc is required by nostr-rs-relay's build.rs —
    // prost-build invokes `protoc` to compile proto/nauthz.proto and the
    // `cargo install` fails with "Could not find `protoc` installation" without it.
    case 'brew':
      return run('brew', ['install', 'git', 'curl', 'protobuf']);
    case 'apt':
      await run('sudo', ['apt-get', 'update', '-qq']);
      return run('sudo', ['apt-get', 'install', '-y',
        'build-essential', 'curl', 'git', 'pkg-config',
        'libssl-dev', 'netcat-openbsd',
        'libsecret-tools',   // provides secret-tool for GNOME Keyring access
        'protobuf-compiler', // provides protoc for nostr-rs-relay build.rs
      ]);
    case 'dnf':
      return run('sudo', ['dnf', 'install', '-y',
        'gcc', 'curl', 'git', 'openssl-devel', 'pkgconfig', 'nmap-ncat',
        'protobuf-compiler']);
    case 'pacman':
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
