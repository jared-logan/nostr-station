import { execa, type ExecaError } from 'execa';
import type { Platform, Config } from './detect.js';

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
    case 'brew':
      return run('brew', ['install', 'git', 'curl']);
    case 'apt':
      await run('sudo', ['apt-get', 'update', '-qq']);
      return run('sudo', ['apt-get', 'install', '-y',
        'build-essential', 'curl', 'git', 'pkg-config',
        'libssl-dev', 'netcat-openbsd',
        'libsecret-tools',   // provides secret-tool for GNOME Keyring access
      ]);
    case 'dnf':
      return run('sudo', ['dnf', 'install', '-y',
        'gcc', 'curl', 'git', 'openssl-devel', 'pkgconfig', 'nmap-ncat']);
    case 'pacman':
      return run('sudo', ['pacman', '-Sy', '--noconfirm',
        'base-devel', 'curl', 'git', 'openssl']);
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
export async function installCargoBin(
  pkg: string,
  onProgress: (detail: string) => void,
): Promise<InstallResult> {
  const start = Date.now();

  const ticker = setInterval(() => {
    const secs = Math.floor((Date.now() - start) / 1000);
    const mins = Math.floor(secs / 60);
    onProgress(`compiling… ${mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`}`);
  }, 5000);

  try {
    const proc = execa('cargo', ['install', pkg, '--locked'], {
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

// Stacks by Soapbox — @getstacks/stacks — Nostr app scaffolding via MKStack + Dork AI agent
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
